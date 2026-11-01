/**
 * The six signals, one pure function each.
 *
 * A signal answers one question with `pass | fail | unknown` and one reason code
 * from the closed set in `@factory/contracts`. Nothing here reads a clock, picks a
 * random number, opens a socket or asks a model: an auditor re-runs these
 * functions on the stored spec and must get the same three-valued answer, forever
 * (`findings.md > TD9`).
 *
 * `unknown` is a first-class answer, not a quiet `fail`. It means "the input that
 * would settle this is not here" — no history for the task class, no budget
 * estimate. `qualify.ts` turns any `unknown` into a demotion, never into `dark`.
 */
import {
  IRREVERSIBLE_OPERATION_CLASSES,
  SIGNAL_NAMES,
  type AcceptanceCriterion,
  type OperationClass,
  type QualifierReasonCode,
  type Signal,
  type SignalName,
  type UnitSpec,
} from '@factory/contracts';
import type { QualifierPolicy } from './policy.ts';

/** History for one task class, as the store reports it. `null` at the call site means "never seen". */
export interface TaskClassHistory {
  readonly samples: number;
  readonly passRate: number;
  readonly escapeRate: number;
}

/** The inputs every signal may read. No ambient state is available, by construction. */
export interface SignalInputs {
  readonly spec: UnitSpec;
  readonly taskClassHistory: TaskClassHistory | null;
  readonly envelopeUsd: number;
}

// ---------------------------------------------------------------------------
// Text handling for the restate-back check
// ---------------------------------------------------------------------------

/**
 * A deliberately small English stopword list.
 *
 * The list exists so the overlap metric compares *content* words. It is kept tiny
 * and frozen for a reason: every addition silently changes the score of every
 * future unit, so growing it is a policy change in disguise. Words that carry
 * domain meaning are absent on purpose (`add`, `delete`, `database`, `pagination`
 * must all count).
 */
export const STOPWORDS: ReadonlySet<string> = new Set([
  'a',
  'an',
  'the',
  'and',
  'or',
  'but',
  'if',
  'then',
  'else',
  'of',
  'to',
  'in',
  'on',
  'at',
  'for',
  'with',
  'without',
  'from',
  'by',
  'as',
  'is',
  'are',
  'was',
  'were',
  'be',
  'been',
  'being',
  'it',
  'its',
  'this',
  'that',
  'these',
  'those',
  'we',
  'you',
  'they',
  'he',
  'she',
  'i',
  'not',
  'no',
  'do',
  'does',
  'did',
  'should',
  'must',
  'can',
  'could',
  'will',
  'would',
  'may',
  'might',
  'shall',
  'have',
  'has',
  'had',
  'so',
  'than',
  'too',
  'very',
  'just',
  'also',
  'into',
  'over',
  'under',
  'after',
  'before',
  'when',
  'while',
  'there',
  'here',
  'which',
  'who',
  'whom',
  'whose',
  'what',
  'why',
  'how',
  'all',
  'any',
  'some',
  'each',
  'every',
  'both',
  'more',
  'most',
  'other',
  'such',
  'only',
  'own',
  'same',
  'up',
  'down',
  'out',
  'off',
  'again',
  'further',
  'once',
  'about',
  'via',
]);

/**
 * Lowercase, split on `[^a-z0-9]+`, drop the empty pieces and the stopwords, and
 * deduplicate. Numbers survive: `200` in both texts is weak evidence, but it is
 * evidence, and dropping it would need a rule nobody can reconstruct later.
 */
export function significantTokens(text: string): ReadonlySet<string> {
  const tokens = new Set<string>();
  for (const piece of text.toLowerCase().split(/[^a-z0-9]+/)) {
    if (piece.length === 0) continue;
    if (STOPWORDS.has(piece)) continue;
    tokens.add(piece);
  }
  return tokens;
}

