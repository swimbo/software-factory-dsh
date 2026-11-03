/**
 * The decision.
 *
 * This function is the factory's only statement about whether work is done. Three
 * laws hold it in place, and every line below is one of them:
 *
 * **L1 — an agent report is not evidence.** `evaluate` accepts a `DecisionReceipt`,
 * which has no `narrative` field. There is no parameter here that takes prose, and
 * no branch that reads a claim the agent made about itself. Faithfulness is
 * established by re-execution, not by assertion.
 *
 * **L2 — deterministic controls enforce, LLMs advise.** There is no model call, no
 * network call and no clock read in this file. The same inputs produce a
 * bit-identical verdict; `evaluatedAt` is handed in by the caller precisely so that
 * this property survives.
 *
 * **L3 — unknown is not pass.** Every check can return `unknown`, `unknown` refuses
 * every gate, and the outcome is computed by precedence (fail > unknown > pass) so
 * that no combination of unmeasured checks can add up to approval.
 *
 * Two consequences are worth stating out loud, because they are the price of L3 and
 * they will feel inconvenient:
 *
 * 1. A `pass` requires a **holdout**. No store, no approval — an empty or missing
 *    holdout is a hole shaped like a pass, so it is `unknown`.
 * 2. A `pass` requires a **diff surface**. If the wall cannot see which files the
 *    patch touched, it cannot know whether tests were deleted or the change left its
 *    declared scope, so it refuses to certify. A wall that cannot see the diff is a
 *    wall that can be walked around.
 */
import {
  assertVerdictIsEarned,
  contentHash,
  FactoryError,
  IRREVERSIBLE_OPERATION_CLASSES,
  Verdict as VerdictSchema,
  WALL_VERSION,
  type AcceptanceCriterion,
  type DecisionReceipt,
  type Delta,
  type OperationClass,
  type ScenarioResult,
  type UnitSpec,
  type Verdict,
  type WallReasonCode,
} from '@factory/contracts';
import { assessDiscrimination } from './criteria-log.ts';
import { PrivilegedBrokerRefusal } from './local.ts';
import { replayArgv, verificationReadProblem, verificationSequenceProblem } from './replay.ts';
import type { CriteriaLogEntry, CriteriaLogPort, DiscriminationReport } from './criteria-log.ts';
import type { HoldoutScenario, HoldoutStore } from './holdout.ts';
import { assessSecurityPaths, SENSITIVE_OPERATION_CLASSES } from './security-path.ts';
import type { ClassCertificate } from '@factory/contracts';

import { certificationForClass, type ClassCertification } from './operating-point.ts';
import { normalisePath, pathIsInScope } from './scope.ts';

export { pathIsInScope } from './scope.ts';

// ---------------------------------------------------------------------------
// ports
// ---------------------------------------------------------------------------

/** Which checkout to execute in, and what to run there. */
/**
 * The machine-readable summary a suite run must produce.
 *
 * This replaces "parse the worker's `suite_output`" (A4.1). Counts and an exit code are
 * comparable; free-text logs are not — they carry timings and temp paths, so comparing
 * them false-fails faithful receipts, and grepping them is not a spec.
 */
export interface SuiteSummary {
  readonly passed: number;
  readonly failed: number;
  readonly unknown: number;
  readonly exitCode: number | null;
}

export interface ScenarioRunInput {
  readonly baseRev: string;
  readonly patchFile: string;
  readonly argv: readonly string[];
  readonly timeoutMs: number;
  /**
   * Which test root the runner must materialise (A4.1).
   *
   * `base` means: apply the candidate's source but check out the **base revision's**
   * tests (`git checkout <base> -- <testRoot>`). That is what makes the wall's oracle
   * independent of the candidate's ability to edit the tests that judge it.
   */
  readonly testRootFrom?: 'base' | 'candidate';
  /** Container isolation this run requires. The container runner satisfies it; a local runner must refuse. */
  readonly requires?: 'container';
  /** An egress-free network this run requires. Same rule: satisfied by a container, refused by a local runner. */
  readonly network?: 'none';
}

export interface ScenarioRunResult {
  /** Present when the run produced a machine-readable suite summary. */
  readonly summary?: SuiteSummary;
  /** `null` when the process produced no exit status (killed, crashed, unstartable). */
  readonly exitCode: number | null;
  /** Hash of combined stdout+stderr, so a claim can be compared without storing megabytes. */
  readonly outputSha: string;
  readonly durationMs: number;
  readonly timedOut: boolean;
}

/**
 * The execution port. The wall never spawns a process itself: it asks a runner,
 * which in production is a fresh container and in tests is a lookup table. A
 * runner that throws is a *measurement that did not happen*, which is `unknown` —
 * never a `fail`, because the candidate did not fail, the instrumentation did.
 */
export interface ScenarioRunner {
  run(input: ScenarioRunInput): Promise<ScenarioRunResult>;
  /**
   * What kind of environment this runner provides.
   *
   * Not decoration: a verdict produced without container isolation must say so, or two
   * verdicts that measured different things read as the same evidence. `evaluate` folds
   * this into `wallVersion` (`+local`) so the label cannot be forgotten by a caller.
   */
  readonly kind?: 'container' | 'local';
}

/** Isolation a run requires, so a runner that cannot provide it can refuse instead of pretending. */
export interface ScenarioRequirements {
  /** The scenario must run inside the pinned container image (A4.4). */
  readonly requires?: 'container';
  /** The scenario must have no network at all. */
  readonly network?: 'none';
}

/** What a single path in the patch did. */
export interface ChangedFile {
  readonly path: string;
  readonly kind: 'added' | 'modified' | 'deleted';
  /** True when the file existed at the base revision and the patch leaves it empty. */
  readonly emptied?: boolean;
  /** Assertions the patch removed from this file; only meaningful for test files. */
  readonly removedAssertions?: number;
}

/**
 * The diff surface: the wall's view of *which files changed*.
 *
 * `null` means the diff could not be inspected — which is an unavailable
 * measurement, not an empty diff. The distinction matters: an empty diff is a
 * legitimate "nothing changed", and `null` is "I cannot tell", and only one of
 * those may contribute to a pass.
 */
export interface DiffInspector {
  changedFiles(): Promise<readonly ChangedFile[] | null>;
}

/** `patchFile` sentinel meaning "check out `baseRev` with no patch applied". */
export const NO_PATCH = '';

/**
 * `holdoutRevision` recorded when there is no usable holdout. It is a word rather
 * than an empty string because the contract requires a non-empty revision and
 * because an absent holdout should be legible in an audit trail, not invisible.
 */
export const HOLDOUT_ABSENT_REVISION = 'absent';

export interface EvaluateInput {
  readonly spec: UnitSpec;
  readonly receipt: DecisionReceipt;
  readonly holdout: HoldoutStore | null;
  readonly runner: ScenarioRunner;
  /**
   * The model id this attempt ran under, when the caller knows it. It is *recorded*, never judged:
   * it rides on the verdict so a class certificate can be checked against the model that produced
   * it (`re-certify: model changed`), and it is absent for an offline attempt rather than being
   * invented — L2 forbids a model anywhere on a decision path, and this is metadata about a
   * measurement, not an input to one.
   */
  readonly modelId?: string | undefined;
  readonly policy: {
    readonly deltaThreshold: number;
    readonly commandTimeoutMs: number;
    readonly wallVersion: string;
    /**
     * How many times each scenario runs before a majority decides it. Odd, 1–9.
     * Defaults to 3: a single run cannot distinguish a flaky scenario from a
     * broken one, and the acceptance surface is exactly where a sabotage gets one
     * lucky green.
     */
    readonly runsPerScenario?: number;
    /**
     * How many scenarios are allowed to pass on *every* base run before the wall
     * refuses to certify the class. Defaults to 0: one scenario that cannot
     * distinguish the change from the base is one scenario that is measuring
     * nothing, and a wall made of those approves everything.
     */
    readonly maxNonDiscriminating?: number;
    /**
     * The wall's **own** test entrypoint (A4.1/A6).
     *
     * The worker never supplies this: it is operator-declared policy, part of
     * `policyVersion`, and the wall runs it over the base test root and reads the
     * machine-readable summary. Without it the wall has no oracle of its own and cannot
     * pass anything — which is L3 applied to "we have no way to check this".
     */
    readonly pinnedSuite?: { readonly argv: readonly string[]; readonly requires?: 'container' };
    /**
     * Minimum Δ samples for a task class to be *certifiable* (A4.7). Below it, a passing
     * unit still verifies but its promotion needs a human signature. `0` disables the
     * gate and is the honest default for a cold start.
     */
    readonly minDeltaSamples?: number;
    /**
     * The certification operating point (ND1). Defaults to the ratified m = 20, k = 18, p0 = 0.95;
     * a policy may tighten it, and `evaluate` publishes the α that follows from it.
     */
    readonly certification?: {
      readonly m?: number;
      readonly k?: number;
      readonly p0?: number;
    };
    /**
     * The `factory-env` image digest the wall ran, so a verdict names its instrument
     * (A4.4). Recorded in `wallVersion`; a tag is a mutable pointer and therefore not an
     * instrument identity.
     */
    readonly imageDigest?: string;
    /**
     * Optional because `EvaluateInput['policy']` is a frozen shape. When absent the
     * wall derives the policy identity from the decision-relevant fields, so a
     * threshold change cannot silently reuse an old verdict.
     */
    readonly policyVersion?: string;
  };
  readonly diff?: DiffInspector;
  /**
   * The criteria log, injected as a port.
   *
   * Optional: without it the discrimination control still works, because it uses
   * the base observations this run made itself. With it, those observations
   * accumulate, which is what makes criteria drift visible over weeks rather than
   * only within one attempt.
   *
   * There is deliberately no field here for a signing key. The wall decides; the
   * wall's *CLI* signs. See `signing.ts` and the structural test that asserts this
   * type cannot be handed a private key.
   */
  readonly criteriaLog?: CriteriaLogPort;
  readonly nowIso: string;
}

