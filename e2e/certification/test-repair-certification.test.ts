/**
 * The certificate flip for `test-repair`: twenty measured attempts, eighteen honest repairs and two
 * refused cheats.
 *
 * The `docs-typo-fix` loop could be certified at 19 of 20 because its holdout refused a
 * plausible-looking patch. This class is different in kind: its cheap repair is *green*. A model that
 * does not understand the function can weaken the test, rewrite the expectation data, or special-case
 * the inputs it can see, and every visible signal says done. So the loop spends two of its twenty
 * revisions on exactly those two cheats and lands at `k = 18` with both failures measured as class
 * rule refusals. A 20-of-20 certificate for this class would have been a demonstration rather than a
 * measurement: nothing would have tested whether the corpus can refuse the thing this class makes
 * cheap, and the certificate would be indistinguishable from one issued for a class that cannot be
 * attacked.
 *
 * Twenty real `factory run` invocations: real mirror, real clone, real wall, real receipt, real
 * verdict, with `FACTORY_EXECUTOR=fake` so the proof costs nothing. Every number below is read back
 * from the store and the criteria-log file, not from the driver's tally.
 */
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { openStore } from '../../packages/store/src/index.ts';
import { criteriaLogPath, readCriteriaLog } from '../../packages/wall/src/index.ts';
import { jsonOf, runFactory } from '../harness/factory.ts';
import {
  TEST_REPAIR_HOLDOUT_REVISION,
  TEST_REPAIR_TASK_CLASS,
  createTestRepairSubstrate,
  lookupCandidate,
  weakenFixturesCandidate,
  type TestRepairSubstrate,
} from './test-repair.ts';

/**
 * Zero-based unit indexes that get a cheap repair instead of the honest one, and which one.
 *
 * Two, not zero: the certificate's whole value for this class is that these were *measured* and
 * refused. Their revisions still count as samples (`countClassAttempts` counts attempts and clean
 * attempts separately), which is what makes 18 of 20 the honest number rather than 20 of 20.
 */
const CHEATS = new Map<number, 'lookup' | 'fixtures'>([
  [1, 'lookup'],
  [6, 'fixtures'],
]);

interface Sample {
  readonly run: number;
  readonly unitId: string;
  readonly exit: number;
  readonly samples: number;
  readonly passes: number;
  readonly outcome: string;
}

interface CertificateRow {
  readonly outcome: string;
  readonly samples: number;
  readonly passes: number;
  readonly m: number;
  readonly modelId: string | null;
}

let substrate: TestRepairSubstrate;
let unitIds: readonly string[];

function newestCertificate(): CertificateRow | null {
  const store = openStore({ dir: join(substrate.home, 'state') });
  try {
    const row = store.classCertificates?.()[0];
    if (row === undefined) return null;
    return {
      outcome: row.outcome,
      samples: row.samples,
      passes: row.passes,
      m: row.m,
      modelId: row.modelId,
    };
  } finally {
    store.close();
  }
}

interface AuditRun {
  readonly code: number;
  readonly body: Record<string, unknown>;
  readonly stderr: string;
}

function audits(): AuditRun {
  const run = runFactory(['audit', '--certifications', '--json'], {
    home: substrate.home,
    env: substrate.wallEnv(),
  });
  return { code: run.code, body: jsonOf(run), stderr: run.stderr };
}

function alertCodes(): readonly unknown[] {
  const run = runFactory(['alerts', '--json'], { home: substrate.home, env: substrate.wallEnv() });
  const alerts = jsonOf(run)['alerts'] as readonly Record<string, unknown>[];
  return alerts.map((alert) => alert['code']);
}

beforeAll(() => {
  // Twenty units reach the operating point; the twenty-first is the "what happens after" unit.
  substrate = createTestRepairSubstrate({ units: 21 });
  unitIds = substrate.units.map((unit) => substrate.submit(unit));
}, 240_000);

afterAll(() => {
  substrate.cleanup();
});

// One `factory run` is ~2.3 s of real wall work, but the count is 21 runs and the suite runs files in
// parallel: under a full-suite load each of those runs takes several times longer than it does alone.
// The budget below is the measured cost with headroom for that contention, not a way to hide a hang —
// a hang still trips the adapter's own kill deadline long before this fires.
const LOOP_TIMEOUT_MS = 600_000;

