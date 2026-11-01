/**
 * The wall's adversarial tests.
 *
 * The whole point of this file is test #1: **a change that passes its own visible
 * tests is still rejected.** Everything else here exists to make sure that
 * property cannot be satisfied vacuously — that a `pass` needs a measured Δ, that
 * missing evidence produces `unknown` rather than silence, and that the verdict
 * an agent could read back contains no scenario text it could learn from.
 *
 * No network, no model, no clock: every execution goes through `FakeRunner`, so
 * the same inputs must produce a bit-identical verdict on any machine.
 */
import { mkdtempSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
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
  type Verdict,
  type WorkerReceipt,
} from '@factory/contracts';
import {
  evaluate,
  isDestructiveArgv,
  pathIsInScope,
  HOLDOUT_ABSENT_REVISION,
  NO_PATCH,
  type DiffInspector,
  type ScenarioRunner,
  type ScenarioRunInput,
  type ScenarioRunResult,
} from './evaluate.ts';
import { oneLineReason, workerFacingReason } from './reasons.ts';
import type { HoldoutScenario, HoldoutStore } from './holdout.ts';
import type { CriteriaLogEntry, CriteriaLogPort, CriteriaLogReadResult } from './criteria-log.ts';
import { writeHoldoutStore } from './holdout.test-helpers.ts';

// ---------------------------------------------------------------------------
// fixtures
// ---------------------------------------------------------------------------

const BASE_REV = 'a'.repeat(40);
const NOW = '2026-11-01T12:00:00.000Z';
const OK_SHA = `sha256:${sha256Hex('ok')}`;
const FAIL_SHA = `sha256:${sha256Hex('fail')}`;

function keyOf(argv: readonly string[]): string {
  return argv.join('\u0000');
}

interface Outcome {
  readonly exitCode: number | null;
  readonly outputSha: string;
  readonly timedOut?: boolean;
  readonly throws?: boolean;
  /** Explicit summary, when a test cares about the counts rather than just the exit code. */
  readonly summary?: {
    readonly passed: number;
    readonly failed: number;
    readonly unknown: number;
    readonly exitCode: number | null;
  };
}

const PASS: Outcome = { exitCode: 0, outputSha: OK_SHA };
const FAIL: Outcome = { exitCode: 1, outputSha: FAIL_SHA };

/**
 * A runner whose behaviour is a lookup table keyed by argv, with two tables:
 * the candidate checkout (the patch applied) and the base checkout (no patch).
 * The base table is what makes Δ measurable at all, so the split is explicit.
 */
class FakeRunner implements ScenarioRunner {
  readonly patched = new Map<string, Outcome>();
  readonly base = new Map<string, Outcome>();
  readonly calls: ScenarioRunInput[] = [];
  fallback: Outcome = PASS;

  async run(input: ScenarioRunInput): Promise<ScenarioRunResult> {
    this.calls.push(input);
    const table = input.patchFile === NO_PATCH ? this.base : this.patched;
    const outcome = table.get(keyOf(input.argv)) ?? this.fallback;
    if (outcome.throws === true) {
      throw new Error('runner could not execute (fake infrastructure failure)');
    }
    return {
      exitCode: outcome.exitCode,
      outputSha: outcome.outputSha,
      durationMs: 1,
      timedOut: outcome.timedOut ?? false,
      // A real runner reports counts; the double synthesises them from the exit code so
      // every existing case keeps its meaning without carrying a summary by hand.
      summary:
        outcome.summary ??
        (outcome.exitCode === null
          ? { passed: 0, failed: 0, unknown: 1, exitCode: null }
          : {
              passed: outcome.exitCode === 0 ? 12 : 0,
              failed: outcome.exitCode === 0 ? 0 : 3,
              unknown: 0,
              exitCode: outcome.exitCode,
            }),
    };
  }
}

function commandCriterion(id: string, target: string, expect: string): AcceptanceCriterion {
  return { id, text: `criterion ${id} holds`, oracle: { kind: 'command', target, expect } };
}

function commandRecord(
  argv: readonly string[],
  exitCode: number,
  outputSha: string,
): CommandRecord {
  return {
    argv: [...argv],
    cwd: 'worktree',
    exitCode,
    timedOut: false,
    outputSha,
    durationMs: 5,
  };
}

interface SpecParts {
  readonly acceptance?: AcceptanceCriterion[];
  readonly touchPaths?: string[];
  readonly operationClasses?: OperationClass[];
}

function makeSpec(parts: SpecParts = {}): UnitSpec {
  return {
    slug: 'add-probe',
    revision: 1,
    repo: '/repo',
    baseRev: BASE_REV,
    intent: 'Add a probe endpoint that answers with the unit id, so operators can see it.',
    restateBack: 'Add /probe returning the unit id as JSON, with a command oracle proving it.',
    acceptance: parts.acceptance ?? [
      commandCriterion('probe-answers', '["node","--probe","acceptance-ok"]', '0'),
    ],
    touchPaths: parts.touchPaths ?? ['src/'],
    operationClasses: parts.operationClasses ?? ['code-change'],
    sizeBudget: { files: 10, lines: 400 },
    budgetEstimateUsd: 2,
  };
}

function makeReceipt(commands: CommandRecord[]): DecisionReceipt {
  // Built as a full WorkerReceipt *with* a narrative and then stripped through
  // the contract's own barrier, so the test proves the barrier is what removes
  // prose rather than trusting the fixture to have omitted it.
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
    narrative: 'Perfect! All tests are passing. The implementation is complete and verified.',
  };
  return toDecisionReceipt(receipt);
}

function makeHoldout(taskClass: string, scenarios: HoldoutScenario[]): HoldoutStore {
  return { revision: 'r0001', taskClass, scenarios };
}

function holdoutScenario(
  id: string,
  extra: { dependsOn?: readonly string[] } = {},
): HoldoutScenario {
  const base: HoldoutScenario = {
    id,
    taskClass: 'core',
    argv: ['node', '.holdout/run.js', id],
    expectExit: [0],
  };
  return extra.dependsOn === undefined ? base : { ...base, dependsOn: extra.dependsOn };
}

