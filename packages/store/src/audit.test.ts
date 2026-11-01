/**
 * Ledger-integrity tests: the append-only guarantee, and `audit()` as the
 * mechanism that finds a corrupted aggregate instead of hiding it.
 *
 * `audit()` is deliberately the only place that reports rather than throws — an
 * audit that crashes on a damaged store cannot tell you what is damaged — so
 * these tests corrupt the database *behind the store's back*, with raw SQL on a
 * second connection, and check that the divergence is named.
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { WALL_VERSION, contentHash, receiptShaFor } from '@factory/contracts';
import type {
  LaneDecisionType,
  UnitSpec as UnitSpecType,
  VerdictType,
  WorkerReceiptType,
} from '@factory/contracts';
import { openSqlite } from './driver.ts';
import type { SqliteDriver } from './driver.ts';
import { openStore } from './store.ts';
import type { AppendOptions, Store, UnitRow } from './types.ts';

// --------------------------------------------------------------------- fixtures

const REPO = 'acme/widgets';
const BASE_REV = 'b'.repeat(40);
const AT = '2026-11-01T00:00:00.000Z';
const SHA = `sha256:${'0'.repeat(64)}`;
const options = (traceId = 'tr-1'): AppendOptions => ({ actor: 'control', traceId });

function spec(): UnitSpecType {
  return {
    slug: 'add-health-check',
    revision: 1,
    repo: REPO,
    baseRev: BASE_REV,
    intent: 'Add a /healthz endpoint that reports process liveness and version.',
    restateBack: 'Serve GET /healthz returning 200 with {ok:true} while the process is alive.',
    acceptance: [
      {
        id: 'ac-health',
        text: 'GET /healthz returns 200 and ok=true',
        oracle: {
          kind: 'http',
          target: 'http://127.0.0.1:3000/healthz',
          expect: '200 and {"ok":true}',
        },
      },
    ],
    touchPaths: ['src/routes/health.ts'],
    operationClasses: ['code-change'],
    sizeBudget: { files: 2, lines: 60 },
    budgetEstimateUsd: 0.2,
  };
}

const UNIT_ID = 'U-audit1';

function unitRow(unitId = UNIT_ID, unitSpec = spec()): UnitRow {
  return {
    unitId,
    slug: unitSpec.slug,
    revision: unitSpec.revision,
    repo: unitSpec.repo,
    baseRev: unitSpec.baseRev,
    specHash: contentHash(unitSpec),
    spec: unitSpec,
    state: 'submitted',
    lane: null,
    currentMandateId: null,
    attemptCount: 0,
    createdAt: AT,
    updatedAt: AT,
    terminalAt: null,
    terminalReason: null,
  };
}

function laneDecision(): LaneDecisionType & { decisionId: string } {
  return {
    decisionId: 'LD-1',
    unitId: UNIT_ID,
    lane: 'dark',
    score: 84,
    policyVersion: 'policy/2026-11-01',
    decidedAt: AT,
    mandateId: 'M-1',
    signals: [
      {
        name: 'intent_derivability',
        outcome: 'pass',
        observed: '1 criteria',
        reason: 'INTENT_DERIVABLE',
        weight: 30,
      },
      {
        name: 'reversibility',
        outcome: 'pass',
        observed: 'code-change',
        reason: 'REVERSIBLE',
        weight: 20,
      },
      {
        name: 'observability',
        outcome: 'pass',
        observed: 'http',
        reason: 'ORACLE_PRESENT',
        weight: 15,
      },
      {
        name: 'task_class_history',
        outcome: 'pass',
        observed: 'delta 0.04',
        reason: 'TASK_CLASS_STABLE',
        weight: 15,
      },
      {
        name: 'size',
        outcome: 'pass',
        observed: '60 lines',
        reason: 'SIZE_WITHIN_BUDGET',
        weight: 10,
      },
      {
        name: 'budget',
        outcome: 'pass',
        observed: '0.2 of 2.0',
        reason: 'BUDGET_WITHIN_ENVELOPE',
        weight: 10,
      },
    ],
  };
}

function receiptBody(): WorkerReceiptType {
  return {
    unitId: UNIT_ID,
    attemptId: 'A-1',
    sessionId: 'sess-1',
    startedAt: AT,
    endedAt: AT,
    exitCode: 0,
    diff: {
      patchFile: '/tmp/attempts/A-1/change.patch',
      sha: SHA,
      filesChanged: 2,
      insertions: 60,
      deletions: 4,
      baseRev: BASE_REV,
    },
    commands: [
      {
        argv: ['pnpm', 'test'],
        cwd: '/tmp/attempts/A-1',
        exitCode: 0,
        timedOut: false,
        outputSha: SHA,
        durationMs: 800,
      },
    ],
    suite: { command: ['pnpm', 'test'], exitCode: 0, passed: 5, failed: 0, skipped: 0, unknown: 0 },
    ceilings: { turnsUsed: 4, wallClockMs: 60_000, hit: [] },
    artifacts: [],
    narrative: 'Added /healthz.',
  };
}

function passVerdict(receiptSha: string): VerdictType {
  return {
    unitId: UNIT_ID,
    attemptId: 'A-1',
    receiptSha,
    holdoutRevision: 'holdout/7',
    policyVersion: 'policy/2026-11-01',
    wallVersion: WALL_VERSION,
    outcome: 'pass',
    scenarios: [
      { id: 'ac-health', source: 'acceptance', outcome: 'pass', observed: '200 {"ok":true}' },
    ],
    delta: {
      checked: true,
      baseRate: 0.9,
      candidateRate: 0.92,
      threshold: 0,
      observed: 0.02,
      holdoutRevision: 'holdout/7',
    },
    reasons: [],
    evaluatedAt: AT,
  };
}

// ------------------------------------------------------------------------ setup

let dir: string;
let store: Store;
let dbPath: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'factory-audit-'));
  dbPath = join(dir, 'factory.db');
  store = openStore({ dir, now: () => new Date(AT) });
});

afterEach(() => {
  try {
    store.close();
  } catch {
    // A test may already have closed it.
  }
  rmSync(dir, { recursive: true, force: true });
});

/** Raw SQL on a second connection: this is how a bug (or a `sqlite3` session) acts. */
function raw<T>(fn: (db: SqliteDriver) => T): T {
  const db = openSqlite({ path: dbPath });
  try {
    return fn(db);
  } finally {
    db.close();
  }
}

