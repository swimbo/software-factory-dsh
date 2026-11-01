/**
 * The qualifier's behaviour, pinned case by case.
 *
 * Every case asserts three things beyond its headline: the decision parses as the
 * frozen `LaneDecision` contract, it satisfies `assertLaneIsDerived` at the shipped
 * `dark` threshold, and every reason code it emitted is a member of the closed set.
 * A qualifier bug that produced a plausible-looking lane would still fail those
 * three, which is the point of testing the derivation rather than an example.
 */
import { describe, expect, it } from 'vitest';
import {
  QUALIFIER_REASON_CODES,
  SIGNAL_NAMES,
  LaneDecision,
  assertLaneIsDerived,
  type AcceptanceCriterion,
  type LaneDecisionType,
  type Signal,
  type SignalName,
  type UnitSpec,
} from '@factory/contracts';
import { DEFAULT_POLICY, currentPolicyVersion, type QualifierPolicy } from './policy.ts';
import { deriveLane, qualify, scoreSignals, type QualifyInput } from './qualify.ts';
import type { TaskClassHistory } from './signals.ts';

/** Fixed timestamp: the package may not read a clock, and a test may not depend on one. */
const NOW = '2026-11-01T12:00:00.000Z';
/** The threshold the contract-aware assertion is run at; the shipped policy's value. */
const DARK_THRESHOLD = 90;

const STABLE_HISTORY: TaskClassHistory = { samples: 40, passRate: 0.98, escapeRate: 0.01 };

function criterion(id: string, text: string, target: string, expect: string): AcceptanceCriterion {
  return { id, text, oracle: { kind: 'command', target, expect } };
}

/**
 * A unit that passes all six signals: small, reversible code change, machine-checkable
 * criteria, a faithful restatement, a stable task class and an estimate inside the
 * envelope. Cases override exactly one field so the delta in the score is readable.
 */
function makeSpec(overrides: Partial<UnitSpec> = {}): UnitSpec {
  return {
    slug: 'add-pagination-parameter',
    revision: 1,
    repo: 'acme/widgets',
    baseRev: '0123456789abcdef0123456789abcdef01234567',
    intent: 'Add a pagination parameter to the items endpoint so callers can page through results.',
    restateBack:
      'Add a pagination parameter to the items endpoint so callers can page through the results list.',
    acceptance: [
      criterion(
        'items-page-two',
        'GET /items?page=2 returns 3 items and a next cursor',
        'pnpm vitest run items-page',
        'exit 0 and 3 items returned',
      ),
    ],
    touchPaths: ['src/api/items.ts', 'src/api/items.test.ts'],
    operationClasses: ['code-change', 'test-change'],
    sizeBudget: { files: 3, lines: 120 },
    budgetEstimateUsd: 1.5,
    ...overrides,
  };
}

function makeInput(overrides: Partial<QualifyInput> = {}): QualifyInput {
  return {
    unitId: 'unit-0001',
    spec: makeSpec(),
    taskClassHistory: STABLE_HISTORY,
    envelopeUsd: 2,
    nowIso: NOW,
    ...overrides,
  };
}

function signalOf(decision: LaneDecisionType, name: SignalName) {
  const found = decision.signals.find((candidate) => candidate.name === name);
  if (found === undefined) throw new Error(`decision carries no ${name} signal`);
  return found;
}

/** The three assertions every decision must satisfy, whatever its lane. */
function expectWellFormed(decision: LaneDecisionType): void {
  expect(() => LaneDecision.parse(decision)).not.toThrow();
  expect(decision.signals).toHaveLength(SIGNAL_NAMES.length);
  expect(decision.signals.map((item) => item.name)).toEqual([...SIGNAL_NAMES]);
  expect(decision.mandateId).toBeNull();
  expect(decision.decidedAt).toBe(NOW);
  expect(() => assertLaneIsDerived(decision, DARK_THRESHOLD)).not.toThrow();
  for (const item of decision.signals) {
    expect(QUALIFIER_REASON_CODES).toContain(item.reason);
    expect(item.weight).toBe(DEFAULT_POLICY.weights[item.name]);
  }
}