// ---------------------------------------------------------------------------
// small pure predicates (exported: they are the testable core of two checks)
// ---------------------------------------------------------------------------

/**
 * The destructive-verb denylist.
 *
 * This is a *second* line, behind the structural control (the worker holds no
 * production credential), and it is knowingly weak: string matching is exactly
 * the control the incident corpus shows agents routing around. It exists because
 * a recorded `--force` in a receipt should never reach a `pass` verdict, not
 * because it makes the wall safe. Do not grow this list hoping it becomes
 * complete — that is the trap the research names.
 */
const DESTRUCTIVE_PATTERNS: readonly RegExp[] = [
  // `--force` but not `--force-with-lease`, which is the safe variant of the same verb.
  /--force\b(?!-with-lease)/,
  /\bfilter-repo\b/,
  /\breset\s+--hard\b/,
  /\brm\s+-\w*(?:rf|fr)\w*\b/,
  /\bdrop\s+table\b/,
  /\btruncate\s+table\b/,
  /\bdelete\s+from\b/,
  /\bgit\s+push\b[^\n]*\s-f(?:\s|$)/,
  /\bgit\s+push\b[^\n]*--mirror\b/,
];

export function isDestructiveArgv(argv: readonly string[]): boolean {
  const command = argv.join(' ');
  return DESTRUCTIVE_PATTERNS.some((pattern) => pattern.test(command));
}

// ---------------------------------------------------------------------------
// result construction
// ---------------------------------------------------------------------------

const MAX_OBSERVED = 2000;

function result(
  id: string,
  source: ScenarioResult['source'],
  outcome: ScenarioResult['outcome'],
  observed: string | null,
): ScenarioResult {
  return {
    id,
    source,
    outcome,
    observed: observed === null ? null : observed.slice(0, MAX_OBSERVED),
  };
}

interface CheckOutcome {
  readonly scenarios: readonly ScenarioResult[];
  readonly reasons: readonly WallReasonCode[];
}

function emptyCheck(): CheckOutcome {
  return { scenarios: [], reasons: [] };
}

function mergeChecks(...checks: readonly CheckOutcome[]): CheckOutcome {
  const scenarios: ScenarioResult[] = [];
  const reasons: WallReasonCode[] = [];
  for (const check of checks) {
    scenarios.push(...check.scenarios);
    for (const reason of check.reasons) if (!reasons.includes(reason)) reasons.push(reason);
  }
  return { scenarios, reasons };
}

// ---------------------------------------------------------------------------
// repeated execution — 2-of-3, because one run is a coin toss
// ---------------------------------------------------------------------------

const DEFAULT_RUNS_PER_SCENARIO = 3;
const MIN_RUNS_PER_SCENARIO = 1;
const MAX_RUNS_PER_SCENARIO = 9;

/**
 * Validate the repeat count.
 *
 * Odd only, because an even count has no majority and would quietly resolve ties by
 * whichever branch the code happened to test first. A misconfiguration throws rather
 * than defaulting: silently running once when the operator asked for five is the kind
 * of difference nobody notices until it matters.
 */
function runsPerScenario(policy: EvaluateInput['policy']): number {
  const runs = policy.runsPerScenario ?? DEFAULT_RUNS_PER_SCENARIO;
  if (
    typeof runs !== 'number' ||
    !Number.isInteger(runs) ||
    runs < MIN_RUNS_PER_SCENARIO ||
    runs > MAX_RUNS_PER_SCENARIO ||
    runs % 2 === 0
  ) {
    throw new FactoryError(
      'INTERNAL',
      `runsPerScenario must be an odd integer in [${MIN_RUNS_PER_SCENARIO}, ${MAX_RUNS_PER_SCENARIO}], got ${String(runs)}`,
    );
  }
  return runs;
}

interface MajorityOutcome {
  readonly outcome: 'pass' | 'fail' | 'unknown';
  /** `runs=3 pass=2 fail=1 unknown=0` — counts only, safe to place in a verdict. */
  readonly observed: string;
}

/**
 * Run a scenario `runs` times and take the majority.
 *
 * Three things this buys, and one it costs:
 *
 * - A **flaky** scenario (2 pass, 1 fail) reads as `pass`, which is what a working
 *   scenario in a noisy environment should read as. Before this, one flaky run
 *   rejected an honest change and taught the operator to re-run until green — the
 *   exact habit that destroys a gate's authority.
 * - A **broken** scenario (1 pass, 2 fail) reads as `fail`, so one lucky run cannot
 *   rescue a sabotage.
 * - A **split** verdict (1 pass, 1 fail, 1 timeout) reads as `unknown`. Not pass, not
 *   fail: the instrument disagreed with itself, and L3 says disagreement is
 *   unmeasured rather than a coin flip.
 * - The cost is **3x executions** on the acceptance surface and on both sides of
 *   delta. That is deliberate: this is the surface a sabotage attacks, so it is the
 *   one place where paying three times is cheaper than being wrong once.
 *   Faithfulness stays single-run because it compares an exact reproduction (exit
 *   code and output hash) rather than sampling a behaviour.
 *
 * Early stop: as soon as one outcome reaches the majority the remaining runs cannot
 * change the answer, so they are skipped. Deterministic given a deterministic runner.
 */
async function runForMajority(
  runner: ScenarioRunner,
  checkout: {
    readonly baseRev: string;
    readonly patchFile: string;
    readonly timeoutMs: number;
    readonly testRootFrom?: 'base' | 'candidate';
    readonly requires?: 'container';
    readonly network?: 'none';
  },
  argv: readonly string[],
  runs: number,
  judge: (run: ScenarioRunResult) => 'pass' | 'fail' | 'unknown',
): Promise<MajorityOutcome> {
  const needed = Math.floor(runs / 2) + 1;
  const tally = { pass: 0, fail: 0, unknown: 0 };
  let attempts = 0;

  for (let index = 0; index < runs; index += 1) {
    attempts += 1;
    let run: ScenarioRunResult;
    try {
      run = await runner.run({
        baseRev: checkout.baseRev,
        patchFile: checkout.patchFile,
        argv,
        timeoutMs: checkout.timeoutMs,
        // Isolation requirements travel with the *run*, not with the caller's convenience:
        // dropping them here would silently downgrade a container scenario to a local one,
        // which is the failure mode this field exists to prevent.
        ...(checkout.testRootFrom === undefined ? {} : { testRootFrom: checkout.testRootFrom }),
        ...(checkout.requires === undefined ? {} : { requires: checkout.requires }),
        ...(checkout.network === undefined ? {} : { network: checkout.network }),
      });
    } catch {
      // A runner that throws measured nothing; that is `unknown`, never `fail`.
      tally.unknown += 1;
      if (tally.unknown >= needed) break;
      continue;
    }
    tally[judge(run)] += 1;
    if (tally.pass >= needed || tally.fail >= needed) break;
  }

  const outcome: MajorityOutcome['outcome'] =
    tally.pass >= needed ? 'pass' : tally.fail >= needed ? 'fail' : 'unknown';
  return {
    outcome,
    observed: `runs=${attempts} pass=${tally.pass} fail=${tally.fail} unknown=${tally.unknown}`,
  };
}

/**
 * Per-run judgement for the wall's own suite.
 *
 * Absent summary is `unknown`, never `pass`: a runner that cannot report counts has not
 * told the wall anything, and "no news is good news" is the habit this package exists to
 * break.
 */
