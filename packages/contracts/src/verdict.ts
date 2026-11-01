/**
 * The wall's output: a verdict.
 *
 * A verdict is the factory's own signed statement about an attempt. It carries
 * the *inputs* that produced it (receipt hash, holdout revision, policy version,
 * wall version) so that "why did this pass?" is answerable months later — and so
 * a verdict can be declared stale rather than silently reused.
 */
import { z } from 'zod';

/** The wall's reason codes. Deliberately coarse: an agent must not learn which check it failed. */
export const WALL_REASON_CODES = [
  'suite_failed',
  'suite_unknown',
  'acceptance_unmet',
  'acceptance_unmeasured',
  'receipt_unfaithful',
  /**
   * Faithfulness was measured over a **subset** of the recorded commands: some could not be
   * replayed (the worker launch, the factory's own `git diff` reads) and are reported as
   * `not-replayed` with their reason. Advisory, not disqualifying: a pass still requires at
   * least one replayed command and zero mismatches, so this code means "the reproduced
   * subset reproduced" and never "everything was reproduced". It is deliberately the only
   * code allowed to accompany a `pass` (see `ADVISORY_REASON_CODES` in the wall) — a
   * disqualifying code always accompanies a failing check, and a failing check cannot pass.
   */
  'faithfulness_partial',
  'receipt_unavailable',
  /**
   * A recorded command needed a person's decision and had none. The factory will not
   * re-run what it cannot broker, so the verdict stays `unknown` -- and the operator
   * is told which command and which rule, instead of being handed the generic
   * "could not be re-executed" that hides a gate refusal behind a transport failure.
   */
  'privileged_unbrokered',
  'delta_regression',
  'delta_unmeasured',
  'holdout_failed',
  'holdout_unavailable',
  /**
   * The holdout ran and could not tell the change from the base: every scenario
   * passed on every base run, so Δ = 0 and the gate would be satisfied by a wall
   * that approves anything. Distinct from `delta_unmeasured` (which means "could
   * not compare"): here we compared, and the instrument is blunt.
   */
  'holdout_not_discriminating',
  'tests_weakened',
  /**
   * The change touched the *surface* that decides whether it works: the test root,
   * a dependency manifest, a lockfile, a test-runner config, a CI script or
   * `.git/hooks`. Path analysis, distinct from `tests_weakened` (content analysis):
   * this fires even when no test file was edited, because moving `package.json` can
   * change which tests run at all.
   */
  'test_surface_changed',
  /** The diff was empty. An attempt that changed nothing cannot have fixed anything. */
  'no_change',
  /**
   * The verdict was supplied by a fake wall (`FACTORY_WALL=fake`) rather than
   * measured. It exists so a plumbing test can drive the real verdict handling
   * without pretending a scenario ran: any verdict carrying this code must be
   * treated as unmeasured, and a `pass` carrying it must never reach promotion
   * without a human signature.
   */
  'fake_verdict_not_measured',
  /**
   * The change used an operation class that is security-relevant in itself —
   * credential use, network egress, schema migration, data deletion, force-push —
   * even when the change is reversible and every scenario passes. Distinct from
   * `irreversible_operation`, which is about reversibility; a `network-egress`
   * change is perfectly reversible and still needs a person, because it can move
   * data out.
   */
  'sensitive_operation',
  'scope_violation',
  'irreversible_operation',
  'budget_exceeded',
] as const;
export type WallReasonCode = (typeof WALL_REASON_CODES)[number];

export const ScenarioResult = z.object({
  /** Which acceptance criterion or holdout scenario this covers. */
  id: z.string().min(1),
  source: z.enum(['acceptance', 'holdout', 'delta', 'suite', 'faithfulness', 'policy']),
  outcome: z.enum(['pass', 'fail', 'unknown']),
  /** Measured value, for the operator. Never shown to the worker. */
  observed: z.string().max(2000).nullable(),
});
export type ScenarioResult = z.infer<typeof ScenarioResult>;

/**
 * Δ (delta): the holdout pass rate must not regress against the base revision.
 * `checked: false` means the wall could not measure it — which is `unknown`, and
 * `unknown` never satisfies the gate.
 */
export const Delta = z.object({
  checked: z.boolean(),
  baseRate: z.number().min(0).max(1).nullable(),
  candidateRate: z.number().min(0).max(1).nullable(),
  threshold: z.number().min(-1).max(1),
  /** candidateRate - baseRate, or null when either side is unmeasured. */
  observed: z.number().min(-1).max(1).nullable(),
  holdoutRevision: z.string().min(1),
});
export type Delta = z.infer<typeof Delta>;