describe('qualify — the happy path', () => {
  it('routes an all-pass unit to dark with a full score and no mandate of its own', () => {
    const decision = qualify(makeInput());

    expectWellFormed(decision);
    expect(decision.lane).toBe('dark');
    expect(decision.score).toBe(100);
    expect(decision.mandateId).toBeNull();
    // The engine mints the mandate; a decision that minted its own would authorise itself.
    expect(decision.policyVersion).toBe(currentPolicyVersion());
    expect(decision.policyVersion).toMatch(/^sha256:[0-9a-f]{64}$/);
    for (const item of decision.signals) {
      expect(item.outcome).toBe('pass');
      expect(item.observed).not.toBeNull();
    }
  });

  it('records the observed measurement on each signal, not just the verdict', () => {
    const decision = qualify(makeInput());
    expect(signalOf(decision, 'size').observed).toContain('lines=120/400');
    expect(signalOf(decision, 'budget').observed).toContain('estimateUsd=1.50');
    expect(signalOf(decision, 'task_class_history').observed).toContain('passRate=0.980');
    expect(signalOf(decision, 'intent_derivability').observed).toContain('restateOverlap=');
  });
});

describe('qualify — reject is for rewrites, lit is for parking', () => {
  it('rejects a criterion whose oracle is empty, with SPEC_NOT_MACHINE_CHECKABLE', () => {
    const spec = makeSpec({
      acceptance: [criterion('items-page-two', 'pagination is implemented', '', '')],
    });
    const decision = qualify(makeInput({ spec }));

    expectWellFormed(decision);
    expect(decision.lane).toBe('reject');
    const intent = signalOf(decision, 'intent_derivability');
    expect(intent.outcome).toBe('fail');
    expect(intent.reason).toBe('SPEC_NOT_MACHINE_CHECKABLE');
    // A reject is a rewrite request, so it must never look like a near-miss: the
    // score stays below the dark threshold, which is what `assertLaneIsDerived` checks.
    expect(decision.score).toBeLessThan(DARK_THRESHOLD);
  });

  it('rejects a criterion whose text is prose the oracle does not measure', () => {
    const spec = makeSpec({
      acceptance: [
        criterion('items-page-two', 'the feature is nice', 'pnpm vitest run items', 'exit 0'),
      ],
    });
    const decision = qualify(makeInput({ spec }));

    expectWellFormed(decision);
    expect(decision.lane).toBe('reject');
    expect(signalOf(decision, 'intent_derivability').reason).toBe('SPEC_NOT_MACHINE_CHECKABLE');
  });

  it('accepts a criterion whose text names the thing its oracle checks', () => {
    const spec = makeSpec({
      acceptance: [
        criterion(
          'items-page-two',
          'items page 2 returns a next cursor',
          'pnpm vitest run items',
          'exit 0',
        ),
      ],
    });
    const decision = qualify(makeInput({ spec }));

    expectWellFormed(decision);
    expect(signalOf(decision, 'intent_derivability').outcome).toBe('pass');
  });

  it('rejects a restatement of a different task with RESTATE_BACK_MISMATCH', () => {
    const spec = makeSpec({
      restateBack: 'Delete the database and drop every table in the production cluster today.',
    });
    const decision = qualify(makeInput({ spec }));

    expectWellFormed(decision);
    expect(decision.lane).toBe('reject');
    const intent = signalOf(decision, 'intent_derivability');
    expect(intent.outcome).toBe('fail');
    expect(intent.reason).toBe('RESTATE_BACK_MISMATCH');
    expect(intent.observed).toContain('restateOverlap=0.000');
  });

  it('rejects a restatement that is too short to judge, with RESTATE_BACK_MISSING', () => {
    const spec = makeSpec({ restateBack: 'add paging' });
    const decision = qualify(makeInput({ spec }));

    expectWellFormed(decision);
    expect(decision.lane).toBe('reject');
    expect(signalOf(decision, 'intent_derivability').reason).toBe('RESTATE_BACK_MISSING');
  });

  it('rejects when a criterion has no oracle even though the intent is derivable', () => {
    // Intent derivability fails on the empty target, so this is a reject rather than a
    // park: a unit whose outcome cannot be observed is rewritten, not queued.
    const spec = makeSpec({
      acceptance: [
        criterion(
          'items-page-two',
          'GET /items?page=2 returns 3 items',
          'pnpm vitest run items',
          'exit 0',
        ),
        criterion('items-cursor', 'the cursor advances', '', 'no cursor returned twice'),
      ],
    });
    const decision = qualify(makeInput({ spec }));

    expectWellFormed(decision);
    expect(decision.lane).toBe('reject');
    expect(signalOf(decision, 'observability').reason).toBe('ORACLE_MISSING');
  });

  it('parks an irreversible operation as lit when the intent is derivable', () => {
    const spec = makeSpec({ operationClasses: ['code-change', 'schema-migration'] });
    const decision = qualify(makeInput({ spec }));

    expectWellFormed(decision);
    expect(decision.lane).toBe('lit');
    const reversibility = signalOf(decision, 'reversibility');
    expect(reversibility.outcome).toBe('fail');
    expect(reversibility.reason).toBe('IRREVERSIBLE_OPERATION');
    expect(reversibility.observed).toContain('schema-migration');
    expect(decision.score).toBe(80);
  });

  it.each([
    { label: 'an empty path list', touchPaths: [] as string[] },
    { label: 'a recursive glob', touchPaths: ['src/api/**'] },
    { label: 'a filesystem-rooted path', touchPaths: ['/etc/passwd'] },
  ])('parks unbounded scope as lit for $label', ({ touchPaths }) => {
    const decision = qualify(makeInput({ spec: makeSpec({ touchPaths }) }));

    expectWellFormed(decision);
    expect(decision.lane).toBe('lit');
    expect(signalOf(decision, 'reversibility').reason).toBe('TOUCH_PATHS_UNSCOPED');
  });

  it('parks an unstable task class as lit', () => {
    const decision = qualify(
      makeInput({ taskClassHistory: { samples: 50, passRate: 0.8, escapeRate: 0.1 } }),
    );

    expectWellFormed(decision);
    expect(decision.lane).toBe('lit');
    expect(signalOf(decision, 'task_class_history').reason).toBe('TASK_CLASS_UNSTABLE');
  });

  it('parks a unit over its envelope as lit', () => {
    const decision = qualify(makeInput({ envelopeUsd: 1 }));

    expectWellFormed(decision);
    expect(decision.lane).toBe('lit');
    expect(signalOf(decision, 'budget').reason).toBe('BUDGET_EXCEEDS_ENVELOPE');
  });

  it('parks an over-size unit as lit — size demotes, it never rejects', () => {
    const decision = qualify(
      makeInput({ spec: makeSpec({ sizeBudget: { files: 40, lines: 900 } }) }),
    );

    expectWellFormed(decision);
    expect(decision.lane).toBe('lit');
    expect(signalOf(decision, 'size').outcome).toBe('fail');
    expect(signalOf(decision, 'size').reason).toBe('SIZE_OVER_BUDGET');
    // Ten points of weight lost lands exactly on the threshold: still not dark,
    // because `dark` requires six passes as well as the score.
    expect(decision.score).toBe(90);
  });
});

