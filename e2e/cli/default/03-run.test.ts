/**
 * `run`: the dispatch boundary, and the three refusals that must happen before anything is spent.
 *
 * On this host there is no `dsh` binary and no model key, which makes the *refusal* the
 * honest assertion: `run` must exit 8 with a runbook line and record no attempt. A factory
 * that dispatched anyway (or that turned a missing harness into a stack trace) would be
 * failing in the one place where "nothing was reserved, nothing was dispatched" is the
 * promise (`ux-plan.md` §5.2). The third case is configuration rather than hardware:
 * container isolation and a live model cannot both be honoured, and the probe says so.
 *
 * E2E-09, E2E-28 of `e2e-tests.md`.
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

let fixture: FixtureRepo;
let home: string;

beforeEach(() => {
  fixture = createFixtureRepo();
  home = newFactoryHome();
});

afterEach(() => {
  fixture.cleanup();
});

function derivable(overrides: Parameters<typeof specFor>[0] = {}): ReturnType<typeof specFor> {
  return specFor({ baseRev: fixture.baseRev, ...overrides });
}

describe('run', () => {
  it('[@default] refuses a lit unit with exit 3 and records no attempt', () => {
    const { unitId } = submitUnit(home, { spec: derivable() });
    expect(runFactory(['qualify', unitId, '--json'], { home }).code).toBe(0);

    const run = runFactory(['run', unitId, '--json'], { home });
    const json = jsonOf(run);

    expect(run.code).toBe(3);
    expect(json['code']).toBe('LANE_NOT_DARK');
    expect(units(home)[0]?.['attempt']).toBeNull();
    expect(existsSync(join(home, 'attempts', unitId))).toBe(false);
  });

  it('[@default] refuses a dark unit with exit 8 and a runbook, because no dsh is installed', () => {
    const { unitId } = submitUnit(home, { spec: derivable() });
    expect(runFactory(['qualify', unitId, '--cold-start', '--json'], { home }).code).toBe(0);

    const run = runFactory(['run', unitId, '--json'], { home });
    const json = jsonOf(run);

    expect(run.code).toBe(8);
    expect(json['code']).toBe('EXECUTOR_UNAVAILABLE');
    // The runbook is the whole difference between an operator who can fix this and one who
    // files a bug: it must name the missing thing and the next command.
    expect(String(json['message'])).toMatch(/dsh/iu);
    expect(String(json['message'])).toMatch(/DSH_BIN|no `?dsh`?/iu);
    expect(`${run.stdout}${run.stderr}`).toMatch(/runbook/iu);
    expect(units(home)[0]?.['attempt']).toBeNull();
  });

  it('[@default] a retry without a reason is a usage error, not a dispatch', () => {
    const { unitId } = submitUnit(home, { spec: derivable() });
    expect(runFactory(['qualify', unitId, '--cold-start', '--json'], { home }).code).toBe(0);

    const run = runFactory(['run', unitId, '--retry', '--json'], { home });

    expect(run.code).toBe(2);
    expect(units(home)[0]?.['attempt']).toBeNull();
  });

  it('[@default] refuses container isolation with a live model: the worker has no network and the proxy is on loopback', () => {
    // The combination cannot work, and it is knowable *before* dispatch: the container gets
    // `--network none`, the credential proxy binds `127.0.0.1` on this host, and no container
    // without a network can reach a loopback address on the machine that runs it. So the
    // refusal belongs in the probe — where "nothing was reserved" is still true — rather
    // than in a worker that starts, cannot authenticate, and dies as an unexplained 401.
    const { unitId } = submitUnit(home, { spec: derivable() });
    expect(runFactory(['qualify', unitId, '--cold-start', '--json'], { home }).code).toBe(0);

    const run = runFactory(['run', unitId, '--json'], {
      home,
      env: {
        FACTORY_WORKER_ISOLATION: 'container',
        FACTORY_LIVE_MODEL: '1',
        BIFROST_API_KEY: 'sk-test-not-a-real-key',
      },
    });
    const json = jsonOf(run);
    const message = String(json['message']);

    expect(run.code).toBe(8);
    expect(json['code']).toBe('CONTAINER_UNAVAILABLE');
    // Both levers, by name: the message has to tell the operator which *two* settings made
    // the combination impossible, not merely that the combination was impossible.
    expect(message).toContain('FACTORY_WORKER_ISOLATION');
    expect(message).toContain('FACTORY_LIVE_MODEL');
    // ... and the mechanism, so "it should work" has an answer.
    expect(message).toMatch(/--network none/u);
    expect(message).toMatch(/127\.0\.0\.1/u);
    // ... and both ways forward.
    expect(message).toMatch(/unset FACTORY_WORKER_ISOLATION/u);
    expect(message).toMatch(/unset FACTORY_LIVE_MODEL/u);

    // Nothing was dispatched and nothing was spent: no attempt row, no attempt directory,
    // and no metered usage. A refusal that leaves a reservation behind is a failed dispatch
    // wearing a refusal's clothes.
    expect(units(home)[0]?.['attempt']).toBeNull();
    expect(existsSync(join(home, 'attempts', unitId))).toBe(false);
    const store = openStore({ dir: join(home, 'state') });
    try {
      expect(store.listUsage()).toHaveLength(0);
    } finally {
      store.close();
    }
  });
});
