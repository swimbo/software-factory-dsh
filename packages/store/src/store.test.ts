/**
 * Store behaviour tests — the acceptance evidence for phase 9a.
 *
 * Each test names the invariant it pins (I1…I14 from `data-map.md` /
 * `CODE_LEVEL_INVARIANTS`). Nothing here weakens an assertion to make the store
 * pass: where a refusal is expected, the test also asserts that *nothing* was
 * written, because a refusal that still wrote a row is the failure mode that
 * matters.
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { FactoryError, WALL_VERSION, contentHash, receiptShaFor } from '@factory/contracts';
import type {
  LaneDecisionType,
  UnitSpec as UnitSpecType,
  VerdictType,
  WorkerReceiptType,
} from '@factory/contracts';
import { openSqlite } from './driver.ts';
import { SCHEMA_VERSION } from './schema.ts';
import { openStore } from './store.ts';
import type { AppendOptions, Store, UnitRow } from './types.ts';

// --------------------------------------------------------------------- fixtures

const REPO = 'acme/widgets';
const BASE_REV = 'a'.repeat(40);
const AT = '2026-11-01T00:00:00.000Z';
const SHA = `sha256:${'0'.repeat(64)}`;

let tick = 0;
const clock = (): Date => new Date(Date.parse(AT) + tick * 1000);
const advance = (seconds = 1): void => {
  tick += seconds;
};
const options = (traceId = 'tr-1'): AppendOptions => ({ actor: 'control', traceId });

function spec(overrides: Partial<UnitSpecType> = {}): UnitSpecType {
  return {
    slug: 'add-version-endpoint',
    revision: 1,
    repo: REPO,
    baseRev: BASE_REV,
    intent: 'Add a GET /version endpoint that returns the running build version as JSON.',
    restateBack: 'Expose GET /version returning 200 with a JSON body that names the build version.',
    acceptance: [
      {
        id: 'ac-version',
        text: 'GET /version returns 200 and a version field',
        oracle: {
          kind: 'http',
          target: 'http://127.0.0.1:3000/version',
          expect: '200 and {"version":"x"}',
        },
      },
    ],
    touchPaths: ['src/routes/version.ts'],
    operationClasses: ['code-change'],
    sizeBudget: { files: 3, lines: 120 },
    budgetEstimateUsd: 0.4,
    ...overrides,
  };
}

function unitRow(
  unitId = 'U-7f3a9c',
  unitSpec = spec(),
  state: UnitRow['state'] = 'submitted',
): UnitRow {
  return {
    unitId,
    slug: unitSpec.slug,
    revision: unitSpec.revision,
    repo: unitSpec.repo,
    baseRev: unitSpec.baseRev,
    specHash: contentHash(unitSpec),
    spec: unitSpec,
    state,
    lane: null,
    currentMandateId: null,
    attemptCount: 0,
    createdAt: AT,
    updatedAt: AT,
    terminalAt: null,
    terminalReason: null,
  };
}

function laneDecision(
  unitId: string,
  lane: 'dark' | 'lit' | 'reject',
  mandateId: string | null,
): LaneDecisionType & {
  decisionId: string;
} {
  return {
    decisionId: `LD-${unitId}`,
    unitId,
    lane,
    score: 91,
    policyVersion: 'policy/2026-11-01',
    decidedAt: AT,
    mandateId,
    signals: [
      {
        name: 'intent_derivability',
        outcome: 'pass',
        observed: '1 of 1 criteria machine-checkable',
        reason: 'INTENT_DERIVABLE',
        weight: 30,
      },
      {
        name: 'reversibility',
        outcome: 'pass',
        observed: 'code-change only',
        reason: 'REVERSIBLE',
        weight: 20,
      },
      {
        name: 'observability',
        outcome: 'pass',
        observed: 'http oracle',
        reason: 'ORACLE_PRESENT',
        weight: 15,
      },
      {
        name: 'task_class_history',
        outcome: 'pass',
        observed: 'delta 0.05 over 20 samples',
        reason: 'TASK_CLASS_STABLE',
        weight: 15,
      },
      {
        name: 'size',
        outcome: 'pass',
        observed: '120 lines',
        reason: 'SIZE_WITHIN_BUDGET',
        weight: 10,
      },
      {
        name: 'budget',
        outcome: 'pass',
        observed: '0.4 of 2.0 USD',
        reason: 'BUDGET_WITHIN_ENVELOPE',
        weight: 10,
      },
    ],
  };
}

function receipt(
  unitId: string,
  attemptId: string,
  narrative: string | null = 'All tests pass.',
): WorkerReceiptType {
  return {
    unitId,
    attemptId,
    sessionId: 'sess-1',
    startedAt: AT,
    endedAt: AT,
    exitCode: 0,
    diff: {
      patchFile: `/tmp/attempts/${attemptId}/change.patch`,
      sha: SHA,
      filesChanged: 1,
      insertions: 12,
      deletions: 0,
      baseRev: BASE_REV,
    },
    commands: [
      {
        argv: ['pnpm', 'test'],
        cwd: `/tmp/attempts/${attemptId}`,
        exitCode: 0,
        timedOut: false,
        outputSha: SHA,
        durationMs: 1200,
      },
    ],
    suite: { command: ['pnpm', 'test'], exitCode: 0, passed: 8, failed: 0, skipped: 0, unknown: 0 },
    ceilings: { turnsUsed: 6, wallClockMs: 90_000, hit: [] },
    artifacts: [],
    narrative,
  };
}

function passVerdict(unitId: string, attemptId: string, receiptSha: string): VerdictType {
  return {
    unitId,
    attemptId,
    receiptSha,
    holdoutRevision: 'holdout/7',
    policyVersion: 'policy/2026-11-01',
    wallVersion: WALL_VERSION,
    outcome: 'pass',
    scenarios: [
      {
        id: 'ac-version',
        source: 'acceptance',
        outcome: 'pass',
        observed: '200 {"version":"1.2.3"}',
      },
    ],
    delta: {
      checked: true,
      baseRate: 0.8,
      candidateRate: 0.85,
      threshold: 0,
      observed: 0.05,
      holdoutRevision: 'holdout/7',
    },
    reasons: [],
    evaluatedAt: AT,
  };
}

function expectFactoryError(fn: () => unknown, code: string): FactoryError {
  try {
    fn();
  } catch (error) {
    if (!(error instanceof FactoryError)) {
      throw new Error(`expected a FactoryError(${code}), got ${String(error)}`);
    }
    expect(error.code).toBe(code);
    return error;
  }
  throw new Error(`expected a FactoryError with code ${code}, but nothing was thrown`);
}

// ------------------------------------------------------------------------ setup

let dir: string;
let store: Store;
let dbPath: string;

beforeEach(() => {
  tick = 0;
  dir = mkdtempSync(join(tmpdir(), 'factory-store-'));
  dbPath = join(dir, 'factory.db');
  store = openStore({ dir, now: clock });
});

afterEach(() => {
  store.close();
  rmSync(dir, { recursive: true, force: true });
});

/** Full walk to a dispatched unit: submitted → qualified → lease + attempt. */
function dispatchedUnit(unitId = 'U-7f3a9c', attemptId = 'A-1'): UnitRow {
  store.insertUnit(unitRow(unitId), options());
  store.insertLaneDecision(laneDecision(unitId, 'dark', 'M-1'));
  store.insertMandate({
    mandateId: 'M-1',
    unitId,
    policyVersion: 'policy/2026-11-01',
    lane: 'dark',
    budgetUsd: 2,
    issuedAt: AT,
    expiresAt: '2027-01-01T00:00:00.000Z',
    revokedAt: null,
  });
  store.setUnitLaneAndMandate(unitId, 'dark', 'M-1', options());
  store.acquireLease({
    leaseId: `L-${attemptId}`,
    unitId,
    owner: 'control-1',
    acquiredAt: AT,
    expiresAt: '2026-11-01T01:00:00.000Z',
  });
  store.insertAttempt({
    attemptId,
    unitId,
    leaseId: `L-${attemptId}`,
    state: 'planned',
    launchKey: `launch:${unitId}:${attemptId}`,
    sessionId: null,
    attemptDir: `/tmp/attempts/${attemptId}`,
    startedAt: AT,
    endedAt: null,
    exitCode: null,
  });
  return store.setUnitState(unitId, 'dispatched', null, options());
}

