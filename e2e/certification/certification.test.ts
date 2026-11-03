/**
 * The certificate flip: `insufficient` at 19 samples, `certified` at 20 — and why that is the only
 * honest way to produce it.
 *
 * A class certificate is not a thing the wall can be asked to print. It is the store's summary of
 * `m = 20` measured attempts of the class at `k = 18` passes, accumulated in the criteria log
 * across distinct base revisions. The cheap way to produce a `certified` row would be to insert one;
 * that row would be unmeasured evidence, and this suite refuses to do it. Instead the loop runs
 * twenty real `factory run` invocations — real mirror, real clone, real wall, real receipt, real
 * verdict — with the executor scripted so the run costs nothing. Every number below is read back
 * from the store, not from the driver's tally.
 *
 * Two of the twenty units are the *almost-fixed* patch (visible suite green, one broken link). They
 * are what makes the run a measurement rather than a demonstration: without them the certificate
 * would say "20 of 20", and nothing would have tested whether the class rule can refuse anything.
 * They fail on the holdout, they are rejected, and they consume two of the two failures `k = 18`
 * allows — which is exactly the margin the operating point is for.
 *
 * The last unit then runs after the certificate exists, and the store answers a question worth
 * knowing the answer to before an operator meets it in production: a certified class is not
 * revoked by a later failing unit. The certificate is a historical measurement under a policy and a
 * model; only a change to those makes it stale (`certificateRecency`). That is documented rather
 * than discovered.
 */
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { openStore } from '../../packages/store/src/index.ts';
import { criteriaLogPath, readCriteriaLog } from '../../packages/wall/src/index.ts';
import { jsonOf, runFactory } from '../harness/factory.ts';
import {
  almostFixedDocs,
  createDocsSubstrate,
  HOLDOUT_REVISION,
  TASK_CLASS,
  writeCandidateScenario,
  type DocsSubstrate,
} from './docs-substrate.ts';

/** Zero-based unit indexes that get the almost-fixed patch instead of the repair. */
const ALMOST_FIXED = new Set([1, 6]);

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

let substrate: DocsSubstrate;
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

function audits(): { code: number; body: Record<string, unknown> } {
  const run = runFactory(['audit', '--certifications', '--json'], {
    home: substrate.home,
    env: substrate.wallEnv(),
  });
  return { code: run.code, body: jsonOf(run) };
}

function alertCodes(): readonly unknown[] {
  const run = runFactory(['alerts', '--json'], { home: substrate.home, env: substrate.wallEnv() });
  const alerts = jsonOf(run)['alerts'] as readonly Record<string, unknown>[];
  return alerts.map((alert) => alert['code']);
}

beforeAll(() => {
  // Twenty units reach the operating point; the twenty-first is the "what happens after" unit.
  substrate = createDocsSubstrate({ units: 21 });
  unitIds = substrate.units.map((unit) => substrate.submit(unit));
}, 120_000);

afterAll(() => {
  substrate.cleanup();
});

// One `factory run` is ~2.5 s of real wall work. Twenty-one of them, plus the store reads, is the
// suite's longest test; the timeout is the measured cost with room for a slow machine, not a way to
// hide a hang.
const LOOP_TIMEOUT_MS = 300_000;

