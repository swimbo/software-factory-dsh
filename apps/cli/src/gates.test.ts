/**
 * The three human gates, tested for the two things that make a gate real: a wrong
 * answer changes nothing, and a right answer is the only way through.
 *
 * The promotion test is the important one. `ux-plan.md` §3.7 says an unsigned
 * promotion writes **no file at all** — not a draft, not a directory. So the test
 * checks the filesystem, not the message: a CLI that prints the right refusal and
 * leaves a half-written artifact has failed the gate while looking like it passed.
 */
import { existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { EXIT } from './exit.ts';
import { jsonOf, runCli, seedUnit, tempHome, writeSpec } from './testing.ts';

describe('budget raise — human gate 2', () => {
  it('refuses a wrong phrase with exit 5 and leaves the envelope unchanged', () => {
    const home = tempHome();
    const before = jsonOf(runCli(['budget', 'show', '--json'], { home }));
    const result = runCli(
      [
        'budget',
        'raise',
        '--to',
        '4.00',
        '--reason',
        'this unit needs more turns',
        '--confirm',
        'raise per-unit envelope to 8.00',
      ],
      { home },
    );
    expect(result.status).toBe(EXIT.gate);
    expect(result.stderr).toContain('GATE_REQUIRED');
    const after = jsonOf(runCli(['budget', 'show', '--json'], { home }));
    expect(after['perUnit']).toEqual(before['perUnit']);
  });

  it('refuses with no phrase at all, and says what to type', () => {
    const home = tempHome();
    const result = runCli(['budget', 'raise', '--to', '4.00', '--reason', 'more turns'], { home });
    expect(result.status).toBe(EXIT.gate);
    expect(result.stderr).toContain('raise per-unit envelope to 4.00');
  });

  it('applies the raise when the phrase is exactly right', () => {
    const home = tempHome();
    const result = runCli(
      [
        'budget',
        'raise',
        '--to',
        '4.00',
        '--reason',
        'this unit needs more turns',
        '--confirm',
        'raise per-unit envelope to 4.00',
      ],
      { home },
    );
    expect(result.status).toBe(EXIT.ok);
    expect(result.stderr).toContain('recorded');
    const after = jsonOf(runCli(['budget', 'show', '--json'], { home }));
    expect(after['perUnit']).toMatchObject({ limit: 4 });
  });

  it('requires a reason even for a raise that is not signed yet', () => {
    const home = tempHome();
    expect(runCli(['budget', 'raise', '--to', '4.00'], { home }).status).toBe(EXIT.usage);
  });

  it('prints the numbers as estimates, never as charges', () => {
    const home = tempHome();
    const show = runCli(['budget', 'show'], { home });
    expect(show.stderr).toContain('estimated');
    expect(jsonOf(runCli(['budget', 'show', '--json'], { home }))).toMatchObject({
      telemetry: 'estimated',
    });
  });
});

describe('promote — human gate 1', () => {
  it('refuses an unsigned promotion with exit 5 and writes no artifact', () => {
    const home = tempHome();
    const { unitId } = seedUnit(home, { lane: 'dark' });
    const result = runCli(['promote', unitId], { home });
    expect(result.status).toBe(EXIT.gate);
    expect(result.stderr).toContain('PROMOTION_UNSIGNED');
    // The gate's defining property: nothing on disk.
    expect(existsSync(join(home, 'artifacts', unitId))).toBe(false);
    expect(existsSync(join(home, 'artifacts', unitId, 'promotion.yaml'))).toBe(false);
  });

  it('refuses when the phrase is wrong even though a signature was offered', () => {
    const home = tempHome();
    const { unitId } = seedUnit(home, { lane: 'dark' });
    const result = runCli(
      ['promote', unitId, '--signature', join(home, 'sig.pem'), '--confirm', 'yes please'],
      { home },
    );
    expect(result.status).toBe(EXIT.gate);
    expect(result.stderr).toContain('GATE_REQUIRED');
    expect(existsSync(join(home, 'artifacts', unitId))).toBe(false);
  });

  it('does not leave an artifacts directory behind for any refusal', () => {
    const home = tempHome();
    const { unitId } = seedUnit(home, { lane: 'dark' });
    runCli(['promote', unitId], { home });
    const artifacts = join(home, 'artifacts');
    const entries = existsSync(artifacts) ? readdirSync(artifacts) : [];
    expect(entries).toEqual([]);
  });

  it('exits 2 when the unit id is missing, because the invocation is malformed', () => {
    expect(runCli(['promote']).status).toBe(EXIT.usage);
  });

  it('refuses an unknown unit with exit 3, before it can claim a signature is missing', () => {
    const result = runCli(['promote', 'U-nope'], { home: tempHome() });
    expect(result.status).toBe(EXIT.policy);
    expect(result.stderr).toContain('UNIT_NOT_FOUND');
  });
});

describe('credential — human gate 3', () => {
  it('refuses a privileged grant with no typed phrase, exit 5, nothing issued', () => {
    const home = tempHome();
    const result = runCli(['credential', 'request', '--repo', 'acme/api', '--ttl', '15m'], {
      home,
    });
    expect(result.status).toBe(EXIT.gate);
    expect(result.stderr).toContain('issue privileged credential for acme/api');
  });

  it('issues with the exact phrase, and never prints a secret', () => {
    const home = tempHome();
    const result = runCli(
      [
        'credential',
        'request',
        '--repo',
        'acme/api',
        '--ttl',
        '15m',
        '--reason',
        'deploy the patch',
        '--confirm',
        'issue privileged credential for acme/api',
      ],
      { home },
    );
    expect(result.status).toBe(EXIT.ok);
    expect(result.stderr).toContain('value not printed');
    const json = jsonOf(
      runCli(
        [
          'credential',
          'request',
          '--repo',
          'acme/api',
          '--ttl',
          '15m',
          '--reason',
          'deploy the patch',
          '--confirm',
          'issue privileged credential for acme/api',
          '--json',
        ],
        { home },
      ),
    );
    expect(json['secret']).toBeNull();
    expect(JSON.stringify(json)).not.toMatch(/BEGIN .*PRIVATE KEY/u);
  });

  it('refuses an unscoped request with exit 3, because an unscoped grant is not a thing', () => {
    const home = tempHome();
    const result = runCli(['credential', 'request', '--ttl', '15m'], { home });
    expect(result.status).toBe(EXIT.policy);
    expect(result.stderr).toContain('SPEC_INVALID');
  });

  it('refuses a ttl beyond the ceiling with exit 3', () => {
    const home = tempHome();
    const result = runCli(['credential', 'request', '--repo', 'acme/api', '--ttl', '2h'], { home });
    expect(result.status).toBe(EXIT.policy);
    expect(result.stderr).toContain('60');
  });

  it('revokes a grant it issued', () => {
    const home = tempHome();
    const issued = jsonOf(
      runCli(
        [
          'credential',
          'request',
          '--repo',
          'acme/api',
          '--ttl',
          '15m',
          '--reason',
          'deploy',
          '--confirm',
          'issue privileged credential for acme/api',
          '--json',
        ],
        { home },
      ),
    );
    const result = runCli(['credential', 'revoke', String(issued['grantId'])], { home });
    expect(result.status).toBe(EXIT.ok);
    expect(result.stderr).toContain('REVOKED');
  });

  it('refuses to revoke an id that names nothing, with exit 3 rather than exit 1', () => {
    const home = tempHome();
    const result = runCli(['credential', 'revoke', 'c_1234567890'], { home });
    expect(result.status).toBe(EXIT.policy);
    expect(result.stderr).toContain('no credential');
  });
});

describe('a gate is never implied by the previous one', () => {
  it('answers a budget raise and a promotion in separate invocations', () => {
    const home = tempHome();
    const { unitId } = seedUnit(home, { lane: 'dark' });
    const budget = runCli(
      [
        'budget',
        'raise',
        '--to',
        '4.00',
        '--reason',
        'more turns',
        '--confirm',
        'raise per-unit envelope to 4.00',
      ],
      { home },
    );
    expect(budget.status).toBe(EXIT.ok);
    // The raise must not have signed anything for the promotion.
    expect(runCli(['promote', unitId], { home }).status).toBe(EXIT.gate);
  });

  it('does not accept a spec file path that is also a confirmation phrase', () => {
    const home = tempHome();
    const file = writeSpec(home);
    const result = runCli(['intent', '--file', file, '--confirm', file], { home });
    // `--confirm` is not an `intent` option: an unknown option is a usage error,
    // not an accept-everything switch.
    expect(result.status).toBe(EXIT.usage);
  });
});
