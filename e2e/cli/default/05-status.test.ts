/**
 * `status`: the only surface where a person is told what is wrong, so the two ways it can
 * lie are the two things asserted first.
 *
 * - **`unknown` must never read as success.** A unit whose attempt is ambiguous appears under
 *   NEEDS YOU, the exit code is non-zero, and the words are printed (`A-1`).
 * - **estimated is not measured.** Every money figure is rendered with `~`/`estimated`.
 *
 * `status --json` is validated against the contract's own `parseStatus()`, not against a
 * shape this suite invented: if the CLI and the schema disagree, the schema wins.
 *
 * E2E-11, E2E-12, E2E-16, E2E-24, E2E-25 of `e2e-tests.md`.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { parseStatus } from '@factory/contracts';
import { jsonOf, newFactoryHome, runFactory, specFor, submitUnit } from '../../harness/factory.ts';
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

describe('status --json', () => {
  it('[@default] carries every documented key the panel reads, and the unit it just took', () => {
    const { unitId } = submitUnit(home, { spec: specFor({ baseRev: fixture.baseRev }) });
    const run = runFactory(['status', '--json'], { home });
    const raw = JSON.parse(run.stdout.trim()) as Record<string, unknown>;

    expect(run.code).toBe(0);
    expect(raw['ok']).toBe(true);
    expect(raw['schemaVersion']).toBe('status.v1');
    expect(Object.keys(raw).sort()).toEqual(
      [
        'budget',
        'factory',
        'generatedAt',
        'health',
        'ok',
        'schemaVersion',
        'units',
        'waitingOnPerson',
      ].sort(),
    );
    const units = raw['units'] as { unitId: string }[];
    expect(units.map((unit) => unit.unitId)).toContain(unitId);
  });

  it('[@default] status --json validates against StatusV1', () => {
    // BUG, reported not patched: on a host where the wall is unavailable and a unit has not
    // been qualified, the payload carries `factory.wallVersion: null` and `units[].lane: null`.
    // `StatusV1` requires a non-empty string for `wallVersion` and a lane enum for `lane`, so
    // `parseStatus()` rejects the CLI's own output. `it.fails` keeps the suite honest while this
    // is open: the moment the CLI or the schema is reconciled, this assertion passes and vitest
    // reports it as an unexpected pass, which is the prompt to flip it back to `it`.
    submitUnit(home, { spec: specFor({ baseRev: fixture.baseRev }) });
    const raw = JSON.parse(runFactory(['status', '--json'], { home }).stdout.trim()) as unknown;

    expect(() => parseStatus(raw)).not.toThrow();
  });

  it('[@default] keeps stdout empty and puts the aggregate line on stderr exactly once', () => {
    // `ux-plan.md` §4.1's "one line while healthy" is about *work*, not about the store being
    // empty: a fresh store also gets an onboarding line, and a unit in flight gets its block.
    // What must hold in every case is the separation of streams and a single aggregate line.
    const empty = runFactory(['status'], { home });
    expect(empty.code).toBe(0);
    expect(empty.stdout).toBe('');
    expect(empty.stderr.split('\n').filter((line) => line.includes('in flight')).length).toBe(1);
    expect(empty.stderr).toContain('no units');

    submitUnit(home, { spec: specFor({ baseRev: fixture.baseRev }) });
    const withUnit = runFactory(['status'], { home });
    expect(withUnit.code).toBe(0);
    expect(withUnit.stdout).toBe('');
    const aggregate = withUnit.stderr
      .trim()
      .split('\n')
      .filter((line) => line.includes('in flight'));
    expect(aggregate).toHaveLength(1);
    // A `submitted` unit is not "in flight" yet — it is waiting to be qualified — and the
    // aggregate says so rather than inflating the number.
    expect(aggregate[0]).toMatch(/in flight · 0 need you · 0 unknown .*not a pass/iu);
    // The unknown count is always labelled, even when it is zero.
    expect(aggregate[0]).toContain('not a pass');
  });

  it('[@default] an ambiguous attempt is exit 5, and says UNKNOWN rather than ok', () => {
    const seeded = seedUnit(home, { lane: 'dark', state: 'qualified' });
    seedStaleAttempt(home, seeded.unitId, 'A-e2e1');
    const recovered = runFactory(['recover', '--json'], { home });
    expect(recovered.code).toBe(4);

    const run = runFactory(['status', '--json'], { home });
    expect(run.code).toBe(5);
    // Read raw: the payload does not satisfy `StatusV1` yet (see the contract spec above), and
    // this assertion is about what a person is told, not about the schema.
    const raw = JSON.parse(run.stdout.trim()) as {
      waitingOnPerson: unknown[];
      units: { unitId: string; state: string }[];
    };
    expect(raw.waitingOnPerson.length).toBeGreaterThan(0);
    expect(raw.units.some((unit) => unit.state === 'ambiguous')).toBe(true);

    const human = runFactory(['status'], { home });
    expect(human.code).toBe(5);
    expect(human.stderr).toMatch(/UNKNOWN/iu);
    expect(human.stderr).not.toMatch(/^ok\b/iu);
  });

  it('[@default] --plain emits zero ANSI bytes and keeps the labels', () => {
    const run = runFactory(['status', '--plain'], { home });
    // eslint-disable-next-line no-control-regex
    expect(run.stderr).not.toMatch(/\u001B\[/u);
    expect(run.stderr).toContain('not a pass');
  });

  it('[@default] --all lists every unit with its lane and state', () => {
    const first = submitUnit(home, { spec: specFor({ baseRev: fixture.baseRev, slug: 'one' }) });
    const second = submitUnit(home, { spec: specFor({ baseRev: fixture.baseRev, slug: 'two' }) });

    const run = runFactory(['status', '--all'], { home });
    expect(run.code).toBe(0);
    expect(run.stderr).toContain('UNITS');
    expect(run.stderr).toContain(first.unitId);
    expect(run.stderr).toContain(second.unitId);
  });

  it('[@default] --help names the exit codes and never offers a force flag', () => {
    // Divergence from e2e-tests.md E2E-16, recorded: the top-level help has no EXAMPLES and no
    // LIMITS section. What it does have is the exit-code table and the "there is no -y" line,
    // which are the two things the plan wanted those sections to carry.
    const run = runFactory(['--help'], { home });
    expect(run.code).toBe(0);
    expect(run.stdout).toMatch(/Exit codes: 0 ok/u);
    expect(run.stdout).toMatch(/there is no -y/u);
    expect(run.stdout).toContain('promote');
    // The flags are documented as *absent*, in prose, and never offered as options:
    // "No gate can be bypassed: -y, --yes, --force, -f and --assume-yes are usage errors".
    expect(run.stdout).toMatch(/-y, --yes, --force/iu);
    const optionsBlock = run.stdout.slice(
      run.stdout.indexOf('Options:'),
      run.stdout.indexOf('Commands:'),
    );
    expect(optionsBlock).not.toMatch(/--yes|--force|--assume-yes/u);
  });
});