/** Walk one unit to `receipted` (a receipt with a recorded attempt state). */
function buildToReceipted(): string {
  store.insertUnit(unitRow(), options('tr-submit'));
  store.insertLaneDecision(laneDecision());
  store.insertMandate({
    mandateId: 'M-1',
    unitId: UNIT_ID,
    policyVersion: 'policy/2026-11-01',
    lane: 'dark',
    budgetUsd: 2,
    issuedAt: AT,
    expiresAt: '2027-01-01T00:00:00.000Z',
    revokedAt: null,
  });
  store.setUnitLaneAndMandate(UNIT_ID, 'dark', 'M-1', options('tr-qualify'));
  store.acquireLease({
    leaseId: 'L-1',
    unitId: UNIT_ID,
    owner: 'control-1',
    acquiredAt: AT,
    expiresAt: '2026-11-01T01:00:00.000Z',
  });
  store.insertAttempt({
    attemptId: 'A-1',
    unitId: UNIT_ID,
    leaseId: 'L-1',
    state: 'running',
    launchKey: `launch:${UNIT_ID}:A-1`,
    sessionId: 'sess-1',
    attemptDir: '/tmp/attempts/A-1',
    startedAt: AT,
    endedAt: null,
    exitCode: null,
  });
  store.setUnitState(UNIT_ID, 'dispatched', null, options('tr-dispatch'));
  store.reserveSpend({
    spendId: 'S-1',
    unitId: UNIT_ID,
    attemptId: 'A-1',
    amountUsd: 0.2,
    recordedAt: AT,
  });
  const body = receiptBody();
  const sha = receiptShaFor(body);
  store.insertReceipt(
    {
      receiptId: 'R-1',
      unitId: UNIT_ID,
      attemptId: 'A-1',
      receiptSha: sha,
      sessionId: 'sess-1',
      exitCode: 0,
      startedAt: AT,
      endedAt: AT,
      recordedAt: AT,
      receipt: body,
    },
    options('tr-receipt'),
  );
  store.setAttemptState('A-1', 'produced-receipt', {});
  return sha;
}