describe('qualify — unknown never looks like a pass', () => {
  it.each([
    { label: 'no history at all', taskClassHistory: null },
    { label: 'too few samples', taskClassHistory: { samples: 3, passRate: 1, escapeRate: 0 } },
    { label: 'zero samples', taskClassHistory: { samples: 0, passRate: 1, escapeRate: 0 } },
  ])('parks $label as lit with TASK_CLASS_UNKNOWN, never dark', ({ taskClassHistory }) => {
    const decision = qualify(makeInput({ taskClassHistory }));

    expectWellFormed(decision);
    expect(decision.lane).toBe('lit');
    expect(decision.lane).not.toBe('dark');
    const history = signalOf(decision, 'task_class_history');
    expect(history.outcome).toBe('unknown');
    expect(history.reason).toBe('TASK_CLASS_UNKNOWN');
  });

  it('parks a missing budget estimate as lit, even though the score clears the threshold', () => {
    const decision = qualify(makeInput({ spec: makeSpec({ budgetEstimateUsd: null }) }));

    expectWellFormed(decision);
    expect(decision.lane).toBe('lit');
    expect(signalOf(decision, 'budget').outcome).toBe('unknown');
    expect(signalOf(decision, 'budget').reason).toBe('BUDGET_UNKNOWN');
    // Half of ten is five: the score is 95 and the lane is still lit. This is the case
    // that proves the `dark` lock is "all signals pass", not "score above threshold".
    expect(decision.score).toBe(95);
    expect(decision.score).toBeGreaterThanOrEqual(DARK_THRESHOLD);
  });

  it('gives unknown exactly half the weight, and fail nothing', () => {
    const passOnly = qualify(makeInput()).signals;
    const withUnknown = qualify(makeInput({ spec: makeSpec({ budgetEstimateUsd: null }) })).signals;
    const withFail = qualify(
      makeInput({ spec: makeSpec({ sizeBudget: { files: 40, lines: 900 } }) }),
    ).signals;

    expect(scoreSignals(passOnly)).toBe(100);
    expect(scoreSignals(withUnknown)).toBe(95);
    expect(scoreSignals(withFail)).toBe(90);
  });
});