function summaryJudge(run: ScenarioRunResult): 'pass' | 'fail' | 'unknown' {
  if (run.timedOut || run.exitCode === null) return 'unknown';
  const summary = run.summary;
  if (summary === undefined) return 'unknown';
  if (summary.exitCode !== 0 || summary.failed > 0 || summary.unknown > 0) return 'fail';
  return 'pass';
}

/**
 * Per-run judgement for a scenario with an accepted exit-code set.
 *
 * A timeout is `unknown` rather than `fail` on purpose: a hang may be the candidate
 * (bad) or the machine (not the candidate's fault), and the difference is exactly
 * what the wall cannot see. Both readings refuse promotion; only one of them is
 * honest about why.
 */
function exitSetJudge(
  expectExit: readonly number[],
): (run: ScenarioRunResult) => 'pass' | 'fail' | 'unknown' {
  return (run) => {
    if (run.timedOut || run.exitCode === null) return 'unknown';
    return expectExit.includes(run.exitCode) ? 'pass' : 'fail';
  };
}

// ---------------------------------------------------------------------------
// 1. faithfulness — re-execute the receipt's own commands
// ---------------------------------------------------------------------------

/**
 * A receipt is faithful when its mechanical claims survive independent
 * re-execution. This runs first on purpose: if the receipt's own exit codes and
 * output hashes cannot be reproduced, nothing downstream is worth measuring, so a
 * divergence stops the verdict at `receipt_unfaithful` rather than letting the
 * candidate be judged on a story that already failed.
 */
/**
 * Can the wall re-execute this recorded command, and if not, why not?
 *
 * The rule is opt-in: only an explicit `replayable: true` is replayed. Absent provenance
 * means "not replayable", never "probably fine" — an adapter that forgets the field loses
 * replay coverage loudly (the verdict says which commands were not re-run) instead of
 * silently re-running a model, which on a live attempt spends money.
 *
 * `worker-launch` and `factory-verification` are refused even if a receipt asserts they are
 * replayable: the launch is the attempt under test (non-deterministic, side-effecting,
 * billed), and the factory's own `git diff --cached`/`--numstat` reads depend on index
 * state the wall does not reconstruct. A receipt that claims otherwise is wrong, and the
 * wall does not take the receipt's word for what can be replayed.
 */
function replayPolicy(
  command: DecisionReceipt['commands'][number],
  context: {
    readonly baseRev: string;
    readonly verificationProblem: string | null;
    readonly runnerKind?: 'container' | 'local';
  },
): {
  readonly replayable: boolean;
  readonly note: string | null;
  readonly argv?: readonly string[];
} {
  const source = command.source ?? 'unattributed';

  // The launch is the attempt under test. It is never replayed, whatever the receipt claims:
  // replaying it re-runs the worker, and on a live attempt that spends money.
  if (command.source === 'worker-launch') {
    return {
      replayable: false,
      note: 'worker-launch: the attempt under test is never replayed (non-deterministic, side-effecting, billed)',
    };
  }

  // The factory's own reads are decided by the wall, not by the receipt's flag: they are
  // deterministic given (base commit, staged tree), and the wall reconstructs that state. A
  // receipt that still marks them unreplayable (an adapter that has not been updated, or a
  // historical row) must not be able to close the gate forever — `unknown` would refuse every
  // real worker, which is the consequence this policy exists to avoid.
  if (command.source === 'factory-verification') {
    if (context.runnerKind === 'container') {
      return {
        replayable: false,
        note: "factory-verification: the wall's container image carries no git, so the index cannot be reconstructed there",
      };
    }
    if (context.verificationProblem !== null) {
      return { replayable: false, note: `factory-verification: ${context.verificationProblem}` };
    }
    // Not every git read is a function of (base, staged tree): a status form that reports
    // untracked or ignored entries depends on the working directory, which a commit cannot
    // reconstruct. The live attempt caught exactly that — two `git status` rows diverged and
    // failed a good change.
    const readProblem = verificationReadProblem(command.argv);
    if (readProblem !== null) {
      return { replayable: false, note: `factory-verification: ${readProblem}` };
    }
    const replayArgvForCommand = replayArgv(context.baseRev, command.argv);
    if (replayArgvForCommand === null) {
      return {
        replayable: false,
        note: 'factory-verification: the recorded argv cannot be replayed without a shell quoting surface the wall refuses to introduce',
      };
    }
    return { replayable: true, note: null, argv: replayArgvForCommand };
  }

  if (command.replayable === true) {
    return { replayable: true, note: null, argv: command.argv };
  }
  const why =
    command.replaySkipReason ??
    (command.source === undefined
      ? 'the receipt recorded no replay provenance'
      : 'the recorder marked it not replayable');
  return { replayable: false, note: `${source}: ${why}` };
}

/** `commands[2] (worker-launch: …)` for each skipped command, capped so `observed` fits. */
function describeNotReplayed(
  skipped: readonly { readonly index: number; readonly note: string }[],
): string {
  const shown = skipped
    .slice(0, 8)
    .map((entry) => `commands[${String(entry.index)}] (${entry.note})`);
  if (skipped.length > shown.length)
    shown.push(`…(+${String(skipped.length - shown.length)} more)`);
  return shown.join(', ');
}

async function checkFaithfulness(input: EvaluateInput): Promise<CheckOutcome> {
  const { receipt, spec, policy, runner } = input;

  // A patch cut from a different base cannot be replayed against this spec, so the
  // receipt does not describe this unit's attempt at all.
  if (receipt.diff.baseRev !== spec.baseRev) {
    return {
      scenarios: [
        result(
          'faithfulness:base',
          'faithfulness',
          'fail',
          'receipt base revision is not the spec base revision',
        ),
      ],
      reasons: ['receipt_unfaithful'],
    };
  }

  if (receipt.commands.length === 0) {
    // Nothing recorded means nothing to reproduce. That is an unavailable
    // measurement, and an agent that ran nothing has proven nothing.
    return {
      scenarios: [
        result('faithfulness', 'faithfulness', 'unknown', 'no commands recorded to re-execute'),
      ],
      reasons: ['receipt_unavailable'],
    };
  }

  const scenarios: ScenarioResult[] = [];
  const reasons: WallReasonCode[] = [];
  const skipped: { index: number; note: string }[] = [];
  let replayed = 0;
  let mismatched = 0;

  for (let index = 0; index < receipt.commands.length; index += 1) {
    const command = receipt.commands[index];
    if (command === undefined) continue;
    const id = `faithfulness:${String(index + 1).padStart(2, '0')}`;

    const verificationProblem = verificationSequenceProblem(receipt.commands, receipt.diff.baseRev);
    const policyForCommand = replayPolicy(command, {
      baseRev: receipt.diff.baseRev,
      verificationProblem,
      ...(runner.kind === undefined ? {} : { runnerKind: runner.kind }),
    });
    if (!policyForCommand.replayable) {
      // Not replayed, and recorded as such rather than silently dropped: the verdict has to
      // say which claims were not independently checked. The scenario passes because this
      // command is not evidence *against* the change; the scope note carries the honesty.
      skipped.push({ index, note: policyForCommand.note ?? 'not replayable' });
      scenarios.push(
        result(
          id,
          'faithfulness',
          'pass',
          `not replayed — ${policyForCommand.note ?? 'not replayable'}`,
        ),
      );
      continue;
    }
    replayed += 1;

    let observed: ScenarioRunResult;
    try {
      observed = await runner.run({
        baseRev: receipt.diff.baseRev,
        patchFile: receipt.diff.patchFile,
        argv: policyForCommand.argv ?? command.argv,
        timeoutMs: policy.commandTimeoutMs,
      });
    } catch (error) {
      // A brokered refusal is not a transport failure: the command was not re-run
      // because a person had not approved it, and the operator has to see that
      // distinction. Collapsing it into `receipt_unavailable` would report a gate as
      // an accident -- the same shape of lie as the outbox comment.
      const refused = error instanceof PrivilegedBrokerRefusal;
      scenarios.push(
        result(
          id,
          'faithfulness',
          'unknown',
          refused ? error.message : 'recorded command could not be re-executed',
        ),
      );
      // The code names the refusal, not the operation: the wall is not a consumer of decisions, so
      // what it observed is "the replay was refused because it had no decision", never "this
      // operation was never approved". `privileged_unbrokered` stays in the contract for verdicts
      // already on disk; new rows carry the additive code.
      const reason = refused ? 'privileged_replay_refused' : 'receipt_unavailable';
      if (!reasons.includes(reason)) reasons.push(reason);
      continue;
    }

    if (observed.exitCode !== command.exitCode || observed.outputSha !== command.outputSha) {
      mismatched += 1;
      // The operator needs to know a divergence exists; the agent must not learn
      // which byte differed, because that is the signal it would optimise next.
      scenarios.push(
        result(id, 'faithfulness', 'fail', 'recorded exit code or output hash was not reproduced'),
      );
      if (!reasons.includes('receipt_unfaithful')) reasons.push('receipt_unfaithful');
      continue;
    }

    scenarios.push(result(id, 'faithfulness', 'pass', 'exit code and output hash reproduced'));
  }

  // The scope note is the whole point of this rewrite. A faithfulness pass means "every
  // command the wall *could* re-execute did reproduce" — never "everything was replayed" —
  // and the verdict says which commands were left alone, with the reason for each.
  const notReplayed = skipped.length === 0 ? null : describeNotReplayed(skipped);
  const total = receipt.commands.length;
  const scopeObserved = ((): string => {
    const head = `replayed ${String(replayed)} of ${String(total)} recorded commands; ${String(mismatched)} mismatched`;
    return notReplayed === null
      ? `${head}; nothing skipped`
      : `${head}; not replayed: ${notReplayed}`;
  })();

  if (replayed === 0) {
    // Nothing was independently checked. That is an unavailable measurement, not a
    // failure — the change may be perfectly good — and `unknown` refuses every gate.
    scenarios.push(result('faithfulness:scope', 'faithfulness', 'unknown', scopeObserved));
    if (!reasons.includes('faithfulness_partial')) reasons.push('faithfulness_partial');
    return { scenarios, reasons };
  }

  // No `faithfulness_partial` on this path: a reason here would degrade the pass to
  // `unknown` (the invariant below), and a change whose replayable commands reproduced has
  // earned its pass. The scope note in `observed` is what carries the honesty — the operator
  // reads it, and `oneLineReason` promotes it whenever the verdict is not a pass.
  // The scope row's outcome must agree with its own sentence. A live attempt produced
  // `outcome: pass` on a row whose text read `2 mismatched` — a green line that reports a
  // divergence, which is the verdict lying rather than the check failing. The overall verdict
  // was `fail` only because `receipt_unfaithful` came along; do not rely on that coupling.
  scenarios.push(
    result('faithfulness:scope', 'faithfulness', mismatched > 0 ? 'fail' : 'pass', scopeObserved),
  );
  // A refusal states its own scope too: on a `fail` the extra code cannot mask anything
  // (a failure is already the outcome), and the operator should know that the launch was
  // skipped before concluding that "the wall re-ran everything and it diverged".
  if (mismatched > 0 && skipped.length > 0 && !reasons.includes('faithfulness_partial')) {
    reasons.push('faithfulness_partial');
  }

  return { scenarios, reasons };
}

