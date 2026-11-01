/**
 * Does the reconstruction actually reconstruct? Real `git`, real index, real hashes.
 *
 * The policy specs in `provenance.test.ts` use a table runner, which proves the *shape* of the
 * replay (the prefix is present, the order is validated, a mismatch is caught) but cannot prove
 * that `git read-tree <base> && git add --all -- .` puts a checkout into the state the recorded
 * reads were captured in. That is the load-bearing claim of the whole fix, so it is tested
 * against a real repository and the real local runner.
 *
 * The trap this file sets for the wall: the repository is left with an index reset to the base
 * tree, with the candidate change still in the working tree. A wall that replays a recorded read
 * *without* rebuilding the index therefore sees "nothing staged" — an empty diff — and diverges
 * on every read. Only reconstruction makes the reads reproduce.
 */
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  sha256Hex,
  toDecisionReceipt,
  type CommandRecord,
  type DecisionReceipt,
  type UnitSpec,
  type WorkerReceipt,
} from '@factory/contracts';
import { evaluate, NO_PATCH, type DiffInspector, type ScenarioRunner } from './evaluate.ts';
import { createLocalRunner } from './local.ts';
import { replayScript } from './replay.ts';
import type { HoldoutScenario, HoldoutStore } from './holdout.ts';

const NOW = '2026-11-01T12:00:00.000Z';
const ROOT = mkdtempSync(join(tmpdir(), 'factory-replay-git-'));

function git(dir: string, args: readonly string[]): void {
  execFileSync('git', [...args], {
    cwd: dir,
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: 'factory',
      GIT_AUTHOR_EMAIL: 'factory@example.invalid',
      GIT_COMMITTER_NAME: 'factory',
      GIT_COMMITTER_EMAIL: 'factory@example.invalid',
    },
    stdio: 'pipe',
  });
}

/** stdout+stderr, hashed — the same capture the runner applies to a replayed command. */
function capture(dir: string, argv: readonly string[]): { exitCode: number; sha: string } {
  const result = spawnSync(argv[0] ?? 'git', argv.slice(1), { cwd: dir, encoding: 'utf8' });
  const output = `${result.stdout ?? ''}${result.stderr ?? ''}`;
  return { exitCode: result.status ?? 1, sha: `sha256:${sha256Hex(output)}` };
}

/** The factory's own verification reads, in recorded order. */
const READS: readonly (readonly string[])[] = [
  ['git', 'read-tree'],
  ['git', 'add', '--all', '--', '.'],
  ['git', 'diff', '--binary', '--cached'],
  ['git', 'diff', '--numstat'],
  ['git', 'status', '--porcelain'],
  ['git', 'diff', '--cached', '--name-only'],
  ['git', 'ls-files', '-s'],
];

let repo = '';
let baseRev = '';

beforeAll(() => {
  repo = join(ROOT, 'repo');
  mkdirSync(join(repo, 'src'), { recursive: true });
  writeFileSync(join(repo, 'src', 'slug.js'), 'export const slug = (s) => s;\n', 'utf8');
  git(repo, ['init', '--quiet', '--initial-branch=main']);
  git(repo, ['add', '--all']);
  git(repo, ['commit', '--quiet', '-m', 'base']);
  baseRev = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: repo, encoding: 'utf8' }).trim();
});

afterAll(() => {
  rmSync(ROOT, { recursive: true, force: true });
});

function makeSpec(): UnitSpec {
  return {
    slug: 'add-slug-cjk',
    revision: 1,
    repo,
    baseRev,
    intent: 'Strip diacritics before slugifying, so CJK titles do not collide.',
    restateBack: 'Add /probe returning the unit id as JSON, with a command oracle proving it.',
    acceptance: [
      {
        id: 'noop',
        text: 'the probe answers',
        oracle: { kind: 'command', target: '["node","-e","process.exit(0)"]', expect: '0' },
      },
    ],
    touchPaths: ['src/'],
    operationClasses: ['code-change'],
    sizeBudget: { files: 10, lines: 400 },
    budgetEstimateUsd: 2,
  };
}

function holdout(): HoldoutStore {
  const scenarios: HoldoutScenario[] = [
    {
      id: 'holdout-alpha',
      taskClass: 'core',
      argv: ['node', '-e', 'process.exit(0)'],
      expectExit: [0],
    },
  ];
  return { revision: 'r0001', taskClass: 'core', scenarios };
}

const DIFF: DiffInspector = {
  async changedFiles() {
    return [{ path: 'src/slug.js', kind: 'modified', emptied: false, removedAssertions: 0 }];
  },
};

/**
 * Record the receipt's commands the way the factory does: the worker launch (never replayed),
 * then the reads, captured against the staged candidate tree.
 */
