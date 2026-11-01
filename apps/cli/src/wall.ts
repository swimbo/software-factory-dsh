/**
 * The wall, wired: one receipt in, one measured `Verdict` out.
 *
 * Everything interesting about the wall lives in `@factory/wall`; this module's job is
 * to hand it the four things it cannot get for itself — the spec, the receipt, a
 * scenario runner and a diff inspector — and to refuse, loudly, when it cannot.
 *
 * ## Which runner, and what that costs
 *
 * `createLocalRunner`: a private temp copy of the tree, a process-group timeout and a
 * private `FACTORY_HOME`. It provides **no** containment — no network isolation, no
 * filesystem isolation, no uid separation — so the wall labels every verdict it
 * produces `+local`, and a scenario that declares `requires: 'container'` or
 * `network: 'none'` is refused by the runner rather than quietly downgraded
 * (`packages/wall/README.md` §17). That refusal becomes `unknown`, never `pass`.
 *
 * ## `prepare`: why the wall cannot just run in the attempt clone
 *
 * A scenario must run against `base + patch`, not against the tree the worker left
 * behind, for two reasons:
 *
 * 1. **Faithfulness.** The receipt claims "this command exited 0 and printed these
 *    bytes"; re-executing it in the worker's own directory would reproduce the claim by
 *    construction. A fresh tree makes it a test.
 * 2. **The wall's own oracle.** `testRootFrom: 'base'` means the tests are checked out
 *    from the base revision, so a candidate cannot weaken the tests that judge it.
 *
 * So `prepare` builds a throwaway checkout from the pristine mirror at `baseRev`,
 * applies the recorded patch, and — when the wall asks for the base test root — checks
 * the test tree back out from `baseRev`. The mirror is only ever read: a worker that
 * edits the mirror would destroy the base for every later attempt.
 */
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

import {
  WALL_VERSION,
  type DecisionReceipt,
  type UnitSpec,
  type Verdict,
} from '@factory/contracts';
import {
  createLocalRunner,
  evaluate,
  loadHoldout,
  NO_PATCH,
  type ChangedFile,
  type DiffInspector,
  type ScenarioRunInput,
} from '@factory/wall';

/** Wall knobs that are operator policy, read from the environment once per invocation. */
export interface WallPolicyEnv {
  readonly holdoutRoot: string | undefined;
  readonly taskClass: string;
  readonly testRoot: string;
  readonly pinnedSuite: readonly string[] | null;
  readonly deltaThreshold: number;
  readonly commandTimeoutMs: number;
}

function numberOr(raw: string | undefined, fallback: number): number {
  const text = (raw ?? '').trim();
  if (text === '') return fallback;
  const value = Number(text);
  return Number.isFinite(value) ? value : fallback;
}

/** An argv from an env var: JSON array first (exact), whitespace split second (hand-written). */
function argvOrNull(raw: string | undefined): readonly string[] | null {
  const text = (raw ?? '').trim();
  if (text === '') return null;
  if (text.startsWith('[')) {
    try {
      const parsed: unknown = JSON.parse(text);
      if (
        Array.isArray(parsed) &&
        parsed.every((item) => typeof item === 'string' && item !== '')
      ) {
        return parsed as string[];
      }
    } catch {
      return null;
    }
    return null;
  }
  const parts = text.split(/\s+/).filter((part) => part !== '');
  return parts.length === 0 ? null : parts;
}

export function wallPolicyFrom(
  env: Readonly<Record<string, string | undefined>>,
  spec: UnitSpec,
): WallPolicyEnv {
  const holdoutRoot = (env.FACTORY_HOLDOUT_ROOT ?? '').trim();
  const taskClass = (env.FACTORY_HOLDOUT_TASK_CLASS ?? '').trim();
  const testRoot = (env.FACTORY_TEST_ROOT ?? '').trim();
  return {
    holdoutRoot: holdoutRoot === '' ? undefined : holdoutRoot,
    // A holdout corpus is filed under a task class. The spec has no such field (the
    // qualifier derives the class from measured history), so the operator names it and
    // the spec slug is the default: two units of the same kind share a slug family.
    taskClass: taskClass === '' ? spec.slug : taskClass,
    testRoot: testRoot === '' ? 'tests' : testRoot,
    pinnedSuite: argvOrNull(env.FACTORY_WALL_SUITE),
    deltaThreshold: numberOr(env.FACTORY_WALL_DELTA_THRESHOLD, 0.2),
    commandTimeoutMs: numberOr(env.FACTORY_WALL_COMMAND_TIMEOUT_MS, 120_000),
  };
}

