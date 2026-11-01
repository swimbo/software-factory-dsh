/**
 * Test helpers. Not a test file (no `.test.ts` suffix), so vitest never runs it.
 *
 * Everything here is offline by construction: no network, no model call, no
 * `dsh` binary. The only real processes are `git` against a temporary directory.
 */

import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { attemptRecordDir, DSH_PROFILE } from '../src/executor.ts';

/** A throwaway directory that the OS cleans up. */
export function tempDir(prefix: string): string {
  return mkdtempSync(join(tmpdir(), `factory-${prefix}-`));
}

/** Split a YAML patch list into `id -> block`. */
export function overlayEntries(overlay: string): Map<string, string> {
  const entries = new Map<string, string>();
  let currentId: string | null = null;
  let buffer: string[] = [];
  const flush = (): void => {
    if (currentId !== null) entries.set(currentId, buffer.join('\n'));
    buffer = [];
  };
  for (const line of overlay.split('\n')) {
    const match = /^- id: (.+)$/.exec(line);
    if (match !== null) {
      flush();
      currentId = match[1] ?? '';
      buffer.push(line);
      continue;
    }
    buffer.push(line);
  }
  flush();
  return entries;
}

/** The value of a `key: value` line inside one YAML entry block, unquoted. */
export function entryValue(block: string, key: string): string | null {
  const match = new RegExp(`^\\s*${key}: (.*)$`, 'm').exec(block);
  if (match === null) return null;
  const raw = (match[1] ?? '').trim();
  if (raw.length >= 2 && raw.startsWith("'") && raw.endsWith("'")) {
    return raw.slice(1, -1).replaceAll("''", "'");
  }
  return raw;
}

export const UNIT_ID = 'unit-1';
export const ATTEMPT_ID = 'attempt-1';

export interface FixtureRepo {
  /** The factory root: template home, attempt record and per-attempt homes. */
  factoryHome: string;
  /** The pristine source an attempt clones from. */
  sourceRepo: string;
  /** The clone. This is the sandbox root, the mount target and the dsh cwd. */
  attemptDir: string;
  /** Where the adapter writes everything it knows about the attempt. */
  recordDir: string;
  /** The commit the patch applies to. */
  baseRev: string;
}

function git(args: string[], cwd: string): string {
  const result = spawnSync(
    'git',
    ['-c', 'user.name=fixture', '-c', 'user.email=fixture@example.invalid', ...args],
    { cwd, encoding: 'utf8' },
  );
  if (result.status !== 0) {
    throw new Error(`git ${args.join(' ')} failed: ${result.stderr}`);
  }
  return result.stdout.trim();
}

/**
 * A prepared attempt: a factory root, a provisioned template, a pristine source
 * repo, a self-contained clone, and the task prompt in the attempt record.
 *
 * The clone is made the way `createAttemptClone` makes it, so a test that passes
 * here exercises the layout production gets. The assertions on the clone itself
 * live in `clone.test.ts`.
 */
export function fixtureRepo(options?: { task?: string }): FixtureRepo {
  const factoryHome = tempDir('factory');

  // The provisioned template the per-attempt home is seeded from.
  const template = join(factoryHome, 'dsh-home', 'worker', 'profiles', DSH_PROFILE);
  mkdirSync(template, { recursive: true });
  writeFileSync(join(template, 'cordis.yml'), '[]\n');
  writeFileSync(join(template, 'cordis.patch.yml'), '[]\n');
  writeFileSync(
    join(template, 'package.json'),
    `${JSON.stringify(
      {
        name: `dsh-profile-${DSH_PROFILE}`,
        private: true,
        dependencies: {},
        dsh: { profile: { bundles: ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-headless'] } },
      },
      null,
      2,
    )}\n`,
  );

  // The pristine source a real attempt clones from its bare mirror.
  const sourceRepo = join(factoryHome, 'repos', 'source');
  mkdirSync(sourceRepo, { recursive: true });
  git(['init', '-q', '.'], sourceRepo);
  writeFileSync(join(sourceRepo, 'README.md'), 'fixture baseline\n');
  writeFileSync(join(sourceRepo, '.gitignore'), 'ignored.txt\n');
  git(['add', 'README.md', '.gitignore'], sourceRepo);
  git(['commit', '-q', '-m', 'baseline'], sourceRepo);
  const baseRev = git(['rev-parse', 'HEAD'], sourceRepo);

  const recordDir = attemptRecordDir(factoryHome, UNIT_ID, ATTEMPT_ID);
  const attemptDir = join(recordDir, 'checkout');
  mkdirSync(recordDir, { recursive: true });
  git(
    ['clone', '--no-hardlinks', '--no-checkout', '--quiet', sourceRepo, attemptDir],
    process.cwd(),
  );
  git(['checkout', '--detach', '--quiet', baseRev], attemptDir);

  writeFileSync(join(recordDir, 'task.md'), options?.task ?? 'Implement the unit.\n');

  return { factoryHome, sourceRepo, attemptDir, recordDir, baseRev };
}

/** The fixtures directory, resolved from this file so cwd never matters. */
export function fixturePath(name: string): string {
  return join(import.meta.dirname, 'fixtures', name);
}

/** True when a pid is gone (or was never ours). */
export function isDead(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return false;
  } catch (cause) {
    return (cause as NodeJS.ErrnoException).code === 'ESRCH';
  }
}

/** Poll `check` until it holds or `timeoutMs` elapses. */
export async function eventually(
  check: () => boolean,
  timeoutMs = 5000,
  stepMs = 25,
): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (check()) return true;
    await new Promise((resolve) => setTimeout(resolve, stepMs));
  }
  return check();
}

/** True when the Docker CLI answers; used to skip the `@docker` tests, not to fail them. */
export function dockerAvailable(): boolean {
  const result = spawnSync('docker', ['info'], { encoding: 'utf8' });
  return result.status === 0;
}