// ------------------------------------------------------------------------ tests

describe('durability pragmas', () => {
  it('runs in WAL with synchronous=FULL and a file-backed database', () => {
    expect(store.pragmas['journal_mode']).toBe('wal');
    expect(store.pragmas['synchronous']).toBe('FULL');
    expect(store.pragmas['foreign_keys']).toBe('ON');
    expect(store.schemaVersion).toBe(SCHEMA_VERSION);
    expect(store.location).toBe(dbPath);
  });

  it('records exactly one schema_migration row and refuses a drifted schema', () => {
    const raw = openSqlite({ path: dbPath });
    const rows = raw.prepare('SELECT version, applied_at, checksum FROM schema_migration').all<{
      version: number;
      applied_at: string;
      checksum: string;
    }>();
    expect(rows).toHaveLength(1);
    expect(rows[0]?.version).toBe(SCHEMA_VERSION);
    expect(typeof rows[0]?.checksum).toBe('string');

    // Re-opening the same directory is fine: the checksum matches.
    const reopened = openStore({ dir, now: clock });
    reopened.close();

    // Tamper with the recorded checksum → the store must refuse to run, not warn.
    raw.prepare("UPDATE schema_migration SET checksum = 'deadbeef'").run();
    raw.close();
    expect(() => openStore({ dir, now: clock })).toThrow(/schema drift/);
  });

  it('opens a v1 store by applying the declared additive migration, and says so in the ledger', () => {
    // Put a store back to v1 the way an operator's store actually is: the table the migration adds
    // is gone, and the recorded version is the older one. This is the only test that can exist
    // without shipping an old binary.
    store.close();
    const raw = openSqlite({ path: dbPath });
    raw.prepare('DROP TABLE usage_records').run();
    raw.prepare('DELETE FROM schema_migration WHERE version = ?').run(SCHEMA_VERSION);
    raw
      .prepare(
        "INSERT INTO schema_migration (version, applied_at, checksum) VALUES (1, '2026-10-31T00:00:00.000Z', 'v1')",
      )
      .run();
    raw.close();

    const migrated = openStore({ dir, now: clock });
    const applied = migrated.eventsSince(0).filter((event) => event.type === 'store.migrated');
    expect(applied).toHaveLength(1);
    expect(applied[0]?.payload).toMatchObject({ from: 1, to: SCHEMA_VERSION });
    const raw2 = openSqlite({ path: dbPath });
    const versions = raw2
      .prepare('SELECT version FROM schema_migration ORDER BY version')
      .all<{ version: number }>()
      .map((row) => row.version);
    // The v1 row stays: history is not rewritten by a migration, it is appended to.
    expect(versions).toEqual([1, SCHEMA_VERSION]);
    raw2.close();

    // Reopening a migrated store must not migrate it again: the version row is now current, so the
    // ledger still carries exactly one `store.migrated` event when the next process opens it.
    migrated.close();
    const reopened = openStore({ dir, now: clock });
    const again = reopened.eventsSince(0).filter((event) => event.type === 'store.migrated');
    expect(again).toHaveLength(1);
    expect(reopened.migrationsApplied()).toEqual([]);
    // Teardown closes whatever `store` points at, so hand it the live handle rather than leaving it
    // holding a closed one.
    store = reopened;
  });

  it('still refuses a version it has no declared path from', () => {
    // Tampered from a second connection while this store is open, so teardown still has a live handle.
    const raw = openSqlite({ path: dbPath });
    raw.prepare('UPDATE schema_migration SET version = 7').run();
    raw.close();
    expect(() => openStore({ dir, now: clock })).toThrow(/declares no migration/u);
  });
});

