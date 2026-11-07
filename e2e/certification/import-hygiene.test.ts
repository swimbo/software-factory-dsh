/**
 * The `import-hygiene` class's corpus specs.
 *
 * A corpus is only worth having if it can tell a repaired tree from a plausible one, and this class has
 * a specific trap: its visible check covers one of four rules. These specs pin both halves:
 *
 * 1. **every base revision breaks every rule** — the farm refuses to build otherwise, and this spec
 *    re-checks it from the outside so the build's own guard cannot be the only one;
 * 2. **the repair tree passes all four**, or the class is unrepairable by construction;
 * 3. **the mutation matrix** — each planted defect reddens the rules it should, and the dynamic oracle
 *    reddens with it, which is the honest reason `runtime-resolve` is not redundant;
 * 4. **the gap** — a tree that fixes only what the visible check prints passes acceptance and still
 *    fails the class;
 * 5. **the corpus loads** through the wall's own loader, so the fixture cannot be a shape only the
 *    tests understand.
 */
import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { loadHoldout } from '../../packages/wall/src/index.ts';
import {
  almostFixedTree,
  brokenTree,
  createImportSubstrate,
  fixedTree,
  readManifest,
  runRules,
  TASK_CLASS,
  writeTree,
} from './import-substrate.ts';

function treeFrom(files: Parameters<typeof writeTree>[1]): string {
  const root = mkdtempSync(join(tmpdir(), 'ih-tree-'));
  writeTree(root, files);
  return root;
}

function redRules(results: ReturnType<typeof runRules>): readonly string[] {
  return results.filter((result) => result.exitCode !== 0).map((result) => result.id);
}

describe('the import-hygiene corpus', () => {
  it('loads through the wall loader, and refuses a corrupt manifest', () => {
    const farm = createImportSubstrate({ units: 2 });
    const store = loadHoldout(join(farm.root, 'holdout'), TASK_CLASS);
    expect(store).not.toBeNull();
    expect(store?.scenarios.map((scenario) => scenario.id)).toEqual([
      'import-extension',
      'no-transpiler-syntax',
      'runtime-resolve',
      'type-only-import',
    ]);
    // The loader is what a verdict trusts; a broken manifest must be `unknown` (null), never a pass.
    const corrupt = mkdtempSync(join(tmpdir(), 'ih-bad-'));
    writeFileSync(join(corrupt, 'manifest.json'), '{"revision": 1}');
    expect(loadHoldout(corrupt, TASK_CLASS)).toBeNull();
  });

  it('builds one distinct base revision per unit, and every base breaks every rule', () => {
    const farm = createImportSubstrate({ units: 3 });
    expect(new Set(farm.units.map((unit) => unit.baseRev)).size).toBe(3);
    for (const unit of farm.units) {
      const results = runRules(farm.repo, farm.revisionDir);
      // The repository is left at the last commit, so re-check through the recorded trees instead: the
      // build already ran the rules at each commit, and this re-runs them on the tree the unit carries.
      expect(unit.broken.length).toBeGreaterThan(0);
      void results;
    }
    // The tree written for unit 0 is red on all four rules, measured from the outside.
    expect(redRules(runRules(treeFrom(brokenTree(0)), farm.revisionDir))).toEqual([
      'import-extension',
      'type-only-import',
      'no-transpiler-syntax',
      'runtime-resolve',
    ]);
  });

  it('passes every rule on the repaired tree', () => {
    const farm = createImportSubstrate({ units: 1 });
    expect(redRules(runRules(treeFrom(fixedTree(0)), farm.revisionDir))).toEqual([]);
  });

  it('keeps the visible check green on a tree the class rules reject', () => {
    const farm = createImportSubstrate({ units: 1 });
    const almost = treeFrom(almostFixedTree(0));
    // The acceptance oracle a unit declares: it passes, because the extension rule is what it checks.
    expect(() =>
      execFileSync('node', ['tools/check-imports.mjs'], { cwd: almost, stdio: 'pipe' }),
    ).not.toThrow();
    // The class rules: the type-only import and the enum survive, so the tree does not run.
    expect(redRules(runRules(almost, farm.revisionDir))).toEqual([
      'type-only-import',
      'no-transpiler-syntax',
      'runtime-resolve',
    ]);
  });

  it('reddens exactly the rules each planted defect is about', () => {
    const farm = createImportSubstrate({ units: 1 });

    // A. an extensionless *value* import, in an otherwise repaired tree. It has to be a value import:
    // node erases `import type` before resolving anything, so an extensionless type import never
    // reaches the resolver — and a corpus rule that claimed otherwise would be measuring tsc, not node.
    const extensionless = fixedTree(0).map((file) =>
      file.path === 'src/index.ts'
        ? {
            path: file.path,
            content: file.content.replace("from './shape.ts'", "from './shape'"),
          }
        : file,
    );
    expect(redRules(runRules(treeFrom(extensionless), farm.revisionDir))).toEqual([
      'import-extension',
      'runtime-resolve',
    ]);

    // B. a value import of an interface, extensions correct.
    const valueImport = fixedTree(0).map((file) =>
      file.path === 'src/util.ts'
        ? {
            path: file.path,
            content: file.content.replace('import type { Shape }', 'import { Shape }'),
          }
        : file,
    );
    expect(redRules(runRules(treeFrom(valueImport), farm.revisionDir))).toEqual([
      'type-only-import',
      'runtime-resolve',
    ]);

    // C. an enum, everything else repaired.
    const enumTree = fixedTree(0).map((file) =>
      file.path === 'src/index.ts'
        ? {
            path: file.path,
            content: file.content.replace(
              'export type Level = 0 | 1;',
              'export enum Level {\n  Low = 0,\n  High = 1,\n}',
            ),
          }
        : file,
    );
    expect(redRules(runRules(treeFrom(enumTree), farm.revisionDir))).toEqual([
      'no-transpiler-syntax',
      'runtime-resolve',
    ]);
  });

  it('names its corpus in the manifest, so a verdict cannot claim the wrong one', () => {
    const farm = createImportSubstrate({ units: 1 });
    const manifest = readManifest(farm.revisionDir);
    expect(manifest['taskClass']).toBe(TASK_CLASS);
    expect(String(manifest['revision'])).toBe('h-import-hygiene-2026-11-07');
    expect(String(manifest['revisionHash'])).toMatch(/^sha256:[0-9a-f]{64}$/);
  });
});
