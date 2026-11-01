/**
 * The gates: every refusal here is a refusal to spend money or attention on the operator's
 * behalf. Three properties are asserted for each of them.
 *
 * 1. **A phrase is required and printed.** The operator must be able to copy it exactly, and
 *    a near-miss must not be accepted.
 * 2. **A refusal writes nothing.** `ux-plan.md` §4.4 is explicit: no `promotion.yaml` at all,
 *    not an empty one, not a draft.
 * 3. **No flag replaces a phrase.** `-y`, `--yes`, `--force`, `-f`, `--assume-yes` are exit 2
 *    on a gated verb — the absence is tested, not documented.
 *
 * E2E-14, E2E-15, E2E-17, E2E-18, E2E-19, E2E-20 of `e2e-tests.md`.
 */
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
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
let unitId: string;

beforeEach(() => {
  fixture = createFixtureRepo();
  home = newFactoryHome();
  unitId = submitUnit(home, { spec: specFor({ baseRev: fixture.baseRev }) }).unitId;
});

afterEach(() => {
  fixture.cleanup();
});

/** `factory budget --json` emits the envelope flat; `status --json` nests it under `budget`. */
function perUnitLimit(): number {
  const json = jsonOf(runFactory(['budget', '--json'], { home }));
  const perUnit = json['perUnit'] as { limit?: number } | undefined;
  return Number(perUnit?.limit ?? Number.NaN);
}

describe('promotion gate', () => {
  it('[@default] refuses an unsigned promotion, writes no artifact, and keeps exit 5', () => {
    const run = runFactory(['promote', unitId, '--json'], { home });
    const json = jsonOf(run);

    expect(run.code).toBe(5);
    expect(json['code']).toBe('PROMOTION_UNSIGNED');
    expect(String(json['message'])).toMatch(/no artifact was written/iu);
    expect(existsSync(join(home, 'artifacts', unitId, 'promotion.yaml'))).toBe(false);
    // Not even the directory: a refusal must not leave a trace that looks like progress.
    expect(existsSync(join(home, 'artifacts', unitId))).toBe(false);
  });

  it('[@default] prints the exact phrase it will accept, so a typo is fixable', () => {
    const run = runFactory(['promote', unitId], { home });
    const json = runFactory(['promote', unitId, '--json'], { home });
    expect(run.stderr).toContain(`sign promotion ${unitId}`);
    expect(json.code).toBe(5);
  });

  it('[@default] a wrong phrase is refused and still writes nothing', () => {
    const run = runFactory(
      ['promote', unitId, '--confirm', 'sign promotion U-something-else', '--json'],
      {
        home,
      },
    );
    expect(run.code).toBe(5);
    expect(existsSync(join(home, 'artifacts', unitId, 'promotion.yaml'))).toBe(false);
  });
});

describe('budget envelope gate', () => {
  it('[@default] a raise with the wrong phrase is refused and the envelope is unchanged', () => {
    const before = perUnitLimit();
    const run = runFactory(['budget', 'raise', '--to', '4.00', '--reason', 'why', '--json'], {
      home,
    });
    const json = jsonOf(run);

    expect(run.code).toBe(5);
    expect(json['code']).toBe('GATE_REQUIRED');
    expect(String(json['message'])).toContain('raise per-unit envelope to 4.00');
    expect(perUnitLimit()).toBe(before);
  });

  it('[@default] a raise with the exact phrase is applied', () => {
    const run = runFactory(
      [
        'budget',
        'raise',
        '--to',
        '4.00',
        '--reason',
        'U-x needs a second verification pass',
        '--confirm',
        'raise per-unit envelope to 4.00',
        '--json',
      ],
      { home },
    );

    expect(run.code).toBe(0);
    expect(perUnitLimit()).toBe(4);
  });

  it('[@default] without a --to the command only shows the envelope, and is not a gate', () => {
    const run = runFactory(['budget', '--json'], { home });
    expect(run.code).toBe(0);
    expect(perUnitLimit()).toBe(2);
  });
});

describe('credential gate', () => {
  it('[@default] refuses an unscoped repository with exit 3', () => {
    for (const repo of ['', '*', 'two,repos']) {
      const run = runFactory(
        ['credential', '--repo', repo, '--ttl', '15m', '--class', 'standard', '--json'],
        { home },
      );
      expect(run.code).toBe(3);
      expect(jsonOf(run)['code']).toBe('SPEC_INVALID');
    }
  });

  it('[@default] refuses a privileged credential with no phrase, and issues a standard one', () => {
    const privileged = runFactory(['credential', '--repo', 'fixture', '--ttl', '15m', '--json'], {
      home,
    });
    expect(privileged.code).toBe(5);
    expect(jsonOf(privileged)['code']).toBe('GATE_REQUIRED');
    expect(String(jsonOf(privileged)['message'])).toContain(
      'issue privileged credential for fixture',
    );

    const standard = runFactory(
      ['credential', '--repo', 'fixture', '--ttl', '15m', '--class', 'standard', '--json'],
      { home },
    );
    const json = jsonOf(standard);
    expect(standard.code).toBe(0);
    expect(json['secret']).toBeNull();
    expect(JSON.stringify(json)).not.toMatch(/-----BEGIN|sk-[A-Za-z0-9]{10}/u);
  });

  it('[@default] refuses a TTL over the 60 minute ceiling', () => {
    const run = runFactory(
      ['credential', '--repo', 'fixture', '--ttl', '90m', '--class', 'standard', '--json'],
      { home },
    );
    expect(run.code).toBe(3);
  });
});

describe('no flag replaces a phrase', () => {
  const GATED: readonly (readonly string[])[] = [
    ['promote', 'U-x'],
    ['budget', 'raise', '--to', '4.00', '--reason', 'why'],
    ['credential', '--repo', 'fixture', '--ttl', '15m'],
  ];
  const FLAGS = ['-y', '--yes', '--force', '-f', '--assume-yes', '--yes=1', '-fy'];

  it('[@default] every bypass flag is exit 2 on every gated verb', () => {
    for (const verb of GATED) {
      for (const flag of FLAGS) {
        const run = runFactory([...verb, flag], { home });
        expect(run.code, `${verb.join(' ')} ${flag}`).toBe(2);
        // A bare flag is refused by the bypass check, before commander sees it. The
        // `--yes=1`/`-fy` shapes are unknown options instead — also exit 2, different text.
        if (!flag.includes('=') && flag !== '-fy') {
          expect(run.stderr).toMatch(/no force path|bypass/iu);
        }
      }
    }
  });

  it('[@default] the same flags are tolerated on a verb with no gate', () => {
    // `status` has nothing to bypass, so a stray flag must not be rejected as a bypass — it is
    // simply not this gate's business (commander rejects unknown options, which is exit 2 too,
    // so the assertion is about *which* error is produced).
    const run = runFactory(['status', '--yes'], { home });
    expect(run.stderr).not.toMatch(/no force path/iu);
  });
});

describe('the store stays consistent across refusals', () => {
  it('[@default] nothing is left behind: one unit, no attempts, no artifacts', () => {
    runFactory(['promote', unitId, '--json'], { home });
    runFactory(['budget', 'raise', '--to', '9.00', '--reason', 'x', '--json'], { home });
    runFactory(['credential', '--repo', 'fixture', '--ttl', '15m', '--json'], { home });

    expect(units(home)).toHaveLength(1);
    expect(units(home)[0]?.['attempt']).toBeNull();
    expect(existsSync(join(home, 'artifacts'))).toBe(false);
  });
});