// ---------------------------------------------------------------------------
// 2. acceptance — the unit's own criteria, mechanically
// ---------------------------------------------------------------------------

/**
 * Split an acceptance `target` into argv.
 *
 * JSON array form is preferred and exact. A whitespace split is accepted for
 * hand-written specs, and is documented as *not* shell quoting: `"a b"` is two
 * arguments, so anything needing quoting must be written as JSON. Guessing at
 * shell syntax here would make the wall's behaviour depend on a parser rather
 * than on the spec.
 */
function parseOracleArgv(criterion: AcceptanceCriterion): readonly string[] | null {
  const raw = criterion.oracle.target.trim();
  if (raw === '') return null;
  if (raw.startsWith('[')) {
    try {
      const parsed: unknown = JSON.parse(raw);
      if (!Array.isArray(parsed) || parsed.length === 0) return null;
      const exact: string[] = [];
      for (const value of parsed) {
        if (typeof value !== 'string' || value.length === 0) return null;
        exact.push(value);
      }
      return exact;
    } catch {
      return null;
    }
  }
  const parts = raw.split(/\s+/).filter((part) => part.length > 0);
  return parts.length === 0 ? null : parts;
}

/** The expected exit code for a `command` oracle, or `null` when `expect` is not one. */
function parseExpectedExit(expect: string): number | null {
  const match = /^\s*(?:exit\s*)?(-?\d{1,3})\s*$/i.exec(expect);
  if (match === null) return null;
  const digits = match[1];
  if (digits === undefined) return null;
  const value = Number.parseInt(digits, 10);
  return Number.isInteger(value) ? value : null;
}

/**
 * Run the unit's acceptance criteria.
 *
 * Only the `command` oracle is implemented in v1. `unit-test`, `http` and `data`
 * are *unmeasured*, which means `unknown`, which means the unit cannot pass — the
 * honest consequence of L3, and the reason a real deployment must either widen
 * this switch or author `command` oracles. An unimplemented oracle must never be
 * approximated by "assume it would have passed"; that is the whole failure mode
 * the wall exists to prevent.
 */
async function checkAcceptance(input: EvaluateInput, runs: number): Promise<CheckOutcome> {
  const { spec, receipt, policy, runner } = input;
  const scenarios: ScenarioResult[] = [];
  const reasons: WallReasonCode[] = [];

  for (const criterion of spec.acceptance) {
    const id = `acceptance:${criterion.id}`;

    if (criterion.oracle.kind !== 'command') {
      scenarios.push(
        result(
          id,
          'acceptance',
          'unknown',
          `oracle kind '${criterion.oracle.kind}' is not implemented by this wall version`,
        ),
      );
      if (!reasons.includes('acceptance_unmeasured')) reasons.push('acceptance_unmeasured');
      continue;
    }

    const argv = parseOracleArgv(criterion);
    const expected = parseExpectedExit(criterion.oracle.expect);
    if (argv === null || expected === null) {
      scenarios.push(
        result(
          id,
          'acceptance',
          'unknown',
          'oracle could not be parsed into argv and an expected exit code',
        ),
      );
      if (!reasons.includes('acceptance_unmeasured')) reasons.push('acceptance_unmeasured');
      continue;
    }

    const verdict = await runForMajority(
      runner,
      {
        baseRev: receipt.diff.baseRev,
        patchFile: receipt.diff.patchFile,
        timeoutMs: policy.commandTimeoutMs,
      },
      argv,
      runs,
      exitSetJudge([expected]),
    );

    if (verdict.outcome === 'fail') {
      scenarios.push(result(id, 'acceptance', 'fail', `oracle failed (${verdict.observed})`));
      if (!reasons.includes('acceptance_unmet')) reasons.push('acceptance_unmet');
      continue;
    }
    if (verdict.outcome === 'unknown') {
      scenarios.push(
        result(id, 'acceptance', 'unknown', `oracle unmeasured (${verdict.observed})`),
      );
      if (!reasons.includes('acceptance_unmeasured')) reasons.push('acceptance_unmeasured');
      continue;
    }

    scenarios.push(result(id, 'acceptance', 'pass', `oracle satisfied (${verdict.observed})`));
  }

  return { scenarios, reasons };
}

// ---------------------------------------------------------------------------
// 3 + 4. holdout and Δ — the wall proper
// ---------------------------------------------------------------------------

interface HoldoutAssessment extends CheckOutcome {
  readonly delta: Delta;
  /** Every scenario observation this run made, so the caller can judge and record it. */
  readonly observations: readonly CriteriaLogEntry[];
}

const RATE_PRECISION = 1_000_000;

/** Round to 6 dp so a threshold comparison cannot turn on floating-point noise. */
function roundRate(value: number): number {
  return Math.round(value * RATE_PRECISION) / RATE_PRECISION;
}

function scenarioHandle(index: number): string {
  // Positional, not the scenario id: a verdict that names scenarios is a verdict
  // an agent can use as an oracle to confirm a guess about the holdout.
  return `holdout:${String(index + 1).padStart(2, '0')}`;
}

/**
 * Carry a scenario's declared isolation requirement into the run input.
 *
 * Spread rather than assigned, because `exactOptionalPropertyTypes` distinguishes "absent"
 * from "explicitly undefined" and the runner uses absence as "no requirement".
 */
function requirementOf(scenario: HoldoutScenario): ScenarioRequirements {
  return {
    ...(scenario.requires === undefined ? {} : { requires: scenario.requires }),
  };
}

