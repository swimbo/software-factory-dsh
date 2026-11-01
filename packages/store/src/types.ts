/**
 * The store's contract.
 *
 * Everything above the store codes against this interface, never against SQLite.
 * Two properties are part of the contract and not implementation detail:
 *
 *  1. **Every mutation is transactional with its event.** A method that changes
 *     an aggregate appends the matching ledger event in the same transaction, or
 *     it does not change anything.
 *  2. **A quarantined store refuses every write.** The refusal is
 *     `STORE_QUARANTINED` from `@factory/contracts`, raised before any SQL runs.
 */
import type {
  ErrorCode,
  LaneDecisionType,
  LedgerEvent,
  UnitSpec,
  UnitState,
  VerdictType,
  WorkerReceiptType,
} from '@factory/contracts';

export const UNIT_EXAMPLE = undefined; // keeps this file's import list honest for type-only use
void UNIT_EXAMPLE;

export interface UnitRow {
  readonly unitId: string;
  readonly slug: string;
  readonly revision: number;
  readonly repo: string;
  readonly baseRev: string;
  readonly specHash: string;
  readonly spec: UnitSpec;
  readonly state: UnitState;
  readonly lane: 'dark' | 'lit' | 'reject' | null;
  readonly currentMandateId: string | null;
  readonly attemptCount: number;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly terminalAt: string | null;
  readonly terminalReason: string | null;
}

export interface MandateRow {
  readonly mandateId: string;
  readonly unitId: string;
  readonly policyVersion: string;
  readonly lane: 'dark' | 'lit';
  readonly budgetUsd: number;
  readonly issuedAt: string;
  readonly expiresAt: string;
  readonly revokedAt: string | null;
}

export interface AttemptRow {
  readonly attemptId: string;
  readonly unitId: string;
  readonly leaseId: string;
  readonly state:
    'planned' | 'launching' | 'running' | 'produced-receipt' | 'aborted' | 'ambiguous';
  readonly launchKey: string;
  readonly sessionId: string | null;
  readonly attemptDir: string;
  readonly startedAt: string;
  readonly endedAt: string | null;
  readonly exitCode: number | null;
}

export interface ReceiptRow {
  readonly receiptId: string;
  readonly unitId: string;
  readonly attemptId: string;
  readonly receiptSha: string;
  readonly sessionId: string;
  readonly exitCode: number | null;
  readonly startedAt: string;
  readonly endedAt: string;
  readonly recordedAt: string;
  readonly receipt: WorkerReceiptType;
}

export interface VerdictRow {
  readonly verdictId: string;
  readonly unitId: string;
  readonly attemptId: string;
  readonly receiptId: string | null;
  readonly receiptSha: string | null;
  readonly holdoutRevision: string | null;
  readonly policyVersion: string;
  readonly wallVersion: string;
  readonly outcome: 'pass' | 'fail' | 'unknown';
  readonly evaluatedAt: string;
  readonly verdict: VerdictType;
}

export interface EffectRow {
  readonly effectId: string;
  readonly idempotencyKey: string;
  readonly kind: string;
  readonly payload: unknown;
  readonly state: 'pending' | 'applied' | 'failed';
  readonly attempts: number;
  readonly createdAt: string;
  readonly appliedAt: string | null;
  readonly lastError: string | null;
}

export interface AppendOptions {
  readonly actor: string;
  readonly traceId: string;
  readonly occurredAt?: string;
}

/** The refusal surface. Any `ErrorCode` may be raised; these are the ones the store owns. */
export type StoreRefusal = ErrorCode;
export interface Store {
  // --- lifecycle
  close(): void;
  readonly location: string;
  readonly schemaVersion: number;
  readonly pragmas: Readonly<Record<string, string>>;

  /**
   * Run `fn` in a single transaction. Every store call inside joins it; an
   * exception rolls the whole thing back, including the ledger events.
   */
  atomic<T>(fn: () => T): T;

  // --- ledger
  appendEvent(event: LedgerEvent['payload'], options: AppendOptions): LedgerEvent;
  eventsSince(seq: number, limit?: number): LedgerEvent[];
  eventCount(): number;
  /** Rebuilds aggregates from the ledger and reports divergence instead of hiding it. */
  audit(): { ok: boolean; divergences: string[]; events: number };

  // --- quarantine
  isQuarantined(): boolean;
  quarantine(reason: string, actor: string, traceId: string): void;

  // --- units
  getUnit(unitId: string): UnitRow | null;
  findUnitBySlug(repo: string, slug: string, revision: number): UnitRow | null;
  findUnitBySpecHash(repo: string, specHash: string): UnitRow | null;
  insertUnit(unit: UnitRow, options: AppendOptions): UnitRow;
  setUnitState(
    unitId: string,
    state: UnitState,
    reason: string | null,
    options: AppendOptions,
  ): UnitRow;
  setUnitLaneAndMandate(
    unitId: string,
    lane: 'dark' | 'lit' | 'reject',
    mandateId: string | null,
    options: AppendOptions,
  ): UnitRow;
  incrementAttemptCount(unitId: string, options: AppendOptions): number;
  listUnits(filter?: {
    state?: UnitState;
    lane?: 'dark' | 'lit' | 'reject';
    limit?: number;
  }): UnitRow[];
  countUnitsByState(): Record<UnitState, number>;

