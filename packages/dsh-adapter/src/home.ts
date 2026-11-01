/**
 * The per-attempt `DSH_HOME` — a volume that outlives the container and never
 * outlives the attempt.
 *
 * Amendment A13 in `consensus-plan.md` resolved a contradiction in the earlier
 * design. Step 3 of the execution plane set `DSH_HOME=~/.factory/dsh-home/worker`
 * "per trust domain" while also allowing "no host mounts except the attempt
 * directory". Both readings failed:
 *
 * - a container-local home dies with the container, taking the **session log**
 *   with it — and the session log is the only source of token usage we have
 *   (the NDJSON projection has no `usage` event), so `collect()` could never
 *   produce the audit comparison;
 * - a bind mount of the parent directory puts `~/.factory/holdout/` one `..`
 *   away from a path the worker can reach.
 *
 * So: one home **per attempt**, seeded read-only from the provisioned template,
 * read out by the adapter after receipt capture, then destroyed.
 *
 * The destruction is not housekeeping. `$DSH_HOME/cordis.patch.yml` is composed
 * into *every* profile (findings D5), so a shared home lets attempt N configure
 * attempt N+1 — a worker could leave a patch entry that changes how the next
 * worker runs. A home that ceases to exist at the end of its attempt closes that
 * channel structurally rather than by convention.
 *
 * Seeding copies **only** `profiles/<profile>`: never the template's home patch
 * layer, never a template's leftover sessions. What the attempt gets is exactly
 * what the provisioner froze, and nothing that any previous run wrote.
 */

import { cpSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync } from 'node:fs';
import { join, relative, sep } from 'node:path';

import { FactoryError } from '@factory/contracts';

/** The trust domain whose provisioned template seeds a worker attempt. */
export const WORKER_DOMAIN = 'worker';

/** Cap the read-out so a runaway session log cannot overflow the receipt. */
const MAX_READOUT_FILES = 64;
const MAX_READOUT_BYTES = 32 * 1024 * 1024;

/** Ids are path segments here, so they must not be able to escape the root. */
const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

function assertSafeId(value: string, what: string): void {
  if (!SAFE_ID.test(value)) {
    throw new FactoryError(
      'INTERNAL',
      `unsafe ${what} for a path segment: ${JSON.stringify(value)}`,
    );
  }
}

/** The provisioned, read-only template a worker attempt is seeded from. */
export function seedTemplateDir(root: string, domain: string, profile: string): string {
  return join(root, 'dsh-home', domain, 'profiles', profile);
}

/** The attempt's own home. Destroyed at the end of the attempt. */
export function attemptHomePath(root: string, attemptId: string): string {
  assertSafeId(attemptId, 'attemptId');
  return join(root, 'dsh-home', 'attempts', attemptId);
}

/**
 * Create the attempt home and copy the frozen profile into it.
 *
 * Returns the home to pass as `DSH_HOME`. The template directory itself is only
 * ever read: a test hashes it before and after to hold that.
 */
export function seedAttemptHome(options: {
  root: string;
  attemptId: string;
  profile: string;
}): string {
  const template = seedTemplateDir(options.root, WORKER_DOMAIN, options.profile);
  if (!statSync(template, { throwIfNoEntry: false })?.isDirectory()) {
    throw new FactoryError(
      'EXECUTOR_UNAVAILABLE',
      `no provisioned ${options.profile} profile at ${template}; run scripts/provision-dsh-home.sh`,
      { template },
    );
  }
  const home = attemptHomePath(options.root, options.attemptId);
  rmSync(home, { recursive: true, force: true });
  mkdirSync(join(home, 'profiles'), { recursive: true });
  // Only the profile: no home patch layer, no inherited sessions, no storages.
  cpSync(template, join(home, 'profiles', options.profile), { recursive: true });
  return home;
}

export interface ReadoutFile {
  /** Where the copy lives, for `ArtifactRecord.path`. */
  path: string;
  bytes: number;
}

function walk(dir: string, out: string[]): void {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) walk(full, out);
    else if (entry.isFile()) out.push(full);
  }
}

/**
 * Copy the attempt's session log and projections out of the home.
 *
 * This is the "read out with `docker exec`/`docker cp`" step of A13, done against
 * the filesystem today and against the volume when the container lands: either
 * way the bytes have to exist outside the home before the home is destroyed.
 * DSH writes `sessions/<cwd-slug>/<sessionId>/session.v4.jsonl.zstd` plus a plain
 * JSON projection under `storages/`; both are captured verbatim, zstd included,
 * because re-encoding someone else's record of the run is how evidence stops
 * being evidence.
 */
export function readOutSession(home: string, destination: string): ReadoutFile[] {
  const out: ReadoutFile[] = [];
  let budget = MAX_READOUT_BYTES;
  for (const subtree of ['sessions', 'storages']) {
    const source = join(home, subtree);
    if (!statSync(source, { throwIfNoEntry: false })?.isDirectory()) continue;
    const files: string[] = [];
    walk(source, files);
    for (const file of files) {
      if (out.length >= MAX_READOUT_FILES || budget <= 0) return out;
      const size = statSync(file).size;
      if (size > budget) return out;
      const target = join(destination, relative(home, file).split(sep).join('/'));
      mkdirSync(join(target, '..'), { recursive: true });
      cpSync(file, target);
      budget -= size;
      out.push({ path: target, bytes: size });
    }
  }
  return out;
}

/**
 * Destroy the attempt home.
 *
 * Called after the read-out, on every exit path including a failed or killed
 * attempt: a home left behind is both a disk leak and an un-audited configuration
 * channel for the next worker.
 */
export function destroyAttemptHome(home: string): void {
  rmSync(home, { recursive: true, force: true });
}

/** Files the attempt is allowed to have left in its home, for the test assertions. */
export function listHomeFiles(home: string): string[] {
  const out: string[] = [];
  if (!statSync(home, { throwIfNoEntry: false })?.isDirectory()) return out;
  walk(home, out);
  return out.map((file) => relative(home, file).split(sep).join('/'));
}

/** Read a home file as text, for diagnostics. Missing is `null`, never a throw. */
export function readHomeFile(home: string, relativePath: string): string | null {
  try {
    return readFileSync(join(home, relativePath), 'utf8');
  } catch {
    return null;
  }
}
