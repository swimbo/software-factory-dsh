/**
 * `status.v1` — the one shape shared by `GET /api/status` and `factory status --json`.
 *
 * It lives in the contract package rather than in either consumer because E2E-11
 * asserts that both surfaces validate against the *same* schema: two schemas that
 * merely look alike drift the first time one of them gains a field.
 *
 * Three rules are encoded here rather than left to a renderer:
 *  - `value: null` + `state: 'unknown'` is the only way to say "not measured"
 *    (never `0`, never an omitted key — an omitted key renders as nothing, and
 *    nothing reads as "fine").
 *  - `health.*.state` is a three-state enum, never a boolean: `ok | degraded |
 *    unavailable`. A boolean is what makes a page say "fine" about a thing it
 *    could not check.
 *  - `budget.telemetry` is an enum for the same reason: a boolean `estimated`
 *    would let a surface render a bare number when false, and every number this
 *    factory has is an estimate.
 */
import { z } from 'zod';

const iso = z.string().datetime();
const nullableIso = iso.nullable();
const id = z.string().regex(/^[A-Z]-[0-9a-z]{4,}$/);

/** The three-state health vocabulary. `unavailable` ≠ `degraded` ≠ `ok`. */
export const HEALTH_STATES = ['ok', 'degraded', 'unavailable'] as const;
export type HealthState = (typeof HEALTH_STATES)[number];

const HealthStateEnum = z.enum(HEALTH_STATES);

/** Where a number came from. v1 never emits `measured` for spend (no billing-grade telemetry). */
export const MEASUREMENT_KINDS = ['estimated', 'measured', 'unknown'] as const;
const MeasurementKind = z.enum(MEASUREMENT_KINDS);

/** A measurement that may be absent. `null` + `unknown` is the honest pair. */
const Measurement = z.object({
  value: z.number().nullable(),
  samples: z.number().int().nonnegative(),
  state: z.enum(['stable', 'unstable', 'unknown', 'measured']),
  measuredAt: nullableIso.optional(),
});

export const FACTORY_STATUS_KINDS = [
  'budget_envelope_raise',
  'initial_production_deploy',
  'privileged_credential_issuance',
  'lit_unit',
  'ambiguous_attempt',
  'unknown_verdict',
  'escape_rate_review',
] as const;

export const WaitingOnPerson = z.object({
  id,
  kind: z.enum(FACTORY_STATUS_KINDS),
  unitId: id.nullable(),
  question: z.string().min(1),
  recommendedCommand: z.string().min(1),
  irreversible: z.boolean(),
  since: iso,
});
export type WaitingOnPerson = z.infer<typeof WaitingOnPerson>;

export const UNIT_STATUS_STATES = [
  'queued',
  'dispatched',
  'running',
  'verifying',
  'verified',
  'promoted',
  'failed',
  'rejected',
  'unknown',
  'ambiguous',
  'aborted',
  'lit_parked',
] as const;
export type UnitStatusState = (typeof UNIT_STATUS_STATES)[number];

export const AttemptStatus = z.object({
  attemptNo: z.number().int().positive(),
  state: z.string().min(1),
  /** Unmeasurable in v1: the store has no per-turn telemetry. `null`, never `0`. */
  turn: z.number().int().nonnegative().nullable(),
  tokensUsed: z.number().int().nonnegative().nullable(),
  tokenCeiling: z.number().int().nonnegative().nullable(),
  wallClockCeilingS: z.number().nonnegative().nullable(),
  startedAt: iso,
  lastProgressAt: nullableIso,
  noProgressStreak: z.number().int().nonnegative().nullable(),
});
export type AttemptStatus = z.infer<typeof AttemptStatus>;

export const VerdictStatus = z.object({
  verdictId: id,
  state: z.enum(['passed', 'failed', 'unknown']),
  wallVersion: z.string().min(1),
  holdoutRevision: z.string().min(1),
  policyVersion: z.string().min(1),
  holdout: z.object({
    passed: z.number().int().nonnegative(),
    total: z.number().int().nonnegative(),
    /** The honest rule string. v1 never claims a certification rate (amendment A14). */
    rule: z.string().min(1),
  }),
  delta: z.object({
    value: z.number().nullable(),
    visiblePassRate: z.number().nullable(),
    holdoutPassRate: z.number().nullable(),
    samples: z.number().int().nonnegative(),
    state: z.enum(['stable', 'unstable', 'unknown', 'measured']),
  }),
  receipt: z.object({
    receiptId: id,
    faithful: z.boolean().nullable(),
    contentHash: z.string().min(1),
  }),
  /** Required non-null iff `state === 'unknown'`: a reason-less unknown is a bug. */
  unknownReason: z.string().min(1).nullable(),
  signed: z
    .object({ alg: z.string().min(1), keyId: z.string().min(1), verified: z.boolean() })
    .nullable(),
  promotionBlocked: z.string().nullable(),
  createdAt: iso,
});
export type VerdictStatus = z.infer<typeof VerdictStatus>;

export const UnitStatus = z.object({
  unitId: id,
  title: z.string().min(1),
  /** `null` while the unit has no lane decision yet (submitted, unqualified). */
  lane: z.enum(['dark', 'lit', 'reject']).nullable(),
  state: z.enum(UNIT_STATUS_STATES),
  attempt: AttemptStatus.nullable(),
  /** Present iff `state === 'ambiguous'`: what is known, what is not, what was not done. */
  ambiguity: z
    .object({
      known: z.string().min(1),
      unknown: z.string().min(1),
      notDone: z.string().min(1),
      observedAt: iso,
    })
    .nullable()
    /** Absent means the same as `null`: the unit is not ambiguous (the CLI omits it). */
    .optional(),
  verdict: VerdictStatus.nullable(),
  promotion: z.object({ id, signedAt: iso, signedBy: z.string().min(1) }).nullable(),
  updatedAt: iso,
});
export type UnitStatus = z.infer<typeof UnitStatus>;

