/**
 * The amended rules (consensus-plan §A4, §A5, §A6, §A10), tested where they bite.
 *
 * Kept apart from `evaluate.test.ts` because these are not the wall's original laws — they
 * are the corrections the architecture debate forced after the first implementation, and a
 * reader should be able to see exactly what changed without diffing a 1300-line file.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  assertVerdictIsEarned,
  sha256Hex,
  toDecisionReceipt,
  type AcceptanceCriterion,
  type DecisionReceipt,
  type UnitSpec,
  type Verdict,
} from '@factory/contracts';
import {
  NO_PATCH,
  evaluate,
  type DiffInspector,
  type ScenarioRunner,
  type ScenarioRunInput,
  type ScenarioRunResult,
} from './evaluate.ts';
import type { HoldoutStore } from './holdout.ts';
import { oneLineReason, workerFacingReason } from './reasons.ts';
import { SENSITIVE_PATH_PATTERNS, assessSecurityPaths } from './security-path.ts';

const BASE_REV = 'b'.repeat(40);
const NOW = '2026-12-01T00:00:00.000Z';
const OK_SHA = `sha256:${sha256Hex('ok')}`;

const PASS_SUMMARY = { passed: 12, failed: 0, unknown: 0, exitCode: 0 };
const RED_SUMMARY = { passed: 9, failed: 3, unknown: 0, exitCode: 1 };

interface Outcome {
  readonly exitCode: number | null;
  readonly summary?: {
    readonly passed: number;
    readonly failed: number;
    readonly unknown: number;
    readonly exitCode: number | null;
  };
}

const PASS: Outcome = { exitCode: 0, summary: PASS_SUMMARY };
const HOLD_FAIL: Outcome = { exitCode: 1, summary: RED_SUMMARY };

class TableRunner implements ScenarioRunner {
  readonly patched = new Map<string, Outcome>();
  readonly base = new Map<string, Outcome>();

  async run(input: ScenarioRunInput): Promise<ScenarioRunResult> {
    const table = input.patchFile === NO_PATCH ? this.base : this.patched;
    const outcome = table.get(input.argv.join('\u0000')) ?? PASS;
    return {
      exitCode: outcome.exitCode,
      outputSha: OK_SHA,
      durationMs: 1,
      timedOut: false,
      ...(outcome.summary === undefined ? {} : { summary: outcome.summary }),
    };
  }
}

function criterion(): AcceptanceCriterion {
  return {
    id: 'probe-answers',
    text: 'criterion probe-answers holds',
    oracle: { kind: 'command', target: '["node","--probe","ok"]', expect: '0' },
  };
}

function makeSpec(
  over: {
    readonly touchPaths?: string[];
    readonly operationClasses?: UnitSpec['operationClasses'];
  } = {},
): UnitSpec {
  return {
    slug: 'add-probe',
    revision: 1,
    repo: '/repo',
    baseRev: BASE_REV,
    intent: 'Add a probe endpoint that answers with the unit id, so operators can see it.',
    restateBack: 'Add /probe returning the unit id as JSON, with a command oracle proving it.',
    acceptance: [criterion()],
    touchPaths: over.touchPaths ?? ['src/'],
    operationClasses: over.operationClasses ?? ['code-change'],
    sizeBudget: { files: 10, lines: 400 },
    budgetEstimateUsd: 2,
  };
}

function makeReceipt(statusPaths?: string[]): DecisionReceipt {
  const diff = {
    patchFile: '/attempts/a/change.patch',
    sha: `sha256:${sha256Hex('patch')}`,
    filesChanged: 1,
    insertions: 10,
    deletions: 0,
    baseRev: BASE_REV,
    ...(statusPaths === undefined ? {} : { statusPaths }),
  };
  return toDecisionReceipt({
    unitId: 'unit-1',
    attemptId: 'attempt-1',
    sessionId: 'session-1',
    startedAt: '2026-12-01T00:00:00.000Z',
    endedAt: '2026-12-01T00:30:00.000Z',
    exitCode: 0,
    diff,
    commands: [
      {
        argv: ['pnpm', 'test'],
        cwd: 'worktree',
        exitCode: 0,
        timedOut: false,
        outputSha: OK_SHA,
        durationMs: 5,
      },
    ],
    suite: {
      command: ['pnpm', 'test'],
      exitCode: 0,
      passed: 12,
      failed: 0,
      skipped: 0,
      unknown: 0,
    },
    ceilings: { turnsUsed: 8, wallClockMs: 900_000, hit: [] },
    artifacts: [],
    narrative: 'All tests are passing. The implementation is complete.',
  });
}

function makeHoldout(): HoldoutStore {
  return {
    revision: 'r0001',
    taskClass: 'core',
    scenarios: [
      {
        id: 'alpha',
        taskClass: 'core',
        argv: ['node', '.holdout/run.js', 'alpha'],
        expectExit: [0],
      },
    ],
  };
}

function fakeDiff(
  files: readonly { path: string; kind: 'added' | 'modified' | 'deleted' }[] | null,
): DiffInspector {
  return {
    async changedFiles() {
      return files === null
        ? null
        : files.map((file) => ({ ...file, emptied: false, removedAssertions: 0 }));
    },
  };
}

function policy(
  over: {
    readonly pinned?: boolean;
    readonly minDeltaSamples?: number;
    readonly imageDigest?: string;
  } = {},
) {
  return {
    deltaThreshold: 0,
    commandTimeoutMs: 30_000,
    wallVersion: 'wall/0.1.0',
    runsPerScenario: 1,
    maxNonDiscriminating: 0,
    ...(over.pinned === false ? {} : { pinnedSuite: { argv: ['pnpm', 'test'] } }),
    ...(over.minDeltaSamples === undefined ? {} : { minDeltaSamples: over.minDeltaSamples }),
    ...(over.imageDigest === undefined ? {} : { imageDigest: over.imageDigest }),
  };
}

/** A unit that is green everywhere unless a test changes one thing. */
function runner(): TableRunner {
  const fake = new TableRunner();
  fake.patched.set('pnpm\u0000test', PASS);
  fake.patched.set('node\u0000--probe\u0000ok', PASS);
  fake.patched.set('node\u0000.holdout/run.js\u0000alpha', PASS);
  fake.base.set('node\u0000.holdout/run.js\u0000alpha', HOLD_FAIL);
  return fake;
}

