/**
 * The replay policy: what the wall re-executes, and what it says about the rest.
 *
 * Two live-attempt defects in one check, in opposite directions:
 *
 * 1. The wall replayed **every** command — including the worker launch (`dsh …`: the thing
 *    under test, non-deterministic, and on a paid attempt a replay spends money) and the
 *    factory's own `git diff --cached` / `--numstat` reads run *in isolation and out of order*.
 *    A good change was refused with `receipt_unfaithful`.
 * 2. Fixing (1) by refusing all seven reads made every real receipt have zero replayable
 *    commands: `unknown` → L3 refuses every gate → **no real worker could ever produce a
 *    promotable unit**. A gate that cannot open is not caution.
 *
 * The policy under test, in one sentence: **the wall replays every command it can reconstruct
 * — worker commands the recorder marked `replayable`, and the factory's verification reads with
 * the index rebuilt from the receipt's base by the replay itself — never the launch, and it
 * states in the verdict which commands it did not re-execute.**
 *
 * The real-receipt shape (8 commands) is the fixture below: one launch, `read-tree`, `add`, and
 * five reads. `replay.git.test.ts` proves the same policy against real git.
 */
import { describe, expect, it } from 'vitest';
import {
  assertVerdictIsEarned,
  sha256Hex,
  toDecisionReceipt,
  type AcceptanceCriterion,
  type CommandRecord,
  type DecisionReceipt,
  type OperationClass,
  type UnitSpec,
  type WorkerReceipt,
} from '@factory/contracts';
import {
  evaluate,
  NO_PATCH,
  type DiffInspector,
  type ScenarioRunner,
  type ScenarioRunInput,
  type ScenarioRunResult,
} from './evaluate.ts';
import { oneLineReason, workerFacingReason } from './reasons.ts';
import type { HoldoutScenario, HoldoutStore } from './holdout.ts';

const BASE_REV = 'a'.repeat(40);
const NOW = '2026-11-01T12:00:00.000Z';
const OK_SHA = `sha256:${sha256Hex('ok')}`;
const FAIL_SHA = `sha256:${sha256Hex('fail')}`;
const LAUNCH_ARGV = ['dsh', 'run', '--attempt', 'attempt-1', '--live'];
const READ_TREE_ARGV = ['git', 'read-tree', BASE_REV];
const ADD_ARGV = ['git', 'add', '--all', '--', '.'];
const DIFF_BINARY_ARGV = ['git', 'diff', '--binary', '--cached'];
const DIFF_NUMSTAT_ARGV = ['git', 'diff', '--numstat', '--cached'];
const STATUS_UNTRACKED_ARGV = ['git', 'status', '--porcelain=v1', '--untracked-files=all'];
const STATUS_IGNORED_ARGV = ['git', 'status', '--porcelain=v1', '--ignored=matching'];
const LS_FILES_IGNORED_ARGV = ['git', 'ls-files', '--others', '--ignored'];

interface Outcome {
  readonly exitCode: number | null;
  readonly outputSha: string;
}

const PASS: Outcome = { exitCode: 0, outputSha: OK_SHA };

/** The command a replay script actually executes: everything after the last `&& `. */
function tailOf(argv: readonly string[]): string {
  if (argv[0] !== 'sh' || argv[1] !== '-c') return argv.join(' ');
  const script = argv[2] ?? '';
  const cut = script.lastIndexOf('&& ');
  return cut === -1 ? script : script.slice(cut + 3);
}

/**
 * Answers by the *tail* of the argv, so a rewritten replay argv
 * (`sh -c 'git read-tree … && git add … && <read>'`) is keyed by `<read>` — which is what makes
 * "the wall replays the recorded command in a reconstructed index" observable here.
 */
class TableRunner implements ScenarioRunner {
  readonly kind = 'local' as const;
  readonly patched = new Map<string, Outcome>();
  readonly base = new Map<string, Outcome>();
  readonly calls: ScenarioRunInput[] = [];
  fallback: Outcome = PASS;

