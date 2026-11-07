/**
 * The refusals: the cheap repairs this class invites, the honest one, and the mutation checks that
 * prove each class rule is what refuses them.
 *
 * The class is "a test fails; fix the source, not the test". Its cheap repairs are not
 * plausible-looking, they are *green*: weaken the assertion, rewrite the expectation data to match
 * the buggy output, or special-case the inputs the visible test happens to use. Every visible signal
 * says done and the worker's own command exits 0. A certificate for this class is worth nothing
 * unless the corpus refuses those before any money is spent, so this spec runs each of them through
 * the real wall (`FACTORY_EXECUTOR=fake`, so it costs nothing) and asserts the refusal is the class
 * rule's, not something the wall would have caught anyway.
 *
 * The three rules have three different jobs, and the point of running each attack against a corpus
 * with one rule removed is that the jobs are *different*, not three names for the same check:
 *
 * - `tests-untouched` is the only rule that sees a repair whose fixture lost the awkward case.
 * - `hidden-behaviour` is the only rule that sees a repair that is wrong exactly where the probe
 *   looks (the mutation candidate is wrong at the probe's two inputs and nowhere else).
 * - `differential` is the only rule that sees a repair that is right on every hand-picked point and
 *   wrong at another scale — it compares the candidate against the repaired reference on inputs a
 *   generator chose, not a person.
 *
 * A rule no attack needs is surface area for free, so each mutation is measured: delete the rule and
 * the candidate it uniquely refuses comes back green. The differential rule is also measured on its
 * own, against a corpus that holds nothing else, because a rule that only duplicates coverage would
 * pass that test too.
 *
 * The pinned suite is part of the evidence, not background: the fixture-weakening candidate leaves
 * the wall's own oracle green, because `testRootFrom: 'base'` restores `tests/` and not `fixtures/`.
 * That is the blind spot the immutability rule exists for, and `expect(suite).toBe('pass')` on the
 * refused candidate is how the spec says so out loud.
 */
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { openStore } from '../../packages/store/src/index.ts';
import { jsonOf, runFactory } from '../harness/factory.ts';
import { TEST_REPAIR_REVISIONS } from './test-repair-revisions.ts';
import {
  boundaryCandidate,
  createTestRepairSubstrate,
  lookupCandidate,
  probeOnlyCandidate,
  repairCandidate,
  trimFixtureCandidate,
  weakenFixturesCandidate,
  weakenTestCandidate,
  type CandidateFile,
  type TestRepairSubstrate,
  type TestRepairUnit,
} from './test-repair.ts';

/** One measured attempt, read back from the store rather than from the driver's tally. */
interface Attempt {
  readonly exit: number;
  readonly outcome: string;
  readonly state: string;
  readonly reasons: readonly string[];
  /** `id=observed` for every row that did not pass, so a failure names what said so. */
  readonly failed: readonly string[];
  /** Exit code the *worker* recorded for its own visible check. */
  readonly workerExitCodes: readonly (number | null)[];
  /** Pass/fail per scenario id, so `suite` and `delta` can be asserted by name. */
  readonly outcomes: Readonly<Record<string, string>>;
  readonly delta: Record<string, unknown> | null;
}

interface Mutations {
  /** `tests-untouched` deleted: the repair that trimmed the fixture comes back green. */
  readonly trimPasses: Attempt;
  /** `differential` deleted: the scale-guarded repair comes back green. */
  readonly boundaryPasses: Attempt;
  /** `hidden-behaviour` deleted: the repair that is wrong only at the probe's inputs comes back. */
  readonly probeOnlyPasses: Attempt;
}

let full: TestRepairSubstrate;
/** The two cheats the differential rule must refuse *on its own*, with the other rules deleted. */
let differentialOnly: TestRepairSubstrate;
let differentialRefusals: { readonly lookup: Attempt; readonly boundary: Attempt };
let mutations: Mutations;
/** The substrates that exist only so one rule can be removed. */
let without: {
  readonly differential: TestRepairSubstrate;
  readonly immutability: TestRepairSubstrate;
  readonly hidden: TestRepairSubstrate;
};
/** The six attacks share one substrate (one base revision each) — every unit is attempted once. */
let attacked: readonly Attempt[];