/** A diff surface that reports exactly what the test wants it to have changed. */
function fakeDiff(
  files:
    | readonly {
        path: string;
        kind: 'added' | 'modified' | 'deleted';
        emptied?: boolean;
        removedAssertions?: number;
      }[]
    | null,
): DiffInspector {
  return {
    async changedFiles() {
      if (files === null) return null;
      return files.map((f) => ({
        path: f.path,
        kind: f.kind,
        emptied: f.emptied ?? false,
        removedAssertions: f.removedAssertions ?? 0,
      }));
    },
  };
}

const CLEAN_DIFF = fakeDiff([{ path: 'src/probe.ts', kind: 'added' }]);

function policy(
  over: { deltaThreshold?: number; runsPerScenario?: number; maxNonDiscriminating?: number } = {},
) {
  return {
    deltaThreshold: over.deltaThreshold ?? 0,
    commandTimeoutMs: 30_000,
    wallVersion: 'wall/0.1.0',
    runsPerScenario: over.runsPerScenario ?? 3,
    maxNonDiscriminating: over.maxNonDiscriminating ?? 0,
    // The wall always has an oracle of its own; a test that omitted it would only be
    // testing the "no oracle" path by accident.
    pinnedSuite: { argv: ['pnpm', 'test'] },
  };
}

// ---------------------------------------------------------------------------
// 1. THE DEFINING TEST
// ---------------------------------------------------------------------------

describe('the wall rejects a change that only satisfies its own tests', () => {
  it('a change that passes its own visible tests is still rejected', async () => {
    const spec = makeSpec();
    const receipt = makeReceipt([commandRecord(['pnpm', 'test'], 0, OK_SHA)]);
    const holdout = makeHoldout('core', [
      holdoutScenario('holdout-alpha'),
      holdoutScenario('holdout-beta'),
      holdoutScenario('holdout-gamma'),
    ]);

    const runner = new FakeRunner();
    // The visible suite: the acceptance oracle and the receipted command both pass.
    runner.patched.set(keyOf(['pnpm', 'test']), PASS);
    runner.patched.set(keyOf(['node', '--probe', 'acceptance-ok']), PASS);
    // The holdout: this is what the sabotage actually breaks.
    runner.patched.set(keyOf(['node', '.holdout/run.js', 'holdout-alpha']), FAIL);
    runner.patched.set(keyOf(['node', '.holdout/run.js', 'holdout-beta']), PASS);
    runner.patched.set(keyOf(['node', '.holdout/run.js', 'holdout-gamma']), PASS);
    // Base revision satisfies none of the holdout: Δ is measured and rising.
    runner.base.set(keyOf(['node', '.holdout/run.js', 'holdout-alpha']), FAIL);
    runner.base.set(keyOf(['node', '.holdout/run.js', 'holdout-beta']), FAIL);
    runner.base.set(keyOf(['node', '.holdout/run.js', 'holdout-gamma']), FAIL);

    const verdict = await evaluate({
      spec,
      receipt,
      holdout,
      runner,
      policy: policy(),
      diff: CLEAN_DIFF,
      nowIso: NOW,
    });

    expect(verdict.outcome).toBe('fail');
    expect(verdict.reasons).toContain('holdout_failed');
    // The agent learns only that it was not accepted — not which check failed.
    expect(workerFacingReason(verdict)).toBe('not accepted');
    expect(workerFacingReason(verdict)).not.toMatch(/holdout|delta|acceptance|scope/i);
    // The visible suite passing is precisely why this verdict has to exist.
    const visible = verdict.scenarios.filter((s) => s.source === 'acceptance');
    expect(visible.every((s) => s.outcome === 'pass')).toBe(true);
    // A fail verdict is a legitimate, earned verdict.
    expect(() => assertVerdictIsEarned(verdict)).not.toThrow();
  });
});

// ---------------------------------------------------------------------------
// 2–8. the individual checks
// ---------------------------------------------------------------------------