async function assessHoldout(input: EvaluateInput, runs: number): Promise<HoldoutAssessment> {
  const { holdout, policy, runner, receipt } = input;
  const threshold = policy.deltaThreshold;

  const absentDelta: Delta = {
    checked: false,
    baseRate: null,
    candidateRate: null,
    threshold,
    observed: null,
    holdoutRevision: HOLDOUT_ABSENT_REVISION,
  };

  if (holdout === null || holdout.scenarios.length === 0) {
    return {
      scenarios: [
        result('holdout', 'holdout', 'unknown', 'no usable holdout store for this task class'),
      ],
      reasons: ['holdout_unavailable', 'delta_unmeasured'],
      delta: absentDelta,
      observations: [],
    };
  }

  const ordered = [...holdout.scenarios].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  const scenarios: ScenarioResult[] = [];
  const reasons: WallReasonCode[] = [];
  const observations: CriteriaLogEntry[] = [];
  const checkout = { baseRev: receipt.diff.baseRev, timeoutMs: policy.commandTimeoutMs };

  const candidatePassed: (boolean | null)[] = [];
  for (let index = 0; index < ordered.length; index += 1) {
    const scenario = ordered[index];
    if (scenario === undefined) continue;
    const id = scenarioHandle(index);

    const verdict = await runForMajority(
      runner,
      { ...checkout, patchFile: receipt.diff.patchFile, ...requirementOf(scenario) },
      scenario.argv,
      runs,
      exitSetJudge(scenario.expectExit),
    );

    observations.push(observation(holdout, receipt, scenario.id, 'candidate', verdict.outcome));

    if (verdict.outcome === 'fail') {
      scenarios.push(result(id, 'holdout', 'fail', `scenario failed (${verdict.observed})`));
      reasons.push('holdout_failed');
      candidatePassed.push(false);
      continue;
    }
    if (verdict.outcome === 'unknown') {
      scenarios.push(result(id, 'holdout', 'unknown', `scenario unmeasured (${verdict.observed})`));
      reasons.push('holdout_unavailable');
      candidatePassed.push(null);
      continue;
    }

    scenarios.push(result(id, 'holdout', 'pass', `scenario passed (${verdict.observed})`));
    candidatePassed.push(true);
  }

  // Delta's base rate: the same scenarios against a clean checkout of the base
  // revision, no patch. This is the only measurement that says whether the holdout
  // is discriminating at all — a scenario set that already passes on the base cannot
  // credit the candidate with anything. These base observations are also what the
  // discrimination control reads, live, without trusting the log.
  const basePassed: (boolean | null)[] = [];
  for (const scenario of ordered) {
    const verdict = await runForMajority(
      runner,
      { ...checkout, patchFile: NO_PATCH, ...requirementOf(scenario) },
      scenario.argv,
      runs,
      exitSetJudge(scenario.expectExit),
    );

    observations.push(observation(holdout, receipt, scenario.id, 'base', verdict.outcome));
    basePassed.push(verdict.outcome === 'unknown' ? null : verdict.outcome === 'pass');
  }

  const candidateMeasured = candidatePassed.every((value) => value !== null);
  const baseMeasured = basePassed.every((value) => value !== null);
  const checked = candidateMeasured && baseMeasured && ordered.length > 0;

  let delta: Delta;
  if (!checked) {
    delta = {
      checked: false,
      baseRate: null,
      candidateRate: null,
      threshold,
      observed: null,
      holdoutRevision: holdout.revision,
    };
    scenarios.push(
      result(
        'delta',
        'delta',
        'unknown',
        'holdout pass rate could not be measured on both revisions',
      ),
    );
    reasons.push('delta_unmeasured');
    return { scenarios, reasons, delta, observations };
  }

  const total = ordered.length;
  const candidateHits = candidatePassed.filter((value) => value === true).length;
  const baseHits = basePassed.filter((value) => value === true).length;
  const candidateRate = roundRate(candidateHits / total);
  const baseRate = roundRate(baseHits / total);
  const observedDelta = roundRate(candidateRate - baseRate);

  delta = {
    checked: true,
    baseRate,
    candidateRate,
    threshold,
    observed: observedDelta,
    holdoutRevision: holdout.revision,
  };

  if (observedDelta < threshold) {
    scenarios.push(
      result('delta', 'delta', 'fail', 'holdout pass rate regressed against the base revision'),
    );
    reasons.push('delta_regression');
  } else {
    scenarios.push(
      result(
        'delta',
        'delta',
        'pass',
        'holdout pass rate did not regress against the base revision',
      ),
    );
  }

  return { scenarios, reasons, delta, observations };
}

/** Build one log entry. `side` is what lets the control tell "base already passed" from "the change made it pass". */
function observation(
  holdout: HoldoutStore,
  receipt: DecisionReceipt,
  scenarioId: string,
  side: 'base' | 'candidate',
  outcome: 'pass' | 'fail' | 'unknown',
): CriteriaLogEntry {
  return {
    taskClass: holdout.taskClass,
    holdoutRevision: holdout.revision,
    scenarioId,
    revision: receipt.diff.baseRev,
    side,
    outcome,
    at: '',
  };
}

// ---------------------------------------------------------------------------
// 3b. is the holdout capable of telling the change from the base?
// ---------------------------------------------------------------------------

interface QualityAssessment extends CheckOutcome {
  readonly report: DiscriminationReport | null;
}

/**
 * The non-discriminating-holdout control.
 *
 * Delta is *relative*, so a holdout whose scenarios already pass on the base yields
 * delta = 0 and satisfies a threshold of 0 — the wall would approve anything, and
 * say nothing. This check is the instrument's own health check: how many scenarios
 * pass on **every** base run observed?
 *
 * Two independent inputs, and neither alone is trusted:
 *   - the **live** base observations this run just made (authoritative), and
 *   - the **log** of previous observations (history, so drift shows up over weeks).
 * Corrupting the log therefore cannot help a candidate: the live measurement is
 * always included, so damage can only reduce information, and damage *itself*
 * degrades the verdict (a control that a single corrupted byte can reset is not a
 * control).
 */
function assessHoldoutQuality(
  holdout: HoldoutStore | null,
  observations: readonly CriteriaLogEntry[],
  log: { readonly entries: readonly CriteriaLogEntry[]; readonly corruptLines: number },
  maxNonDiscriminating: number,
  nowIso: string,
): QualityAssessment {
  if (holdout === null || holdout.scenarios.length === 0) {
    return { scenarios: [], reasons: [], report: null };
  }

  if (log.corruptLines > 0) {
    return {
      scenarios: [
        result(
          'holdout:quality',
          'holdout',
          'unknown',
          `criteria log has ${log.corruptLines} unparseable line(s); usable history is incomplete, so the holdout cannot be certified`,
        ),
      ],
      // No dedicated reason code exists for a damaged log, and the semantic that
      // matters is "the evidence that would certify this holdout is unavailable".
      reasons: ['holdout_unavailable'],
      report: null,
    };
  }

  const live = observations.map((entry) => ({ ...entry, at: nowIso }));
  const report = assessDiscrimination(holdout, log.entries, {
    maxNonDiscriminating,
    extraBaseRuns: live,
  });

  if (!report.checked) {
    // No base run could be measured. The delta check already reports that fact, so
    // this adds no reason of its own — but it still records that the check ran.
    return {
      scenarios: [
        result(
          'holdout:quality',
          'holdout',
          'unknown',
          'discrimination unassessed: no base run could be measured',
        ),
      ],
      reasons: [],
      report,
    };
  }

  if (!report.discriminates) {
    // Counts and the threshold only: the operator must be able to see the
    // instrument, and the verdict must not carry a scenario id.
    const sentence = `${report.nonDiscriminating.length} of ${report.scenarios.length} holdout scenarios pass on every base revision — the holdout cannot distinguish this change from the base (threshold ${report.maxAllowed})`;
    return {
      scenarios: [result('holdout:quality', 'holdout', 'unknown', sentence)],
      reasons: ['holdout_not_discriminating'],
      report,
    };
  }

  return {
    scenarios: [
      result(
        'holdout:quality',
        'holdout',
        'pass',
        `${(report.scenarios.length - report.nonDiscriminating.length).toString()} of ${report.scenarios.length} holdout scenarios distinguish the change from the base (max non-discriminating ${report.maxAllowed})`,
      ),
    ],
    reasons: [],
    report,
  };
}

// ---------------------------------------------------------------------------
// 2b. the wall's own oracle (A4.1, A6)
// ---------------------------------------------------------------------------

/**
 * Run the wall's pinned suite over the **base test root**.
 *
 * This is the amendment's central correction to the acceptance path. The spec's oracles
 * are operator-authored, so they were never the problem; the problem is that a candidate
 * can weaken the tests that judge it and still report green. Checking out the base test
 * root removes that lever entirely, and reading a machine-readable summary removes the
 * other one (parsing the agent's own log output).
 *
 * Uses the contract's dormant `suite_failed` / `suite_unknown` codes rather than `acceptance_*`:
 * a failing wall-owned suite is not the same fact as an unmet acceptance criterion, and
 * collapsing them would hide which surface failed.
 */
