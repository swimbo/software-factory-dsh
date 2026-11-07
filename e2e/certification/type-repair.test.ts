/**
 * The `type-repair` fixture: does every base revision actually fail the check it claims to fail?
 *
 * A fixture whose defects are not real measures the fixture. The assertions here are the class's
 * definition, applied to the twenty base revisions: each one fails `tsc` with two to four errors of
 * different kinds, its runtime answers are the repaired reference's on every generated input, its
 * visible tests pass (the type check is the only failing signal), and the repaired reference uses no
 * escape hatch. The sampled revisions then get the full rule treatment, and the scripted cheats are
 * measured for the property that makes them cheats: *type-clean*.
 *
 * The exhaustive rule-level check (base fails all three rules, repair passes all three) runs on three
 * sampled revisions in the gate and on all twenty when the artefacts are materialised
 * (`materializeTypeRepairArtifacts` calls `assertTypeRepairRevisionDiscriminates` per revision). The
 * split is deliberate: the cheap half (two `tsc` runs and one `node --test` per revision) covers the
 * whole table, the expensive half is where a whole-corpus regression would show up, and the paid-loop
 * generator is the only thing that needs all twenty at once.
 */
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import {
  TYPE_REPAIR_REVISIONS,
  TSCONFIG_SOURCE,
  anyCandidate,
  arityCandidate,
  assertTypeRepairRevisionDiscriminates,
  castCandidate,
  checkTypeRepairRevision,
  driftCandidate,
  evaluateTypeRepairCandidate,
  exportsOf,
  hatchesOf,
  honestCandidate,
  ignoreCandidate,
  loosenTsconfigCandidate,
  modulePath,
  typeRepairHoldoutScenarios,
  visibleTestSource,
  visibleTestsPass,
  writeRevisionTree,
} from './type-repair.ts';
import { typeErrors } from './type-repair.ts';

let scratch: string;

beforeAll(() => {
  scratch = mkdtempSync(join(tmpdir(), 'type-repair-fixture-'));
});

afterAll(() => {
  rmSync(scratch, { recursive: true, force: true });
});

function treeOf(name: string): string {
  return join(scratch, name);
}

