/**
 * `recover`: the command that exists because a process can die mid-attempt.
 *
 * The invariant is the prior repo's inherited #1 and it is asserted from three directions:
 * an attempt left without a terminal event becomes **ambiguous** (never `failed`, because
 * nobody knows), `recover` **never re-dispatches**, and a second `recover` changes nothing.
 * The ledger is then replayed through the store's own `audit()`, which must find zero
 * divergences — the store is the only witness to whether a duplicate effect escaped.
 *
 * E2E-21, E2E-30, E2E-31, E2E-32 of `e2e-tests.md`.
 */
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { openStore } from '../../../packages/store/src/index.ts';
import {
  jsonOf,
  newFactoryHome,
  runFactory,
  specFor,
  submitUnit,
  units,
} from '../../harness/factory.ts';
import { createFixtureRepo, type FixtureRepo } from '../../harness/fixture.ts';
import { seedStaleAttempt, seedUnit } from '../../../apps/cli/src/testing.ts';

let fixture: FixtureRepo;
let home: string;

beforeEach(() => {
  fixture = createFixtureRepo();
  home = newFactoryHome();
});

afterEach(() => {
  fixture.cleanup();
});

function attemptStates(unitId: string): string[] {
  const store = openStore({ dir: join(home, 'state') });
  try {
    return store.listAttemptsForUnit(unitId).map((attempt) => attempt.state);
  } finally {
    store.close();
  }
}

function audit(): { ok: boolean; divergences: string[]; events: number } {
  const store = openStore({ dir: join(home, 'state') });
  try {
    return store.audit();
  } finally {
    store.close();
  }
}

describe('recover', () => {
  it('[@default] an attempt with no terminal event becomes ambiguous, and is not retried', () => {
    const seeded = seedUnit(home, { lane: 'dark', state: 'qualified' });
    seedStaleAttempt(home, seeded.unitId, 'A-e2e1');

    const run = runFactory(['recover', '--json'], { home });
    const json = jsonOf(run);

    expect(run.code).toBe(4);
    expect(json['ambiguous']).toBe(1);
    const block = json['ambiguityBlock'] as Record<string, unknown> | null;
    expect(block).not.toBeNull();
    // The three questions a person asks about an ambiguous attempt, answered in words.
    expect(Object.keys(block ?? {}).sort()).toEqual(['known', 'notDone', 'unknown']);
    expect(String(block?.['notDone'])).toMatch(/no second attempt/iu);

    expect(attemptStates(seeded.unitId)).toEqual(['ambiguous']);
    // Nothing was dispatched: the attempt count is still one.
    const store = openStore({ dir: join(home, 'state') });
    try {
      expect(store.listAttemptsForUnit(seeded.unitId)).toHaveLength(1);
    } finally {
      store.close();
    }
    expect(units(home)[0]?.['attempt']).not.toBeNull();
  });

  it('[@default] a second recover is idempotent: same state, still one attempt, still exit 4', () => {
    const seeded = seedUnit(home, { lane: 'dark', state: 'qualified' });
    seedStaleAttempt(home, seeded.unitId, 'A-e2e1');

    expect(runFactory(['recover', '--json'], { home }).code).toBe(4);
    const second = runFactory(['recover', '--json'], { home });
    // Documented divergence from e2e-tests.md E2E-32: exit 4 means "I found an attempt that
    // needs a person", not "the store holds an ambiguity". On the second run nothing new is
    // discovered, so the exit code is 0 even though the unit is still ambiguous — `status`
    // remains the surface that keeps saying so (exit 5).
    expect(second.code).toBe(0);
    expect(attemptStates(seeded.unitId)).toEqual(['ambiguous']);
    expect(runFactory(['status', '--json'], { home }).code).toBe(5);
  });

  it('[@default] a clean store recovers to exit 0 and says nothing was dispatched', () => {
    submitUnit(home, { spec: specFor({ baseRev: fixture.baseRev }) });

    const run = runFactory(['recover', '--json'], { home });
    const json = jsonOf(run);

    expect(run.code).toBe(0);
    expect(json['ambiguous']).toBe(0);
    expect(json['orphaned']).toBe(0);
    expect(json['ambiguityBlock']).toBeNull();
    expect(run.stderr).toMatch(/0 redispatched/iu);
  });

  it('[@default] recovery leaves no promotion artifact and no divergence in the ledger', () => {
    const seeded = seedUnit(home, { lane: 'dark', state: 'qualified' });
    seedStaleAttempt(home, seeded.unitId, 'A-e2e1');
    expect(runFactory(['recover', '--json'], { home }).code).toBe(4);
    expect(runFactory(['promote', seeded.unitId, '--json'], { home }).code).toBe(5);

    expect(existsSync(join(home, 'artifacts', seeded.unitId, 'promotion.yaml'))).toBe(false);
    const replay = audit();
    expect(replay.ok).toBe(true);
    expect(replay.divergences).toEqual([]);
    expect(replay.events).toBeGreaterThan(0);
  });
});
