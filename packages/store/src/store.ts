/**
 * The durable store: one SQLite file, one writer, an append-only ledger and
 * aggregates that are only ever projections of it.
 *
 * Three rules shape every method here, and each one is tested:
 *
 *  1. **A mutation and its ledger event share one transaction.** There is no
 *     path that changes an aggregate without the event that explains it, and no
 *     path that writes an event for a change that did not happen.
 *  2. **A quarantined store refuses every write.** The check runs before any
 *     SQL, so a refusal cannot leave a half-written row behind.
 *  3. **Unknown does not become pass.** A verdict that claims `pass` without a
 *     receipt, a holdout revision and a measured Δ is refused here — and the
 *     schema refuses it again, so a future refactor cannot remove the check.
 *
 * Timestamps are ISO-8601 UTC strings supplied by an injectable clock; nothing
 * in a method body reads the wall clock directly, so replay and tests are
 * deterministic.
 */
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';

import {
  FactoryError,
  canonicalJson,
  contentHash,
  sha256Hex,
  EventPayload,
  UnitSpec,
  Verdict,
  WorkerReceipt,
  assertVerdictIsEarned,
  isTerminal,
  canTransition,
  receiptShaFor,
} from '@factory/contracts';
import type {
  EventType,
  LaneDecisionType,
  LedgerEvent,
  UnitState,
  VerdictType,
  WorkerReceiptType,
} from '@factory/contracts';

import { openSqlite } from './driver.ts';
import type { SqliteDriver, SqliteStatement } from './driver.ts';
import { migrationPath, SCHEMA_SQL, SCHEMA_VERSION } from './schema.ts';
import type {
  AppendOptions,
  AttemptRow,
  EffectRow,
  MandateRow,
  ReceiptRow,
  Store,
  UnitRow,
  UsageRow,
  VerdictRow,
} from './types.ts';

export interface OpenStoreOptions {
  /** Directory that holds `factory.db`. `:memory:` is refused: WAL requires a file. */
  readonly dir: string;
  /** Injected clock. Absent → real time, read once per call and never inside a method body. */
  readonly now?: () => Date;
}

const UNATTRIBUTED_ATTEMPT = 'unattributed';
/** What the store can honestly say about an attempt it could not observe. */
const UNOBSERVED = 'unobserved';

// ---------------------------------------------------------------- database rows

interface UnitDbRow {
  unit_id: string;
  slug: string;
  revision: number;
  repo: string;
  base_rev: string;
  spec_hash: string;
  spec_json: string;
  state: UnitState;
  lane: 'dark' | 'lit' | 'reject' | null;
  current_mandate_id: string | null;
  attempt_count: number;
  created_at: string;
  updated_at: string;
  terminal_at: string | null;
  terminal_reason: string | null;
}

interface MandateDbRow {
  mandate_id: string;
  unit_id: string;
  policy_version: string;
  lane: 'dark' | 'lit';
  budget_usd: number;
  issued_at: string;
  expires_at: string;
  revoked_at: string | null;
}

interface LaneDecisionDbRow {
  decision_id: string;
  unit_id: string;
  lane: 'dark' | 'lit' | 'reject';
  score: number;
  policy_version: string;
  signals_json: string;
  reasons_json: string;
  mandate_id: string | null;
  decided_at: string;
}

interface LeaseDbRow {
  lease_id: string;
  unit_id: string;
  owner: string;
  acquired_at: string;
  expires_at: string;
  released_at: string | null;
}

interface AttemptDbRow {
  attempt_id: string;
  unit_id: string;
  lease_id: string;
  state: AttemptRow['state'];
  launch_key: string;
  session_id: string | null;
  attempt_dir: string;
  started_at: string;
  ended_at: string | null;
  exit_code: number | null;
}

interface ReceiptDbRow {
  receipt_id: string;
  unit_id: string;
  attempt_id: string;
  receipt_sha: string;
  session_id: string;
  exit_code: number | null;
  started_at: string;
  ended_at: string;
  receipt_json: string;
  recorded_at: string;
}

interface VerdictDbRow {
  verdict_id: string;
  unit_id: string;
  attempt_id: string;
  receipt_id: string | null;
  receipt_sha: string | null;
  holdout_revision: string | null;
  policy_version: string;
  wall_version: string;
  outcome: 'pass' | 'fail' | 'unknown';
  delta_checked: number;
  delta_observed: number | null;
  reasons_json: string;
  scenarios_json: string;
  delta_json: string;
  evaluated_at: string;
}

interface EffectDbRow {
  effect_id: string;
  idempotency_key: string;
  kind: string;
  payload_json: string;
  state: EffectRow['state'];
  attempts: number;
  created_at: string;
  applied_at: string | null;
  last_error: string | null;
}

interface EventDbRow {
  seq: number;
  event_id: string;
  type: string;
  occurred_at: string;
  actor: string;
  trace_id: string;
  payload: string;
}

interface CountRow {
  n: number;
}

interface SeqRow {
  seq: number;
}

// ------------------------------------------------------------------- helpers

function describeZodError(error: unknown): string {
  const issues = (
    error as { issues?: ReadonlyArray<{ path: ReadonlyArray<PropertyKey>; message: string }> }
  ).issues;
  if (!issues || issues.length === 0) return error instanceof Error ? error.message : String(error);
  return issues.map((i) => `${i.path.map(String).join('.') || '<root>'}: ${i.message}`).join('; ');
}

function isConstraintError(error: unknown): boolean {
  return error instanceof Error && /SQLITE_CONSTRAINT|constraint failed/i.test(error.message);
}

function isUniqueError(error: unknown): boolean {
  return error instanceof Error && /UNIQUE constraint failed/i.test(error.message);
}

/** Event payloads are `Record<string, unknown>` on the ledger; replay reads fields by name. */
function payloadString(payload: Record<string, unknown>, key: string): string | null {
  const value = payload[key];
  return typeof value === 'string' ? value : null;
}

/**
 * A mutation may move a unit to the state its own event implies, but a terminal
 * unit never moves again — the ledger then reads as history, not as a plan.
 * Writers and `audit` replay both use this rule, which is what keeps them equal.
 */
function stateAfter(current: UnitState, target: UnitState): UnitState {
  return isTerminal(current) ? current : target;
}

