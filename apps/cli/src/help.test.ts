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
import { BYPASS_FLAGS, EXIT, runbookFor } from './exit.ts';
import { jsonOf, runCli } from './testing.ts';

describe('--help', () => {
  it('exits 0 and names the pinned dsh version', () => {
    const result = runCli(['--help']);
    expect(result.status).toBe(EXIT.ok);
    expect(result.stdout).toContain('0.2.1-rc.5');
  });

  it('states the exit-code table, so a script author never has to guess', () => {
    const result = runCli(['--help']);
    expect(result.stdout).toContain('2 usage');
    expect(result.stdout).toContain('9 integrity');
  });

  it('says exit 8 has two next actions, because two codes share it', () => {
    // `CONTAINER_UNAVAILABLE` and `CONFIGURATION_CONFLICT` are both 8, and the numbers cannot tell
    // them apart — so the help names the distinction. Without it, a reader who has memorised
    // "8 means build the image" will rebuild a daemon and an image that are both fine.
    const help = runCli(['--help']).stdout;
    expect(help).toContain('CONTAINER_UNAVAILABLE');
    expect(help).toContain('CONFIGURATION_CONFLICT');
    expect(help).toMatch(/unset one/u);
  });

  it('says there is no -y in the general help', () => {
    expect(runCli(['--help']).stdout).toContain('No gate can be bypassed');
  });
});

describe('every verb', () => {
  it('is registered (a verb named in the plan with no command is a verb that silently 404s)', () => {
    // The list is the plan's verb set plus the ones that became worth a command. `alerts` joined it
    // in the evidence-expiry task: the two controls that exit 9 on expired evidence had a log entry
    // and nothing that wrote it, so the surface existed only in prose. `gate` joined it in R5:
    // the broker could refuse a privileged operation but there was no command that turned "I
    // approve this" into a record it would accept, which made every refusal a dead end.
    expect(VERB_SPECS.map((spec) => spec.name).sort()).toEqual(
      [
        'abort',
        'alerts',
        'audit',
        'budget',
        'credential',
        'gate',
        'intent',
        'ledger',
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

describe('the class-8 runbook lines', () => {
  it('sends a missing image to docker build, and a configuration conflict to the settings', () => {
    // The whole point of the second code: same exit, opposite next action. A reader told to
    // `docker build` when the daemon and the image are both fine rebuilds something that was
    // never broken, and is refused again for the same reason.
    const missing = runbookFor('CONTAINER_UNAVAILABLE') ?? '';
    const conflict = runbookFor('CONFIGURATION_CONFLICT') ?? '';
    expect(missing).toContain('docker build');
    expect(conflict).not.toContain('docker build');
    expect(conflict).toContain('unset FACTORY_WORKER_ISOLATION');
    expect(conflict).toContain('FACTORY_LIVE_MODEL');
    expect(conflict).toContain('worker-container.md');
    // The code names the *conflict*, so the line must say the pair cannot both be honoured.
    expect(conflict).toMatch(/both be honoured/u);
  });

  it('has a runbook line for every code that can reach exit 8 through a launch', () => {
    // Not every ErrorCode: `INTERNAL` (1) and the exits 3-7 codes have their own rendering. These
    // three are the ones a `factory run` refusal can carry, and each names a different action.
    for (const code of [
      'EXECUTOR_UNAVAILABLE',
      'CONTAINER_UNAVAILABLE',
      'CONFIGURATION_CONFLICT',
    ]) {
      expect(runbookFor(code), code).not.toBeNull();
    }
    expect(runbookFor('EXECUTOR_UNAVAILABLE')).toMatch(/install the pinned dsh/u);
  });
});

describe('factory version', () => {
  it('exits 0 and prints the pinned dsh expectation', () => {
    const result = runCli(['version']);
    expect(result.status).toBe(EXIT.ok);
    expect(result.stderr).toContain('0.2.1-rc.5');
  });

  it('reports the pinned version in --json under the same names the status page uses', () => {
    const json = jsonOf(runCli(['version', '--json']));
    expect(json).toMatchObject({ ok: true, dshVersionExpected: '0.2.1-rc.5' });
    // `dshVersionObserved` is a *probe*: null when no binary is reachable, the observed version
    // when one is. Asserting `null` made this spec pass only on a shell without `dsh`/`DSH_BIN` —
    // it went red the moment the live layer exported DSH_BIN, which is a test that measured the
    // developer's environment. The contract is the shape: either null or a version string.
    const observed = json['dshVersionObserved'];
    expect(observed === null || typeof observed === 'string').toBe(true);
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
