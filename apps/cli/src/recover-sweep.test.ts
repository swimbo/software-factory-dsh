/**
 * The recover-side sweep's decisions, with no docker and no store.
 *
 * The real daemon is the e2e spec's job (`e2e/cli/docker/09-recover-sweep.test.ts`); what is
 * testable anywhere is the part that decides *whether* to call it. Every case below is one of the
 * ways a sweep can be wrong quietly: sweeping a host attempt, sweeping a live-lease attempt,
 * sweeping on a record that names another attempt, or reporting a failure as a clean.
 */
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

import type { AttemptContainerSweep } from '@factory/dsh-adapter';

import {
  readLaunchRecord,
  sweepReconciledAttempts,
  type ReconciledAttempt,
  type SweepAdapter,
} from './recover-sweep.ts';

const ATTEMPT: ReconciledAttempt = { attemptId: 'A-sweep0001', unitId: 'U-sweep0001' };
const LABEL = 'org.factory.attempt';
const noLease = (): null => null;

const homes: string[] = [];
function tempHome(): string {
  const home = mkdtempSync(join(tmpdir(), 'factory-recover-sweep-'));
  homes.push(home);
  return home;
}

afterEach(() => {
  for (const home of homes.splice(0)) rmSync(home, { recursive: true, force: true });
});

/** Write the record where the adapter writes it: `attempts/<unitId>/<attemptId>/launch.json`. */
function writeRecord(home: string, record: unknown, attempt: ReconciledAttempt = ATTEMPT): string {
  const dir = join(home, 'attempts', attempt.unitId, attempt.attemptId);
  mkdirSync(dir, { recursive: true });
  const path = join(dir, 'launch.json');
  writeFileSync(path, typeof record === 'string' ? record : `${JSON.stringify(record, null, 2)}\n`);
  return path;
}

/** The minimal record the sweep reads: identity plus the container fact. */
function recordWith(container: unknown, attempt: ReconciledAttempt = ATTEMPT): unknown {
  return {
    schema: 'launch/1',
    attemptId: attempt.attemptId,
    unitId: attempt.unitId,
    container,
  };
}

function adapterOf(
  sweep: SweepAdapter['sweep'],
  dockerBin = '/usr/local/bin/docker',
): SweepAdapter {
  return {
    attemptLabel: LABEL,
    dockerBinOf: () => dockerBin,
    sweep,
  };
}

describe('reading the launch record', () => {
  it('tells an absent record apart from a host record and from a container record', () => {
    const home = tempHome();
    const host = writeRecord(home, recordWith(null));
    const other: ReconciledAttempt = { attemptId: 'A-sweep0002', unitId: ATTEMPT.unitId };
    const container = writeRecord(home, recordWith({ image: 'factory-env:rc5' }, other), other);
    expect(
      readLaunchRecord(join(home, 'attempts', 'nothing', 'here', 'launch.json'), 'A-x').kind,
    ).toBe('absent');
    expect(readLaunchRecord(host, ATTEMPT.attemptId)).toMatchObject({ kind: 'host' });
    expect(readLaunchRecord(container, 'A-sweep0002')).toStrictEqual({
      kind: 'container',
      image: 'factory-env:rc5',
    });
  });

  it('refuses a record that names a different attempt, rather than sweeping its label', () => {
    // The record is the only thing tying an id to a container. If it disagrees with the row the
    // store reconciled, neither can be trusted as the filter.
    const home = tempHome();
    const path = writeRecord(home, recordWith({ image: 'factory-env:rc5' }));
    const read = readLaunchRecord(path, 'A-some-other-attempt');
    expect(read.kind).toBe('malformed');
    expect(read.kind === 'malformed' ? read.detail : '').toMatch(/names attempt/u);
  });

  it('treats unparseable JSON and a non-object container as malformed, not as "no container"', () => {
    const home = tempHome();
    const broken = writeRecord(home, '{"schema": "launch/1", ');
    expect(readLaunchRecord(broken, ATTEMPT.attemptId).kind).toBe('malformed');
    const wrongShape = writeRecord(home, recordWith('factory-env:rc5'));
    expect(readLaunchRecord(wrongShape, ATTEMPT.attemptId).kind).toBe('malformed');
  });
});

