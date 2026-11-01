/**
 * `factory recover` — the command that must be boring.
 *
 * The temptation is to make recovery "helpful": re-dispatch, retry, clean up. It
 * may do none of those (`ux-plan.md` §3.9), because a duplicate side effect is
 * unrecoverable while a lost attempt only costs an observation. So the tests
 * assert the *refusals*: nothing is re-dispatched, nothing is retried, the attempt
 * is marked ambiguous, and the block says exactly what is known, what is unknown
 * and what is not done.
 */
import { describe, expect, it } from 'vitest';

import { EXIT } from './exit.ts';
import { jsonOf, runCli, seedStaleAttempt, seedUnit, tempHome } from './testing.ts';

describe('recover', () => {
  it('marks an attempt with a dead lease ambiguous, prints the block, and exits 4', () => {
    const home = tempHome();
    const { unitId } = seedUnit(home, { lane: 'dark' });
    seedStaleAttempt(home, unitId);
    const result = runCli(['recover'], { home });
    expect(result.status).toBe(EXIT.unknown);
    expect(result.stderr).toContain('AMBIGUOUS');
    expect(result.stderr).toContain('KNOWN');
    expect(result.stderr).toContain('UNKNOWN');
    expect(result.stderr).toContain('NOT DONE');
    expect(result.stderr).toContain('nothing was retried');
  });

  it('says plainly that it dispatched nothing', () => {
    const home = tempHome();
    const { unitId } = seedUnit(home, { lane: 'dark' });
    seedStaleAttempt(home, unitId);
    expect(runCli(['recover'], { home }).stderr).toMatch(/0 redispatched/u);
  });

  it('is idempotent: the second run finds nothing to reconcile and exits 0', () => {
    const home = tempHome();
    const { unitId } = seedUnit(home, { lane: 'dark' });
    seedStaleAttempt(home, unitId);
    expect(runCli(['recover'], { home }).status).toBe(EXIT.unknown);
    const second = runCli(['recover'], { home });
    expect(second.status).toBe(EXIT.ok);
    expect(second.stderr).toContain('nothing was dispatched');
  });

  it('on a clean store exits 0 and reports an empty reconciliation', () => {
    const home = tempHome();
    const result = runCli(['recover'], { home });
    expect(result.status).toBe(EXIT.ok);
    expect(jsonOf(runCli(['recover', '--json'], { home }))).toMatchObject({
      ambiguous: 0,
      orphaned: 0,
    });
  });

  it('reports the ambiguity in JSON with the three-part framing', () => {
    const home = tempHome();
    const { unitId } = seedUnit(home, { lane: 'dark' });
    seedStaleAttempt(home, unitId, 'A-json01');
    const json = jsonOf(runCli(['recover', '--json'], { home }));
    expect(json['ambiguous']).toBe(1);
    expect(json['ambiguityBlock']).toMatchObject({
      known: expect.any(String),
      unknown: expect.any(String),
      notDone: expect.any(String),
    });
    expect((json['attempts'] as Array<Record<string, unknown>>)[0]).toMatchObject({
      attemptId: 'A-json01',
      unitId,
      state: 'ambiguous',
    });
  });

  it('names the observation command for each ambiguous attempt, and never a retry command', () => {
    const home = tempHome();
    const { unitId } = seedUnit(home, { lane: 'dark' });
    seedStaleAttempt(home, unitId);
    const stderr = runCli(['recover'], { home }).stderr;
    expect(stderr).toContain(`factory status ${unitId}`);
    expect(stderr).not.toContain('factory run');
    expect(stderr).not.toContain('--retry');
  });
});
