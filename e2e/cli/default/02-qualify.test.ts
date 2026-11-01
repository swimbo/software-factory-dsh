/**
 * Qualify: the routing decision, and the two ways it can be reached legitimately.
 *
 * Two facts drive these specs:
 *
 * - with `taskClassHistory` unknown and no cold-start policy, **every** unit is `lit` — a
 *   factory that has measured nothing cannot dispatch anything. That is the correct default,
 *   and it means the dark path is only reachable via cold start, which is labelled
 *   `TASK_CLASS_COLD_START` ("by policy, not measured") and carries a different policy
 *   version. Both are asserted here so a future regression cannot make cold start look
 *   measured.
 * - a security-relevant operation class is locked to `lit` even when it is reversible.
 *
 * E2E-06, E2E-07, E2E-34 of `e2e-tests.md`.
 */
import { describe, expect, it, afterEach, beforeEach } from 'vitest';
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

/** A spec whose restate-back overlaps its intent (the qualifier's derivability floor is 0.5). */
function derivable(overrides: Parameters<typeof specFor>[0] = {}): ReturnType<typeof specFor> {
  return specFor({ baseRev: fixture.baseRev, ...overrides });
}

describe('qualify', () => {
  it('[@default] routes a derivable unit to lit, because nothing has been measured', () => {
    const { unitId } = submitUnit(home, { spec: derivable() });
    const run = runFactory(['qualify', unitId, '--json'], { home });
    const json = jsonOf(run);

    expect(run.code).toBe(0);
    expect(json['lane']).toBe('lit');
    const signals = json['signals'] as { name: string; outcome: string; reason: string }[];
    const history = signals.find((signal) => signal.name === 'task_class_history');
    expect(history?.outcome).toBe('unknown');
    expect(history?.reason).toBe('TASK_CLASS_UNKNOWN');
  });

  it('[@default] cold start routes a clean unit dark, labelled by policy not measurement', () => {
    const { unitId } = submitUnit(home, { spec: derivable() });
    const run = runFactory(['qualify', unitId, '--cold-start', '--json'], { home });
    const json = jsonOf(run);

    expect(run.code).toBe(0);
    expect(json['lane']).toBe('dark');
    const signals = json['signals'] as { name: string; outcome: string; reason: string }[];
    const history = signals.find((signal) => signal.name === 'task_class_history');
    expect(history?.outcome).toBe('pass');
    expect(history?.reason).toBe('TASK_CLASS_COLD_START');
    expect(String(json['policyVersion'])).toMatch(/^sha256:[0-9a-f]{64}$/u);
    // The operator-facing text must say what cold start is, not leave it to the reason code.
    expect(run.stderr).toMatch(/by policy, not measured|cold start/iu);
  });

  it('[@default] the cold-start policy version differs from the shipped one', () => {
    const cold = submitUnit(home, { spec: derivable({ slug: 'cold' }) });
    const coldRun = runFactory(['qualify', cold.unitId, '--cold-start', '--json'], { home });
    const coldJson = jsonOf(coldRun);

    const warm = submitUnit(home, { spec: derivable({ slug: 'warm' }) });
    const warmRun = runFactory(['qualify', warm.unitId, '--json'], { home });
    const warmJson = jsonOf(warmRun);

    expect(coldJson['policyVersion']).not.toBe(warmJson['policyVersion']);
    expect(coldJson['lane']).toBe('dark');
    expect(warmJson['lane']).toBe('lit');
  });

  it('[@default] a security-relevant operation class is locked to lit even with cold start', () => {
    const { unitId } = submitUnit(home, {
      spec: derivable({ slug: 'sec', operationClasses: ['force-push'] }),
    });
    const run = runFactory(['qualify', unitId, '--cold-start', '--json'], { home });
    const json = jsonOf(run);

    expect(run.code).toBe(0);
    expect(json['lane']).toBe('lit');
    expect(run.stderr).toMatch(/SECURITY/u);
    expect(run.stderr).toMatch(/force-push/u);
  });

  it('[@default] the signal list is the closed enum, and every outcome is pass/fail/unknown', () => {
    const { unitId } = submitUnit(home, { spec: derivable() });
    const run = runFactory(['qualify', unitId, '--json'], { home });
    const json = jsonOf(run);
    const signals = json['signals'] as { name: string; outcome: string; reason: string }[];

    expect(signals).toHaveLength(6);
    expect(signals.map((signal) => signal.name)).toEqual([
      'intent_derivability',
      'reversibility',
      'observability',
      'task_class_history',
      'size',
      'budget',
    ]);
    for (const signal of signals) {
      expect(['pass', 'fail', 'unknown']).toContain(signal.outcome);
      expect(signal.reason).toMatch(/^[A-Z][A-Z0-9_]+$/u);
    }
  });

  it('[@default] a second qualify of a dark unit is a stored decision, not a re-score', () => {
    const { unitId } = submitUnit(home, { spec: derivable() });
    const first = runFactory(['qualify', unitId, '--cold-start', '--json'], { home });
    const second = runFactory(['qualify', unitId, '--cold-start', '--json'], { home });

    expect(second.code).toBe(0);
    const firstJson = jsonOf(first);
    const secondJson = jsonOf(second);
    expect(secondJson['lane']).toBe('dark');
    expect(secondJson['decisionId']).toBe(firstJson['decisionId']);
    expect(secondJson['stored']).toBe(true);
    expect(second.stderr).toMatch(/not\s+re-scored|stored decision/iu);
    expect(units(home)).toHaveLength(1);
  });

  it('[@default] a lit unit is terminal, so re-qualify refuses instead of re-scoring', () => {
    // Divergence from e2e-tests.md E2E-07, recorded rather than hidden: a `lit` decision
    // parks the unit (`lit_parked`), and a terminal unit is never re-qualified in place.
    const { unitId } = submitUnit(home, { spec: derivable() });
    expect(runFactory(['qualify', unitId, '--json'], { home }).code).toBe(0);
    const again = runFactory(['qualify', unitId, '--json'], { home });

    expect(again.code).toBe(3);
    expect(again.stderr).toContain('UNIT_ALREADY_TERMINAL');
    // The lane, not the state column, is what makes it terminal: no attempt may exist.
    expect(units(home)[0]?.['lane']).toBe('lit');
    expect(units(home)[0]?.['attempt']).toBeNull();
  });
});
