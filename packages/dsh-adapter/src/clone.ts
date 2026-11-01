/**
 * The attempt checkout: a self-contained clone, at a stable absolute path.
 *
 * Amendment A3.2 in `consensus-plan.md` replaced `git worktree add` with a clone,
 * and the reason is mechanical rather than stylistic: **a linked worktree's
 * `.git` is a file**, containing an absolute host path
 * (`gitdir: /path/to/repo.git/worktrees/attempt-17`). The worker container gets
 * exactly one bind mount — the attempt directory — so inside the container that
 * path resolves to nothing and every `git` command in the attempt fails. A clone
 * has a real `.git` **directory** inside the mount, so it works in both worlds.
 *
 * The *identical absolute path* requirement is not cosmetic either. DSH keys its
 * session log by the process working directory
 * (`$DSH_HOME/sessions/<cwd-slug>/<sessionId>/session.v4.jsonl.zstd` — verified),
 * and `--session-id` adoption refuses when the cwd differs. If the host says
 * `/Users/bo/.factory/attempts/u1/a1` and the container says `/work`, the session
 * cannot be adopted after a control-plane restart, which is the whole
 * reconciliation story.
 *
 * `--no-hardlinks` is deliberate too: a hardlinked clone shares inodes with the
 * pristine mirror, so a worker writing to its object store would write to the
 * mirror's, reintroducing a shared writable object store.
 */

import { execFile } from 'node:child_process';
import { existsSync, lstatSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

import { FactoryError } from '@factory/contracts';

/** A base revision is always a full 40-hex object name; a short sha is not a base. */
const FULL_SHA = /^[0-9a-f]{40}$/;

export interface CloneOptions {
  /** The bare mirror every attempt clones from. Never the operator's working tree. */
  pristineRepo: string;
  /** The commit the patch will apply to. */
  baseRev: string;
  /** Where the clone lands; becomes the sandbox root and the container mount. */
  attemptDir: string;
}

interface GitResult {
  code: number;
  stdout: string;
  stderr: string;
}

function git(args: string[], cwd: string): Promise<GitResult> {
  return new Promise((resolve, reject) => {
    execFile('git', args, { cwd, maxBuffer: 32 * 1024 * 1024 }, (error, stdout, stderr) => {
      if (error !== null && !('code' in error)) {
        reject(error);
        return;
      }
      const code = error === null ? 0 : ((error as { code?: number }).code ?? 1);
      resolve({ code, stdout: String(stdout), stderr: String(stderr) });
    });
  });
}

/**
 * Assert `attemptDir` is a checkout git can use from a single mount.
 *
 * The `.git`-as-directory check is the whole point of A3.2, so it is an explicit
 * assertion rather than an assumption: a directory `git checkout` in the factory
 * repo (or a hand-made `git worktree`) would produce a `.git` file and the
 * failure would only appear inside the container, as an unexplained git error.
 */
export function assertSelfContainedClone(attemptDir: string): void {
  const dotGit = join(attemptDir, '.git');
  if (!existsSync(dotGit)) {
    throw new FactoryError('EXECUTOR_UNAVAILABLE', `not a checkout: ${dotGit} is missing`, {
      attemptDir,
    });
  }
  if (lstatSync(dotGit).isFile()) {
    throw new FactoryError(
      'EXECUTOR_UNAVAILABLE',
      `linked worktree or submodule: ${dotGit} is a file, not a directory; ` +
        'a single-mount container cannot resolve its gitdir',
      { attemptDir },
    );
  }
  if (!lstatSync(dotGit).isDirectory()) {
    throw new FactoryError('EXECUTOR_UNAVAILABLE', `${dotGit} is neither a file nor a directory`, {
      attemptDir,
    });
  }
}

/**
 * Clone the base revision into `attemptDir` as a self-contained checkout.
 *
 * Refuses to clone into a non-empty directory: an attempt directory is created
 * once per attempt, and a stale one means two attempts are sharing a path — which
 * is the same class of bug as two attempts sharing a `DSH_HOME`.
 */
export async function createAttemptClone(options: CloneOptions): Promise<{
  attemptDir: string;
  baseRev: string;
}> {
  const { pristineRepo, baseRev, attemptDir } = options;
  if (!FULL_SHA.test(baseRev)) {
    throw new FactoryError('EXECUTOR_UNAVAILABLE', `base revision is not a full sha: ${baseRev}`, {
      baseRev,
    });
  }
  if (existsSync(attemptDir) && readdirSync(attemptDir).length > 0) {
    throw new FactoryError(
      'EXECUTOR_UNAVAILABLE',
      `attempt directory is not empty: ${attemptDir}`,
      {
        attemptDir,
      },
    );
  }

  const clone = await git(
    ['clone', '--no-hardlinks', '--no-checkout', '--quiet', pristineRepo, attemptDir],
    process.cwd(),
  );
  if (clone.code !== 0) {
    throw new FactoryError('EXECUTOR_UNAVAILABLE', `git clone failed: ${clone.stderr.trim()}`, {
      pristineRepo,
      attemptDir,
    });
  }

  const checkout = await git(['checkout', '--detach', '--quiet', baseRev], attemptDir);
  if (checkout.code !== 0) {
    throw new FactoryError(
      'EXECUTOR_UNAVAILABLE',
      `cannot check out ${baseRev}: ${checkout.stderr.trim()}`,
      { attemptDir, baseRev },
    );
  }

  assertSelfContainedClone(attemptDir);

  const head = await git(['rev-parse', 'HEAD'], attemptDir);
  const resolved = head.stdout.trim();
  if (head.code !== 0 || resolved !== baseRev) {
    throw new FactoryError(
      'EXECUTOR_UNAVAILABLE',
      `clone HEAD is ${resolved || '(unreadable)'}, expected ${baseRev}`,
      { attemptDir, baseRev },
    );
  }
  return { attemptDir, baseRev: resolved };
}
