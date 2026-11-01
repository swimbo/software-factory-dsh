/**
 * The qualifier's numbers, in one frozen object.
 *
 * The policy is data, not code. `qualify` reads every threshold and weight from
 * here, so a rule change is a value change — and `currentPolicyVersion` turns
 * that value into an identity that the decision carries. Two decisions quoting
 * the same version were scored by the same rules; that is the whole contract the
 * ledger leans on (`data-map.md` §2.5 `LaneDecision.policy_version`, §2.6
 * `PolicyVersion`). A rule edit therefore cannot silently reuse a stale score:
 * the new version makes `(unit_id, policy_version)` a new row.
 *
 * There is no second tuning surface: no environment variable, no feature flag,
 * no default buried in a caller. Same policy object in, same bytes out.
 *
 * ## Why `unknown` is worth half
 *
 * A signal that could not be measured is scored at half its weight rather than
 * zero. Zero would make "we have no history for this task class" arithmetically
 * indistinguishable from "this task class is known to be unstable", and the lane
 * derivation would then be justified by a number that pretends to know something
 * it does not. Half says the honest thing: the signal is unmeasured, so the unit
 * is *demoted* to `lit` (it can never reach `dark`, see `qualify.ts`), and the
 * score gap is what tells the operator that measuring it is how the unit earns
 * its way back.
 */
import { SIGNAL_NAMES, contentHash, type SignalName } from '@factory/contracts';

/** One weight per signal. Weights are 0–100 and must sum to 100. */
export type SignalWeights = Readonly<Record<SignalName, number>>;

/** Every number the qualifier consults. Frozen: a policy is a value, never a mutable global. */
export interface QualifierPolicy {
  /** Minimum score for `dark`. Only reachable when all six signals pass, so this is a second lock, not the first. */
  readonly darkThreshold: number;
  /** Below this many observations a task class is unmeasured, not trustworthy. */
  readonly minSamples: number;
  /** Pass rate a class must reach to be called stable. */
  readonly minPassRate: number;
  /** Escape rate above which a class is unstable even when its pass rate looks good. */
  readonly maxEscapeRate: number;
  /** Diff size ceiling for one unit. */
  readonly maxLines: number;
  /** File-count ceiling for one unit. */
  readonly maxFiles: number;
  /** Token-overlap floor between `intent` and `restateBack` (see `signals.ts` for the metric). */
  readonly restateOverlapMin: number;
  readonly weights: SignalWeights;
  /**
   * Cold start: whether an absent task-class history still permits `dark`.
   *
   * A brand-new factory has no history for any class, so with this `false` — the
   * shipped default — the `task_class_history` signal can only ever be `unknown`,
   * `deriveLane` requires every signal to pass, and **nothing routes dark**. That
   * deadlock is deliberate: routing dark on evidence that does not exist is the
   * exact laundering L1 forbids. It is resolved by a *human policy decision*, not by
   * a code default: an operator who wants a cold factory to start on the visible
   * suite plus the wall sets this `true`, which changes `currentPolicyVersion`, so
   * every decision made under it is distinguishable from one made with history.
   *
   * When `true` the signal reports `pass` with `TASK_CLASS_COLD_START` so a reader
   * can see the unit was waved through on policy rather than on measurement — and
   * it stops applying the moment a class has samples.
   */
  readonly allowColdStart: boolean;
}

/**
 * The shipped policy. Deliberately boring and deliberately public: an operator
 * can read a `dark` decision and re-derive the same number by hand.
 *
 * Weights sum to 100 with intent/observability carrying half of it, because those
 * are the two signals a rewrite can fix and the two whose failure rejects rather
 * than parks.
 */
export const DEFAULT_POLICY: QualifierPolicy = Object.freeze({
  allowColdStart: false,
  darkThreshold: 90,
  minSamples: 10,
  minPassRate: 0.95,
  maxEscapeRate: 0.02,
  maxLines: 400,
  maxFiles: 25,
  restateOverlapMin: 0.5,
  weights: Object.freeze({
    intent_derivability: 30,
    reversibility: 20,
    observability: 20,
    task_class_history: 10,
    size: 10,
    budget: 10,
  }),
});

/** Tolerance for the weight sum, so a policy assembled from decimals is not rejected on the last bit. */
const SUM_TOLERANCE = 1e-9;

function fail(message: string): never {
  throw new TypeError(`qualifier policy: ${message}`);
}

function requireUnitInterval(name: string, value: number): void {
  if (!Number.isFinite(value) || value < 0 || value > 1) {
    fail(`${name} must be a number in [0,1], got ${String(value)}`);
  }
}

function requireCount(name: string, value: number, minimum: number): void {
  if (!Number.isInteger(value) || value < minimum) {
    fail(`${name} must be an integer >= ${minimum}, got ${String(value)}`);
  }
}

/**
 * Reject a policy that could not produce a comparable score.
 *
 * This runs on every `qualify` call. It is cheap, and it is the difference
 * between "the weights changed" and "the weights silently stopped summing to
 * 100 and every score drifted". A caller that wants to try a policy learns about
 * the mistake at the call, not in a decision six months from now.
 */
export function assertPolicy(policy: QualifierPolicy): void {
  const { weights } = policy;
  if (weights === null || typeof weights !== 'object') fail('weights must be an object');

  const declared = new Set<string>(SIGNAL_NAMES);
  for (const key of Object.keys(weights)) {
    if (!declared.has(key)) {
      fail(
        `weights has an unknown signal ${JSON.stringify(key)}; known: ${SIGNAL_NAMES.join(', ')}`,
      );
    }
  }

  let sum = 0;
  for (const name of SIGNAL_NAMES) {
    const weight = weights[name];
    if (!Number.isFinite(weight) || weight < 0 || weight > 100) {
      fail(`weight ${name} must be a number in [0,100], got ${String(weight)}`);
    }
    sum += weight;
  }
  if (Math.abs(sum - 100) > SUM_TOLERANCE) {
    fail(
      `weights must sum to 100, got ${String(sum)} (a score must stay comparable across policies)`,
    );
  }

  if (
    !Number.isFinite(policy.darkThreshold) ||
    policy.darkThreshold < 0 ||
    policy.darkThreshold > 100
  ) {
    fail(`darkThreshold must be a number in [0,100], got ${String(policy.darkThreshold)}`);
  }
  requireCount('minSamples', policy.minSamples, 0);
  requireUnitInterval('minPassRate', policy.minPassRate);
  requireUnitInterval('maxEscapeRate', policy.maxEscapeRate);
  requireUnitInterval('restateOverlapMin', policy.restateOverlapMin);
  requireCount('maxLines', policy.maxLines, 1);
  requireCount('maxFiles', policy.maxFiles, 1);
}

/**
 * The identity of a rule set: `sha256:` over the policy's canonical JSON.
 *
 * `canonicalJson` sorts keys and refuses values it cannot hash, so the digest is
 * a function of the policy's content alone — not of key insertion order, not of
 * which file it was written in. Passing a different policy yields a different
 * version, which is exactly what makes a decision re-score instead of being
 * reused.
 *
 * @param policy - the rule set to identify; defaults to {@link DEFAULT_POLICY}.
 * @returns `sha256:<64 hex chars>`.
 */
export function currentPolicyVersion(policy: QualifierPolicy = DEFAULT_POLICY): string {
  assertPolicy(policy);
  return contentHash(policy);
}
