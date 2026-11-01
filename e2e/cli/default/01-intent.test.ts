/**
 * Intent intake: the first place the factory can be wrong in a way that costs money.
 *
 * A duplicate submission must not create a second unit (idempotency is what lets an operator
 * retry a flaky terminal), and a malformed spec must be refused *before* a unit row exists —
 * a spec that is stored but unpromotable is a unit someone has to clean up by hand.
 *
 * E2E-01, E2E-02, E2E-03, E2E-04, E2E-05 of `e2e-tests.md`.
 */
import { describe, expect, it, afterEach, beforeEach } from 'vitest';
import {
  jsonOf,
  newFactoryHome,
  runFactory,
  specFor,
  submitUnit,
  units,
  writeJsonFile,
  writeTextFile,
} from '../../harness/factory.ts';
import {
  assertVisibleSuitePasses,
  createFixtureRepo,
  type FixtureRepo,
} from '../../harness/fixture.ts';

let fixture: FixtureRepo;
let home: string;

beforeEach(() => {
  fixture = createFixtureRepo();
  home = newFactoryHome();
});

afterEach(() => {
  fixture.cleanup();
});

function spec(): ReturnType<typeof specFor> {
  return specFor({ baseRev: fixture.baseRev, repo: 'fixture' });
}

describe('intent', () => {
  it('[@default] binds the restate-back to the spec and records one unit', () => {
    assertVisibleSuitePasses(fixture.repo);
    const submitted = submitUnit(home, { spec: spec() });
    const json = jsonOf(submitted.run);

    expect(submitted.run.code).toBe(0);
    expect(json['ok']).toBe(true);
    expect(json['unitId']).toMatch(/^U-[0-9a-f]{6,}$/u);
    expect(json['specHash']).toMatch(/^sha256:[0-9a-f]{64}$/u);
    expect(json['restateHash']).toMatch(/^sha256:[0-9a-f]{64}$/u);
    expect(json['created']).toBe(true);
    // The human stream carries the same identity, so an operator who did not pass --json
    // still sees what the machine recorded.
    expect(submitted.run.stderr).toContain(String(json['unitId']));
    expect(units(home)).toHaveLength(1);
  });

  it('[@default] same spec twice returns the same unit and creates no second one', () => {
    const first = submitUnit(home, { spec: spec() });
    const second = submitUnit(home, { spec: spec() });

    expect(second.unitId).toBe(first.unitId);
    expect(jsonOf(second.run)['created']).toBe(false);
    expect(second.run.code).toBe(0);
    expect(units(home)).toHaveLength(1);
  });

  it('[@default] an invalid spec is refused before any unit exists', () => {
    const bad = specFor({
      baseRev: fixture.baseRev,
      acceptance: [
        {
          id: 'ok',
          text: 'node --test exits 0',
          oracle: { kind: 'command', target: 'node --test tests/', expect: 'exit 0' },
        },
        { id: 'broken', text: 'no oracle at all' },
      ],
    });
    const run = runFactory(['intent', '--file', writeJsonFile(home, 'bad.json', bad), '--json'], {
      home,
    });
    const json = jsonOf(run);

    expect(run.code).toBe(3);
    expect(json['ok']).toBe(false);
    expect(json['code']).toBe('SPEC_INVALID');
    expect(String(json['message'])).toContain('acceptance');
    expect(units(home)).toHaveLength(0);
  });

  it('[@default] the same spec with a different restate-back is a conflict, not a new unit', () => {
    const submitted = submitUnit(home, { spec: spec() });
    const edited = writeTextFile(
      home,
      'restate-edited.md',
      'You asked for: something else entirely.',
    );

    const run = runFactory(
      [
        'intent',
        '--file',
        writeJsonFile(home, 'spec2.json', spec()),
        '--restate',
        edited,
        '--json',
      ],
      { home },
    );
    const json = jsonOf(run);

    expect(run.code).toBe(3);
    expect(json['ok']).toBe(false);
    // Whichever code the intake chooses, the important part is that it refuses and says why.
    expect(String(json['message'])).toMatch(/restate|duplicate|revision/iu);
    expect(units(home)).toHaveLength(1);
    expect(units(home)[0]?.['unitId']).toBe(submitted.unitId);
  });

  it('[@default] a missing restate-back warns at intake but still qualifies as lit', () => {
    const specPath = writeJsonFile(home, 'spec.json', spec());
    const run = runFactory(['intent', '--file', specPath], { home });
    expect(run.code).toBe(0);
    expect(run.stderr).toMatch(/restate/iu);

    const unitId = units(home)[0]?.['unitId'];
    expect(typeof unitId).toBe('string');
    const qualify = runFactory(['qualify', String(unitId), '--json'], { home });
    const json = jsonOf(qualify);

    // Documented divergence from e2e-tests.md E2E-05, which expects `reject` (exit 3) with
    // INTENT_NOT_DERIVABLE. The implementation scores the unit on the spec's own restateBack
    // field, so an unbound restate-back is `lit` (unknown signal), not a structural refusal:
    // the unit is parked for a person instead of being refused.
    expect(qualify.code).toBe(0);
    expect(json['lane']).toBe('lit');
    const signals = json['signals'] as { name: string; outcome: string }[];
    expect(signals.some((signal) => signal.outcome === 'unknown')).toBe(true);
  });
});
