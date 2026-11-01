/**
 * The ledger contract.
 *
 * Every state change is one of these events, so the event union is the schema of
 * the factory's history. Two things are proven here: each of the 16 event types
 * has a shape that parses (a valid example each, typed as `Record<EventType, …>`
 * so an added type breaks typecheck rather than going untested), and each maps
 * to exactly one aggregate for `factory audit`. The two type lists in
 * `events.ts` — the payload union and the envelope's `type` enum — are also
 * compared, because a drift between them would make an event unrecordable.
 */
import { describe, expect, it } from 'vitest';
import { aggregateOf, EventPayload, LedgerEvent, type EventType } from './events.ts';

const sha = (fill: string): string => `sha256:${fill.repeat(64)}`;
const OCCURRED_AT = '2026-11-01T12:00:00.000Z';

/** Compile-time exhaustiveness: a new EventType without an example fails typecheck. */
const VALID_PAYLOADS: Readonly<Record<EventType, unknown>> = {
  'unit.submitted': {
    type: 'unit.submitted',
    unitId: 'U-7f3a9c',
    specHash: sha('1'),
    slug: 'slug-check',
    revision: 1,
  },
  'unit.qualified': {
    type: 'unit.qualified',
    unitId: 'U-7f3a9c',
    lane: 'dark',
    laneDecisionId: 'L-2b1e',
    policyVersion: 'q-2026.11.1',
    score: 96,
  },
  'unit.lit_parked': {
    type: 'unit.lit_parked',
    unitId: 'U-7f3a9c',
    reason: 'ORACLE_MISSING',
  },
  'unit.rejected': {
    type: 'unit.rejected',
    unitId: 'U-7f3a9c',
    reason: 'INTENT_NOT_DERIVABLE',
  },
  'unit.dispatched': {
    type: 'unit.dispatched',
    unitId: 'U-7f3a9c',
    attemptId: 'A-01',
    mandateId: 'M-2b1e',
    launchKey: 'dispatch:3f9c',
  },
  'attempt.receipted': {
    type: 'attempt.receipted',
    unitId: 'U-7f3a9c',
    attemptId: 'A-01',
    receiptSha: sha('2'),
    exitCode: 0,
  },
  'attempt.ambiguous': {
    type: 'attempt.ambiguous',
    unitId: 'U-7f3a9c',
    attemptId: 'A-01',
    observedAs: 'pid-gone',
    reason: 'no terminal event at recovery',
  },
  'unit.verified': {
    type: 'unit.verified',
    unitId: 'U-7f3a9c',
    attemptId: 'A-01',
    verdictId: 'V-88f1',
    outcome: 'pass',
  },
  'unit.promoted': {
    type: 'unit.promoted',
    unitId: 'U-7f3a9c',
    verdictId: 'V-88f1',
    promotionSha: sha('3'),
    signedBy: 'operator',
  },
  'unit.aborted': {
    type: 'unit.aborted',
    unitId: 'U-7f3a9c',
    reason: 'operator abort',
    observedAs: null,
  },
  'spend.reserved': {
    type: 'spend.reserved',
    unitId: 'U-7f3a9c',
    attemptId: 'A-01',
    amountUsd: 0.5,
    kind: 'estimate',
  },
  'spend.recorded': {
    type: 'spend.recorded',
    unitId: 'U-7f3a9c',
    attemptId: 'A-01',
    amountUsd: null,
    kind: 'unknown',
  },
  'usage.recorded': {
    type: 'usage.recorded',
    usageId: 'usg_4d2e',
    unitId: 'U-7f3a9c',
    attemptId: 'A-01',
    tokensIn: 1200,
    tokensOut: 340,
    costUsd: 0.02,
    gatewayRequestId: 'req_8812',
    ceilingCrossed: false,
    recordSha: sha('b'),
  },
  'envelope.raised': {
    type: 'envelope.raised',
    envelopeId: 'E-per-unit',
    scope: 'per-unit',
    fromUsd: 2,
    toUsd: 4,
    signedBy: 'operator',
    reason: 'second verification pass',
  },
  'privileged.decided': {
    type: 'privileged.decided',
    decisionId: 'gd_4d2e9a1f7c3b',
    taskId: 'U-7f3a9c',
    operator: 'operator',
    operationSha: sha('3'),
    expiresAt: OCCURRED_AT,
    outcome: 'allow',
  },
  'credential.issued': {
    type: 'credential.issued',
    grantId: 'G-4d2e',
    repo: 'dark-factory-dsh',
    ttlSeconds: 900,
    issuedBy: 'broker',
  },
  'store.quarantined': {
    type: 'store.quarantined',
    reason: 'ledger chain break at event 8812',
    detectedBy: 'control',
  },
  'store.migrated': {
    type: 'store.migrated',
    from: 1,
    to: 2,
    note: 'ND3: append-only usage_records',
  },
  'wall.class_certified': {
    type: 'wall.class_certified',
    certificateId: 'cert:V-1a2b3c',
    verdictId: 'V-1a2b3c',
    unitId: 'U-7f3a9c',
    taskClass: 'refactor-extract-helper',
    m: 20,
    k: 18,
    samples: 20,
    passes: 18,
    alpha: 0.07548367378849634,
    outcome: 'certified',
    policyVersion: 'policy/2026-11-01',
    modelId: 'auto',
    certificateSha: 'sha256:1f4c',
  },
  'recovery.completed': {
    type: 'recovery.completed',
    recoveryRunId: 'R-91ab',
    orphanedAttempts: 0,
    ambiguous: 2,
  },
};