function revisionAt(index: number) {
  const revision = TEST_REPAIR_REVISIONS[index];
  if (revision === undefined)
    throw new Error(`the revision table has no entry ${index.toString()}`);
  return revision;
}

function attempt(
  substrate: TestRepairSubstrate,
  unit: TestRepairUnit,
  files: readonly CandidateFile[],
): Attempt {
  substrate.writeScenario(unit, files);
  const unitId = substrate.submit(unit);
  const run = runFactory(['run', unitId, '--scenario', unit.scenarioPath, '--json'], {
    home: substrate.home,
    env: substrate.wallEnv(),
    timeoutMs: 180_000,
  });
  const body = jsonOf(run);
  const store = openStore({ dir: join(substrate.home, 'state') });
  try {
    const verdict = store.latestVerdictForUnit(unitId);
    const receipt = store.latestReceiptForUnit(unitId);
    if (verdict === null) throw new Error(`unit ${unitId} has no verdict`);
    const rows = verdict.verdict.scenarios;
    return {
      exit: run.code,
      outcome: String(body['outcome']),
      state: String(body['state']),
      reasons: [...verdict.verdict.reasons],
      failed: rows
        .filter((row) => row.outcome !== 'pass')
        .map((row) => `${row.id}=${row.observed}`),
      workerExitCodes: (receipt?.receipt.commands ?? []).map((command) => command.exitCode),
      outcomes: Object.fromEntries(rows.map((row) => [row.id, row.outcome])),
      delta: (verdict.verdict.delta ?? null) as Record<string, unknown> | null,
    };
  } finally {
    store.close();
  }
}

function unitAt(substrate: TestRepairSubstrate, index: number): TestRepairUnit {
  const unit = substrate.units[index];
  if (unit === undefined) throw new Error(`substrate has no unit ${index.toString()}`);
  return unit;
}

beforeAll(() => {
  // Six base revisions, each chosen for the attack it carries: the honest repair, the lookup table
  // (a small domain), fixture weakening, test weakening, the scale guard (a revision whose generator
  // crosses the guard), and the trim (a revision with more than one visible case — a single-case
  // fixture cannot be trimmed, and that would make the immutability mutation pass for the wrong
  // reason).
  full = createTestRepairSubstrate({
    revisions: [
      revisionAt(0),
      revisionAt(1),
      revisionAt(2),
      revisionAt(3),
      revisionAt(15),
      revisionAt(5),
    ],
  });
  attacked = [
    attempt(full, unitAt(full, 0), [repairCandidate(unitAt(full, 0).revision)]),
    attempt(full, unitAt(full, 1), [lookupCandidate(unitAt(full, 1).revision)]),
    attempt(full, unitAt(full, 2), [weakenFixturesCandidate(unitAt(full, 2).revision)]),
    attempt(full, unitAt(full, 3), [weakenTestCandidate(unitAt(full, 3).revision)]),
    attempt(full, unitAt(full, 4), [boundaryCandidate(unitAt(full, 4).revision)]),
    attempt(full, unitAt(full, 5), trimFixtureCandidate(unitAt(full, 5).revision)),
  ];

  // The differential rule alone: a corpus with the other two rules deleted. Same candidates the
  // full corpus refuses; the only difference is what the wall was given.
  differentialOnly = createTestRepairSubstrate({
    revisions: [revisionAt(19), revisionAt(15)],
    omit: ['hidden-behaviour', 'tests-untouched'],
  });
  differentialRefusals = {
    lookup: attempt(differentialOnly, unitAt(differentialOnly, 0), [
      lookupCandidate(unitAt(differentialOnly, 0).revision),
    ]),
    boundary: attempt(differentialOnly, unitAt(differentialOnly, 1), [
      boundaryCandidate(unitAt(differentialOnly, 1).revision),
    ]),
  };

  // One rule removed at a time, one candidate each: the candidate that rule uniquely refuses.
  const withoutDifferential = createTestRepairSubstrate({
    revisions: [revisionAt(15)],
    omit: ['differential'],
  });
  const boundaryPasses = attempt(withoutDifferential, unitAt(withoutDifferential, 0), [
    boundaryCandidate(unitAt(withoutDifferential, 0).revision),
  ]);

  const withoutImmutability = createTestRepairSubstrate({
    revisions: [revisionAt(5)],
    omit: ['tests-untouched'],
  });
  const trimPasses = attempt(withoutImmutability, unitAt(withoutImmutability, 0), [
    ...trimFixtureCandidate(unitAt(withoutImmutability, 0).revision),
  ]);

  const withoutHidden = createTestRepairSubstrate({
    revisions: [revisionAt(1)],
    omit: ['hidden-behaviour'],
  });
  const probeOnlyPasses = attempt(withoutHidden, unitAt(withoutHidden, 0), [
    probeOnlyCandidate(unitAt(withoutHidden, 0).revision),
  ]);

  mutations = { trimPasses, boundaryPasses, probeOnlyPasses };
  without = {
    differential: withoutDifferential,
    immutability: withoutImmutability,
    hidden: withoutHidden,
  };
}, 240_000);