/**
 * Overlap coefficient (Szymkiewicz–Simpson): `|A ∩ B| / min(|A|, |B|)`.
 *
 * Chosen over Jaccard on purpose. A good restatement is *longer* than the intent —
 * it adds words to show it understood — and Jaccard punishes it for exactly that,
 * so a faithful 12-word restatement of a 5-word intent would score worse than a
 * lazy copy. The overlap coefficient asks the narrower question the gate actually
 * needs: did the restatement cover the words the intent used?
 *
 * Limits, stated plainly: this measures *lexical* agreement, not understanding.
 * It catches "the agent restated a different task" (disjoint vocabulary) and it
 * misses "the agent restated the same words in a way that means something else".
 * It is defeated by synonyms and by translation. It is not a comprehension test
 * and no score in this package should be read as one — the gate it feeds only
 * asks whether the restatement is *about the same words*, because a restatement
 * about different words is provably not about the same task.
 */
export function overlapCoefficient(a: ReadonlySet<string>, b: ReadonlySet<string>): number {
  const smaller = Math.min(a.size, b.size);
  if (smaller === 0) return 0;
  const [small, large] = a.size <= b.size ? [a, b] : [b, a];
  let shared = 0;
  for (const token of small) {
    if (large.has(token)) shared += 1;
  }
  return shared / smaller;
}

/** The metric above, applied to the two spec fields. */
export function restateOverlap(intent: string, restateBack: string): number {
  return overlapCoefficient(significantTokens(intent), significantTokens(restateBack));
}

// ---------------------------------------------------------------------------
// Signal construction
// ---------------------------------------------------------------------------

/** `Signal.observed` is capped by the contract at this many characters. */
const MAX_OBSERVED = 2000;

function bound(text: string): string {
  return text.length <= MAX_OBSERVED ? text : `${text.slice(0, MAX_OBSERVED - 3)}...`;
}

function signal(
  name: SignalName,
  outcome: 'pass' | 'fail' | 'unknown',
  reason: QualifierReasonCode,
  observed: string,
  policy: QualifierPolicy,
): Signal {
  return { name, outcome, reason, observed: bound(observed), weight: policy.weights[name] };
}

