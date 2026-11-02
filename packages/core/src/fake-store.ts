/**
 * An in-memory `Store` for the engine's tests.
 *
 * This is not a second implementation of the store: it is the *contract* of
 * `@factory/store` expressed with Maps, so an engine test can assert ordering
 * ("no effect was enqueued before the budget gate refused") without a temp
 * directory, a WAL, or a clock. The behaviours the engine depends on are
 * reproduced faithfully — event derivation from rows, idempotent unit insert,
 * one live lease per unit, one receipt per hash, `stateAfter` semantics — because
 * a fake that is more permissive than the real store hides exactly the bugs these
 * tests exist to find.
 *
 * Anything the engine does not call is implemented as a refusal rather than a
 * guess: a test that starts needing it should get a loud failure, not a silent
 * no-op.
 *
 * Test-only. It is deliberately *not* exported from the package entry point.
 */
import { createHash } from 'node:crypto';
import {
  EventPayload,
  FactoryError,
  UnitSpec,
  Verdict,
  WorkerReceipt,
  assertVerdictIsEarned,
  canTransition,
  contentHash,
  isTerminal,
  type LaneDecisionType,
  type LedgerEvent,
  type UnitState,
  receiptShaFor,
} from '@factory/contracts';
import type {
  AppendOptions,
  AttemptRow,
  EffectRow,
  MandateRow,
  ReceiptRow,
  Store,
  UnitRow,
  VerdictRow,
} from '@factory/store';
import { join } from 'node:path';

interface LeaseRow {
  readonly leaseId: string;
  readonly unitId: string;
  readonly owner: string;
  readonly acquiredAt: string;
  readonly expiresAt: string;
  releasedAt: string | null;
}

/** The shape `recordUsage` returns; identical to the real store's `UsageRow`. */
interface UsageRowLike {
  usageId: string;
  unitId: string;
  attemptId: string;
  tokensIn: number;
  tokensOut: number;
  costUsd: number | null;
  gatewayRequestId: string | null;
  signedAt: string;
  recordSha: string;
  ceilingCrossed: boolean;
}

interface SpendRow {
  readonly spendId: string;
  readonly unitId: string;
  readonly attemptId: string | null;
  readonly kind: 'reserved' | 'estimate' | 'measured' | 'unknown';
  readonly amountUsd: number | null;
  readonly recordedAt: string;
}

interface PromotionRow {
  readonly promotionId: string;
  readonly unitId: string;
  readonly verdictId: string;
  readonly verdictSha: string;
  readonly promotionSha: string;
  readonly signedBy: string;
  readonly createdAt: string;
}

interface CredentialRow {
  readonly grantId: string;
  readonly repo: string;
  readonly ttlSeconds: number;
  readonly issuedBy: string;
  readonly issuedAt: string;
  readonly expiresAt: string;
  revokedAt: string | null;
}

interface RecoveryRunRow {
  readonly recoveryRunId: string;
  readonly startedAt: string;
  completedAt: string | null;
  orphanedAttempts: number;
  ambiguous: number;
}

const ALL_STATES: readonly UnitState[] = [
  'submitted',
  'qualified',
  'lit_parked',
  'dispatched',
  'receipted',
  'verified',
  'promoted',
  'rejected',
  'aborted',
  'ambiguous',
];

/** The real store's rule: a terminal unit keeps its state, everything else moves. */
function stateAfter(current: UnitState, target: UnitState): UnitState {
  return isTerminal(current) ? current : target;
}

export class FakeStore implements Store {
  /** The engine derives attempt directories from this, exactly as it does with the real store. */
  readonly location: string;
  readonly schemaVersion = 1;
  readonly pragmas: Readonly<Record<string, string>> = { journal_mode: 'wal', foreign_keys: 'on' };

  readonly ledger: EventPayload[] = [];
  /** How many times each store method was called — the tests assert ordering with it. */
  readonly calls: Record<string, number> = {};

  private readonly units = new Map<string, UnitRow>();
  private readonly mandates = new Map<string, MandateRow>();
  private readonly decisions = new Map<string, LaneDecisionType & { decisionId: string }>();
  private readonly leases = new Map<string, LeaseRow>();
  private readonly attempts = new Map<string, AttemptRow>();
  private readonly receipts = new Map<string, ReceiptRow>();
  private readonly verdicts = new Map<string, VerdictRow>();
  private readonly effects = new Map<string, EffectRow>();
  private readonly spend: SpendRow[] = [];
  /** ND3: metered usage facts, appended in order like the real table. */
  private readonly usage: UsageRowLike[] = [];
  private readonly promotions: PromotionRow[] = [];
  private readonly credentials = new Map<string, CredentialRow>();
  private readonly recoveryRuns = new Map<string, RecoveryRunRow>();
  private readonly envelopes: Array<{
    envelopeId: string;
    scope: 'per-unit' | 'daily';
    amountUsd: number;
    effectiveFrom: string;
    supersedes: string | null;
    signedBy: string;
    reason: string;
  }> = [];

  private quarantined: string | null = null;
  private depth = 0;
  private seq = 0;

  constructor(stateDir = '/tmp/factory-test-state') {
    this.location = join(stateDir, 'factory.db');
  }

  // ------------------------------------------------------------------ helpers

  private tick(method: string): void {
    this.calls[method] = (this.calls[method] ?? 0) + 1;
  }

  /** Refusals are the same `FactoryError`s the real store raises, so tests assert on codes. */
  private assertWritable(operation: string): void {
    if (this.quarantined !== null) {
      throw new FactoryError(
        'STORE_QUARANTINED',
        `store ${this.location} is quarantined (${this.quarantined}); ${operation} refused`,
        { operation, location: this.location },
      );
    }
  }

