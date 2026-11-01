/**
 * `factory status` — the one screen an operator reads every morning.
 *
 * Three properties are load-bearing and all three are tested here:
 *
 * 1. the JSON key set is the `/api/status` key set (`ui-plan.md` §5.1), so the
 *    terminal and the web page cannot drift into two truths;
 * 2. `unknown` counts as needing a person (design law L3 / `ux-plan.md` §6.2):
 *    exit 5 and the words "not a pass" in the aggregate line;
 * 3. money is always `~` and always the word `estimated` (design law A-2).
 */
import { describe, expect, it } from 'vitest';

import { EXIT } from './exit.ts';
import { jsonOf, runCli, seedStaleAttempt, seedUnit, tempHome } from './testing.ts';

const STATUS_KEYS = [
  'schemaVersion',
  'generatedAt',
  'factory',
  'waitingOnPerson',
  'units',
  'health',
  'budget',
] as const;

describe('status --json', () => {
  it('carries exactly the /api/status keys plus the CLI ok envelope', () => {
    const home = tempHome();
    const json = jsonOf(runCli(['status', '--json'], { home }));
    expect(Object.keys(json).sort()).toEqual([...STATUS_KEYS, 'ok'].sort());
    expect(json['schemaVersion']).toBe('status.v1');
  });

  it('names the factory as waiting on a person, or not, with a stable shape', () => {
    const home = tempHome();
    const json = jsonOf(runCli(['status', '--json'], { home }));
    expect(json['waitingOnPerson']).toEqual([]);
    expect(json['units']).toEqual([]);
    // Health is per-subsystem, so "is it quiet or dead" is answerable without a shell.
    const health = json['health'] as Record<string, unknown>;
    for (const subsystem of ['store', 'controlPlane', 'executor', 'wall', 'outbox', 'dshVersion']) {
      expect(health, subsystem).toHaveProperty(subsystem);
    }
  });
});

describe('status on an empty factory', () => {
  it('exits 0 and says how to start, without pretending the empty state is a problem', () => {
    const home = tempHome();
    const result = runCli(['status'], { home });
    expect(result.status).toBe(EXIT.ok);
    expect(result.stdout).toBe('');
    expect(result.stderr).toContain('no units');
  });

  it('renders spend as an estimate, never as a charge', () => {
    const home = tempHome();
    expect(runCli(['status'], { home }).stderr).toContain('estimated');
  });
});

describe('status when something is unknown', () => {
  it('exits 5, lists the unit under NEEDS YOU, and says "not a pass"', () => {
    const home = tempHome();
    const { unitId } = seedUnit(home, { lane: 'dark' });
    seedStaleAttempt(home, unitId);
    const recovered = runCli(['recover'], { home });
    expect(recovered.status).toBe(EXIT.unknown);

    const status = runCli(['status'], { home });
    expect(status.status).toBe(EXIT.gate);
    expect(status.stderr).toContain('NEEDS YOU');
    expect(status.stderr).toContain('unknown (not a pass)');
    expect(status.stderr).toContain(unitId);
  });

  it('reports the ambiguity in --json as a waiting item, not as a failure', () => {
    const home = tempHome();
    const { unitId } = seedUnit(home, { lane: 'dark' });
    seedStaleAttempt(home, unitId);
    runCli(['recover'], { home });
    const json = jsonOf(runCli(['status', '--json'], { home }));
    expect((json['waitingOnPerson'] as unknown[]).length).toBe(1);
    const units = json['units'] as Array<Record<string, unknown>>;
    expect(units[0]).toMatchObject({ unitId, state: 'ambiguous' });
    expect(units[0]?.['ambiguity']).toMatchObject({
      known: expect.any(String),
      unknown: expect.any(String),
      notDone: expect.any(String),
    });
  });

  it('refuses to name an unknown unit with exit 3, not with an empty page', () => {
    const home = tempHome();
    const result = runCli(['status', 'U-nope'], { home });
    expect(result.status).toBe(EXIT.policy);
    expect(result.stderr).toContain('UNIT_NOT_FOUND');
  });
});

describe('status budget and task classes', () => {
  it('reports the documented daily default instead of a $0 ceiling, and says it is a default', () => {
    const home = tempHome();
    const run = runCli(['status', '--json'], { home });
    const json = jsonOf(run);
    const budget = json['budget'] as Record<string, unknown>;
    const perDay = budget['perDay'] as Record<string, unknown>;
    // $0 would read as "the budget is exhausted". No envelope row means the documented
    // default applies, and the note says so in words an operator can act on.
    expect(perDay['limit']).toBe(20);
    expect(perDay['kind']).toBe('estimated');
    expect(String(budget['note'])).toContain('documented default');
    // The marker is render-only: it must not leak into the frozen status contract.
    expect(perDay['limitIsDefault']).toBeUndefined();
    expect(run.stderr).toContain('default');
  });

  it('aggregates Δ per task class from verdicts that measured one, never from a passing suite', () => {
    const home = tempHome();
    const json = jsonOf(runCli(['status', '--json'], { home }));
    const health = json['health'] as Record<string, unknown>;
    // Nothing has been measured here, and the array says that rather than implying
    // "everything is stable".
    expect(health['taskClasses']).toEqual([]);
    const human = runCli(['status'], { home });
    expect(human.stderr).toContain('task classes  none measured');
  });
});

describe('status of a single unit', () => {
  it('prints the state as a word in a fixed column, and no diff', () => {
    const home = tempHome();
    const { unitId } = seedUnit(home, { lane: 'dark' });
    const result = runCli(['status', unitId], { home });
    expect(result.stderr).toContain(unitId);
    expect(result.stderr).toContain('dark');
    expect(result.stderr).not.toContain('@@');
  });

  it('--all lists the units it has', () => {
    const home = tempHome();
    const { unitId } = seedUnit(home, { lane: 'dark' });
    const result = runCli(['status', '--all'], { home });
    expect(result.stderr).toContain('UNITS');
    expect(result.stderr).toContain(unitId);
  });
});
