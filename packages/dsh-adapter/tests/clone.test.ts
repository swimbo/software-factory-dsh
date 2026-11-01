/**
 * The attempt checkout must be a clone, not a `git worktree`.
 *
 * Amendment A3.2. The test that matters here is the last one in the first block:
 * the source can be deleted and the attempt still works. That is exactly what a
 * linked worktree cannot do, so it is the assertion that distinguishes the two
 * implementations rather than a cosmetic detail.
 */

import { spawnSync } from 'node:child_process';
import {
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';

import { FactoryError } from '@factory/contracts';
import { describe, expect, it } from 'vitest';

import { assertSelfContainedClone, createAttemptClone } from '../src/clone.ts';
import { tempDir } from './helpers.ts';

function git(args: string[], cwd: string): string {
  const result = spawnSync(
    'git',
    ['-c', 'user.name=fixture', '-c', 'user.email=fixture@example.invalid', ...args],
    { cwd, encoding: 'utf8' },
  );
  if (result.status !== 0) throw new Error(`git ${args.join(' ')}: ${result.stderr}`);
  return result.stdout.trim();
}

/** A source repository with one commit, plus the commit id. */
function sourceRepo(): { dir: string; baseRev: string } {
  const dir = join(tempDir('clone-src'), 'source');
  mkdirSync(dir, { recursive: true });
  git(['init', '-q', '.'], dir);
  writeFileSync(join(dir, 'a.txt'), 'baseline\n');
  git(['add', 'a.txt'], dir);
  git(['commit', '-q', '-m', 'baseline'], dir);
  return { dir, baseRev: git(['rev-parse', 'HEAD'], dir) };
}

async function rejection(promise: Promise<unknown>): Promise<FactoryError> {
  try {
    await promise;
  } catch (cause) {
    if (cause instanceof FactoryError) return cause;
    throw cause;
  }
  throw new Error('expected a FactoryError');
}

describe('createAttemptClone', () => {
  it('makes .git a directory, which is the only shape a single mount can use', async () => {
    const source = sourceRepo();
    const target = join(tempDir('clone-dst'), 'attempt');

    const clone = await createAttemptClone({
      pristineRepo: source.dir,
      baseRev: source.baseRev,
      attemptDir: target,
    });

    expect(clone.baseRev).toBe(source.baseRev);
    // The A3.2 fact: a linked worktree writes `.git` as a *file* holding an
    // absolute host path, and git inside the container then resolves nothing.
    expect(lstatSync(join(target, '.git')).isDirectory()).toBe(true);
    expect(lstatSync(join(target, '.git')).isFile()).toBe(false);
    expect(existsSync(join(target, '.git', 'HEAD'))).toBe(true);
    expect(readFileSync(join(target, 'a.txt'), 'utf8')).toBe('baseline\n');
  });

  it('checks the base revision out detached, so the attempt owns no branch', async () => {
    const source = sourceRepo();
    const target = join(tempDir('clone-dst'), 'attempt');
    await createAttemptClone({
      pristineRepo: source.dir,
      baseRev: source.baseRev,
      attemptDir: target,
    });

    expect(git(['rev-parse', 'HEAD'], target)).toBe(source.baseRev);
    expect(git(['rev-parse', '--abbrev-ref', 'HEAD'], target)).toBe('HEAD');
  });

  it('stays usable after the source is gone', async () => {
    const source = sourceRepo();
    const target = join(tempDir('clone-dst'), 'attempt');
    await createAttemptClone({
      pristineRepo: source.dir,
      baseRev: source.baseRev,
      attemptDir: target,
    });

    rmSync(source.dir, { recursive: true, force: true });

    // Every one of these is a command the receipt capture runs.
    expect(git(['rev-parse', 'HEAD'], target)).toBe(source.baseRev);
    expect(git(['status', '--porcelain'], target)).toBe('');
    writeFileSync(join(target, 'b.txt'), 'new\n');
    expect(git(['status', '--porcelain'], target)).toContain('b.txt');
    expect(git(['log', '--oneline'], target)).toContain('baseline');
  });

  it('does not hardlink objects into the mirror', async () => {
    // `--shared`/hardlinks would put the worker's object store in the mirror's
    // inodes, reintroducing the shared writable object store the clone exists to
    // remove. The commit object must therefore be two independent files.
    const source = sourceRepo();
    const target = join(tempDir('clone-dst'), 'attempt');
    await createAttemptClone({
      pristineRepo: source.dir,
      baseRev: source.baseRev,
      attemptDir: target,
    });

    const objectPath = (dir: string): string =>
      join(dir, '.git', 'objects', source.baseRev.slice(0, 2), source.baseRev.slice(2));
    expect(existsSync(objectPath(source.dir))).toBe(true);
    expect(existsSync(objectPath(target))).toBe(true);
    // nlink 2 is what a hardlink looks like; a copy has one name.
    expect(statSync(objectPath(target)).nlink).toBe(1);
    expect(statSync(objectPath(target)).ino).not.toBe(statSync(objectPath(source.dir)).ino);
  });

  it('refuses to clone into a directory that already has content', async () => {
    const source = sourceRepo();
    const target = tempDir('clone-dst');
    writeFileSync(join(target, 'stale.txt'), 'a previous attempt\n');

    const error = await rejection(
      createAttemptClone({ pristineRepo: source.dir, baseRev: source.baseRev, attemptDir: target }),
    );
    // Two attempts sharing a path is the same class of bug as two attempts
    // sharing a DSH_HOME, so it fails instead of merging.
    expect(error.message).toMatch(/not empty/);
  });

  it('refuses a short sha as a base revision', async () => {
    const source = sourceRepo();
    const target = join(tempDir('clone-dst'), 'attempt');
    const error = await rejection(
      createAttemptClone({
        pristineRepo: source.dir,
        baseRev: source.baseRev.slice(0, 7),
        attemptDir: target,
      }),
    );
    expect(error.message).toMatch(/not a full sha/);
  });

  it('refuses a revision the source does not have', async () => {
    const source = sourceRepo();
    const target = join(tempDir('clone-dst'), 'attempt');
    const error = await rejection(
      createAttemptClone({
        pristineRepo: source.dir,
        baseRev: '0'.repeat(40),
        attemptDir: target,
      }),
    );
    expect(error.code).toBe('EXECUTOR_UNAVAILABLE');
    expect(error.message).toMatch(/cannot check out/);
  });
});

describe('assertSelfContainedClone', () => {
  it('accepts a real clone', async () => {
    const source = sourceRepo();
    const target = join(tempDir('clone-dst'), 'attempt');
    await createAttemptClone({
      pristineRepo: source.dir,
      baseRev: source.baseRev,
      attemptDir: target,
    });
    expect(() => assertSelfContainedClone(target)).not.toThrow();
  });

  it('rejects a linked worktree, and says why', async () => {
    // Reproduced rather than simulated: `git worktree add` is what the earlier
    // plan specified, and this is the artifact it produces.
    const source = sourceRepo();
    const linked = join(tempDir('clone-dst'), 'linked');
    git(['worktree', 'add', '--detach', linked, source.baseRev], source.dir);

    expect(lstatSync(join(linked, '.git')).isFile()).toBe(true);
    expect(() => assertSelfContainedClone(linked)).toThrow(/file, not a directory/);
    // The pointer is absolute and points at the source, which a single mount
    // does not carry — that is the failure, in one line.
    expect(readFileSync(join(linked, '.git'), 'utf8')).toContain('gitdir: ');
  });

  it('rejects a directory with no checkout', () => {
    expect(() => assertSelfContainedClone(tempDir('clone-empty'))).toThrow(/is missing/);
  });
});