  private unit(unitId: string): UnitRow {
    const row = this.units.get(unitId);
    if (row === undefined) {
      throw new FactoryError(
        'UNIT_NOT_FOUND',
        `unit ${unitId} does not exist in ${this.location}`,
        { unitId },
      );
    }
    return row;
  }

  private attempt(attemptId: string): AttemptRow {
    const row = this.attempts.get(attemptId);
    if (row === undefined) {
      throw new FactoryError('ATTEMPT_NOT_FOUND', `attempt ${attemptId} does not exist`, {
        attemptId,
      });
    }
    return row;
  }

  private update(unitId: string, patch: Partial<UnitRow>, at: string): UnitRow {
    const current = this.unit(unitId);
    const next: UnitRow = { ...current, ...patch, updatedAt: at };
    this.units.set(unitId, next);
    return next;
  }

  private latestDecision(unitId: string): (LaneDecisionType & { decisionId: string }) | null {
    let found: (LaneDecisionType & { decisionId: string }) | null = null;
    for (const decision of this.decisions.values()) {
      if (decision.unitId !== unitId) continue;
      if (found === null || decision.decidedAt >= found.decidedAt) found = decision;
    }
    return found;
  }

  private decisionReason(decision: LaneDecisionType): string {
    const failed = decision.signals.filter((signal) => signal.outcome !== 'pass');
    if (failed.length === 0) return `lane=${decision.lane} (score ${decision.score})`;
    return failed.map((signal) => `${signal.name}:${signal.reason}`).join(', ');
  }

  /** The event a unit state change implies — mirrors `eventForUnitState` in the real store. */
  private eventForState(row: UnitRow, target: UnitState, reason: string | null): EventPayload {
    switch (target) {
      case 'submitted':
        return {
          type: 'unit.submitted',
          unitId: row.unitId,
          specHash: row.specHash,
          slug: row.slug,
          revision: row.revision,
        };
      case 'qualified':
      case 'lit_parked':
      case 'rejected': {
        const decision = this.latestDecision(row.unitId);
        if (decision === null) {
          throw new FactoryError(
            'INTERNAL',
            `unit ${row.unitId} cannot move to '${target}' without a recorded lane decision`,
            { unitId: row.unitId, target },
          );
        }
        if (target === 'qualified') {
          return {
            type: 'unit.qualified',
            unitId: row.unitId,
            lane: 'dark',
            laneDecisionId: decision.decisionId,
            policyVersion: decision.policyVersion,
            score: decision.score,
          };
        }
        if (target === 'lit_parked') {
          return {
            type: 'unit.lit_parked',
            unitId: row.unitId,
            reason: reason ?? this.decisionReason(decision),
          };
        }
        return {
          type: 'unit.rejected',
          unitId: row.unitId,
          reason: reason ?? this.decisionReason(decision),
        };
      }
      case 'dispatched': {
        const attempt = [...this.attempts.values()]
          .filter((candidate) => candidate.unitId === row.unitId)
          .sort((a, b) => (a.startedAt < b.startedAt ? 1 : a.startedAt > b.startedAt ? -1 : 0))[0];
        if (attempt === undefined) {
          throw new FactoryError(
            'ATTEMPT_NOT_FOUND',
            `unit ${row.unitId} cannot be dispatched without an attempt`,
            {
              unitId: row.unitId,
            },
          );
        }
        if (row.currentMandateId === null) {
          throw new FactoryError('MANDATE_EXPIRED', `unit ${row.unitId} has no current mandate`, {
            unitId: row.unitId,
          });
        }
        const mandate = this.mandates.get(row.currentMandateId);
        if (mandate === undefined) {
          throw new FactoryError(
            'MANDATE_EXPIRED',
            `mandate ${row.currentMandateId} does not exist`,
            {
              mandateId: row.currentMandateId,
            },
          );
        }
        return {
          type: 'unit.dispatched',
          unitId: row.unitId,
          attemptId: attempt.attemptId,
          mandateId: row.currentMandateId,
          launchKey: attempt.launchKey,
        };
      }
      case 'receipted': {
        const receipt = this.latestReceipt(row.unitId);
        if (receipt === null) {
          throw new FactoryError(
            'INTERNAL',
            `unit ${row.unitId} cannot move to 'receipted' without a receipt`,
            {
              unitId: row.unitId,
            },
          );
        }
        return {
          type: 'attempt.receipted',
          unitId: row.unitId,
          attemptId: receipt.attemptId,
          receiptSha: receipt.receiptSha,
          exitCode: receipt.exitCode,
        };
      }
      case 'verified': {
        const verdict = this.latestVerdict(row.unitId);
        if (verdict === null) {
          throw new FactoryError(
            'VERDICT_MISSING',
            `unit ${row.unitId} cannot move to 'verified' without a verdict`,
            {
              unitId: row.unitId,
            },
          );
        }
        return {
          type: 'unit.verified',
          unitId: row.unitId,
          attemptId: verdict.attemptId,
          verdictId: verdict.verdictId,
          outcome: verdict.outcome,
        };
      }
      case 'promoted': {
        const promotion = [...this.promotions]
          .reverse()
          .find((candidate) => candidate.unitId === row.unitId);
        if (promotion === undefined) {
          throw new FactoryError(
            'VERDICT_MISSING',
            `unit ${row.unitId} cannot move to 'promoted'`,
            {
              unitId: row.unitId,
            },
          );
        }
        return {
          type: 'unit.promoted',
          unitId: row.unitId,
          verdictId: promotion.verdictId,
          promotionSha: promotion.promotionSha,
          signedBy: promotion.signedBy,
        };
      }
      case 'aborted':
        return {
          type: 'unit.aborted',
          unitId: row.unitId,
          reason: reason ?? 'aborted',
          observedAs: null,
        };
      case 'ambiguous': {
        const attempt = [...this.attempts.values()].find(
          (candidate) => candidate.unitId === row.unitId,
        );
        if (attempt === undefined) {
          throw new FactoryError(
            'ATTEMPT_NOT_FOUND',
            `unit ${row.unitId} cannot be ambiguous without an attempt`,
            {
              unitId: row.unitId,
            },
          );
        }
        return {
          type: 'attempt.ambiguous',
          unitId: row.unitId,
          attemptId: attempt.attemptId,
          // The real store cannot know the identity; it says so explicitly.
          observedAs: 'unobserved',
          reason: reason ?? 'ambiguous without a recorded reason',
        };
      }
    }
  }