async function checkWallSuite(input: EvaluateInput, runs: number): Promise<CheckOutcome> {
  const pinned = input.policy.pinnedSuite;
  if (pinned === undefined || pinned.argv.length === 0) {
    return {
      scenarios: [
        result(
          'suite',
          'suite',
          'unknown',
          'no pinned suite declared: the wall has no oracle of its own',
        ),
      ],
      reasons: ['suite_unknown'],
    };
  }

  const verdict = await runForMajority(
    input.runner,
    {
      baseRev: input.receipt.diff.baseRev,
      patchFile: input.receipt.diff.patchFile,
      timeoutMs: input.policy.commandTimeoutMs,
      testRootFrom: 'base',
      ...(input.policy.pinnedSuite?.requires === undefined
        ? {}
        : { requires: input.policy.pinnedSuite.requires }),
    },
    pinned.argv,
    runs,
    summaryJudge,
  );

  if (verdict.outcome === 'fail') {
    return {
      scenarios: [
        result('suite', 'suite', 'fail', `the wall's own suite failed (${verdict.observed})`),
      ],
      reasons: ['suite_failed'],
    };
  }
  if (verdict.outcome === 'unknown') {
    return {
      scenarios: [
        result(
          'suite',
          'suite',
          'unknown',
          `the wall's own suite produced no readable summary (${verdict.observed})`,
        ),
      ],
      reasons: ['suite_unknown'],
    };
  }

  return {
    scenarios: [
      result('suite', 'suite', 'pass', `the wall's own suite passed (${verdict.observed})`),
    ],
    reasons: [],
  };
}

// ---------------------------------------------------------------------------
// 4b. the test surface, and the non-empty-diff invariant (A4.2)
// ---------------------------------------------------------------------------

/**
 * The test surface: the things that decide whether a change passes, rather than the
 * change itself.
 *
 * A diff touching any of these is `lit` — never a pass — because a green run produced by
 * modified tests, a modified runner config or a `postinstall` script is not evidence
 * about the code that was supposed to change. This is *path* analysis; `tests_weakened`
 * is *content* analysis and the two answer different questions.
 */
const TEST_FILE = /\.(?:test|spec)\.(?:[cm]?[jt]sx?)$/;

const TEST_SURFACE_PATTERNS: readonly { readonly pattern: RegExp; readonly why: string }[] = [
  { pattern: TEST_FILE, why: 'test files are the instrument, not the change' },
  {
    pattern:
      /(^|\/)(package\.json|pnpm-lock\.yaml|package-lock\.json|yarn\.lock|Cargo\.toml|Cargo\.lock|go\.mod|go\.sum|requirements\.txt|pyproject\.toml|poetry\.lock|Gemfile\.lock|composer\.json)$/,
    why: 'dependency manifest or lockfile (a lifecycle script is executable code in the oracle)',
  },
  {
    pattern:
      /(^|\/)(vitest|jest|mocha|ava|karma|playwright|cypress|pytest|tox)\.(config|conf)?\.?[a-z]*$/,
    why: 'test-runner configuration',
  },
  {
    pattern:
      /(^|\/)(\.github\/workflows\/|Makefile$|\.gitlab-ci\.yml$|\.travis\.yml$|Jenkinsfile$|azure-pipelines\.yml$|\.git\/hooks\/)/,
    why: 'CI or hook script',
  },
];

function checkTestSurface(files: readonly ChangedFile[] | null): CheckOutcome {
  if (files === null) {
    return {
      scenarios: [
        result(
          'test-surface',
          'policy',
          'unknown',
          'diff surface unavailable, so the test surface could not be checked',
        ),
      ],
      reasons: ['receipt_unavailable'],
    };
  }

  const touched: string[] = [];
  const whys: string[] = [];
  for (const file of files) {
    const path = normalisePath(file.path);
    for (const rule of TEST_SURFACE_PATTERNS) {
      if (!rule.pattern.test(path)) continue;
      if (!touched.includes(path)) touched.push(path);
      if (!whys.includes(rule.why)) whys.push(rule.why);
      break;
    }
  }

  if (touched.length > 0) {
    // Names the paths: the agent wrote them, so this leaks nothing it does not already
    // have, and an operator deciding whether to intervene needs to know which surface moved.
    return {
      scenarios: [
        result(
          'test-surface',
          'policy',
          'fail',
          `${touched.length} changed path(s) on the test surface: ${touched.join(', ')}`,
        ),
      ],
      reasons: ['test_surface_changed'],
    };
  }

  return {
    scenarios: [result('test-surface', 'policy', 'pass', 'no changed path is on the test surface')],
    reasons: [],
  };
}

/**
 * A diff with nothing in it is not a change that passed; it is a change that was not
 * made. A4.2's other half — `diff == ∅ ∧ status ≠ ∅` — is checkable only when the receipt
 * recorded `statusPaths`; when it did not, the wall says so instead of inferring that
 * the working tree was clean.
 */
function checkDiffNonEmpty(
  files: readonly ChangedFile[] | null,
  receipt: DecisionReceipt,
): CheckOutcome {
  if (files === null) {
    return {
      scenarios: [
        result(
          'diff',
          'policy',
          'unknown',
          'diff surface unavailable, so a non-empty diff could not be established',
        ),
      ],
      reasons: ['receipt_unavailable'],
    };
  }

  if (files.length > 0) {
    return {
      scenarios: [result('diff', 'policy', 'pass', `${files.length} changed path(s) in the diff`)],
      reasons: [],
    };
  }

  const statusPaths = receipt.diff.statusPaths ?? [];
  if (statusPaths.length > 0) {
    return {
      scenarios: [
        result(
          'diff',
          'policy',
          'fail',
          `the diff is empty but ${statusPaths.length} path(s) were uncommitted in the working tree`,
        ),
      ],
      reasons: ['receipt_unfaithful'],
    };
  }

  return {
    scenarios: [
      result(
        'diff',
        'policy',
        'unknown',
        'the diff is empty; the receipt recorded no working-tree status, so untracked work cannot be ruled out',
      ),
    ],
    reasons: ['no_change'],
  };
}

// ---------------------------------------------------------------------------
// 5. tests weakened
// ---------------------------------------------------------------------------

async function inspectChangedFiles(
  diff: DiffInspector | undefined,
): Promise<readonly ChangedFile[] | null> {
  if (diff === undefined) return null;
  try {
    return await diff.changedFiles();
  } catch {
    return null;
  }
}

function dependencyMatches(path: string, dependency: string): boolean {
  const dep = normalisePath(dependency);
  if (dep === '' || dep.includes('*')) return false;
  return path === dep || path.startsWith(dep.endsWith('/') ? dep : `${dep}/`);
}

/**
 * Refuse a patch that removes the evidence it is graded on.
 *
 * Deletion, emptying and assertion-stripping are detectable from the diff's file
 * list. **Rewriting is not**: a test whose body is replaced with `assert(true)`
 * looks identical to a test that was "cleaned up", and this check cannot tell them
 * apart. That is the honest limit of this control, and the reason the holdout
 * exists as a *separate* surface the patch never touches — the weakening check
 * catches the crude case, the holdout catches the subtle one.
 */
async function checkTestsWeakened(
  input: EvaluateInput,
  files: readonly ChangedFile[] | null,
): Promise<CheckOutcome> {
  if (files === null) {
    return {
      scenarios: [
        result(
          'tests-weakened',
          'policy',
          'unknown',
          'diff surface unavailable, so changed files could not be inspected',
        ),
      ],
      reasons: ['receipt_unavailable'],
    };
  }

  const dependencies = new Set<string>();
  for (const scenario of input.holdout?.scenarios ?? []) {
    for (const dependency of scenario.dependsOn ?? []) dependencies.add(normalisePath(dependency));
  }

  const weakened: string[] = [];
  for (const file of files) {
    const path = normalisePath(file.path);
    const removedOrEmptied = file.kind === 'deleted' || file.emptied === true;
    const strippedAssertions = (file.removedAssertions ?? 0) > 0;

    if (TEST_FILE.test(path) && (removedOrEmptied || strippedAssertions)) {
      weakened.push(path);
      continue;
    }
    if (removedOrEmptied) {
      for (const dependency of dependencies) {
        if (dependencyMatches(path, dependency)) {
          weakened.push(path);
          break;
        }
      }
    }
  }

  if (weakened.length > 0) {
    // The count, never the paths: the verdict must not hand the next attempt a map
    // of which files the wall was watching.
    return {
      scenarios: [
        result(
          'tests-weakened',
          'policy',
          'fail',
          `${weakened.length} test or holdout-dependency file(s) removed, emptied or stripped`,
        ),
      ],
      reasons: ['tests_weakened'],
    };
  }

  return {
    scenarios: [
      result(
        'tests-weakened',
        'policy',
        'pass',
        'no test or holdout-dependency file removed, emptied or stripped',
      ),
    ],
    reasons: [],
  };
}

// ---------------------------------------------------------------------------
// 6. scope
// ---------------------------------------------------------------------------