  async run(input: ScenarioRunInput): Promise<ScenarioRunResult> {
    this.calls.push(input);
    const table = input.patchFile === NO_PATCH ? this.base : this.patched;
    const outcome = table.get(tailOf(input.argv)) ?? this.fallback;
    return {
      exitCode: outcome.exitCode,
      outputSha: outcome.outputSha,
      durationMs: 1,
      timedOut: false,
      summary:
        outcome.exitCode === 0
          ? { passed: 12, failed: 0, unknown: 0, exitCode: 0 }
          : { passed: 0, failed: 3, unknown: 0, exitCode: outcome.exitCode },
    };
  }

  /** Everything this runner was asked to execute, as argv arrays. */
  get argvs(): string[][] {
    return this.calls.map((call) => [...call.argv]);
  }

  get scripts(): string[] {
    return this.calls.map((call) => tailOf(call.argv));
  }
}

function commandCriterion(id: string, target: string, expect: string): AcceptanceCriterion {
  return { id, text: `criterion ${id} holds`, oracle: { kind: 'command', target, expect } };
}

function makeSpec(): UnitSpec {
  return {
    slug: 'add-probe',
    revision: 1,
    repo: '/repo',
    baseRev: BASE_REV,
    intent: 'Add a probe endpoint that answers with the unit id, so operators can see it.',
    restateBack: 'Add /probe returning the unit id as JSON, with a command oracle proving it.',
    acceptance: [commandCriterion('probe-answers', '["node","--probe","acceptance-ok"]', '0')],
    touchPaths: ['src/'],
    operationClasses: ['code-change'] as OperationClass[],
    sizeBudget: { files: 10, lines: 400 },
    budgetEstimateUsd: 2,
  };
}

function command(
  argv: readonly string[],
  provenance: {
    readonly source?: 'worker-launch' | 'worker-command' | 'factory-verification';
    readonly replayable?: boolean;
    readonly replaySkipReason?: string;
  },
  outcome: Outcome = PASS,
): CommandRecord {
  return {
    argv: [...argv],
    cwd: 'worktree',
    exitCode: outcome.exitCode,
    timedOut: false,
    outputSha: outcome.outputSha,
    durationMs: 7,
    ...(provenance.source === undefined ? {} : { source: provenance.source }),
    ...(provenance.replayable === undefined ? {} : { replayable: provenance.replayable }),
    ...(provenance.replaySkipReason === undefined
      ? {}
      : { replaySkipReason: provenance.replaySkipReason }),
  };
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
      insertions: 10,
      deletions: 0,
      baseRev: BASE_REV,
    },
    commands,
    suite: {
      command: ['pnpm', 'test'],
      exitCode: 0,
      passed: 12,
      failed: 0,
      skipped: 0,
      unknown: 0,
    },
    ceilings: { turnsUsed: 14, wallClockMs: 1_800_000, hit: [] },
    artifacts: [],
    narrative: 'Attempt complete: implementation verified by the suite.',
  };
  return toDecisionReceipt(receipt);
}

const CLEAN_DIFF: DiffInspector = {
  async changedFiles() {
    return [{ path: 'src/probe.ts', kind: 'added', emptied: false, removedAssertions: 0 }];
  },
};

function holdout(): HoldoutStore {
  const scenarios: HoldoutScenario[] = ['holdout-alpha', 'holdout-beta'].map((id) => ({
    id,
    taskClass: 'core',
    argv: ['node', '.holdout/run.js', id],
    expectExit: [0],
  }));
  return { revision: 'r0001', taskClass: 'core', scenarios };
}

function policy() {
  return {
    deltaThreshold: 0,
    commandTimeoutMs: 30_000,
    wallVersion: 'wall/0.1.0',
    runsPerScenario: 3,
    maxNonDiscriminating: 0,
    pinnedSuite: { argv: ['pnpm', 'test'] },
  };
}

/** A green world: acceptance, the wall's own suite and the holdout all behave. */
function greenRunner(): TableRunner {
  const runner = new TableRunner();
  runner.patched.set('pnpm test', PASS);
  runner.patched.set('node --probe acceptance-ok', PASS);
  for (const id of ['holdout-alpha', 'holdout-beta']) {
    runner.patched.set(`node .holdout/run.js ${id}`, PASS);
    runner.base.set(`node .holdout/run.js ${id}`, { exitCode: 1, outputSha: FAIL_SHA });
  }
  return runner;
}

