/**
 * The one gate in the engine that has never fired on real evidence: `CLASS_NOT_CERTIFIED`.
 *
 * `packages/core/src/engine.ts` refuses to dispatch a unit whose class has been *measured* to
 * `not-certified` — `m` samples in, fewer than `k` passes. That is a different state from `insufficient`
 * (a class with fewer than `m` samples), which dispatches by design, because otherwise no class could
 * ever take its first unit. The distinction was documented and untested end to end: a class had never
 * reached `not-certified`, so the refusal had no evidence behind it.
 *
 * This spec reaches the state the slow way and then checks the refusal, all with the scripted worker:
 *
 *  1. twenty distinct base revisions, each attempt measured and failed (`passes: 0`, `samples: 20`);
 *  2. the store's answer for the class is `not-certified`, not `insufficient`;
 *  3. a twenty-first unit, submitted and qualified, is refused at `factory run` with exit 3 and
 *     `CLASS_NOT_CERTIFIED`, before the wall and before any attempt is recorded.
 *
 * Twenty attempts of a fake worker cost no tokens — the corpus runs are local node scripts. What the
 * spec proves is the *engine's decision*, which is the same decision a live worker would meet.
 */
import { join } from 'node:path';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { openStore } from '../../packages/store/src/index.ts';
import { jsonOf, runFactory } from '../harness/factory.ts';
import {
  almostFixedTree,
  createImportSubstrate,
  TASK_CLASS,
  type ImportSubstrate,
} from './import-substrate.ts';

/** The operating point's m: the number of measured attempts a certificate is read from. */
const M = 20;

let substrate: ImportSubstrate;

beforeAll(() => {
  // M + 1 units: twenty to spend on the certificate and one left for the refusal.
  substrate = createImportSubstrate({ units: M + 1 });
});

afterAll(() => {
  substrate.cleanup();
});

const classRow = (): Record<string, unknown> | undefined => {
  const store = openStore({ dir: join(substrate.home, 'state') });
  try {
    return (store.classCertificates?.() ?? []).map((row) => ({
      taskClass: row.taskClass,
      outcome: row.outcome,
      samples: row.samples,
      passes: row.passes,
    }))[0];
  } finally {
    store.close();
  }
};

describe('the certificate gate refuses a class that has been measured as not certified', () => {
  it('measures twenty failed attempts, then refuses the twenty-first unit before dispatch', () => {
    for (const unit of substrate.units.slice(0, M)) {
      // The candidate is the tree a worker produces after reading the visible check: every extension is
      // present, so the visible suite passes, and a value import of a type-only symbol survives — the
      // holdout refuses it, which makes it a *measured* fail rather than an unmeasurable one. (Writing the
      // bare broken tree instead would delete the tools the wall needs, and the verdict would be `unknown`,
      // not `fail`: an unmeasurable attempt is not a sample.)
      const { unitId, scenarioPath } = substrate.submit(unit, almostFixedTree(unit.index));
      const run = runFactory(['run', unitId, '--scenario', scenarioPath, '--json'], {
        home: substrate.home,
        env: substrate.wallEnv(),
        timeoutMs: 180_000,
      });
      expect(run.code, `${unitId}: ${run.stderr}`).toBe(3);
      expect(jsonOf(run)['outcome']).toBe('fail');
    }

    // Twenty samples, twenty non-passes: `not-certified`, which is the state the gate refuses.
    expect(classRow()).toMatchObject({
      taskClass: TASK_CLASS,
      outcome: 'not-certified',
      samples: M,
      passes: 0,
    });

    const audit = runFactory(['audit', '--certifications', '--json'], {
      home: substrate.home,
      env: substrate.wallEnv({ FACTORY_MODEL_ID: 'fixture/offline-scripted-worker' }),
    });
    const classes = jsonOf(audit)['classes'] as Array<Record<string, unknown>>;
    const mine = classes.find((entry) => entry['taskClass'] === TASK_CLASS);
    // The audit's *state* vocabulary answers "has a certificate ever been issued?", so a class measured
    // to twenty failures is still `never-certified`; the *outcome* is the measurement, and that is the
    // field the engine's gate reads.
    expect(mine).toMatchObject({
      state: 'never-certified',
      outcome: 'not-certified',
      samples: M,
      m: M,
    });

    // The unit under test: qualified, certified-looking to every other gate, and refused here alone.
    const next = substrate.units[M];
    if (next === undefined) throw new Error('no unit left for the refusal');
    const { unitId, scenarioPath } = substrate.submit(next);
    const refused = runFactory(['run', unitId, '--scenario', scenarioPath, '--json'], {
      home: substrate.home,
      env: substrate.wallEnv(),
      timeoutMs: 180_000,
    });
    expect(refused.code, refused.stderr).toBe(3);
    const body = jsonOf(refused);
    // The code is the machine-readable refusal; the message is the sentence an operator reads. Both have to
    // name the class, and the message has to carry the measurement, or the refusal is a wall with no handle.
    expect(body['code']).toBe('CLASS_NOT_CERTIFIED');
    const message = String(body['message'] ?? '');
    expect(message).toContain('is not certified');
    // It names the class and the measurement, because a refusal an operator cannot act on is a wall.
    expect(message).toContain(TASK_CLASS);
    expect(message).toMatch(/not-certified|not certified/u);

    // Nothing was dispatched and no verdict was recorded: the refusal happens before the wall runs, so
    // there is no attempt to count and the unit keeps the state its qualification gave it.
    const store = openStore({ dir: join(substrate.home, 'state') });
    try {
      expect(store.latestVerdictForUnit(unitId)).toBeNull();
      expect(store.getUnit(unitId)?.state).toBe('qualified');
    } finally {
      store.close();
    }
    // And the certificate row did not move: a refused unit is not a sample.
    expect(classRow()).toMatchObject({ samples: M, passes: 0 });
  }, 600_000);
});