const ALL_UNIT_STATES: readonly UnitState[] = [
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

// ------------------------------------------------------------------ openStore

interface UsageRecordRowRow {
  usage_id: string;
  unit_id: string;
  attempt_id: string;
  tokens_in: number;
  tokens_out: number;
  cost_usd: number | null;
  gateway_request_id: string | null;
  signed_at: string;
  record_sha: string;
  ceiling_crossed: number;
}

function usageFromRow(row: UsageRecordRowRow): UsageRow {
  return {
    usageId: row.usage_id,
    unitId: row.unit_id,
    attemptId: row.attempt_id,
    tokensIn: row.tokens_in,
    tokensOut: row.tokens_out,
    costUsd: row.cost_usd === null ? null : Number(row.cost_usd),
    gatewayRequestId: row.gateway_request_id,
    signedAt: row.signed_at,
    recordSha: row.record_sha,
    ceilingCrossed: row.ceiling_crossed === 1,
  };
}

export function openStore(options: OpenStoreOptions): Store {
  if (options.dir === ':memory:') {
    throw new FactoryError(
      'INTERNAL',
      'openStore: :memory: is not supported — WAL and crash-durability require a file; use a temp dir',
    );
  }
  mkdirSync(options.dir, { recursive: true });
  const location = join(options.dir, 'factory.db');

  const clock = options.now ?? ((): Date => new Date());
  const now = (): string => clock().toISOString();

  const driver: SqliteDriver = openSqlite({ path: location });
  driver.exec(SCHEMA_SQL);

  const cache = new Map<string, SqliteStatement>();
  const stmt = (text: string): SqliteStatement => {
    const cached = cache.get(text);
    if (cached) return cached;
    const prepared = driver.prepare(text);
    cache.set(text, prepared);
    return prepared;
  };

  let depth = 0;

  function inTransaction<T>(fn: () => T): T {
    if (depth > 0) return fn();
    return driver.transaction(() => {
      depth += 1;
      try {
        return fn();
      } finally {
        depth -= 1;
      }
    });
  }

  // ------------------------------------------------------------ schema migration

  const schemaChecksum = sha256Hex(SCHEMA_SQL);
  const migrationsApplied: { from: number; to: number; note: string }[] = [];
  inTransaction(() => {
    const rows = stmt(
      'SELECT version, checksum FROM schema_migration ORDER BY version DESC LIMIT 1',
    ).all<{
      version: number;
      checksum: string;
    }>();
    const existing = rows[0];
    if (!existing) {
      stmt('INSERT INTO schema_migration (version, applied_at, checksum) VALUES (?, ?, ?)').run(
        SCHEMA_VERSION,
        now(),
        schemaChecksum,
      );
      return;
    }
    if (existing.version !== SCHEMA_VERSION) {
      // A declared, additive path is applied here; anything else is a refusal. This is the one place
      // the store rewrites its own metadata, so it says exactly what it did in the ledger afterwards.
      const path = migrationPath(existing.version);
      if (path === null) {
        throw new FactoryError(
          'INTERNAL',
          `store: ${location} is at schema version ${existing.version}; this binary expects ${SCHEMA_VERSION} and ` +
            'declares no migration from there — refusing to open across a schema change (migrate explicitly, do not guess)',
          { location, foundVersion: existing.version, expectedVersion: SCHEMA_VERSION },
        );
      }
      for (const step of path) {
        for (const statement of step.statements) stmt(statement).run();
        stmt('INSERT INTO schema_migration (version, applied_at, checksum) VALUES (?, ?, ?)').run(
          step.to,
          now(),
          // The current binary's checksum, not the step's: this row asserts "this store now
          // conforms to SCHEMA_SQL", which is what the next open compares against.
          step.to === SCHEMA_VERSION ? schemaChecksum : sha256Hex(step.statements.join('\n')),
        );
        migrationsApplied.push({ from: step.from, to: step.to, note: step.note });
      }
      // The drift check below is for a store already at this version; a just-migrated store has
      // nothing to compare yet.
      return;
    }
    if (existing.checksum !== schemaChecksum) {
      throw new FactoryError(
        'INTERNAL',
        `store: schema drift in ${location} — recorded checksum ${existing.checksum} does not match this ` +
          `binary's SCHEMA_SQL (${schemaChecksum}); refusing to run against a schema that changed underneath it`,
        { location, recorded: existing.checksum, expected: schemaChecksum },
      );
    }
  });

  // A migration is a change to the shape of history, so it goes on the ledger like any other fact:
  // one event per step, written after the DDL committed. A reader can therefore tell a store that was
  // opened fresh from one that was upgraded, without trusting a comment in a changelog.
  for (const step of migrationsApplied) {
    writeEvent(
      { type: 'store.migrated', from: step.from, to: step.to, note: step.note },
      { actor: 'store', traceId: `migration:v${String(step.from)}-v${String(step.to)}` },
    );
  }

  // ---------------------------------------------------------------- quarantine

  function quarantineReason(): string | null {
    const row = stmt("SELECT value FROM store_state WHERE key = 'quarantined'").get<{
      value: string;
    }>();
    return row ? row.value : null;
  }

  function assertWritable(operation: string): void {
    const reason = quarantineReason();
    if (reason !== null) {
      throw new FactoryError(
        'STORE_QUARANTINED',
        `store is quarantined (${reason}): refusing ${operation}. Reads still work; inspect with a read-only ` +
          'handle and never write to a quarantined store',
        { operation, reason, location },
      );
    }
  }

  function mutate<T>(operation: string, fn: () => T): T {
    assertWritable(operation);
    return inTransaction(fn);
  }

  // -------------------------------------------------------------------- ledger

  function writeEvent(payload: EventPayload, opts: AppendOptions): LedgerEvent {
    let parsed: EventPayload;
    try {
      parsed = EventPayload.parse(payload);
    } catch (error) {
      throw new FactoryError(
        'INTERNAL',
        `ledger: refusing to append a malformed ${String((payload as { type?: unknown }).type)} event ` +
          `(${describeZodError(error)}) — a payload the contract cannot parse is not evidence`,
        { payloadType: (payload as { type?: unknown }).type },
      );
    }
    const occurredAt = opts.occurredAt ?? now();
    const body = canonicalJson(parsed);
    // `events` is append-only, so `event_id` cannot be patched in after the insert
    // (the trigger would refuse it). The sequence is therefore reserved first,
    // inside this transaction — with a single writer, MAX(seq)+1 is race-free.
    const next = stmt('SELECT COALESCE(MAX(seq), 0) + 1 AS seq FROM events').get<SeqRow>();
    const seq = Number(next?.seq ?? 1);
    const eventId = `evt_${seq}_${sha256Hex(`${seq}:${parsed.type}:${opts.traceId}`).slice(0, 8)}`;
    stmt(
      'INSERT INTO events (seq, event_id, type, occurred_at, actor, trace_id, payload) VALUES (?, ?, ?, ?, ?, ?, ?)',
    ).run(seq, eventId, parsed.type, occurredAt, opts.actor, opts.traceId, body);
    return {
      seq,
      eventId,
      type: parsed.type,
      occurredAt,
      actor: opts.actor,
      traceId: opts.traceId,
      payload: parsed as unknown as Record<string, unknown>,
    };
  }

  function mapEvent(row: EventDbRow): LedgerEvent {
    return {
      seq: Number(row.seq),
      eventId: row.event_id,
      type: row.type as EventType,
      occurredAt: row.occurred_at,
      actor: row.actor,
      traceId: row.trace_id,
      payload: JSON.parse(row.payload) as Record<string, unknown>,
    };
  }

  // ---------------------------------------------------------------- unit mapping

  function mapUnit(row: UnitDbRow): UnitRow {
    return {
      unitId: row.unit_id,
      slug: row.slug,
      revision: Number(row.revision),
      repo: row.repo,
      baseRev: row.base_rev,
      specHash: row.spec_hash,
      spec: JSON.parse(row.spec_json) as UnitRow['spec'],
      state: row.state,
      lane: row.lane,
      currentMandateId: row.current_mandate_id,
      attemptCount: Number(row.attempt_count),
      createdAt: row.created_at,
      updatedAt: row.updated_at,
      terminalAt: row.terminal_at,
      terminalReason: row.terminal_reason,
    };
  }

  function requireUnit(unitId: string): UnitRow {
    const row = stmt('SELECT * FROM units WHERE unit_id = ?').get<UnitDbRow>(unitId);
    if (!row) {
      throw new FactoryError('UNIT_NOT_FOUND', `unit ${unitId} does not exist in ${location}`, {
        unitId,
      });
    }
    return mapUnit(row);
  }

  function requireAttempt(attemptId: string): AttemptRow {
    const row = stmt('SELECT * FROM attempts WHERE attempt_id = ?').get<AttemptDbRow>(attemptId);
    if (!row) {
      throw new FactoryError(
        'ATTEMPT_NOT_FOUND',
        `attempt ${attemptId} does not exist in ${location}`,
        {
          attemptId,
        },
      );
    }
    return mapAttempt(row);
  }

  function mapAttempt(row: AttemptDbRow): AttemptRow {
    return {
      attemptId: row.attempt_id,
      unitId: row.unit_id,
      leaseId: row.lease_id,
      state: row.state,
      launchKey: row.launch_key,
      sessionId: row.session_id,
      attemptDir: row.attempt_dir,
      startedAt: row.started_at,
      endedAt: row.ended_at,
      exitCode: row.exit_code === null ? null : Number(row.exit_code),
    };
  }

  function updateUnit(
    unitId: string,
    patch: {
      state?: UnitState;
      lane?: 'dark' | 'lit' | 'reject' | null;
      mandateId?: string | null;
      terminalAt?: string | null;
      terminalReason?: string | null;
      attemptCount?: number;
    },
    at: string,
  ): UnitRow {
    const current = requireUnit(unitId);
    const state = patch.state ?? current.state;
    const lane = patch.lane === undefined ? current.lane : patch.lane;
    const mandate = patch.mandateId === undefined ? current.currentMandateId : patch.mandateId;
    const attemptCount = patch.attemptCount ?? current.attemptCount;
    const terminal = isTerminal(state);
    // A non-terminal unit must never carry `terminal_at`: the schema trigger
    // aborts that write, so the invariant is kept true here instead of being
    // discovered by an exception.
    const terminalAt =
      patch.terminalAt !== undefined ? patch.terminalAt : terminal ? current.terminalAt : null;
    const terminalReason =
      patch.terminalReason !== undefined
        ? patch.terminalReason
        : terminal
          ? current.terminalReason
          : null;
    stmt(
      `UPDATE units SET state = ?, lane = ?, current_mandate_id = ?, attempt_count = ?,
         updated_at = ?, terminal_at = ?, terminal_reason = ? WHERE unit_id = ?`,
    ).run(state, lane, mandate, attemptCount, at, terminalAt, terminalReason, unitId);
    return requireUnit(unitId);
  }

  /** The latest lane decision for a unit — the source of `laneDecisionId`, policy and score. */
  function latestLaneDecision(unitId: string): (LaneDecisionType & { decisionId: string }) | null {
    const row = stmt(
      'SELECT * FROM lane_decisions WHERE unit_id = ? ORDER BY decided_at DESC, rowid DESC LIMIT 1',
    ).get<LaneDecisionDbRow>(unitId);
    return row ? mapLaneDecision(row) : null;
  }

  function mapLaneDecision(row: LaneDecisionDbRow): LaneDecisionType & { decisionId: string } {
    return {
      decisionId: row.decision_id,
      unitId: row.unit_id,
      lane: row.lane,
      score: Number(row.score),
      signals: JSON.parse(row.signals_json) as LaneDecisionType['signals'],
      policyVersion: row.policy_version,
      decidedAt: row.decided_at,
      mandateId: row.mandate_id,
    };
  }

  /** A reason code string an operator can act on, derived from the recorded decision. */
  function decisionReason(decision: LaneDecisionType): string {
    const failing = decision.signals.find((s) => s.outcome !== 'pass');
    if (!failing) return `lane=${decision.lane}`;
    return `${failing.name}:${failing.reason}`;
  }

  function requireMandate(mandateId: string): MandateRow {
    const row = stmt('SELECT * FROM mandates WHERE mandate_id = ?').get<MandateDbRow>(mandateId);
    if (!row) {
      throw new FactoryError(
        'MANDATE_EXPIRED',
        `mandate ${mandateId} does not exist; re-qualify the unit`,
        {
          mandateId,
        },
      );
    }
    return mapMandate(row);
  }

  function mapMandate(row: MandateDbRow): MandateRow {
    return {
      mandateId: row.mandate_id,
      unitId: row.unit_id,
      policyVersion: row.policy_version,
      lane: row.lane,
      budgetUsd: Number(row.budget_usd),
      issuedAt: row.issued_at,
      expiresAt: row.expires_at,
      revokedAt: row.revoked_at,
    };
  }

  function assertMandateUsable(mandate: MandateRow, unitId: string, at: string): void {
    if (mandate.revokedAt !== null) {
      throw new FactoryError(
        'MANDATE_EXPIRED',
        `unit ${unitId} is backed by mandate ${mandate.mandateId}, revoked at ${mandate.revokedAt}; ` +
          're-qualify the unit before dispatching it again',
        { unitId, mandateId: mandate.mandateId, revokedAt: mandate.revokedAt },
      );
    }
    // ISO-8601 UTC strings sort lexicographically, which is the whole reason the
    // store never persists epoch numbers.
    if (mandate.expiresAt <= at) {
      throw new FactoryError(
        'MANDATE_EXPIRED',
        `unit ${unitId} mandate ${mandate.mandateId} expired at ${mandate.expiresAt} (now ${at}); ` +
          're-qualify the unit to mint a fresh mandate',
        { unitId, mandateId: mandate.mandateId, expiresAt: mandate.expiresAt },
      );
    }
  }

  // ---------------------------------------------------------- qualification

  /**
   * Lane + mandate + unit state, written as one decision.
   *
   * Interpretation (reported): only `dark` produces `unit.qualified`; `lit` is
   * parked (`unit.lit_parked`) because a lit unit is terminally not-dispatched in
   * this system, and `reject` is `unit.rejected`. The event's `laneDecisionId`,
   * `policyVersion` and `score` come from the stored lane decision, because the
   * `Store` interface does not carry them on this call and inventing them would
   * put numbers in the ledger that no policy produced.
   */
  function applyLane(
    row: UnitRow,
    lane: 'dark' | 'lit' | 'reject',
    mandateId: string | null,
    opts: AppendOptions,
  ): UnitRow {
    const decision = latestLaneDecision(row.unitId);
    if (!decision) {
      throw new FactoryError(
        'INTERNAL',
        `unit ${row.unitId} has no lane decision; record one with insertLaneDecision before setting lane ` +
          `'${lane}' — the ledger must be able to name the decision that routed it`,
        { unitId: row.unitId, lane },
      );
    }
    const at = opts.occurredAt ?? now();
    if (lane === 'dark') {
      if (mandateId === null) {
        throw new FactoryError(
          'INTERNAL',
          `lane 'dark' for unit ${row.unitId} requires a mandate id; a dark unit without a mandate cannot be ` +
            'dispatched or budgeted',
          { unitId: row.unitId },
        );
      }
      const mandate = requireMandate(mandateId);
      assertMandateUsable(mandate, row.unitId, at);
      const updated = updateUnit(row.unitId, { lane: 'dark', mandateId, state: 'qualified' }, at);
      writeEvent(
        {
          type: 'unit.qualified',
          unitId: row.unitId,
          lane: 'dark',
          laneDecisionId: decision.decisionId,
          policyVersion: decision.policyVersion,
          score: decision.score,
        },
        opts,
      );
      return updated;
    }
    if (mandateId !== null) {
      throw new FactoryError(
        'INTERNAL',
        `lane '${lane}' for unit ${row.unitId} must not mint mandate ${mandateId}; only a dark lane authorises ` +
          'dispatch, so a mandate here would be a capability nobody granted',
        { unitId: row.unitId, lane, mandateId },
      );
    }
    const reason = decisionReason(decision);
    if (lane === 'lit') {
      const updated = updateUnit(
        row.unitId,
        {
          lane: 'lit',
          mandateId: null,
          state: 'lit_parked',
          terminalAt: at,
          terminalReason: reason,
        },
        at,
      );
      writeEvent({ type: 'unit.lit_parked', unitId: row.unitId, reason }, opts);
      return updated;
    }
    const updated = updateUnit(
      row.unitId,
      {
        lane: 'reject',
        mandateId: null,
        state: 'rejected',
        terminalAt: at,
        terminalReason: reason,
      },
      at,
    );
    writeEvent({ type: 'unit.rejected', unitId: row.unitId, reason }, opts);
    return updated;
  }

  // -------------------------------------------------------------- event per state

  /**
   * The ledger event a unit state change implies. States whose event needs facts
   * the store does not have on this call are derived from the rows that produced
   * them (attempt, receipt, verdict, promotion), so the payload is never invented.
   */
  function eventForUnitState(
    row: UnitRow,
    target: UnitState,
    reason: string | null,
    at: string,
  ): EventPayload {
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
        const decision = latestLaneDecision(row.unitId);
        if (!decision) {
          throw new FactoryError(
            'INTERNAL',
            `unit ${row.unitId} cannot move to '${target}' without a recorded lane decision; call ` +
              'setUnitLaneAndMandate so the ledger names the decision that routed it',
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
            reason: reason ?? decisionReason(decision),
          };
        }
        return {
          type: 'unit.rejected',
          unitId: row.unitId,
          reason: reason ?? decisionReason(decision),
        };
      }
      case 'dispatched': {
        const attempt = stmt(
          'SELECT * FROM attempts WHERE unit_id = ? ORDER BY started_at DESC, rowid DESC LIMIT 1',
        ).get<AttemptDbRow>(row.unitId);
        if (!attempt) {
          throw new FactoryError(
            'ATTEMPT_NOT_FOUND',
            `unit ${row.unitId} cannot be dispatched: it has no attempt. Insert the attempt (which fixes its ` +
              'launch key) before moving the unit to dispatched',
            { unitId: row.unitId },
          );
        }
        if (row.currentMandateId === null) {
          throw new FactoryError(
            'MANDATE_EXPIRED',
            `unit ${row.unitId} has no current mandate; qualify it into the dark lane before dispatching`,
            { unitId: row.unitId },
          );
        }
        assertMandateUsable(requireMandate(row.currentMandateId), row.unitId, at);
        return {
          type: 'unit.dispatched',
          unitId: row.unitId,
          attemptId: attempt.attempt_id,
          mandateId: row.currentMandateId,
          launchKey: attempt.launch_key,
        };
      }
      case 'receipted': {
        const receipt = stmt(
          'SELECT * FROM receipts WHERE unit_id = ? ORDER BY recorded_at DESC, rowid DESC LIMIT 1',
        ).get<ReceiptDbRow>(row.unitId);
        if (!receipt) {
          throw new FactoryError(
            'INTERNAL',
            `unit ${row.unitId} cannot move to 'receipted' without a receipt; call insertReceipt so the state ` +
              'names the evidence it is based on',
            { unitId: row.unitId },
          );
        }
        return {
          type: 'attempt.receipted',
          unitId: row.unitId,
          attemptId: receipt.attempt_id,
          receiptSha: receipt.receipt_sha,
          exitCode: receipt.exit_code === null ? null : Number(receipt.exit_code),
        };
      }
      case 'verified': {
        const verdict = stmt(
          'SELECT * FROM verdicts WHERE unit_id = ? ORDER BY evaluated_at DESC, rowid DESC LIMIT 1',
        ).get<VerdictDbRow>(row.unitId);
        if (!verdict) {
          throw new FactoryError(
            'VERDICT_MISSING',
            `unit ${row.unitId} cannot move to 'verified' without a verdict; the wall must record one with ` +
              'insertVerdict',
            { unitId: row.unitId },
          );
        }
        return {
          type: 'unit.verified',
          unitId: row.unitId,
          attemptId: verdict.attempt_id,
          verdictId: verdict.verdict_id,
          outcome: verdict.outcome,
        };
      }
      case 'promoted': {
        const promotion = stmt(
          'SELECT * FROM promotions WHERE unit_id = ? ORDER BY created_at DESC, rowid DESC LIMIT 1',
        ).get<{
          promotion_id: string;
          verdict_id: string;
          promotion_sha: string;
          signed_by: string;
        }>(row.unitId);
        if (!promotion) {
          throw new FactoryError(
            'VERDICT_MISSING',
            `unit ${row.unitId} cannot move to 'promoted' without a signed promotion; call insertPromotion so ` +
              'the ledger names the signature that authorised it',
            { unitId: row.unitId },
          );
        }
        return {
          type: 'unit.promoted',
          unitId: row.unitId,
          verdictId: promotion.verdict_id,
          promotionSha: promotion.promotion_sha,
          signedBy: promotion.signed_by,
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
        const attempt = stmt(
          'SELECT * FROM attempts WHERE unit_id = ? ORDER BY started_at DESC, rowid DESC LIMIT 1',
        ).get<AttemptDbRow>(row.unitId);
        if (!attempt) {
          throw new FactoryError(
            'ATTEMPT_NOT_FOUND',
            `unit ${row.unitId} cannot be ambiguous: ambiguity is a property of an attempt, and this unit has ` +
              'none',
            { unitId: row.unitId },
          );
        }
        return {
          type: 'attempt.ambiguous',
          unitId: row.unitId,
          attemptId: attempt.attempt_id,
          observedAs: UNOBSERVED,
          reason: reason ?? 'ambiguous without a recorded reason',
        };
      }
    }
  }

  // ---------------------------------------------------------------------- store

  const store: Store = {
    // --- lifecycle -----------------------------------------------------------
    close(): void {
      cache.clear();
      driver.close();
    },
    location,
    schemaVersion: SCHEMA_VERSION,
    pragmas: driver.pragmas,

    atomic<T>(fn: () => T): T {
      return inTransaction(fn);
    },

    // --- ledger --------------------------------------------------------------
    appendEvent(event: LedgerEvent['payload'], opts: AppendOptions): LedgerEvent {
      return mutate('appendEvent', () => writeEvent(event as EventPayload, opts));
    },

    /** Declared migrations applied when this store was opened. Empty for a store already current. */
    migrationsApplied(): { from: number; to: number; note: string }[] {
      return [...migrationsApplied];
    },

    eventsSince(seq: number, limit?: number): LedgerEvent[] {
      const cap = limit ?? -1; // SQLite: LIMIT -1 means "no limit"
      return stmt('SELECT * FROM events WHERE seq > ? ORDER BY seq ASC LIMIT ?')
        .all<EventDbRow>(seq, cap)
        .map(mapEvent);
    },

    eventCount(): number {
      const row = stmt('SELECT COUNT(*) AS n FROM events').get<CountRow>();
      return Number(row?.n ?? 0);
    },

    /**
     * Replay the ledger into a shadow projection and compare it with the
     * aggregates. A divergence is reported, never thrown: an audit that crashes
     * on a corrupt store is an audit that cannot tell you what is corrupt.
     */
    audit(): { ok: boolean; divergences: string[]; events: number } {
      const divergences: string[] = [];
      let total = 0;
      try {
        total = store.eventCount();
        const events = stmt('SELECT * FROM events ORDER BY seq ASC')
          .all<EventDbRow>()
          .map(mapEvent);
        const units = new Map<string, UnitState>();
        const attempts = new Map<string, AttemptRow['state']>();
        const spend = new Map<string, { reserved: number; recorded: number; unknown: number }>();

        const bucket = (
          unitId: string,
        ): { reserved: number; recorded: number; unknown: number } => {
          const existing = spend.get(unitId);
          if (existing) return existing;
          const created = { reserved: 0, recorded: 0, unknown: 0 };
          spend.set(unitId, created);
          return created;
        };

        for (const event of events) {
          const payload = event.payload;
          const unitId = payloadString(payload, 'unitId');
          const attemptId = payloadString(payload, 'attemptId');
          switch (event.type) {
            case 'unit.submitted':
            case 'unit.qualified':
            case 'unit.dispatched':
            case 'unit.verified':
            case 'unit.promoted':
            case 'unit.rejected':
            case 'unit.aborted':
            case 'unit.lit_parked': {
              if (unitId === null) break;
              const target = event.type.slice('unit.'.length) as UnitState;
              units.set(unitId, stateAfter(units.get(unitId) ?? 'submitted', target));
              break;
            }
            case 'attempt.receipted': {
              if (unitId !== null)
                units.set(unitId, stateAfter(units.get(unitId) ?? 'submitted', 'receipted'));
              if (attemptId !== null) attempts.set(attemptId, 'produced-receipt');
              break;
            }
            case 'attempt.ambiguous': {
              if (unitId !== null)
                units.set(unitId, stateAfter(units.get(unitId) ?? 'submitted', 'ambiguous'));
              if (attemptId !== null) attempts.set(attemptId, 'ambiguous');
              break;
            }
            case 'spend.reserved': {
              if (unitId === null) break;
              const amount = payload['amountUsd'];
              if (typeof amount === 'number') bucket(unitId).reserved += amount;
              break;
            }
            case 'spend.recorded': {
              if (unitId === null) break;
              const amount = payload['amountUsd'];
              const kind = payload['kind'];
              if (typeof amount === 'number') bucket(unitId).recorded += amount;
              else if (kind === 'unknown') bucket(unitId).unknown += 1;
              break;
            }
            default:
              break;
          }
        }

        // Units: ledger vs aggregate.
        for (const row of stmt('SELECT unit_id, state FROM units').all<{
          unit_id: string;
          state: UnitState;
        }>()) {
          const replayed = units.get(row.unit_id);
          if (replayed === undefined) {
            divergences.push(
              `unit ${row.unit_id}: exists in aggregates (state '${row.state}') but the ledger has no event ` +
                'that creates it',
            );
          } else if (replayed !== row.state) {
            divergences.push(
              `unit ${row.unit_id}: aggregate state '${row.state}' but ledger replays to '${replayed}'`,
            );
          }
        }
        for (const [unitId, replayed] of units) {
          const row = stmt('SELECT state FROM units WHERE unit_id = ?').get<{ state: UnitState }>(
            unitId,
          );
          if (!row) {
            divergences.push(
              `unit ${unitId}: ledger replays to '${replayed}' but no aggregate row exists`,
            );
          }
        }

        // Attempts: only where the ledger actually determines the state.
        for (const [attemptId, replayed] of attempts) {
          const row = stmt('SELECT state FROM attempts WHERE attempt_id = ?').get<{
            state: AttemptRow['state'];
          }>(attemptId);
          if (!row) {
            divergences.push(
              `attempt ${attemptId}: ledger replays to '${replayed}' but no aggregate row exists`,
            );
          } else if (row.state !== replayed) {
            divergences.push(
              `attempt ${attemptId}: aggregate state '${row.state}' but ledger replays to '${replayed}'`,
            );
          }
        }

        // Spend: totals per unit, compared with the aggregate table.
        for (const [unitId, expected] of spend) {
          const actual = store.spendForUnit(unitId);
          if (Math.abs(actual.reservedUsd - expected.reserved) > 1e-9) {
            divergences.push(
              `unit ${unitId}: spend reserved ${actual.reservedUsd} but ledger replays to ${expected.reserved}`,
            );
          }
          if (Math.abs(actual.recordedUsd - expected.recorded) > 1e-9) {
            divergences.push(
              `unit ${unitId}: spend recorded ${actual.recordedUsd} but ledger replays to ${expected.recorded}`,
            );
          }
          if (actual.unknownRows !== expected.unknown) {
            divergences.push(
              `unit ${unitId}: ${actual.unknownRows} unknown spend rows but ledger replays to ${expected.unknown}`,
            );
          }
        }
      } catch (error) {
        divergences.push(
          `replay failed: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
      return { ok: divergences.length === 0, divergences, events: total };
    },

    // --- quarantine ----------------------------------------------------------
    isQuarantined(): boolean {
      return quarantineReason() !== null;
    },

    quarantine(reason: string, actor: string, traceId: string): void {
      mutate('quarantine', () => {
        const existing = quarantineReason();
        if (existing !== null) {
          throw new FactoryError(
            'STORE_QUARANTINED',
            `store is already quarantined (${existing})`,
            {
              reason: existing,
              location,
            },
          );
        }
        const at = now();
        stmt("INSERT INTO store_state (key, value) VALUES ('quarantined', ?)").run(reason);
        stmt("INSERT INTO store_state (key, value) VALUES ('quarantined_at', ?)").run(at);
        // Written through the internal path: the store is already quarantined, so
        // the public guard would refuse the very event that records the refusal.
        writeEvent(
          { type: 'store.quarantined', reason, detectedBy: actor },
          { actor, traceId, occurredAt: at },
        );
      });
    },

    // --- units ---------------------------------------------------------------
    getUnit(unitId: string): UnitRow | null {
      const row = stmt('SELECT * FROM units WHERE unit_id = ?').get<UnitDbRow>(unitId);
      return row ? mapUnit(row) : null;
    },

    findUnitBySlug(repo: string, slug: string, revision: number): UnitRow | null {
      const row = stmt(
        'SELECT * FROM units WHERE repo = ? AND slug = ? AND revision = ?',
      ).get<UnitDbRow>(repo, slug, revision);
      return row ? mapUnit(row) : null;
    },

    findUnitBySpecHash(repo: string, specHash: string): UnitRow | null {
      const row = stmt(
        'SELECT * FROM units WHERE repo = ? AND spec_hash = ? LIMIT 1',
      ).get<UnitDbRow>(repo, specHash);
      return row ? mapUnit(row) : null;
    },

    insertUnit(unit: UnitRow, opts: AppendOptions): UnitRow {
      return mutate('insertUnit', () => {
        let spec: UnitRow['spec'];
        try {
          spec = UnitSpec.parse(unit.spec);
        } catch (error) {
          throw new FactoryError(
            'SPEC_INVALID',
            `unit spec for ${unit.repo}/${unit.slug} is invalid: ${describeZodError(error)}`,
            {
              repo: unit.repo,
              slug: unit.slug,
            },
          );
        }
        const computed = contentHash(spec);
        if (computed !== unit.specHash) {
          throw new FactoryError(
            'SPEC_INVALID',
            `unit ${unit.unitId}: specHash ${unit.specHash} does not match sha256 of its own spec (${computed}); ` +
              'an identity that disagrees with its content is not an identity',
            { unitId: unit.unitId, specHash: unit.specHash, computed },
          );
        }
        if (unit.state !== 'submitted') {
          throw new FactoryError(
            'SPEC_INVALID',
            `unit ${unit.unitId}: insertUnit creates a submitted unit, but state '${unit.state}' was given; ` +
              'later states belong to the commands that earn them',
            { unitId: unit.unitId, state: unit.state },
          );
        }
        const existing = store.findUnitBySlug(unit.repo, unit.slug, unit.revision);
        if (existing) {
          if (existing.specHash === unit.specHash) return existing;
          throw new FactoryError(
            'DUPLICATE_UNIT',
            `unit ${unit.repo}/${unit.slug}@${unit.revision} already exists as ${existing.unitId} with spec hash ` +
              `${existing.specHash}; re-submitting different intent under the same revision is a duplicate — ` +
              'bump the revision or submit a new slug',
            {
              repo: unit.repo,
              slug: unit.slug,
              revision: unit.revision,
              existingUnitId: existing.unitId,
              existingSpecHash: existing.specHash,
              incomingSpecHash: unit.specHash,
            },
          );
        }
        const sameSpec = store.findUnitBySpecHash(unit.repo, unit.specHash);
        if (sameSpec) {
          throw new FactoryError(
            'DUPLICATE_UNIT',
            `spec hash ${unit.specHash} is already unit ${sameSpec.unitId} (${sameSpec.slug}@${sameSpec.revision}); ` +
              'the same intent cannot be two units',
            { existingUnitId: sameSpec.unitId, specHash: unit.specHash },
          );
        }
        stmt(
          `INSERT INTO units (unit_id, slug, revision, repo, base_rev, spec_hash, spec_json, state, lane,
             current_mandate_id, attempt_count, created_at, updated_at, terminal_at, terminal_reason)
           VALUES (?, ?, ?, ?, ?, ?, ?, 'submitted', NULL, NULL, 0, ?, ?, NULL, NULL)`,
        ).run(
          unit.unitId,
          unit.slug,
          unit.revision,
          unit.repo,
          unit.baseRev,
          unit.specHash,
          canonicalJson(spec),
          unit.createdAt,
          unit.updatedAt,
        );
        writeEvent(
          {
            type: 'unit.submitted',
            unitId: unit.unitId,
            specHash: unit.specHash,
            slug: unit.slug,
            revision: unit.revision,
          },
          opts,
        );
        return requireUnit(unit.unitId);
      });
    },

    setUnitState(
      unitId: string,
      state: UnitState,
      reason: string | null,
      opts: AppendOptions,
    ): UnitRow {
      return mutate('setUnitState', () => {
        const row = requireUnit(unitId);
        const at = opts.occurredAt ?? now();
        if (isTerminal(row.state)) {
          throw new FactoryError(
            'UNIT_ALREADY_TERMINAL',
            `unit ${unitId} is already terminal (${row.state}); a terminal unit never changes state — ` +
              'submit a new revision instead',
            { unitId, state: row.state, requested: state },
          );
        }
        if (row.state === state) return row; // already there; one event per change
        if (!canTransition(row.state, state)) {
          throw new FactoryError(
            'INTERNAL',
            `illegal unit transition ${row.state} → ${state} for unit ${unitId}; the state machine in ` +
              '@factory/contracts forbids it, so one of the two callers is wrong',
            { unitId, from: row.state, to: state },
          );
        }
        const payload = eventForUnitState(row, state, reason, at);
        const terminal = isTerminal(state);
        const updated = updateUnit(
          unitId,
          {
            state,
            terminalAt: terminal ? at : null,
            terminalReason: terminal
              ? (reason ?? String((payload as { reason?: string }).reason ?? state))
              : null,
          },
          at,
        );
        writeEvent(payload, opts);
        return updated;
      });
    },

    setUnitLaneAndMandate(
      unitId: string,
      lane: 'dark' | 'lit' | 'reject',
      mandateId: string | null,
      opts: AppendOptions,
    ): UnitRow {
      return mutate('setUnitLaneAndMandate', () => {
        const row = requireUnit(unitId);
        if (isTerminal(row.state)) {
          throw new FactoryError(
            'UNIT_ALREADY_TERMINAL',
            `unit ${unitId} is already terminal (${row.state}); its lane cannot be re-assigned`,
            { unitId, state: row.state },
          );
        }
        return applyLane(row, lane, mandateId, opts);
      });
    },

    incrementAttemptCount(unitId: string, opts: AppendOptions): number {
      return mutate('incrementAttemptCount', () => {
        requireUnit(unitId);
        const at = opts.occurredAt ?? now();
        stmt(
          'UPDATE units SET attempt_count = attempt_count + 1, updated_at = ? WHERE unit_id = ?',
        ).run(at, unitId);
        // No event: the ledger vocabulary has no `attempt.counted` type, and the
        // dispatch event already names the attempt that consumed the budget.
        return requireUnit(unitId).attemptCount;
      });
    },

    listUnits(filter?: {
      state?: UnitState;
      lane?: 'dark' | 'lit' | 'reject';
      limit?: number;
    }): UnitRow[] {
      const where: string[] = [];
      const params: unknown[] = [];
      if (filter?.state !== undefined) {
        where.push('state = ?');
        params.push(filter.state);
      }
      if (filter?.lane !== undefined) {
        where.push('lane = ?');
        params.push(filter.lane);
      }
      const sql =
        'SELECT * FROM units' +
        (where.length > 0 ? ` WHERE ${where.join(' AND ')}` : '') +
        ' ORDER BY created_at ASC, rowid ASC LIMIT ?';
      params.push(filter?.limit ?? -1);
      return stmt(sql)
        .all<UnitDbRow>(...params)
        .map(mapUnit);
    },

    countUnitsByState(): Record<UnitState, number> {
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
      for (const row of stmt('SELECT state, COUNT(*) AS n FROM units GROUP BY state').all<{
        state: UnitState;
        n: number;
      }>()) {
        out[row.state] = Number(row.n);
      }
      for (const state of ALL_UNIT_STATES) out[state] = out[state] ?? 0;
      return out;
    },

    // --- mandates ------------------------------------------------------------
    insertMandate(mandate: MandateRow): MandateRow {
      return mutate('insertMandate', () => {
        requireUnit(mandate.unitId);
        try {
          stmt(
            `INSERT INTO mandates (mandate_id, unit_id, policy_version, lane, budget_usd, issued_at, expires_at,
               revoked_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
          ).run(
            mandate.mandateId,
            mandate.unitId,
            mandate.policyVersion,
            mandate.lane,
            mandate.budgetUsd,
            mandate.issuedAt,
            mandate.expiresAt,
            mandate.revokedAt,
          );
        } catch (error) {
          if (isConstraintError(error)) {
            throw new FactoryError(
              'INTERNAL',
              `mandate ${mandate.mandateId} could not be recorded for unit ${mandate.unitId}: ` +
                `${error instanceof Error ? error.message : String(error)}`,
              { mandateId: mandate.mandateId, unitId: mandate.unitId },
            );
          }
          throw error;
        }
        return requireMandate(mandate.mandateId);
      });
    },

    getMandate(mandateId: string): MandateRow | null {
      const row = stmt('SELECT * FROM mandates WHERE mandate_id = ?').get<MandateDbRow>(mandateId);
      return row ? mapMandate(row) : null;
    },

    revokeMandate(mandateId: string, at: string): void {
      mutate('revokeMandate', () => {
        const res = stmt(
          'UPDATE mandates SET revoked_at = ? WHERE mandate_id = ? AND revoked_at IS NULL',
        ).run(at, mandateId);
        if (Number(res.changes) === 0) {
          const exists = stmt('SELECT mandate_id FROM mandates WHERE mandate_id = ?').get<{
            mandate_id: string;
          }>(mandateId);
          if (!exists) {
            throw new FactoryError(
              'MANDATE_EXPIRED',
              `mandate ${mandateId} does not exist; nothing to revoke`,
              {
                mandateId,
              },
            );
          }
        }
        // No event: revocation is a mandate fact and the ledger vocabulary has no
        // `mandate.revoked` type; the re-qualification that follows is recorded.
      });
    },

    // --- lane decisions ------------------------------------------------------
    insertLaneDecision(decision: LaneDecisionType & { decisionId: string }): void {
      mutate('insertLaneDecision', () => {
        requireUnit(decision.unitId);
        const existing = store.getLaneDecision(decision.unitId, decision.policyVersion);
        if (existing) {
          const same =
            canonicalJson({ ...existing, decisionId: undefined }) ===
            canonicalJson({ ...decision, decisionId: undefined });
          if (same) return; // I4: re-qualification under one policy is idempotent
          throw new FactoryError(
            'INTERNAL',
            `unit ${decision.unitId} already has a different lane decision for policy ` +
              `${decision.policyVersion} (${existing.decisionId}); a re-qualification needs a new policy version`,
            {
              unitId: decision.unitId,
              policyVersion: decision.policyVersion,
              existing: existing.decisionId,
            },
          );
        }
        stmt(
          `INSERT INTO lane_decisions (decision_id, unit_id, lane, score, policy_version, signals_json,
             reasons_json, mandate_id, decided_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        ).run(
          decision.decisionId,
          decision.unitId,
          decision.lane,
          decision.score,
          decision.policyVersion,
          canonicalJson(decision.signals),
          // `reasons_json` holds the per-signal reason codes: the LaneDecision
          // contract has no separate reason list, and the signal reasons are the
          // only reason vocabulary the qualifier actually produced.
          canonicalJson(decision.signals.map((s) => ({ name: s.name, reason: s.reason }))),
          decision.mandateId,
          decision.decidedAt,
        );
      });
    },

    getLaneDecision(
      unitId: string,
      policyVersion: string,
    ): (LaneDecisionType & { decisionId: string }) | null {
      const row = stmt(
        'SELECT * FROM lane_decisions WHERE unit_id = ? AND policy_version = ?',
      ).get<LaneDecisionDbRow>(unitId, policyVersion);
      return row ? mapLaneDecision(row) : null;
    },

    // --- leases --------------------------------------------------------------
    acquireLease(input: {
      leaseId: string;
      unitId: string;
      owner: string;
      acquiredAt: string;
      expiresAt: string;
    }): void {
      mutate('acquireLease', () => {
        requireUnit(input.unitId);
        try {
          stmt(
            'INSERT INTO leases (lease_id, unit_id, owner, acquired_at, expires_at, released_at) VALUES (?, ?, ?, ?, ?, NULL)',
          ).run(input.leaseId, input.unitId, input.owner, input.acquiredAt, input.expiresAt);
        } catch (error) {
          if (isUniqueError(error)) {
            const live = store.getLiveLease(input.unitId);
            throw new FactoryError(
              'LEASE_HELD',
              `unit ${input.unitId} already has a live lease${live ? ` held by ${live.owner} (expires ${live.expiresAt})` : ''}; ` +
                `refusing lease ${input.leaseId} — one live lease per unit, enforced by a partial unique index`,
              {
                unitId: input.unitId,
                requestedLeaseId: input.leaseId,
                liveLeaseId: live?.leaseId ?? null,
                liveOwner: live?.owner ?? null,
              },
            );
          }
          throw error;
        }
      });
    },

    getLiveLease(unitId: string): { leaseId: string; owner: string; expiresAt: string } | null {
      const row = stmt(
        'SELECT * FROM leases WHERE unit_id = ? AND released_at IS NULL',
      ).get<LeaseDbRow>(unitId);
      if (!row) return null;
      return { leaseId: row.lease_id, owner: row.owner, expiresAt: row.expires_at };
    },

    releaseLease(leaseId: string, at: string): void {
      mutate('releaseLease', () => {
        const res = stmt(
          'UPDATE leases SET released_at = ? WHERE lease_id = ? AND released_at IS NULL',
        ).run(at, leaseId);
        if (Number(res.changes) === 0) {
          const exists = stmt('SELECT lease_id FROM leases WHERE lease_id = ?').get<{
            lease_id: string;
          }>(leaseId);
          if (!exists) {
            throw new FactoryError(
              'INTERNAL',
              `lease ${leaseId} does not exist; nothing to release`,
              { leaseId },
            );
          }
          // Already released: releasing twice is a no-op, not an error.
        }
        // No event: lease lifecycle has no ledger vocabulary. The attempt events
        // that depend on the lease are what the audit replays.
      });
    },

    listExpiredLeases(
      nowIso: string,
    ): Array<{ leaseId: string; unitId: string; expiresAt: string }> {
      return stmt(
        'SELECT * FROM leases WHERE released_at IS NULL AND expires_at <= ? ORDER BY expires_at ASC',
      )
        .all<LeaseDbRow>(nowIso)
        .map((row) => ({ leaseId: row.lease_id, unitId: row.unit_id, expiresAt: row.expires_at }));
    },

    // --- attempts ------------------------------------------------------------
    insertAttempt(attempt: AttemptRow): AttemptRow {
      return mutate('insertAttempt', () => {
        requireUnit(attempt.unitId);
        // The launch key is the attempt's idempotency key: replaying the dispatch
        // must return the same attempt, not a second run of the same work.
        const existing = stmt('SELECT * FROM attempts WHERE launch_key = ?').get<AttemptDbRow>(
          attempt.launchKey,
        );
        if (existing) return mapAttempt(existing);
        try {
          stmt(
            `INSERT INTO attempts (attempt_id, unit_id, lease_id, state, launch_key, session_id, attempt_dir,
               started_at, ended_at, exit_code) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          ).run(
            attempt.attemptId,
            attempt.unitId,
            attempt.leaseId,
            attempt.state,
            attempt.launchKey,
            attempt.sessionId,
            attempt.attemptDir,
            attempt.startedAt,
            attempt.endedAt,
            attempt.exitCode,
          );
        } catch (error) {
          if (isConstraintError(error)) {
            throw new FactoryError(
              'INTERNAL',
              `attempt ${attempt.attemptId} could not be recorded for unit ${attempt.unitId}: ` +
                `${error instanceof Error ? error.message : String(error)} (does lease ${attempt.leaseId} exist?)`,
              { attemptId: attempt.attemptId, unitId: attempt.unitId, leaseId: attempt.leaseId },
            );
          }
          throw error;
        }
        return requireAttempt(attempt.attemptId);
      });
    },

    getAttempt(attemptId: string): AttemptRow | null {
      const row = stmt('SELECT * FROM attempts WHERE attempt_id = ?').get<AttemptDbRow>(attemptId);
      return row ? mapAttempt(row) : null;
    },

    setAttemptState(
      attemptId: string,
      state: AttemptRow['state'],
      // Defaulted rather than required: a JS caller (or a future caller that only
      // wants the state change) must not crash the store on an absent patch.
      patch: { endedAt?: string | null; exitCode?: number | null; sessionId?: string | null } = {},
    ): AttemptRow {
      return mutate('setAttemptState', () => {
        const current = requireAttempt(attemptId);
        // Terminal attempt states end the attempt, so an end timestamp is implied
        // rather than optional — an attempt that ended without a time is not
        // reconcilable.
        const endedDefault =
          state === 'aborted' || state === 'ambiguous' || state === 'produced-receipt';
        const endedAt =
          patch.endedAt !== undefined
            ? patch.endedAt
            : endedDefault
              ? (current.endedAt ?? now())
              : current.endedAt;
        const exitCode = patch.exitCode !== undefined ? patch.exitCode : current.exitCode;
        const sessionId = patch.sessionId !== undefined ? patch.sessionId : current.sessionId;
        stmt(
          'UPDATE attempts SET state = ?, ended_at = ?, exit_code = ?, session_id = ? WHERE attempt_id = ?',
        ).run(state, endedAt, exitCode, sessionId, attemptId);
        // No event: the ledger records the facts that matter to a decision (a
        // receipt, an ambiguity). Intermediate attempt states are operational.
        return requireAttempt(attemptId);
      });
    },

    listActiveAttempts(): AttemptRow[] {
      return stmt(
        "SELECT * FROM attempts WHERE state IN ('planned','launching','running') ORDER BY started_at ASC",
      )
        .all<AttemptDbRow>()
        .map(mapAttempt);
    },

    listAttemptsForUnit(unitId: string): AttemptRow[] {
      return stmt('SELECT * FROM attempts WHERE unit_id = ? ORDER BY started_at ASC, rowid ASC')
        .all<AttemptDbRow>(unitId)
        .map(mapAttempt);
    },

    // --- receipts ------------------------------------------------------------
    insertReceipt(row: ReceiptRow, opts: AppendOptions): ReceiptRow {
      return mutate('insertReceipt', () => {
        const unit = requireUnit(row.unitId);
        requireAttempt(row.attemptId);
        let body: WorkerReceiptType;
        try {
          body = WorkerReceipt.parse(row.receipt);
        } catch (error) {
          throw new FactoryError(
            'INTERNAL',
            `receipt for attempt ${row.attemptId} does not satisfy the receipt contract ` +
              `(${describeZodError(error)}); a receipt the wall cannot re-read is not evidence`,
            { attemptId: row.attemptId, receiptId: row.receiptId },
          );
        }
        const sha = receiptShaFor(body);
        if (sha !== row.receiptSha) {
          throw new FactoryError(
            'INTERNAL',
            `receipt for attempt ${row.attemptId}: receiptSha ${row.receiptSha} does not match sha256 of its own ` +
              `content (${sha}); a receipt that disagrees with its hash is not evidence`,
            { attemptId: row.attemptId, receiptSha: row.receiptSha, computed: sha },
          );
        }
        if (body.unitId !== row.unitId || body.attemptId !== row.attemptId) {
          throw new FactoryError(
            'INTERNAL',
            `receipt for attempt ${row.attemptId} describes unit ${body.unitId} / attempt ` +
              `${body.attemptId}; a receipt cannot be filed against another attempt`,
            {
              attemptId: row.attemptId,
              receiptUnitId: body.unitId,
              receiptAttemptId: body.attemptId,
            },
          );
        }
        try {
          stmt(
            `INSERT INTO receipts (receipt_id, unit_id, attempt_id, receipt_sha, session_id, exit_code, started_at,
               ended_at, receipt_json, recorded_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          ).run(
            row.receiptId,
            row.unitId,
            row.attemptId,
            row.receiptSha,
            row.sessionId,
            row.exitCode,
            row.startedAt,
            row.endedAt,
            canonicalJson(body),
            row.recordedAt,
          );
        } catch (error) {
          if (isUniqueError(error)) {
            const existing = store.getReceiptBySha(row.receiptSha);
            throw new FactoryError(
              'RECEIPT_CONFLICT',
              `receipt ${row.receiptSha} is already recorded${existing ? ` as ${existing.receiptId} for attempt ${existing.attemptId}` : ''}; ` +
                'receipts are append-only, so a second receipt for another attempt is a conflict — never an overwrite',
              {
                receiptSha: row.receiptSha,
                attemptId: row.attemptId,
                existingReceiptId: existing?.receiptId ?? null,
              },
            );
          }
          throw error;
        }
        // A recorded receipt is what makes a unit `receipted`; a terminal unit
        // keeps its state (evidence may still arrive after an abort).
        const nextState = stateAfter(unit.state, 'receipted');
        if (nextState !== unit.state) {
          updateUnit(row.unitId, { state: nextState }, row.recordedAt);
        }
        writeEvent(
          {
            type: 'attempt.receipted',
            unitId: row.unitId,
            attemptId: row.attemptId,
            receiptSha: row.receiptSha,
            exitCode: row.exitCode,
          },
          opts,
        );
        const stored = stmt('SELECT * FROM receipts WHERE receipt_id = ?').get<ReceiptDbRow>(
          row.receiptId,
        );
        if (!stored) {
          throw new FactoryError('INTERNAL', `receipt ${row.receiptId} vanished after insert`, {
            receiptId: row.receiptId,
          });
        }
        return mapReceipt(stored);
      });
    },

    getReceiptBySha(receiptSha: string): ReceiptRow | null {
      const row = stmt('SELECT * FROM receipts WHERE receipt_sha = ?').get<ReceiptDbRow>(
        receiptSha,
      );
      return row ? mapReceipt(row) : null;
    },

    latestReceiptForUnit(unitId: string): ReceiptRow | null {
      const row = stmt(
        'SELECT * FROM receipts WHERE unit_id = ? ORDER BY recorded_at DESC, rowid DESC LIMIT 1',
      ).get<ReceiptDbRow>(unitId);
      return row ? mapReceipt(row) : null;
    },

    // --- verdicts ------------------------------------------------------------
    insertVerdict(row: VerdictRow, opts: AppendOptions): VerdictRow {
      return mutate('insertVerdict', () => {
        const unit = requireUnit(row.unitId);
        requireAttempt(row.attemptId);
        let verdict: VerdictType;
        try {
          verdict = Verdict.parse(row.verdict);
        } catch (error) {
          throw new FactoryError(
            'INTERNAL',
            `verdict ${row.verdictId} does not satisfy the verdict contract (${describeZodError(error)}); ` +
              'a verdict the gate cannot re-read is not evidence',
            { verdictId: row.verdictId, unitId: row.unitId },
          );
        }
        if (row.outcome !== verdict.outcome) {
          throw new FactoryError(
            'INTERNAL',
            `verdict ${row.verdictId}: outcome column '${row.outcome}' disagrees with the verdict body ` +
              `'${verdict.outcome}'`,
            { verdictId: row.verdictId },
          );
        }
        if (row.receiptSha !== null && row.receiptSha !== verdict.receiptSha) {
          throw new FactoryError(
            'INTERNAL',
            `verdict ${row.verdictId}: receiptSha ${row.receiptSha} disagrees with the verdict body's ` +
              `${verdict.receiptSha}`,
            { verdictId: row.verdictId },
          );
        }
        if (row.receiptId !== null) {
          const receipt = stmt('SELECT * FROM receipts WHERE receipt_id = ?').get<ReceiptDbRow>(
            row.receiptId,
          );
          if (!receipt) {
            throw new FactoryError(
              'INTERNAL',
              `verdict ${row.verdictId} cites receipt ${row.receiptId}, which does not exist; the wall cannot ` +
                'judge evidence it does not hold',
              { verdictId: row.verdictId, receiptId: row.receiptId },
            );
          }
          if (receipt.receipt_sha !== verdict.receiptSha) {
            throw new FactoryError(
              'INTERNAL',
              `verdict ${row.verdictId} cites receipt ${row.receiptId} with sha ${receipt.receipt_sha}, but the ` +
                `verdict body names ${verdict.receiptSha}`,
              { verdictId: row.verdictId, receiptId: row.receiptId },
            );
          }
        }
        if (row.outcome === 'pass') {
          // The schema CHECK says the same thing; refusing here names what is
          // missing, which is the difference between "invalid" and "unknown".
          const missing: string[] = [];
          if (row.receiptId === null) missing.push('a receipt');
          if (verdict.receiptSha.length === 0) missing.push('a receipt hash');
          if (verdict.holdoutRevision.length === 0) missing.push('a holdout revision');
          if (!verdict.delta.checked) missing.push('a measured Δ');
          if (verdict.delta.observed === null) missing.push('an observed Δ value');
          if (missing.length > 0) {
            throw new FactoryError(
              'INTERNAL',
              `verdict ${row.verdictId} claims pass for unit ${row.unitId} without ${missing.join(', ')}; ` +
                'unknown never becomes pass — record it as unknown instead',
              { verdictId: row.verdictId, unitId: row.unitId, missing },
            );
          }
        }
        // The contract's own rule — a pass must be earned by measurement, a fail
        // must name a reason, and a pass may not carry failure reasons. Running it
        // here means the aggregate table and the gate read the same rule.
        try {
          assertVerdictIsEarned(verdict);
        } catch (error) {
          throw new FactoryError(
            'INTERNAL',
            `verdict ${row.verdictId} for unit ${row.unitId} is not earnable: ` +
              `${error instanceof Error ? error.message : String(error)}`,
            { verdictId: row.verdictId, unitId: row.unitId },
          );
        }
        try {
          stmt(
            `INSERT INTO verdicts (verdict_id, unit_id, attempt_id, receipt_id, receipt_sha, holdout_revision,
               policy_version, wall_version, outcome, delta_checked, delta_observed, reasons_json, scenarios_json,
               delta_json, evaluated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          ).run(
            row.verdictId,
            row.unitId,
            row.attemptId,
            row.receiptId,
            row.receiptSha ?? verdict.receiptSha,
            row.holdoutRevision ?? verdict.holdoutRevision,
            row.policyVersion,
            row.wallVersion,
            row.outcome,
            verdict.delta.checked ? 1 : 0,
            verdict.delta.observed,
            canonicalJson(verdict.reasons),
            canonicalJson(verdict.scenarios),
            canonicalJson(verdict.delta),
            row.evaluatedAt,
          );
        } catch (error) {
          if (isConstraintError(error)) {
            throw new FactoryError(
              'INTERNAL',
              `verdict ${row.verdictId} was refused by the schema: ` +
                `${error instanceof Error ? error.message : String(error)}`,
              { verdictId: row.verdictId, unitId: row.unitId },
            );
          }
          throw error;
        }
        // A verdict is evidence first and a state change second.
        //
        //  * `pass`    — the unit advances to `verified` (and only along an edge the
        //                state machine allows; a pass recorded on a terminal unit is
        //                kept as evidence and moves nothing).
        //  * `fail`    — a *measured* failure rejects the unit: `receipted → rejected`
        //                is the transition the state machine provides for exactly
        //                this, and the terminal reason is the wall's own reason codes.
        //                Routing this through `eventForUnitState('rejected')` would be
        //                wrong: that path derives its reason from the lane decision's
        //                signals, so the ledger would name the qualifier's opinion
        //                instead of the verdict that actually rejected the unit.
        //  * `unknown` — the row is recorded and the unit does **not** advance: it
        //                stays `receipted` so a human decides. Recording a verdict
        //                that does not move the unit is deliberate, not an omission —
        //                `unknown` must never be silently upgraded to verified or
        //                downgraded to rejected.
        if (row.outcome === 'pass') {
          if (canTransition(unit.state, 'verified')) {
            updateUnit(row.unitId, { state: 'verified' }, row.evaluatedAt);
            writeEvent(
              {
                type: 'unit.verified',
                unitId: row.unitId,
                attemptId: row.attemptId,
                verdictId: row.verdictId,
                outcome: 'pass',
              },
              opts,
            );
          }
        } else if (row.outcome === 'fail') {
          if (canTransition(unit.state, 'rejected')) {
            const reason = verdict.reasons.join(',');
            updateUnit(
              row.unitId,
              { state: 'rejected', terminalAt: row.evaluatedAt, terminalReason: reason },
              row.evaluatedAt,
            );
            writeEvent({ type: 'unit.rejected', unitId: row.unitId, reason }, opts);
          }
        }
        const stored = stmt('SELECT * FROM verdicts WHERE verdict_id = ?').get<VerdictDbRow>(
          row.verdictId,
        );
        if (!stored) {
          throw new FactoryError('INTERNAL', `verdict ${row.verdictId} vanished after insert`, {
            verdictId: row.verdictId,
          });
        }
        return mapVerdict(stored);
      });
    },

    latestVerdictForUnit(unitId: string): VerdictRow | null {
      const row = stmt(
        'SELECT * FROM verdicts WHERE unit_id = ? ORDER BY evaluated_at DESC, rowid DESC LIMIT 1',
      ).get<VerdictDbRow>(unitId);
      return row ? mapVerdict(row) : null;
    },

    getVerdict(verdictId: string): VerdictRow | null {
      const row = stmt('SELECT * FROM verdicts WHERE verdict_id = ?').get<VerdictDbRow>(verdictId);
      return row ? mapVerdict(row) : null;
    },

    // --- promotions ----------------------------------------------------------
    insertPromotion(row: {
      promotionId: string;
      unitId: string;
      verdictId: string;
      verdictSha: string;
      promotionSha: string;
      signedBy: string;
      createdAt: string;
    }): void {
      mutate('insertPromotion', () => {
        const unit = requireUnit(row.unitId);
        const verdict = store.getVerdict(row.verdictId);
        if (!verdict) {
          throw new FactoryError(
            'VERDICT_MISSING',
            `promotion ${row.promotionId}: verdict ${row.verdictId} does not exist for unit ${row.unitId}; ` +
              'the wall must record a verdict before a promotion can cite one',
            { promotionId: row.promotionId, unitId: row.unitId, verdictId: row.verdictId },
          );
        }
        if (verdict.unitId !== row.unitId) {
          throw new FactoryError(
            'INTERNAL',
            `promotion ${row.promotionId}: verdict ${row.verdictId} belongs to unit ${verdict.unitId}, not ` +
              `${row.unitId}`,
            { promotionId: row.promotionId, verdictId: row.verdictId },
          );
        }
        if (row.signedBy.trim().length === 0) {
          throw new FactoryError(
            'PROMOTION_UNSIGNED',
            `promotion ${row.promotionId} for unit ${row.unitId} has no signer; the first promotion of any unit ` +
              'is signed by a human, always',
            { promotionId: row.promotionId, unitId: row.unitId },
          );
        }
        // I8: promoting the same (unit, verdict) twice is the same promotion, so a
        // replay returns before the legality guard below (the unit is already
        // terminal by then, which would otherwise refuse the repeat).
        if (store.getPromotion(row.unitId, row.verdictSha)) return;
        // A promotion is an authority act, so it may only advance a unit that can
        // legally reach `promoted` (i.e. one that is `verified`). Writing the row and
        // leaving the unit put would silently discard a human's signature, which is
        // worse than refusing it, and forcing the state would let an unverified unit
        // be promoted — the gate bypass this store exists to prevent.
        if (canTransition(unit.state, 'promoted')) {
          // reachable below
        } else {
          const latest = store.latestVerdictForUnit(row.unitId);
          const code =
            latest?.outcome === 'fail'
              ? 'VERDICT_FAILED'
              : latest?.outcome === 'unknown'
                ? 'VERDICT_UNKNOWN'
                : 'INTERNAL';
          throw new FactoryError(
            code,
            `promotion ${row.promotionId}: unit ${row.unitId} is '${unit.state}', not 'verified'; a promotion can ` +
              `only advance a verified unit (verdict ${row.verdictId} is '${verdict.outcome}')`,
            {
              promotionId: row.promotionId,
              unitId: row.unitId,
              state: unit.state,
              verdictOutcome: verdict.outcome,
            },
          );
        }
        try {
          stmt(
            `INSERT INTO promotions (promotion_id, unit_id, verdict_id, verdict_sha, promotion_sha, signed_by,
               created_at) VALUES (?, ?, ?, ?, ?, ?, ?)`,
          ).run(
            row.promotionId,
            row.unitId,
            row.verdictId,
            row.verdictSha,
            row.promotionSha,
            row.signedBy,
            row.createdAt,
          );
        } catch (error) {
          if (isUniqueError(error)) return; // I8: promoting the same verdict twice is the same promotion
          if (isConstraintError(error)) {
            throw new FactoryError(
              'INTERNAL',
              `promotion ${row.promotionId} was refused by the schema: ` +
                `${error instanceof Error ? error.message : String(error)}`,
              { promotionId: row.promotionId },
            );
          }
          throw error;
        }
        updateUnit(
          row.unitId,
          {
            state: 'promoted',
            terminalAt: row.createdAt,
            terminalReason: `promoted by ${row.signedBy}`,
          },
          row.createdAt,
        );
        writeEvent(
          {
            type: 'unit.promoted',
            unitId: row.unitId,
            verdictId: row.verdictId,
            promotionSha: row.promotionSha,
            signedBy: row.signedBy,
          },
          { actor: row.signedBy, traceId: row.promotionId, occurredAt: row.createdAt },
        );
      });
    },

    getPromotion(unitId: string, verdictSha: string): { promotionId: string } | null {
      const row = stmt(
        'SELECT promotion_id FROM promotions WHERE unit_id = ? AND verdict_sha = ?',
      ).get<{
        promotion_id: string;
      }>(unitId, verdictSha);
      return row ? { promotionId: row.promotion_id } : null;
    },

    // --- spend ---------------------------------------------------------------
    reserveSpend(row: {
      spendId: string;
      unitId: string;
      attemptId: string | null;
      amountUsd: number;
      recordedAt: string;
    }): void {
      mutate('reserveSpend', () => {
        requireUnit(row.unitId);
        if (row.attemptId !== null) requireAttempt(row.attemptId);
        stmt(
          `INSERT INTO spend_ledger (spend_id, unit_id, attempt_id, kind, amount_usd, recorded_at)
             VALUES (?, ?, ?, 'reserved', ?, ?)`,
        ).run(row.spendId, row.unitId, row.attemptId, row.amountUsd, row.recordedAt);
        writeEvent(
          {
            type: 'spend.reserved',
            unitId: row.unitId,
            // The ledger's event vocabulary calls a reservation an "estimate"
            // (the row kind is 'reserved'); an unattributed reserve names that
            // fact rather than inventing an attempt id.
            attemptId: row.attemptId ?? UNATTRIBUTED_ATTEMPT,
            amountUsd: row.amountUsd,
            kind: 'estimate',
          },
          { actor: 'control', traceId: row.spendId, occurredAt: row.recordedAt },
        );
      });
    },

    recordSpend(row: {
      spendId: string;
      unitId: string;
      attemptId: string | null;
      kind: 'estimate' | 'measured' | 'unknown';
      amountUsd: number | null;
      recordedAt: string;
    }): void {
      mutate('recordSpend', () => {
        requireUnit(row.unitId);
        if (row.attemptId !== null) requireAttempt(row.attemptId);
        if (row.kind !== 'unknown' && row.amountUsd === null) {
          throw new FactoryError(
            'INTERNAL',
            `spend ${row.spendId} for unit ${row.unitId} is kind '${row.kind}' with no amount; missing telemetry ` +
              "is kind 'unknown' — never a measured zero",
            { spendId: row.spendId, unitId: row.unitId, kind: row.kind },
          );
        }
        stmt(
          `INSERT INTO spend_ledger (spend_id, unit_id, attempt_id, kind, amount_usd, recorded_at)
             VALUES (?, ?, ?, ?, ?, ?)`,
        ).run(row.spendId, row.unitId, row.attemptId, row.kind, row.amountUsd, row.recordedAt);
        writeEvent(
          {
            type: 'spend.recorded',
            unitId: row.unitId,
            attemptId: row.attemptId ?? UNATTRIBUTED_ATTEMPT,
            amountUsd: row.amountUsd,
            kind: row.kind,
          },
          { actor: 'control', traceId: row.spendId, occurredAt: row.recordedAt },
        );
      });
    },

    spendForUnit(unitId: string): {
      reservedUsd: number;
      recordedUsd: number;
      unknownRows: number;
    } {
      const reserved = stmt(
        "SELECT COALESCE(SUM(amount_usd), 0) AS n FROM spend_ledger WHERE unit_id = ? AND kind = 'reserved'",
      ).get<CountRow>(unitId);
      const recorded = stmt(
        "SELECT COALESCE(SUM(amount_usd), 0) AS n FROM spend_ledger WHERE unit_id = ? AND kind IN ('estimate','measured')",
      ).get<CountRow>(unitId);
      const unknown = stmt(
        "SELECT COUNT(*) AS n FROM spend_ledger WHERE unit_id = ? AND (kind = 'unknown' OR amount_usd IS NULL)",
      ).get<CountRow>(unitId);
      return {
        reservedUsd: Number(reserved?.n ?? 0),
        recordedUsd: Number(recorded?.n ?? 0),
        unknownRows: Number(unknown?.n ?? 0),
      };
    },

    // --- metered usage ------------------------------------------------------
    recordUsage(row: {
      usageId: string;
      unitId: string;
      attemptId: string;
      tokensIn: number;
      tokensOut: number;
      /** `null` when the gateway reported tokens but no price: unknown, never a zero. */
      costUsd: number | null;
      gatewayRequestId: string | null;
      signedAt: string;
      ceilingCrossed: boolean;
    }): UsageRow {
      return mutate('recordUsage', () => {
        requireUnit(row.unitId);
        requireAttempt(row.attemptId);
        // The digest is computed here, from the row as stored, so a later reader can prove the
        // table row and the ledger event are the same fact. It is *not* a signature over a
        // claim the gateway made — that is what `budget reconcile` exists for. Stating the
        // limit in the code is cheaper than a reader discovering it in an incident review.
        const recordSha = contentHash({
          usageId: row.usageId,
          unitId: row.unitId,
          attemptId: row.attemptId,
          tokensIn: row.tokensIn,
          tokensOut: row.tokensOut,
          costUsd: row.costUsd,
          gatewayRequestId: row.gatewayRequestId,
          signedAt: row.signedAt,
          ceilingCrossed: row.ceilingCrossed,
        });
        stmt(
          `INSERT INTO usage_records (usage_id, unit_id, attempt_id, tokens_in, tokens_out, cost_usd,
             gateway_request_id, signed_at, record_sha, ceiling_crossed)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        ).run(
          row.usageId,
          row.unitId,
          row.attemptId,
          row.tokensIn,
          row.tokensOut,
          row.costUsd,
          row.gatewayRequestId,
          row.signedAt,
          recordSha,
          row.ceilingCrossed ? 1 : 0,
        );
        writeEvent(
          {
            type: 'usage.recorded',
            usageId: row.usageId,
            unitId: row.unitId,
            attemptId: row.attemptId,
            tokensIn: row.tokensIn,
            tokensOut: row.tokensOut,
            costUsd: row.costUsd,
            gatewayRequestId: row.gatewayRequestId,
            ceilingCrossed: row.ceilingCrossed,
            recordSha,
          },
          { actor: 'worker-proxy', traceId: row.usageId, occurredAt: row.signedAt },
        );
        return {
          usageId: row.usageId,
          unitId: row.unitId,
          attemptId: row.attemptId,
          tokensIn: row.tokensIn,
          tokensOut: row.tokensOut,
          costUsd: row.costUsd,
          gatewayRequestId: row.gatewayRequestId,
          signedAt: row.signedAt,
          recordSha,
          ceilingCrossed: row.ceilingCrossed,
        };
      });
    },

    usageForAttempt(attemptId: string): readonly UsageRow[] {
      return stmt(
        `SELECT usage_id, unit_id, attempt_id, tokens_in, tokens_out, cost_usd,
                gateway_request_id, signed_at, record_sha, ceiling_crossed
           FROM usage_records WHERE attempt_id = ? ORDER BY signed_at, rowid`,
      )
        .all<UsageRecordRowRow>(attemptId)
        .map(usageFromRow);
    },

    listUsage(): readonly UsageRow[] {
      return stmt(
        `SELECT usage_id, unit_id, attempt_id, tokens_in, tokens_out, cost_usd,
                gateway_request_id, signed_at, record_sha, ceiling_crossed
           FROM usage_records ORDER BY signed_at, rowid`,
      )
        .all<UsageRecordRowRow>()
        .map(usageFromRow);
    },

    usageForUnit(unitId: string): {
      tokensIn: number;
      tokensOut: number;
      costUsd: number;
      unpricedRows: number;
      rows: number;
      ceilingCrossed: boolean;
    } {
      const rows = stmt(
        `SELECT tokens_in, tokens_out, cost_usd, ceiling_crossed FROM usage_records WHERE unit_id = ?`,
      ).all<{
        tokens_in: number;
        tokens_out: number;
        cost_usd: number | null;
        ceiling_crossed: number;
      }>(unitId);
      let tokensIn = 0;
      let tokensOut = 0;
      let costUsd = 0;
      let unpricedRows = 0;
      let crossed = false;
      for (const row of rows) {
        tokensIn += row.tokens_in;
        tokensOut += row.tokens_out;
        if (row.cost_usd === null) unpricedRows += 1;
        else costUsd += row.cost_usd;
        if (row.ceiling_crossed === 1) crossed = true;
      }
      return {
        tokensIn,
        tokensOut,
        costUsd,
        unpricedRows,
        rows: rows.length,
        ceilingCrossed: crossed,
      };
    },

    // --- envelopes -----------------------------------------------------------
    currentEnvelope(scope: 'per-unit' | 'daily'): { envelopeId: string; amountUsd: number } | null {
      const row = stmt(
        'SELECT envelope_id, amount_usd FROM envelopes WHERE scope = ? ORDER BY effective_from DESC, rowid DESC LIMIT 1',
      ).get<{ envelope_id: string; amount_usd: number }>(scope);
      return row ? { envelopeId: row.envelope_id, amountUsd: Number(row.amount_usd) } : null;
    },

    raiseEnvelope(row: {
      envelopeId: string;
      scope: 'per-unit' | 'daily';
      amountUsd: number;
      effectiveFrom: string;
      supersedes: string | null;
      signedBy: string;
      reason: string;
    }): void {
      mutate('raiseEnvelope', () => {
        if (row.signedBy.trim().length === 0 || row.signedBy.startsWith('system:')) {
          throw new FactoryError(
            'GATE_REQUIRED',
            `raising the ${row.scope} envelope to ${row.amountUsd} USD requires a human signature; ` +
              `'${row.signedBy}' is not one — a budget raise is a human gate, never an agent action`,
            { scope: row.scope, signedBy: row.signedBy, envelopeId: row.envelopeId },
          );
        }
        if (row.supersedes !== null) {
          const previous = stmt('SELECT envelope_id FROM envelopes WHERE envelope_id = ?').get<{
            envelope_id: string;
          }>(row.supersedes);
          if (!previous) {
            throw new FactoryError(
              'INTERNAL',
              `envelope ${row.envelopeId} supersedes ${row.supersedes}, which has no amount to raise`,
              { envelopeId: row.envelopeId, supersedes: row.supersedes },
            );
          }
        }
        const previous = store.currentEnvelope(row.scope);
        try {
          stmt(
            `INSERT INTO envelopes (envelope_id, scope, amount_usd, effective_from, supersedes, signed_by, reason)
               VALUES (?, ?, ?, ?, ?, ?, ?)`,
          ).run(
            row.envelopeId,
            row.scope,
            row.amountUsd,
            row.effectiveFrom,
            row.supersedes,
            row.signedBy,
            row.reason,
          );
        } catch (error) {
          if (isConstraintError(error)) {
            throw new FactoryError(
              'INTERNAL',
              `envelope ${row.envelopeId} could not be recorded: ` +
                `${error instanceof Error ? error.message : String(error)}`,
              { envelopeId: row.envelopeId },
            );
          }
          throw error;
        }
        writeEvent(
          {
            type: 'envelope.raised',
            envelopeId: row.envelopeId,
            scope: row.scope,
            fromUsd: previous?.amountUsd ?? 0,
            toUsd: row.amountUsd,
            signedBy: row.signedBy,
            reason: row.reason,
          },
          { actor: row.signedBy, traceId: row.envelopeId, occurredAt: row.effectiveFrom },
        );
      });
    },

    // --- credentials ---------------------------------------------------------
    insertCredential(row: {
      grantId: string;
      repo: string;
      ttlSeconds: number;
      issuedBy: string;
      issuedAt: string;
      expiresAt: string;
    }): void {
      mutate('insertCredential', () => {
        try {
          stmt(
            `INSERT INTO credentials (grant_id, repo, ttl_seconds, issued_by, issued_at, expires_at, revoked_at)
               VALUES (?, ?, ?, ?, ?, ?, NULL)`,
          ).run(row.grantId, row.repo, row.ttlSeconds, row.issuedBy, row.issuedAt, row.expiresAt);
        } catch (error) {
          if (isConstraintError(error)) {
            throw new FactoryError(
              'INTERNAL',
              `credential ${row.grantId} was refused by the schema: ` +
                `${error instanceof Error ? error.message : String(error)} (one repo, at most 3600 s)`,
              { grantId: row.grantId, repo: row.repo },
            );
          }
          throw error;
        }
        writeEvent(
          {
            type: 'credential.issued',
            grantId: row.grantId,
            repo: row.repo,
            ttlSeconds: row.ttlSeconds,
            issuedBy: row.issuedBy,
          },
          { actor: row.issuedBy, traceId: row.grantId, occurredAt: row.issuedAt },
        );
      });
    },

    revokeCredential(grantId: string, at: string): void {
      mutate('revokeCredential', () => {
        const res = stmt(
          'UPDATE credentials SET revoked_at = ? WHERE grant_id = ? AND revoked_at IS NULL',
        ).run(at, grantId);
        if (Number(res.changes) === 0) {
          const exists = stmt('SELECT grant_id FROM credentials WHERE grant_id = ?').get<{
            grant_id: string;
          }>(grantId);
          if (!exists) {
            throw new FactoryError(
              'INTERNAL',
              `credential ${grantId} does not exist; nothing to revoke`,
              {
                grantId,
              },
            );
          }
        }
      });
    },

    // --- effects (outbox) ----------------------------------------------------
    enqueueEffect(row: {
      effectId: string;
      idempotencyKey: string;
      kind: string;
      payload: unknown;
      createdAt: string;
    }): EffectRow {
      return mutate('enqueueEffect', () => {
        const existing = stmt('SELECT * FROM effects WHERE idempotency_key = ?').get<EffectDbRow>(
          row.idempotencyKey,
        );
        if (existing) return mapEffect(existing); // same key → same row; `attempts` untouched
        try {
          stmt(
            `INSERT INTO effects (effect_id, idempotency_key, kind, payload_json, state, attempts, created_at,
               applied_at, last_error) VALUES (?, ?, ?, ?, 'pending', 0, ?, NULL, NULL)`,
          ).run(
            row.effectId,
            row.idempotencyKey,
            row.kind,
            canonicalJson(row.payload),
            row.createdAt,
          );
        } catch (error) {
          if (isUniqueError(error)) {
            const raced = stmt('SELECT * FROM effects WHERE idempotency_key = ?').get<EffectDbRow>(
              row.idempotencyKey,
            );
            if (raced) return mapEffect(raced);
          }
          if (isConstraintError(error)) {
            throw new FactoryError(
              'INTERNAL',
              `effect ${row.effectId} could not be enqueued: ` +
                `${error instanceof Error ? error.message : String(error)}`,
              { effectId: row.effectId, idempotencyKey: row.idempotencyKey },
            );
          }
          throw error;
        }
        const stored = stmt('SELECT * FROM effects WHERE effect_id = ?').get<EffectDbRow>(
          row.effectId,
        );
        if (!stored) {
          throw new FactoryError('INTERNAL', `effect ${row.effectId} vanished after insert`, {
            effectId: row.effectId,
          });
        }
        return mapEffect(stored);
      });
    },

    getEffectByKey(idempotencyKey: string): EffectRow | null {
      const row = stmt('SELECT * FROM effects WHERE idempotency_key = ?').get<EffectDbRow>(
        idempotencyKey,
      );
      return row ? mapEffect(row) : null;
    },

    /**
     * Oldest-first, by creation order.
     *
     * A single-writer control plane is what makes ordering sufficient for v1:
     * the only process that enqueues is also the only process that claims, and it
     * claims inside one transaction, so `created_at` (plus `effect_id` as a
     * tie-break) is a total order over pending work. Per-kind ordering across
     * multiple kinds is therefore a caller concern (group by `kind`), not a
     * scheduling problem this table has to solve — which is why the schema stays
     * as it is, with no priority or sequence column.
     */
    claimPendingEffects(limit: number): EffectRow[] {
      return stmt(
        "SELECT * FROM effects WHERE state = 'pending' ORDER BY created_at ASC, effect_id ASC LIMIT ?",
      )
        .all<EffectDbRow>(limit)
        .map(mapEffect);
    },

    markEffectApplied(effectId: string, at: string): void {
      mutate('markEffectApplied', () => {
        const res = stmt(
          "UPDATE effects SET state = 'applied', applied_at = ?, last_error = NULL WHERE effect_id = ?",
        ).run(at, effectId);
        if (Number(res.changes) === 0) {
          throw new FactoryError(
            'INTERNAL',
            `effect ${effectId} does not exist; cannot mark it applied`,
            {
              effectId,
            },
          );
        }
      });
    },

    /**
     * "Failed once" — retryable. `attempts` increments and `last_error` is
     * recorded, but the effect stays `pending` so the next drain picks it up.
     * Collapsing this into the terminal case would either lose retries or retry
     * forever; the two facts are kept apart on purpose.
     */
    recordEffectFailure(effectId: string, error: string): EffectRow {
      return mutate('recordEffectFailure', () => {
        const res = stmt(
          "UPDATE effects SET attempts = attempts + 1, last_error = ? WHERE effect_id = ? AND state = 'pending'",
        ).run(error, effectId);
        if (Number(res.changes) === 0) {
          const current = stmt('SELECT * FROM effects WHERE effect_id = ?').get<EffectDbRow>(
            effectId,
          );
          if (!current) {
            throw new FactoryError(
              'INTERNAL',
              `effect ${effectId} does not exist; cannot record a failure`,
              {
                effectId,
              },
            );
          }
          throw new FactoryError(
            'INTERNAL',
            `effect ${effectId} is '${current.state}'; a retryable failure can only be recorded while it is ` +
              'pending (an exhausted effect stays exhausted)',
            { effectId, state: current.state },
          );
        }
        const updated = stmt('SELECT * FROM effects WHERE effect_id = ?').get<EffectDbRow>(
          effectId,
        );
        if (!updated) {
          throw new FactoryError(
            'INTERNAL',
            `effect ${effectId} vanished while recording a failure`,
            {
              effectId,
            },
          );
        }
        return mapEffect(updated);
      });
    },

    /**
     * "It will never succeed" — terminal. `attempts` increments, `last_error` is
     * kept, and the state becomes `failed` for good: a `failed` effect is never
     * claimed again and is never deleted (the row is the record of the loss).
     */
    markEffectExhausted(effectId: string, error: string): void {
      mutate('markEffectExhausted', () => {
        const res = stmt(
          "UPDATE effects SET state = 'failed', attempts = attempts + 1, last_error = ? WHERE effect_id = ?",
        ).run(error, effectId);
        if (Number(res.changes) === 0) {
          throw new FactoryError(
            'INTERNAL',
            `effect ${effectId} does not exist; cannot exhaust it`,
            {
              effectId,
            },
          );
        }
      });
    },

    // --- recovery ------------------------------------------------------------
    insertRecoveryRun(row: { recoveryRunId: string; startedAt: string }): void {
      mutate('insertRecoveryRun', () => {
        stmt(
          `INSERT INTO recovery_runs (recovery_run_id, started_at, completed_at, orphaned_attempts, ambiguous)
             VALUES (?, ?, NULL, 0, 0)`,
        ).run(row.recoveryRunId, row.startedAt);
      });
    },

    completeRecoveryRun(
      recoveryRunId: string,
      at: string,
      counts: { orphanedAttempts: number; ambiguous: number },
    ): void {
      mutate('completeRecoveryRun', () => {
        const res = stmt(
          `UPDATE recovery_runs SET completed_at = ?, orphaned_attempts = ?, ambiguous = ?
             WHERE recovery_run_id = ?`,
        ).run(at, counts.orphanedAttempts, counts.ambiguous, recoveryRunId);
        if (Number(res.changes) === 0) {
          throw new FactoryError(
            'INTERNAL',
            `recovery run ${recoveryRunId} does not exist; a report for an unrecorded run is not evidence`,
            { recoveryRunId },
          );
        }
        writeEvent(
          {
            type: 'recovery.completed',
            recoveryRunId,
            orphanedAttempts: counts.orphanedAttempts,
            ambiguous: counts.ambiguous,
          },
          { actor: 'recovery', traceId: recoveryRunId, occurredAt: at },
        );
      });
    },
  };

  // ------------------------------------------------------------------- mappers

  function mapReceipt(row: ReceiptDbRow): ReceiptRow {
    return {
      receiptId: row.receipt_id,
      unitId: row.unit_id,
      attemptId: row.attempt_id,
      receiptSha: row.receipt_sha,
      sessionId: row.session_id,
      exitCode: row.exit_code === null ? null : Number(row.exit_code),
      startedAt: row.started_at,
      endedAt: row.ended_at,
      recordedAt: row.recorded_at,
      receipt: JSON.parse(row.receipt_json) as WorkerReceiptType,
    };
  }

  function mapVerdict(row: VerdictDbRow): VerdictRow {
    const delta = JSON.parse(row.delta_json) as VerdictType['delta'];
    return {
      verdictId: row.verdict_id,
      unitId: row.unit_id,
      attemptId: row.attempt_id,
      receiptId: row.receipt_id,
      receiptSha: row.receipt_sha,
      holdoutRevision: row.holdout_revision,
      policyVersion: row.policy_version,
      wallVersion: row.wall_version,
      outcome: row.outcome,
      evaluatedAt: row.evaluated_at,
      verdict: {
        unitId: row.unit_id,
        attemptId: row.attempt_id,
        // `receipt_sha` is written on every verdict (insertVerdict reconciles it
        // with the verdict body), so an empty value here means a row that did not
        // come from this API.
        receiptSha: row.receipt_sha ?? '',
        holdoutRevision: row.holdout_revision ?? delta.holdoutRevision,
        policyVersion: row.policy_version,
        wallVersion: row.wall_version,
        outcome: row.outcome,
        scenarios: JSON.parse(row.scenarios_json) as VerdictType['scenarios'],
        delta,
        reasons: JSON.parse(row.reasons_json) as VerdictType['reasons'],
        evaluatedAt: row.evaluated_at,
      },
    };
  }

  function mapEffect(row: EffectDbRow): EffectRow {
    return {
      effectId: row.effect_id,
      idempotencyKey: row.idempotency_key,
      kind: row.kind,
      payload: JSON.parse(row.payload_json) as unknown,
      state: row.state,
      attempts: Number(row.attempts),
      createdAt: row.created_at,
      appliedAt: row.applied_at,
      lastError: row.last_error,
    };
  }

  return store;
}
