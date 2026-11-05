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
      // The probe has to say something the fixture does not: at least two assertions, all against
      // inputs the visible cases never show.
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
