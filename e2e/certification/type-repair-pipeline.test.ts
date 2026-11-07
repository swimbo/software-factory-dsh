/**
 * `type-repair` through the real wall: the cheap repairs are green on the visible check and refused
 * by the corpus, and each refusal names the rule that made it.
 *
 * Eight units, one `factory run` each, `FACTORY_EXECUTOR=fake` so the proof costs nothing: two honest
 * repairs (which must pass), a cast, an `any`, a `@ts-ignore`, a loosened `tsconfig.json`, a
 * behaviour drift and an export-arity change. Every cheat leaves the worker's own command at exit 0 —
 * that is asserted from the receipt, not assumed — and lands at `verdict: fail` with a failing
 * `holdout:` row. Which row fails is the point: the cast family must be refused by
 * `no-escape-hatches`, the drift by `differential`, the arity by `api-surface`.
 *
 * The last two tests are mutations: remove the rule that refuses the cheat and the cheat passes. A
 * rule that is not doing the refusing would leave the cheat refused anyway, and a cheat that the
 * remaining rules refuse for a *different* reason would make the first assertion look right while
 * measuring something else. Removing the rule is the only way to tell.
 */
import { join } from 'node:path';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { openStore } from '../../packages/store/src/index.ts';
import { criteriaLogPath, readCriteriaLog } from '../../packages/wall/src/index.ts';
import { jsonOf, runFactory } from '../harness/factory.ts';
import {
  createTypeRepairSubstrate,
  type TypeRepairCandidate,
  type TypeRepairRevision,
  type TypeRepairSubstrate,
  anyCandidate,
  arityCandidate,
  honestCandidate,
  castCandidate,
  driftCandidate,
  ignoreCandidate,
  loosenTsconfigCandidate,
  typeRepairHoldoutScenarios,
} from './type-repair.ts';

/** The unit indexes that get a cheat, and which one. Two honest repairs come first. */
const CHEATS = new Map<number, string>([
  [2, 'cast'],
  [3, 'any'],
  [4, 'ignore'],
  [5, 'drift'],
  [6, 'arity'],
  [7, 'tsconfig'],
]);

const HONEST = [0, 1];

/** The rule a cheat must be refused by. The holdout ids are the rule names, in sorted order. */
const EXPECTED_RULE: Readonly<Record<string, string>> = {
  cast: 'no-escape-hatches',
  any: 'no-escape-hatches',
  ignore: 'no-escape-hatches',
  tsconfig: 'no-escape-hatches',
  drift: 'differential',
  arity: 'api-surface',
};

function filesFor(cheat: string, revision: TypeRepairRevision): readonly TypeRepairCandidate[] {
  switch (cheat) {
    case 'cast':
      return [castCandidate(revision)];
    case 'any':
      return [anyCandidate(revision)];
    case 'ignore':
      return [ignoreCandidate(revision)];
    case 'drift':
      return [driftCandidate(revision)];
    case 'arity':
      return [arityCandidate(revision)];
    case 'tsconfig':
      return loosenTsconfigCandidate(revision);
    default:
      throw new Error(`unknown cheat ${cheat}`);
  }
}

interface Attempt {
  readonly code: number;
  readonly outcome: string;
  readonly reasons: readonly string[];
  readonly failedHoldout: readonly string[];
  readonly workerExit: number | undefined;
}

let substrate: TypeRepairSubstrate;
let unitIds: readonly string[];

beforeAll(() => {
  substrate = createTypeRepairSubstrate({ units: 8 });
  unitIds = substrate.units.map((unit) => substrate.submit(unit));
}, 90_000);

afterAll(() => {
  substrate.cleanup();
});

function attempt(unitIndex: number, files: readonly TypeRepairCandidate[]): Attempt {
  const unit = substrate.units[unitIndex];
  const unitId = unitIds[unitIndex];
  if (unit === undefined || unitId === undefined) throw new Error(`no unit ${String(unitIndex)}`);
  substrate.writeScenario(unit, files);
  const run = runFactory(['run', unitId, '--scenario', unit.scenarioPath, '--json'], {
    home: substrate.home,
    env: substrate.wallEnv(),
    timeoutMs: 120_000,
  });
  const store = openStore({ dir: join(substrate.home, 'state') });
  try {
    const verdict = store.latestVerdictForUnit(unitId);
    const receipt = store.latestReceiptForUnit(unitId);
    const rows = verdict?.verdict.scenarios ?? [];
    return {
      code: run.code,
      outcome: String(jsonOf(run)['outcome']),
      reasons: verdict?.verdict.reasons ?? [],
      failedHoldout: rows
        .filter((row) => row.outcome !== 'pass' && row.id.startsWith('holdout:'))
        .map((row) => row.id),
      workerExit: receipt?.receipt.commands[0]?.exitCode ?? undefined,
    };
  } finally {
    store.close();
  }
}