describe('evaluate', () => {
  async function passingVerdict(): Promise<Verdict> {
    const spec = makeSpec();
    const receipt = makeReceipt([commandRecord(['pnpm', 'test'], 0, OK_SHA)]);
    const holdout = makeHoldout('core', [
      holdoutScenario('holdout-alpha'),
      holdoutScenario('holdout-beta'),
    ]);
    const runner = new FakeRunner();
    runner.patched.set(keyOf(['pnpm', 'test']), PASS);
    runner.patched.set(keyOf(['node', '--probe', 'acceptance-ok']), PASS);
    runner.patched.set(keyOf(['node', '.holdout/run.js', 'holdout-alpha']), PASS);
    runner.patched.set(keyOf(['node', '.holdout/run.js', 'holdout-beta']), PASS);
    runner.base.set(keyOf(['node', '.holdout/run.js', 'holdout-alpha']), FAIL);
    runner.base.set(keyOf(['node', '.holdout/run.js', 'holdout-beta']), FAIL);
    return evaluate({
      spec,
      receipt,
      holdout,
      runner,
      policy: policy(),
      diff: CLEAN_DIFF,
      nowIso: NOW,
    });
  }

  it('passes when everything is measured, every scenario passes and Δ is met', async () => {
    const verdict = await passingVerdict();
    expect(verdict.outcome).toBe('pass');
    expect(verdict.reasons).toEqual([]);
    expect(verdict.delta.checked).toBe(true);
    expect(verdict.delta.baseRate).toBe(0);
    expect(verdict.delta.candidateRate).toBe(1);
    expect(verdict.delta.observed).toBe(1);
    expect(() => assertVerdictIsEarned(verdict)).not.toThrow();
    expect(verdict.holdoutRevision).toBe('r0001');
    expect(verdict.evaluatedAt).toBe(NOW);
  });

  it('rejects an unfaithful receipt even when the suite passed', async () => {
    const spec = makeSpec();
    // The receipt claims exit 0 for its command; re-execution observes exit 1.
    const receipt = makeReceipt([commandRecord(['pnpm', 'test'], 0, OK_SHA)]);
    const holdout = makeHoldout('core', [holdoutScenario('holdout-alpha')]);
    const runner = new FakeRunner();
    runner.patched.set(keyOf(['pnpm', 'test']), FAIL);
    runner.patched.set(keyOf(['node', '--probe', 'acceptance-ok']), PASS);
    runner.patched.set(keyOf(['node', '.holdout/run.js', 'holdout-alpha']), PASS);
    runner.base.set(keyOf(['node', '.holdout/run.js', 'holdout-alpha']), FAIL);

    const verdict = await evaluate({
      spec,
      receipt,
      holdout,
      runner,
      policy: policy(),
      diff: CLEAN_DIFF,
      nowIso: NOW,
    });

    expect(verdict.reasons).toContain('receipt_unfaithful');
    expect(verdict.outcome).not.toBe('pass');
  });

  it('treats a missing holdout as unknown, never as pass', async () => {
    const spec = makeSpec();
    const receipt = makeReceipt([commandRecord(['pnpm', 'test'], 0, OK_SHA)]);
    const runner = new FakeRunner();
    runner.patched.set(keyOf(['pnpm', 'test']), PASS);
    runner.patched.set(keyOf(['node', '--probe', 'acceptance-ok']), PASS);

    const verdict = await evaluate({
      spec,
      receipt,
      holdout: null,
      runner,
      policy: policy(),
      diff: CLEAN_DIFF,
      nowIso: NOW,
    });

    expect(verdict.outcome).toBe('unknown');
    expect(verdict.outcome).not.toBe('pass');
    expect(verdict.reasons).toContain('holdout_unavailable');
    expect(verdict.reasons).toContain('delta_unmeasured');
    expect(verdict.holdoutRevision).toBe(HOLDOUT_ABSENT_REVISION);
    expect(verdict.delta.checked).toBe(false);
    expect(() => assertVerdictIsEarned(verdict)).not.toThrow();
  });

  it('treats an unmeasurable base rate as an unmeasured Δ, which is unknown', async () => {
    const spec = makeSpec();
    const receipt = makeReceipt([commandRecord(['pnpm', 'test'], 0, OK_SHA)]);
    const holdout = makeHoldout('core', [holdoutScenario('holdout-alpha')]);
    const runner = new FakeRunner();
    runner.patched.set(keyOf(['pnpm', 'test']), PASS);
    runner.patched.set(keyOf(['node', '--probe', 'acceptance-ok']), PASS);
    runner.patched.set(keyOf(['node', '.holdout/run.js', 'holdout-alpha']), PASS);
    // The base checkout cannot be executed at all: nothing to compare against.
    runner.base.set(keyOf(['node', '.holdout/run.js', 'holdout-alpha']), { ...PASS, throws: true });

    const verdict = await evaluate({
      spec,
      receipt,
      holdout,
      runner,
      policy: policy(),
      diff: CLEAN_DIFF,
      nowIso: NOW,
    });

    expect(verdict.outcome).toBe('unknown');
    expect(verdict.reasons).toContain('delta_unmeasured');
    expect(verdict.delta.checked).toBe(false);
    expect(verdict.delta.observed).toBeNull();
  });

  it('rejects a Δ regression (candidate 0.60 against base 0.85)', async () => {
    const scenarios: HoldoutScenario[] = [];
    for (let i = 0; i < 20; i += 1) {
      scenarios.push(holdoutScenario(`scenario-${String(i).padStart(2, '0')}`));
    }
    const spec = makeSpec();
    const receipt = makeReceipt([commandRecord(['pnpm', 'test'], 0, OK_SHA)]);
    const runner = new FakeRunner();
    runner.patched.set(keyOf(['pnpm', 'test']), PASS);
    runner.patched.set(keyOf(['node', '--probe', 'acceptance-ok']), PASS);
    scenarios.forEach((s, i) => {
      const k = keyOf(s.argv);
      // base: 17/20 = 0.85, candidate: 12/20 = 0.60 → Δ -0.25 against threshold 0
      runner.base.set(k, i < 17 ? PASS : FAIL);
      runner.patched.set(k, i < 12 ? PASS : FAIL);
    });

    const verdict = await evaluate({
      spec,
      receipt,
      holdout: makeHoldout('core', scenarios),
      runner,
      policy: policy({ deltaThreshold: 0 }),
      diff: CLEAN_DIFF,
      nowIso: NOW,
    });

    expect(verdict.outcome).toBe('fail');
    expect(verdict.reasons).toContain('delta_regression');
    expect(verdict.delta.baseRate).toBeCloseTo(0.85, 10);
    expect(verdict.delta.candidateRate).toBeCloseTo(0.6, 10);
    expect(verdict.delta.observed).toBeCloseTo(-0.25, 10);
  });

  it('rejects a patch that deletes a test file', async () => {
    const spec = makeSpec();
    const receipt = makeReceipt([commandRecord(['pnpm', 'test'], 0, OK_SHA)]);
    const holdout = makeHoldout('core', [holdoutScenario('holdout-alpha')]);
    const runner = new FakeRunner();
    runner.patched.set(keyOf(['pnpm', 'test']), PASS);
    runner.patched.set(keyOf(['node', '--probe', 'acceptance-ok']), PASS);
    runner.patched.set(keyOf(['node', '.holdout/run.js', 'holdout-alpha']), PASS);
    runner.base.set(keyOf(['node', '.holdout/run.js', 'holdout-alpha']), FAIL);

    const verdict = await evaluate({
      spec,
      receipt,
      holdout,
      runner,
      policy: policy(),
      diff: fakeDiff([{ path: 'src/foo.test.ts', kind: 'deleted' }]),
      nowIso: NOW,
    });

    expect(verdict.reasons).toContain('tests_weakened');
    expect(verdict.outcome).toBe('fail');
  });

  it('rejects a patch that removes assertions from a test file', async () => {
    const verdictRunner = new FakeRunner();
    verdictRunner.patched.set(keyOf(['pnpm', 'test']), PASS);
    verdictRunner.patched.set(keyOf(['node', '--probe', 'acceptance-ok']), PASS);
    verdictRunner.patched.set(keyOf(['node', '.holdout/run.js', 'holdout-alpha']), PASS);
    verdictRunner.base.set(keyOf(['node', '.holdout/run.js', 'holdout-alpha']), FAIL);

    const verdict = await evaluate({
      spec: makeSpec(),
      receipt: makeReceipt([commandRecord(['pnpm', 'test'], 0, OK_SHA)]),
      holdout: makeHoldout('core', [holdoutScenario('holdout-alpha')]),
      runner: verdictRunner,
      policy: policy(),
      diff: fakeDiff([{ path: 'src/probe.test.ts', kind: 'modified', removedAssertions: 4 }]),
      nowIso: NOW,
    });

    expect(verdict.reasons).toContain('tests_weakened');
  });

  it('rejects a patch that deletes a file the holdout depends on', async () => {
    const runner = new FakeRunner();
    runner.patched.set(keyOf(['pnpm', 'test']), PASS);
    runner.patched.set(keyOf(['node', '--probe', 'acceptance-ok']), PASS);
    runner.patched.set(keyOf(['node', '.holdout/run.js', 'holdout-alpha']), PASS);
    runner.base.set(keyOf(['node', '.holdout/run.js', 'holdout-alpha']), FAIL);

    const verdict = await evaluate({
      spec: makeSpec(),
      receipt: makeReceipt([commandRecord(['pnpm', 'test'], 0, OK_SHA)]),
      holdout: makeHoldout('core', [
        holdoutScenario('holdout-alpha', { dependsOn: ['src/probe.ts'] }),
      ]),
      runner,
      policy: policy(),
      diff: fakeDiff([{ path: 'src/probe.ts', kind: 'deleted' }]),
      nowIso: NOW,
    });

    expect(verdict.reasons).toContain('tests_weakened');
  });

  it('rejects a change outside the declared touch paths', async () => {
    const runner = new FakeRunner();
    runner.patched.set(keyOf(['pnpm', 'test']), PASS);
    runner.patched.set(keyOf(['node', '--probe', 'acceptance-ok']), PASS);
    runner.patched.set(keyOf(['node', '.holdout/run.js', 'holdout-alpha']), PASS);
    runner.base.set(keyOf(['node', '.holdout/run.js', 'holdout-alpha']), FAIL);

    const verdict = await evaluate({
      spec: makeSpec({ touchPaths: ['src/'] }),
      receipt: makeReceipt([commandRecord(['pnpm', 'test'], 0, OK_SHA)]),
      holdout: makeHoldout('core', [holdoutScenario('holdout-alpha')]),
      runner,
      policy: policy(),
      diff: fakeDiff([
        { path: 'src/probe.ts', kind: 'modified' },
        { path: 'infra/production.tf', kind: 'modified' },
      ]),
      nowIso: NOW,
    });

    expect(verdict.reasons).toContain('scope_violation');
    expect(verdict.outcome).toBe('fail');
  });

  it('rejects a unit whose declared operation class is irreversible', async () => {
    const verdict = await evaluate({
      spec: makeSpec({ operationClasses: ['schema-migration'] }),
      receipt: makeReceipt([commandRecord(['pnpm', 'test'], 0, OK_SHA)]),
      holdout: null,
      runner: new FakeRunner(),
      policy: policy(),
      diff: CLEAN_DIFF,
      nowIso: NOW,
    });

    expect(verdict.reasons).toContain('irreversible_operation');
    expect(verdict.outcome).toBe('fail');
  });

  it('cannot certify a change when the diff surface is unavailable', async () => {
    const runner = new FakeRunner();
    runner.patched.set(keyOf(['pnpm', 'test']), PASS);
    runner.patched.set(keyOf(['node', '--probe', 'acceptance-ok']), PASS);
    runner.patched.set(keyOf(['node', '.holdout/run.js', 'holdout-alpha']), PASS);
    runner.base.set(keyOf(['node', '.holdout/run.js', 'holdout-alpha']), FAIL);

    const verdict = await evaluate({
      spec: makeSpec(),
      receipt: makeReceipt([commandRecord(['pnpm', 'test'], 0, OK_SHA)]),
      holdout: makeHoldout('core', [holdoutScenario('holdout-alpha')]),
      runner,
      policy: policy(),
      // No diff surface supplied at all: the wall cannot see what changed.
      nowIso: NOW,
    });

    expect(verdict.outcome).toBe('unknown');
    expect(verdict.outcome).not.toBe('pass');
  });

  it('treats an unimplemented oracle kind as unmeasured, not as satisfied', async () => {
    const spec = makeSpec({
      acceptance: [
        {
          id: 'endpoint-live',
          text: 'the probe endpoint answers over HTTP',
          oracle: { kind: 'http', target: 'http://127.0.0.1:8080/probe', expect: '200' },
        },
      ],
    });
    const runner = new FakeRunner();
    runner.patched.set(keyOf(['pnpm', 'test']), PASS);
    runner.patched.set(keyOf(['node', '.holdout/run.js', 'holdout-alpha']), PASS);
    runner.base.set(keyOf(['node', '.holdout/run.js', 'holdout-alpha']), FAIL);

    const verdict = await evaluate({
      spec,
      receipt: makeReceipt([commandRecord(['pnpm', 'test'], 0, OK_SHA)]),
      holdout: makeHoldout('core', [holdoutScenario('holdout-alpha')]),
      runner,
      policy: policy(),
      diff: CLEAN_DIFF,
      nowIso: NOW,
    });

    expect(verdict.outcome).toBe('unknown');
    expect(verdict.reasons).toContain('acceptance_unmeasured');
  });

  it('rejects an unfaithful receipt whose base revision is not the spec base', async () => {
    const spec = makeSpec();
    const receipt = makeReceipt([commandRecord(['pnpm', 'test'], 0, OK_SHA)]);
    const moved: DecisionReceipt = {
      ...receipt,
      diff: { ...receipt.diff, baseRev: 'b'.repeat(40) },
    };

    const verdict = await evaluate({
      spec,
      receipt: moved,
      holdout: null,
      runner: new FakeRunner(),
      policy: policy(),
      diff: CLEAN_DIFF,
      nowIso: NOW,
    });

    expect(verdict.reasons).toContain('receipt_unfaithful');
    expect(verdict.outcome).toBe('fail');
  });
});