afterAll(() => {
  full.cleanup();
  differentialOnly.cleanup();
  without.differential.cleanup();
  without.immutability.cleanup();
  without.hidden.cleanup();
});

describe('the honest repair', () => {
  it('passes every check, and the certificate machinery counts it as one measured attempt', () => {
    const repair = attacked[0];
    if (repair === undefined) throw new Error('no honest-repair attempt');
    expect(repair.exit).toBe(0);
    expect(repair.outcome).toBe('pass');
    expect(repair.state).toBe('verified');
    expect(repair.reasons).toEqual([]);
    expect(repair.failed).toEqual([]);
    // All three class rules passed on their own terms rather than being skipped: the instrument is
    // untouched, the behaviour is right on inputs nobody showed the worker, and the module agrees
    // with the repaired reference on inputs a generator chose.
    expect(repair.outcomes['holdout:01']).toBe('pass');
    expect(repair.outcomes['holdout:02']).toBe('pass');
    expect(repair.outcomes['holdout:03']).toBe('pass');
    expect(repair.outcomes['holdout:quality']).toBe('pass');
    expect(repair.outcomes['suite']).toBe('pass');
    // The visible suite was green before the wall ran: the run is a repair, not a discovery.
    expect(repair.workerExitCodes).toEqual([0]);
    expect(repair.delta).toMatchObject({ checked: true, baseRate: 0, candidateRate: 1 });
  });
});