/**
 * The class certificate: the operating point the wall judged a *task class* against, as data
 * rather than as prose in a scenario line.
 *
 * ND1 published α inside the `class-certification` scenario's `observed` text, which made a
 * re-certification job impossible: there was nothing to compare a stored judgement against. This
 * object is the record. `taskClass` rides here — and not only on the verdict — because the class,
 * not the unit, is what gets certified, and a projection keyed by class must be able to read the
 * key off the evidence itself.
 *
 * `alpha` is the published false-refusal risk of the operating point, not a measurement of this
 * class: it is `P(X <= k-1)` under `p0`, identical for every class at the same point.
 */
export const ClassCertificate = z.object({
  taskClass: z.string().min(1),
  /** Attempts required before the class can be judged at all. */
  m: z.number().int().positive(),
  /** Passes required among those attempts. */
  k: z.number().int().positive(),
  /** The true pass rate the certification is calibrated against. */
  p0: z.number().min(0).max(1),
  alpha: z.number().min(0).max(1),
  /** Attempts observed for this class, and how many of them passed. */
  samples: z.number().int().nonnegative(),
  passes: z.number().int().nonnegative(),
  /**
   * `insufficient` and `never-certified` are not "probably fine": fewer than `m` attempts is
   * unknown, and unknown never satisfies a gate. A certificate that does not say `certified`
   * cannot make a class current, whatever a reader wishes it said.
   */
  outcome: z.enum(['certified', 'not-certified', 'insufficient']),
});
export type ClassCertificate = z.infer<typeof ClassCertificate>;

export const Verdict = z.object({
  unitId: z.string().min(1),
  attemptId: z.string().min(1),
  receiptSha: z.string().regex(/^sha256:[0-9a-f]{64}$/),
  holdoutRevision: z.string().min(1),
  policyVersion: z.string().min(1),
  wallVersion: z.string().min(1),
  /** `unknown` is not a synonym for `fail`: it means "not measured", and it refuses every gate. */
  outcome: z.enum(['pass', 'fail', 'unknown']),
  scenarios: z.array(ScenarioResult).max(4096),
  delta: Delta,
  reasons: z.array(z.enum(WALL_REASON_CODES)).max(64),
  /**
   * Set when the verdict *verifies* but its task class is not certifiable — fewer
   * than `policy.minDeltaSamples` Δ samples — so the promotion gate must obtain a
   * human signature. Deliberately a flag and not a reason code: a reason would flip
   * `outcome` to `unknown`, which contradicts "the unit may still verify". Never set
   * on `fail` or `unknown`.
   */
  promotionRequiresHumanSignature: z.boolean().optional(),
  /**
   * The class judgement this verdict carried, when the wall had a holdout to judge against.
   * Absent for a cold start with no holdout: absence means "no class was measured", never
   * "the class is fine".
   */
  certification: ClassCertificate.optional(),
  /**
   * The model id the attempt ran under, when the caller knew it. Optional and nullable on
   * purpose: an offline attempt has no model, and `null` (unknown) must not be read as "no
   * change since" — re-certification treats a null as "cannot prove it is current".
   */
  modelId: z.string().min(1).nullable().optional(),
  evaluatedAt: z.string().datetime(),
});
export type Verdict = z.infer<typeof Verdict>;

/**
 * The invariant this file exists to protect: a `pass` verdict must be *earned*
 * by measurement. Encoded as a parse-time refinement so no code path — not a
 * bug, not a fixture, not a future refactor — can store a vacuous pass.
 */
export function assertVerdictIsEarned(verdict: Verdict): void {
  if (verdict.outcome !== 'pass') {
    if (verdict.reasons.length === 0 && verdict.outcome === 'fail') {
      throw new Error('a fail verdict must carry at least one reason code');
    }
    return;
  }
  if (verdict.reasons.length > 0) {
    throw new Error(`a pass verdict cannot carry reasons: ${verdict.reasons.join(',')}`);
  }
  const failing = verdict.scenarios.filter((s) => s.outcome !== 'pass');
  if (failing.length > 0) {
    throw new Error(
      `a pass verdict requires every scenario to pass; ${failing.map((s) => `${s.id}=${s.outcome}`).join(',')}`,
    );
  }
  if (verdict.scenarios.length === 0) {
    throw new Error('a pass verdict requires at least one measured scenario');
  }
  if (!verdict.delta.checked) {
    throw new Error('a pass verdict requires a measured Δ (unmeasured Δ is unknown, not pass)');
  }
  if (verdict.delta.observed === null) {
    throw new Error('a pass verdict requires an observed Δ value');
  }
  if (verdict.delta.observed < verdict.delta.threshold) {
    throw new Error(
      `a pass verdict requires observed Δ ${verdict.delta.observed} ≥ threshold ${verdict.delta.threshold}`,
    );
  }
}

/** Wall versions are what make a verdict reproducible; a change to any check must bump this. */
export const WALL_VERSION = 'wall/0.1.0';
