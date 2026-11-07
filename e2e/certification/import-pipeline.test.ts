/**
 * The `import-hygiene` pipeline, end to end, with a scripted worker: intent → qualify → run → wall →
 * verdict → class certificate row → `audit --certifications`.
 *
 * This is the pass half *and* the reject half, and the reject is the point of the class: the candidate
 * here is the one a worker produces after reading the visible check — every relative import carries its
 * `.ts` extension, so `node tools/check-imports.mjs` prints nothing and exits 0 — while a value import of
 * a type-only symbol and an enum survive. TypeScript accepts it, the visible suite accepts it, and node
 * cannot load it. A wall that certified this candidate would be certifying "looks repaired", which is
 * exactly the failure a class with a hidden convention exists to catch.
 *
 * The numbers asserted are the arithmetic the certificate rests on: distinct base revisions accumulate
 * as distinct samples, and a rejected candidate still occupies its sample as a non-pass.
 */
import { join } from 'node:path';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { openStore } from '../../packages/store/src/index.ts';
import { jsonOf, runFactory } from '../harness/factory.ts';
import {
  almostFixedTree,
  createImportSubstrate,
  HOLDOUT_REVISION,
  TASK_CLASS,
  type ImportSubstrate,
} from './import-substrate.ts';

let substrate: ImportSubstrate;

const certificates = (): readonly Record<string, unknown>[] => {
  const store = openStore({ dir: join(substrate.home, 'state') });
  try {
    return (store.classCertificates?.() ?? []).map((row) => ({
      taskClass: row.taskClass,
      outcome: row.outcome,
      samples: row.samples,
      passes: row.passes,
    }));
  } finally {
    store.close();
  }
};

beforeAll(() => {
  substrate = createImportSubstrate({ units: 3 });
});

afterAll(() => {
  substrate.cleanup();
});

describe('the certification pipeline for import-hygiene', () => {
  it('verifies a repaired tree and records the first class sample', () => {
    const unit = substrate.units[0];
    if (unit === undefined) throw new Error('no unit');
    const { unitId, scenarioPath } = substrate.submit(unit);
    const run = runFactory(['run', unitId, '--scenario', scenarioPath, '--json'], {
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
      const verdict = store.latestVerdictForUnit(unitId);
      expect(verdict?.outcome).toBe('pass');
      // The verdict names the corpus it was measured against — the class token, not "any corpus".
      expect(verdict?.holdoutRevision).toBe(HOLDOUT_REVISION);
    } finally {
      store.close();
    }

    const rows = certificates();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      taskClass: TASK_CLASS,
      outcome: 'insufficient',
      samples: 1,
      passes: 1,
    });
  });

  it('rejects the candidate that satisfies the visible check and fails the class', () => {
    const unit = substrate.units[1];
    if (unit === undefined) throw new Error('no unit');
    const { unitId, scenarioPath } = substrate.submit(unit, almostFixedTree(unit.index));
    const run = runFactory(['run', unitId, '--scenario', scenarioPath, '--json'], {
      home: substrate.home,
      env: substrate.wallEnv(),
      timeoutMs: 180_000,
    });
    // The wall refuses the change: `VERDICT_FAILED` (3) is the policy refusal, and the verdict is what
    // carries the reason. Asserting the code as well as the verdict keeps "exit 0" from ever being read
    // as "passed".
    expect(run.code, run.stderr).toBe(3);
    const body = jsonOf(run);
    expect(body['outcome']).toBe('fail');
    // A failed verdict ends the unit: `rejected` is terminal, and there is no state in which a rejected
    // unit waits for a promotion that can never be signed.
    expect(body['state']).toBe('rejected');

    const store = openStore({ dir: join(substrate.home, 'state') });
    try {
      const verdict = store.latestVerdictForUnit(unitId);
      expect(verdict?.outcome).toBe('fail');
      // The visible suite passed: the failure is the class's, and the reason names the holdout.
      const reasons = JSON.stringify(verdict?.verdict.reasons ?? []);
      expect(reasons).toContain('holdout');
    } finally {
      store.close();
    }

    // A rejected candidate is a judged sample, not a gap: it occupies its revision as a non-pass, so
    // two distinct base revisions are `samples: 2` and `passes: 1`. `classCertificates()` is newest
    // first, so the row to assert is `rows[0]`.
    const rows = certificates();
    expect(rows[0]).toMatchObject({ taskClass: TASK_CLASS, samples: 2, passes: 1 });
  });

  it('has a unit that can still pass and says what the certificate would need', () => {
    const unit = substrate.units[2];
    if (unit === undefined) throw new Error('no unit');
    const { unitId, scenarioPath } = substrate.submit(unit);
    const run = runFactory(['run', unitId, '--scenario', scenarioPath, '--json'], {
      home: substrate.home,
      env: substrate.wallEnv(),
      timeoutMs: 180_000,
    });
    expect(run.code, run.stderr).toBe(0);
    expect(jsonOf(run)['outcome']).toBe('pass');

    const rows = certificates();
    expect(rows[0]).toMatchObject({ taskClass: TASK_CLASS, samples: 3, passes: 2 });
    // And the audit says, in the same words the operator reads, that three of twenty is not a
    // certificate: the class is `insufficient`, so nothing is certified and nothing is refused.
    const audit = runFactory(['audit', '--certifications', '--json'], {
      home: substrate.home,
      env: substrate.wallEnv({ FACTORY_MODEL_ID: 'fixture/offline-scripted-worker' }),
    });
    const auditBody = jsonOf(audit);
    const classes = auditBody['classes'] as Array<Record<string, unknown>>;
    const mine = classes.find((entry) => entry['taskClass'] === TASK_CLASS);
    expect(mine).toMatchObject({
      state: 'never-certified',
      outcome: 'insufficient',
      samples: 3,
      m: 20,
    });
  });
});
