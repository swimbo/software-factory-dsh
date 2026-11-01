/**
 * `factory qualify` and `factory run`: the lane gate, and the machinery gate.
 *
 * The security lock is tested first because it can only ever *demote*: a
 * security-relevant change never goes dark even when every weighted signal
 * passes.
 *
 * The second group pins the shipped policy: the engine hands the qualifier
 * `taskClassHistory: unknown`, so a clean spec is `lit` with `TASK_CLASS_UNKNOWN`
 * named. The third group tests the escape hatch the Lead added — cold start — which
 * turns that same absence into a *policy* pass (`TASK_CLASS_COLD_START`), changes
 * the policy version, and must never be mistakable for a measurement.
 */
import { describe, expect, it } from 'vitest';
import { resolvePolicy } from './context.ts';

import { EXIT } from './exit.ts';
import { jsonOf, runCli, seedUnit, tempHome, writeSpec } from './testing.ts';

const SECURITY_SPEC = {
  slug: 'token-rotation',
  touchPaths: ['src/auth/token.ts'],
  operationClasses: ['credential-use'],
  intent: 'Rotate the API token used by the auth path and prove the old one is rejected.',
  restateBack:
    'You asked for: rotating the API token used by the auth path, proven by a test that the old token is rejected. Not asking for: a new auth provider.',
};

describe('qualify', () => {
  it('locks a security-relevant unit to lit and prints the security line', () => {
    const home = tempHome();
    const file = writeSpec(home, SECURITY_SPEC);
    const intent = jsonOf(runCli(['intent', '--file', file, '--json'], { home }));
    const unitId = String(intent['unitId']);
    const result = runCli(['qualify', unitId], { home });
    expect(result.stderr).toContain('SECURITY');
    expect(result.stderr).toContain('security-relevant');
    expect(result.stderr).toMatch(/LANE\s+lit/u);
  });

  it('reports the security lock in --json with the reasons that produced it', () => {
    const home = tempHome();
    const file = writeSpec(home, SECURITY_SPEC);
    const intent = jsonOf(runCli(['intent', '--file', file, '--json'], { home }));
    const json = jsonOf(runCli(['qualify', String(intent['unitId']), '--json'], { home }));
    expect(json['lane']).toBe('lit');
    expect(json['security']).toMatchObject({ relevant: true });
    expect(Array.isArray(json['signals'])).toBe(true);
  });

  it('reports whether the decision was reused, and refuses to re-qualify a parked unit', () => {
    const home = tempHome();
    const file = writeSpec(home);
    const unitId = String(jsonOf(runCli(['intent', '--file', file, '--json'], { home }))['unitId']);
    const first = jsonOf(runCli(['qualify', unitId, '--json'], { home }));
    expect(first['stored']).toBe(false);
    // A lit unit is parked (terminal) in v1, so a second qualification is a
    // policy refusal naming the state, not a silent re-score.
    const second = runCli(['qualify', unitId], { home });
    expect(second.status).toBe(EXIT.policy);
    expect(second.stderr).toContain('UNIT_ALREADY_TERMINAL');
  });

  it('routes a clean spec lit as well, because task-class history is unknown (reported gap)', () => {
    const home = tempHome();
    const file = writeSpec(home);
    const unitId = String(jsonOf(runCli(['intent', '--file', file, '--json'], { home }))['unitId']);
    const result = runCli(['qualify', unitId], { home });
    expect(result.status).toBe(EXIT.ok);
    expect(result.stderr).toMatch(/LANE\s+lit/u);
    expect(result.stderr).toContain('TASK_CLASS_UNKNOWN');
  });

  it('refuses an unknown unit with exit 3', () => {
    const home = tempHome();
    const result = runCli(['qualify', 'U-nope'], { home });
    expect(result.status).toBe(EXIT.policy);
    expect(result.stderr).toContain('UNIT_NOT_FOUND');
  });

  it('exits 2 with no unit id, because a refusal about shape is not a refusal about policy', () => {
    expect(runCli(['qualify']).status).toBe(EXIT.usage);
  });
});

