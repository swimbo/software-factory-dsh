/**
 * The scheduled re-certification, spending — the control that had a plan and no evidence of a spend.
 *
 * `scripts/recertify-due.sh` has two halves. The detection half (`factory alerts`, `audit --certifications`)
 * shipped long ago and is exercised nightly. The acting half is `--spend`, and until now its only tests drove
 * it with a stubbed plan and a stubbed runner: they proved the *script* reacts correctly, never that a real
 * plan, a real budget and the real driver compose into an attempt the store counts.
 *
 * This spec composes them, with the scripted worker:
 *
 *  - a real store with one measured attempt, so the projection has a measured basis (never an estimate from
 *    another class). **The usage row is a fixture**: the scripted worker has no gateway, so the spec records
 *    what a live attempt would have cost. That is the one number here that is invented, it is labelled, and
 *    the engine never sees it as a pass — it only feeds the budget arithmetic.
 *  - `FACTORY_RECERTIFY_BUDGET_TOKENS` above and below the projection: `would-spend`, then `refused-over-budget`
 *    with the driver never invoked.
 *  - the real `scripts/certify-class.sh`, which takes one `factory run` per unit. Its worker is the scripted
 *    executor, so the tokens actually spent are zero and the *spend path* is what is under test: the plan's
 *    decision, the credential read, the per-unit run, the verdict, the certificate row, the alert.
 *
 * So the honest claim is narrow and worth making: **the scheduled spend path executes end to end and stops at
 * the budget it is given**. What it does not show is the economics of a live class — that is the operator's
 * decision to make with the numbers in `docs/runbooks/certify-class.md` §10.
 */
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { openStore } from '../../packages/store/src/index.ts';
import { jsonOf, runFactory } from '../harness/factory.ts';
import {
  createImportSubstrate,
  fixedTree,
  TASK_CLASS,
  type ImportSubstrate,
} from './import-substrate.ts';

const ROOT = join(import.meta.dirname, '..', '..');

let substrate: ImportSubstrate;
let unitsDir: string;
let keyCommand: string;

beforeAll(() => {
  substrate = createImportSubstrate({ units: 3 });
  // One measured pass, so the class is due for re-certification and the projection has a basis.
  const first = substrate.units[0];
  if (first === undefined) throw new Error('no unit');
  const { unitId, scenarioPath } = substrate.submit(first, fixedTree(0));
  const run = runFactory(['run', unitId, '--scenario', scenarioPath, '--json'], {
    home: substrate.home,
    env: substrate.wallEnv(),
    timeoutMs: 180_000,
  });
  expect(run.code, run.stderr).toBe(0);

  // The fixture usage row: 30k in, 2k out. A live attempt would have written this from the gateway's
  // response; the scripted worker has no gateway, so the spec writes it, and says so here.
  const store = openStore({ dir: join(substrate.home, 'state') });
  try {
    const verdict = store.latestVerdictForUnit(unitId);
    if (verdict === null) throw new Error('no verdict for the measured attempt');
    store.recordUsage({
      usageId: 'usg-recertify-fixture-1',
      unitId,
      attemptId: verdict.attemptId,
      tokensIn: 30_000,
      tokensOut: 2_000,
      costUsd: 0.01,
      gatewayRequestId: null,
      signedAt: new Date('2026-11-08T12:00:00.000Z').toISOString(),
      ceilingCrossed: false,
    });
  } finally {
    store.close();
  }

  // The remaining units are pre-submitted and dark, which is what the driver's units file names.
  unitsDir = mkdtempSync(join(tmpdir(), 'recertify-units-'));
  const remaining = [substrate.units[1], substrate.units[2]];
  const ids: string[] = [];
  for (const unit of remaining) {
    if (unit === undefined) continue;
    ids.push(substrate.submit(unit, fixedTree(unit.index)).unitId);
  }
  writeFileSync(join(unitsDir, `${TASK_CLASS}.txt`), `${ids.join('\n')}\n`);

  // The driver reads a credential for every run; the scripted executor uses none, but the driver refuses to
  // dispatch without one. The stub is a file, because `CERTIFY_KEY_COMMAND` is executed, not eval'd.
  keyCommand = join(substrate.root, 'fake-key.sh');
  writeFileSync(keyCommand, '#!/bin/sh\nprintf %s fake-key-for-the-scripted-executor\n');
  chmodSync(keyCommand, 0o755);
});