  private latestReceipt(unitId: string): ReceiptRow | null {
    const rows = [...this.receipts.values()].filter((row) => row.unitId === unitId);
    if (rows.length === 0) return null;
    return rows[rows.length - 1] ?? null;
  }

  private latestVerdict(unitId: string): VerdictRow | null {
    const rows = [...this.verdicts.values()].filter((row) => row.unitId === unitId);
    if (rows.length === 0) return null;
    return rows[rows.length - 1] ?? null;
  }

  /** Test conveniences. */
  effectsInOrder(): EffectRow[] {
    return [...this.effects.values()];
  }
  eventsOfType<T extends EventPayload['type']>(type: T): Array<Extract<EventPayload, { type: T }>> {
    return this.ledger.filter(
      (event): event is Extract<EventPayload, { type: T }> => event.type === type,
    );
  }
  allUnits(): UnitRow[] {
    return [...this.units.values()];
  }
  allAttempts(): AttemptRow[] {
    return [...this.attempts.values()];
  }
  allLeases(): LeaseRow[] {
    return [...this.leases.values()];
  }

  // --------------------------------------------------------------- lifecycle

  close(): void {
    this.tick('close');
  }

  atomic<T>(fn: () => T): T {
    this.tick('atomic');
    if (this.depth > 0) return fn();
    const units = new Map(this.units);
    const mandates = new Map(this.mandates);
    const decisions = new Map(this.decisions);
    const leases = new Map(this.leases);
    const attempts = new Map(this.attempts);
    const receipts = new Map(this.receipts);
    const verdicts = new Map(this.verdicts);
    const effects = new Map(this.effects);
    const events = this.ledger.length;
    const spend = this.spend.length;
    const recoveryRuns = new Map(this.recoveryRuns);
    this.depth += 1;
    try {
      return fn();
    } catch (error) {
      // Rollback, like the real store: a failed command leaves no trace, because a
      // half-written dispatch is indistinguishable from a dispatched one.
      this.units.clear();
      for (const [key, value] of units) this.units.set(key, value);
      this.mandates.clear();
      for (const [key, value] of mandates) this.mandates.set(key, value);
      this.decisions.clear();
      for (const [key, value] of decisions) this.decisions.set(key, value);
      this.leases.clear();
      for (const [key, value] of leases) this.leases.set(key, value);
      this.attempts.clear();
      for (const [key, value] of attempts) this.attempts.set(key, value);
      this.receipts.clear();
      for (const [key, value] of receipts) this.receipts.set(key, value);
      this.verdicts.clear();
      for (const [key, value] of verdicts) this.verdicts.set(key, value);
      this.effects.clear();
      for (const [key, value] of effects) this.effects.set(key, value);
      this.recoveryRuns.clear();
      for (const [key, value] of recoveryRuns) this.recoveryRuns.set(key, value);
      this.ledger.length = events;
      this.spend.length = spend;
      throw error;
    } finally {
      this.depth -= 1;
    }
  }

  // ------------------------------------------------------------------ ledger

  appendEvent(event: EventPayload, options: AppendOptions): LedgerEvent {
    this.tick('appendEvent');
    this.assertWritable('appendEvent');
    return this.record(event, options);
  }

  /** A fake opens no files, so it never migrates; the seam exists because `Store` requires it. */
  migrationsApplied(): { from: number; to: number; note: string }[] {
    return [];
  }

  eventsSince(seq: number, limit?: number): LedgerEvent[] {
    this.tick('eventsSince');
    const slice =
      limit === undefined ? this.ledger.slice(seq) : this.ledger.slice(seq, seq + limit);
    return slice.map((payload, offset) => ({
      seq: seq + offset,
      eventId: `evt-${seq + offset + 1}`,
      type: payload.type,
      occurredAt: '1970-01-01T00:00:00.000Z',
      actor: 'unknown',
      traceId: 'unknown',
      payload: payload as unknown as Record<string, unknown>,
    }));
  }

  eventCount(): number {
    this.tick('eventCount');
    return this.ledger.length;
  }

  audit(): { ok: boolean; divergences: string[]; events: number } {
    this.tick('audit');
    return { ok: true, divergences: [], events: this.ledger.length };
  }

  isQuarantined(): boolean {
    this.tick('isQuarantined');
    return this.quarantined !== null;
  }

  quarantine(reason: string, actor: string, traceId: string): void {
    this.tick('quarantine');
    this.quarantined = reason;
    void actor;
    void traceId;
  }

  // ------------------------------------------------------------------- units

  getUnit(unitId: string): UnitRow | null {
    this.tick('getUnit');
    return this.units.get(unitId) ?? null;
  }

  findUnitBySlug(repo: string, slug: string, revision: number): UnitRow | null {
    this.tick('findUnitBySlug');
    for (const unit of this.units.values()) {
      if (unit.repo === repo && unit.slug === slug && unit.revision === revision) return unit;
    }
    return null;
  }

  findUnitBySpecHash(repo: string, specHash: string): UnitRow | null {
    this.tick('findUnitBySpecHash');
    for (const unit of this.units.values()) {
      if (unit.repo === repo && unit.specHash === specHash) return unit;
    }
    return null;
  }

