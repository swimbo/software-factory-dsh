/**
 * The `type-repair` accumulator, offline: six measured attempts against a throwaway store.
 *
 * The paid loop is twenty; this spec spends nothing and measures six, because the gate has a budget
 * and the wall work per attempt is real (three class rules, each starting with a compiler run, on
 * both sides of Δ). What it proves is the machinery the paid loop depends on: every attempt
 * increments `samples`, a clean attempt increments `passes`, a refused cheat increments `samples`
 * and not `passes`, and the certificate stays `insufficient` until `m` samples exist. The flip at
 * twenty is the paid loop's job (`docs/runbooks/certify-class-type-repair.md`), and it is the same
 * arithmetic this spec measures at six.
 *
 * The numbers are read back from the store and the criteria log, not from the driver's tally.
 */
import { join } from 'node:path';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { openStore } from '../../packages/store/src/index.ts';
import { criteriaLogPath, readCriteriaLog } from '../../packages/wall/src/index.ts';
import { jsonOf, runFactory } from '../harness/factory.ts';
import {
  TYPE_REPAIR_HOLDOUT_BASE_REVISION,
  TYPE_REPAIR_TASK_CLASS,
  castCandidate,
  createTypeRepairSubstrate,
  typeRepairHoldoutScenarios,
  type TypeRepairSubstrate,
} from './type-repair.ts';

/** The honest attempts. Six, because six is what the gate can afford; the paid loop runs twenty. */
const LOOP = 6;

interface Sample {
  readonly run: number;
  readonly samples: number;
  readonly passes: number;
  readonly outcome: string;
}

let substrate: TypeRepairSubstrate;
let unitIds: readonly string[];