afterAll(() => {
  rmSync(unitsDir, { recursive: true, force: true });
  substrate.cleanup();
});

function samples(): number {
  const store = openStore({ dir: join(substrate.home, 'state') });
  try {
    return (store.classCertificates?.() ?? [])[0]?.samples ?? 0;
  } finally {
    store.close();
  }
}

function recertify(extra: Record<string, string>): {
  readonly code: number;
  readonly output: string;
} {
  const result = spawnSync('bash', ['scripts/recertify-due.sh', '--spend'], {
    cwd: ROOT,
    encoding: 'utf8',
    env: {
      ...process.env,
      ...substrate.wallEnv(),
      FACTORY_HOME: substrate.home,
      FACTORY_EXECUTOR: 'fake',
      FACTORY_RECERTIFY_UNITS_DIR: unitsDir,
      CERTIFY_KEY_COMMAND: keyCommand,
      CERTIFY_NODE_BIN: process.execPath,
      RECERTIFY_NODE_BIN: process.execPath,
      ...extra,
    },
    timeout: 600_000,
  });
  return { code: result.status ?? -1, output: `${result.stdout ?? ''}${result.stderr ?? ''}` };
}

describe('the scheduled spend stops at the budget it is given', () => {
  it('refuses to spend when the measured projection exceeds the class budget, and dispatches nothing', () => {
    const before = samples();
    const result = recertify({ FACTORY_RECERTIFY_BUDGET_TOKENS: `${TASK_CLASS}=100000` });
    expect(result.code, result.output).toBe(0);
    // 32,000 measured tokens per attempt × 19 remaining = 608,000 > 100,000.
    expect(result.output).toContain('refused-over-budget');
    expect(result.output).toContain('not spending');
    expect(result.output).not.toContain('driver finished');
    expect(samples()).toBe(before);
  });

  it('spends when the budget covers the projection: the real driver runs, the store counts the attempts', () => {
    const before = samples();
    const result = recertify({ FACTORY_RECERTIFY_BUDGET_TOKENS: `${TASK_CLASS}=5000000` });
    // The driver stops at the end of the two units the plan supplied, which is exit 2 (`units-exhausted`)
    // and therefore `incomplete` rather than `finished` — 4 from the script, unknown and never a pass.
    // That distinction is itself a finding from this composition: before it, the script took this branch
    // to `driver FAILED` and exited before the alert, so the night that made progress was silent.
    expect(result.code, result.output).toBe(4);
    expect(result.output).toContain('would spend');
    expect(result.output).toContain('incomplete, not failed');
    // Two pre-submitted units, two attempts, two more samples — and the class still short of m, which is
    // the state a nightly job leaves behind for the next night.
    expect(samples()).toBe(before + 2);

    // Zero tokens were metered: the worker was the scripted executor, so there is no gateway response to
    // reconcile. The spend path ran; the money did not move. Saying that is the point of this spec.
    const store = openStore({ dir: join(substrate.home, 'state') });
    try {
      const usage = store.listUnits({}).flatMap((unit) => store.usageForAttempt(unit.unitId) ?? []);
      expect(usage).toHaveLength(0);
    } finally {
      store.close();
    }

    // And the class's own audit agrees about what the night produced.
    const audit = runFactory(['audit', '--certifications', '--json'], {
      home: substrate.home,
      env: substrate.wallEnv({ FACTORY_MODEL_ID: 'fixture/offline-scripted-worker' }),
    });
    const classes = jsonOf(audit)['classes'] as Array<Record<string, unknown>>;
    const mine = classes.find((entry) => entry['taskClass'] === TASK_CLASS);
    expect(mine).toMatchObject({ outcome: 'insufficient', samples: 3, m: 20 });
  }, 600_000);
});