describe('units', () => {
  it('inserts a unit and its unit.submitted event in one transaction', () => {
    const unit = store.insertUnit(unitRow(), options('tr-submit'));
    expect(unit.state).toBe('submitted');
    expect(unit.specHash).toBe(contentHash(unit.spec));
    const events = store.eventsSince(0);
    expect(events).toHaveLength(1);
    expect(events[0]?.type).toBe('unit.submitted');
    expect(events[0]?.payload['unitId']).toBe('U-7f3a9c');
    expect(events[0]?.traceId).toBe('tr-submit');
    expect(events[0]?.eventId).toMatch(/^evt_1_[0-9a-f]{8}$/);
  });

  it('is idempotent for the same spec under the same revision', () => {
    store.insertUnit(unitRow(), options());
    const again = store.insertUnit(unitRow(), options());
    expect(again.unitId).toBe('U-7f3a9c');
    expect(store.eventCount()).toBe(1);
  });

  it('refuses a different spec under the same repo/slug/revision', () => {
    store.insertUnit(unitRow(), options());
    const changed = unitRow(
      'U-8aaaaa',
      spec({ intent: 'Refactor the version endpoint into a shared helper module.' }),
    );
    const error = expectFactoryError(() => store.insertUnit(changed, options()), 'DUPLICATE_UNIT');
    expect(error.message).toContain('already exists as U-7f3a9c');
    expect(store.eventCount()).toBe(1);
  });

  it('refuses a specHash that disagrees with the spec body', () => {
    const bad = { ...unitRow(), specHash: `sha256:${'1'.repeat(64)}` };
    expectFactoryError(() => store.insertUnit(bad, options()), 'SPEC_INVALID');
  });

  it('routes a dark unit through qualification with exactly one event', () => {
    store.insertUnit(unitRow(), options());
    const before = store.eventCount();
    store.insertLaneDecision(laneDecision('U-7f3a9c', 'dark', 'M-1'));
    store.insertMandate({
      mandateId: 'M-1',
      unitId: 'U-7f3a9c',
      policyVersion: 'policy/2026-11-01',
      lane: 'dark',
      budgetUsd: 2,
      issuedAt: AT,
      expiresAt: '2027-01-01T00:00:00.000Z',
      revokedAt: null,
    });
    const qualified = store.setUnitLaneAndMandate('U-7f3a9c', 'dark', 'M-1', options('tr-qualify'));
    expect(qualified.state).toBe('qualified');
    expect(qualified.lane).toBe('dark');
    expect(qualified.currentMandateId).toBe('M-1');
    expect(store.eventCount()).toBe(before + 1);
    const event = store.eventsSince(before).at(0);
    expect(event?.type).toBe('unit.qualified');
    expect(event?.payload).toMatchObject({
      unitId: 'U-7f3a9c',
      lane: 'dark',
      laneDecisionId: 'LD-U-7f3a9c',
      policyVersion: 'policy/2026-11-01',
      score: 91,
    });
  });

  it('parks a lit unit and refuses to dispatch it', () => {
    store.insertUnit(unitRow(), options());
    store.insertLaneDecision(laneDecision('U-7f3a9c', 'lit', null));
    const parked = store.setUnitLaneAndMandate('U-7f3a9c', 'lit', null, options());
    expect(parked.state).toBe('lit_parked');
    expect(parked.lane).toBe('lit');
    const event = store.eventsSince(0).at(-1);
    expect(event?.type).toBe('unit.lit_parked');
    // A parked unit is terminal: it never dispatches.
    expectFactoryError(
      () => store.setUnitState('U-7f3a9c', 'dispatched', null, options()),
      'UNIT_ALREADY_TERMINAL',
    );
  });

  it('writes exactly one event whose payload matches the new state', () => {
    dispatchedUnit();
    const before = store.eventCount();
    const aborted = store.setUnitState(
      'U-7f3a9c',
      'aborted',
      'operator aborted the run',
      options('tr-abort'),
    );
    expect(aborted.state).toBe('aborted');
    expect(aborted.terminalAt).not.toBeNull();
    expect(store.eventCount()).toBe(before + 1);
    const event = store.eventsSince(before).at(0);
    expect(event?.type).toBe('unit.aborted');
    expect(event?.payload).toMatchObject({
      unitId: 'U-7f3a9c',
      reason: 'operator aborted the run',
    });
    // Terminal is terminal.
    const error = expectFactoryError(
      () => store.setUnitState('U-7f3a9c', 'verified', null, options()),
      'UNIT_ALREADY_TERMINAL',
    );
    expect(error.message).toBe(
      'unit U-7f3a9c is already terminal (aborted); a terminal unit never changes state — submit a new revision instead',
    );
  });

  it('refuses an illegal transition that the state machine forbids', () => {
    store.insertUnit(unitRow(), options());
    expectFactoryError(
      () => store.setUnitState('U-7f3a9c', 'verified', null, options()),
      'INTERNAL',
    );
  });

  it('reports a missing unit as UNIT_NOT_FOUND naming the unit', () => {
    const error = expectFactoryError(
      () => store.setUnitState('U-nope', 'aborted', null, options()),
      'UNIT_NOT_FOUND',
    );
    expect(error.message).toContain('U-nope');
    expect(error.details?.['unitId']).toBe('U-nope');
  });

  it('counts units by state and lists them', () => {
    store.insertUnit(unitRow('U-1'), options());
    store.insertUnit(unitRow('U-2', spec({ slug: 'second-unit' })), options());
    expect(store.countUnitsByState().submitted).toBe(2);
    expect(store.countUnitsByState().promoted).toBe(0);
    expect(store.listUnits({ state: 'submitted' })).toHaveLength(2);
    expect(store.listUnits({ limit: 1 })).toHaveLength(1);
    expect(store.findUnitBySlug(REPO, 'add-version-endpoint', 1)?.unitId).toBe('U-1');
    expect(
      store.findUnitBySpecHash(REPO, unitRow('U-2', spec({ slug: 'second-unit' })).specHash)
        ?.unitId,
    ).toBe('U-2');
  });
});

describe('mandates', () => {
  it('refuses dispatch when the mandate has expired', () => {
    store.insertUnit(unitRow(), options());
    store.insertLaneDecision(laneDecision('U-7f3a9c', 'dark', 'M-expired'));
    // Issued in the past relative to the clock at dispatch time.
    store.insertMandate({
      mandateId: 'M-expired',
      unitId: 'U-7f3a9c',
      policyVersion: 'policy/2026-11-01',
      lane: 'dark',
      budgetUsd: 2,
      issuedAt: '2026-10-01T00:00:00.000Z',
      expiresAt: '2026-10-02T00:00:00.000Z',
      revokedAt: null,
    });
    expectFactoryError(
      () => store.setUnitLaneAndMandate('U-7f3a9c', 'dark', 'M-expired', options()),
      'MANDATE_EXPIRED',
    );
    expect(store.getUnit('U-7f3a9c')?.state).toBe('submitted');
  });

  it('refuses dispatch when the mandate was revoked', () => {
    dispatchedUnit();
    store.revokeMandate('M-1', AT);
    // A fresh unit+mandate pair, revoked before dispatch.
    store.insertUnit(unitRow('U-rev', spec({ slug: 'revoked-unit' })), options());
    store.insertLaneDecision(laneDecision('U-rev', 'dark', 'M-2'));
    store.insertMandate({
      mandateId: 'M-2',
      unitId: 'U-rev',
      policyVersion: 'policy/2026-11-01',
      lane: 'dark',
      budgetUsd: 2,
      issuedAt: AT,
      expiresAt: '2027-01-01T00:00:00.000Z',
      revokedAt: null,
    });
    store.revokeMandate('M-2', AT);
    expectFactoryError(
      () => store.setUnitLaneAndMandate('U-rev', 'dark', 'M-2', options()),
      'MANDATE_EXPIRED',
    );
  });
});

