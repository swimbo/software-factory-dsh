/**
 * The CLI's contract with a shell: help, the pinned version, and the absence of
 * every shortcut that would let a keystroke stand in for a gate.
 *
 * `ux-plan.md` §7 ("bait and switch") says a verb must state its limits; §6.1 and
 * §5.4 say unknown flags are a usage error rather than an escape hatch. Both are
 * cheap to test and expensive to notice missing, so both are tested for *every*
 * verb rather than for a representative one.
 */
import { describe, expect, it } from 'vitest';

import { VERB_SPECS } from './main.ts';
import { BYPASS_FLAGS, EXIT } from './exit.ts';
import { jsonOf, runCli } from './testing.ts';

describe('--help', () => {
  it('exits 0 and names the pinned dsh version', () => {
    const result = runCli(['--help']);
    expect(result.status).toBe(EXIT.ok);
    expect(result.stdout).toContain('0.2.1-rc.3');
  });

  it('states the exit-code table, so a script author never has to guess', () => {
    const result = runCli(['--help']);
    expect(result.stdout).toContain('2 usage');
    expect(result.stdout).toContain('9 integrity');
  });

  it('says there is no -y in the general help', () => {
    expect(runCli(['--help']).stdout).toContain('No gate can be bypassed');
  });
});

describe('every verb', () => {
  it('is registered (a verb named in the plan with no command is a verb that silently 404s)', () => {
    expect(VERB_SPECS.map((spec) => spec.name).sort()).toEqual(
      [
        'abort',
        'audit',
        'budget',
        'credential',
        'intent',
        'promote',
        'qualify',
        'receipts',
        'recover',
        'run',
        'status',
        'version',
      ].sort(),
    );
  });

  for (const spec of VERB_SPECS) {
    it(`documents its LIMITS in \`factory ${spec.name} --help\``, () => {
      const result = runCli([spec.name, '--help']);
      expect(result.status).toBe(EXIT.ok);
      expect(result.stdout).toContain('LIMITS');
    });
  }

  for (const verb of ['intent', 'qualify', 'run', 'status', 'promote', 'budget', 'credential']) {
    it(`refuses every bypass flag on \`${verb}\` with a usage error`, () => {
      for (const flag of BYPASS_FLAGS) {
        const result = runCli([verb, flag, 'U-7f3a9c']);
        expect(result.status, `${verb} ${flag}`).toBe(EXIT.usage);
      }
    });
  }

  it('declares no bypass flag as an option on any gate-touching verb', () => {
    // The LIMITS section *names* the flags in order to refuse them, so the
    // assertion is about the option table: no line may declare one.
    const declaration = /^\s+(-\w,\s+)?--(force|yes|assume-yes)\b/mu;
    for (const verb of ['promote', 'budget', 'credential']) {
      const help = runCli([verb, '--help']).stdout;
      expect(declaration.test(help), verb).toBe(false);
    }
  });
});

describe('factory version', () => {
  it('exits 0 and prints the pinned dsh expectation', () => {
    const result = runCli(['version']);
    expect(result.status).toBe(EXIT.ok);
    expect(result.stderr).toContain('0.2.1-rc.3');
  });

  it('reports the pinned version in --json under the same names the status page uses', () => {
    const json = jsonOf(runCli(['version', '--json']));
    expect(json).toMatchObject({ ok: true, dshVersionExpected: '0.2.1-rc.3' });
    expect(json['dshVersionObserved']).toBeNull();
  });
});

describe('unknown input', () => {
  it('refuses an unknown flag with exit 2, not exit 1', () => {
    expect(runCli(['status', '--reset']).status).toBe(EXIT.usage);
  });

  it('refuses an unknown verb with exit 2', () => {
    expect(runCli(['definitely-not-a-verb']).status).toBe(EXIT.usage);
  });

  it('prints exactly one JSON object on stdout when a usage error happens under --json', () => {
    const result = runCli(['status', '--json', '--reset']);
    expect(result.status).toBe(EXIT.usage);
    expect(jsonOf(result)).toMatchObject({ ok: false, code: 'USAGE', exitCode: 2 });
  });
});