/** Read a possibly-malformed field as text without letting a type lie reach a runtime crash. */
function asText(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

function asArray<T>(value: readonly T[] | undefined | null): readonly T[] {
  return Array.isArray(value) ? value : [];
}

// ---------------------------------------------------------------------------
// 1. Intent derivability
// ---------------------------------------------------------------------------

/**
 * What makes a criterion machine-checkable.
 *
 * The oracle's `target` and `expect` must be non-empty (the schema says so, but a
 * spec can arrive from a file, so this is re-checked at the boundary), and the
 * criterion *text* must not be pure prose. "Pure prose" is defined narrowly and
 * deterministically:
 *
 * - the text carries no measurable anchor — no digit and no code-ish punctuation
 *   (backtick, slash, backslash, `=`, `<>`, bracket, brace, colon, underscore), and
 * - the text shares no significant token with its own oracle.
 *
 * A text that names nothing the oracle measures is a criterion whose claim and
 * whose proof are unrelated: rewritable, and until it is rewritten there is
 * nothing to hand a wall. The rule is a floor, not a proof — a well-written prose
 * sentence that happens to reuse a word from the oracle passes it, and synonyms
 * defeat it. That is acceptable because the failure it produces is `reject`
 * (rewrite the criterion), never a silent `pass` into `dark`.
 */
export function isProseOnly(
  criterion: AcceptanceCriterion,
  target: string,
  expect: string,
): boolean {
  const text = asText((criterion as { text?: unknown }).text).trim();
  if (text.length === 0) return true;

  const ANCHOR = /[0-9`/\\=<>()[\]{}:_]/;
  if (ANCHOR.test(text)) return false;

  const textTokens = significantTokens(text);
  const oracleTokens = new Set<string>([
    ...significantTokens(target),
    ...significantTokens(expect),
  ]);
  for (const token of textTokens) {
    if (oracleTokens.has(token)) return false;
  }
  return true;
}

interface CriterionProblem {
  readonly index: number;
  readonly why: string;
}

function criterionProblems(criteria: readonly AcceptanceCriterion[]): readonly CriterionProblem[] {
  const problems: CriterionProblem[] = [];
  criteria.forEach((criterion, index) => {
    const oracle = (criterion as { oracle?: { target?: unknown; expect?: unknown } }).oracle;
    const target = asText(oracle?.target).trim();
    const expect = asText(oracle?.expect).trim();
    if (target.length === 0) {
      problems.push({ index, why: 'oracle.target empty' });
      return;
    }
    if (expect.length === 0) {
      problems.push({ index, why: 'oracle.expect empty' });
      return;
    }
    if (isProseOnly(criterion, target, expect)) {
      problems.push({ index, why: 'criterion text names nothing the oracle measures' });
    }
  });
  return problems;
}

/** The minimum restate-back length, in characters, before the overlap check is meaningful. */
const RESTATE_MIN_CHARS = 20;

/**
 * Intent derivability: can this unit be checked without a human reading it?
 *
 * Order matters and is fixed: an unusable criterion outranks a missing
 * restatement, because a rewritten criterion is the larger repair.
 *
 * The contract also carries a generic `INTENT_NOT_DERIVABLE`. This evaluator never
 * emits it: every cause of a non-derivable intent needs a different repair (rewrite
 * the criterion, write the restatement, restate the *same* task), so the specific
 * code is the one an operator can act on. The generic code stays available for a
 * caller that wants one umbrella, never for this gate.
 */
export function evaluateIntentDerivability(spec: UnitSpec, policy: QualifierPolicy): Signal {
  const criteria = asArray(spec.acceptance);
  const problems = criterionProblems(criteria);
  const first = problems[0];
  if (first !== undefined) {
    return signal(
      'intent_derivability',
      'fail',
      'SPEC_NOT_MACHINE_CHECKABLE',
      `acceptance[${String(first.index)}] ${first.why}; ${String(problems.length)} of ${String(criteria.length)} criteria unusable`,
      policy,
    );
  }

  const restateBack = asText(spec.restateBack);
  const trimmed = restateBack.trim();
  if (trimmed.length < RESTATE_MIN_CHARS) {
    return signal(
      'intent_derivability',
      'fail',
      'RESTATE_BACK_MISSING',
      `restateBack chars=${String(trimmed.length)} min=${String(RESTATE_MIN_CHARS)}`,
      policy,
    );
  }

  const overlap = restateOverlap(asText(spec.intent), restateBack);
  const observedOverlap = `restateOverlap=${overlap.toFixed(3)} min=${policy.restateOverlapMin.toFixed(3)}`;
  if (overlap < policy.restateOverlapMin) {
    return signal('intent_derivability', 'fail', 'RESTATE_BACK_MISMATCH', observedOverlap, policy);
  }

  return signal(
    'intent_derivability',
    'pass',
    'INTENT_DERIVABLE',
    `criteria=${String(criteria.length)} usable=${String(criteria.length)} ${observedOverlap}`,
    policy,
  );
}

// ---------------------------------------------------------------------------
// 2. Reversibility
// ---------------------------------------------------------------------------

/**
 * A touch path is unbounded when it is empty, when it is a glob that can reach
 * anything (`**`), or when it is rooted at the filesystem (`/...`) rather than at
 * the worktree.
 *
 * Known limit, stated rather than hidden: a traversal such as `../../x` is not
 * rejected here. The path list is a *declaration*, and the executor's worktree and
 * container bound what a declaration can reach; this signal's job is to refuse a
 * unit that declared "somewhere", not to be the path jail.
 */
export function isUnboundedTouchPath(path: string): boolean {
  const trimmed = path.trim();
  return trimmed.length === 0 || trimmed.includes('**') || trimmed.startsWith('/');
}

/** Reversibility: can the change be undone without a human, an archive or an apology? */
export function evaluateReversibility(spec: UnitSpec, policy: QualifierPolicy): Signal {
  const classes = asArray<OperationClass>(spec.operationClasses);
  const irreversible = classes.filter((operation) =>
    IRREVERSIBLE_OPERATION_CLASSES.includes(operation),
  );
  if (irreversible.length > 0) {
    return signal(
      'reversibility',
      'fail',
      'IRREVERSIBLE_OPERATION',
      `operationClasses=${irreversible.join(',')} (irreversible: ${IRREVERSIBLE_OPERATION_CLASSES.join(',')})`,
      policy,
    );
  }

  const paths = asArray<string>(spec.touchPaths);
  const unbounded = paths.filter((path) => typeof path === 'string' && isUnboundedTouchPath(path));
  if (paths.length === 0 || unbounded.length > 0) {
    const sample = unbounded.slice(0, 3).join(',');
    return signal(
      'reversibility',
      'fail',
      'TOUCH_PATHS_UNSCOPED',
      paths.length === 0
        ? 'touchPaths=0 (a unit must declare where it writes)'
        : `touchPaths unbounded=${String(unbounded.length)} of ${String(paths.length)}: ${sample}`,
      policy,
    );
  }

  return signal(
    'reversibility',
    'pass',
    'REVERSIBLE',
    `operationClasses=${classes.length === 0 ? 'none' : classes.join(',')} touchPaths=${String(paths.length)}`,
    policy,
  );
}

// ---------------------------------------------------------------------------
// 3. Observability
// ---------------------------------------------------------------------------

/** Observability: every criterion names something a machine can look at. */
export function evaluateObservability(spec: UnitSpec, policy: QualifierPolicy): Signal {
  const criteria = asArray(spec.acceptance);
  const missing: string[] = [];
  criteria.forEach((criterion, index) => {
    const oracle = (criterion as { oracle?: { target?: unknown; expect?: unknown } }).oracle;
    const target = asText(oracle?.target).trim();
    const expect = asText(oracle?.expect).trim();
    if (target.length === 0 || expect.length === 0) {
      const id = asText((criterion as { id?: unknown }).id);
      missing.push(id.length > 0 ? id : `#${String(index)}`);
    }
  });

  if (criteria.length === 0 || missing.length > 0) {
    return signal(
      'observability',
      'fail',
      'ORACLE_MISSING',
      criteria.length === 0
        ? 'acceptance=0 (no criterion to observe)'
        : `criteria=${String(criteria.length)} missing=${missing.slice(0, 5).join(',')}`,
      policy,
    );
  }

  return signal(
    'observability',
    'pass',
    'ORACLE_PRESENT',
    `criteria=${String(criteria.length)} withOracle=${String(criteria.length)}`,
    policy,
  );
}