// ---------------------------------------------------------------------------
// 9–11. wall properties: opacity, determinism, purity
// ---------------------------------------------------------------------------

describe('the verdict is opaque to the agent that reads it', () => {
  it('carries no scenario id, no argv and no criterion text', async () => {
    const secretArgv = ['node', '.holdout/run.js', 'HOLDOUT_ARG_TOKEN'];
    const holdout: HoldoutStore = {
      revision: 'r0001',
      taskClass: 'core',
      scenarios: [
        { id: 'HOLDOUT_SCENARIO_ALPHA', taskClass: 'core', argv: secretArgv, expectExit: [0] },
        {
          id: 'HOLDOUT_SCENARIO_BETA',
          taskClass: 'core',
          argv: ['node', '.holdout/run.js', 'BETA'],
          expectExit: [0],
        },
      ],
    };
    const spec = makeSpec({
      acceptance: [
        {
          id: 'probe-answers',
          text: 'ACCEPTANCE_CRITERION_TEXT the probe returns the unit id',
          oracle: { kind: 'command', target: '["node","--probe","acceptance-ok"]', expect: '0' },
        },
      ],
    });
    const runner = new FakeRunner();
    runner.patched.set(keyOf(['pnpm', 'test']), PASS);
    runner.patched.set(keyOf(['node', '--probe', 'acceptance-ok']), PASS);
    runner.patched.set(keyOf(secretArgv), FAIL);
    runner.patched.set(keyOf(['node', '.holdout/run.js', 'BETA']), FAIL);
    runner.base.set(keyOf(secretArgv), FAIL);
    runner.base.set(keyOf(['node', '.holdout/run.js', 'BETA']), FAIL);

    const verdict = await evaluate({
      spec,
      receipt: makeReceipt([commandRecord(['pnpm', 'test'], 0, OK_SHA)]),
      holdout,
      runner,
      policy: policy(),
      diff: CLEAN_DIFF,
      nowIso: NOW,
    });

    const serialized = JSON.stringify(verdict);
    expect(serialized).not.toContain('HOLDOUT_SCENARIO_ALPHA');
    expect(serialized).not.toContain('HOLDOUT_SCENARIO_BETA');
    expect(serialized).not.toContain('HOLDOUT_ARG_TOKEN');
    expect(serialized).not.toContain('ACCEPTANCE_CRITERION_TEXT');
    // The operator line is human-facing, and it is still held to the same rule.
    const line = oneLineReason(verdict);
    expect(line).not.toContain('HOLDOUT_SCENARIO_ALPHA');
    expect(line).not.toContain('HOLDOUT_ARG_TOKEN');
    expect(line).not.toContain('ACCEPTANCE_CRITERION_TEXT');
    // …but it must still be useful: the operator needs a count and the reason codes.
    expect(line).toMatch(/^REJECTED: /);
    expect(line).toContain('holdout_failed');
    // Three holdout-sourced checks now: the two scenarios plus `holdout:quality`
    // (the discrimination control), which passes here because both scenarios fail on
    // the base revision. The denominator is pinned exactly, so a check that silently
    // stops being reported fails this test rather than shrinking the line politely.
    expect(line).toMatch(/2 of 3 scenarios failed/);
  });
});