describe('qualify — determinism', () => {
  it('produces a deep-equal decision for the same input twice', () => {
    const first = qualify(makeInput());
    const second = qualify(makeInput());
    expect(second).toEqual(first);
    // Byte-identical through a serialisation round trip: the decision is data, not an object graph.
    expect(LaneDecision.parse(JSON.parse(JSON.stringify(first)))).toEqual(first);
  });

  it('keeps the policy version stable, and changes it when a rule changes', () => {
    expect(currentPolicyVersion()).toBe(currentPolicyVersion(DEFAULT_POLICY));
    expect(currentPolicyVersion()).toMatch(/^sha256:/);

    const tightened: QualifierPolicy = { ...DEFAULT_POLICY, darkThreshold: 95 };
    expect(currentPolicyVersion(tightened)).not.toBe(currentPolicyVersion());

    // A weight change is a rule change even when it keeps the sum at 100.
    const reweighted: QualifierPolicy = {
      ...DEFAULT_POLICY,
      weights: { ...DEFAULT_POLICY.weights, size: 11, budget: 9 },
    };
    expect(currentPolicyVersion(reweighted)).not.toBe(currentPolicyVersion());
  });

  it('re-scores the same unit differently under a different policy', () => {
    // Intent tokens are five; the restatement covers four of them (overlap 0.8).
    const spec = makeSpec({
      intent: 'Add a pagination parameter to the items endpoint',
      restateBack:
        'Add a pagination parameter to the results endpoint and keep the existing tests passing',
    });

    const underDefault = qualify(makeInput({ spec }));
    expectWellFormed(underDefault);
    expect(underDefault.lane).toBe('dark');

    const strict: QualifierPolicy = { ...DEFAULT_POLICY, restateOverlapMin: 0.85 };
    const underStrict = qualify(makeInput({ spec }), strict);
    expect(() => LaneDecision.parse(underStrict)).not.toThrow();
    expect(underStrict.lane).toBe('reject');
    expect(signalOf(underStrict, 'intent_derivability').reason).toBe('RESTATE_BACK_MISMATCH');
    expect(underStrict.policyVersion).not.toBe(underDefault.policyVersion);
  });

  it('refuses a malformed timestamp instead of recording one', () => {
    expect(() => qualify(makeInput({ nowIso: 'yesterday' }))).toThrow();
  });

  it('refuses a policy whose weights do not sum to 100', () => {
    const broken: QualifierPolicy = {
      ...DEFAULT_POLICY,
      weights: { ...DEFAULT_POLICY.weights, size: 20 },
    };
    expect(() => qualify(makeInput(), broken)).toThrow(/sum to 100/);
  });
});