  insertUnit(unit: UnitRow, options: AppendOptions): UnitRow {
    this.tick('insertUnit');
    this.assertWritable('insertUnit');
    const spec = UnitSpec.parse(unit.spec);
    if (contentHash(spec) !== unit.specHash) {
      throw new FactoryError(
        'SPEC_INVALID',
        `unit ${unit.unitId}: specHash does not match its spec`,
        {
          unitId: unit.unitId,
        },
      );
    }
    if (unit.state !== 'submitted') {
      throw new FactoryError(
        'SPEC_INVALID',
        `insertUnit creates a submitted unit, got '${unit.state}'`,
        {
          unitId: unit.unitId,
        },
      );
    }
    const existing = this.findUnitBySlug(unit.repo, unit.slug, unit.revision);
    if (existing !== null) {
      if (existing.specHash === unit.specHash) return existing;
      throw new FactoryError(
        'DUPLICATE_UNIT',
        `unit ${unit.repo}/${unit.slug}@${unit.revision} already exists`,
        {
          existingUnitId: existing.unitId,
        },
      );
    }
    const sameSpec = this.findUnitBySpecHash(unit.repo, unit.specHash);
    if (sameSpec !== null) {
      throw new FactoryError(
        'DUPLICATE_UNIT',
        `spec hash ${unit.specHash} is already unit ${sameSpec.unitId}`,
        {
          existingUnitId: sameSpec.unitId,
        },
      );
    }
    this.units.set(unit.unitId, unit);
    this.write(options, this.eventForState(unit, 'submitted', null));
    return unit;
  }

  setUnitState(
    unitId: string,
    state: UnitState,
    reason: string | null,
    options: AppendOptions,
  ): UnitRow {
    this.tick('setUnitState');
    this.assertWritable('setUnitState');
    const row = this.unit(unitId);
    const at = options.occurredAt ?? new Date().toISOString();
    if (isTerminal(row.state)) {
      throw new FactoryError(
        'UNIT_ALREADY_TERMINAL',
        `unit ${unitId} is already terminal (${row.state})`,
        {
          unitId,
          state: row.state,
        },
      );
    }
    if (row.state === state) return row;
    if (!canTransition(row.state, state)) {
      throw new FactoryError(
        'INTERNAL',
        `illegal unit transition ${row.state} → ${state} for ${unitId}`,
        {
          unitId,
          from: row.state,
          to: state,
        },
      );
    }
    const payload = this.eventForState(row, state, reason);
    const terminal = isTerminal(state);
    const updated = this.update(
      unitId,
      {
        state,
        terminalAt: terminal ? at : null,
        terminalReason: terminal
          ? (reason ?? (payload as { reason?: string }).reason ?? state)
          : null,
      },
      at,
    );
    this.write(options, payload);
    return updated;
  }

  setUnitLaneAndMandate(
    unitId: string,
    lane: 'dark' | 'lit' | 'reject',
    mandateId: string | null,
    options: AppendOptions,
  ): UnitRow {
    this.tick('setUnitLaneAndMandate');
    this.assertWritable('setUnitLaneAndMandate');
    const row = this.unit(unitId);
    if (isTerminal(row.state)) {
      throw new FactoryError(
        'UNIT_ALREADY_TERMINAL',
        `unit ${unitId} is already terminal (${row.state})`,
        {
          unitId,
          state: row.state,
        },
      );
    }
    const decision = this.latestDecision(unitId);
    if (decision === null) {
      throw new FactoryError('INTERNAL', `unit ${unitId} has no lane decision to route from`, {
        unitId,
        lane,
      });
    }
    const at = options.occurredAt ?? new Date().toISOString();
    if (lane === 'dark') {
      if (mandateId === null) {
        throw new FactoryError('INTERNAL', `lane 'dark' for unit ${unitId} requires a mandate id`, {
          unitId,
        });
      }
      const mandate = this.mandates.get(mandateId);
      if (mandate === undefined) {
        throw new FactoryError('MANDATE_EXPIRED', `mandate ${mandateId} does not exist`, {
          mandateId,
        });
      }
      if (mandate.revokedAt !== null || mandate.expiresAt <= at) {
        throw new FactoryError('MANDATE_EXPIRED', `mandate ${mandateId} is not usable at ${at}`, {
          mandateId,
        });
      }
      const updated = this.update(
        unitId,
        { lane: 'dark', currentMandateId: mandateId, state: 'qualified' },
        at,
      );
      this.write(options, {
        type: 'unit.qualified',
        unitId,
        lane: 'dark',
        laneDecisionId: decision.decisionId,
        policyVersion: decision.policyVersion,
        score: decision.score,
      });
      return updated;
    }
    if (mandateId !== null) {
      throw new FactoryError('INTERNAL', `lane '${lane}' must not mint mandate ${mandateId}`, {
        unitId,
        mandateId,
      });
    }
    const reason = this.decisionReason(decision);
    if (lane === 'lit') {
      const updated = this.update(
        unitId,
        {
          lane: 'lit',
          currentMandateId: null,
          state: 'lit_parked',
          terminalAt: at,
          terminalReason: reason,
        },
        at,
      );
      this.write(options, { type: 'unit.lit_parked', unitId, reason });
      return updated;
    }
    const updated = this.update(
      unitId,
      {
        lane: 'reject',
        currentMandateId: null,
        state: 'rejected',
        terminalAt: at,
        terminalReason: reason,
      },
      at,
    );
    this.write(options, { type: 'unit.rejected', unitId, reason });
    return updated;
  }

  incrementAttemptCount(unitId: string, options: AppendOptions): number {
    this.tick('incrementAttemptCount');
    this.assertWritable('incrementAttemptCount');
    const row = this.unit(unitId);
    const at = options.occurredAt ?? new Date().toISOString();
    const next = this.update(unitId, { attemptCount: row.attemptCount + 1 }, at);
    return next.attemptCount;
  }