function cleanDiff(): DiffInspector {
  return fakeDiff([{ path: 'src/probe.ts', kind: 'added' }]);
}

describe('A4.2 / A6 — the test surface is not part of the change', () => {
  it('refuses a change that reaches the test surface, naming the path for the operator', async () => {
    const verdict = await evaluate({
      spec: makeSpec(),
      receipt: makeReceipt(),
      holdout: makeHoldout(),
      runner: runner(),
      policy: policy(),
      diff: fakeDiff([
        { path: 'src/probe.ts', kind: 'added' },
        { path: 'package.json', kind: 'modified' },
      ]),
      nowIso: NOW,
    });

    expect(verdict.outcome).toBe('fail');
    expect(verdict.reasons).toContain('test_surface_changed');
    // The agent wrote the path, so naming it leaks nothing it does not already have; the
    // worker still learns only that it was refused.
    expect(oneLineReason(verdict)).toContain('package.json');
    expect(workerFacingReason(verdict)).toBe('not accepted');
  });

  it('treats a missing diff surface as "cannot check", never as clean', async () => {
    const verdict = await evaluate({
      spec: makeSpec(),
      receipt: makeReceipt(),
      holdout: makeHoldout(),
      runner: runner(),
      policy: policy(),
      diff: fakeDiff(null),
      nowIso: NOW,
    });

    expect(verdict.outcome).toBe('unknown');
    expect(verdict.reasons).toContain('receipt_unavailable');
  });

  it('never passes an empty diff, and says whether working-tree status was recorded', async () => {
    const noChange = await evaluate({
      spec: makeSpec(),
      receipt: makeReceipt(),
      holdout: makeHoldout(),
      runner: runner(),
      policy: policy(),
      diff: fakeDiff([]),
      nowIso: NOW,
    });

    expect(noChange.outcome).toBe('unknown');
    expect(noChange.reasons).toContain('no_change');
    expect(oneLineReason(noChange)).toContain('untracked work cannot be ruled out');

    // Now the receipt DID record uncommitted paths: the diff is empty, the work exists,
    // and the receipt misrepresented the change.
    const lied = await evaluate({
      spec: makeSpec(),
      receipt: makeReceipt(['src/probe.ts']),
      holdout: makeHoldout(),
      runner: runner(),
      policy: policy(),
      diff: fakeDiff([]),
      nowIso: NOW,
    });

    expect(lied.outcome).toBe('fail');
    expect(lied.reasons).toContain('receipt_unfaithful');
  });
});