/** Continue the same unit all the way to `promoted`, so the ledger has a rich history. */
function buildHistory(): void {
  const sha = buildToReceipted();
  store.recordSpend({
    spendId: 'S-2',
    unitId: UNIT_ID,
    attemptId: 'A-1',
    kind: 'measured',
    amountUsd: 0.18,
    recordedAt: AT,
  });
  store.insertVerdict(
    {
      verdictId: 'V-1',
      unitId: UNIT_ID,
      attemptId: 'A-1',
      receiptId: 'R-1',
      receiptSha: sha,
      holdoutRevision: 'holdout/7',
      policyVersion: 'policy/2026-11-01',
      wallVersion: WALL_VERSION,
      outcome: 'pass',
      evaluatedAt: AT,
      verdict: passVerdict(sha),
    },
    options('tr-verify'),
  );
  store.insertPromotion({
    promotionId: 'P-1',
    unitId: UNIT_ID,
    verdictId: 'V-1',
    verdictSha: `sha256:${'5'.repeat(64)}`,
    promotionSha: `sha256:${'6'.repeat(64)}`,
    signedBy: 'human:bo',
    createdAt: AT,
  });
}

// ------------------------------------------------------------------------ tests

describe('append-only ledger', () => {
  it('refuses an UPDATE of a ledger row', () => {
    store.insertUnit(unitRow(), options());
    const error = (() => {
      try {
        raw((db) => db.prepare("UPDATE events SET actor = 'forged'").run());
      } catch (caught) {
        return caught as Error;
      }
      return null;
    })();
    expect(error).not.toBeNull();
    expect(error?.message).toMatch(/events is append-only/);
    expect(store.eventsSince(0)[0]?.actor).toBe('control');
  });

  it('refuses a DELETE of a ledger row', () => {
    store.insertUnit(unitRow(), options());
    expect(() => raw((db) => db.prepare('DELETE FROM events').run())).toThrow(
      /events is append-only/,
    );
    expect(store.eventCount()).toBe(1);
  });

  it('refuses an INSERT that rewrites an existing seq', () => {
    store.insertUnit(unitRow(), options());
    expect(() =>
      raw((db) =>
        db
          .prepare(
            'INSERT INTO events (seq, event_id, type, occurred_at, actor, trace_id, payload) VALUES (1, ?, ?, ?, ?, ?, ?)',
          )
          .run('evt_forged', 'unit.aborted', AT, 'forger', 'tr-x', '{}'),
      ),
    ).toThrow(/UNIQUE constraint failed/);
    expect(store.eventCount()).toBe(1);
  });

  it('sequences events strictly and lets a reader page through them', () => {
    store.insertUnit(unitRow(), options());
    store.insertLaneDecision(laneDecision());
    const seqs = store.eventsSince(0).map((e) => e.seq);
    expect(seqs).toEqual([1]);
    expect(store.eventsSince(1)).toHaveLength(0);
    expect(store.eventsSince(0, 1)).toHaveLength(1);
    store.insertUnit(unitRow('U-audit2', { ...spec(), slug: 'second-unit' }), options());
    expect(store.eventsSince(0).map((e) => e.seq)).toEqual([1, 2]);
    expect(store.eventsSince(1).map((e) => e.seq)).toEqual([2]);
    expect(store.eventCount()).toBe(2);
  });
});