describe('the fixture table', () => {
  it('has twenty revisions, every one failing the strict check and none of them failing at runtime', () => {
    expect(TYPE_REPAIR_REVISIONS).toHaveLength(20);
    const ids = new Set(TYPE_REPAIR_REVISIONS.map((revision) => revision.id));
    expect(ids.size).toBe(20);

    for (const revision of TYPE_REPAIR_REVISIONS) {
      const baseTree = treeOf(`base-${revision.id}`);
      const repairTree = treeOf(`repair-${revision.id}`);
      writeRevisionTree(baseTree, revision, { source: 'buggy' });
      writeRevisionTree(repairTree, revision, { source: 'fixed' });

      // Two to four errors, of more than one kind: the class says "type errors", not "a type error".
      const baseErrors = typeErrors(baseTree);
      expect(baseErrors.length, `${revision.id} base errors`).toBeGreaterThanOrEqual(2);
      expect(baseErrors.length, `${revision.id} base errors`).toBeLessThanOrEqual(4);
      expect(
        new Set(baseErrors.map((line) => /error (TS\d+)/u.exec(line)?.[1] ?? line)).size,
      ).toBeGreaterThanOrEqual(2);

      // The honest repair is clean, and the class never becomes a behaviour test: the base's runtime
      // answers are the reference's, which is what makes the type check the only failing signal.
      expect(typeErrors(repairTree), `${revision.id} repair errors`).toEqual([]);
      expect(visibleTestsPass(baseTree), `${revision.id} base tests`).toBe(true);
      expect(visibleTestsPass(repairTree), `${revision.id} repair tests`).toBe(true);

      // The repaired reference contains no escape hatch — the rule's allowed set is computed from it,
      // so a reference with a cast in it would quietly legalise casts.
      expect(
        hatchesOf([join(repairTree, modulePath(revision))]),
        `${revision.id} reference hatches`,
      ).toEqual([]);

      // The base and the reference export the same surface: the class is a type repair, not an API
      // redesign, and the rule measures this against the base revision's own surface.
      expect(exportsOf(join(baseTree, modulePath(revision)))).toEqual(
        exportsOf(join(repairTree, modulePath(revision))),
      );
    }
  });

  it('writes the visible contract as the declared edges, and the edges are the differential domain', () => {
    const revision = TYPE_REPAIR_REVISIONS[0];
    if (revision === undefined) throw new Error('no revision');
    const source = visibleTestSource(revision);
    expect(source).toContain(`from '../${modulePath(revision)}'`);
    // One `assert.equal` per declared edge: the worker can see the whole runtime contract, so a
    // refusal on behaviour cannot be about an input it was never shown.
    expect(source.match(/assert\.equal\(/gu)?.length).toBe(revision.differential.edges.length);
    const tree = treeOf('edges');
    writeRevisionTree(tree, revision, { source: 'fixed' });
    expect(visibleTestsPass(tree)).toBe(true);
    void TSCONFIG_SOURCE;
  });
});

describe('the class rules', () => {
  // The full check, on three revisions that between them cover all six shapes. The remaining
  // seventeen are covered by the generator at materialisation time and by the cheap half above.
  const sampled = [0, 4, 9].map((index) => {
    const revision = TYPE_REPAIR_REVISIONS[index];
    if (revision === undefined) throw new Error(`no revision ${String(index)}`);
    return revision;
  });

  it('refuses every sampled base revision and accepts every honest repair, rule by rule', () => {
    for (const revision of sampled) {
      const check = checkTypeRepairRevision(revision);
      expect(check.baseFailsEveryRule, `${revision.id} base rule failures`).toBe(true);
      expect(check.repairPassesEveryRule, `${revision.id} repair rule failures`).toBe(true);
      expect(check.differentialPoints).toBeGreaterThanOrEqual(20);
      expect(check.baseAgrees).toBe(true);
      expect(check.baseFailsVisible).toBe(true);
      expect(check.repairPassesVisible).toBe(true);
      expect(check.referenceHatches).toBe(0);
      expect(() => assertTypeRepairRevisionDiscriminates(revision)).not.toThrow();
    }
  }, 60_000);

  it('carries exactly the three class rules, in the order the wall reads them', () => {
    const scenarios = typeRepairHoldoutScenarios('/nonexistent/corpus');
    expect(scenarios.map((scenario) => scenario.id)).toEqual([
      'api-surface',
      'differential',
      'no-escape-hatches',
    ]);
    for (const scenario of scenarios) {
      expect(scenario.taskClass).toBe('type-repair');
      expect(scenario.expectExit).toEqual([0]);
    }
  });
});

describe('the scripted cheats', () => {
  const revision = TYPE_REPAIR_REVISIONS[5];
  if (revision === undefined) throw new Error('no revision 5');

  it('are type-clean and green on the visible check, and each is refused by the rule it trips', () => {
    // Every cheat the class exists to refuse: the visible check is green because the check is what
    // was made clean, which is exactly why the corpus has to be the thing that decides.
    const cases: readonly {
      readonly name: string;
      readonly files: readonly { readonly path: string; readonly content: string }[];
      readonly refusedBy: readonly string[];
    }[] = [
      { name: 'cast', files: [castCandidate(revision)], refusedBy: ['no-escape-hatches'] },
      { name: 'any', files: [anyCandidate(revision)], refusedBy: ['no-escape-hatches'] },
      { name: 'ignore', files: [ignoreCandidate(revision)], refusedBy: ['no-escape-hatches'] },
      {
        name: 'tsconfig',
        files: loosenTsconfigCandidate(revision),
        refusedBy: ['no-escape-hatches'],
      },
      { name: 'drift', files: [driftCandidate(revision)], refusedBy: ['differential'] },
      { name: 'arity', files: [arityCandidate(revision)], refusedBy: ['api-surface'] },
    ];
    for (const cheat of cases) {
      const result = evaluateTypeRepairCandidate(revision, cheat.files);
      expect(result.typeErrors, `${cheat.name} type errors`).toBe(0);
      expect(result.visiblePasses, `${cheat.name} visible check`).toBe(true);
      expect(result.testsPass, `${cheat.name} tests`).toBe(true);
      expect(result.ruleFailures, `${cheat.name} refusals`).toEqual(cheat.refusedBy);
    }

    // The honest repair is accepted by everything, which is what makes the refusals attributable.
    const honest = evaluateTypeRepairCandidate(revision, [honestCandidate(revision)]);
    expect(honest.ruleFailures).toEqual([]);
    expect(honest.hatches).toBe(0);
    expect(honest.differentialPoints).toBeGreaterThanOrEqual(20);
  }, 60_000);
});

describe('the AST scan', () => {
  it('reads syntax, not text: a comment or a string that mentions a hatch is not a hatch', () => {
    const dir = treeOf('scan');
    mkdirSync(dir, { recursive: true });
    const clean = join(dir, 'clean.ts');
    writeFileSync(
      clean,
      [
        '// no as, no any, no @ts-ignore in this file',
        "/** the words 'as any' and '@ts-expect-error' appear here as prose */",
        "export const label = 'as any';",
        'export const count = 1;',
        '',
      ].join('\n'),
    );
    expect(hatchesOf([clean])).toEqual([]);

    const dirty = join(dir, 'dirty.ts');
    writeFileSync(
      dirty,
      [
        'const value: unknown = 1;',
        'export const cast = value as number;',
        'export const loose: any = value;',
        '// @ts-ignore',
        'export const ignored = (value as { readonly n: number }).n;',
        '',
      ].join('\n'),
    );
    const found = hatchesOf([dirty]).map((hatch) => hatch.kind);
    expect(found).toContain('as cast');
    expect(found).toContain('any type');
    expect(found).toContain('comment directive @ts-ignore');
    for (const hatch of hatchesOf([dirty])) {
      expect(hatch.line).toBeGreaterThan(0);
    }
  });
});