describe('cold start', () => {
  it('routes a clean spec dark with --cold-start, and names the policy reason', () => {
    const home = tempHome();
    const file = writeSpec(home);
    const unitId = String(jsonOf(runCli(['intent', '--file', file, '--json'], { home }))['unitId']);
    const result = runCli(['qualify', unitId, '--cold-start'], { home });
    expect(result.status).toBe(EXIT.ok);
    expect(result.stderr).toMatch(/LANE\s+dark/u);
    expect(result.stderr).toContain('TASK_CLASS_COLD_START');
    // The one sentence that stops this reading as a measurement.
    expect(result.stderr).toContain('not measured');
    expect(result.stderr).toContain('COLD START');
  });

  it('reports the cold-start policy version, which differs from the shipped one', () => {
    const home = tempHome();
    const file = writeSpec(home);
    const unitId = String(jsonOf(runCli(['intent', '--file', file, '--json'], { home }))['unitId']);
    const cold = jsonOf(runCli(['qualify', unitId, '--cold-start', '--json'], { home }));

    const otherHome = tempHome();
    const otherFile = writeSpec(otherHome);
    const otherId = String(
      jsonOf(runCli(['intent', '--file', otherFile, '--json'], { home: otherHome }))['unitId'],
    );
    const warm = jsonOf(runCli(['qualify', otherId, '--json'], { home: otherHome }));

    expect(warm['lane']).toBe('lit');
    expect(cold['lane']).toBe('dark');
    expect(cold['coldStart']).toBe(true);
    expect(cold['policyVersion']).not.toBe(warm['policyVersion']);
  });

  it('honours FACTORY_POLICY_ALLOW_COLD_START=1 without the flag', () => {
    const home = tempHome();
    const file = writeSpec(home);
    const unitId = String(jsonOf(runCli(['intent', '--file', file, '--json'], { home }))['unitId']);
    const result = runCli(['qualify', unitId], {
      home,
      env: { FACTORY_POLICY_ALLOW_COLD_START: '1' },
    });
    expect(result.status).toBe(EXIT.ok);
    expect(result.stderr).toMatch(/LANE\s+dark/u);
    expect(result.stderr).toContain('TASK_CLASS_COLD_START');
  });

  it('leaves privileged brokering off by default, and takes it from the environment', () => {
    // Both halves matter: the shipped default must not change admission behaviour for every
    // existing unit, and the one place an operator can turn it on is the composition root —
    // never the worker's environment.
    const home = tempHome();
    const file = writeSpec(home);
    const unitId = String(jsonOf(runCli(['intent', '--file', file, '--json'], { home }))['unitId']);
    const shipped = jsonOf(runCli(['qualify', unitId, '--json'], { home }));
    const brokered = jsonOf(
      runCli(['qualify', unitId, '--json'], { home, env: { FACTORY_PRIVILEGED_BROKERING: 'on' } }),
    );
    expect(resolvePolicy({}).privilegedBrokering).toBe('off');
    expect(resolvePolicy({ FACTORY_PRIVILEGED_BROKERING: 'on' }).privilegedBrokering).toBe('on');
    // Turning it on is a *policy* fact, so it changes the version every decision records.
    expect(brokered['policyVersion']).not.toBe(shipped['policyVersion']);
  });

  it('does not enable cold start for any value other than 1', () => {
    const home = tempHome();
    const file = writeSpec(home);
    const unitId = String(jsonOf(runCli(['intent', '--file', file, '--json'], { home }))['unitId']);
    const result = runCli(['qualify', unitId], {
      home,
      env: { FACTORY_POLICY_ALLOW_COLD_START: 'true' },
    });
    expect(result.stderr).toMatch(/LANE\s+lit/u);
    expect(result.stderr).toContain('TASK_CLASS_UNKNOWN');
  });

  it('a cold-started unit really is dispatchable: run reaches the executor check (exit 8)', () => {
    const home = tempHome();
    const file = writeSpec(home);
    const unitId = String(jsonOf(runCli(['intent', '--file', file, '--json'], { home }))['unitId']);
    runCli(['qualify', unitId, '--cold-start'], { home });
    const run = runCli(['run', unitId], { home });
    // No `dsh` in this environment: the lane gate passed, the machinery gate did not.
    expect(run.status).toBe(EXIT.environment);
    expect(run.stderr).toContain('EXECUTOR_UNAVAILABLE');
  });

  it('never silently cold-starts a security-relevant unit', () => {
    const home = tempHome();
    const file = writeSpec(home, SECURITY_SPEC);
    const unitId = String(jsonOf(runCli(['intent', '--file', file, '--json'], { home }))['unitId']);
    const result = runCli(['qualify', unitId, '--cold-start'], { home });
    // The lock is applied after the score and can only ever demote.
    expect(result.stderr).toMatch(/LANE\s+lit/u);
    expect(result.stderr).toContain('security-relevant');
  });
});