/** Compile-time exhaustiveness again: one aggregate per type, no defaulting in the test. */
const EXPECTED_AGGREGATE: Readonly<Record<EventType, ReturnType<typeof aggregateOf>>> = {
  'unit.submitted': 'unit',
  'unit.qualified': 'unit',
  'unit.lit_parked': 'unit',
  'unit.rejected': 'unit',
  'unit.dispatched': 'unit',
  'attempt.receipted': 'attempt',
  'attempt.ambiguous': 'attempt',
  'unit.verified': 'unit',
  'unit.promoted': 'unit',
  'unit.aborted': 'unit',
  'spend.reserved': 'spend',
  'spend.recorded': 'spend',
  // Usage is the measured half of spend: the same aggregate, so `audit`'s projection keeps one
  // case for "what did this unit cost us" rather than two overlapping ones.
  'usage.recorded': 'spend',
  'envelope.raised': 'envelope',
  // Both are authorization facts; the credential aggregate is reused on purpose so
  // `audit`'s projection switch does not grow a second case for one event type.
  'privileged.decided': 'credential',
  'credential.issued': 'credential',
  // A wall judgement gets its own aggregate: `audit --certifications` asks "what has the wall
  // certified", which is not a question about the ledger's own state.
  'wall.class_certified': 'wall',
  'store.quarantined': 'store',
  'store.migrated': 'store',
  'recovery.completed': 'store',
};

describe('each of the 20 event types', () => {
  for (const [type, payload] of Object.entries(VALID_PAYLOADS)) {
    it(`accepts a valid ${type} payload`, () => {
      expect(EventPayload.parse(payload).type).toBe(type);
    });
  }
});

describe('EventPayload', () => {
  it('covers 20 event types', () => {
    // 19 since ND3 added `usage.recorded` (spend as the gateway reported it) and `store.migrated`
    // (an additive schema migration ran on open); 20 since ND1 half two added
    // `wall.class_certified` (a class judgement exists as a record, not as prose in a scenario
    // line). A count that drifts from the union is the point of this spec; the number moves when a
    // fact becomes worth recording, never to make a suite green.
    expect(Object.keys(VALID_PAYLOADS)).toHaveLength(20);
  });

  it('rejects an unknown event type', () => {
    const result = EventPayload.safeParse({ type: 'unit.vanished', unitId: 'U-7f3a9c' });
    expect(result.success).toBe(false);
  });

  it('rejects a known type that is missing a fact the audit would need', () => {
    const { receiptSha: _dropped, ...withoutSha } = VALID_PAYLOADS['attempt.receipted'] as Record<
      string,
      unknown
    >;
    expect(EventPayload.safeParse(withoutSha).success).toBe(false);
  });
});

describe('aggregateOf', () => {
  it('maps every event type to its aggregate, prefix by prefix', () => {
    for (const [type, payload] of Object.entries(VALID_PAYLOADS)) {
      const parsed = EventPayload.parse(payload);
      expect(aggregateOf(parsed.type)).toBe(EXPECTED_AGGREGATE[parsed.type]);
    }
  });

  it('groups recovery under the store aggregate (recovery is a store-level operation)', () => {
    expect(aggregateOf('recovery.completed')).toBe('store');
  });
});

describe('the ledger envelope', () => {
  it('accepts an envelope for every payload type (the two type lists cannot drift apart)', () => {
    for (const [type, payload] of Object.entries(VALID_PAYLOADS)) {
      const event = {
        seq: 1,
        eventId: 'E-0001',
        type,
        occurredAt: OCCURRED_AT,
        actor: 'control',
        traceId: 'T-9c1f',
        payload,
      };
      expect(LedgerEvent.safeParse(event).success).toBe(true);
    }
  });

  it('declares the same 19 types the payload union declares', () => {
    // The envelope enum is written out by hand in events.ts; reading the schema
    // is the only way to prove the two lists agree rather than assume it.
    const ledgerTypes = (LedgerEvent.shape.type as unknown as { options: readonly string[] })
      .options;
    expect([...ledgerTypes].sort()).toEqual(Object.keys(VALID_PAYLOADS).sort());
  });

  it('requires a monotonic seq, not a timestamp, for replay order', () => {
    const event = {
      seq: -1,
      eventId: 'E-0001',
      type: 'unit.aborted',
      occurredAt: OCCURRED_AT,
      actor: 'control',
      traceId: 'T-9c1f',
      payload: VALID_PAYLOADS['unit.aborted'],
    };
    expect(LedgerEvent.safeParse(event).success).toBe(false);
  });
});
