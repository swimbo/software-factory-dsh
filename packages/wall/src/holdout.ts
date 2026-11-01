/**
 * The generator-blind holdout store.
 *
 * The wall is only a wall if the thing it measures against is *not reachable by
 * the thing being measured*. So the holdout scenarios live outside the attempt's
 * working tree — under `~/.factory/holdout/` — and are read only by this package,
 * in the evaluator's own process, from a path that appears in no worktree, no
 * container mount and no prompt.
 *
 * The attack this defends against is specific and boring: an agent that can read
 * the holdout can satisfy it exactly, and an agent that can write it can widen it.
 * Either one turns the wall into a mirror. That is why the store's location is
 * never derived from the repository, why `assertHoldoutOutsideRepo` refuses a
 * root inside the working tree, and why every failure mode below resolves to
 * `null` (unavailable) rather than to an empty store: an empty holdout is a
 * pass-shaped hole, and a `pass` verdict must never be reachable by deletion.
 *
 * Nothing here reads a patch, a diff or a receipt. A scenario is derived from the
 * *spec* — what the software must do — never from the implementation that claims
 * to do it.
 */
import { readdirSync, readFileSync, realpathSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { FactoryError, contentHash } from '@factory/contracts';

/**
 * One holdout scenario: a command to run and the exit codes that mean "the
 * behaviour the spec asked for is present".
 *
 * `dependsOn` is optional and additive to the frozen scenario shape: it names
 * files the scenario's verdict depends on, so the wall can refuse a patch that
 * deletes them (see `tests_weakened` in `evaluate.ts`). Without it the wall
 * cannot distinguish "the candidate improved" from "the candidate removed the
 * fixture the scenario needed".
 */
export interface HoldoutScenario {
  readonly id: string;
  readonly taskClass: string;
  readonly argv: readonly string[];
  readonly expectExit: readonly number[];
  readonly dependsOn?: readonly string[];
  /**
   * Isolation this scenario needs. `container` means the wall must not measure it in a
   * convenience runner: a scenario that expects no network, in a runner that has one, is a
   * scenario whose result means something else.
   */
  readonly requires?: 'container';
}

/**
 * A whole task class's scenarios at one revision.
 *
 * `revision` is an opaque token (the store directory's name). The wall never
 * interprets it; it exists so a verdict can say which scenario set it was
 * measured against, and so a stale verdict can be recognised as stale.
 */
export interface HoldoutStore {
  readonly revision: string;
  readonly taskClass: string;
  readonly scenarios: readonly HoldoutScenario[];
}

/** A path segment that cannot escape its parent, so a manifest can never point the wall elsewhere. */
const SAFE_SEGMENT = /^[a-z0-9][a-z0-9-]{0,63}$/;
const SAFE_REVISION = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;

/** `~/.factory/holdout` — the one location that is in no worktree and no container mount. */
export function defaultHoldoutRoot(): string {
  return join(homedir(), '.factory', 'holdout');
}

/**
 * Byte-order comparison, deliberately not `localeCompare`: a locale-sensitive
 * sort would pick a different "latest revision" on a different machine, and a
 * wall whose scenario set depends on the host's locale is not reproducible.
 */
function compareCodeUnits(a: string, b: string): number {
  if (a === b) return 0;
  return a < b ? -1 : 1;
}

/**
 * Load the current revision of `taskClass`'s scenarios, or `null` when the store
 * is not usable.
 *
 * `null` is deliberately overloaded for *every* failure — missing root, missing
 * class, malformed manifest, hash mismatch, empty scenario list. The wall's rule
 * is that unknown is not pass; collapsing "the store is broken" and "the store is
 * absent" into one unavailable signal makes it impossible for a caller to
 * accidentally treat a broken store as a passing one.
 *
 * `root` of `undefined` uses `defaultHoldoutRoot()`. The signature keeps `root`
 * first because the tests and the CLI both need to point at a fixture tree.
 */
export function loadHoldout(root: string | undefined, taskClass: string): HoldoutStore | null {
  if (!SAFE_SEGMENT.test(taskClass)) return null;
  const base = root === undefined ? defaultHoldoutRoot() : root;
  if (typeof base !== 'string' || base.trim() === '') return null;

  const classDir = join(base, taskClass);
  let revisionNames: string[];
  try {
    revisionNames = readdirSync(classDir, { withFileTypes: true })
      // Symlinked revision directories are ignored on purpose: a symlink is a
      // way to point the store into the repository, which is exactly the shape
      // this module exists to refuse.
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name)
      .filter((name) => SAFE_REVISION.test(name));
  } catch {
    return null;
  }
  if (revisionNames.length === 0) return null;

  // The greatest revision wins. We do not fall back to an older revision when
  // the newest is malformed: falling back would silently verify a candidate
  // against scenarios the operator has already replaced.
  const latest = revisionNames.sort(compareCodeUnits).at(-1);
  if (latest === undefined) return null;

  let raw: string;
  try {
    raw = readFileSync(join(classDir, latest, 'manifest.json'), 'utf8');
  } catch {
    return null;
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }

  return acceptManifest(parsed, latest, taskClass);
}

/**
 * Validate a parsed manifest into a store, or `null`.
 *
 * Every rejection here is a way the store could lie: a revision that does not
 * match its directory, a scenario belonging to another task class, a duplicate
 * id (two scenarios that cannot be told apart in a verdict), an empty argv (a
 * scenario that runs nothing and therefore always "passes"), or a content hash
 * that does not describe the scenarios actually present.
 */