function git(
  cwd: string,
  args: readonly string[],
): { code: number; stdout: string; stderr: string } {
  try {
    const stdout = execFileSync('git', [...args], {
      cwd,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      env: process.env,
    });
    return { code: 0, stdout, stderr: '' };
  } catch (error) {
    const record = error as { status?: number; stdout?: string; stderr?: string };
    return {
      code: record.status ?? 1,
      stdout: typeof record.stdout === 'string' ? record.stdout : '',
      stderr: typeof record.stderr === 'string' ? record.stderr : '',
    };
  }
}

/**
 * Build the per-run tree: `baseRev` + the recorded patch, optionally with the base tests.
 *
 * Synchronous because the wall's `prepare` hook is synchronous; each git call is a
 * subprocess, which is exactly what the container runner does with `docker run`.
 */
export function makePrepare(options: {
  readonly pristineRepo: string;
  readonly testRoot: string;
}): (input: ScenarioRunInput) => string {
  return (input) => {
    const dir = mkdtempSync(join(tmpdir(), 'factory-wall-'));
    const clone = git(join(dir, '..'), [
      'clone',
      '--no-hardlinks',
      '--quiet',
      options.pristineRepo,
      dir,
    ]);
    if (clone.code !== 0) {
      rmSync(dir, { recursive: true, force: true });
      throw new Error(`wall prepare: cannot clone the pristine mirror (${clone.stderr.trim()})`);
    }
    const checkout = git(dir, ['checkout', '--detach', '--quiet', input.baseRev]);
    if (checkout.code !== 0) {
      rmSync(dir, { recursive: true, force: true });
      throw new Error(
        `wall prepare: cannot check out ${input.baseRev} (${checkout.stderr.trim()})`,
      );
    }
    if (input.patchFile.trim() !== NO_PATCH) {
      // `git apply` is the honest replay: it fails when the patch does not apply, and
      // the wall turns a throwing run into `unknown` rather than a pass.
      const applied = git(dir, ['apply', '--whitespace=nowarn', input.patchFile]);
      if (applied.code !== 0) {
        rmSync(dir, { recursive: true, force: true });
        throw new Error(`wall prepare: the patch does not apply (${applied.stderr.trim()})`);
      }
    }
    if (input.testRootFrom === 'base') {
      // The candidate's *source* with the base revision's tests.
      const restored = git(dir, ['checkout', input.baseRev, '--', options.testRoot]);
      if (restored.code !== 0) {
        // A repository with no test directory at base is not an error: there is
        // simply nothing for the wall to restore, and the scenario runs as prepared.
        rmSync(join(dir, '.git', 'index.lock'), { force: true });
      }
    }
    return dir;
  };
}

interface NumstatLine {
  readonly path: string;
  readonly kind: ChangedFile['kind'];
  readonly removedAssertions: number;
}