describe('A5 — security relevance reaches the wall', () => {
  it('refuses an undeclared security-sensitive path even when the holdout is green', async () => {
    const verdict = await evaluate({
      spec: makeSpec(),
      receipt: makeReceipt(),
      holdout: makeHoldout(),
      runner: runner(),
      policy: policy(),
      diff: fakeDiff([
        { path: 'src/probe.ts', kind: 'added' },
        { path: '.github/workflows/release.yml', kind: 'modified' },
      ]),
      nowIso: NOW,
    });

    expect(verdict.outcome).toBe('fail');
    expect(verdict.reasons).toContain('scope_violation');
    const scope = verdict.scenarios.find((scenario) => scenario.id === 'scope');
    expect(scope?.observed).toContain('.github/workflows/release.yml');
    expect(scope?.observed).toContain('CI workflow');
  });

  it('does not refuse a sensitive path the unit declared', async () => {
    const verdict = await evaluate({
      // Declared, and inside a declared touch path: planned and reviewed, so the ladder
      // stays out of the way. (The test-surface rule would still fire on a test file —
      // that is deliberate; declaring a path does not make it a legitimate oracle.)
      spec: makeSpec({ touchPaths: ['src/'] }),
      receipt: makeReceipt(),
      holdout: makeHoldout(),
      runner: runner(),
      policy: policy(),
      diff: fakeDiff([{ path: 'src/auth/login.ts', kind: 'modified' }]),
      nowIso: NOW,
    });

    expect(verdict.reasons).not.toContain('scope_violation');
    expect(verdict.outcome).toBe('pass');
  });

  it('refuses a reversible security-relevant operation class with its own code, not the reversibility code', async () => {
    const verdict = await evaluate({
      // `network-egress` is sensitive and reversible. The reason must say `sensitive_operation`:
      // claiming an egress change was irreversible would be a false statement in the operator line.
      spec: makeSpec({ operationClasses: ['network-egress'] }),
      receipt: makeReceipt(),
      holdout: makeHoldout(),
      runner: runner(),
      policy: policy(),
      diff: cleanDiff(),
      nowIso: NOW,
    });

    expect(verdict.outcome).toBe('fail');
    expect(verdict.reasons).toContain('sensitive_operation');
    expect(verdict.reasons).not.toContain('irreversible_operation');

    // A class that really is irreversible keeps the reversibility code.
    const irreversible = await evaluate({
      spec: makeSpec({ operationClasses: ['data-delete'] }),
      receipt: makeReceipt(),
      holdout: makeHoldout(),
      runner: runner(),
      policy: policy(),
      diff: cleanDiff(),
      nowIso: NOW,
    });
    expect(irreversible.reasons).toContain('irreversible_operation');
    expect(irreversible.reasons).not.toContain('sensitive_operation');
  });

  it('classifies paths and classes without the qualifier package present', () => {
    const declared = assessSecurityPaths(['src/auth/login.ts'], ['src/'], []);
    expect(declared.undeclared).toEqual([]);
    expect(declared.declared).toHaveLength(1);

    const undeclared = assessSecurityPaths(
      ['.github/workflows/ci.yml'],
      ['src/'],
      ['credential-use'],
    );
    expect(undeclared.undeclared.map((hit) => hit.path)).toEqual(['.github/workflows/ci.yml']);
    expect(undeclared.sensitiveOperations).toEqual(['credential-use']);
    expect(undeclared.detail).toContain('CI workflow');
  });

  it('stays in step with the qualifier’s table, or the drift test fails', () => {
    // The drift assertion is the condition of acceptance for duplicating the table. It
    // skips when the qualifier package is not checked out (a standalone wall install).
    let qualifierSource: string;
    try {
      qualifierSource = readFileSync(
        fileURLToPath(new URL('../../qualifier/src/security.ts', import.meta.url)),
        'utf8',
      );
    } catch {
      return;
    }

    for (const rule of SENSITIVE_PATH_PATTERNS) {
      expect(
        qualifierSource,
        `wall rule ${String(rule.pattern)} is absent from the qualifier`,
      ).toContain(rule.pattern.source);
      expect(qualifierSource).toContain(rule.why);
    }
    expect(qualifierSource).toContain("'credential-use'");
    expect(qualifierSource).toContain("'force-push'");
  });
});