// ---------------------------------------------------------------------------
// 4. Task-class history
// ---------------------------------------------------------------------------

/** Task-class history: has this kind of work ever gone dark and stayed correct? */
export function evaluateTaskClassHistory(
  history: TaskClassHistory | null,
  policy: QualifierPolicy,
): Signal {
  if (history === null || history === undefined) {
    if (policy.allowColdStart) {
      // A policy decision, visibly labelled: the operator chose to start a cold
      // factory without measurements, so the reason code says exactly that and
      // `policyVersion` changes so the decision can never be mistaken for a
      // measured one.
      return signal(
        'task_class_history',
        'pass',
        'TASK_CLASS_COLD_START',
        'history=absent allowColdStart=true',
        policy,
      );
    }
    return signal('task_class_history', 'unknown', 'TASK_CLASS_UNKNOWN', 'history=absent', policy);
  }

  const samples = Number.isFinite(history.samples) ? history.samples : 0;
  const passRate = Number.isFinite(history.passRate) ? history.passRate : 0;
  const escapeRate = Number.isFinite(history.escapeRate) ? history.escapeRate : 1;
  const observed = `samples=${String(samples)} passRate=${passRate.toFixed(3)} escapeRate=${escapeRate.toFixed(3)}`;

  if (samples < policy.minSamples) {
    return signal(
      'task_class_history',
      'unknown',
      'TASK_CLASS_UNKNOWN',
      `${observed} minSamples=${String(policy.minSamples)}`,
      policy,
    );
  }

  if (passRate >= policy.minPassRate && escapeRate <= policy.maxEscapeRate) {
    return signal('task_class_history', 'pass', 'TASK_CLASS_STABLE', observed, policy);
  }

  return signal(
    'task_class_history',
    'fail',
    'TASK_CLASS_UNSTABLE',
    `${observed} need passRate>=${policy.minPassRate.toFixed(3)} and escapeRate<=${policy.maxEscapeRate.toFixed(3)}`,
    policy,
  );
}