describe('determinism', () => {
  it('produces a deep-equal verdict from the same inputs, with a fixed evaluatedAt', async () => {
    const spec = makeSpec();
    const receipt = makeReceipt([commandRecord(['pnpm', 'test'], 0, OK_SHA)]);
    const holdout = makeHoldout('core', [
      holdoutScenario('holdout-alpha'),
      holdoutScenario('holdout-beta'),
    ]);

    function makeRunner(): FakeRunner {
      const r = new FakeRunner();
      r.patched.set(keyOf(['pnpm', 'test']), PASS);
      r.patched.set(keyOf(['node', '--probe', 'acceptance-ok']), PASS);
      r.patched.set(keyOf(['node', '.holdout/run.js', 'holdout-alpha']), PASS);
      r.patched.set(keyOf(['node', '.holdout/run.js', 'holdout-beta']), FAIL);
      r.base.set(keyOf(['node', '.holdout/run.js', 'holdout-alpha']), FAIL);
      r.base.set(keyOf(['node', '.holdout/run.js', 'holdout-beta']), FAIL);
      return r;
    }

    const first = await evaluate({
      spec,
      receipt,
      holdout,
      runner: makeRunner(),
      policy: policy(),
      diff: CLEAN_DIFF,
      nowIso: NOW,
    });
    const second = await evaluate({
      spec,
      receipt,
      holdout,
      runner: makeRunner(),
      policy: policy(),
      diff: CLEAN_DIFF,
      nowIso: NOW,
    });

    expect(second).toEqual(first);
    expect(second.evaluatedAt).toBe(first.evaluatedAt);
    expect(JSON.stringify(second)).toBe(JSON.stringify(first));
  });
});

/**
 * Source with comments removed.
 *
 * The purity rules are about code. Several modules *document* the rule they obey
 * ("duration comes from `performance.now()`, not `Date.now()`"), and a grep that
 * fires on that prose punishes the explanation instead of the violation — which
 * teaches the next author to delete the explanation. Strip comments, then assert.
 */
function codeOnly(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');
}

