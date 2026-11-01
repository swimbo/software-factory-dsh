/**
 * The append-only event ledger.
 *
 * Every state change in the factory is one of these events, written in the same
 * transaction as the aggregate it changes. Nothing else may mutate state: the
 * aggregates are projections, so a divergence between ledger and aggregate is a
 * bug that `factory audit` can detect rather than a data loss that nobody sees.
 *
 * Events are also the replay input. A replay of the ledger must reproduce every
 * aggregate exactly, which is why every event carries the facts it needs and no
 * event carries a timestamp derived from "now" alone.
 */
import { z } from 'zod';

const hash = z.string().regex(/^sha256:[0-9a-f]{64}$/);
const iso = z.string().datetime();

export const EventPayload = z.discriminatedUnion('type', [
  z.object({
    type: z.literal('unit.submitted'),
    unitId: z.string(),
    specHash: hash,
    slug: z.string(),
    revision: z.number().int().positive(),
  }),
  z.object({
    type: z.literal('unit.qualified'),
    unitId: z.string(),
    lane: z.enum(['dark', 'lit', 'reject']),
    laneDecisionId: z.string(),
    policyVersion: z.string(),
    score: z.number(),
  }),
  z.object({
    type: z.literal('unit.lit_parked'),
    unitId: z.string(),
    reason: z.string(),
  }),
  z.object({
    type: z.literal('unit.rejected'),
    unitId: z.string(),
    reason: z.string(),
  }),
  z.object({
    type: z.literal('unit.dispatched'),
    unitId: z.string(),
    attemptId: z.string(),
    mandateId: z.string(),
    launchKey: z.string(),
  }),
  z.object({
    type: z.literal('attempt.receipted'),
    unitId: z.string(),
    attemptId: z.string(),
    receiptSha: hash,
    exitCode: z.number().int().nullable(),
  }),
  z.object({
    type: z.literal('attempt.ambiguous'),
    unitId: z.string(),
    attemptId: z.string(),
    observedAs: z.string(),
    reason: z.string(),
  }),
  z.object({
    type: z.literal('unit.verified'),
    unitId: z.string(),
    attemptId: z.string(),
    verdictId: z.string(),
    outcome: z.enum(['pass', 'fail', 'unknown']),
  }),
  z.object({
    type: z.literal('unit.promoted'),
    unitId: z.string(),
    verdictId: z.string(),
    promotionSha: hash,
    signedBy: z.string(),
  }),
  z.object({
    type: z.literal('unit.aborted'),
    unitId: z.string(),
    reason: z.string(),
    observedAs: z.string().nullable(),
  }),
  z.object({
    type: z.literal('spend.reserved'),
    unitId: z.string(),
    attemptId: z.string(),
    amountUsd: z.number().nonnegative(),
    kind: z.enum(['estimate', 'unknown']),
  }),
  z.object({
    type: z.literal('spend.recorded'),
    unitId: z.string(),
    attemptId: z.string(),
    amountUsd: z.number().nonnegative().nullable(),
    kind: z.enum(['estimate', 'measured', 'unknown']),
  }),
  z.object({
    type: z.literal('envelope.raised'),
    envelopeId: z.string(),
    scope: z.enum(['per-unit', 'daily']),
    fromUsd: z.number().nonnegative(),
    toUsd: z.number().nonnegative(),
    signedBy: z.string(),
    reason: z.string(),
  }),
  z.object({
    // A brokered privileged operation: either a human decision to allow one exact
    // operation, or the refusal of one. Recorded as an event so the decision can be
    // audited after the fact — a decision that lives only in the proxy's memory is not
    // a decision the factory can defend the next morning.
    type: z.literal('privileged.decided'),
    decisionId: z.string(),
    taskId: z.string(),
    operator: z.string(),
    operationSha: hash,
    expiresAt: iso,
    outcome: z.enum(['allow', 'deny']),
  }),
  z.object({
    type: z.literal('credential.issued'),
    grantId: z.string(),
    repo: z.string(),
    ttlSeconds: z.number().int().positive(),
    issuedBy: z.string(),
  }),
  z.object({
    type: z.literal('store.quarantined'),
    reason: z.string(),
    detectedBy: z.string(),
  }),
  z.object({
    type: z.literal('recovery.completed'),
    recoveryRunId: z.string(),
    orphanedAttempts: z.number().int().nonnegative(),
    ambiguous: z.number().int().nonnegative(),
  }),
]);
export type EventPayload = z.infer<typeof EventPayload>;
export type EventType = EventPayload['type'];

/**
 * The envelope on the ledger. `seq` is a monotonic integer assigned by the store
 * inside the same transaction, so gaps are detectable and replay order is not
 * dependent on wall-clock time (two events can share a millisecond).
 */
export const LedgerEvent = z.object({
  seq: z.number().int().nonnegative(),
  eventId: z.string().min(1),
  type: z.enum([
    'unit.submitted',
    'unit.qualified',
    'unit.lit_parked',
    'unit.rejected',
    'unit.dispatched',
    'attempt.receipted',
    'attempt.ambiguous',
    'unit.verified',
    'unit.promoted',
    'unit.aborted',
    'spend.reserved',
    'spend.recorded',
    'envelope.raised',
    'privileged.decided',
    'credential.issued',
    'store.quarantined',
    'recovery.completed',
  ]),
  occurredAt: iso,
  /** The process that wrote it: `control`, `wall`, `worker-proxy`, or a recovery run. */
  actor: z.string().min(1),
  /** Correlates an event with the command that caused it, for the audit trail. */
  traceId: z.string().min(1),
  payload: z.record(z.string(), z.unknown()),
});
export type LedgerEvent = z.infer<typeof LedgerEvent>;

/** Which aggregate each event belongs to; used by `audit` to rebuild projections. */
export function aggregateOf(
  type: EventType,
): 'unit' | 'attempt' | 'spend' | 'envelope' | 'credential' | 'store' {
  if (type.startsWith('unit.')) return 'unit';
  if (type.startsWith('attempt.')) return 'attempt';
  if (type.startsWith('spend.')) return 'spend';
  if (type.startsWith('envelope.')) return 'envelope';
  if (type.startsWith('credential.')) return 'credential';
  // `privileged.decided` reuses the credential aggregate: both are authorization facts.
  // Widening this union to a new `gate` aggregate would ripple into `audit`'s projection
  // switch, which owns that decision.
  if (type.startsWith('privileged.')) return 'credential';
  return 'store';
}
