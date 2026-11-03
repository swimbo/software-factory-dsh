/**
 * The certification pipeline, end to end, with a scripted worker: intent → qualify → run → wall →
 * verdict → class certificate row → `audit --certifications` → `alerts`.
 *
 * This file is the pass half *and* the reject half. The reject is not a malformed patch: it is the
 * patch a competent person would write after reading the visible check — every doubled word gone,
 * the code fence closed, the visible suite green — that leaves one relative link pointing at a
 * file that does not exist. The visible oracle cannot see it; the class holdout can. That is the
 * difference between certifying a unit and certifying a class, and it is why the wall refuses the
 * change rather than the suite.
 *
 * The numbers asserted here are the ones the certificate arithmetic is built on. Before the
 * `criteriaLog` wiring in `apps/cli/src/wall.ts` was fixed, each of these three units wrote its own
 * row with `samples: 1` — the log was created and thrown away per evaluation, so `countClassAttempts`
 * only ever saw the live revision and no number of paid runs could reach `samples >= m`. The
 * `1 → 2 → 3` progression is that bug's regression test.
 */
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { openStore } from '../../packages/store/src/index.ts';
import {
  criteriaLogPath,
  readCriteriaLog,
  type CriteriaLogEntry,
} from '../../packages/wall/src/index.ts';
import { jsonOf, runFactory } from '../harness/factory.ts';
import {
  almostFixedDocs,
  createDocsSubstrate,
  HOLDOUT_REVISION,
  TASK_CLASS,
  writeCandidateScenario,
  type DocsSubstrate,
} from './docs-substrate.ts';

let substrate: DocsSubstrate;
let units: readonly { unitId: string; scenarioPath: string }[];

const certificates = (): readonly Record<string, unknown>[] => {
  const store = openStore({ dir: join(substrate.home, 'state') });
  try {
    return (store.classCertificates?.() ?? []).map((row) => ({
      taskClass: row.taskClass,
      outcome: row.outcome,
      samples: row.samples,
      passes: row.passes,
      m: row.m,
      modelId: row.modelId,
    }));
  } finally {
    store.close();
  }
};

const criteria = (): { entries: readonly CriteriaLogEntry[]; corruptLines: number } =>
  readCriteriaLog(criteriaLogPath(substrate.holdoutRoot));

beforeAll(() => {
  substrate = createDocsSubstrate({ units: 3 });
  units = substrate.units.map((unit) => ({
    unitId: substrate.submit(unit),
    scenarioPath: unit.scenarioPath,
  }));
});

afterAll(() => {
  substrate.cleanup();
});