  listUnits(filter?: {
    state?: UnitState;
    lane?: 'dark' | 'lit' | 'reject';
    limit?: number;
  }): UnitRow[] {
    this.tick('listUnits');
    let rows = [...this.units.values()];
    if (filter?.state !== undefined) rows = rows.filter((row) => row.state === filter.state);
    if (filter?.lane !== undefined) rows = rows.filter((row) => row.lane === filter.lane);
    if (filter?.limit !== undefined) rows = rows.slice(0, filter.limit);
    return rows;
  }

  countUnitsByState(): Record<UnitState, number> {
    this.tick('countUnitsByState');
    const out: Record<UnitState, number> = {
      submitted: 0,
      qualified: 0,
      lit_parked: 0,
      dispatched: 0,
      receipted: 0,
      verified: 0,
      promoted: 0,
      rejected: 0,
      aborted: 0,
      ambiguous: 0,
    };
    for (const state of ALL_STATES) {
      out[state] = [...this.units.values()].filter((row) => row.state === state).length;
    }
    return out;
  }

  // ---------------------------------------------------------------- mandates

  insertMandate(mandate: MandateRow): MandateRow {
    this.tick('insertMandate');
    this.assertWritable('insertMandate');
    this.unit(mandate.unitId);
    this.mandates.set(mandate.mandateId, mandate);
    return mandate;
  }

  getMandate(mandateId: string): MandateRow | null {
    this.tick('getMandate');
    return this.mandates.get(mandateId) ?? null;
  }

  revokeMandate(mandateId: string, at: string): void {
    this.tick('revokeMandate');
    this.assertWritable('revokeMandate');
    const mandate = this.mandates.get(mandateId);
    if (mandate === undefined) {
      throw new FactoryError('MANDATE_EXPIRED', `mandate ${mandateId} does not exist`, {
        mandateId,
      });
    }
    this.mandates.set(mandateId, { ...mandate, revokedAt: at });
  }

  // ---------------------------------------------------------- lane decisions

  insertLaneDecision(decision: LaneDecisionType & { decisionId: string }): void {
    this.tick('insertLaneDecision');
    this.assertWritable('insertLaneDecision');
    this.unit(decision.unitId);
    const key = `${decision.unitId}\u0000${decision.policyVersion}`;
    const existing = this.decisions.get(key);
    if (existing !== undefined) return; // same policy, same decision: idempotent
    this.decisions.set(key, decision);
  }

  getLaneDecision(
    unitId: string,
    policyVersion: string,
  ): (LaneDecisionType & { decisionId: string }) | null {
    this.tick('getLaneDecision');
    return this.decisions.get(`${unitId}\u0000${policyVersion}`) ?? null;
  }

  // ------------------------------------------------------------------ leases

  acquireLease(input: {
    leaseId: string;
    unitId: string;
    owner: string;
    acquiredAt: string;
    expiresAt: string;
  }): void {
    this.tick('acquireLease');
    this.assertWritable('acquireLease');
    this.unit(input.unitId);
    if (this.getLiveLease(input.unitId) !== null) {
      throw new FactoryError('LEASE_HELD', `unit ${input.unitId} already has a live lease`, {
        unitId: input.unitId,
        requestedLeaseId: input.leaseId,
      });
    }
    this.leases.set(input.leaseId, { ...input, releasedAt: null });
  }

  getLiveLease(unitId: string): { leaseId: string; owner: string; expiresAt: string } | null {
    this.tick('getLiveLease');
    for (const lease of this.leases.values()) {
      if (lease.unitId === unitId && lease.releasedAt === null) {
        return { leaseId: lease.leaseId, owner: lease.owner, expiresAt: lease.expiresAt };
      }
    }
    return null;
  }

  releaseLease(leaseId: string, at: string): void {
    this.tick('releaseLease');
    this.assertWritable('releaseLease');
    const lease = this.leases.get(leaseId);
    if (lease === undefined) {
      throw new FactoryError('INTERNAL', `lease ${leaseId} does not exist; nothing to release`, {
        leaseId,
      });
    }
    if (lease.releasedAt === null) this.leases.set(leaseId, { ...lease, releasedAt: at });
  }

  listExpiredLeases(now: string): Array<{ leaseId: string; unitId: string; expiresAt: string }> {
    this.tick('listExpiredLeases');
    return [...this.leases.values()]
      .filter((lease) => lease.releasedAt === null && lease.expiresAt <= now)
      .map((lease) => ({
        leaseId: lease.leaseId,
        unitId: lease.unitId,
        expiresAt: lease.expiresAt,
      }));
  }

  // ---------------------------------------------------------------- attempts

  insertAttempt(attempt: AttemptRow): AttemptRow {
    this.tick('insertAttempt');
    this.assertWritable('insertAttempt');
    this.unit(attempt.unitId);
    if (!this.leases.has(attempt.leaseId)) {
      throw new FactoryError(
        'INTERNAL',
        `attempt ${attempt.attemptId} names lease ${attempt.leaseId}, which does not exist`,
        {
          attemptId: attempt.attemptId,
          leaseId: attempt.leaseId,
        },
      );
    }
    for (const existing of this.attempts.values()) {
      if (existing.launchKey === attempt.launchKey) return existing; // idempotent by launch key
    }
    this.attempts.set(attempt.attemptId, attempt);
    return attempt;
  }

  getAttempt(attemptId: string): AttemptRow | null {
    this.tick('getAttempt');
    return this.attempts.get(attemptId) ?? null;
  }