/** The launch: never replayed, and it says why. */
const LAUNCH = command(LAUNCH_ARGV, {
  source: 'worker-launch',
  replayable: false,
  replaySkipReason:
    'the worker launch is the attempt under test; replaying it would re-run the model',
});

/**
 * The live attempt's own eight commands, in recorded order (`U-20be8c159df8 / A-e507950c0625`):
 * the launch, the factory's reconstruction (`read-tree`, `add`), three diff reads that are
 * functions of (base, staged tree), and two `git status` forms that are not — they report
 * untracked and ignored entries from the working directory, which no commit can reconstruct.
 *
 * All seven are marked `replayable: true` by the recorder, and that is the point: the wall
 * decides the class itself, so a recorder that is too optimistic (or too pessimistic) cannot
 * move the gate. Five reproduce; the two status forms are reported as not-replayed-with-reason.
 */
function realReceiptCommands(
  over: { readonly tamperNumstat?: boolean; readonly tamperBoth?: boolean } = {},
): CommandRecord[] {
  const verification = (argv: readonly string[], outcome: Outcome = PASS): CommandRecord =>
    command(argv, { source: 'factory-verification', replayable: true }, outcome);
  return [
    LAUNCH,
    verification(READ_TREE_ARGV),
    verification(ADD_ARGV),
    verification(DIFF_BINARY_ARGV),
    verification(
      DIFF_NUMSTAT_ARGV,
      over.tamperNumstat === true || over.tamperBoth === true
        ? { exitCode: 0, outputSha: FAIL_SHA }
        : PASS,
    ),
    verification(STATUS_UNTRACKED_ARGV),
    verification(STATUS_IGNORED_ARGV),
    verification(
      LS_FILES_IGNORED_ARGV,
      over.tamperBoth === true ? { exitCode: 0, outputSha: FAIL_SHA } : PASS,
    ),
  ];
}

async function evaluateReceipt(
  commands: CommandRecord[],
  runner: TableRunner,
): Promise<Awaited<ReturnType<typeof evaluate>>> {
  return evaluate({
    spec: makeSpec(),
    receipt: makeReceipt(commands),
    holdout: holdout(),
    runner,
    policy: policy(),
    diff: CLEAN_DIFF,
    nowIso: NOW,
  });
}

const scopeOf = (verdict: { scenarios: { id: string; observed: string | null }[] }): string =>
  verdict.scenarios.find((scenario) => scenario.id === 'faithfulness:scope')?.observed ?? '';