async function checkScope(
  input: EvaluateInput,
  files: readonly ChangedFile[] | null,
): Promise<CheckOutcome> {
  if (files === null) {
    return {
      scenarios: [
        result(
          'scope',
          'policy',
          'unknown',
          'diff surface unavailable, so scope could not be checked',
        ),
      ],
      reasons: ['receipt_unavailable'],
    };
  }

  const changedPaths = files.map((file) => normalisePath(file.path));

  // The security ladder runs first because it is the more specific fact. A declared
  // sensitive path is a planned, reviewed change; an undeclared one is camouflage, and
  // a green holdout does not excuse it (A5.1).
  const security = assessSecurityPaths(
    changedPaths,
    input.spec.touchPaths,
    input.spec.operationClasses,
  );
  if (security.undeclared.length > 0) {
    return {
      scenarios: [result('scope', 'policy', 'fail', security.detail)],
      reasons: ['scope_violation'],
    };
  }

  const outside = changedPaths.filter((path) => !pathIsInScope(path, input.spec.touchPaths));

  if (outside.length > 0) {
    return {
      scenarios: [
        result(
          'scope',
          'policy',
          'fail',
          `${outside.length} changed path(s) outside the declared touch paths`,
        ),
      ],
      reasons: ['scope_violation'],
    };
  }

  return {
    scenarios: [
      result(
        'scope',
        'policy',
        'pass',
        `${files.length} changed path(s), all inside the declared touch paths`,
      ),
    ],
    reasons: [],
  };
}

// ---------------------------------------------------------------------------
// 7. irreversible operation
// ---------------------------------------------------------------------------

/**
 * Refuse a unit whose declared effect is irreversible, or whose receipt records a
 * destructive command.
 *
 * The declaration half is complete and deterministic. The recorded-command half is
 * a denylist and therefore partial: a destructive command the agent ran and did
 * not record is invisible here. What catches *that* is check 1 — the receipt's
 * claims are re-executed — plus the structural control that the worker holds no
 * production credential at all.
 */
function checkIrreversible(input: EvaluateInput): CheckOutcome {
  const declared = input.spec.operationClasses.filter((operation: OperationClass) =>
    IRREVERSIBLE_OPERATION_CLASSES.includes(operation),
  );
  if (declared.length > 0) {
    return {
      scenarios: [
        result(
          'irreversible',
          'policy',
          'fail',
          `${declared.length} irreversible operation class(es) declared`,
        ),
      ],
      reasons: ['irreversible_operation'],
    };
  }

  // Security-relevant operation classes never pass, even when reversible (A5.1): a
  // `network-egress` change can move data out, and its reversibility is irrelevant to
  // that. The dedicated `sensitive_operation` code exists precisely so the operator line
  // does not claim an egress change was irreversible — it was not, and that is the point.
  const sensitive = input.spec.operationClasses.filter((operation: OperationClass) =>
    SENSITIVE_OPERATION_CLASSES.includes(operation),
  );
  if (sensitive.length > 0) {
    return {
      scenarios: [
        result(
          'irreversible',
          'policy',
          'fail',
          `${sensitive.length} security-sensitive operation class(es) declared: ${sensitive.join(', ')}`,
        ),
      ],
      reasons: ['sensitive_operation'],
    };
  }

  const destructive = input.receipt.commands.filter((command) => isDestructiveArgv(command.argv));
  if (destructive.length > 0) {
    return {
      scenarios: [
        result(
          'irreversible',
          'policy',
          'fail',
          `${destructive.length} recorded command(s) matched the destructive denylist`,
        ),
      ],
      reasons: ['irreversible_operation'],
    };
  }

  return {
    scenarios: [
      result(
        'irreversible',
        'policy',
        'pass',
        'no irreversible operation class declared and no destructive command recorded',
      ),
    ],
    reasons: [],
  };
}

// ---------------------------------------------------------------------------
// the decision
// ---------------------------------------------------------------------------

/**
 * Derive the policy identity from the fields that actually change a decision.
 *
 * The contract requires `policyVersion` on every verdict and `EvaluateInput.policy`
 * does not carry one, so it is content-derived rather than invented: two runs with
 * different thresholds cannot share a policy identity, which is exactly the
 * property that lets a verdict be declared stale instead of silently reused.
 */
function derivePolicyVersion(policy: EvaluateInput['policy']): string {
  const explicit = policy.policyVersion;
  if (explicit !== undefined && explicit.trim() !== '') return explicit;
  return `wall-policy/${contentHash({
    deltaThreshold: policy.deltaThreshold,
    commandTimeoutMs: policy.commandTimeoutMs,
    runsPerScenario: policy.runsPerScenario ?? DEFAULT_RUNS_PER_SCENARIO,
    maxNonDiscriminating: policy.maxNonDiscriminating ?? 0,
    wallVersion: policy.wallVersion,
  }).slice('sha256:'.length, 'sha256:'.length + 16)}`;
}

/**
 * The `+local` label: a verdict must say whether it was produced in a container.
 *
 * Derived from the runner rather than from policy, deliberately. Every other instrument
 * fact is operator policy (an operator declares the image), but the *kind* of environment is
 * a property of the object doing the running, and a caller who has to remember to declare it
 * will eventually forget — producing a verdict that looks like containment and is not.
 */
function runnerVersionSuffix(input: EvaluateInput): string {
  if (input.policy.imageDigest !== undefined) return '';
  return input.runner.kind === 'local' ? '+local' : '';
}

/**
 * How many independent Δ measurements this task class has (A4.7).
 *
 * A sample is one code revision for which the log holds both a base and a candidate
 * observation of at least one scenario. Errored runs are not samples: an attempt whose
 * scenario never ran measured nothing, and counting it would inflate the class's apparent
 * evidence — the exact way a "certified" class becomes an unmeasured one with paperwork.
 */
function countDeltaSamples(
  holdout: HoldoutStore,
  live: readonly CriteriaLogEntry[],
  log: readonly CriteriaLogEntry[],
): number {
  const relevant = [...log, ...live].filter(
    (entry) => entry.taskClass === holdout.taskClass && entry.holdoutRevision === holdout.revision,
  );

  const byRevision = new Map<string, { base: boolean; candidate: boolean }>();
  for (const entry of relevant) {
    const current = byRevision.get(entry.revision) ?? { base: false, candidate: false };
    if (entry.side === 'base') current.base = true;
    else current.candidate = true;
    byRevision.set(entry.revision, current);
  }

  return [...byRevision.values()].filter((entry) => entry.base && entry.candidate).length;
}

/**
 * The class's certification attempts: one per paired revision, and "passed" when the candidate
 * side of that attempt produced no `fail` and no unmeasured run.
 *
 * A paired revision is one *attempt* — base and candidate observations of the same scenario set —
 * which is the unit ND1 certifies. Counting scenario rows instead would make a class look
 * certifiable because its tasks have many scenarios, which is the same error as counting test cases
 * as attempts.
 */
export function countClassAttempts(
  holdout: HoldoutStore,
  live: readonly CriteriaLogEntry[],
  log: readonly CriteriaLogEntry[],
): { readonly samples: number; readonly passes: number } {
  const relevant = [...log, ...live].filter(
    (entry) => entry.taskClass === holdout.taskClass && entry.holdoutRevision === holdout.revision,
  );
  const byRevision = new Map<string, { base: boolean; candidate: number; clean: boolean }>();
  for (const entry of relevant) {
    const current = byRevision.get(entry.revision) ?? { base: false, candidate: 0, clean: true };
    if (entry.side === 'base') current.base = true;
    else {
      current.candidate += 1;
      if (entry.outcome !== 'pass') current.clean = false;
    }
    byRevision.set(entry.revision, current);
  }
  const attempts = [...byRevision.values()].filter((entry) => entry.base && entry.candidate > 0);
  return {
    samples: attempts.length,
    passes: attempts.filter((entry) => entry.clean).length,
  };
}

/**
 * Is the *class* certifiable, or does this pass require a human signature?
 *
 * The unit-level verdict is unchanged: the unit verified. What degrades is the right to
 * promote itself — a class with two Δ samples does not yet know its own error rate, and
 * pretending otherwise is what A4.7 calls the cold-start hole. The flag, not a reason
 * code, because a reason code would flip the verdict to `unknown` and lie in the other
 * direction.
 */