describe('twenty measured attempts of test-repair', () => {
  it(
    'accumulates to samples = m and flips the certificate to certified at passes = k',
    () => {
      const progression: Sample[] = [];
      const refusals: {
        readonly unitId: string;
        readonly cheat: 'lookup' | 'fixtures';
        readonly reasons: readonly string[];
        readonly failedIds: readonly string[];
        readonly workerExit: number | null | undefined;
      }[] = [];

      for (let index = 0; index < 20; index += 1) {
        const unit = substrate.units[index];
        const unitId = unitIds[index];
        if (unit === undefined || unitId === undefined)
          throw new Error(`no unit ${index.toString()}`);

        const cheat = CHEATS.get(index);
        if (cheat === 'lookup') {
          substrate.writeScenario(unit, [lookupCandidate(unit.revision)]);
        } else if (cheat === 'fixtures') {
          substrate.writeScenario(unit, [weakenFixturesCandidate(unit.revision)]);
        }

        const run = runFactory(['run', unitId, '--scenario', unit.scenarioPath, '--json'], {
          home: substrate.home,
          env: substrate.wallEnv(),
          timeoutMs: 180_000,
        });
        expect(run.code, `unit ${index.toString()}:\n${run.stderr}`).toBe(
          cheat === undefined ? 0 : 3,
        );
        const body = jsonOf(run);
        expect(body['outcome']).toBe(cheat === undefined ? 'pass' : 'fail');

        if (cheat !== undefined) {
          const store = openStore({ dir: join(substrate.home, 'state') });
          try {
            const verdict = store.latestVerdictForUnit(unitId);
            const receipt = store.latestReceiptForUnit(unitId);
            // The refusal is the corpus's, not the visible check's: the worker's own command
            // exited 0 and the class rule it never saw is what failed.
            expect(receipt?.receipt.commands[0]?.exitCode).toBe(0);
            refusals.push({
              unitId,
              cheat,
              reasons: verdict?.verdict.reasons ?? [],
              failedIds: (verdict?.verdict.scenarios ?? [])
                .filter((row) => row.outcome !== 'pass')
                .map((row) => row.id),
              workerExit: receipt?.receipt.commands[0]?.exitCode,
            });
          } finally {
            store.close();
          }
        }

        const row = newestCertificate();
        if (row === null) throw new Error('no certificate row after a verdict');
        progression.push({
          run: index + 1,
          unitId,
          exit: run.code,
          samples: row.samples,
          passes: row.passes,
          outcome: row.outcome,
        });
      }

      // The samples counter is a count of *revisions measured*, one per run, never a re-labelled
      // single attempt. The two cheats consume samples and do not add passes.
      expect(progression.map((sample) => sample.samples)).toEqual(
        Array.from({ length: 20 }, (_unused, index) => index + 1),
      );
      expect(progression.map((sample) => sample.passes)).toEqual(
        Array.from({ length: 20 }, (_unused, index) => (CHEATS.has(index) ? 0 : 1)).reduce<
          number[]
        >((totals, pass) => [...totals, (totals[totals.length - 1] ?? 0) + pass], []),
      );
      // Nineteen samples — 19 of 20 needed — is still insufficient, even with 17 passes.
      expect(progression[18]).toMatchObject({ samples: 19, passes: 17, outcome: 'insufficient' });
      // The twentieth sample is the first at which the certificate can exist, and it does: 18 of
      // the 20 attempts passed, which is exactly k.
      expect(progression[19]).toMatchObject({ samples: 20, passes: 18, outcome: 'certified' });
      // Nothing was certified early. There is exactly one flip, and it happens at attempt 20.
      expect(progression.filter((sample) => sample.outcome === 'certified')).toHaveLength(1);
      expect(newestCertificate()).toMatchObject({
        outcome: 'certified',
        samples: 20,
        passes: 18,
        m: 20,
        modelId: 'fixture/offline-scripted-worker',
      });

      // Both failures were measured failures of the class, not of the visible check. The lookup
      // cheat is refused by the behaviour probe alone; the fixture cheat moves the instrument and
      // is refused by the immutability rule as well.
      expect(refusals.map((refusal) => refusal.cheat)).toEqual(['lookup', 'fixtures']);
      for (const refusal of refusals) {
        expect(refusal.workerExit, `${refusal.cheat}: the visible suite was green`).toBe(0);
        expect(refusal.reasons).toContain('holdout_failed');
        expect(refusal.failedIds.filter((id) => id.startsWith('holdout:'))).not.toEqual([]);
        expect(
          refusal.failedIds.every((id) => !id.startsWith('acceptance:')),
          `${refusal.cheat}: the visible check did not fail`,
        ).toBe(true);
      }

      // The accumulator on disk: 20 revisions × 3 rules × 2 sides, every line parseable. The
      // differential rule runs in both directions like the others: the base side is what says the
      // rule discriminates, and a corpus line that cannot say which side it measured is not
      // evidence.
      const log = readCriteriaLog(criteriaLogPath(substrate.home));
      expect(log.corruptLines).toBe(0);
      expect(log.entries).toHaveLength(120);
      expect(new Set(log.entries.map((entry) => entry.revision)).size).toBe(20);
      expect(new Set(log.entries.map((entry) => entry.holdoutRevision))).toEqual(
        new Set([TEST_REPAIR_HOLDOUT_REVISION]),
      );

      // `audit --certifications` is the surface an operator actually reads, and after twenty
      // measured attempts it has to be *clean*: exit 0, nothing listed as uncertified, no
      // "STALE OR NEVER CERTIFIED" line on stderr.
      const audit = audits();
      expect(audit.code, audit.stderr).toBe(0);
      expect(audit.stderr).not.toContain('STALE OR NEVER CERTIFIED');
      const classes = audit.body['classes'] as readonly Record<string, unknown>[];
      expect(classes).toHaveLength(1);
      expect(classes[0]).toMatchObject({
        taskClass: TEST_REPAIR_TASK_CLASS,
        state: 'current',
        outcome: 'certified',
        samples: 20,
        m: 20,
      });
      expect(audit.body['uncertifiedUnits']).toEqual([]);
      expect(audit.body['projectionPresent']).toBe(true);

      // The certificate exists because the attempts left rows behind, not because a verdict said
      // so: the store strips `certification` from the verdict body.
      const certificates = openStore({ dir: join(substrate.home, 'state') });
      try {
        const verified = [...certificates.listUnits({ state: 'verified' })];
        const promoted = [...certificates.listUnits({ state: 'promoted' })];
        const rejected = certificates.listUnits({ state: 'rejected' });
        // Eighteen verified, two rejected — every unit this loop submitted is one or the other. A
        // fourth state would mean the audit silently stopped covering a unit.
        expect(verified.length + promoted.length).toBe(18);
        expect(rejected.length).toBe(2);
        const rows = certificates.classCertificates?.() ?? [];
        const certificateVerdicts = new Set(rows.map((row) => row.verdictId));
        for (const unit of [...verified, ...promoted]) {
          const verdict = certificates.latestVerdictForUnit(unit.unitId);
          if (verdict === null) throw new Error(`no verdict stored for ${unit.unitId}`);
          const body = verdict.verdict as unknown as Record<string, unknown>;
          expect(body['certification'], 'the store strips the per-verdict certificate').toBe(
            undefined,
          );
          expect(
            certificateVerdicts.has(verdict.verdictId),
            `verdict ${verdict.verdictId} left no certificate row behind`,
          ).toBe(true);
        }
      } finally {
        certificates.close();
      }

      // The alert that started this: CERT_NEVER is gone once the certificate exists. The anchor is
      // still unconfigured, which keeps the verb at exit 8 — a different, unrelated integrity fact.
      const alerts = alertCodes();
      expect(alerts).not.toContain('CERT_NEVER');
      expect(alerts).toContain('ANCHOR_MISSING');
    },
    LOOP_TIMEOUT_MS,
  );

  it(
    'keeps the certificate when a later cheap repair is refused: passes never decreases, samples only grow',
    () => {
      // The twenty-first unit is a cheat again (revision bytes, a new commit), run *after* the
      // certificate exists. It is a measured failure and it does not un-certify anything:
      // `countClassAttempts` counts attempts (samples) and clean attempts (passes), and a new
      // failing attempt increments the first and leaves the second alone. With k = 18 already
      // reached, 18 of 21 is still 18 of the required 18 — the class stays current.
      //
      // Worth asserting because the alternative is what an operator would assume: that a later
      // failure revokes the claim. It does not. The certificate describes the attempts that were
      // accumulated, not the state of the tree today.
      const unit = substrate.units[20];
      const unitId = unitIds[20];
      if (unit === undefined || unitId === undefined) throw new Error('no unit 21');
      substrate.writeScenario(unit, [lookupCandidate(unit.revision)]);
      const run = runFactory(['run', unitId, '--scenario', unit.scenarioPath, '--json'], {
        home: substrate.home,
        env: substrate.wallEnv(),
        timeoutMs: 180_000,
      });
      expect(run.code, run.stderr).toBe(3);
      expect(jsonOf(run)['outcome']).toBe('fail');

      // Twenty-one samples, still eighteen passes, still certified.
      expect(newestCertificate()).toMatchObject({
        outcome: 'certified',
        samples: 21,
        passes: 18,
      });
      const audit = audits();
      expect(audit.code, audit.stderr).toBe(0);
      expect(audit.stderr).not.toContain('STALE OR NEVER CERTIFIED');
      const classes = audit.body['classes'] as readonly Record<string, unknown>[];
      expect(classes[0]).toMatchObject({ state: 'current', outcome: 'certified', samples: 21 });
      expect(audit.body['uncertifiedUnits']).toEqual([]);
      expect(alertCodes()).not.toContain('CERT_NEVER');

      // Both rows are kept: history is appended to, never rewritten.
      const rows = openStore({ dir: join(substrate.home, 'state') });
      try {
        const stored = (rows.classCertificates?.() ?? []).map((row) => [
          row.samples,
          row.passes,
          row.outcome,
        ]);
        expect(stored.slice(0, 2)).toEqual([
          [21, 18, 'certified'],
          [20, 18, 'certified'],
        ]);
      } finally {
        rows.close();
      }
    },
    LOOP_TIMEOUT_MS,
  );
});