describe('the certification pipeline for docs-typo-fix', () => {
  it('verifies a repaired tree and records the first class sample', () => {
    const [first] = units;
    if (first === undefined) throw new Error('no unit');
    const run = runFactory(['run', first.unitId, '--scenario', first.scenarioPath, '--json'], {
      home: substrate.home,
      env: substrate.wallEnv(),
      timeoutMs: 180_000,
    });
    expect(run.code, run.stderr).toBe(0);
    const body = jsonOf(run);
    expect(body['state']).toBe('verified');
    expect(body['outcome']).toBe('pass');

    const store = openStore({ dir: join(substrate.home, 'state') });
    try {
      const verdict = store.latestVerdictForUnit(first.unitId);
      expect(verdict).not.toBeNull();
      // The verdict names the corpus it was measured against, and the delta is the measurement:
      // no holdout scenario passed the base revision, all five passed the candidate.
      expect(verdict?.verdict.holdoutRevision).toBe(HOLDOUT_REVISION);
      expect(verdict?.verdict.delta).toEqual({
        baseRate: 0,
        candidateRate: 1,
        checked: true,
        holdoutRevision: HOLDOUT_REVISION,
        observed: 1,
        threshold: 0.2,
      });
      const unit = store.getUnit(first.unitId);
      expect(unit?.state).toBe('verified');
    } finally {
      store.close();
    }

    // One class certificate row, for one attempt of one revision: `k = 18` passes out of 20 is not
    // reachable with one sample, and the store says so instead of rounding up.
    const rows = certificates();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      taskClass: TASK_CLASS,
      outcome: 'insufficient',
      samples: 1,
      passes: 1,
      m: 20,
      modelId: 'fixture/offline-scripted-worker',
    });

    // The criteria log is the accumulator, and it is on disk under the holdout store — not in the
    // evaluation's memory. Ten entries: five rules, base and candidate side.
    const log = criteria();
    expect(log.corruptLines).toBe(0);
    expect(log.entries).toHaveLength(10);
    expect(new Set(log.entries.map((entry) => entry.side))).toEqual(new Set(['base', 'candidate']));
    expect(new Set(log.entries.map((entry) => entry.scenarioId)).size).toBe(5);
    expect(new Set(log.entries.map((entry) => entry.outcome))).toEqual(new Set(['pass', 'fail']));

    // `audit --certifications` reports the store's own view: never certified, and honestly so.
    const audit = runFactory(['audit', '--certifications', '--json'], {
      home: substrate.home,
      env: substrate.wallEnv(),
    });
    // Exit 9 is the audit's own verdict on a surface with nothing current on it: "stale or never
    // certified", printed loudly, with the JSON still on stdout.
    expect(audit.code, audit.stderr).toBe(9);
    const auditBody = jsonOf(audit);
    const classes = auditBody['classes'] as readonly Record<string, unknown>[];
    expect(classes).toHaveLength(1);
    expect(classes[0]).toMatchObject({
      taskClass: TASK_CLASS,
      state: 'never-certified',
      outcome: 'insufficient',
      samples: 1,
      m: 20,
    });

    // And `alerts` says it out loud. The anchor is unconfigured in this environment, which is its
    // own integrity alert (exit 8); what matters here is CERT_NEVER, which is the alert that
    // disappears when a class certificate exists.
    const alerts = runFactory(['alerts', '--json'], {
      home: substrate.home,
      env: substrate.wallEnv(),
    });
    expect(alerts.code).toBe(8);
    const alertCodes = (jsonOf(alerts)['alerts'] as readonly Record<string, unknown>[]).map(
      (alert) => alert['code'],
    );
    expect(alertCodes).toContain('CERT_NEVER');
  });

  it('rejects a plausible patch whose visible suite is green but whose class rule is broken', () => {
    const [, second] = units;
    const unit = substrate.units[1];
    if (second === undefined || unit === undefined) throw new Error('no unit');
    // Fix the doubled words and the fence — everything `tools/check-docs.mjs` can see — and leave
    // the link to a file that was never created.
    writeCandidateScenario(second.scenarioPath, unit, almostFixedDocs(unit.index));

    const run = runFactory(['run', second.unitId, '--scenario', second.scenarioPath, '--json'], {
      home: substrate.home,
      env: substrate.wallEnv(),
      timeoutMs: 180_000,
    });
    expect(run.code, run.stderr).toBe(3);
    const body = jsonOf(run);
    expect(body['state']).toBe('rejected');
    expect(body['outcome']).toBe('fail');

    const store = openStore({ dir: join(substrate.home, 'state') });
    try {
      const verdict = store.latestVerdictForUnit(second.unitId);
      expect(verdict).not.toBeNull();
      expect(verdict?.verdict.outcome).toBe('fail');
      expect(verdict?.verdict.reasons).toEqual(['holdout_failed']);
      // One scenario failed, and it is a holdout scenario (the wall's own id, not the corpus's:
      // `holdout:05`, never `relative-links-resolve`).
      const failed = (verdict?.verdict.scenarios ?? []).filter((row) => row.outcome !== 'pass');
      expect(failed).toHaveLength(1);
      expect(failed[0]?.id).toMatch(/^holdout:\d+$/u);
      expect(failed[0]?.observed).toContain('runs=2 pass=0 fail=2');
      // The visible check *did* pass inside the attempt: the reject is not "the worker's command
      // failed", it is "the class rule it did not know about was measured".
      const receipt = store.latestReceiptForUnit(second.unitId);
      expect(receipt?.receipt.exitCode).toBe(0);
      expect(receipt?.receipt.commands).toHaveLength(1);
      expect(receipt?.receipt.commands[0]?.exitCode).toBe(0);
      expect(receipt?.receipt.commands[0]?.source).toBe('worker-command');
      const unitRow = store.getUnit(second.unitId);
      expect(unitRow?.state).toBe('rejected');
    } finally {
      store.close();
    }

    // The failure is a *sample*: the revision was measured, and it did not pass. Two samples, one
    // pass — still insufficient, and the count is what a budget has to be read against.
    const rows = certificates();
    expect(rows[0]).toMatchObject({ outcome: 'insufficient', samples: 2, passes: 1 });
    expect(criteria().entries).toHaveLength(20);
  });

  it('accumulates a sample per measured revision, which is the only path to `samples >= m`', () => {
    const [, , third] = units;
    if (third === undefined) throw new Error('no unit');
    const run = runFactory(['run', third.unitId, '--scenario', third.scenarioPath, '--json'], {
      home: substrate.home,
      env: substrate.wallEnv(),
      timeoutMs: 180_000,
    });
    expect(run.code, run.stderr).toBe(0);

    // Three units, three distinct base revisions, three samples: 2 pass, 1 fail. This is the
    // regression test for the accumulator — before `apps/cli/src/wall.ts` passed `criteriaLog`
    // into the evaluation, this row read `samples: 1, passes: 1` no matter how many units ran.
    const rows = certificates();
    expect(rows[0]).toMatchObject({
      taskClass: TASK_CLASS,
      outcome: 'insufficient',
      samples: 3,
      passes: 2,
    });

    const log = criteria();
    expect(log.entries).toHaveLength(30);
    expect(log.corruptLines).toBe(0);
    const revisions = new Set(log.entries.map((entry) => entry.revision));
    expect(revisions.size).toBe(3);
    // Every revision was measured on both sides, so no revision contributes a half sample.
    for (const revision of revisions) {
      const sides = new Set(
        log.entries.filter((entry) => entry.revision === revision).map((entry) => entry.side),
      );
      expect(sides).toEqual(new Set(['base', 'candidate']));
    }

    const audit = runFactory(['audit', '--certifications', '--json'], {
      home: substrate.home,
      env: substrate.wallEnv(),
    });
    expect(audit.code).toBe(9);
    const auditBody = jsonOf(audit);
    const classes = auditBody['classes'] as readonly Record<string, unknown>[];
    expect(classes[0]).toMatchObject({ state: 'never-certified', samples: 3, m: 20 });
    // 3 < 20, so no class certificate exists, and the audit names the verified units rather than
    // letting their verification imply a class judgement. The rejected unit is never in that list:
    // it was measured and refused, which is a different fact. (What the audit *means* by an
    // uncertified unit is an open question recorded in the runbook — `mapVerdict` in the store does
    // not return `certification` at all, so a re-read verdict can never satisfy that check. The
    // assertion here is only the part that holds either way.)
    const uncertified = auditBody['uncertifiedUnits'] as readonly string[];
    expect(uncertified).not.toContain(units[1]?.unitId ?? '');
    expect(new Set(uncertified)).toEqual(new Set([units[0]?.unitId ?? '', units[2]?.unitId ?? '']));
  });
});
