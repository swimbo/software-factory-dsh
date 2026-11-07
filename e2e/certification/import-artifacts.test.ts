/**
 * The `import-hygiene` artefacts build.
 *
 * The build is what a certification loop runs against, so its refusals matter more than its output: a
 * root inside the checkout would let the worker read the corpus, a foreign directory deleted in the name
 * of "rebuilding" is data loss, and a base revision that passes a rule is a corpus that certifies nothing.
 *
 * The assertions here are about those three refusals plus the two things the loop cannot work without:
 * one distinct base commit per unit, and a bare mirror the wall can clone.
 */
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { UnitSpec } from '../../packages/contracts/src/index.ts';
import { buildImportArtifacts, MARKER } from './import-artifacts.ts';
import { runRules, TASK_CLASS } from './import-substrate.ts';

const SOURCE = join(import.meta.dirname, '..', '..');

function root(): string {
  return join(mkdtempSync(join(tmpdir(), 'ih-artifacts-')), 'root');
}

describe('the import-hygiene artefacts build', () => {
  it('refuses a root inside the checkout, before writing anything', () => {
    const inside = join(SOURCE, 'docs', 'artifacts-should-not-exist');
    expect(() =>
      buildImportArtifacts({
        root: inside,
        revisions: 1,
        source: SOURCE,
        createdAt: '2026-11-07T00:00:00Z',
      }),
    ).toThrow(/inside the checkout/);
    expect(existsSync(inside)).toBe(false);
  });

  it('refuses to delete a directory it did not build', () => {
    const foreign = mkdtempSync(join(tmpdir(), 'ih-foreign-'));
    writeFileSync(join(foreign, 'precious.txt'), 'do not delete\n');
    expect(() =>
      buildImportArtifacts({
        root: foreign,
        revisions: 1,
        source: SOURCE,
        createdAt: '2026-11-07T00:00:00Z',
      }),
    ).toThrow(/refusing to delete/);
    expect(existsSync(join(foreign, 'precious.txt'))).toBe(true);
    rmSync(foreign, { recursive: true, force: true });
  });

  it('builds one distinct base revision per unit, each red on all four rules', () => {
    const target = root();
    const artifacts = buildImportArtifacts({
      root: target,
      revisions: 3,
      source: SOURCE,
      createdAt: '2026-11-07T00:00:00Z',
    });
    expect(new Set(artifacts.baseRevs).size).toBe(3);
    expect(artifacts.specPaths).toHaveLength(3);

    // The mirror is bare, so the wall's clone has no working tree to inherit.
    expect(existsSync(join(artifacts.mirror, 'HEAD'))).toBe(true);
    expect(existsSync(join(artifacts.mirror, '.git'))).toBe(false);

    // The last working tree is a base revision: still red on all four rules.
    expect(
      runRules(artifacts.repo, artifacts.revisionDir)
        .filter((result) => result.exitCode === 0)
        .map((result) => result.id),
    ).toEqual([]);
    // The repair target is kept, and it is green — "fixed" is a fact anyone can re-measure.
    expect(
      runRules(join(target, 'repair'), artifacts.revisionDir)
        .filter((result) => result.exitCode !== 0)
        .map((result) => result.id),
    ).toEqual([]);
    expect(existsSync(join(target, 'restate.md'))).toBe(true);
    expect(existsSync(join(target, 'plan-units.sh'))).toBe(true);
  });

  it('emits specs the store will accept, one per base revision', () => {
    const artifacts = buildImportArtifacts({
      root: root(),
      revisions: 2,
      source: SOURCE,
      createdAt: '2026-11-07T00:00:00Z',
    });
    const specs = artifacts.specPaths.map((path) =>
      UnitSpec.parse(JSON.parse(readFileSync(path, 'utf8'))),
    );
    expect(specs.map((spec) => spec.revision)).toEqual([1, 2]);
    expect(specs.map((spec) => spec.baseRev)).toEqual(artifacts.baseRevs);
    expect(new Set(specs.map((spec) => spec.slug))).toEqual(new Set([TASK_CLASS]));
    // The acceptance oracle is the visible check — a subset of the class rules, on purpose.
    expect(specs[0]?.acceptance[0]?.oracle.target).toBe('node tools/check-imports.mjs');
  });

  it('is rebuildable: a second build replaces its own artefacts and keeps the marker', () => {
    // The build creates its own root: an existing directory without the marker is exactly what the
    // previous spec proves it refuses.
    const target = root();
    const first = buildImportArtifacts({
      root: target,
      revisions: 1,
      source: SOURCE,
      createdAt: '2026-11-07T00:00:00Z',
    });
    expect(existsSync(join(target, MARKER))).toBe(true);
    const second = buildImportArtifacts({
      root: target,
      revisions: 1,
      source: SOURCE,
      createdAt: '2026-11-07T00:01:00Z',
    });
    // A rebuild starts from scratch: the new commit differs because the timestamps do.
    expect(second.baseRevs[0]).not.toBe(first.baseRevs[0]);
  });
});