describe('twenty measured attempts of docs-typo-fix', () => {
  it(
    'accumulates to samples = m and flips the certificate to certified at passes = k',
    () => {
      const progression: Sample[] = [];
      const failing: {
        unitId: string;
        reasons: readonly string[];
        failedIds: readonly string[];
      }[] = [];

      for (let index = 0; index < 20; index += 1) {
        const unit = substrate.units[index];
        const unitId = unitIds[index];
        if (unit === undefined || unitId === undefined)
          throw new Error(`no unit ${index.toString()}`);
        const almost = ALMOST_FIXED.has(index);
        if (almost) writeCandidateScenario(unit.scenarioPath, unit, almostFixedDocs(unit.index));
        const run = runFactory(['run', unitId, '--scenario', unit.scenarioPath, '--json'], {
          home: substrate.home,
          env: substrate.wallEnv(),
          timeoutMs: 180_000,
        });
        expect(run.code, `unit ${index.toString()}:\n${run.stderr}`).toBe(almost ? 3 : 0);
        const body = jsonOf(run);
        expect(body['outcome']).toBe(almost ? 'fail' : 'pass');

        if (almost) {
          const store = openStore({ dir: join(substrate.home, 'state') });
          try {
            const verdict = store.latestVerdictForUnit(unitId);
            const receipt = store.latestReceiptForUnit(unitId);
            // The refusal is the holdout's, not the visible check's: the worker's own command
            // exited 0 and the class rule it never saw is what failed.
            expect(receipt?.receipt.commands[0]?.exitCode).toBe(0);
            failing.push({
              unitId,
              reasons: verdict?.verdict.reasons ?? [],
              failedIds: (verdict?.verdict.scenarios ?? [])
                .filter((row) => row.outcome !== 'pass')
                .map((row) => row.id),
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
      // single attempt. Before the criteria log was wired into the evaluation this sequence was
      // twenty ones; the whole point of the run is that it is not.
      expect(progression.map((sample) => sample.samples)).toEqual(
        Array.from({ length: 20 }, (_unused, index) => index + 1),
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

      // The two failures were measured failures of the class, not of the visible check.
      expect(failing).toHaveLength(2);
      for (const refusal of failing) {
        expect(refusal.reasons).toEqual(['holdout_failed']);
        expect(refusal.failedIds).toHaveLength(1);
        expect(refusal.failedIds[0]).toMatch(/^holdout:\d+$/u);
      }

      // The accumulator on disk: 20 revisions × 5 rules × 2 sides, every line parseable.
      const log = readCriteriaLog(criteriaLogPath(substrate.holdoutRoot));
      expect(log.corruptLines).toBe(0);
      expect(log.entries).toHaveLength(200);
      expect(new Set(log.entries.map((entry) => entry.revision)).size).toBe(20);
      expect(new Set(log.entries.map((entry) => entry.holdoutRevision))).toEqual(
        new Set([HOLDOUT_REVISION]),
      );

      // `audit --certifications` reports a current class certificate, with the counts the store
      // accumulated rather than the ones the loop would like. The *JSON* is the contract asserted
      // here; the verb's exit code is not, because it is currently 9 for a reason unrelated to this
      // class — see the report in the runbook's "what this does not prove" and the comment below.
      const audit = audits();
      const classes = audit.body['classes'] as readonly Record<string, unknown>[];
      expect(classes).toHaveLength(1);
      expect(classes[0]).toMatchObject({
        taskClass: TASK_CLASS,
        state: 'current',
        outcome: 'certified',
        samples: 20,
        m: 20,
      });
      // `uncertifiedUnits` still lists verified units, and this spec does not pin its contents
      // beyond the two facts that must hold whatever the audit decides a unit-level judgement is:
      // a rejected unit is never in it, and only units this run verified can be.
      expect(audit.body['uncertifiedUnits']).not.toContain(unitIds[1]);
      expect(audit.body['uncertifiedUnits']).not.toContain(unitIds[6]);
      for (const listed of audit.body['uncertifiedUnits'] as readonly string[]) {
        expect(unitIds.slice(0, 20)).toContain(listed);
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
    'keeps the certificate when a later unit fails: passes never decreases, samples only grow',
    () => {
      // The twenty-first unit is the almost-fixed patch again, run *after* the certificate exists.
      // It is a measured failure, and it does not un-certify anything: `countClassAttempts` counts
      // attempts (samples) and clean attempts (passes), and a new failing attempt increments the
      // first and leaves the second alone. With k = 18 already reached, 18 of 21 is still 18 of the
      // required 18 — the class stays current.
      //
      // This is worth asserting because the alternative is what an operator would assume: that a
      // later failure revokes the claim. It does not. The certificate describes the attempts that
      // were accumulated, not the state of the tree today; a regression after certification is
      // caught by the *unit* walls, and re-certification is a policy/model question
      // (`certificateRecency`), not a "did anything fail since" question.
      const unit = substrate.units[20];
      const unitId = unitIds[20];
      if (unit === undefined || unitId === undefined) throw new Error('no unit 21');
      writeCandidateScenario(unit.scenarioPath, unit, almostFixedDocs(unit.index));
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
      const classes = audit.body['classes'] as readonly Record<string, unknown>[];
      expect(classes[0]).toMatchObject({ state: 'current', outcome: 'certified', samples: 21 });
      expect(alertCodes()).not.toContain('CERT_NEVER');

      // Both rows are kept: history is appended to, never rewritten. The certified row is still
      // there at its own samples/passes, and the newest row is the one an operator sees first.
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