describe('run', () => {
  it('refuses a lit unit with exit 3 LANE_NOT_DARK and never dispatches it', () => {
    const home = tempHome();
    const file = writeSpec(home);
    const unitId = String(jsonOf(runCli(['intent', '--file', file, '--json'], { home }))['unitId']);
    runCli(['qualify', unitId], { home });
    const result = runCli(['run', unitId], { home });
    expect(result.status).toBe(EXIT.policy);
    expect(result.stderr).toContain('LANE_NOT_DARK');
    expect(result.stderr).toContain('does not dispatch lit units');
  });

  it('refuses a dark unit with exit 8 when no dsh binary exists, and prints the runbook', () => {
    const home = tempHome();
    const { unitId } = seedUnit(home, { lane: 'dark' });
    const result = runCli(['run', unitId], { home });
    expect(result.status).toBe(EXIT.environment);
    expect(result.stderr).toContain('EXECUTOR_UNAVAILABLE');
    expect(result.stderr).toContain('runbook:');
    // "nothing dispatched, no reservation": the store must show no attempt.
    const status = JSON.parse(runCli(['status', unitId, '--json'], { home }).stdout) as {
      units: Array<{ attempt: unknown }>;
    };
    expect(status.units[0]?.attempt).toBeNull();
  });

  it('refuses an unknown unit with exit 3 rather than opening a store of its own', () => {
    const result = runCli(['run', 'U-nope'], { home: tempHome() });
    expect(result.status).toBe(EXIT.policy);
    expect(result.stderr).toContain('UNIT_NOT_FOUND');
  });

  it('refuses --retry without --reason with a usage error', () => {
    const home = tempHome();
    const { unitId } = seedUnit(home, { lane: 'dark' });
    expect(runCli(['run', unitId, '--retry'], { home }).status).toBe(EXIT.usage);
  });

  it('refuses --verify-only on a unit that is not awaiting measurement, instead of inventing a verdict', () => {
    // The wall is wired now, so "there is no instrument" is no longer the reason for
    // refusing — a seeded unit has no receipt, and re-measuring one would mean
    // inventing the evidence. The refusal moved, the promise did not: nothing is
    // dispatched and no verdict is recorded.
    const home = tempHome();
    const { unitId } = seedUnit(home, { lane: 'dark' });
    const result = runCli(['run', unitId, '--verify-only'], { home });
    expect(result.status).toBe(EXIT.policy);
    expect(result.stderr).toContain('UNIT_ALREADY_TERMINAL');
    expect(result.stderr).toContain('Nothing was dispatched');

    const status = runCli(['status', unitId, '--json'], { home });
    const json = JSON.parse(status.stdout.trim()) as Record<string, unknown>;
    expect(JSON.stringify(json)).not.toContain('verdictId');
  });
});