describe('qualify — lane derivation is total and legal', () => {
  /**
   * Every combination of pass/fail/unknown across the six signals: 3^6 = 729.
   * The lane function must be total (it returns exactly one lane for every input),
   * legal (the contract's own `assertLaneIsDerived` accepts it) and honest (a reject
   * is never a near-miss, a dark is never a partial pass).
   */
  const OUTCOMES = ['pass', 'fail', 'unknown'] as const;
  const COMBINATIONS = 3 ** SIGNAL_NAMES.length;

  function syntheticSignals(combo: readonly number[]): Signal[] {
    return SIGNAL_NAMES.map((name, index) => {
      const outcome = OUTCOMES[combo[index] ?? 0] ?? 'pass';
      const reason =
        outcome === 'pass'
          ? 'INTENT_DERIVABLE'
          : outcome === 'unknown'
            ? 'BUDGET_UNKNOWN'
            : 'SIZE_OVER_BUDGET';
      return { name, outcome, reason, observed: null, weight: DEFAULT_POLICY.weights[name] };
    });
  }

  function comboOf(index: number): readonly number[] {
    return SIGNAL_NAMES.map((_, place) => Math.floor(index / 3 ** place) % 3);
  }

  it(`covers all ${String(COMBINATIONS)} combinations`, () => {
    expect(COMBINATIONS).toBe(729);
  });

  it('derives a legal lane for every combination of the six signals', () => {
    let dark = 0;
    let lit = 0;
    let rejected = 0;

    for (let index = 0; index < COMBINATIONS; index += 1) {
      const signals = syntheticSignals(comboOf(index));
      const score = scoreSignals(signals);
      const lane = deriveLane(signals, score, DEFAULT_POLICY);

      const outcomeOfSignal = (name: SignalName): string =>
        signals.find((item) => item.name === name)?.outcome ?? 'missing';
      const allPass = signals.every((item) => item.outcome === 'pass');
      const rejecting =
        outcomeOfSignal('intent_derivability') === 'fail' ||
        outcomeOfSignal('observability') === 'fail';

      if (rejecting) {
        expect(lane).toBe('reject');
        // The reject invariant, for every combination rather than the sampled cases:
        // a rewrite request must never score like a near-dark unit.
        expect(score).toBeLessThan(DEFAULT_POLICY.darkThreshold);
      } else if (allPass) {
        expect(lane).toBe(score >= DEFAULT_POLICY.darkThreshold ? 'dark' : 'lit');
      } else {
        expect(lane).toBe('lit');
      }

      const decision = {
        unitId: `unit-${String(index)}`,
        lane,
        score,
        signals,
        policyVersion: currentPolicyVersion(),
        decidedAt: NOW,
        mandateId: null,
      };
      expect(() => LaneDecision.parse(decision)).not.toThrow();
      expect(() => assertLaneIsDerived(decision, DARK_THRESHOLD)).not.toThrow();

      if (lane === 'dark') dark += 1;
      else if (lane === 'reject') rejected += 1;
      else lit += 1;
    }

    // Only the all-pass combination can be dark, and it is: the score ceiling is 100.
    expect(dark).toBe(1);
    expect(lit + rejected + dark).toBe(COMBINATIONS);
  });
});

describe('qualify — lane derivation invariants', () => {
  const cases: ReadonlyArray<{ label: string; input: QualifyInput }> = [
    { label: 'all pass', input: makeInput() },
    {
      label: 'irreversible',
      input: makeInput({ spec: makeSpec({ operationClasses: ['data-delete'] }) }),
    },
    { label: 'unscoped', input: makeInput({ spec: makeSpec({ touchPaths: ['**'] }) }) },
    { label: 'no history', input: makeInput({ taskClassHistory: null }) },
    { label: 'no estimate', input: makeInput({ spec: makeSpec({ budgetEstimateUsd: null }) }) },
    {
      label: 'over size',
      input: makeInput({ spec: makeSpec({ sizeBudget: { files: 99, lines: 9999 } }) }),
    },
    {
      label: 'unstable class',
      input: makeInput({ taskClassHistory: { samples: 99, passRate: 0.5, escapeRate: 0.5 } }),
    },
    {
      label: 'uncheckable',
      input: makeInput({
        spec: makeSpec({ acceptance: [criterion('x-id', 'improve things', '', '')] }),
      }),
    },
  ];

  it.each(cases)('keeps every decision legal for $label', ({ input }) => {
    const decision = qualify(input);
    expectWellFormed(decision);
    expect(['dark', 'lit', 'reject']).toContain(decision.lane);

    if (decision.lane === 'dark') {
      expect(decision.signals.every((item) => item.outcome === 'pass')).toBe(true);
      expect(decision.score).toBeGreaterThanOrEqual(DEFAULT_POLICY.darkThreshold);
    }
    if (decision.lane === 'reject') {
      const rejecting = decision.signals.some(
        (item) =>
          (item.name === 'intent_derivability' || item.name === 'observability') &&
          item.outcome === 'fail',
      );
      expect(rejecting).toBe(true);
      expect(decision.score).toBeLessThan(DEFAULT_POLICY.darkThreshold);
    }
    if (decision.lane === 'lit') {
      const notAllPass = decision.signals.some((item) => item.outcome !== 'pass');
      const belowThreshold = decision.score < DEFAULT_POLICY.darkThreshold;
      expect(notAllPass || belowThreshold).toBe(true);
    }
  });

  it.each(cases)('emits only closed-set reason codes and weights for $label', ({ input }) => {
    const decision = qualify(input);
    for (const item of decision.signals) {
      expect(QUALIFIER_REASON_CODES).toContain(item.reason);
      expect(item.weight).toBeGreaterThanOrEqual(0);
      expect(item.weight).toBeLessThanOrEqual(100);
      if (item.outcome === 'pass') expect(item.reason).toMatch(/^[A-Z_]+$/);
    }
  });
});
