/**
 * A real git fixture repository, built once per test file into a temp directory.
 *
 * The e2e suite must never touch the outer repository: a test that runs `git` against the
 * checkout would dirty a teammate's working tree. So every fixture is `git init`ed into
 * `mkdtemp`, given a visible suite that really passes, and committed — `baseRev` is then a
 * genuine 40-hex commit, not a placeholder. No clones, no network.
 *
 * The holdout directory lives *outside* the repository root, which is the property the leak
 * assertions depend on: a path inside the repo would be reachable from every worktree.
 */
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

export interface FixtureRepo {
  /** Temp root holding both the repository and the holdout store. */
  readonly root: string;
  /** The git repository the factory's units point at. */
  readonly repo: string;
  /** The commit every attempt would branch from. */
  readonly baseRev: string;
  /** Holdout scenarios, deliberately outside `repo`. */
  readonly holdout: string;
  cleanup(): void;
}

export function git(cwd: string, args: readonly string[]): string {
  return execFileSync('git', [...args], {
    cwd,
    encoding: 'utf8',
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: 'factory-e2e',
      GIT_AUTHOR_EMAIL: 'e2e@factory.invalid',
      GIT_COMMITTER_NAME: 'factory-e2e',
      GIT_COMMITTER_EMAIL: 'e2e@factory.invalid',
      GIT_CONFIG_NOSYSTEM: '1',
    },
  }).trim();
}

const SLUG_SRC = `/**
 * The fixture's SUT: a slug helper with one visible test per behaviour.
 * Kept small on purpose — the e2e suite asserts process behaviour, not slug logic.
 */
export function slugify(input) {
  return String(input)
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}
`;

const SLUG_TEST = `import assert from 'node:assert/strict';
import { test } from 'node:test';
import { slugify } from '../src/slug.js';

test('lowercases', () => assert.equal(slugify('ABC'), 'abc'));
test('trims', () => assert.equal(slugify('  a  '), 'a'));
test('collapses separators', () => assert.equal(slugify('a  b'), 'a-b'));
test('strips punctuation', () => assert.equal(slugify('a.b!c'), 'a-b-c'));
test('strips edge dashes', () => assert.equal(slugify('--a--'), 'a'));
test('keeps digits', () => assert.equal(slugify('a1'), 'a1'));
`;

const HOLDOUT = {
  revision: 'h-88f1',
  scenarios: ['h-1', 'h-2', 'h-3'].map((id) => ({
    id,
    kind: 'command' as const,
    target: 'node --test tests/',
    expect: 'exit 0',
    text: `holdout scenario ${id}: never leaves this directory`,
  })),
};

/** A passing visible suite plus a commit: `baseRev` is real, and `node --test` exits 0. */
export function createFixtureRepo(): FixtureRepo {
  const root = mkdtempSync(join(tmpdir(), 'factory-e2e-'));
  const repo = join(root, 'repo');
  mkdirSync(join(repo, 'src'), { recursive: true });
  mkdirSync(join(repo, 'tests'), { recursive: true });
  writeFileSync(
    join(repo, 'package.json'),
    `${JSON.stringify({ name: 'fixture', private: true, scripts: { test: 'node --test tests/' } }, null, 2)}\n`,
  );
  writeFileSync(join(repo, 'src', 'slug.js'), SLUG_SRC);
  writeFileSync(join(repo, 'tests', 'slug.test.js'), SLUG_TEST);
  writeFileSync(
    join(repo, 'README.md'),
    '# fixture\n\nA two-line repository used by the e2e suite.\n',
  );

  git(repo, ['init', '-q', '-b', 'main']);
  git(repo, ['add', '-A']);
  git(repo, ['commit', '-q', '-m', 'base: slug helper with a visible suite']);
  const baseRev = git(repo, ['rev-parse', 'HEAD']);

  const holdout = join(root, 'holdout');
  mkdirSync(holdout, { recursive: true });
  writeFileSync(join(holdout, 'scenarios.json'), `${JSON.stringify(HOLDOUT, null, 2)}\n`);

  return {
    root,
    repo,
    baseRev,
    holdout,
    cleanup: () => {
      rmSync(root, { recursive: true, force: true });
    },
  };
}

/** The visible suite really passes on `baseRev`; asserted once per fixture creation. */
export function assertVisibleSuitePasses(repo: string): void {
  execFileSync(process.execPath, ['--test', 'tests/'], { cwd: repo, encoding: 'utf8' });
}
