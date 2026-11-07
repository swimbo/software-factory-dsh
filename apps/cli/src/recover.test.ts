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
import { chmodSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { EXIT } from './exit.ts';
import { jsonOf, runCli, seedStaleAttempt, seedUnit, tempHome } from './testing.ts';

/** Write a launch record next to the attempt, where the adapter writes it. */
function writeLaunchRecord(
  home: string,
  unitId: string,
  attemptId: string,
  container: unknown,
): string {
  const dir = join(home, 'attempts', unitId, attemptId);
  mkdirSync(dir, { recursive: true });
  const path = join(dir, 'launch.json');
  writeFileSync(
    path,
    `${JSON.stringify({ schema: 'launch/1', attemptId, unitId, container }, null, 2)}\n`,
  );
  return path;
}

/** A docker client that reports one labelled container, removes it, then reports none. */
function fakeDockerThatReaps(home: string, containerId: string): string {
  const dir = join(home, 'fake-docker');
  mkdirSync(dir, { recursive: true });
  const state = join(dir, 'removed');
  const path = join(dir, 'docker');
  writeFileSync(
    path,
    [
      '#!/bin/sh',
      `state=${JSON.stringify(state)}`,
      'case "$1" in',
      '  ps)',
      '    if [ -f "$state" ]; then exit 0; fi',
      `    printf '%s\\n' '${containerId}'`,
      '    exit 0 ;;',
      '  rm)',
      '    printf \'%s\\n\' "$3" > "$state"',
      '    exit 0 ;;',
      'esac',
      'exit 2',
    ].join('\n'),
    { mode: 0o755 },
  );
  chmodSync(path, 0o755);
  return path;
}

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

/**
 * The recover-side container sweep, through the real binary and a scripted docker client.
 *
 * The real daemon is `e2e/cli/docker/09-recover-sweep.test.ts`; here the question is the contract
 * `recover` has with a caller. Three things must hold without a daemon: a sweep that could not
 * run is visible in text and `--json`; it never changes the exit code; and a host attempt never
 * reaches docker at all.
 */
describe('recover’s container sweep', () => {
  /** The docker client name that must not be called, and proves it when it is. */
  const NO_DOCKER = '/nonexistent/factory-docker-must-not-be-called';

  it('reports an attempt with no launch record as skipped, with the reason as a value', () => {
    const home = tempHome();
    const { unitId } = seedUnit(home, { lane: 'dark' });
    seedStaleAttempt(home, unitId, 'A-norecord');
    const run = runCli(['recover', '--json'], { home });
    expect(run.status).toBe(EXIT.unknown);
    const sweeps = jsonOf(run)['sweeps'] as Array<Record<string, unknown>>;
    expect(sweeps).toHaveLength(1);
    expect(sweeps[0]).toMatchObject({ attemptId: 'A-norecord', status: 'skipped' });
    expect(String(sweeps[0]?.['reason'])).toMatch(/no launch record/u);
    // Text output says it too, in the same words the JSON carries as a fact.
    expect(run.stderr).toMatch(/skipped: no launch record/u);
  });

  it('fails soft when docker cannot be reached: exit 4 stays, and the sweep is loud', () => {
    const home = tempHome();
    const { unitId } = seedUnit(home, { lane: 'dark' });
    seedStaleAttempt(home, unitId, 'A-nodocker');
    writeLaunchRecord(home, unitId, 'A-nodocker', { image: 'factory-env:rc5' });
    const run = runCli(['recover', '--json'], { home, env: { FACTORY_DOCKER_BIN: NO_DOCKER } });
    // The exit code is the ambiguity's, not the sweep's: a leaked container is not a verdict.
    expect(run.status).toBe(EXIT.unknown);
    const sweeps = jsonOf(run)['sweeps'] as Array<Record<string, unknown>>;
    expect(sweeps[0]).toMatchObject({
      attemptId: 'A-nodocker',
      status: 'failed',
      image: 'factory-env:rc5',
      removed: [],
    });
    expect(String(sweeps[0]?.['reason'])).toContain(NO_DOCKER);
    expect(String(sweeps[0]?.['checkCommand'])).toContain('org.factory.attempt=A-nodocker');
    // Visible in the text of the same invocation, on stderr, even under `--json`.
    expect(run.stderr).toMatch(/FAILED:/u);
    expect(run.stderr).toContain('org.factory.attempt=A-nodocker');
  });

  it('does not call docker for a host attempt: container: null is not a container', () => {
    const home = tempHome();
    const { unitId } = seedUnit(home, { lane: 'dark' });
    seedStaleAttempt(home, unitId, 'A-host');
    writeLaunchRecord(home, unitId, 'A-host', null);
    // If the sweep consulted docker here it would be `failed` naming this path. `skipped` with
    // the host reason is the proof the client was never spawned.
    const run = runCli(['recover', '--json'], { home, env: { FACTORY_DOCKER_BIN: NO_DOCKER } });
    const sweeps = jsonOf(run)['sweeps'] as Array<Record<string, unknown>>;
    expect(sweeps[0]).toMatchObject({ attemptId: 'A-host', status: 'skipped' });
    expect(String(sweeps[0]?.['reason'])).toMatch(/host child/u);
  });

  it('sweeps only by the reconciled attempt id, and names what it removed', () => {
    const home = tempHome();
    const { unitId } = seedUnit(home, { lane: 'dark' });
    seedStaleAttempt(home, unitId, 'A-leaked');
    writeLaunchRecord(home, unitId, 'A-leaked', { image: 'factory-env:rc5' });
    const dockerBin = fakeDockerThatReaps(home, 'deadbeef0001');
    const run = runCli(['recover', '--json'], { home, env: { FACTORY_DOCKER_BIN: dockerBin } });
    expect(run.status).toBe(EXIT.unknown);
    const sweeps = jsonOf(run)['sweeps'] as Array<Record<string, unknown>>;
    expect(sweeps[0]).toStrictEqual({
      attemptId: 'A-leaked',
      unitId,
      status: 'swept',
      image: 'factory-env:rc5',
      removed: ['deadbeef0001'],
      remaining: [],
      reason: null,
      checkCommand: null,
    });
    expect(run.stderr).toContain('swept: removed deadbeef0001');
    // The removed container id is named in the text; the attempt id (and so the label a reader
    // can filter by) is a value in `--json`, not a sentence.
  });

  it('does not re-sweep an attempt a previous recover already reconciled', () => {
    const home = tempHome();
    const { unitId } = seedUnit(home, { lane: 'dark' });
    seedStaleAttempt(home, unitId, 'A-once');
    writeLaunchRecord(home, unitId, 'A-once', { image: 'factory-env:rc5' });
    const dockerBin = fakeDockerThatReaps(home, 'deadbeef0002');
    expect(
      runCli(['recover', '--json'], { home, env: { FACTORY_DOCKER_BIN: dockerBin } }).status,
    ).toBe(EXIT.unknown);
    const second = runCli(['recover', '--json'], { home, env: { FACTORY_DOCKER_BIN: dockerBin } });
    expect(second.status).toBe(EXIT.ok);
    // Nothing was reconciled the second time, so nothing is swept and nothing is reported: the
    // sweep is scoped to this invocation, not to "every ambiguous attempt in the store".
    expect(jsonOf(second)['sweeps']).toStrictEqual([]);
  });
});
