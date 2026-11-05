/**
 * The fixture, checked before anything is measured against it.
 *
 * A task-class certificate is only as good as the corpus, and the corpus is only as good as the base
 * revisions it was cut from. Each of the twenty has to be a *failing* test with a defect behind it:
 * if a base revision's visible test passed, the class rule that requires the suite to pass would pass
 * on the base too, the rule would stop discriminating, and the wall would read every attempt as
 * `unknown`. That is not a hypothetical — `maxNonDiscriminating` defaults to zero and a corpus with a
 * non-discriminating scenario cannot produce a verdict, so this spec is the fixture's own gate.
 *
 * Every check here runs the real thing in a throwaway tree: the generated test file, the fixture
 * file, `node --test`. Nothing asserts on a reimplementation of the test.
 */
import { beforeAll, describe, expect, it } from 'vitest';

import {
  FIXTURES_ROOT,
  TESTS_ROOT,
  assertRevisionDiscriminates,
  buggySource,
  checkRevision,
  fixtureJson,
  fixturePath,
  modulePath,
  testPath,
  visibleTestSource,
  type RevisionCheck,
} from './test-repair.ts';
import { TEST_REPAIR_REVISIONS } from './test-repair-revisions.ts';

let checks: readonly RevisionCheck[];

beforeAll(() => {
  // Six real subprocesses per revision (base and repair, for each of the visible test, the hidden
  // probe and the differential rule). Twenty revisions is ~5 s; the timeout is the measured cost
  // with room for a slow machine.
  checks = TEST_REPAIR_REVISIONS.map((revision) => checkRevision(revision));
}, 180_000);