describe('the wall replays what it can reconstruct, and says what it could not', () => {
  it('replays 5 of the 8 live-receipt commands and reports the two status forms as not replayed', async () => {
    // The exact shape the paid attempt produced. Five reads are functions of (base, staged
    // tree): read-tree, add, diff --binary --cached, diff --numstat --cached, and
    // ls-files --others --ignored. The launch is never replayed, and the two `git status`
    // forms depend on untracked/ignored working-directory state a commit cannot reconstruct —
    // they are unreplayable-with-reason, not divergences.
    const runner = greenRunner();
    const verdict = await evaluateReceipt(realReceiptCommands(), runner);

    expect(scopeOf(verdict)).toContain('replayed 5 of 8 recorded commands');
    expect(scopeOf(verdict)).toContain('0 mismatched');
    expect(scopeOf(verdict)).toContain('commands[0] (worker-launch');

    // The reason names the limit rather than blaming the change.
    const untracked = verdict.scenarios.find((scenario) => scenario.id === 'faithfulness:06');
    const ignored = verdict.scenarios.find((scenario) => scenario.id === 'faithfulness:07');
    expect(untracked?.observed).toContain('not replayed');
    expect(untracked?.observed).toContain('untracked entries from the working directory');
    expect(ignored?.observed).toContain('ignored entries from the working directory');
    expect(untracked?.outcome).toBe('pass');
    expect(ignored?.outcome).toBe('pass');

    // Every replayed read ran in a rebuilt index: the script carries read-tree and add.
    const replayScripts = runner.calls
      .filter((call) => call.argv[0] === 'sh' && call.argv[1] === '-c')
      .map((call) => call.argv[2] ?? '');
    expect(replayScripts).toHaveLength(5);
    for (const script of replayScripts) {
      expect(script).toContain(`git read-tree ${BASE_REV}`);
      expect(script).toContain('git add --all -- .');
    }
    // `git ls-files --others --ignored` is reconstructable and stays replayable: it answers
    // the ignored-file question from the index, which the replay rebuilds.
    expect(replayScripts.some((script) => script.endsWith('git ls-files --others --ignored'))).toBe(
      true,
    );
    // The launch was never executed, by any route.
    expect(runner.argvs.some((argv) => argv[0] === 'dsh')).toBe(false);

    // No false divergence, so a green world is a pass — the gate can open.
    expect(verdict.outcome).toBe('pass');
    expect(verdict.reasons).toEqual([]);
    expect(() => assertVerdictIsEarned(verdict)).not.toThrow();
    const faithfulness = verdict.scenarios.filter((scenario) =>
      scenario.id.startsWith('faithfulness:0'),
    );
    expect(faithfulness).toHaveLength(8);
  });

  it('catches a tampered --numstat: the replay measures, it does not trust', async () => {
    // The receipt claims the numstat read produced FAIL_SHA; the replay produces OK_SHA.
    // Nothing about that is "partial": a recorded claim did not reproduce.
    const verdict = await evaluateReceipt(
      realReceiptCommands({ tamperNumstat: true }),
      greenRunner(),
    );

    expect(verdict.outcome).toBe('fail');
    expect(verdict.reasons).toContain('receipt_unfaithful');
    expect(scopeOf(verdict)).toContain('replayed 5 of 8 recorded commands');
    expect(scopeOf(verdict)).toContain('1 mismatched');
    // The scope row agrees with its own sentence: a row that counts a divergence is a failure.
    const scope = verdict.scenarios.find((scenario) => scenario.id === 'faithfulness:scope');
    expect(scope?.outcome).toBe('fail');
    // The divergence is named by index, so the operator knows which read lied.
    const divergent = verdict.scenarios.find((scenario) => scenario.id === 'faithfulness:05');
    expect(divergent?.outcome).toBe('fail');
    expect(divergent?.observed).toContain('not reproduced');
    // The agent still learns nothing beyond "not accepted".
    expect(workerFacingReason(verdict)).toBe('not accepted');
  });

  it('with two of eight mismatched the scope row fails and both codes are present', async () => {
    // The live verdict said `2 mismatched` on a row whose outcome was `pass`: a green line
    // reporting a divergence. It only failed overall because `receipt_unfaithful` came along;
    // the row must fail on its own terms, and both codes must be present.
    const verdict = await evaluateReceipt(realReceiptCommands({ tamperBoth: true }), greenRunner());

    const scope = verdict.scenarios.find((scenario) => scenario.id === 'faithfulness:scope');
    expect(scope?.observed).toContain('2 mismatched');
    expect(scope?.outcome).toBe('fail');
    expect(verdict.outcome).toBe('fail');
    expect(verdict.reasons).toContain('receipt_unfaithful');
    expect(verdict.reasons).toContain('faithfulness_partial');
  });

  it('no row may claim a mismatch while passing', async () => {
    // The invariant behind the bug, checked over every verdict this file can produce: if a
    // row's own observed text counts a divergence, the row is a failure. A reader who sees a
    // green row saying `2 mismatched` has been lied to by the instrument.
    const cases = [
      await evaluateReceipt(realReceiptCommands(), greenRunner()),
      await evaluateReceipt(realReceiptCommands({ tamperNumstat: true }), greenRunner()),
      await evaluateReceipt(realReceiptCommands({ tamperBoth: true }), greenRunner()),
    ];
    for (const verdict of cases) {
      for (const scenario of verdict.scenarios) {
        const counted = /([1-9][0-9]*) mismatched/u.exec(scenario.observed ?? '');
        if (counted !== null) expect(scenario.outcome).toBe('fail');
      }
    }
  });

  it('reports an out-of-order verification group as unreplayable-with-reason, never a silent pass', async () => {
    // A read captured before the index was reconstructed cannot be trusted, so the wall does
    // not replay it "anyway" — that is the original defect wearing a different hat.
    const verification = (argv: readonly string[], outcome: Outcome = PASS): CommandRecord =>
      command(argv, { source: 'factory-verification', replayable: true }, outcome);
    const verdict = await evaluateReceipt(
      [
        LAUNCH,
        verification(DIFF_BINARY_ARGV),
        verification(READ_TREE_ARGV),
        verification(ADD_ARGV),
        verification(DIFF_NUMSTAT_ARGV),
      ],
      greenRunner(),
    );

    expect(verdict.outcome).not.toBe('pass');
    expect(scopeOf(verdict)).toContain('replayed 0 of 5');
    expect(scopeOf(verdict)).toContain('recorded before git read-tree');
    expect(verdict.reasons).toContain('faithfulness_partial');
    expect(verdict.reasons).not.toContain('receipt_unfaithful');
  });

  it('a receipt with only the worker launch is faithfulness_partial, never a pass', async () => {
    const verdict = await evaluateReceipt([LAUNCH], greenRunner());

    expect(verdict.outcome).not.toBe('pass');
    expect(verdict.outcome).toBe('unknown');
    expect(verdict.reasons).toContain('faithfulness_partial');
    expect(scopeOf(verdict)).toContain('replayed 0 of 1');
    expect(oneLineReason(verdict)).toContain('not replayed');
  });

  it('a worker command the recorder marked unreplayable is not replayed', async () => {
    // Only the launch and worker commands are decided by the receipt's flag: a worker command
    // may genuinely be non-deterministic, and the recorder is the one who knows.
    const verdict = await evaluateReceipt(
      [
        LAUNCH,
        command(['node', 'scripts/flaky.js'], {
          source: 'worker-command',
          replayable: false,
          replaySkipReason: 'hits a live endpoint',
        }),
      ],
      greenRunner(),
    );

    expect(verdict.outcome).not.toBe('pass');
    expect(scopeOf(verdict)).toContain('replayed 0 of 2');
    expect(scopeOf(verdict)).toContain('hits a live endpoint');
    expect(verdict.reasons).toContain('faithfulness_partial');
  });

  it('a replayable command that does not reproduce is still receipt_unfaithful', async () => {
    // Never regress: scoping the replay must not blunt the reproduction check.
    const runner = greenRunner();
    runner.patched.set('pnpm test', { exitCode: 0, outputSha: FAIL_SHA });
    const verdict = await evaluateReceipt(
      [command(['pnpm', 'test'], { source: 'worker-command', replayable: true }), LAUNCH],
      runner,
    );

    expect(verdict.outcome).toBe('fail');
    expect(verdict.reasons).toContain('receipt_unfaithful');
    expect(scopeOf(verdict)).toContain('replayed 1 of 2');
    expect(scopeOf(verdict)).toContain('1 mismatched');
  });

  it('a receipt with no provenance at all is unknown, not a pass and not a failure', async () => {
    // Historical receipts still parse (the ledger is history) but they cannot prove
    // faithfulness: absence of provenance is never read as "safe to re-run".
    const verdict = await evaluateReceipt(
      [command(['pnpm', 'test'], {}), command(['git', 'diff', '--numstat'], {})],
      greenRunner(),
    );

    expect(verdict.outcome).toBe('unknown');
    expect(verdict.reasons).toContain('faithfulness_partial');
    expect(scopeOf(verdict)).toContain('replayed 0 of 2');
    expect(scopeOf(verdict)).toContain('the receipt recorded no replay provenance');
  });

  it('refuses to believe a receipt that marks the worker launch replayable', async () => {
    // The schema rejects this shape, so it can only arrive through a cast or a legacy row.
    // The wall does not take the receipt's word for what can be replayed: replaying the launch
    // would re-run a paid model, which is exactly the defect this policy exists to prevent.
    const runner = greenRunner();
    const verdict = await evaluateReceipt(
      [
        command(LAUNCH_ARGV, { source: 'worker-launch', replayable: true }),
        command(['pnpm', 'test'], { source: 'worker-command', replayable: true }),
      ],
      runner,
    );

    expect(runner.argvs.some((argv) => argv[0] === 'dsh')).toBe(false);
    const launchScenario = verdict.scenarios.find((scenario) => scenario.id === 'faithfulness:01');
    expect(launchScenario?.observed).toContain('worker-launch');
    expect(launchScenario?.observed).toContain('never replayed');
    expect(scopeOf(verdict)).toContain('replayed 1 of 2');
  });
});