describe('A6 — the wall owns the oracle', () => {
  it('never passes without a pinned suite of its own', async () => {
    const verdict = await evaluate({
      spec: makeSpec(),
      receipt: makeReceipt(),
      holdout: makeHoldout(),
      runner: runner(),
      policy: policy({ pinned: false }),
      diff: cleanDiff(),
      nowIso: NOW,
    });

    expect(verdict.outcome).toBe('unknown');
    expect(verdict.reasons).toContain('suite_unknown');
    // The operator is told which surface is missing, in the wall's own words.
    const suite = verdict.scenarios.find((scenario) => scenario.id === 'suite');
    expect(suite?.observed).toContain('no oracle of its own');
  });

  it("believes the wall's own summary rather than the receipt's claim of green", async () => {
    const fake = runner();
    // The wall's own run over the base test root reports failures while the receipt
    // reports 12 passed.
    fake.patched.set('pnpm\u0000test', { exitCode: 0, summary: RED_SUMMARY });

    const verdict = await evaluate({
      spec: makeSpec(),
      receipt: makeReceipt(),
      holdout: makeHoldout(),
      runner: fake,
      policy: policy(),
      diff: cleanDiff(),
      nowIso: NOW,
    });

    expect(verdict.outcome).toBe('fail');
    expect(verdict.reasons).toContain('suite_failed');
  });

  it('treats a run with no machine-readable summary as unmeasured', async () => {
    const fake = runner();
    fake.patched.set('pnpm\u0000test', { exitCode: 0 });

    const verdict = await evaluate({
      spec: makeSpec(),
      receipt: makeReceipt(),
      holdout: makeHoldout(),
      runner: fake,
      policy: policy(),
      diff: cleanDiff(),
      nowIso: NOW,
    });

    expect(verdict.outcome).toBe('unknown');
    expect(verdict.reasons).toContain('suite_unknown');
  });
});

describe('A10 — Δ provenance and class certifiability', () => {
  it('flags a passing unit whose class has too few Δ samples, without failing it', async () => {
    const verdict: Verdict = await evaluate({
      spec: makeSpec(),
      receipt: makeReceipt(),
      holdout: makeHoldout(),
      runner: runner(),
      policy: policy({ minDeltaSamples: 3 }),
      diff: cleanDiff(),
      nowIso: NOW,
    });

    // The unit verified; the *class* is not certifiable, so promotion needs a human.
    expect(verdict.outcome).toBe('pass');
    expect(verdict.reasons).toEqual([]);
    expect(verdict.promotionRequiresHumanSignature).toBe(true);
    expect(() => assertVerdictIsEarned(verdict)).not.toThrow();
    expect(oneLineReason(verdict)).toContain('promotion requires a human signature');
  });

  it('does not set the flag when the class has enough samples', async () => {
    const verdict = await evaluate({
      spec: makeSpec(),
      receipt: makeReceipt(),
      holdout: makeHoldout(),
      runner: runner(),
      policy: policy({ minDeltaSamples: 1 }),
      diff: cleanDiff(),
      nowIso: NOW,
    });

    expect(verdict.outcome).toBe('pass');
    expect(verdict.promotionRequiresHumanSignature).toBeUndefined();
  });

  it('never sets the promotion flag on a verdict that did not verify', async () => {
    const verdict = await evaluate({
      spec: makeSpec(),
      receipt: makeReceipt(),
      holdout: makeHoldout(),
      runner: runner(),
      policy: policy({ minDeltaSamples: 3 }),
      diff: fakeDiff([
        { path: 'src/probe.ts', kind: 'added' },
        { path: 'package.json', kind: 'modified' },
      ]),
      nowIso: NOW,
    });

    expect(verdict.outcome).toBe('fail');
    expect(verdict.promotionRequiresHumanSignature).toBeUndefined();
  });

  it('names the instrument in the verdict when an image digest is pinned', async () => {
    const digest = `sha256:${'c'.repeat(64)}`;
    const verdict = await evaluate({
      spec: makeSpec(),
      receipt: makeReceipt(),
      holdout: makeHoldout(),
      runner: runner(),
      policy: policy({ imageDigest: digest }),
      diff: cleanDiff(),
      nowIso: NOW,
    });

    expect(verdict.wallVersion).toContain(digest);
  });
});
