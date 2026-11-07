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
import { createWallFixture } from '../../harness/wall-fixture.ts';

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
  it(
    '[@default] carries every documented key the panel reads, and the unit it just took',
    { timeout: 120_000 },
    () => {
      const { unitId } = submitUnit(home, { spec: specFor({ baseRev: fixture.baseRev }) });
      const run = runFactory(['status', '--json'], { home });
      const raw = JSON.parse(run.stdout.trim()) as Record<string, unknown>;

      expect(run.code).toBe(0);
      expect(raw['ok']).toBe(true);
      expect(raw['schemaVersion']).toBe('status.v1');
      expect(Object.keys(raw).sort()).toEqual(
        [
          'budget',
          'concurrency',
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
    },
  );

  it('[@default] status --json validates against StatusV1', () => {
    // Was an `it.fails` while the contract and the CLI disagreed: the payload carries
    // `factory.wallVersion: null` and `units[].lane: null` on a host with no wall and an
    // unqualified unit, and `StatusV1` required a non-empty string plus a lane enum. The
    // schema now admits both, so this is a plain assertion again — and it is the one spec
    // that would catch the two drifting apart a second time.
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

/**
 * A verdict outlives the unit it was measured for — and `status` had been reading the verdict, not
 * the unit.
 *
 * The "sign the first promotion" prompt was derived from `verdictRow !== null &&
 * verdictRow.outcome === 'pass' && promotionRow === null` with no check on `unit.state`. So ending a
 * unit after a measured pass left the prompt open forever: on the live store, 101 certification
 * fixtures that were ended in one triage left `status` reading `105 need you` while 2 items were
 * real. Wallpaper is the failure this whole surface exists to avoid, so the prompt must be a fact
 * about the unit's *state*, not about a row that survives it.
 */
describe('a unit that was ended after it passed', () => {
  it('[@default] stops asking for a signature that nobody can give', { timeout: 180_000 }, () => {
    const wall = createWallFixture();
    try {
      const unitId = wall.submit();
      const run = wall.run(unitId);
      expect(run.code, `run ${unitId}: ${run.stdout}${run.stderr}`).toBe(0);

      const before = jsonOf(runFactory(['status', '--json'], { home: wall.home }));
      const gatesBefore = (before['waitingOnPerson'] as Record<string, unknown>[]).filter(
        (gate) => gate['kind'] === 'initial_production_deploy' && gate['unitId'] === unitId,
      );
      // The premise: a measured pass with no promotion is a signature waiting to happen.
      expect(gatesBefore, 'a verified unit must ask for its first signature').toHaveLength(1);

      const aborted = runFactory(
        [
          'abort',
          unitId,
          '--reason',
          'certification fixture ended after its measured pass; no promotion was ever intended',
          '--json',
        ],
        { home: wall.home },
      );
      expect(aborted.code, `abort ${unitId}: ${aborted.stdout}${aborted.stderr}`).toBe(0);

      const after = jsonOf(runFactory(['status', '--json'], { home: wall.home }));
      const gatesAfter = (after['waitingOnPerson'] as Record<string, unknown>[]).filter(
        (gate) => gate['unitId'] === unitId,
      );
      // Nothing about an ended unit can be actionable, whichever row it came from.
      expect(gatesAfter, JSON.stringify(gatesAfter)).toHaveLength(0);

      const unit = (after['units'] as Record<string, unknown>[]).find(
        (row) => row['unitId'] === unitId,
      );
      expect(unit?.['state']).toBe('aborted');
      // The verdict is still evidence and the surface must not lose it: an abort ends the unit,
      // never the measurement.
      expect((unit?.['verdict'] as Record<string, unknown> | undefined)?.['state']).toBe('passed');
    } finally {
      wall.cleanup();
    }
  });
});

/**
 * The same defect in the other direction: the aggregate line counted a *verdict*, not a unit.
 *
 * A unit whose last verdict is `unknown` renders as `unknown` on purpose (L3: not measured is not a
 * pass). But it kept rendering that way after the unit was ended, so `status` reported
 * "N unknown (not a pass)" about work that no longer exists. On the live store that line survived the
 * triage of 101 ended fixtures. The state of an ended unit is the state it was ended in.
 */
describe('a unit that was ended with an unknown verdict', () => {
  it('[@default] does not keep counting as unknown after it is ended', { timeout: 180_000 }, () => {
    const wall = createWallFixture();
    try {
      // A silent pinned suite is the shortest honest route to an `unknown` verdict: the wall's own
      // oracle produced no readable summary, so the attempt is unmeasured (not failed).
      const unitId = wall.submit({ revision: 2 });
      wall.run(unitId, [], wall.wallEnv({ FACTORY_WALL_SUITE: 'node -e process.exit(0)' }));

      const before = jsonOf(runFactory(['status', '--json'], { home: wall.home }));
      const live = (before['units'] as Record<string, unknown>[]).find(
        (row) => row['unitId'] === unitId,
      );
      expect((live?.['verdict'] as Record<string, unknown> | undefined)?.['state']).toBe('unknown');
      expect(live?.['state']).toBe('unknown');

      const aborted = runFactory(
        [
          'abort',
          unitId,
          '--reason',
          'superseded: the pinned suite was silent, so nothing was measured',
          '--json',
        ],
        { home: wall.home },
      );
      expect(aborted.code, `abort ${unitId}: ${aborted.stdout}${aborted.stderr}`).toBe(0);

      const after = jsonOf(runFactory(['status', '--json'], { home: wall.home }));
      const ended = (after['units'] as Record<string, unknown>[]).find(
        (row) => row['unitId'] === unitId,
      );
      expect(ended?.['state']).toBe('aborted');
      // The measurement is still readable, and still says unknown: the abort ends the unit, not the
      // fact that it was never measured.
      expect((ended?.['verdict'] as Record<string, unknown> | undefined)?.['state']).toBe(
        'unknown',
      );
      expect(
        (after['units'] as Record<string, unknown>[]).filter((row) => row['state'] === 'unknown'),
      ).toHaveLength(0);
    } finally {
      wall.cleanup();
    }
  });
});