function newestCertificate(): {
  readonly outcome: string;
  readonly samples: number;
  readonly passes: number;
  readonly m: number;
  readonly modelId: string | null;
} | null {
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

function runUnit(index: number, cheat: boolean): Sample {
  const unit = substrate.units[index];
  const unitId = unitIds[index];
  if (unit === undefined || unitId === undefined) throw new Error(`no unit ${String(index)}`);
  if (cheat) substrate.writeScenario(unit, [castCandidate(unit.revision)]);
  const run = runFactory(['run', unitId, '--scenario', unit.scenarioPath, '--json'], {
    home: substrate.home,
    env: substrate.wallEnv(),
    timeoutMs: 120_000,
  });
  expect(run.code, `unit ${String(index)}:\n${run.stderr}`).toBe(cheat ? 3 : 0);
  expect(jsonOf(run)['outcome']).toBe(cheat ? 'fail' : 'pass');
  const row = newestCertificate();
  if (row === null) throw new Error('no certificate row after a verdict');
  return { run: index + 1, samples: row.samples, passes: row.passes, outcome: row.outcome };
}

beforeAll(() => {
  // Six honest attempts reach the operating point's *shape*; the seventh is the refusal that shows
  // a failed attempt consumes a sample without adding a pass.
  substrate = createTypeRepairSubstrate({ units: LOOP + 1 });
  unitIds = substrate.units.map((unit) => substrate.submit(unit));
}, 90_000);

afterAll(() => {
  substrate.cleanup();
});

const progression: Sample[] = [];

describe('six measured attempts of type-repair', () => {
  it('counts samples and passes one per attempt, and never certifies below m', () => {
    for (let index = 0; index < 3; index += 1) progression.push(runUnit(index, false));
    expect(progression.map((sample) => sample.samples)).toEqual([1, 2, 3]);
    expect(progression.map((sample) => sample.passes)).toEqual([1, 2, 3]);
    expect(newestCertificate()).toMatchObject({
      outcome: 'insufficient',
      samples: 3,
      passes: 3,
      m: 20,
      modelId: 'fixture/offline-scripted-worker',
    });
  }, 300_000);

  it('keeps the certificate insufficient at six, and counts a refused cheap repair as a sample without a pass', () => {
    for (let index = 3; index < LOOP; index += 1) progression.push(runUnit(index, false));
    expect(progression.map((sample) => sample.samples)).toEqual([1, 2, 3, 4, 5, 6]);
    expect(progression.map((sample) => sample.passes)).toEqual([1, 2, 3, 4, 5, 6]);
    expect(progression.at(-1)).toMatchObject({ samples: 6, passes: 6, outcome: 'insufficient' });
    expect(progression.filter((sample) => sample.outcome === 'certified')).toHaveLength(0);

    // A refused cheap repair is a measured failure: it consumes a sample and adds no pass. That
    // arithmetic is what makes 18 of 20 the honest number for this class rather than 20 of 20.
    const refused = runUnit(LOOP, true);
    expect(refused).toMatchObject({ samples: 7, passes: 6, outcome: 'insufficient' });
    expect(newestCertificate()).toMatchObject({ samples: 7, passes: 6 });

    // The refusal was the corpus's, not the visible check's.
    const refusedId = unitIds[LOOP];
    if (refusedId === undefined) throw new Error('no refused unit id');
    const store = openStore({ dir: join(substrate.home, 'state') });
    try {
      const verdict = store.latestVerdictForUnit(refusedId);
      const receipt = store.latestReceiptForUnit(refusedId);
      expect(receipt?.receipt.commands[0]?.exitCode).toBe(0);
      expect(verdict?.verdict.reasons).toContain('holdout_failed');
      expect(
        (verdict?.verdict.scenarios ?? [])
          .filter((row) => row.outcome !== 'pass')
          .map((row) => row.id),
      ).toContain('holdout:03');
    } finally {
      store.close();
    }
  }, 300_000);

  it('left the evidence an operator reads: a criteria log with every class rule measured on both sides, and a store with no unreachable unit', () => {
    const log = readCriteriaLog(criteriaLogPath(substrate.holdoutRoot));
    expect(log.corruptLines).toBe(0);
    // Seven attempts × three rules × two sides.
    expect(log.entries).toHaveLength(42);
    expect(new Set(log.entries.map((entry) => entry.holdoutRevision))).toEqual(
      new Set([TYPE_REPAIR_HOLDOUT_BASE_REVISION]),
    );
    const rules = new Set(typeRepairHoldoutScenarios(substrate.corpusDir).map((row) => row.id));
    for (const entry of log.entries) {
      expect(entry.outcome, `${entry.scenarioId}/${entry.side} was not measured`).not.toBe(
        'unknown',
      );
    }
    const baseSide = log.entries.filter(
      (entry) => entry.side === 'base' && rules.has(entry.scenarioId),
    );
    expect(baseSide).toHaveLength(21);
    for (const entry of baseSide) expect(entry.outcome).toBe('fail');

    const store = openStore({ dir: join(substrate.home, 'state') });
    try {
      const verified = [...store.listUnits({ state: 'verified' })];
      const rejected = store.listUnits({ state: 'rejected' });
      expect(verified.length).toBe(6);
      expect(rejected.length).toBe(1);
      for (const unit of verified) {
        const verdict = store.latestVerdictForUnit(unit.unitId);
        if (verdict === null) throw new Error(`no verdict for ${unit.unitId}`);
        expect(
          (verdict.verdict as unknown as Record<string, unknown>)['certification'],
          'the store strips the per-verdict certificate',
        ).toBe(undefined);
      }
    } finally {
      store.close();
    }

    // The audit says the class is not certified yet, and why — the alert that would disappear once
    // the paid loop reaches m.
    const audit = runFactory(['audit', '--certifications', '--json'], {
      home: substrate.home,
      env: substrate.wallEnv(),
    });
    const classes = jsonOf(audit)['classes'] as readonly Record<string, unknown>[];
    expect(classes?.[0]).toMatchObject({
      taskClass: TYPE_REPAIR_TASK_CLASS,
      outcome: 'insufficient',
      samples: 7,
      m: 20,
    });
    const alerts = runFactory(['alerts', '--json'], {
      home: substrate.home,
      env: substrate.wallEnv(),
    });
    const codes = (jsonOf(alerts)['alerts'] as readonly Record<string, unknown>[]).map(
      (alert) => alert['code'],
    );
    expect(codes).toContain('CERT_NEVER');
  }, 300_000);
});
