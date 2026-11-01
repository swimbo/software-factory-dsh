/**
 * The store's job is to be *unavailable* rather than wrong.
 *
 * Every test below is a way the holdout store could quietly become a mirror: an
 * empty scenario list (a pass-shaped hole), a revision that does not match its
 * directory, a content hash that does not describe the scenarios present, a
 * duplicate id that makes two scenarios indistinguishable in a verdict, a symlink
 * pointing the store into the repository. The loader's contract is that each of
 * these yields `null`, and `null` means `unknown`, and `unknown` never passes.
 */
import { mkdirSync, mkdtempSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { contentHash, isFactoryError } from '@factory/contracts';
import {
  assertHoldoutOutsideRepo,
  defaultHoldoutRoot,
  hashableScenarios,
  loadHoldout,
  type HoldoutScenario,
  type HoldoutStore,
} from './holdout.ts';
import { writeHoldoutStore, writeRawManifest } from './holdout.test-helpers.ts';

function tempRoot(): string {
  return mkdtempSync(join(tmpdir(), 'wall-holdout-'));
}

function scenario(id: string, extra: { dependsOn?: readonly string[] } = {}): HoldoutScenario {
  const base: HoldoutScenario = {
    id,
    taskClass: 'core',
    argv: ['node', '.holdout/run.js', id],
    expectExit: [0],
  };
  return extra.dependsOn === undefined ? base : { ...base, dependsOn: [...extra.dependsOn] };
}

function store(scenarios: HoldoutScenario[], revision = 'r0001'): HoldoutStore {
  return { revision, taskClass: 'core', scenarios };
}

describe('defaultHoldoutRoot', () => {
  it('points outside every repository, under the operator home', () => {
    expect(defaultHoldoutRoot()).toMatch(/\.factory\/holdout$/);
  });
});

describe('loadHoldout', () => {
  it('round-trips a store it wrote, in id order', () => {
    const root = tempRoot();
    writeHoldoutStore(root, store([scenario('b-second'), scenario('a-first')]));

    const loaded = loadHoldout(root, 'core');
    expect(loaded).not.toBeNull();
    expect(loaded?.revision).toBe('r0001');
    expect(loaded?.taskClass).toBe('core');
    expect(loaded?.scenarios.map((s) => s.id)).toEqual(['a-first', 'b-second']);
  });

  it('uses the default root when none is given', () => {
    // The default root is the real home directory, which this test must not touch:
    // whether it exists or not, the call must not throw and must not invent a store.
    const loaded = loadHoldout(undefined, 'no-such-task-class-7f3a');
    expect(loaded).toBeNull();
  });

  it('returns null when the class is absent', () => {
    expect(loadHoldout(tempRoot(), 'core')).toBeNull();
  });

  it('refuses an empty scenario list, which would be a pass-shaped hole', () => {
    const root = tempRoot();
    writeRawManifest(
      root,
      'core',
      'r0001',
      JSON.stringify({
        revision: 'r0001',
        taskClass: 'core',
        scenarios: [],
        revisionHash: contentHash([]),
      }),
    );
    expect(loadHoldout(root, 'core')).toBeNull();
  });

  it('refuses malformed JSON instead of treating it as no scenarios', () => {
    const root = tempRoot();
    writeRawManifest(root, 'core', 'r0001', '{ not json');
    expect(loadHoldout(root, 'core')).toBeNull();
  });

  it('refuses a revision that does not match its directory', () => {
    const root = tempRoot();
    const scenarios = hashableScenarios([scenario('a-first')]);
    writeRawManifest(
      root,
      'core',
      'r0001',
      JSON.stringify({
        revision: 'r9999',
        taskClass: 'core',
        scenarios,
        revisionHash: contentHash(scenarios),
      }),
    );
    expect(loadHoldout(root, 'core')).toBeNull();
  });

  it('refuses a scenario belonging to another task class', () => {
    const root = tempRoot();
    const scenarios = [
      { id: 'a-first', taskClass: 'other', argv: ['node', 'x.js'], expectExit: [0] },
    ];
    writeRawManifest(
      root,
      'core',
      'r0001',
      JSON.stringify({
        revision: 'r0001',
        taskClass: 'core',
        scenarios,
        revisionHash: contentHash(scenarios),
      }),
    );
    expect(loadHoldout(root, 'core')).toBeNull();
  });

  it('refuses a content hash that does not describe the scenarios present (tampering)', () => {
    const root = tempRoot();
    const honest = hashableScenarios([scenario('a-first')]);
    const edited = hashableScenarios([scenario('a-first'), scenario('b-injected')]);
    writeRawManifest(
      root,
      'core',
      'r0001',
      // A scenario added without rehashing: the store cannot be trusted at all.
      JSON.stringify({
        revision: 'r0001',
        taskClass: 'core',
        scenarios: edited,
        revisionHash: contentHash(honest),
      }),
    );
    expect(loadHoldout(root, 'core')).toBeNull();
  });

  it('refuses duplicate ids, which a verdict could not tell apart', () => {
    const root = tempRoot();
    const scenarios = [scenario('a-first'), scenario('a-first')];
    writeRawManifest(
      root,
      'core',
      'r0001',
      JSON.stringify({
        revision: 'r0001',
        taskClass: 'core',
        scenarios,
        revisionHash: contentHash(hashableScenarios(scenarios)),
      }),
    );
    expect(loadHoldout(root, 'core')).toBeNull();
  });

  it('refuses a scenario that runs nothing, or accepts every exit code', () => {
    const root = tempRoot();
    const noArgv = [{ id: 'a', taskClass: 'core', argv: [], expectExit: [0] }];
    writeRawManifest(
      root,
      'core',
      'r0001',
      JSON.stringify({
        revision: 'r0001',
        taskClass: 'core',
        scenarios: noArgv,
        revisionHash: contentHash(hashableScenarios(noArgv)),
      }),
    );
    expect(loadHoldout(root, 'core')).toBeNull();

    const root2 = tempRoot();
    const noExit = [{ id: 'a', taskClass: 'core', argv: ['node', 'x.js'], expectExit: [] }];
    writeRawManifest(
      root2,
      'core',
      'r0001',
      JSON.stringify({
        revision: 'r0001',
        taskClass: 'core',
        scenarios: noExit,
        revisionHash: contentHash(hashableScenarios(noExit)),
      }),
    );
    expect(loadHoldout(root2, 'core')).toBeNull();
  });

  it('refuses a task class that could escape the store directory', () => {
    const root = tempRoot();
    writeHoldoutStore(root, store([scenario('a-first')]));
    expect(loadHoldout(root, '../core')).toBeNull();
    expect(loadHoldout(root, 'core/../core')).toBeNull();
    expect(loadHoldout(root, '')).toBeNull();
  });

  it('takes the greatest revision, and does not fall back to an older one when the newest is broken', () => {
    const root = tempRoot();
    writeHoldoutStore(root, store([scenario('a-first')], 'r0001'));
    writeHoldoutStore(root, store([scenario('a-first'), scenario('b-new')], 'r0002'));
    expect(loadHoldout(root, 'core')?.revision).toBe('r0002');
    expect(loadHoldout(root, 'core')?.scenarios).toHaveLength(2);

    // Corrupt the newest: the wall must refuse to run rather than verify the
    // candidate against scenarios the operator has already replaced.
    writeRawManifest(root, 'core', 'r0002', '{ broken');
    expect(loadHoldout(root, 'core')).toBeNull();
  });

  it('ignores a symlinked revision directory, which is how a store could be pointed into the repo', () => {
    const root = tempRoot();
    const real = tempRoot();
    writeHoldoutStore(real, store([scenario('a-first')], 'r0001'));
    // A real revision, plus a symlink that would sort higher and point elsewhere.
    writeHoldoutStore(root, store([scenario('a-first')], 'r0001'));
    mkdirSync(join(root, 'core'), { recursive: true });
    symlinkSync(join(real, 'core', 'r0001'), join(root, 'core', 'z0009'));

    const loaded = loadHoldout(root, 'core');
    expect(loaded?.revision).toBe('r0001');
  });

  it('hashes the scenario set, not the file ordering', () => {
    const forward = [scenario('a-first'), scenario('b-second')];
    const backward = [scenario('b-second'), scenario('a-first')];
    expect(contentHash(hashableScenarios(forward))).toBe(contentHash(hashableScenarios(backward)));
  });
});

describe('assertHoldoutOutsideRepo', () => {
  it('throws when the store would live inside the repository', () => {
    const repo = tempRoot();
    expect(() => assertHoldoutOutsideRepo(join(repo, '.factory', 'holdout'), repo)).toThrow(
      /outside the repository/,
    );
  });

  it('throws when the root is the repository itself', () => {
    const repo = tempRoot();
    expect(() => assertHoldoutOutsideRepo(repo, repo)).toThrow(/outside the repository/);
  });

  it('throws a classified error, so the CLI can exit 4 rather than 1', () => {
    const repo = tempRoot();
    try {
      assertHoldoutOutsideRepo(join(repo, 'holdout'), repo);
      expect.unreachable('should have thrown');
    } catch (error) {
      expect(isFactoryError(error)).toBe(true);
      if (isFactoryError(error)) {
        expect(error.code).toBe('WALL_UNAVAILABLE');
        expect(error.exitCode).toBe(4);
      }
    }
  });

  it('accepts a store that is genuinely outside the repository', () => {
    const repo = tempRoot();
    const root = tempRoot();
    expect(() => assertHoldoutOutsideRepo(root, repo)).not.toThrow();
  });

  it('accepts a sibling directory whose name merely starts with the repo name', () => {
    const parent = tempRoot();
    const repo = join(parent, 'repo');
    const root = join(parent, 'repo-holdout');
    mkdirSync(repo, { recursive: true });
    mkdirSync(root, { recursive: true });
    expect(() => assertHoldoutOutsideRepo(root, repo)).not.toThrow();
  });
});