function acceptManifest(
  parsed: unknown,
  revisionDirName: string,
  taskClass: string,
): HoldoutStore | null {
  if (!isRecord(parsed)) return null;
  const { revision, taskClass: declaredClass, scenarios, revisionHash } = parsed;

  if (typeof revision !== 'string' || revision !== revisionDirName) return null;
  if (typeof declaredClass !== 'string' || declaredClass !== taskClass) return null;
  if (typeof revisionHash !== 'string') return null;
  if (!Array.isArray(scenarios) || scenarios.length === 0) return null;

  const accepted: HoldoutScenario[] = [];
  const seen = new Set<string>();
  for (const entry of scenarios) {
    const scenario = acceptScenario(entry, taskClass);
    if (scenario === null) return null;
    if (seen.has(scenario.id)) return null;
    seen.add(scenario.id);
    accepted.push(scenario);
  }

  // Scenario order in the file is authoring convenience, not identity: the wall
  // hash and the wall's positional handles both derive from id order, so two
  // manifests that differ only in ordering describe the same revision.
  const sorted = [...accepted].sort((a, b) => compareCodeUnits(a.id, b.id));
  if (contentHash(hashableScenarios(sorted)) !== revisionHash) return null;

  return { revision: revisionDirName, taskClass, scenarios: sorted };
}

function acceptScenario(entry: unknown, taskClass: string): HoldoutScenario | null {
  if (!isRecord(entry)) return null;
  const { id, taskClass: declaredClass, argv, expectExit, dependsOn } = entry;

  if (typeof id !== 'string' || id.length === 0 || id.length > 200) return null;
  if (typeof declaredClass !== 'string' || declaredClass !== taskClass) return null;
  if (!isNonEmptyStringArray(argv)) return null;
  // An empty or malformed expectation is refused rather than defaulted: a
  // scenario that accepts every exit code is a scenario that cannot fail.
  if (!Array.isArray(expectExit) || expectExit.length === 0) return null;
  const expected: number[] = [];
  for (const code of expectExit) {
    if (!Number.isInteger(code) || typeof code !== 'number' || code < 0 || code > 255) return null;
    expected.push(code);
  }
  if (dependsOn !== undefined && !isNonEmptyStringArray(dependsOn)) return null;

  const base: HoldoutScenario = {
    id,
    taskClass,
    argv: [...argv],
    expectExit: expected,
  };
  return dependsOn === undefined ? base : { ...base, dependsOn: [...dependsOn] };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isNonEmptyStringArray(value: unknown): value is string[] {
  return (
    Array.isArray(value) &&
    value.length > 0 &&
    value.every((v) => typeof v === 'string' && v.length > 0)
  );
}

/** The exact value the revision hash covers — the scenario *set*, not the file's ordering. */
export function hashableScenarios(scenarios: readonly HoldoutScenario[]): readonly unknown[] {
  return [...scenarios]
    .sort((a, b) => compareCodeUnits(a.id, b.id))
    .map((s) => ({
      id: s.id,
      taskClass: s.taskClass,
      argv: [...s.argv],
      expectExit: [...s.expectExit],
      ...(s.dependsOn === undefined ? {} : { dependsOn: [...s.dependsOn] }),
    }));
}

/**
 * Resolve a path into the same "real" space on both sides of a comparison.
 *
 * `realpathSync` alone is not enough: a store that does not exist yet (the normal
 * case — the operator has not created it) cannot be resolved, and on macOS the
 * temp dir is `/var/...` which really lives at `/private/var/...`. Mixing one
 * resolved path with one unresolved path makes `relative()` return `..` for a
 * store that is genuinely *inside* the repository, which is the one direction this
 * check must never get wrong. So: resolve the deepest existing ancestor and re-join
 * the remainder that does not exist yet.
 */
function resolveRealPath(target: string): string {
  const absolute = resolve(target);
  const pending: string[] = [];
  let current = absolute;
  for (;;) {
    try {
      const real = realpathSync(current);
      return pending.length === 0 ? real : join(real, ...pending.reverse());
    } catch {
      const parent = dirname(current);
      if (parent === current) return absolute;
      pending.push(basename(current));
      current = parent;
    }
  }
}

/**
 * Refuse a holdout root that lives inside the repository the worker can write.
 *
 * This is the structural half of the generator-blindness claim: a root inside the
 * repo means the store is inside the blast radius, and the wall would be grading
 * an attempt against scenarios the attempt could have edited. It throws rather
 * than returning a boolean because there is no correct way to continue — a caller
 * that ignores `false` here is a caller that ships a mirror.
 *
 * Limit, stated plainly: this is a path check, so it does not defeat a symlink
 * created *after* the check (a TOCTOU window). The compensating control is that
 * the store is operator-owned and read-only to the worker's user; the check is
 * the cheap guard, not the whole defence.
 */
export function assertHoldoutOutsideRepo(root: string, repoPath: string): void {
  const rootAbs = resolveRealPath(root);
  const repoAbs = resolveRealPath(repoPath);
  const rel = relative(repoAbs, rootAbs);
  const inside = rel === '' || (!rel.startsWith('..') && !isAbsolute(rel));
  if (inside) {
    throw new FactoryError(
      'WALL_UNAVAILABLE',
      `holdout store must live outside the repository: ${rootAbs} is inside ${repoAbs}`,
      { root: rootAbs, repo: repoAbs },
    );
  }
}

/** Re-exported so a caller can name the same pattern the wall uses, without duplicating it. */
export const HOLDOUT_SAFE_SEGMENT = SAFE_SEGMENT;