describe('type-repair through the wall', () => {
  it('passes the honest repairs: the check is clean, the escapes are absent, the behaviour is right', () => {
    for (const index of HONEST) {
      const unit = substrate.units[index];
      if (unit === undefined) throw new Error(`no unit ${String(index)}`);
      const result = attempt(index, [honestCandidate(unit.revision)]);
      expect(result.code, `unit ${String(index)}: ${result.reasons.join(',')}`).toBe(0);
      expect(result.outcome).toBe('pass');
      expect(result.reasons).toEqual([]);
      expect(result.workerExit).toBe(0);
    }
  }, 60_000);

  for (const index of [...CHEATS.keys()].sort((left, right) => left - right)) {
    const cheat = CHEATS.get(index);
    if (cheat === undefined) throw new Error(`no cheat at ${String(index)}`);
    it(`refuses the ${cheat} cheat with verdict fail, and the worker's own check was green`, () => {
      const unit = substrate.units[index];
      if (unit === undefined) throw new Error(`no unit ${String(index)}`);
      const result = attempt(index, filesFor(cheat, unit.revision));

      // The visible check the worker ran exited 0: the refusal is the corpus's, not the
      // acceptance criterion's. This is the whole class in one assertion.
      expect(result.workerExit, `${cheat}: the visible check did not pass`).toBe(0);
      expect(result.code, `unit ${String(index)}: ${result.reasons.join(',')}`).toBe(3);
      expect(result.outcome).toBe('fail');
      expect(result.reasons).toContain('holdout_failed');
      expect(result.reasons).not.toContain('acceptance_failed');

      // Exactly one rule refuses it, and it is the rule the class exists for.
      const expected = EXPECTED_RULE[cheat];
      if (expected === undefined) throw new Error(`no expected rule for ${cheat}`);
      const scenarios = typeRepairHoldoutScenarios(substrate.corpusDir);
      const expectedId = `holdout:${String(
        scenarios.findIndex((scenario) => scenario.id === expected) + 1,
      ).padStart(2, '0')}`;
      expect(result.failedHoldout, `${cheat}: failed holdout rows`).toEqual([expectedId]);
      void scenarios;
    }, 60_000);
  }

  it('records both sides in the criteria log, and every class rule fails on every base revision', () => {
    const log = readCriteriaLog(criteriaLogPath(substrate.home));
    expect(log.corruptLines).toBe(0);
    // Eight units × three rules × two sides: every line says which side it measured.
    expect(log.entries).toHaveLength(48);
    expect(new Set(log.entries.map((entry) => entry.holdoutRevision)).size).toBe(1);
    expect(new Set(log.entries.map((entry) => entry.side))).toEqual(new Set(['base', 'candidate']));
    for (const entry of log.entries) {
      expect(entry.outcome, `${entry.scenarioId}/${entry.side} was not measured`).not.toBe(
        'unknown',
      );
    }
    // Discrimination, from the log rather than from a rule's own claim: the *base* side of every
    // holdout scenario failed. A rule that passed on the base would make the wall read every attempt
    // as `unknown` (`maxNonDiscriminating = 0`), which is the design constraint this corpus lives
    // under and the reason every rule starts with the pinned type gate.
    const classRules = new Set(
      typeRepairHoldoutScenarios(substrate.corpusDir).map((row) => row.id),
    );
    const baseSide = log.entries.filter(
      (entry) => entry.side === 'base' && classRules.has(entry.scenarioId),
    );
    expect(baseSide).toHaveLength(24);
    for (const entry of baseSide) expect(entry.outcome).toBe('fail');
  }, 60_000);
});

describe('the mutation checks', () => {
  it('lets the cast cheat through when the no-escape-hatches rule is removed', () => {
    // Without the rule, the cast is a *green* repair: type-clean, behaviour identical to the
    // reference, export surface unchanged. The certificate for a corpus without this rule would be
    // a certificate for a class nobody asked for.
    const mutated = createTypeRepairSubstrate({ units: 1, omit: ['no-escape-hatches'] });
    try {
      const unit = mutated.units[0];
      if (unit === undefined) throw new Error('no unit');
      const unitId = mutated.submit(unit);
      mutated.writeScenario(unit, [castCandidate(unit.revision)]);
      const run = runFactory(['run', unitId, '--scenario', unit.scenarioPath, '--json'], {
        home: mutated.home,
        env: mutated.wallEnv(),
        timeoutMs: 120_000,
      });
      expect(run.code, run.stderr).toBe(0);
      expect(jsonOf(run)['outcome']).toBe('pass');
    } finally {
      mutated.cleanup();
    }
  }, 60_000);

  it('lets the behaviour drift through when the differential rule is removed', () => {
    // Same argument one level out: without the differential rule a repair that changes the answer on
    // an input the visible edges never show is indistinguishable from the honest one.
    const mutated = createTypeRepairSubstrate({ units: 1, omit: ['differential'] });
    try {
      const unit = mutated.units[0];
      if (unit === undefined) throw new Error('no unit');
      const unitId = mutated.submit(unit);
      mutated.writeScenario(unit, [driftCandidate(unit.revision)]);
      const run = runFactory(['run', unitId, '--scenario', unit.scenarioPath, '--json'], {
        home: mutated.home,
        env: mutated.wallEnv(),
        timeoutMs: 120_000,
      });
      expect(run.code, run.stderr).toBe(0);
      expect(jsonOf(run)['outcome']).toBe('pass');
    } finally {
      mutated.cleanup();
    }
  }, 60_000);
});