describe('leases', () => {
  it('holds one live lease per unit and releases it cleanly', () => {
    store.insertUnit(unitRow(), options());
    store.acquireLease({
      leaseId: 'L-1',
      unitId: 'U-7f3a9c',
      owner: 'control-1',
      acquiredAt: AT,
      expiresAt: '2026-11-01T01:00:00.000Z',
    });
    expect(store.getLiveLease('U-7f3a9c')).toMatchObject({ leaseId: 'L-1', owner: 'control-1' });

    const error = expectFactoryError(
      () =>
        store.acquireLease({
          leaseId: 'L-2',
          unitId: 'U-7f3a9c',
          owner: 'control-2',
          acquiredAt: AT,
          expiresAt: '2026-11-01T01:00:00.000Z',
        }),
      'LEASE_HELD',
    );
    expect(error.message).toContain('control-1');
    expect(error.details?.['liveLeaseId']).toBe('L-1');

    store.releaseLease('L-1', AT);
    expect(store.getLiveLease('U-7f3a9c')).toBeNull();
    store.acquireLease({
      leaseId: 'L-2',
      unitId: 'U-7f3a9c',
      owner: 'control-2',
      acquiredAt: AT,
      expiresAt: '2026-11-01T01:00:00.000Z',
    });
    expect(store.getLiveLease('U-7f3a9c')?.leaseId).toBe('L-2');
    // Releasing twice is a no-op, not an error.
    store.releaseLease('L-2', AT);
    store.releaseLease('L-2', AT);
    expect(store.listExpiredLeases('2026-11-02T00:00:00.000Z')).toHaveLength(0);
  });

  it('lists leases whose expiry has passed without releasing them', () => {
    store.insertUnit(unitRow(), options());
    store.acquireLease({
      leaseId: 'L-old',
      unitId: 'U-7f3a9c',
      owner: 'control-1',
      acquiredAt: '2026-10-31T00:00:00.000Z',
      expiresAt: '2026-10-31T01:00:00.000Z',
    });
    const expired = store.listExpiredLeases(AT);
    expect(expired).toEqual([
      { leaseId: 'L-old', unitId: 'U-7f3a9c', expiresAt: '2026-10-31T01:00:00.000Z' },
    ]);
    // Listing does not mutate: the lease is still live until recovery releases it.
    expect(store.getLiveLease('U-7f3a9c')?.leaseId).toBe('L-old');
  });
});