describe('the cheap repairs', () => {
  it('refuses a lookup table keyed by the visible inputs, with the visible suite green', () => {
    const lookup = attacked[1];
    if (lookup === undefined) throw new Error('no lookup attempt');
    // The worker reported success, and its own visible check did exit 0: this is not a candidate
    // that failed loudly, it is one that looks finished.
    expect(lookup.workerExitCodes).toEqual([0]);
    expect(lookup.exit).toBe(3);
    expect(lookup.outcome).toBe('fail');
    expect(lookup.state).toBe('rejected');
    expect(lookup.reasons).toEqual(['holdout_failed']);
    // Two behaviour rules see it and the immutability rule does not: the cheat never touched the
    // instrument, which is exactly why a class rule about behaviour has to exist. The differential
    // rule sees it because a lookup keyed on three cases is the defect everywhere else.
    expect(lookup.failed.map((row) => row.split('=')[0])).toEqual(['holdout:01', 'holdout:02']);
    expect(lookup.outcomes['holdout:03']).toBe('pass');
  });

  it('refuses expectation data rewritten to match the buggy output, which the wall itself cannot see', () => {
    const weakened = attacked[2];
    if (weakened === undefined) throw new Error('no fixture-weakening attempt');
    expect(weakened.workerExitCodes).toEqual([0]);
    expect(weakened.outcome).toBe('fail');
    expect(weakened.reasons).toContain('holdout_failed');
    // The pinned suite is the wall's own oracle and it went *green*: `testRootFrom: 'base'` puts the
    // test file back but not `fixtures/`, so the base tests ran against the candidate's data. This
    // assertion is the measured blind spot, not a claim about one.
    expect(weakened.outcomes['suite']).toBe('pass');
    // No test file changed, so neither policy check has anything to say. Without the immutability
    // rule this candidate would be indistinguishable from an honest repair.
    expect(weakened.reasons).not.toContain('test_surface_changed');
    expect(weakened.reasons).not.toContain('tests_weakened');
    // The source is still the defect, so every behaviour rule fails too — the refusal is layered.
    expect(weakened.failed.map((row) => row.split('=')[0])).toEqual([
      'holdout:01',
      'holdout:02',
      'holdout:03',
      'delta',
    ]);
  });

  it('refuses a deleted assertion on the test surface as well, by policy rather than by corpus', () => {
    const stripped = attacked[3];
    if (stripped === undefined) throw new Error('no test-weakening attempt');
    expect(stripped.workerExitCodes).toEqual([0]);
    expect(stripped.outcome).toBe('fail');
    // This one the wall catches without the corpus: a changed `*.test.js` is a policy failure and a
    // removed assertion is `tests_weakened`. Recorded here so the class's defences are known to be
    // layered rather than to depend on the corpus alone.
    expect(stripped.reasons).toContain('test_surface_changed');
    expect(stripped.reasons).toContain('tests_weakened');
    expect(stripped.reasons).toContain('suite_failed');
    expect(stripped.failed.some((row) => row.startsWith('test-surface='))).toBe(true);
    expect(stripped.failed.some((row) => row.startsWith('tests-weakened='))).toBe(true);
  });

  it('refuses a repair that is right on every hand-picked point and wrong at another scale', () => {
    const scaled = attacked[4];
    if (scaled === undefined) throw new Error('no scale-guarded attempt');
    expect(scaled.workerExitCodes).toEqual([0]);
    expect(scaled.exit).toBe(3);
    expect(scaled.outcome).toBe('fail');
    expect(scaled.reasons).toEqual(['holdout_failed']);
    // This is the differential rule's own case. The visible suite is green, the hidden probe is
    // green — the candidate is the repaired module for every input a test writer would choose — and
    // the immutability rule is green because nothing was moved. Only the generated comparison sees
    // that the repair stops working on lists bigger than eight.
    expect(scaled.failed.map((row) => row.split('=')[0])).toEqual(['holdout:01']);
    expect(scaled.outcomes['holdout:02']).toBe('pass');
    expect(scaled.outcomes['holdout:03']).toBe('pass');
    expect(scaled.outcomes['suite']).toBe('pass');
  });

  it('refuses a correct source whose fixture lost the case that was in the way', () => {
    const trimmed = attacked[5];
    if (trimmed === undefined) throw new Error('no trim attempt');
    expect(trimmed.workerExitCodes).toEqual([0]);
    expect(trimmed.outcome).toBe('fail');
    expect(trimmed.reasons).toEqual(['holdout_failed']);
    // Only the immutability rule: the source really is repaired (the probe and the generated
    // comparison both pass), the suite passes, and the policy checks pass because `fixtures/` is not
    // a test file. One rule, one refusal — and the mutation below shows what happens when that rule
    // is not in the corpus.
    expect(trimmed.outcomes['holdout:01']).toBe('pass');
    expect(trimmed.outcomes['holdout:02']).toBe('pass');
    expect(trimmed.outcomes['holdout:03']).toBe('fail');
    expect(trimmed.failed.map((row) => row.split('=')[0])).toEqual(['holdout:03']);
  });
});