const SubsystemHealth = z.object({
  state: HealthStateEnum,
  detail: z.string().nullable(),
  since: nullableIso,
});

export const HealthStatus = z.object({
  store: SubsystemHealth.extend({
    quarantined: z.boolean(),
    schemaVersion: z.number().int().positive(),
    ledgerHead: z.string().min(1).nullable(),
  }),
  controlPlane: SubsystemHealth.extend({ uptimeS: z.number().nonnegative() }),
  executor: SubsystemHealth.extend({
    kind: z.string().min(1),
    image: z.string().min(1).nullable(),
  }),
  wall: SubsystemHealth.extend({ holdoutRevision: z.string().min(1).nullable() }),
  outbox: SubsystemHealth.extend({
    /** `null` when the store exposes no read-only outbox count — never a claimed 0. */
    pending: z.number().int().nonnegative().nullable(),
    retrying: z.number().int().nonnegative().nullable(),
    dead: z.number().int().nonnegative().nullable(),
  }),
  dshVersion: SubsystemHealth.extend({
    expected: z.string().min(1),
    observed: z.string().min(1).nullable(),
  }),
  /** Δ per task class lives here because it *is* a health metric: unknown Δ ⇒ no certification. */
  taskClasses: z.array(
    z.object({
      class: z.string().min(1),
      delta: Measurement,
      escapeRate: Measurement,
    }),
  ),
});
export type HealthStatus = z.infer<typeof HealthStatus>;

export const BudgetStatus = z.object({
  currency: z.literal('USD'),
  priceTableVersion: z.string().min(1),
  /** Never `measured` in v1. An enum, not a boolean, so provenance reaches the render path. */
  telemetry: z.enum(['estimated', 'unknown']),
  note: z.string().min(1),
  perUnit: z.object({ limit: z.number().nonnegative(), kind: MeasurementKind }),
  perDay: z.object({
    limit: z.number().nonnegative(),
    spent: z.number().nonnegative().nullable(),
    reserved: z.number().nonnegative().nullable(),
    kind: MeasurementKind,
    measuredSpent: z.number().nonnegative().nullable(),
  }),
  /** > 0 ⇒ the renderer must show a gap and the words "spend understated". */
  unknownCount: z.number().int().nonnegative(),
  state: z.enum(['ok', 'degraded', 'unknown']),
});
export type BudgetStatus = z.infer<typeof BudgetStatus>;

/**
 * The envelope (`schemaVersion`, `generatedAt`, `factory`) plus the four content
 * keys. The content keys are the normative contract (`architecture.md` §4); the
 * envelope exists so a stale page is visibly stale and a version mismatch is
 * visible without a second request.
 */
export const StatusV1 = z
  .object({
    schemaVersion: z.literal('status.v1'),
    generatedAt: iso,
    factory: z.object({
      version: z.string().min(1),
      dshVersionExpected: z.string().min(1),
      dshVersionObserved: z.string().min(1).nullable(),
      policyVersion: z.string().min(1),
      /**
       * `null` when the wall is not wired for this build. A version string would be
       * a claim about an instrument that produced nothing (L3: unknown is not pass).
       */
      wallVersion: z.string().min(1).nullable(),
      holdoutRevision: z.string().min(1).nullable(),
      /**
       * Which topology this instance is actually running under (ND2). Required rather than
       * optional: "the wall is a separate principal" holds only on a provisioned Linux host, and
       * a surface that could omit the field would let the stronger sentence stand everywhere.
       * `claim` is the sentence a reader may repeat, generated by the same module the provisioner
       * runs — the page and the script cannot quote two different ones.
       */
      topology: z.object({
        kind: z.enum(['two-uid', 'single-uid']),
        reason: z.string().min(1),
        claim: z.string().min(1),
      }),
    }),
    waitingOnPerson: z.array(WaitingOnPerson),
    units: z.array(UnitStatus),
    health: HealthStatus,
    budget: BudgetStatus,
  })
  .superRefine((status, ctx) => {
    // A verdict that says "unknown" must say why. Without this, an unmeasured
    // outcome can reach a surface with no explanation and render as "fine".
    for (const [index, unit] of status.units.entries()) {
      if (unit.verdict === null) continue;
      const isUnknown = unit.verdict.state === 'unknown';
      if (isUnknown && unit.verdict.unknownReason === null) {
        ctx.addIssue({
          code: 'custom',
          path: ['units', index, 'verdict', 'unknownReason'],
          message: 'an unknown verdict must carry unknownReason',
        });
      }
      if (!isUnknown && unit.verdict.unknownReason !== null) {
        ctx.addIssue({
          code: 'custom',
          path: ['units', index, 'verdict', 'unknownReason'],
          message: 'unknownReason must be null unless the verdict is unknown',
        });
      }
    }
    // "Not measured" may never be rendered as a measured zero.
    for (const [index, unit] of status.units.entries()) {
      const attempt = unit.attempt;
      if (attempt === null) continue;
      if (attempt.tokensUsed === 0) {
        ctx.addIssue({
          code: 'custom',
          path: ['units', index, 'attempt', 'tokensUsed'],
          message: 'tokensUsed must be null when unmeasured, never 0',
        });
      }
    }
  });
export type StatusV1 = z.infer<typeof StatusV1>;

/** A renderer must refuse to draw a component it cannot validate (ui-plan §5.3, fail closed). */
export function parseStatus(input: unknown): StatusV1 {
  return StatusV1.parse(input);
}