/** `git diff --name-status` + a count of removed assertion lines in the patch. */
function parsePatch(patchText: string, testRoot: string): readonly NumstatLine[] {
  const files: { path: string; kind: ChangedFile['kind'] }[] = [];
  let current: string | null = null;
  const removed = new Map<string, number>();
  const ASSERTION = /\b(assert|expect|test|it|describe)\b/;

  for (const line of patchText.split('\n')) {
    if (line.startsWith('diff --git ')) {
      current = null;
      continue;
    }
    if (line.startsWith('new file mode ')) {
      if (current !== null) {
        const index = files.findIndex((file) => file.path === current);
        if (index >= 0) files[index] = { path: current, kind: 'added' };
      }
      continue;
    }
    if (line.startsWith('deleted file mode ')) {
      if (current !== null) {
        const index = files.findIndex((file) => file.path === current);
        if (index >= 0) files[index] = { path: current, kind: 'deleted' };
      }
      continue;
    }
    if (line.startsWith('+++ ')) {
      const path = line.slice(4).trim();
      if (path === '/dev/null') {
        current = files.length > 0 ? (files[files.length - 1]?.path ?? null) : null;
        continue;
      }
      current = path.replace(/^b\//, '');
      if (!files.some((file) => file.path === current)) {
        files.push({ path: current, kind: 'modified' });
      }
      continue;
    }
    if (line.startsWith('-') && !line.startsWith('---') && current !== null) {
      if (ASSERTION.test(line)) removed.set(current, (removed.get(current) ?? 0) + 1);
    }
  }
  void testRoot;
  return files.map((file) => ({
    path: file.path,
    kind: file.kind,
    removedAssertions: removed.get(file.path) ?? 0,
  }));
}

/**
 * The receipt's patch is the diff — so the inspector reads it rather than the tree.
 *
 * Reading the worker's own directory would report *nothing changed* after the clone is
 * cleaned up, and a `null` inspector makes the wall report `receipt_unavailable`, which
 * refuses a pass. The patch file is the artefact the receipt points at; it is also what
 * every scenario is prepared from, so diff and scenarios cannot disagree.
 */
export function patchDiffInspector(patchFile: string, testRoot: string): DiffInspector {
  return {
    async changedFiles(): Promise<readonly ChangedFile[] | null> {
      let text: string;
      try {
        text = readFileSync(patchFile, 'utf8');
      } catch {
        return null;
      }
      if (text.trim() === '') return [];
      return parsePatch(text, testRoot);
    },
  };
}

export interface WallInputs {
  readonly spec: UnitSpec;
  readonly receipt: DecisionReceipt;
  readonly patchFile: string;
  readonly pristineRepo: string;
  readonly policy: WallPolicyEnv;
  readonly nowIso: string;
  readonly policyVersion: string;
  /**
   * Which model produced the attempt, when the caller knows it. `undefined` is honest: a
   * certificate recorded without a model id cannot be proven current after the operator points
   * `FACTORY_MODEL_ID` somewhere else, and `audit --certifications` says `re-certify: model unknown`
   * rather than assuming the model did not change.
   */
  readonly modelId?: string | undefined;
  /**
   * The operator's home, for `~` expansion in the broker's path rules. `null` means the
   * classifier cannot expand `~`, which makes it refuse rather than guess.
   */
  readonly home?: string | null | undefined;
  /** Where a fake wall's template lives, when `FACTORY_WALL=fake` is not in play this is null. */
  readonly holdoutRoot?: string | undefined;
}

export interface WallOutcome {
  readonly verdict: Verdict;
  /** `false` when no holdout corpus could be loaded — the verdict then cannot pass. */
  readonly holdoutLoaded: boolean;
}

/**
 * Evaluate one receipt.
 *
 * Throws only on a caller bug (a missing test root is not a bug); every *measurement*
 * problem becomes a `Verdict` with `outcome: 'unknown'` and a reason, because that is
 * the type the store accepts and the only one a gate may refuse.
 */
export async function evaluateReceipt(input: WallInputs): Promise<WallOutcome> {
  const holdout = loadHoldout(input.policy.holdoutRoot, input.policy.taskClass);
  // `cwd` is never consulted: every run goes through `prepare`, which builds the tree
  // the run is allowed to see. It is set to the patch's directory so no caller can
  // accidentally hand the runner a directory it would run in unchaperoned.
  const runner = createLocalRunner({
    cwd: dirname(input.patchFile),
    prepare: makePrepare({ pristineRepo: input.pristineRepo, testRoot: input.policy.testRoot }),
    // Always on, and deliberately not configurable: this runner re-executes the commands a
    // receipt *claims* the worker ran. A `sudo` in that list is an operation the factory
    // cannot broker and therefore cannot verify — the run becomes `unknown`, which never
    // satisfies the gate. `privilegedBrokering: 'off'` in the qualifier policy governs the
    // worker's own steps, not the wall's re-execution of them.
    privilegedBrokering: 'on',
    home: input.home ?? null,
    nowIso: () => input.nowIso,
  });

  const verdict = await evaluate({
    spec: input.spec,
    receipt: input.receipt,
    holdout,
    runner,
    policy: {
      deltaThreshold: input.policy.deltaThreshold,
      commandTimeoutMs: input.policy.commandTimeoutMs,
      // The base identity: the local runner appends `+local` itself, so this instrument
      // cannot be mistaken for a container's (packages/wall/README.md §17) — and naming
      // it twice would make the version a string nobody can match on.
      wallVersion: WALL_VERSION,
      ...(input.policy.pinnedSuite === null
        ? {}
        : { pinnedSuite: { argv: input.policy.pinnedSuite } }),
      policyVersion: input.policyVersion,
      minDeltaSamples: 0,
    },
    diff: patchDiffInspector(input.patchFile, input.policy.testRoot),
    nowIso: input.nowIso,
    ...(input.modelId === undefined ? {} : { modelId: input.modelId }),
  });

  return { verdict, holdoutLoaded: holdout !== null };
}