describe('deciding what to sweep', () => {
  it('does not call docker for a host attempt, and says why it skipped', () => {
    const home = tempHome();
    writeRecord(home, recordWith(null));
    const sweep = vi.fn();
    const reports = sweepReconciledAttempts({
      home,
      env: {},
      attempts: [ATTEMPT],
      liveLease: noLease,
      adapter: adapterOf(sweep),
    });
    expect(reports).toHaveLength(1);
    expect(reports[0]).toMatchObject({
      status: 'skipped',
      removed: [],
      reason: expect.stringContaining('host'),
    });
    expect(sweep).not.toHaveBeenCalled();
  });

  it('does not call docker when there is no launch record: nothing was ever started', () => {
    const home = tempHome();
    const sweep = vi.fn();
    const reports = sweepReconciledAttempts({
      home,
      env: {},
      attempts: [ATTEMPT],
      liveLease: noLease,
      adapter: adapterOf(sweep),
    });
    expect(reports[0]?.status).toBe('skipped');
    expect(reports[0]?.reason).toMatch(/no launch record/u);
    expect(sweep).not.toHaveBeenCalled();
  });

  it('refuses to sweep while the lease is live, because that container may be someone’s worker', () => {
    const home = tempHome();
    writeRecord(home, recordWith({ image: 'factory-env:rc5' }));
    const sweep = vi.fn();
    const reports = sweepReconciledAttempts({
      home,
      env: {},
      attempts: [ATTEMPT],
      liveLease: () => ({ leaseId: 'LS-live', expiresAt: '2026-11-02T12:00:00.000Z' }),
      adapter: adapterOf(sweep),
    });
    expect(reports[0]?.status).toBe('skipped');
    expect(reports[0]?.reason).toContain('LS-live');
    expect(sweep).not.toHaveBeenCalled();
  });

  it('sweeps a container record with the docker client the environment names, and only that attempt id', () => {
    const home = tempHome();
    writeRecord(home, recordWith({ image: 'factory-env:rc5' }));
    const sweep = vi.fn((dockerBin: string, attemptId: string): AttemptContainerSweep => ({
      attemptId,
      status: 'swept',
      removed: ['c0ffee000001'],
      remaining: [],
      reason: null,
    }));
    const reports = sweepReconciledAttempts({
      home,
      env: { FACTORY_DOCKER_BIN: '/opt/docker' },
      attempts: [ATTEMPT],
      liveLease: noLease,
      adapter: adapterOf(sweep, '/opt/docker'),
    });
    expect(sweep).toHaveBeenCalledTimes(1);
    expect(sweep).toHaveBeenCalledWith('/opt/docker', ATTEMPT.attemptId);
    expect(reports[0]).toStrictEqual({
      attemptId: ATTEMPT.attemptId,
      unitId: ATTEMPT.unitId,
      status: 'swept',
      image: 'factory-env:rc5',
      removed: ['c0ffee000001'],
      remaining: [],
      reason: null,
      checkCommand: null,
    });
  });

  it('reports a failed sweep as failed, with the reason and the command that shows what is left', () => {
    const home = tempHome();
    writeRecord(home, recordWith({ image: 'factory-env:rc5' }));
    const sweep = (dockerBin: string, attemptId: string): AttemptContainerSweep => ({
      attemptId,
      status: 'failed',
      removed: [],
      remaining: ['c0ffee000002'],
      reason: 'Cannot connect to the Docker daemon',
    });
    const reports = sweepReconciledAttempts({
      home,
      env: {},
      attempts: [ATTEMPT],
      liveLease: noLease,
      adapter: adapterOf(sweep),
    });
    expect(reports[0]?.status).toBe('failed');
    expect(reports[0]?.reason).toContain('Cannot connect to the Docker daemon');
    expect(reports[0]?.remaining).toEqual(['c0ffee000002']);
    expect(reports[0]?.checkCommand).toBe(
      `/usr/local/bin/docker ps -aq --filter label=${LABEL}=${ATTEMPT.attemptId}`,
    );
  });

  it('cannot report a failed sweep without a reason: a shrug becomes a sentence', () => {
    // The adapter's type says a failure carries a reason. A caller assembling its own report must
    // not be able to emit `failed` with `reason: null` — that is a failure nobody can act on.
    const home = tempHome();
    writeRecord(home, recordWith({ image: 'factory-env:rc5' }));
    const sweep = (dockerBin: string, attemptId: string): AttemptContainerSweep => ({
      attemptId,
      status: 'failed',
      removed: [],
      remaining: [],
      reason: null,
    });
    const reports = sweepReconciledAttempts({
      home,
      env: {},
      attempts: [ATTEMPT],
      liveLease: noLease,
      adapter: adapterOf(sweep),
    });
    expect(reports[0]?.status).toBe('failed');
    expect(reports[0]?.reason).toBe('the sweep failed without a reason');
  });

  it('fails loudly when the adapter is missing and the record says a container ran', () => {
    const home = tempHome();
    writeRecord(home, recordWith({ image: 'factory-env:rc5' }));
    const reports = sweepReconciledAttempts({
      home,
      env: {},
      attempts: [ATTEMPT],
      liveLease: noLease,
      adapter: null,
    });
    expect(reports[0]?.status).toBe('failed');
    expect(reports[0]?.reason).toContain('@factory/dsh-adapter');
  });

  it('does not touch a record with an unsafe id: the id is a path segment', () => {
    const home = tempHome();
    const reports = sweepReconciledAttempts({
      home,
      env: {},
      attempts: [{ attemptId: '../escape', unitId: ATTEMPT.unitId }],
      liveLease: noLease,
      adapter: adapterOf(vi.fn()),
    });
    expect(reports[0]?.status).toBe('failed');
    expect(reports[0]?.reason).toContain('not safe path segments');
  });
});