  setAttemptState(
    attemptId: string,
    state: AttemptRow['state'],
    patch: { endedAt?: string | null; exitCode?: number | null; sessionId?: string | null },
  ): AttemptRow {
    this.tick('setAttemptState');
    this.assertWritable('setAttemptState');
    const current = this.attempt(attemptId);
    const endedDefault =
      state === 'aborted' || state === 'ambiguous' || state === 'produced-receipt';
    const next: AttemptRow = {
      ...current,
      state,
      endedAt:
        patch.endedAt === undefined
          ? endedDefault
            ? (current.endedAt ?? new Date().toISOString())
            : current.endedAt
          : patch.endedAt,
      exitCode: patch.exitCode === undefined ? current.exitCode : patch.exitCode,
      sessionId: patch.sessionId === undefined ? current.sessionId : patch.sessionId,
    };
    this.attempts.set(attemptId, next);
    return next;
  }

  listActiveAttempts(): AttemptRow[] {
    this.tick('listActiveAttempts');
    return [...this.attempts.values()].filter(
      (attempt) =>
        attempt.state === 'planned' || attempt.state === 'launching' || attempt.state === 'running',
    );
  }

  listAttemptsForUnit(unitId: string): AttemptRow[] {
    this.tick('listAttemptsForUnit');
    return [...this.attempts.values()].filter((attempt) => attempt.unitId === unitId);
  }

  // ---------------------------------------------------------------- receipts

  insertReceipt(row: ReceiptRow, options: AppendOptions): ReceiptRow {
    this.tick('insertReceipt');
    this.assertWritable('insertReceipt');
    const unit = this.unit(row.unitId);
    this.attempt(row.attemptId);
    const body = WorkerReceipt.parse(row.receipt);
    // Faithful: the real store recomputes the hash and refuses a disagreement.
    if (receiptShaFor(body) !== row.receiptSha) {
      throw new FactoryError('INTERNAL', `receipt ${row.receiptId} disagrees with its own hash`, {
        receiptId: row.receiptId,
      });
    }
    if (body.unitId !== row.unitId || body.attemptId !== row.attemptId) {
      throw new FactoryError('INTERNAL', `receipt ${row.receiptId} describes another attempt`, {
        receiptId: row.receiptId,
      });
    }
    for (const existing of this.receipts.values()) {
      if (existing.receiptSha === row.receiptSha) {
        throw new FactoryError(
          'RECEIPT_CONFLICT',
          `receipt ${row.receiptSha} is already recorded`,
          {
            receiptSha: row.receiptSha,
            existingReceiptId: existing.receiptId,
          },
        );
      }
    }
    this.receipts.set(row.receiptId, row);
    const next = stateAfter(unit.state, 'receipted');
    if (next !== unit.state) this.update(row.unitId, { state: next }, row.recordedAt);
    this.write(options, {
      type: 'attempt.receipted',
      unitId: row.unitId,
      attemptId: row.attemptId,
      receiptSha: row.receiptSha,
      exitCode: row.exitCode,
    });
    return row;
  }

  getReceiptBySha(receiptSha: string): ReceiptRow | null {
    this.tick('getReceiptBySha');
    for (const receipt of this.receipts.values()) {
      if (receipt.receiptSha === receiptSha) return receipt;
    }
    return null;
  }

  latestReceiptForUnit(unitId: string): ReceiptRow | null {
    this.tick('latestReceiptForUnit');
    return this.latestReceipt(unitId);
  }

  // ---------------------------------------------------------------- verdicts

  insertVerdict(row: VerdictRow, options: AppendOptions): VerdictRow {
    this.tick('insertVerdict');
    this.assertWritable('insertVerdict');
    const unit = this.unit(row.unitId);
    this.attempt(row.attemptId);
    const verdict = Verdict.parse(row.verdict);
    if (row.outcome !== verdict.outcome) {
      throw new FactoryError(
        'INTERNAL',
        `verdict ${row.verdictId}: outcome disagrees with its body`,
        {
          verdictId: row.verdictId,
        },
      );
    }
    if (row.receiptId !== null) {
      const receipt = this.receipts.get(row.receiptId);
      if (receipt === undefined) {
        throw new FactoryError(
          'INTERNAL',
          `verdict ${row.verdictId} cites a receipt that does not exist`,
          {
            verdictId: row.verdictId,
          },
        );
      }
      if (receipt.receiptSha !== verdict.receiptSha) {
        throw new FactoryError(
          'INTERNAL',
          `verdict ${row.verdictId} cites a receipt with another sha`,
          {
            verdictId: row.verdictId,
          },
        );
      }
    }
    assertVerdictIsEarned(verdict);
    this.verdicts.set(row.verdictId, row);
    // Evidence first, state change second — the real store's rule since the fail
    // verdict became a legal rejection: a measured failure rejects the unit, and
    // `unknown` records the verdict without moving anything at all.
    if (row.outcome === 'pass' && canTransition(unit.state, 'verified')) {
      this.update(row.unitId, { state: 'verified' }, row.evaluatedAt);
      this.write(options, {
        type: 'unit.verified',
        unitId: row.unitId,
        attemptId: row.attemptId,
        verdictId: row.verdictId,
        outcome: 'pass',
      });
    } else if (row.outcome === 'fail' && canTransition(unit.state, 'rejected')) {
      const reason = verdict.reasons.join(',');
      this.update(
        row.unitId,
        { state: 'rejected', terminalAt: row.evaluatedAt, terminalReason: reason },
        row.evaluatedAt,
      );
      this.write(options, { type: 'unit.rejected', unitId: row.unitId, reason });
    }
    return row;
  }

  latestVerdictForUnit(unitId: string): VerdictRow | null {
    this.tick('latestVerdictForUnit');
    return this.latestVerdict(unitId);
  }

  getVerdict(verdictId: string): VerdictRow | null {
    this.tick('getVerdict');
    return this.verdicts.get(verdictId) ?? null;
  }

  // -------------------------------------------------------------- promotions

  insertPromotion(row: PromotionRow): void {
    this.tick('insertPromotion');
    this.assertWritable('insertPromotion');
    this.unit(row.unitId);
    this.promotions.push(row);
  }