function checkClassCertification(
  holdout: HoldoutStore | null,
  live: readonly CriteriaLogEntry[],
  log: readonly CriteriaLogEntry[],
  minSamples: number,
  operatingPoint: { readonly m?: number; readonly k?: number; readonly p0?: number } | undefined,
): {
  readonly outcome: CheckOutcome;
  readonly requiresHuman: boolean;
  readonly certificate: ClassCertificate | null;
} {
  if (holdout === null) {
    return { outcome: { scenarios: [], reasons: [] }, requiresHuman: false, certificate: null };
  }

  const samples = countDeltaSamples(holdout, live, log);
  const deltaCertifiable = samples >= minSamples;
  const counted = countClassAttempts(holdout, live, log);
  const certification: ClassCertification = certificationForClass({
    samples: counted.samples,
    passes: counted.passes,
    ...(operatingPoint?.m === undefined ? {} : { m: operatingPoint.m }),
    ...(operatingPoint?.k === undefined ? {} : { k: operatingPoint.k }),
    ...(operatingPoint?.p0 === undefined ? {} : { p0: operatingPoint.p0 }),
  });

  // Wording rule: the word "certified" appears only when the class certified. `insufficient` says
  // unknown and says so plainly — a class with three attempts is not "probably fine".
  const point =
    `m=${certification.m.toString()} k=${certification.k.toString()} ` +
    `alpha=${certification.alphaExact}`;
  const detail =
    certification.outcome === 'certified'
      ? `${counted.passes.toString()} of ${counted.samples.toString()} attempts passed for this ` +
        `task class: certified at ${point} (alpha is P(a class that truly passes ` +
        `${certification.p0.toString()} fails certification))`
      : certification.outcome === 'not-certified'
        ? `${counted.passes.toString()} of ${counted.samples.toString()} attempts passed for this ` +
          `task class: not certified at ${point}; promotion requires a human signature`
        : `${counted.samples.toString()} of ${certification.m.toString()} attempts for this task ` +
          `class: insufficient evidence to certify at ${point} — unknown is not "probably fine", ` +
          `so promotion requires a human signature`;

  // Two different facts, both kept: `minDeltaSamples` is Δ evidence, certification is the
  // binomial operating point. Either one unsatisfied means a person decides.
  const requiresHuman = !deltaCertifiable || certification.outcome !== 'certified';
  const deltaLine = deltaCertifiable
    ? `${samples.toString()} delta samples for this task class (min ${minSamples.toString()})`
    : `${samples.toString()} of ${minSamples.toString()} delta samples for this task class: promotion requires a human signature`;

  return {
    outcome: {
      scenarios: [result('class-certification', 'policy', 'pass', `${deltaLine}; ${detail}`)],
      reasons: [],
    },
    requiresHuman,
    certificate: {
      taskClass: holdout.taskClass,
      m: certification.m,
      k: certification.k,
      p0: certification.p0,
      alpha: certification.alpha,
      samples: certification.samples,
      passes: certification.passes,
      outcome: certification.outcome,
    },
  };
}

/**
 * Read the criteria log through its port.
 *
 * A port that throws is treated as a damaged log, not as an empty one: fewer usable
 * observations must degrade, and it must never look like a fresh, clean history.
 */
function readLogPort(port: CriteriaLogPort | undefined): {
  readonly entries: readonly CriteriaLogEntry[];
  readonly corruptLines: number;
} {
  if (port === undefined) return { entries: [], corruptLines: 0 };
  try {
    return port.read();
  } catch {
    return { entries: [], corruptLines: 1 };
  }
}

/** Append this run's observations, stamping them with the caller's clock. */
function recordObservations(input: EvaluateInput, observations: readonly CriteriaLogEntry[]): void {
  const port = input.criteriaLog;
  if (port === undefined || observations.length === 0) return;
  try {
    port.record(observations.map((entry) => ({ ...entry, at: input.nowIso })));
  } catch {
    // Intentionally swallowed: the verdict is already decided by measurement, and
    // failing it because a log file is read-only would turn an infrastructure
    // problem into a verdict about the candidate.
  }
}

/**
 * Decide whether an attempt is done.
 *
 * Order is the specification, and it matters: faithfulness first (is the receipt
 * even true?), then the unit's own criteria, then the generator-blind holdout and
 * its Δ, then the integrity checks that read the diff, then the blast-radius
 * checks. Every check contributes `ScenarioResult`s; the outcome is the weakest
 * outcome across them.
 */
export async function evaluate(input: EvaluateInput): Promise<Verdict> {
  // Configuration is validated before anything runs, so a bad repeat count fails
  // loudly instead of silently falling back to a single execution.
  const runs = runsPerScenario(input.policy);
  const maxNonDiscriminating = input.policy.maxNonDiscriminating ?? 0;

  const files = await inspectChangedFiles(input.diff);
  const log = readLogPort(input.criteriaLog);

  const faithfulness = await checkFaithfulness(input);
  const acceptance = await checkAcceptance(input, runs);
  const holdout = await assessHoldout(input, runs);
  const quality = assessHoldoutQuality(
    input.holdout,
    holdout.observations,
    log,
    maxNonDiscriminating,
    input.nowIso,
  );
  const wallSuite = await checkWallSuite(input, runs);
  const testSurface = checkTestSurface(files);
  const diffNonEmpty = checkDiffNonEmpty(files, input.receipt);
  const testsWeakened = await checkTestsWeakened(input, files);
  const scope = await checkScope(input, files);
  const irreversible = checkIrreversible(input);
  const certification = checkClassCertification(
    input.holdout,
    holdout.observations,
    log.entries,
    input.policy.minDeltaSamples ?? 0,
    input.policy.certification,
  );

  // History is written after the decision is computed, and a failed append does not
  // change this verdict: the live measurement decided it. A silently unwritable log
  // is therefore a thinning of history rather than a wrong answer — documented as a
  // limitation rather than hidden behind a swallow-and-continue.
  recordObservations(input, holdout.observations);

  const merged = mergeChecks(
    faithfulness,
    acceptance,
    wallSuite,
    holdout,
    quality,
    testSurface,
    diffNonEmpty,
    testsWeakened,
    scope,
    irreversible,
    certification.outcome,
  );

  const anyFail = merged.scenarios.some((scenario) => scenario.outcome === 'fail');
  const anyUnknown = merged.scenarios.some((scenario) => scenario.outcome === 'unknown');

  // Precedence, stated once: a failure is a failure even if other checks were
  // unmeasured; unmeasured checks block a pass; only a fully measured, fully
  // passing, reason-free set of checks may pass.
  let outcome: Verdict['outcome'];
  if (anyFail) {
    outcome = 'fail';
  } else if (anyUnknown || merged.scenarios.length === 0) {
    outcome = 'unknown';
  } else {
    outcome = 'pass';
  }

  // Belt and braces for the invariant: a pass with any reason attached is a bug,
  // and the wall would rather report `unknown` than a pass it cannot justify.
  //
  // This is also why `faithfulness_partial` is not attached to a passing verdict: the
  // contract's `assertVerdictIsEarned` refuses a pass that carries reasons, and that guard
  // is a never-regress control. A pass therefore states its scope in the `faithfulness:scope`
  // scenario's `observed` (which the operator reads) and carries no code; the code appears
  // only when nothing could be replayed, where the verdict is `unknown` and must say why.
  if (outcome === 'pass' && merged.reasons.length > 0) outcome = 'unknown';

  const baseVersion =
    input.policy.wallVersion.trim() === '' ? WALL_VERSION : input.policy.wallVersion;
  // A tag is a mutable pointer, so the image digest is part of the instrument's identity
  // (A4.4): a verdict must name the exact environment that produced it.
  const wallVersion =
    input.policy.imageDigest === undefined
      ? `${baseVersion}${runnerVersionSuffix(input)}`
      : `${baseVersion}+img:${input.policy.imageDigest}`;

  const candidate: Verdict = {
    unitId: input.receipt.unitId,
    attemptId: input.receipt.attemptId,
    receiptSha: contentHash(input.receipt),
    holdoutRevision: holdout.delta.holdoutRevision,
    policyVersion: derivePolicyVersion(input.policy),
    wallVersion,
    outcome,
    scenarios: [...merged.scenarios],
    delta: holdout.delta,
    reasons: [...merged.reasons],
    // Only ever set on a verdict that verifies: a failed or unmeasured unit has nothing to
    // promote, so the flag would be noise. `undefined` reads as false at every call site.
    ...(outcome === 'pass' && certification.requiresHuman
      ? { promotionRequiresHumanSignature: true }
      : {}),
    // The class judgement, as data. Absent — never `certified` — when there was no holdout to
    // judge the class against, so a reader cannot mistake a cold start for a certificate.
    ...(certification.certificate === null ? {} : { certification: certification.certificate }),
    ...(input.modelId === undefined ? {} : { modelId: input.modelId }),
    evaluatedAt: input.nowIso,
  };

  // The wall validates its own artefact before returning it: a verdict that does
  // not parse, or that claims more than it measured, must fail loudly here rather
  // than be persisted and believed. This is a self-check, not a sanitizer.
  const verdict = VerdictSchema.parse(candidate);
  assertVerdictIsEarned(verdict);
  return verdict;
}
