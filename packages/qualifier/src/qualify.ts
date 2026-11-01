/**
 * The qualifier: six signals in, one lane out.
 *
 * The lane is *derived*, never assigned (`@factory/contracts` `assertLaneIsDerived`,
 * and the deterministic-controls rule L2). That has a concrete consequence for how
 * this file is written: there is no branch that says `lane = 'dark'` because some
 * other condition looked good. The only path to `dark` is "all six signals passed
 * and the weighted score cleared the threshold", so anyone holding a decision can
 * check it with the signals in front of them and no access to this code.
 *
 * Nothing here reads a clock (the caller supplies `nowIso`), picks a random number,
 * opens a socket or calls a model. The same `QualifyInput` and policy produce the
 * same bytes on any host, today and in five years — which is what makes
 * `(unit_id, policy_version)` a legitimate idempotency key.
 */
import {
  LaneDecision,
  type Lane,
  type Signal,
  type SignalName,
  type UnitSpec,
} from '@factory/contracts';
import {
  DEFAULT_POLICY,
  assertPolicy,
  currentPolicyVersion,
  type QualifierPolicy,
} from './policy.ts';
import { evaluateSignals, type TaskClassHistory } from './signals.ts';
import { classifySecurityRelevance } from './security.ts';

export interface QualifyInput {
  readonly unitId: string;
  readonly spec: UnitSpec;
  /** History for this task class, from the store. `null` = never seen. */
  readonly taskClassHistory: TaskClassHistory | null;
  readonly envelopeUsd: number;
  /** The decision timestamp, injected by the caller. Time enters this package only here. */
  readonly nowIso: string;
}

/**
 * What one outcome is worth against a signal's weight.
 *
 * `unknown` earns half rather than zero, and that is a design decision rather than
 * a rounding one. Zero would make an unmeasured signal arithmetically identical to
 * a measured failure, so a unit parked because "nobody has ever run this task class
 * before" would show the same score as one parked because "this task class has
 * escaped twice", and the only thing distinguishing them would be prose. Half keeps
 * the distinction visible in the number the operator reads, and the lane rule below
 * still refuses `dark` for any `unknown` — so the half weight buys legibility, not
 * permission.
 */
const OUTCOME_FACTOR: Readonly<Record<'pass' | 'fail' | 'unknown', number>> = Object.freeze({
  pass: 1,
  unknown: 0.5,
  fail: 0,
});

/**
 * The signals whose failure rejects the unit instead of parking it.
 *
 * A unit whose intent cannot be checked, or whose outcome cannot be observed, is
 * not a unit that may wait: there is nothing for a human to approve — there is
 * something for the author to rewrite. Parking it would put an unverifiable unit in
 * a queue that promises "a human will look at this and it can then run", which is a
 * false promise, and it would let the unit reach dispatch through a mandate
 * widening. Both signals are therefore terminal for the submission.
 *
 * The weights make the reject invariant checkable rather than hoped for: each of
 * these carries more than `100 - darkThreshold` (30 and 20 against 10), so a
 * rejected unit's score is always below the `dark` threshold — `assertLaneIsDerived`
 * can never find a high-scoring reject.
 */
const REJECTING_SIGNALS: readonly SignalName[] = Object.freeze([
  'intent_derivability',
  'observability',
]);

function outcomeOf(signals: readonly Signal[], name: SignalName): 'pass' | 'fail' | 'unknown' {
  const found = signals.find((candidate) => candidate.name === name);
  if (found === undefined) {
    // Fail closed: a missing signal is not "not rejected".
    throw new Error(`qualifier: signal ${name} is missing from the evaluated set`);
  }
  return found.outcome;
}

/**
 * The weighted score: `pass` = full weight, `unknown` = half, `fail` = 0, rounded to
 * two decimals.
 *
 * The summation order is the `SIGNAL_NAMES` order of `evaluateSignals`, so the
 * floating-point result is a function of the input alone — reordering the array
 * could change the last bit, and the last bit is inside a hash.
 */
export function scoreSignals(signals: readonly Signal[]): number {
  let total = 0;
  for (const item of signals) {
    total += item.weight * OUTCOME_FACTOR[item.outcome];
  }
  const rounded = Math.round(total * 100) / 100;
  if (!Number.isFinite(rounded)) {
    throw new Error(
      `qualifier: non-finite score ${String(rounded)}; the policy weights are unusable`,
    );
  }
  // The contract caps the score at 100; a policy whose weights sum to 100 within
  // tolerance can land a hair above it, and a rounding artifact must not become a
  // schema failure.
  return Math.min(100, Math.max(0, rounded));
}

/**
 * Derive the lane from the signals and the score.
 *
 * The three rules, in order:
 * 1. `reject` — intent derivability or observability failed (rewrite, do not park).
 * 2. `dark` — every one of the six signals passed *and* the score cleared the
 *    threshold. Both halves are required: the score alone would let five passes and
 *    one half-weight `unknown` reach 95.
 * 3. `lit` — everything else, parked for a human with no mandate.
 */
export function deriveLane(
  signals: readonly Signal[],
  score: number,
  policy: QualifierPolicy,
): Lane {
  for (const name of REJECTING_SIGNALS) {
    if (outcomeOf(signals, name) === 'fail') return 'reject';
  }
  const everySignalPassed = signals.every((item) => item.outcome === 'pass');
  if (everySignalPassed && score >= policy.darkThreshold) return 'dark';
  return 'lit';
}

/**
 * Score one unit and return its lane decision.
 *
 * Pure: no I/O, no clock, no randomness, no model. The returned value is validated
 * against the frozen `LaneDecision` contract before it leaves this function, so a
 * malformed `nowIso` or a score outside `[0,100]` is refused here rather than
 * discovered by the store.
 *
 * `mandateId` is always `null`: the engine mints the mandate from the decision
 * (`architecture.md` §4 `qualifyUnit`), and a decision that minted its own mandate
 * would be authorising itself.
 *
 * @param input - the unit, its task-class history, the envelope and the timestamp.
 * @param policy - the rule set; defaults to {@link DEFAULT_POLICY}.
 * @returns the lane decision, parseable by `LaneDecision`.
 */
export function qualify(
  input: QualifyInput,
  policy: QualifierPolicy = DEFAULT_POLICY,
): LaneDecision {
  assertPolicy(policy);

  const signals = evaluateSignals(input, policy);
  const score = scoreSignals(signals);
  // The security lock (Phase 5 amendment A5) is applied *after* the score and can
  // only ever demote: a security-relevant change never goes dark, even when every
  // signal passed. It is a lock rather than a seventh weighted signal because a
  // weight can be outvoted by six passing ones, and this rule must not be.
  const security = classifySecurityRelevance({
    touchPaths: input.spec.touchPaths,
    operationClasses: input.spec.operationClasses,
  });
  const derived = deriveLane(signals, score, policy);
  const lane = security.relevant && derived === 'dark' ? 'lit' : derived;

  return LaneDecision.parse({
    unitId: input.unitId,
    lane,
    score,
    signals: [...signals],
    policyVersion: currentPolicyVersion(policy),
    decidedAt: input.nowIso,
    mandateId: null,
  });
}