  getPromotion(unitId: string, verdictSha: string): { promotionId: string } | null {
    this.tick('getPromotion');
    const row = this.promotions.find(
      (promotion) => promotion.unitId === unitId && promotion.verdictSha === verdictSha,
    );
    return row === undefined ? null : { promotionId: row.promotionId };
  }

  // ------------------------------------------------------------------- spend

  reserveSpend(row: {
    spendId: string;
    unitId: string;
    attemptId: string | null;
    amountUsd: number;
    recordedAt: string;
  }): void {
    this.tick('reserveSpend');
    this.assertWritable('reserveSpend');
    this.unit(row.unitId);
    if (row.attemptId !== null) this.attempt(row.attemptId);
    this.spend.push({ ...row, kind: 'reserved' });
    // The real store appends the reservation event itself, naming the attempt (or
    // saying it is unattributed); the fake must do the same or a test would miss
    // the fact that a dispatch reserved money.
    this.write(
      { actor: 'control', traceId: row.spendId, occurredAt: row.recordedAt },
      {
        type: 'spend.reserved',
        unitId: row.unitId,
        attemptId: row.attemptId ?? 'unattributed',
        amountUsd: row.amountUsd,
        kind: 'estimate',
      },
    );
  }

  recordSpend(row: {
    spendId: string;
    unitId: string;
    attemptId: string | null;
    kind: 'estimate' | 'measured' | 'unknown';
    amountUsd: number | null;
    recordedAt: string;
  }): void {
    this.tick('recordSpend');
    this.assertWritable('recordSpend');
    this.unit(row.unitId);
    this.spend.push(row);
  }

  spendForUnit(unitId: string): { reservedUsd: number; recordedUsd: number; unknownRows: number } {
    this.tick('spendForUnit');
    let reservedUsd = 0;
    let recordedUsd = 0;
    let unknownRows = 0;
    for (const row of this.spend) {
      if (row.unitId !== unitId) continue;
      if (row.kind === 'reserved') reservedUsd += row.amountUsd ?? 0;
      else if (row.kind === 'estimate' || row.kind === 'measured')
        recordedUsd += row.amountUsd ?? 0;
      else if (row.kind === 'unknown' || row.amountUsd === null) unknownRows += 1;
    }
    return { reservedUsd, recordedUsd, unknownRows };
  }

  // ------------------------------------------------------- metered usage (ND3)
  // Mechanical mirror of the real store's four methods. `recordUsage` computes the digest the
  // same way (`sha256` over the row) because a fake whose digest disagreed with the real one
  // would let a spec pass that proves nothing.

  recordUsage(row: {
    usageId: string;
    unitId: string;
    attemptId: string;
    tokensIn: number;
    tokensOut: number;
    costUsd: number | null;
    gatewayRequestId: string | null;
    signedAt: string;
    ceilingCrossed: boolean;
  }): UsageRowLike {
    this.tick('recordUsage');
    this.assertWritable('recordUsage');
    this.unit(row.unitId);
    this.attempt(row.attemptId);
    const recordSha = `sha256:${createHash('sha256')
      .update(JSON.stringify([row.usageId, row.tokensIn, row.tokensOut, row.costUsd]))
      .digest('hex')}`;
    const stored: UsageRowLike = { ...row, recordSha };
    this.usage.push(stored);
    return stored;
  }

  usageForAttempt(attemptId: string): readonly UsageRowLike[] {
    this.tick('usageForAttempt');
    return this.usage.filter((row) => row.attemptId === attemptId);
  }

  listUsage(): readonly UsageRowLike[] {
    this.tick('listUsage');
    return [...this.usage];
  }

  usageForUnit(unitId: string): {
    tokensIn: number;
    tokensOut: number;
    costUsd: number;
    unpricedRows: number;
    rows: number;
    ceilingCrossed: boolean;
  } {
    this.tick('usageForUnit');
    const rows = this.usage.filter((row) => row.unitId === unitId);
    let tokensIn = 0;
    let tokensOut = 0;
    let costUsd = 0;
    let unpricedRows = 0;
    let ceilingCrossed = false;
    for (const row of rows) {
      tokensIn += row.tokensIn;
      tokensOut += row.tokensOut;
      if (row.costUsd === null) unpricedRows += 1;
      else costUsd += row.costUsd;
      if (row.ceilingCrossed) ceilingCrossed = true;
    }
    return { tokensIn, tokensOut, costUsd, unpricedRows, rows: rows.length, ceilingCrossed };
  }

  // ------------------------------------------------- privileged decisions (R5)

  /**
   * The one-use marker, with the same rule as the real store: the *insert* is the check, so a
   * second caller loses. Kept here because the interface grew and a fake that silently lacks the
   * refusal would let an engine test believe a decision can be spent twice.
   */
  private readonly consumedDecisions = new Set<string>();

  isDecisionConsumed(decisionId: string): boolean {
    this.tick('isDecisionConsumed');
    return this.consumedDecisions.has(decisionId);
  }

  recordDecisionConsumed(decisionId: string, _options: AppendOptions): boolean {
    this.tick('recordDecisionConsumed');
    this.assertWritable('recordDecisionConsumed');
    if (this.consumedDecisions.has(decisionId)) return false;
    this.consumedDecisions.add(decisionId);
    return true;
  }

  // --------------------------------------------------------------- envelopes

  currentEnvelope(scope: 'per-unit' | 'daily'): { envelopeId: string; amountUsd: number } | null {
    this.tick('currentEnvelope');
    const rows = this.envelopes.filter((row) => row.scope === scope);
    const last = rows[rows.length - 1];
    return last === undefined ? null : { envelopeId: last.envelopeId, amountUsd: last.amountUsd };
  }