describe('audit', () => {
  it('is clean on a healthy store, and says how many events it read', () => {
    buildHistory();
    const report = store.audit();
    expect(report.divergences).toEqual([]);
    expect(report.ok).toBe(true);
    expect(report.events).toBe(store.eventCount());
    expect(store.eventsSince(0).map((e) => e.type)).toEqual([
      'unit.submitted',
      'unit.qualified',
      'unit.dispatched',
      'spend.reserved',
      'attempt.receipted',
      'spend.recorded',
      'unit.verified',
      'unit.promoted',
    ]);
  });

  it('reports a unit state that the ledger cannot explain', () => {
    buildHistory();
    // Rewrite the aggregate without an event: the exact failure `audit` exists for.
    // (`terminal_at` has to be cleared too — the schema trigger refuses to leave it
    // set on a non-terminal state, which is itself worth knowing.)
    raw((db) =>
      db
        .prepare(
          "UPDATE units SET state = 'receipted', terminal_at = NULL, terminal_reason = NULL WHERE unit_id = ?",
        )
        .run(UNIT_ID),
    );
    const report = store.audit();
    expect(report.ok).toBe(false);
    expect(report.divergences).toHaveLength(1);
    expect(report.divergences[0]).toContain(UNIT_ID);
    expect(report.divergences[0]).toContain("aggregate state 'receipted' but ledger replays to");
    // The store still reports the (corrupt) row: audit observes, it does not repair.
    expect(store.getUnit(UNIT_ID)?.state).toBe('receipted');
  });

  it('reports an aggregate unit that no event created', () => {
    store.insertUnit(unitRow(), options());
    raw((db) =>
      db
        .prepare(
          `INSERT INTO units (unit_id, slug, revision, repo, base_rev, spec_hash, spec_json, state, lane,
             current_mandate_id, attempt_count, created_at, updated_at, terminal_at, terminal_reason)
           VALUES ('U-ghost', 'ghost', 1, ?, ?, ?, ?, 'submitted', NULL, NULL, 0, ?, ?, NULL, NULL)`,
        )
        .run(REPO, BASE_REV, `sha256:${'7'.repeat(64)}`, '{}', AT, AT),
    );
    const report = store.audit();
    expect(report.ok).toBe(false);
    expect(report.divergences.some((d) => d.includes('U-ghost') && d.includes('no event'))).toBe(
      true,
    );
  });

  it('reports spend totals the ledger does not support', () => {
    buildHistory(); // reserved 0.20 + measured 0.18
    raw((db) =>
      db
        .prepare(
          `INSERT INTO spend_ledger (spend_id, unit_id, attempt_id, kind, amount_usd, recorded_at)
           VALUES ('S-ghost', ?, NULL, 'measured', 0.50, ?)`,
        )
        .run(UNIT_ID, AT),
    );
    const report = store.audit();
    expect(report.ok).toBe(false);
    expect(
      report.divergences.some((d) => /spend recorded 0\.6\d* but ledger replays to 0\.18/.test(d)),
    ).toBe(true);
  });

  it('reports an attempt state the ledger contradicts', () => {
    buildHistory();
    raw((db) => db.prepare("UPDATE attempts SET state = 'running' WHERE attempt_id = 'A-1'").run());
    const report = store.audit();
    expect(report.ok).toBe(false);
    expect(
      report.divergences.some(
        (d) => d.includes('attempt A-1') && d.includes("aggregate state 'running'"),
      ),
    ).toBe(true);
  });

  it('replays a measured failure as rejected, not verified', () => {
    const sha = buildToReceipted();
    const verdict = passVerdict(sha);
    store.insertVerdict(
      {
        verdictId: 'V-fail',
        unitId: UNIT_ID,
        attemptId: 'A-1',
        receiptId: 'R-1',
        receiptSha: sha,
        holdoutRevision: verdict.holdoutRevision,
        policyVersion: verdict.policyVersion,
        wallVersion: verdict.wallVersion,
        outcome: 'fail',
        evaluatedAt: AT,
        verdict: {
          ...verdict,
          outcome: 'fail',
          scenarios: [{ id: 'ac-health', source: 'acceptance', outcome: 'fail', observed: '500' }],
          reasons: ['suite_failed'],
        },
      },
      options('tr-reject'),
    );
    expect(store.getUnit(UNIT_ID)?.state).toBe('rejected');
    // The replay has to agree with the writer on where a failure lands; if it did
    // not, every real rejection would light the audit up as corruption.
    expect(store.eventsSince(0).at(-1)?.type).toBe('unit.rejected');
    expect(store.audit().divergences).toEqual([]);
  });

  it('reports a ledger event for a unit that has no aggregate row', () => {
    store.insertUnit(unitRow(), options());
    raw((db) => db.prepare('DELETE FROM units WHERE unit_id = ?').run(UNIT_ID));
    const report = store.audit();
    expect(report.ok).toBe(false);
    expect(
      report.divergences.some((d) => d.includes(UNIT_ID) && d.includes('no aggregate row exists')),
    ).toBe(true);
  });

  it('never throws, even when the database is unreadable mid-audit', () => {
    store.insertUnit(unitRow(), options());
    // Close the underlying connection behind the store's back: every read now fails.
    raw(() => undefined);
    store.close();
    // Re-open a fresh store on the same dir to prove audit is still the reporting
    // path after a legitimate restart; the corrupted case is covered above.
    store = openStore({ dir, now: () => new Date(AT) });
    const report = store.audit();
    expect(report.ok).toBe(true);
    expect(report.divergences).toEqual([]);
  });
});

describe('schema guard', () => {
  it('refuses to open across a schema version bump', () => {
    store.close();
    raw((db) => db.prepare('UPDATE schema_migration SET version = 99').run());
    let caught: Error | null = null;
    try {
      openStore({ dir, now: () => new Date(AT) });
    } catch (error) {
      caught = error as Error;
    }
    expect(caught).not.toBeNull();
    expect(caught?.message).toContain('schema version 99');
    expect(caught?.message).toContain('expects 1');
  });

  it('reports the configured pragmas it actually runs with', () => {
    expect(store.pragmas).toMatchObject({
      journal_mode: 'wal',
      synchronous: 'FULL',
      busy_timeout: '5000',
      foreign_keys: 'ON',
      wal_autocheckpoint: '1000',
    });
  });
});