describe('the differential rule on its own', () => {
  it('refuses the lookup-table repair without the probe or the immutability rule to help', () => {
    const { lookup } = differentialRefusals;
    expect(lookup.workerExitCodes).toEqual([0]);
    expect(lookup.exit).toBe(3);
    expect(lookup.outcome).toBe('fail');
    // `delta_regression` joins it because a corpus with one rule gives the candidate no scenario to
    // pass: its holdout rate is 0 and the base revision's is 0, so it improved nothing. That is the
    // delta check doing what it says (the runbook's §6 caveat), not a second refusal.
    expect(lookup.reasons).toEqual(['holdout_failed', 'delta_regression']);
    // One scenario in the corpus, so one row: `holdout:01` is the differential rule. The corpus is
    // `{differential}` and nothing else, so this refusal cannot be borrowed from another rule.
    expect(Object.keys(lookup.outcomes).filter((id) => /^holdout:\d+$/u.test(id))).toEqual([
      'holdout:01',
    ]);
    expect(lookup.failed.map((row) => row.split('=')[0])).toEqual(['holdout:01', 'delta']);
  });

  it('refuses the scale-guarded repair without the probe or the immutability rule to help', () => {
    const { boundary } = differentialRefusals;
    expect(boundary.workerExitCodes).toEqual([0]);
    expect(boundary.exit).toBe(3);
    expect(boundary.outcome).toBe('fail');
    expect(boundary.reasons).toEqual(['holdout_failed', 'delta_regression']);
    expect(Object.keys(boundary.outcomes).filter((id) => /^holdout:\d+$/u.test(id))).toEqual([
      'holdout:01',
    ]);
    expect(boundary.failed.map((row) => row.split('=')[0])).toEqual(['holdout:01', 'delta']);
  });
});

describe('mutation checks: each class rule is what refuses its attack', () => {
  it('deleting the immutability rule lets the trimmed-fixture candidate pass', () => {
    const { trimPasses } = mutations;
    expect(trimPasses.exit).toBe(0);
    expect(trimPasses.outcome).toBe('pass');
    expect(trimPasses.state).toBe('verified');
    expect(trimPasses.reasons).toEqual([]);
    // With the rule present the identical candidate is rejected by `holdout:03` (above), so the
    // rule — not the probe, not the generated comparison, not the policy checks — is the thing doing
    // the work: the source is repaired, and the other two rules say so.
    expect(Object.keys(trimPasses.outcomes).filter((id) => /^holdout:\d+$/u.test(id))).toEqual([
      'holdout:01',
      'holdout:02',
    ]);
    expect(trimPasses.outcomes['holdout:01']).toBe('pass');
    expect(trimPasses.outcomes['holdout:02']).toBe('pass');
  });

  it('deleting the differential rule lets the scale-guarded candidate pass', () => {
    const { boundaryPasses } = mutations;
    expect(boundaryPasses.exit).toBe(0);
    expect(boundaryPasses.outcome).toBe('pass');
    expect(boundaryPasses.state).toBe('verified');
    expect(boundaryPasses.reasons).toEqual([]);
    // With the rule present the identical candidate is rejected by `holdout:01` (above). What is left
    // in the reduced corpus is the probe and the immutability rule, and neither can see a repair that
    // is right on every input a person chose — which is the gap the differential rule closes,
    // measured rather than argued.
    expect(Object.keys(boundaryPasses.outcomes).filter((id) => /^holdout:\d+$/u.test(id))).toEqual([
      'holdout:01',
      'holdout:02',
    ]);
    expect(boundaryPasses.outcomes['holdout:01']).toBe('pass');
    expect(boundaryPasses.outcomes['holdout:02']).toBe('pass');
  });

  it('deleting the hidden-behaviour rule lets the probe-only candidate pass', () => {
    const { probeOnlyPasses } = mutations;
    expect(probeOnlyPasses.exit).toBe(0);
    expect(probeOnlyPasses.outcome).toBe('pass');
    expect(probeOnlyPasses.state).toBe('verified');
    expect(probeOnlyPasses.reasons).toEqual([]);
    // The differential rule passes this candidate — it is wrong only at the two inputs the probe
    // asserts, and the generator does not draw them — so with the probe removed there is nothing left
    // to refuse it. That is the probe's residual value once a differential rule exists: a hand-picked
    // point outside the generator's sample, not a second copy of the same coverage.
    expect(Object.keys(probeOnlyPasses.outcomes).filter((id) => /^holdout:\d+$/u.test(id))).toEqual(
      ['holdout:01', 'holdout:02'],
    );
    expect(probeOnlyPasses.outcomes['holdout:01']).toBe('pass');
    expect(probeOnlyPasses.outcomes['holdout:02']).toBe('pass');
  });
});