  raiseEnvelope(row: {
    envelopeId: string;
    scope: 'per-unit' | 'daily';
    amountUsd: number;
    effectiveFrom: string;
    supersedes: string | null;
    signedBy: string;
    reason: string;
  }): void {
    this.tick('raiseEnvelope');
    this.assertWritable('raiseEnvelope');
    this.envelopes.push(row);
  }

  // ------------------------------------------------------------- credentials

  insertCredential(row: {
    grantId: string;
    repo: string;
    ttlSeconds: number;
    issuedBy: string;
    issuedAt: string;
    expiresAt: string;
  }): void {
    this.tick('insertCredential');
    this.assertWritable('insertCredential');
    this.credentials.set(row.grantId, { ...row, revokedAt: null });
  }

  revokeCredential(grantId: string, at: string): void {
    this.tick('revokeCredential');
    this.assertWritable('revokeCredential');
    const row = this.credentials.get(grantId);
    if (row === undefined) {
      throw new FactoryError('INTERNAL', `credential ${grantId} does not exist`, { grantId });
    }
    this.credentials.set(grantId, { ...row, revokedAt: at });
  }

  // ----------------------------------------------------------------- effects

  enqueueEffect(row: {
    effectId: string;
    idempotencyKey: string;
    kind: string;
    payload: unknown;
    createdAt: string;
  }): EffectRow {
    this.tick('enqueueEffect');
    this.assertWritable('enqueueEffect');
    const existing = this.getEffectByKey(row.idempotencyKey);
    if (existing !== null) return existing;
    const effect: EffectRow = {
      effectId: row.effectId,
      idempotencyKey: row.idempotencyKey,
      kind: row.kind,
      payload: row.payload,
      state: 'pending',
      attempts: 0,
      createdAt: row.createdAt,
      appliedAt: null,
      lastError: null,
    };
    this.effects.set(row.effectId, effect);
    return effect;
  }

  getEffectByKey(idempotencyKey: string): EffectRow | null {
    this.tick('getEffectByKey');
    for (const effect of this.effects.values()) {
      if (effect.idempotencyKey === idempotencyKey) return effect;
    }
    return null;
  }

  claimPendingEffects(limit: number): EffectRow[] {
    this.tick('claimPendingEffects');
    return [...this.effects.values()]
      .filter((effect) => effect.state === 'pending')
      .slice(0, limit);
  }

  markEffectApplied(effectId: string, at: string): void {
    this.tick('markEffectApplied');
    this.assertWritable('markEffectApplied');
    const effect = this.effects.get(effectId);
    if (effect === undefined) {
      throw new FactoryError('INTERNAL', `effect ${effectId} does not exist`, { effectId });
    }
    this.effects.set(effectId, { ...effect, state: 'applied', appliedAt: at });
  }

  recordEffectFailure(effectId: string, error: string): EffectRow {
    this.tick('recordEffectFailure');
    this.assertWritable('recordEffectFailure');
    const effect = this.effects.get(effectId);
    if (effect === undefined) {
      throw new FactoryError('INTERNAL', `effect ${effectId} does not exist`, { effectId });
    }
    const next: EffectRow = { ...effect, attempts: effect.attempts + 1, lastError: error };
    this.effects.set(effectId, next);
    return next;
  }

  markEffectExhausted(effectId: string, error: string): void {
    this.tick('markEffectExhausted');
    this.assertWritable('markEffectExhausted');
    const effect = this.effects.get(effectId);
    if (effect === undefined) {
      throw new FactoryError('INTERNAL', `effect ${effectId} does not exist`, { effectId });
    }
    this.effects.set(effectId, {
      ...effect,
      state: 'failed',
      attempts: effect.attempts + 1,
      lastError: error,
    });
  }

  // ---------------------------------------------------------------- recovery

  insertRecoveryRun(row: { recoveryRunId: string; startedAt: string }): void {
    this.tick('insertRecoveryRun');
    this.assertWritable('insertRecoveryRun');
    this.recoveryRuns.set(row.recoveryRunId, {
      recoveryRunId: row.recoveryRunId,
      startedAt: row.startedAt,
      completedAt: null,
      orphanedAttempts: 0,
      ambiguous: 0,
    });
  }

  completeRecoveryRun(
    recoveryRunId: string,
    at: string,
    counts: { orphanedAttempts: number; ambiguous: number },
  ): void {
    this.tick('completeRecoveryRun');
    this.assertWritable('completeRecoveryRun');
    const row = this.recoveryRuns.get(recoveryRunId);
    if (row === undefined) {
      throw new FactoryError('INTERNAL', `recovery run ${recoveryRunId} does not exist`, {
        recoveryRunId,
      });
    }
    this.recoveryRuns.set(recoveryRunId, {
      ...row,
      completedAt: at,
      orphanedAttempts: counts.orphanedAttempts,
      ambiguous: counts.ambiguous,
    });
  }

  recoveryRun(recoveryRunId: string): RecoveryRunRow | null {
    return this.recoveryRuns.get(recoveryRunId) ?? null;
  }

  // ------------------------------------------------------------------ ledger

  private write(options: AppendOptions, payload: EventPayload): void {
    // Every mutation is transactional with its event — in the fake, the event list
    // is the transaction log the tests read.
    this.record(payload, options);
  }

  private record(payload: EventPayload, options: AppendOptions): LedgerEvent {
    // Payloads are validated against the contract exactly as the real store does,
    // so a test cannot pass by appending an event the ledger would refuse.
    const parsed = EventPayload.parse(payload);
    const seq = this.seq;
    this.seq += 1;
    this.ledger.push(parsed);
    return {
      seq,
      eventId: `evt-${seq + 1}`,
      type: parsed.type,
      occurredAt: options.occurredAt ?? new Date().toISOString(),
      actor: options.actor,
      traceId: options.traceId,
      payload: parsed as unknown as Record<string, unknown>,
    };
  }
}