// ---------------------------------------------------------------------------
// 5. Size
// ---------------------------------------------------------------------------

/**
 * Size: is the change small enough to read in one sitting?
 *
 * A missing or malformed `sizeBudget` is treated as over budget rather than
 * passing. The schema requires the field, so this only fires on a spec that
 * bypassed validation — and an unmeasured size must never look like a small one
 * (the house rule: unknown never satisfies a gate).
 */
export function evaluateSize(spec: UnitSpec, policy: QualifierPolicy): Signal {
  const budget = (spec as { sizeBudget?: { lines?: unknown; files?: unknown } }).sizeBudget;
  const lines = typeof budget?.lines === 'number' ? budget.lines : Number.NaN;
  const files = typeof budget?.files === 'number' ? budget.files : Number.NaN;

  if (!Number.isFinite(lines) || !Number.isFinite(files)) {
    return signal(
      'size',
      'fail',
      'SIZE_OVER_BUDGET',
      `sizeBudget=absent-or-malformed (treated as over budget; an unmeasured size is not a small one)`,
      policy,
    );
  }

  const observed = `lines=${String(lines)}/${String(policy.maxLines)} files=${String(files)}/${String(policy.maxFiles)}`;
  if (lines <= policy.maxLines && files <= policy.maxFiles) {
    return signal('size', 'pass', 'SIZE_WITHIN_BUDGET', observed, policy);
  }
  return signal('size', 'fail', 'SIZE_OVER_BUDGET', observed, policy);
}

// ---------------------------------------------------------------------------
// 6. Budget
// ---------------------------------------------------------------------------

/** Budget: is the estimate inside the envelope the operator signed? */
export function evaluateBudget(
  spec: UnitSpec,
  envelopeUsd: number,
  policy: QualifierPolicy,
): Signal {
  const estimate = (spec as { budgetEstimateUsd?: unknown }).budgetEstimateUsd;
  const envelope = Number.isFinite(envelopeUsd) ? envelopeUsd : 0;

  if (typeof estimate !== 'number' || !Number.isFinite(estimate)) {
    return signal(
      'budget',
      'unknown',
      'BUDGET_UNKNOWN',
      `estimate=absent envelopeUsd=${envelope.toFixed(2)}`,
      policy,
    );
  }

  const observed = `estimateUsd=${estimate.toFixed(2)} envelopeUsd=${envelope.toFixed(2)}`;
  if (estimate <= envelope) {
    return signal('budget', 'pass', 'BUDGET_WITHIN_ENVELOPE', observed, policy);
  }
  return signal('budget', 'fail', 'BUDGET_EXCEEDS_ENVELOPE', observed, policy);
}

// ---------------------------------------------------------------------------
// The set
// ---------------------------------------------------------------------------

/**
 * Evaluate all six signals, in `SIGNAL_NAMES` order.
 *
 * The order is part of the output: the CLI prints the first failing signal first,
 * so a stable order is what makes two runs of the same unit read the same way.
 */
export function evaluateSignals(inputs: SignalInputs, policy: QualifierPolicy): readonly Signal[] {
  const { spec } = inputs;
  const signals = [
    evaluateIntentDerivability(spec, policy),
    evaluateReversibility(spec, policy),
    evaluateObservability(spec, policy),
    evaluateTaskClassHistory(inputs.taskClassHistory, policy),
    evaluateSize(spec, policy),
    evaluateBudget(spec, inputs.envelopeUsd, policy),
  ];
  // A cheap structural assertion: six signals, in the contract's order. A future
  // edit that adds a signal without adding it to SIGNAL_NAMES fails here rather
  // than in a decision nobody re-reads.
  if (signals.length !== SIGNAL_NAMES.length) {
    throw new Error(
      `qualifier: evaluated ${String(signals.length)} signals, contract declares ${String(SIGNAL_NAMES.length)}`,
    );
  }
  return signals;
}