describe('the test-repair fixture', () => {
  it('is twenty revisions of twenty different modules, each with a test and its expectation data', () => {
    expect(TEST_REPAIR_REVISIONS).toHaveLength(20);
    expect(new Set(TEST_REPAIR_REVISIONS.map((revision) => revision.id)).size).toBe(20);
    expect(new Set(TEST_REPAIR_REVISIONS.map((revision) => revision.fn)).size).toBe(20);

    for (const revision of TEST_REPAIR_REVISIONS) {
      expect(modulePath(revision), revision.id).toMatch(/^src\/[a-z]+\.js$/u);
      expect(testPath(revision), revision.id).toMatch(
        new RegExp(`^${TESTS_ROOT}/[a-z]+\\.test\\.js$`, 'u'),
      );
      expect(fixturePath(revision), revision.id).toMatch(
        new RegExp(`^${FIXTURES_ROOT}/[a-z]+\\.json$`, 'u'),
      );
      // More than one visible case, or the immutability mutation ("fix it and delete the awkward
      // case") has nothing to delete — except where the module's API legitimately has one shape.
      expect(revision.visible.length, revision.id).toBeGreaterThan(0);
      expect(revision.visible[0]?.args.length, revision.id).toBe(revision.params.length);
      // At least two assertions, on inputs of the probe's own: the visible fixture is the contract,
      // the probe is a second sample of it, so a repair keyed to the visible inputs falls through.
      expect(revision.hidden, revision.id).toContain('process.argv[2]');
      // The module under test arrives on argv, not in the environment: a probe a caller can
      // reconfigure measures the caller's choice, and the lint forbids the read.
      expect(revision.hidden, revision.id).not.toContain('process.env.');
      expect(
        revision.hidden.match(/^assert\./gmu)?.length ?? 0,
        revision.id,
      ).toBeGreaterThanOrEqual(2);
    }
  });

  it('is one literal defect away from its repair, and the defect is not a constant bump', () => {
    for (const revision of TEST_REPAIR_REVISIONS) {
      expect(revision.bug.length, revision.id).toBeGreaterThan(0);
      for (const bug of revision.bug) {
        // Exactly one occurrence: `buggySource` refuses anything else, and this is the assertion
        // that says so before the refusal is needed.
        expect(revision.fixed.split(bug.find).length, `${revision.id}: ${bug.find}`).toBe(2);
      }
      const base = buggySource(revision);
      expect(base, revision.id).not.toBe(revision.fixed);
      // A repair is a real change: not a whitespace edit, not a reordered expression.
      expect(base.replaceAll(' ', ''), revision.id).not.toBe(revision.fixed.replaceAll(' ', ''));
    }
  });

  it('holds fixtures whose data is what the test reads', () => {
    for (const revision of TEST_REPAIR_REVISIONS) {
      const parsed = JSON.parse(fixtureJson(revision)) as readonly {
        args: unknown[];
        expected: unknown;
      }[];
      expect(parsed, revision.id).toEqual(
        revision.visible.map((entry) => ({ args: entry.args, expected: entry.expected })),
      );
      const source = visibleTestSource(revision);
      expect(source, revision.id).toContain(`from '../${modulePath(revision)}'`);
      expect(source, revision.id).toContain(
        `new URL('../${fixturePath(revision)}', import.meta.url)`,
      );
      expect(source, revision.id).toContain(revision.fn);
    }
  });

  it('fails the visible test on every base revision', () => {
    expect(checks.filter((check) => !check.baseFailsVisible).map((check) => check.id)).toEqual([]);
  });

  it('passes the visible test on every repair', () => {
    expect(checks.filter((check) => !check.repairPassesVisible).map((check) => check.id)).toEqual(
      [],
    );
  });

  it('has a differential rule that discriminates on seeded inputs and says how many it compared', () => {
    // Both halves matter for the same reason the probe's do: a rule that passes on the defect is
    // not discriminating, and one that fails on the repair would refuse the honest answer.
    expect(
      checks.filter((check) => !check.differentialFailsOnBase).map((check) => check.id),
    ).toEqual([]);
    expect(
      checks.filter((check) => !check.differentialPassesOnRepair).map((check) => check.id),
    ).toEqual([]);
    // The rule compared exactly the points the domain declares: the count it prints is not a
    // side-channel, it is the corpus's own arithmetic. 44–52 points per revision, and the samples
    // (the seeded half) are at least thirty of them.
    for (const revision of TEST_REPAIR_REVISIONS) {
      const check = checks.find((entry) => entry.id === revision.id);
      const declared = revision.differential.edges.length + revision.differential.samples;
      expect(revision.differential.samples, revision.id).toBeGreaterThanOrEqual(30);
      expect(check?.differentialPoints, revision.id).toBe(declared);
    }
    const points = checks.map((check) => check.differentialPoints);
    expect(Math.min(...points)).toBeGreaterThanOrEqual(40);
  });

  it('makes every input the corpus compares on visible, so a refusal is readable before it costs', () => {
    // The visible suite is the whole contract the worker can see before a paid attempt. The corpus
    // refuses a repair for disagreeing with the reference on an input, so every *declared* input has
    // to be asserted by a visible case: otherwise the refusal measures the author's taste. This is
    // the check that would have caught the `paths` defect at build time instead of twice at 3.5
    // minutes a run: the reference drops a leading `..`, the visible cases showed none, and the
    // candidate that kept it (POSIX `path.normalize`) was refused for a convention nothing on disk
    // stated.
    expect(
      checks.filter((check) => check.undiscoverableEdges.length > 0).map((check) => check.id),
    ).toEqual([]);

    const paths = TEST_REPAIR_REVISIONS.find((revision) => revision.id === 'paths');
    expect(paths).toBeDefined();

    // Mutation: delete the leading-`..` visible case and the build refuses before any paid run,
    // naming the input the corpus still compares on.
    const leading = paths?.visible.findIndex(
      (visibleCase) => JSON.stringify(visibleCase.args) === JSON.stringify(['../x']),
    );
    expect(leading).toBeGreaterThanOrEqual(0);
    const thinned = {
      ...(paths as NonNullable<typeof paths>),
      visible: (paths?.visible ?? []).filter((_, index) => index !== leading),
    };
    expect(checkRevision(thinned).undiscoverableEdges).toContain('["../x"]');
    expect(() => assertRevisionDiscriminates(thinned)).toThrow(/no visible case asserts/u);
  });

  it('refuses the leading-parent convention in the visible suite before a paid run', () => {
    // The repair the corpus refused twice: POSIX semantics, a leading `..` is preserved because the
    // path space has a parent. The reference drops it because this one does not. The point of the
    // visible case is that this disagreement is now free to discover: the worker's own test run goes
    // red instead of a 3.5-minute certification attempt.
    const paths = TEST_REPAIR_REVISIONS.find((revision) => revision.id === 'paths');
    expect(paths).toBeDefined();
    // The bug's find text stays in place, so `buggySource` can still cut the base revision from it;
    // the added `else` is the only difference from the reference.
    const posix = (paths?.fixed ?? '').replace(
      '      if (segments.length > 0) segments.pop();',
      "      if (segments.length > 0) segments.pop();\n      else if (!absolute) segments.push('..');",
    );
    expect(posix).not.toBe(paths?.fixed);
    // The POSIX variant carries its own defect marker, so the base side stays parseable: the two
    // added lines are exactly what a repair that keeps the parent segment writes.
    const check = checkRevision({
      ...(paths as NonNullable<typeof paths>),
      fixed: posix,
      bug: [
        {
          find:
            '      if (segments.length > 0) segments.pop();\n' +
            "      else if (!absolute) segments.push('..');",
          replace: "      /* '..' has nothing to pop here */",
        },
      ],
    });
    // Red in the visible suite: that is the discovery, and it costs nothing.
    expect(check.repairPassesVisible).toBe(false);
    // The hidden probe refuses it too — it asserts the collapse on `../x`, which is why the
    // candidate that kept the parent was refused as `holdout:02`. The change here is that the worker
    // learns it from the test they are allowed to run, before the attempt costs anything.
    expect(check.probePassesOnRepair).toBe(false);
  });

  it('has a hidden probe that discriminates: it fails on every base revision and passes on every repair', () => {
    // Both halves matter. A probe that passes on the defect is not discriminating (the wall turns
    // every attempt `unknown`); a probe that fails on the repair makes the class uncertifiable,
    // because the honest answer would be refused.
    expect(checks.filter((check) => !check.probeFailsOnBase).map((check) => check.id)).toEqual([]);
    expect(checks.filter((check) => !check.probePassesOnRepair).map((check) => check.id)).toEqual(
      [],
    );
  });
});
