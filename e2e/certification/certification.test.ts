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
      // The store's own log, not the corpus's: a certificate counts what *this* store measured, so the
      // evidence lives under `FACTORY_HOME` (v0.11.0). Reading it from the holdout root now finds nothing.
      const log = readCriteriaLog(criteriaLogPath(substrate.home));
      expect(log.corruptLines).toBe(0);
      expect(log.entries).toHaveLength(200);
      expect(new Set(log.entries.map((entry) => entry.revision)).size).toBe(20);
      expect(new Set(log.entries.map((entry) => entry.holdoutRevision))).toEqual(
        new Set([HOLDOUT_REVISION]),
      );

      // `audit --certifications` is the surface an operator actually reads, and after twenty
      // measured attempts it has to be *clean*: exit 0, nothing listed as uncertified, no
      // "STALE OR NEVER CERTIFIED" line on stderr. The audit used to fail this — see the comment on
      // the mechanism assertions below — and a certificate the audit calls never-certified is a
      // certificate an operator cannot use.
      const audit = audits();
      expect(audit.code, audit.stderr).toBe(0);
      expect(audit.stderr).not.toContain('STALE OR NEVER CERTIFIED');
      const classes = audit.body['classes'] as readonly Record<string, unknown>[];
      expect(classes).toHaveLength(1);
      expect(classes[0]).toMatchObject({
        taskClass: TASK_CLASS,
        state: 'current',
        outcome: 'certified',
        samples: 20,
        m: 20,
      });
      expect(audit.body['uncertifiedUnits']).toEqual([]);
      expect(audit.body['projectionPresent']).toBe(true);

      // Why that is not automatic, asserted so a regression cannot pass: the store *strips*
      // `certification` and `modelId` from the verdict body (`mapVerdict`, so the promotion
      // signature cannot grow), which means a predicate that asks a verdict whether it carried a
      // certificate answers "no" for every unit ever measured. That is what the audit used to do:
      // it printed `STALE OR NEVER CERTIFIED 20 of 21 entries` and exited 9 on an honestly
      // certified store. Reverting the one-line set construction in `apps/cli/src/verbs/audit.ts`
      // to `verdict.verdict.certification === undefined` reddens the two assertions below, so they
      // are the mutation's tripwire: the verdict carries no certificate, and the row it left behind
      // is the only thing that says otherwise.
      const certificates = openStore({ dir: join(substrate.home, 'state') });
      try {
        const audited = [...certificates.listUnits({ state: 'verified' })];
        for (const state of ['promoted'] as const) {
          audited.push(...certificates.listUnits({ state }));
        }
        const rejected = certificates.listUnits({ state: 'rejected' });
        // The audit judges exactly the units that reached verified/promoted; a rejected unit is
        // outside that surface and is not asked about. Every unit this loop submitted is one or the
        // other — if a unit reached a fourth state the audit would silently stop covering it, which
        // is the absence-as-approval failure the verb's own comments are about.
        expect(audited.length + rejected.length).toBe(20);
        expect(audited.length).toBeGreaterThanOrEqual(18);
        const rows = certificates.classCertificates?.() ?? [];
        const certificateVerdicts = new Set(rows.map((row) => row.verdictId));
        for (const unit of audited) {
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
      expect(audit.code, audit.stderr).toBe(0);
      expect(audit.stderr).not.toContain('STALE OR NEVER CERTIFIED');
      const classes = audit.body['classes'] as readonly Record<string, unknown>[];
      expect(classes[0]).toMatchObject({ state: 'current', outcome: 'certified', samples: 21 });
      expect(audit.body['uncertifiedUnits']).toEqual([]);
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