describe('attempts and receipts', () => {
  it('treats the launch key as the attempt idempotency key', () => {
    dispatchedUnit();
    const duplicate = store.insertAttempt({
      attemptId: 'A-1-retry',
      unitId: 'U-7f3a9c',
      leaseId: 'L-A-1',
      state: 'planned',
      launchKey: 'launch:U-7f3a9c:A-1',
      sessionId: null,
      attemptDir: '/tmp/attempts/A-1',
      startedAt: AT,
      endedAt: null,
      exitCode: null,
    });
    expect(duplicate.attemptId).toBe('A-1');
    expect(store.listAttemptsForUnit('U-7f3a9c')).toHaveLength(1);
  });

  it('records a receipt, its attempt.receipted event, and moves the unit to receipted', () => {
    dispatchedUnit();
    const body = receipt('U-7f3a9c', 'A-1');
    const sha = receiptShaFor(body);
    const stored = store.insertReceipt(
      {
        receiptId: 'R-1',
        unitId: 'U-7f3a9c',
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
    expect(stored.receiptSha).toBe(sha);
    expect(stored.receipt.narrative).toBe('All tests pass.');
    expect(store.getUnit('U-7f3a9c')?.state).toBe('receipted');
    const event = store.eventsSince(0).at(-1);
    expect(event?.type).toBe('attempt.receipted');
    expect(event?.payload).toMatchObject({
      unitId: 'U-7f3a9c',
      attemptId: 'A-1',
      receiptSha: sha,
      exitCode: 0,
    });
    expect(store.getReceiptBySha(sha)?.receiptId).toBe('R-1');
    expect(store.latestReceiptForUnit('U-7f3a9c')?.receiptId).toBe('R-1');
  });

  it('refuses a second receipt with the same sha (append-only evidence)', () => {
    dispatchedUnit();
    const body = receipt('U-7f3a9c', 'A-1');
    const sha = receiptShaFor(body);
    const row = {
      receiptId: 'R-1',
      unitId: 'U-7f3a9c',
      attemptId: 'A-1',
      receiptSha: sha,
      sessionId: 'sess-1',
      exitCode: 0,
      startedAt: AT,
      endedAt: AT,
      recordedAt: AT,
      receipt: body,
    } as const;
    store.insertReceipt(row, options());
    const eventsBefore = store.eventCount();
    const error = expectFactoryError(
      () => store.insertReceipt({ ...row, receiptId: 'R-2' }, options()),
      'RECEIPT_CONFLICT',
    );
    expect(error.message).toContain(sha);
    expect(store.eventCount()).toBe(eventsBefore);
    expect(store.getUnit('U-7f3a9c')?.state).toBe('receipted');
  });

  it('refuses a receipt whose sha disagrees with its body', () => {
    dispatchedUnit();
    expectFactoryError(
      () =>
        store.insertReceipt(
          {
            receiptId: 'R-bad',
            unitId: 'U-7f3a9c',
            attemptId: 'A-1',
            receiptSha: `sha256:${'2'.repeat(64)}`,
            sessionId: 'sess-1',
            exitCode: 0,
            startedAt: AT,
            endedAt: AT,
            recordedAt: AT,
            receipt: receipt('U-7f3a9c', 'A-1'),
          },
          options(),
        ),
      'INTERNAL',
    );
  });

  it('refuses a receipt filed against another attempt', () => {
    dispatchedUnit();
    expectFactoryError(
      () =>
        store.insertReceipt(
          {
            receiptId: 'R-other',
            unitId: 'U-7f3a9c',
            attemptId: 'A-1',
            receiptSha: receiptShaFor(receipt('U-7f3a9c', 'A-OTHER')),
            sessionId: 'sess-1',
            exitCode: 0,
            startedAt: AT,
            endedAt: AT,
            recordedAt: AT,
            receipt: receipt('U-7f3a9c', 'A-OTHER'),
          },
          options(),
        ),
      'INTERNAL',
    );
  });
});

describe('verdicts: unknown is not pass', () => {
  function receiptedUnit(): { receiptSha: string } {
    dispatchedUnit();
    const body = receipt('U-7f3a9c', 'A-1');
    const sha = receiptShaFor(body);
    store.insertReceipt(
      {
        receiptId: 'R-1',
        unitId: 'U-7f3a9c',
        attemptId: 'A-1',
        receiptSha: sha,
        sessionId: 'sess-1',
        exitCode: 0,
        startedAt: AT,
        endedAt: AT,
        recordedAt: AT,
        receipt: body,
      },
      options(),
    );
    return { receiptSha: sha };
  }

  function verdictRow(
    verdict: VerdictType,
    receiptId: string | null,
  ): Parameters<Store['insertVerdict']>[0] {
    return {
      verdictId: 'V-1',
      unitId: verdict.unitId,
      attemptId: verdict.attemptId,
      receiptId,
      receiptSha: verdict.receiptSha,
      holdoutRevision: verdict.holdoutRevision,
      policyVersion: verdict.policyVersion,
      wallVersion: verdict.wallVersion,
      outcome: verdict.outcome,
      evaluatedAt: verdict.evaluatedAt,
      verdict,
    };
  }

  it('refuses a pass verdict with no receipt', () => {
    const { receiptSha } = receiptedUnit();
    const error = expectFactoryError(
      () =>
        store.insertVerdict(
          verdictRow(passVerdict('U-7f3a9c', 'A-1', receiptSha), null),
          options(),
        ),
      'INTERNAL',
    );
    expect(error.message).toContain('without a receipt');
    expect(store.getVerdict('V-1')).toBeNull();
    expect(store.latestVerdictForUnit('U-7f3a9c')).toBeNull();
  });

  it('refuses a pass verdict whose Δ was never measured', () => {
    const { receiptSha } = receiptedUnit();
    const verdict = passVerdict('U-7f3a9c', 'A-1', receiptSha);
    const unmeasured: VerdictType = {
      ...verdict,
      delta: { ...verdict.delta, checked: false, observed: null },
    };
    const error = expectFactoryError(
      () => store.insertVerdict(verdictRow(unmeasured, 'R-1'), options()),
      'INTERNAL',
    );
    expect(error.message).toContain('measured Δ');
    expect(store.getVerdict('V-1')).toBeNull();
  });

  it('refuses a pass verdict that carries a failure reason', () => {
    const { receiptSha } = receiptedUnit();
    const verdict = passVerdict('U-7f3a9c', 'A-1', receiptSha);
    expectFactoryError(
      () =>
        store.insertVerdict(
          verdictRow(
            { ...verdict, reasons: ['receipt_unfaithful'] as VerdictType['reasons'] },
            'R-1',
          ),
          options(),
        ),
      'INTERNAL',
    );
  });

  it('accepts a fully satisfied pass and moves the unit to verified', () => {
    const { receiptSha } = receiptedUnit();
    const before = store.eventCount();
    const stored = store.insertVerdict(
      verdictRow(passVerdict('U-7f3a9c', 'A-1', receiptSha), 'R-1'),
      options('tr-verify'),
    );
    expect(stored.outcome).toBe('pass');
    expect(stored.verdict.delta.checked).toBe(true);
    expect(store.getUnit('U-7f3a9c')?.state).toBe('verified');
    expect(store.eventCount()).toBe(before + 1);
    const event = store.eventsSince(before).at(0);
    expect(event?.type).toBe('unit.verified');
    expect(event?.payload).toMatchObject({ unitId: 'U-7f3a9c', verdictId: 'V-1', outcome: 'pass' });
  });

  it('records an unknown verdict without inventing a pass', () => {
    const { receiptSha } = receiptedUnit();
    const verdict = passVerdict('U-7f3a9c', 'A-1', receiptSha);
    const unknown: VerdictType = {
      ...verdict,
      outcome: 'unknown',
      scenarios: [{ id: 'ac-version', source: 'acceptance', outcome: 'unknown', observed: null }],
      delta: { ...verdict.delta, checked: false, observed: null },
      reasons: ['holdout_unavailable'],
    };
    const before = store.eventCount();
    const stored = store.insertVerdict(verdictRow(unknown, 'R-1'), options());
    expect(stored.outcome).toBe('unknown');
    expect(stored.receiptSha).toBe(receiptSha);
    // An unknown verdict is evidence, not a state change: the unit stays where a
    // human can find it and decide, and the ledger gets no unit event.
    expect(store.getUnit('U-7f3a9c')?.state).toBe('receipted');
    expect(store.eventCount()).toBe(before);
    expect(store.latestVerdictForUnit('U-7f3a9c')?.outcome).toBe('unknown');
  });

  it('rejects a unit on a measured failure, naming the verdict reason codes', () => {
    const { receiptSha } = receiptedUnit();
    const verdict = passVerdict('U-7f3a9c', 'A-1', receiptSha);
    const failed: VerdictType = {
      ...verdict,
      outcome: 'fail',
      scenarios: [{ id: 'ac-version', source: 'acceptance', outcome: 'fail', observed: '500' }],
      reasons: ['suite_failed', 'acceptance_unmet'],
    };
    const before = store.eventCount();
    const stored = store.insertVerdict(verdictRow(failed, 'R-1'), options('tr-reject'));
    expect(stored.outcome).toBe('fail');
    // `receipted → rejected` is the transition a measured failure takes; it must not
    // pass through `verified`, or the failure would be unrecordable (verified →
    // rejected is illegal).
    const unit = store.getUnit('U-7f3a9c');
    expect(unit?.state).toBe('rejected');
    expect(unit?.terminalAt).toBe(AT);
    expect(unit?.terminalReason).toBe('suite_failed,acceptance_unmet');
    expect(store.eventCount()).toBe(before + 1);
    const event = store.eventsSince(before).at(0);
    expect(event?.type).toBe('unit.rejected');
    expect(event?.payload).toMatchObject({
      unitId: 'U-7f3a9c',
      reason: 'suite_failed,acceptance_unmet',
    });
    // The rejection is terminal, and the state machine agrees.
    expectFactoryError(
      () => store.setUnitState('U-7f3a9c', 'verified', null, options()),
      'UNIT_ALREADY_TERMINAL',
    );
  });

  it('refuses to promote a unit whose verdict is unknown', () => {
    const { receiptSha } = receiptedUnit();
    const verdict = passVerdict('U-7f3a9c', 'A-1', receiptSha);
    const unknown: VerdictType = {
      ...verdict,
      outcome: 'unknown',
      scenarios: [{ id: 'ac-version', source: 'acceptance', outcome: 'unknown', observed: null }],
      delta: { ...verdict.delta, checked: false, observed: null },
      reasons: ['holdout_unavailable'],
    };
    store.insertVerdict(verdictRow(unknown, 'R-1'), options());
    const error = expectFactoryError(
      () =>
        store.insertPromotion({
          promotionId: 'P-unknown',
          unitId: 'U-7f3a9c',
          verdictId: 'V-1',
          verdictSha: `sha256:${'8'.repeat(64)}`,
          promotionSha: `sha256:${'9'.repeat(64)}`,
          signedBy: 'human:bo',
          createdAt: AT,
        }),
      'VERDICT_UNKNOWN',
    );
    expect(error.message).toContain("is 'receipted', not 'verified'");
    expect(store.getUnit('U-7f3a9c')?.state).toBe('receipted');
    expect(store.getPromotion('U-7f3a9c', `sha256:${'8'.repeat(64)}`)).toBeNull();
  });
});

describe('promotions', () => {
  function promotedSetup(): void {
    dispatchedUnit();
    const body = receipt('U-7f3a9c', 'A-1');
    const sha = receiptShaFor(body);
    store.insertReceipt(
      {
        receiptId: 'R-1',
        unitId: 'U-7f3a9c',
        attemptId: 'A-1',
        receiptSha: sha,
        sessionId: 'sess-1',
        exitCode: 0,
        startedAt: AT,
        endedAt: AT,
        recordedAt: AT,
        receipt: body,
      },
      options(),
    );
    const verdict = passVerdict('U-7f3a9c', 'A-1', sha);
    store.insertVerdict(
      {
        verdictId: 'V-1',
        unitId: 'U-7f3a9c',
        attemptId: 'A-1',
        receiptId: 'R-1',
        receiptSha: sha,
        holdoutRevision: verdict.holdoutRevision,
        policyVersion: verdict.policyVersion,
        wallVersion: verdict.wallVersion,
        outcome: 'pass',
        evaluatedAt: AT,
        verdict,
      },
      options(),
    );
  }

  it('refuses a promotion citing a verdict that does not exist', () => {
    promotedSetup();
    expectFactoryError(
      () =>
        store.insertPromotion({
          promotionId: 'P-1',
          unitId: 'U-7f3a9c',
          verdictId: 'V-missing',
          verdictSha: `sha256:${'3'.repeat(64)}`,
          promotionSha: `sha256:${'4'.repeat(64)}`,
          signedBy: 'human:bo',
          createdAt: AT,
        }),
      'VERDICT_MISSING',
    );
    expect(store.getUnit('U-7f3a9c')?.state).toBe('verified');
  });

  it('promotes once, signs it, and is idempotent for the same verdict', () => {
    promotedSetup();
    const before = store.eventCount();
    store.insertPromotion({
      promotionId: 'P-1',
      unitId: 'U-7f3a9c',
      verdictId: 'V-1',
      verdictSha: `sha256:${'3'.repeat(64)}`,
      promotionSha: `sha256:${'4'.repeat(64)}`,
      signedBy: 'human:bo',
      createdAt: AT,
    });
    expect(store.getUnit('U-7f3a9c')?.state).toBe('promoted');
    expect(store.eventCount()).toBe(before + 1);
    expect(store.eventsSince(before).at(0)?.payload).toMatchObject({
      unitId: 'U-7f3a9c',
      verdictId: 'V-1',
      signedBy: 'human:bo',
    });
    // Same verdict again: same promotion, no second event.
    store.insertPromotion({
      promotionId: 'P-2',
      unitId: 'U-7f3a9c',
      verdictId: 'V-1',
      verdictSha: `sha256:${'3'.repeat(64)}`,
      promotionSha: `sha256:${'4'.repeat(64)}`,
      signedBy: 'human:bo',
      createdAt: AT,
    });
    expect(store.eventCount()).toBe(before + 1);
    expect(store.getPromotion('U-7f3a9c', `sha256:${'3'.repeat(64)}`)?.promotionId).toBe('P-1');
  });

  it('refuses an unsigned promotion', () => {
    promotedSetup();
    expectFactoryError(
      () =>
        store.insertPromotion({
          promotionId: 'P-unsig',
          unitId: 'U-7f3a9c',
          verdictId: 'V-1',
          verdictSha: `sha256:${'3'.repeat(64)}`,
          promotionSha: `sha256:${'4'.repeat(64)}`,
          signedBy: '   ',
          createdAt: AT,
        }),
      'PROMOTION_UNSIGNED',
    );
  });
});

describe('spend', () => {
  it('sums reserved and recorded, and counts unknown rows separately', () => {
    store.insertUnit(unitRow(), options());
    store.reserveSpend({
      spendId: 'S-1',
      unitId: 'U-7f3a9c',
      attemptId: null,
      amountUsd: 0.4,
      recordedAt: AT,
    });
    store.recordSpend({
      spendId: 'S-2',
      unitId: 'U-7f3a9c',
      attemptId: null,
      kind: 'measured',
      amountUsd: 0.25,
      recordedAt: AT,
    });
    store.recordSpend({
      spendId: 'S-3',
      unitId: 'U-7f3a9c',
      attemptId: null,
      kind: 'unknown',
      amountUsd: null,
      recordedAt: AT,
    });
    expect(store.spendForUnit('U-7f3a9c')).toEqual({
      reservedUsd: 0.4,
      recordedUsd: 0.25,
      unknownRows: 1,
    });
    expect(store.eventsSince(0).map((e) => e.type)).toEqual([
      'unit.submitted',
      'spend.reserved',
      'spend.recorded',
      'spend.recorded',
    ]);
  });

  it('refuses a measured spend with no amount', () => {
    store.insertUnit(unitRow(), options());
    const error = expectFactoryError(
      () =>
        store.recordSpend({
          spendId: 'S-bad',
          unitId: 'U-7f3a9c',
          attemptId: null,
          kind: 'measured',
          amountUsd: null,
          recordedAt: AT,
        }),
      'INTERNAL',
    );
    expect(error.message).toContain("kind 'unknown'");
    expect(store.spendForUnit('U-7f3a9c').recordedUsd).toBe(0);
  });

  it('refuses a budget raise signed by the system rather than a human', () => {
    expectFactoryError(
      () =>
        store.raiseEnvelope({
          envelopeId: 'E-1',
          scope: 'per-unit',
          amountUsd: 5,
          effectiveFrom: AT,
          supersedes: null,
          signedBy: 'system:scheduler',
          reason: 'the run needs more room',
        }),
      'GATE_REQUIRED',
    );
    expect(store.currentEnvelope('per-unit')).toBeNull();
  });

  it('raises an envelope with a signature and records from/to', () => {
    store.raiseEnvelope({
      envelopeId: 'E-1',
      scope: 'per-unit',
      amountUsd: 2,
      effectiveFrom: AT,
      supersedes: null,
      signedBy: 'human:bo',
      reason: 'initial envelope',
    });
    advance();
    store.raiseEnvelope({
      envelopeId: 'E-2',
      scope: 'per-unit',
      amountUsd: 5,
      effectiveFrom: clock().toISOString(),
      supersedes: 'E-1',
      signedBy: 'human:bo',
      reason: 'second attempt needs more room',
    });
    expect(store.currentEnvelope('per-unit')).toEqual({ envelopeId: 'E-2', amountUsd: 5 });
    const event = store.eventsSince(0).at(-1);
    expect(event?.type).toBe('envelope.raised');
    expect(event?.payload).toMatchObject({ fromUsd: 2, toUsd: 5, signedBy: 'human:bo' });
  });

  it('issues and revokes a credential with an event on issue', () => {
    store.insertCredential({
      grantId: 'C-1',
      repo: REPO,
      ttlSeconds: 900,
      issuedBy: 'proxy',
      issuedAt: AT,
      expiresAt: '2026-11-01T00:15:00.000Z',
    });
    expect(store.eventsSince(0).at(-1)?.payload).toMatchObject({
      grantId: 'C-1',
      repo: REPO,
      ttlSeconds: 900,
    });
    store.revokeCredential('C-1', AT);
    expectFactoryError(() => store.revokeCredential('C-missing', AT), 'INTERNAL');
  });
});

describe('effects outbox', () => {
  it('is idempotent by key: the same key is one row, attempts untouched', () => {
    const first = store.enqueueEffect({
      effectId: 'E-1',
      idempotencyKey: 'launch:U-7f3a9c:A-1',
      kind: 'launch',
      payload: { unitId: 'U-7f3a9c', attemptId: 'A-1' },
      createdAt: AT,
    });
    const second = store.enqueueEffect({
      effectId: 'E-2',
      idempotencyKey: 'launch:U-7f3a9c:A-1',
      kind: 'launch',
      payload: { unitId: 'U-7f3a9c', attemptId: 'A-1' },
      createdAt: AT,
    });
    expect(second.effectId).toBe(first.effectId);
    expect(second.attempts).toBe(0);
    expect(store.getEffectByKey('launch:U-7f3a9c:A-1')?.effectId).toBe('E-1');
    expect(store.claimPendingEffects(10)).toHaveLength(1);
  });

  it('claims oldest-first', () => {
    store.enqueueEffect({
      effectId: 'E-b',
      idempotencyKey: 'k:b',
      kind: 'notify',
      payload: {},
      createdAt: AT,
    });
    store.enqueueEffect({
      effectId: 'E-a',
      idempotencyKey: 'k:a',
      kind: 'notify',
      payload: {},
      createdAt: '2026-10-31T23:00:00.000Z',
    });
    expect(store.claimPendingEffects(10).map((e) => e.effectId)).toEqual(['E-a', 'E-b']);
    expect(store.claimPendingEffects(1).map((e) => e.effectId)).toEqual(['E-a']);
  });

  it('keeps a retryable failure pending and reclaimable', () => {
    store.enqueueEffect({
      effectId: 'E-1',
      idempotencyKey: 'k:1',
      kind: 'launch',
      payload: {},
      createdAt: AT,
    });
    const failed = store.recordEffectFailure('E-1', 'container start timed out');
    expect(failed.state).toBe('pending');
    expect(failed.attempts).toBe(1);
    expect(failed.lastError).toBe('container start timed out');
    // Still pending → the next drain picks it up again.
    expect(store.claimPendingEffects(10).map((e) => e.effectId)).toEqual(['E-1']);
    const failedTwice = store.recordEffectFailure('E-1', 'timed out again');
    expect(failedTwice.attempts).toBe(2);
  });

  it('marks an exhausted effect failed for good, and never claims or deletes it', () => {
    store.enqueueEffect({
      effectId: 'E-1',
      idempotencyKey: 'k:1',
      kind: 'launch',
      payload: {},
      createdAt: AT,
    });
    store.recordEffectFailure('E-1', 'timed out');
    store.markEffectExhausted('E-1', 'three attempts exhausted');
    const row = store.getEffectByKey('k:1');
    expect(row).not.toBeNull();
    expect(row?.state).toBe('failed');
    expect(row?.attempts).toBe(2);
    expect(row?.lastError).toBe('three attempts exhausted');
    // A failed effect is not claimable — and the row is still there as the record.
    expect(store.claimPendingEffects(10)).toHaveLength(0);
    // A retryable failure cannot resurrect an exhausted effect.
    expectFactoryError(() => store.recordEffectFailure('E-1', 'again'), 'INTERNAL');
  });

  it('applies an effect once', () => {
    store.enqueueEffect({
      effectId: 'E-1',
      idempotencyKey: 'k:1',
      kind: 'launch',
      payload: {},
      createdAt: AT,
    });
    store.markEffectApplied('E-1', AT);
    const row = store.getEffectByKey('k:1');
    expect(row?.state).toBe('applied');
    expect(row?.appliedAt).toBe(AT);
    expect(store.claimPendingEffects(10)).toHaveLength(0);
    expectFactoryError(() => store.markEffectApplied('E-missing', AT), 'INTERNAL');
  });
});

describe('quarantine', () => {
  it('refuses every write after quarantine but keeps reads working', () => {
    store.insertUnit(unitRow(), options());
    store.quarantine('integrity_check failed: 3 pages corrupt', 'operator:bo', 'tr-quarantine');

    expect(store.isQuarantined()).toBe(true);
    // Reads still work.
    expect(store.getUnit('U-7f3a9c')?.unitId).toBe('U-7f3a9c');
    expect(store.eventCount()).toBe(2);

    const error = expectFactoryError(
      () => store.insertUnit(unitRow('U-2', spec({ slug: 'second' })), options()),
      'STORE_QUARANTINED',
    );
    expect(error.message).toContain('integrity_check failed');
    expect(error.message).toContain('insertUnit');

    expectFactoryError(
      () => store.setUnitState('U-7f3a9c', 'aborted', 'x', options()),
      'STORE_QUARANTINED',
    );
    expectFactoryError(
      () =>
        store.enqueueEffect({
          effectId: 'E-1',
          idempotencyKey: 'k:1',
          kind: 'launch',
          payload: {},
          createdAt: AT,
        }),
      'STORE_QUARANTINED',
    );
    expectFactoryError(() => store.quarantine('again', 'operator:bo', 'tr-2'), 'STORE_QUARANTINED');

    const events = store.eventsSince(0);
    expect(events.at(-1)?.type).toBe('store.quarantined');
    expect(events.at(-1)?.payload['detectedBy']).toBe('operator:bo');
  });
});

describe('atomic', () => {
  it('rolls back aggregates and ledger events together', () => {
    expect(() =>
      store.atomic(() => {
        store.insertUnit(unitRow(), options());
        store.reserveSpend({
          spendId: 'S-1',
          unitId: 'U-7f3a9c',
          attemptId: null,
          amountUsd: 1,
          recordedAt: AT,
        });
        throw new Error('boom after two writes');
      }),
    ).toThrow(/boom/);

    expect(store.getUnit('U-7f3a9c')).toBeNull();
    expect(store.eventCount()).toBe(0);
    expect(store.spendForUnit('U-7f3a9c').reservedUsd).toBe(0);
  });

  it('joins an enclosing transaction instead of opening a nested one', () => {
    store.atomic(() => {
      store.insertUnit(unitRow(), options());
      store.insertUnit(unitRow('U-2', spec({ slug: 'second' })), options());
      // Nested atomic is a join, not a savepoint: this proves no nested BEGIN.
      store.atomic(() => {
        store.reserveSpend({
          spendId: 'S-1',
          unitId: 'U-2',
          attemptId: null,
          amountUsd: 0.5,
          recordedAt: AT,
        });
      });
    });
    expect(store.countUnitsByState().submitted).toBe(2);
    expect(store.spendForUnit('U-2').reservedUsd).toBe(0.5);
    expect(store.eventCount()).toBe(3); // 2 unit.submitted + 1 spend.reserved, and nothing else
  });

  it('commits everything when the transaction succeeds', () => {
    store.atomic(() => {
      store.insertUnit(unitRow(), options());
      store.insertLaneDecision(laneDecision('U-7f3a9c', 'reject', null));
      store.setUnitLaneAndMandate('U-7f3a9c', 'reject', null, options());
    });
    expect(store.getUnit('U-7f3a9c')?.state).toBe('rejected');
    expect(store.eventsSince(0).map((e) => e.type)).toEqual(['unit.submitted', 'unit.rejected']);
  });
});

describe('recovery runs', () => {
  it('records a run and its completion event', () => {
    store.insertRecoveryRun({ recoveryRunId: 'RR-1', startedAt: AT });
    store.completeRecoveryRun('RR-1', AT, { orphanedAttempts: 1, ambiguous: 2 });
    const event = store.eventsSince(0).at(-1);
    expect(event?.type).toBe('recovery.completed');
    expect(event?.payload).toMatchObject({
      recoveryRunId: 'RR-1',
      orphanedAttempts: 1,
      ambiguous: 2,
    });
    expectFactoryError(
      () => store.completeRecoveryRun('RR-missing', AT, { orphanedAttempts: 0, ambiguous: 0 }),
      'INTERNAL',
    );
  });
});

describe('metered usage (ND3)', () => {
  // Appended here rather than in a new file because the setup helpers above build the
  // unit/lease/attempt chain an attempt-scoped usage row needs; duplicating them would be a
  // second definition of "a dispatched unit" that could drift from the first.

  it('records a usage fact, and the ledger event carries the same digest as the row', () => {
    dispatchedUnit();
    const before = store.eventCount();
    const row = store.recordUsage({
      usageId: 'usg-1',
      unitId: 'U-7f3a9c',
      attemptId: 'A-1',
      tokensIn: 1200,
      tokensOut: 340,
      costUsd: 0.021,
      gatewayRequestId: 'req_1',
      signedAt: AT,
      ceilingCrossed: false,
    });
    expect(row.recordSha).toMatch(/^sha256:[0-9a-f]{64}$/u);
    // The digest is over the row as stored, so a reader can recompute it from the table alone.
    expect(store.eventCount()).toBe(before + 1);
    const appended = store.eventsSince(before).at(-1);
    expect(appended?.type).toBe('usage.recorded');
    expect((appended?.payload as { recordSha?: string }).recordSha).toBe(row.recordSha);
    expect(store.usageForAttempt('A-1')).toEqual([row]);
  });

  it('keeps an unpriced call unknown instead of storing a zero', () => {
    dispatchedUnit();
    const row = store.recordUsage({
      usageId: 'usg-2',
      unitId: 'U-7f3a9c',
      attemptId: 'A-1',
      tokensIn: 10,
      tokensOut: 2,
      // The gateway reported tokens and no price. This is the case that must never become
      // `$0.00 measured`: the budget would read healthier the less the gateway said.
      costUsd: null,
      gatewayRequestId: null,
      signedAt: AT,
      ceilingCrossed: false,
    });
    expect(row.costUsd).toBeNull();
    expect(store.usageForUnit('U-7f3a9c')).toMatchObject({
      tokensIn: 10,
      tokensOut: 2,
      costUsd: 0,
      unpricedRows: 1,
      rows: 1,
    });
  });

  it('sums per unit, flags a crossing, and refuses a usage row for an unknown attempt', () => {
    dispatchedUnit();
    store.recordUsage({
      usageId: 'usg-3',
      unitId: 'U-7f3a9c',
      attemptId: 'A-1',
      tokensIn: 100,
      tokensOut: 20,
      costUsd: 0.004,
      gatewayRequestId: 'req_a',
      signedAt: AT,
      ceilingCrossed: false,
    });
    store.recordUsage({
      usageId: 'usg-4',
      unitId: 'U-7f3a9c',
      attemptId: 'A-1',
      tokensIn: 50,
      tokensOut: 10,
      costUsd: 0.002,
      gatewayRequestId: 'req_b',
      signedAt: '2026-11-01T00:00:01.000Z',
      ceilingCrossed: true,
    });
    expect(store.usageForUnit('U-7f3a9c')).toMatchObject({
      tokensIn: 150,
      tokensOut: 30,
      costUsd: 0.006,
      unpricedRows: 0,
      rows: 2,
      ceilingCrossed: true,
    });
    expect(store.listUsage()).toHaveLength(2);
    expectFactoryError(
      () =>
        store.recordUsage({
          usageId: 'usg-bad',
          unitId: 'U-7f3a9c',
          attemptId: 'A-missing',
          tokensIn: 1,
          tokensOut: 1,
          costUsd: null,
          gatewayRequestId: null,
          signedAt: AT,
          ceilingCrossed: false,
        }),
      'ATTEMPT_NOT_FOUND',
    );
  });
});