function recordCommands(options: { readonly tamperNumstat?: boolean } = {}): CommandRecord[] {
  // The candidate change, staged: this is the state the factory captures its reads in.
  writeFileSync(join(repo, 'src', 'slug.js'), 'export const slug = (s) => s.trim();\n', 'utf8');
  git(repo, ['add', '--all']);

  const commands: CommandRecord[] = [
    {
      argv: ['dsh', 'run', '--attempt', 'attempt-1'],
      cwd: 'worktree',
      exitCode: 0,
      timedOut: false,
      outputSha: `sha256:${sha256Hex('launch')}`,
      durationMs: 900,
      source: 'worker-launch',
      replayable: false,
      replaySkipReason: 'the attempt under test; replaying it would re-run the model',
    },
  ];

  for (const read of READS) {
    const argv =
      read[0] === 'git' && read[1] === 'read-tree' ? ['git', 'read-tree', baseRev] : read;
    const captured = capture(repo, argv);
    const tampered = options.tamperNumstat === true && argv.join(' ') === 'git diff --numstat';
    commands.push({
      argv: [...argv],
      cwd: 'worktree',
      exitCode: captured.exitCode,
      timedOut: false,
      // A tampered record claims a different output for exactly one read.
      outputSha: tampered ? `sha256:${sha256Hex('tampered')}` : captured.sha,
      durationMs: 12,
      source: 'factory-verification',
      replayable: true,
    });
  }

  // The trap: leave the index at the base tree with the change still in the working tree.
  // Any replay that does not rebuild the index now sees an empty staged diff and diverges.
  git(repo, ['read-tree', baseRev]);
  return commands;
}

function makeReceipt(commands: CommandRecord[]): DecisionReceipt {
  const receipt: WorkerReceipt = {
    unitId: 'unit-1',
    attemptId: 'attempt-1',
    sessionId: 'session-1',
    startedAt: '2026-11-01T11:00:00.000Z',
    endedAt: '2026-11-01T11:30:00.000Z',
    exitCode: 0,
    diff: {
      patchFile: '/attempts/attempt-1/change.patch',
      sha: `sha256:${sha256Hex('patch')}`,
      filesChanged: 1,
      insertions: 1,
      deletions: 1,
      baseRev,
    },
    commands,
    suite: {
      command: ['node', '-e', 'process.exit(0)'],
      exitCode: 0,
      passed: 1,
      failed: 0,
      skipped: 0,
      unknown: 0,
    },
    ceilings: { turnsUsed: 4, wallClockMs: 60_000, hit: [] },
    artifacts: [],
    narrative: 'Implemented the diacritic strip.',
  };
  return toDecisionReceipt(receipt);
}

function policy() {
  return {
    deltaThreshold: 0,
    commandTimeoutMs: 30_000,
    wallVersion: 'wall/0.1.0',
    runsPerScenario: 1,
    maxNonDiscriminating: 1,
    pinnedSuite: { argv: ['node', '-e', 'process.exit(0)'] },
  };
}

describe.skipIf(spawnSync('git', ['--version']).status !== 0)(
  'real git: the recorded reads reproduce because the wall rebuilds the index from the base',
  () => {
    it('reproduces every one of the seven reads in a checkout whose index was reset to base', async () => {
      const commands = recordCommands();
      const runner: ScenarioRunner = createLocalRunner({ cwd: repo });

      const verdict = await evaluate({
        spec: makeSpec(),
        receipt: makeReceipt(commands),
        holdout: holdout(),
        runner,
        policy: policy(),
        diff: DIFF,
        nowIso: NOW,
      });

      const scope = verdict.scenarios.find((scenario) => scenario.id === 'faithfulness:scope');
      expect(scope?.observed).toContain('replayed 7 of 8 recorded commands');
      expect(scope?.observed).toContain('0 mismatched');
      // Nothing diverged: the reconstruction, not the receipt, made the reads reproducible.
      expect(verdict.reasons).not.toContain('receipt_unfaithful');
      const replayed = verdict.scenarios.filter((scenario) =>
        scenario.id.startsWith('faithfulness:0'),
      );
      expect(replayed.filter((scenario) => scenario.outcome === 'fail')).toHaveLength(0);
    }, 60_000);

    it('catches one tampered read while the other six still reproduce', async () => {
      const commands = recordCommands({ tamperNumstat: true });
      const runner: ScenarioRunner = createLocalRunner({ cwd: repo });

      const verdict = await evaluate({
        spec: makeSpec(),
        receipt: makeReceipt(commands),
        holdout: holdout(),
        runner,
        policy: policy(),
        diff: DIFF,
        nowIso: NOW,
      });

      expect(verdict.outcome).toBe('fail');
      expect(verdict.reasons).toContain('receipt_unfaithful');
      const diverged = verdict.scenarios.filter((scenario) => scenario.outcome === 'fail');
      // Exactly one read diverged — the tampered one — so the check is measuring, not failing
      // wholesale because the reconstruction is wrong.
      expect(diverged).toHaveLength(1);
      expect(diverged[0]?.id).toBe('faithfulness:05');
    }, 60_000);

    it('the replay script a read is given starts from the receipt base, not from the checkout', () => {
      // A guard on the mechanism itself: if the prefix ever loses the read-tree, the specs
      // above would still pass on a checkout that happened to have a staged index, and the
      // trap in `recordCommands` would go unnoticed.
      const script = replayScript(baseRev, ['git', 'diff', '--numstat']);
      expect(script).toBe(`git read-tree ${baseRev} && git add --all -- . && git diff --numstat`);
      expect(replayScript('not-a-sha', ['git', 'diff'])).toBeNull();
      expect(replayScript(baseRev, ['git', 'diff', '--output=$(whoami)'])).toBeNull();
    });
  },
);