  // --- mandates
  insertMandate(mandate: MandateRow): MandateRow;
  getMandate(mandateId: string): MandateRow | null;
  revokeMandate(mandateId: string, at: string): void;

  // --- lane decisions
  insertLaneDecision(decision: LaneDecisionType & { decisionId: string }): void;
  getLaneDecision(
    unitId: string,
    policyVersion: string,
  ): (LaneDecisionType & { decisionId: string }) | null;

  // --- leases
  acquireLease(input: {
    leaseId: string;
    unitId: string;
    owner: string;
    acquiredAt: string;
    expiresAt: string;
  }): void;
  getLiveLease(unitId: string): { leaseId: string; owner: string; expiresAt: string } | null;
  releaseLease(leaseId: string, at: string): void;
  listExpiredLeases(now: string): Array<{ leaseId: string; unitId: string; expiresAt: string }>;

  // --- attempts
  insertAttempt(attempt: AttemptRow): AttemptRow;
  getAttempt(attemptId: string): AttemptRow | null;
  setAttemptState(
    attemptId: string,
    state: AttemptRow['state'],
    patch: { endedAt?: string | null; exitCode?: number | null; sessionId?: string | null },
  ): AttemptRow;
  listActiveAttempts(): AttemptRow[];
  listAttemptsForUnit(unitId: string): AttemptRow[];

  // --- receipts
  insertReceipt(row: ReceiptRow, options: AppendOptions): ReceiptRow;
  getReceiptBySha(receiptSha: string): ReceiptRow | null;
  latestReceiptForUnit(unitId: string): ReceiptRow | null;

  // --- verdicts
  insertVerdict(row: VerdictRow, options: AppendOptions): VerdictRow;
  latestVerdictForUnit(unitId: string): VerdictRow | null;
  getVerdict(verdictId: string): VerdictRow | null;

  // --- promotions
  insertPromotion(row: {
    promotionId: string;
    unitId: string;
    verdictId: string;
    verdictSha: string;
    promotionSha: string;
    signedBy: string;
    createdAt: string;
  }): void;
  getPromotion(unitId: string, verdictSha: string): { promotionId: string } | null;

  // --- spend
  reserveSpend(row: {
    spendId: string;
    unitId: string;
    attemptId: string | null;
    amountUsd: number;
    recordedAt: string;
  }): void;
  recordSpend(row: {
    spendId: string;
    unitId: string;
    attemptId: string | null;
    kind: 'estimate' | 'measured' | 'unknown';
    amountUsd: number | null;
    recordedAt: string;
  }): void;
  spendForUnit(unitId: string): { reservedUsd: number; recordedUsd: number; unknownRows: number };

  // --- envelopes
  currentEnvelope(scope: 'per-unit' | 'daily'): { envelopeId: string; amountUsd: number } | null;
  raiseEnvelope(row: {
    envelopeId: string;
    scope: 'per-unit' | 'daily';
    amountUsd: number;
    effectiveFrom: string;
    supersedes: string | null;
    signedBy: string;
    reason: string;
  }): void;

  // --- credentials
  insertCredential(row: {
    grantId: string;
    repo: string;
    ttlSeconds: number;
    issuedBy: string;
    issuedAt: string;
    expiresAt: string;
  }): void;
  revokeCredential(grantId: string, at: string): void;

  // --- effects (outbox)
  enqueueEffect(row: {
    effectId: string;
    idempotencyKey: string;
    kind: string;
    payload: unknown;
    createdAt: string;
  }): EffectRow;
  getEffectByKey(idempotencyKey: string): EffectRow | null;
  claimPendingEffects(limit: number): EffectRow[];
  markEffectApplied(effectId: string, at: string): void;
  /**
   * A failure that may be retried: `attempts` increments, `last_error` is set,
   * and the effect stays `pending` so the next drain picks it up again. This
   * exists separately from `markEffectExhausted` because "it failed once" and
   * "it will never succeed" are different facts, and collapsing them either
   * loses retries or retries forever.
   */
  recordEffectFailure(effectId: string, error: string): EffectRow;
  /** A terminal failure: `attempts` increments, `last_error` is set, state becomes `failed` for good. */
  markEffectExhausted(effectId: string, error: string): void;

  // --- recovery
  insertRecoveryRun(row: { recoveryRunId: string; startedAt: string }): void;
  completeRecoveryRun(
    recoveryRunId: string,
    at: string,
    counts: { orphanedAttempts: number; ambiguous: number },
  ): void;
}