describe('the package is offline and model-free', () => {
  it('imports no network client and no model SDK anywhere in src', () => {
    const dir = dirname(fileURLToPath(import.meta.url));
    const sources = readdirSync(dir).filter((f) => f.endsWith('.ts') && !f.endsWith('.test.ts'));
    expect(sources.length).toBeGreaterThan(0);
    const banned = [
      /from\s+['"]node:http['"]/,
      /from\s+['"]node:https['"]/,
      /from\s+['"]node:net['"]/,
      /from\s+['"]node:dgram['"]/,
      /from\s+['"]undici['"]/,
      /from\s+['"]axios['"]/,
      /\bfetch\s*\(/,
      /\bXMLHttpRequest\b/,
      /from\s+['"]openai['"]/,
      /from\s+['"]@anthropic-ai\//,
      /from\s+['"]@ai-sdk\//,
    ];
    for (const file of sources) {
      const text = codeOnly(readFileSync(join(dir, file), 'utf8'));
      for (const pattern of banned) {
        expect(text, `${file} must not match ${String(pattern)}`).not.toMatch(pattern);
      }
    }
  });

  it('never reaches for the wall clock: evaluatedAt comes from the caller', () => {
    const dir = dirname(fileURLToPath(import.meta.url));
    const sources = readdirSync(dir).filter((f) => f.endsWith('.ts') && !f.endsWith('.test.ts'));
    for (const file of sources) {
      const text = codeOnly(readFileSync(join(dir, file), 'utf8'));
      expect(text, `${file} must not read the clock`).not.toMatch(/Date\.now|new Date\(/);
    }
  });
});

// ---------------------------------------------------------------------------
// small exported predicates, tested directly
// ---------------------------------------------------------------------------

describe('pathIsInScope', () => {
  it('accepts an exact path, a directory prefix and a glob', () => {
    expect(pathIsInScope('src/probe.ts', ['src/probe.ts'])).toBe(true);
    expect(pathIsInScope('src/deep/probe.ts', ['src/'])).toBe(true);
    expect(pathIsInScope('src/deep/probe.ts', ['src'])).toBe(true);
    expect(pathIsInScope('src/deep/probe.ts', ['src/**'])).toBe(true);
    expect(pathIsInScope('tests/a.test.ts', ['tests/*.test.ts'])).toBe(true);
  });

  it('refuses everything when no touch path is declared', () => {
    expect(pathIsInScope('src/probe.ts', [])).toBe(false);
  });

  it('refuses a path that only looks like a prefix match', () => {
    expect(pathIsInScope('src-evil/probe.ts', ['src'])).toBe(false);
    expect(pathIsInScope('src/deep/probe.ts', ['src/*.ts'])).toBe(false);
    expect(pathIsInScope('../outside.ts', ['src/'])).toBe(false);
    // A traversal segment that would otherwise satisfy a plausible prefix.
    expect(pathIsInScope('src/../etc/passwd', ['src/'])).toBe(false);
    expect(pathIsInScope('/etc/passwd', ['src/'])).toBe(false);
  });
});

describe('isDestructiveArgv', () => {
  it('flags the destructive verbs from the incident corpus', () => {
    expect(isDestructiveArgv(['git', 'push', '--force', 'origin', 'main'])).toBe(true);
    expect(isDestructiveArgv(['git', 'reset', '--hard', 'HEAD~1'])).toBe(true);
    expect(isDestructiveArgv(['rm', '-rf', '/var/lib/data'])).toBe(true);
    expect(
      isDestructiveArgv(['git', 'filter-repo', '--strip-blobs-bigger-than', '500K', '--force']),
    ).toBe(true);
    expect(isDestructiveArgv(['psql', '-c', 'drop table users'])).toBe(true);
  });

  it('does not flag the safe variant, so the denylist stays honest', () => {
    expect(isDestructiveArgv(['git', 'push', '--force-with-lease', 'origin', 'main'])).toBe(false);
    expect(isDestructiveArgv(['pnpm', 'test'])).toBe(false);
    expect(isDestructiveArgv(['git', 'status'])).toBe(false);
  });
});

// Keep the helper honest: the writer used by holdout.test.ts must round-trip.
describe('test helper sanity', () => {
  it('writes a holdout store that loadHoldout can read back', async () => {
    const { loadHoldout } = await import('./holdout.ts');
    const root = mkdtempSync(join(tmpdir(), 'wall-fixture-'));
    const store = makeHoldout('core', [holdoutScenario('holdout-alpha')]);
    const revisionHash = writeHoldoutStore(root, store);
    expect(revisionHash).toMatch(/^sha256:[0-9a-f]{64}$/);
    const loaded = loadHoldout(root, 'core');
    expect(loaded?.revision).toBe(store.revision);
    expect(loaded?.scenarios.map((s) => s.id)).toEqual(['holdout-alpha']);
    // Silence an unused-write warning path in editors: the file must exist.
    expect(readFileSync(join(root, 'core', 'r0001', 'manifest.json'), 'utf8')).toContain(
      'holdout-alpha',
    );
    writeFileSync(join(root, 'sentinel'), 'ok');
  });
});

// ---------------------------------------------------------------------------
// 9. repeated execution: 2-of-3, so one lucky run cannot decide anything
// ---------------------------------------------------------------------------

/**
 * A runner that returns a scripted sequence per (side, argv).
 *
 * `FakeRunner` answers from a table, which cannot express "flaky". This one is the
 * only way to test a majority: the same command must be able to pass and fail within
 * one evaluation.
 */
class SequenceRunner implements ScenarioRunner {
  readonly sequences = new Map<string, Outcome[]>();
  readonly calls: ScenarioRunInput[] = [];

  script(side: 'patched' | 'base', argv: readonly string[], outcomes: readonly Outcome[]): void {
    this.sequences.set(`${side}\u0000${keyOf(argv)}`, [...outcomes]);
  }

  async run(input: ScenarioRunInput): Promise<ScenarioRunResult> {
    this.calls.push(input);
    const key = `${input.patchFile === NO_PATCH ? 'base' : 'patched'}\u0000${keyOf(input.argv)}`;
    const queue = this.sequences.get(key);
    const outcome =
      queue === undefined || queue.length === 0
        ? PASS
        : queue.length === 1
          ? queue[0]
          : queue.shift();
    if (outcome === undefined || outcome.throws === true) {
      throw new Error('runner could not execute (fake infrastructure failure)');
    }
    return {
      exitCode: outcome.exitCode,
      outputSha: outcome.outputSha,
      durationMs: 1,
      timedOut: outcome.timedOut ?? false,
      summary:
        outcome.summary ??
        (outcome.exitCode === null
          ? { passed: 0, failed: 0, unknown: 1, exitCode: null }
          : {
              passed: outcome.exitCode === 0 ? 12 : 0,
              failed: outcome.exitCode === 0 ? 0 : 3,
              unknown: 0,
              exitCode: outcome.exitCode,
            }),
    };
  }
}

const TIMEOUT: Outcome = { exitCode: null, outputSha: FAIL_SHA, timedOut: true };

function oracleVerdictRunner(): {
  runner: SequenceRunner;
  spec: UnitSpec;
  receipt: DecisionReceipt;
  holdout: HoldoutStore;
} {
  const spec = makeSpec();
  const receipt = makeReceipt([commandRecord(['pnpm', 'test'], 0, OK_SHA)]);
  const holdout = makeHoldout('core', [holdoutScenario('holdout-alpha')]);
  const runner = new SequenceRunner();
  runner.script('patched', ['pnpm', 'test'], [PASS]);
  runner.script('patched', ['node', '.holdout/run.js', 'holdout-alpha'], [PASS]);
  runner.script('base', ['node', '.holdout/run.js', 'holdout-alpha'], [FAIL]);
  return { runner, spec, receipt, holdout };
}

describe('repeated execution', () => {
  it('treats two of three passing runs as a pass, not a coin toss', async () => {
    const { runner, spec, receipt, holdout } = oracleVerdictRunner();
    runner.script('patched', ['node', '--probe', 'acceptance-ok'], [PASS, PASS, FAIL]);

    const verdict = await evaluate({
      spec,
      receipt,
      holdout,
      runner,
      policy: policy(),
      diff: CLEAN_DIFF,
      nowIso: NOW,
    });

    expect(verdict.outcome).toBe('pass');
    const oracleCalls = runner.calls.filter(
      (call) => keyOf(call.argv) === keyOf(['node', '--probe', 'acceptance-ok']),
    );
    // Two agreeing runs settle it; the third cannot change the answer, so it is not run.
    expect(oracleCalls).toHaveLength(2);
  });

  it('treats two of three failing runs as a fail, so one lucky run cannot rescue a sabotage', async () => {
    const { runner, spec, receipt, holdout } = oracleVerdictRunner();
    runner.script('patched', ['node', '--probe', 'acceptance-ok'], [PASS, FAIL, FAIL]);

    const verdict = await evaluate({
      spec,
      receipt,
      holdout,
      runner,
      policy: policy(),
      diff: CLEAN_DIFF,
      nowIso: NOW,
    });

    expect(verdict.outcome).toBe('fail');
    expect(verdict.reasons).toContain('acceptance_unmet');
  });

  it('treats a split verdict as unknown — never pass, never fail', async () => {
    const { runner, spec, receipt, holdout } = oracleVerdictRunner();
    // One pass, one fail, one timeout: the instrument disagreed with itself.
    runner.script('patched', ['node', '--probe', 'acceptance-ok'], [PASS, FAIL, TIMEOUT]);

    const verdict = await evaluate({
      spec,
      receipt,
      holdout,
      runner,
      policy: policy(),
      diff: CLEAN_DIFF,
      nowIso: NOW,
    });

    expect(verdict.outcome).toBe('unknown');
    expect(verdict.reasons).toContain('acceptance_unmeasured');
    const oracle = verdict.scenarios.find((scenario) => scenario.id === 'acceptance:probe-answers');
    expect(oracle?.outcome).toBe('unknown');
    // All three runs were needed: no two ever agreed.
    expect(
      runner.calls.filter(
        (call) => keyOf(call.argv) === keyOf(['node', '--probe', 'acceptance-ok']),
      ),
    ).toHaveLength(3);
  });

  it('runs each holdout scenario on both sides three times by default', async () => {
    const { runner, spec, receipt, holdout } = oracleVerdictRunner();

    await evaluate({
      spec,
      receipt,
      holdout,
      runner,
      policy: policy(),
      diff: CLEAN_DIFF,
      nowIso: NOW,
    });

    const patchedHoldout = runner.calls.filter(
      (call) =>
        call.patchFile !== NO_PATCH &&
        keyOf(call.argv) === keyOf(['node', '.holdout/run.js', 'holdout-alpha']),
    );
    const baseHoldout = runner.calls.filter(
      (call) =>
        call.patchFile === NO_PATCH &&
        keyOf(call.argv) === keyOf(['node', '.holdout/run.js', 'holdout-alpha']),
    );
    expect(patchedHoldout).toHaveLength(2);
    expect(baseHoldout).toHaveLength(2);
  });

  it('refuses an even repeat count instead of resolving ties by accident', async () => {
    const { runner, spec, receipt, holdout } = oracleVerdictRunner();

    await expect(
      evaluate({
        spec,
        receipt,
        holdout,
        runner,
        policy: { ...policy(), runsPerScenario: 2 },
        diff: CLEAN_DIFF,
        nowIso: NOW,
      }),
    ).rejects.toThrow(/odd integer/);
    // Nothing ran: an invalid configuration must not spend executions before failing.
    expect(runner.calls).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// 10. the non-discriminating holdout — the control that stops a wall approving all
// ---------------------------------------------------------------------------

describe('holdout discrimination', () => {
  function bluntRunner(): {
    runner: FakeRunner;
    spec: UnitSpec;
    receipt: DecisionReceipt;
    holdout: HoldoutStore;
  } {
    const spec = makeSpec();
    const receipt = makeReceipt([commandRecord(['pnpm', 'test'], 0, OK_SHA)]);
    const holdout = makeHoldout('core', [
      holdoutScenario('holdout-alpha'),
      holdoutScenario('holdout-beta'),
    ]);
    const runner = new FakeRunner();
    runner.patched.set(keyOf(['pnpm', 'test']), PASS);
    runner.patched.set(keyOf(['node', '--probe', 'acceptance-ok']), PASS);
    // Both holdout scenarios pass WITHOUT the change: they cannot distinguish it.
    runner.patched.set(keyOf(['node', '.holdout/run.js', 'holdout-alpha']), PASS);
    runner.patched.set(keyOf(['node', '.holdout/run.js', 'holdout-beta']), PASS);
    runner.base.set(keyOf(['node', '.holdout/run.js', 'holdout-alpha']), PASS);
    runner.base.set(keyOf(['node', '.holdout/run.js', 'holdout-beta']), PASS);
    return { runner, spec, receipt, holdout };
  }

  it('refuses to certify a holdout that already passes on the base revision', async () => {
    const { runner, spec, receipt, holdout } = bluntRunner();

    const verdict = await evaluate({
      spec,
      receipt,
      holdout,
      runner,
      policy: policy(),
      diff: CLEAN_DIFF,
      nowIso: NOW,
    });

    // Delta = 1.00 - 1.00 = 0, which clears a threshold of 0. Before this control that
    // was a pass: a wall built from blunt scenarios approves everything and says so in
    // a green verdict. Now it is `unknown` with a reason.
    expect(verdict.delta.observed).toBe(0);
    expect(verdict.delta.checked).toBe(true);
    expect(verdict.outcome).toBe('unknown');
    expect(verdict.reasons).toContain('holdout_not_discriminating');
    expect(verdict.reasons).not.toContain('delta_regression');
    expect(() => assertVerdictIsEarned(verdict)).not.toThrow();
  });

  it('prints the instrument and its threshold in the operator line', async () => {
    const { runner, spec, receipt, holdout } = bluntRunner();

    const verdict = await evaluate({
      spec,
      receipt,
      holdout,
      runner,
      policy: policy(),
      diff: CLEAN_DIFF,
      nowIso: NOW,
    });
    const line = oneLineReason(verdict);

    expect(line).toMatch(/^UNVERIFIED: /);
    expect(line).toContain('holdout_not_discriminating');
    // The operator has to be able to see the instrument, not just the verdict.
    expect(line).toContain(
      '2 of 2 holdout scenarios pass on every base revision — the holdout cannot distinguish this change from the base (threshold 0)',
    );
    // …and it still must not name a scenario.
    expect(line).not.toContain('holdout-alpha');
    expect(line).not.toContain('holdout-beta');
  });

  it('honours the operator threshold instead of hard-coding zero', async () => {
    const { runner, spec, receipt, holdout } = bluntRunner();

    const verdict = await evaluate({
      spec,
      receipt,
      holdout,
      runner,
      policy: policy({ maxNonDiscriminating: 2 }),
      diff: CLEAN_DIFF,
      nowIso: NOW,
    });

    expect(verdict.outcome).toBe('pass');
    expect(verdict.reasons).toEqual([]);
  });

  it('degrades when the criteria log is damaged, rather than treating damage as a clean slate', async () => {
    const { runner, spec, receipt, holdout } = bluntRunner();
    // The live measurement alone would be damning anyway; the point is that a log a
    // candidate can damage must never read as "no history, therefore nothing wrong".
    const port: CriteriaLogPort = {
      read: (): CriteriaLogReadResult => ({ entries: [], corruptLines: 1 }),
      record: () => undefined,
    };

    const verdict = await evaluate({
      spec,
      receipt,
      holdout,
      runner,
      policy: policy({ maxNonDiscriminating: 2 }),
      diff: CLEAN_DIFF,
      criteriaLog: port,
      nowIso: NOW,
    });

    expect(verdict.outcome).toBe('unknown');
    expect(verdict.reasons).toContain('holdout_unavailable');
    const quality = verdict.scenarios.find((scenario) => scenario.id === 'holdout:quality');
    expect(quality?.observed).toContain('unparseable');
  });

  it('accumulates history rather than judging a scenario on one base run', async () => {
    const spec = makeSpec();
    const receipt = makeReceipt([commandRecord(['pnpm', 'test'], 0, OK_SHA)]);
    const holdout = makeHoldout('core', [holdoutScenario('holdout-alpha')]);
    const runner = new FakeRunner();
    runner.patched.set(keyOf(['pnpm', 'test']), PASS);
    runner.patched.set(keyOf(['node', '--probe', 'acceptance-ok']), PASS);
    runner.patched.set(keyOf(['node', '.holdout/run.js', 'holdout-alpha']), PASS);
    runner.base.set(keyOf(['node', '.holdout/run.js', 'holdout-alpha']), PASS);

    // History: the scenario has failed on the base before, so it *can* distinguish —
    // one live base pass is not enough to condemn it.
    const history: CriteriaLogEntry[] = [
      {
        taskClass: 'core',
        holdoutRevision: 'r0001',
        scenarioId: 'holdout-alpha',
        revision: 'older-base',
        side: 'base',
        outcome: 'fail',
        at: '2026-10-01T00:00:00.000Z',
      },
    ];
    const recorded: CriteriaLogEntry[][] = [];
    const port: CriteriaLogPort = {
      read: () => ({ entries: history, corruptLines: 0 }),
      record: (entries) => {
        recorded.push([...entries]);
      },
    };

    const verdict = await evaluate({
      spec,
      receipt,
      holdout,
      runner,
      policy: policy(),
      diff: CLEAN_DIFF,
      criteriaLog: port,
      nowIso: NOW,
    });

    expect(verdict.outcome).toBe('pass');
    expect(recorded).toHaveLength(1);
  });

  it('records both sides of every scenario it ran, stamped with the caller clock', async () => {
    const { runner, spec, receipt, holdout } = oracleVerdictRunner();
    const recorded: CriteriaLogEntry[][] = [];
    const port: CriteriaLogPort = {
      read: () => ({ entries: [], corruptLines: 0 }),
      record: (entries) => {
        recorded.push([...entries]);
      },
    };

    await evaluate({
      spec,
      receipt,
      holdout,
      runner,
      policy: policy(),
      diff: CLEAN_DIFF,
      criteriaLog: port,
      nowIso: NOW,
    });

    const entries = recorded[0] ?? [];
    expect(entries).toHaveLength(2);
    expect(entries.map((entry) => entry.side).sort()).toEqual(['base', 'candidate']);
    expect(entries.map((entry) => entry.outcome).sort()).toEqual(['fail', 'pass']);
    expect(entries.every((entry) => entry.at === NOW)).toBe(true);
    expect(
      entries.every((entry) => entry.taskClass === 'core' && entry.holdoutRevision === 'r0001'),
    ).toBe(true);
    // The live measurement decided the verdict; the log is written afterwards.
    expect(entries.every((entry) => entry.revision === BASE_REV)).toBe(true);
  });
});
