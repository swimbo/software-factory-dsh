/**
 * The local runner.
 *
 * The interesting tests here are not "does it run a command" — that is `spawn`. They are
 * the three places a convenience runner goes wrong quietly:
 *
 * 1. the timeout reaps the child and leaves the grandchildren (a test suite still holding a
 *    port, a `watch` process still writing files);
 * 2. the runner reports a summary that disagrees with the exit code and someone believes it;
 * 3. the runner is handed a scenario that asked for isolation and runs it anyway.
 */
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, describe, expect, it } from 'vitest';
import { createLocalRunner, LocalRunnerRefusal, parseSummary } from './local.ts';
import { NO_PATCH, evaluate, type ScenarioRunInput } from './evaluate.ts';
import {
  sha256Hex,
  toDecisionReceipt,
  type AcceptanceCriterion,
  type UnitSpec,
} from '@factory/contracts';

const scratch: string[] = [];
afterEach(() => {
  for (const dir of scratch.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function scratchDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'factory-local-test-'));
  scratch.push(dir);
  return dir;
}

function worktree(): string {
  const dir = scratchDir();
  writeFileSync(join(dir, 'marker.txt'), 'checkout\n', 'utf8');
  return dir;
}

function runInput(argv: readonly string[], timeoutMs = 10_000): ScenarioRunInput {
  return { baseRev: 'a'.repeat(40), patchFile: NO_PATCH, argv, timeoutMs };
}

function node(script: string): readonly string[] {
  return [process.execPath, '-e', script];
}

describe('the local runner measures a command', () => {
  it('runs a passing scenario in a private copy of the tree and reports exit 0', async () => {
    const cwd = worktree();
    const runner = createLocalRunner({ cwd });

    const result = await runner.run(runInput(node('process.exit(0)')));

    expect(result.exitCode).toBe(0);
    expect(result.timedOut).toBe(false);
    expect(result.outputSha).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(runner.kind).toBe('local');
  });

  it('reports a failing scenario\u2019s exit code rather than an error of its own', async () => {
    const runner = createLocalRunner({ cwd: worktree() });

    const result = await runner.run(runInput(node('process.exit(3)')));

    expect(result.exitCode).toBe(3);
    expect(result.timedOut).toBe(false);
  });

  it('runs inside the copy, so a scenario cannot see the real checkout', async () => {
    const cwd = worktree();
    const marker = join(scratchDir(), 'seen.txt');
    const runner = createLocalRunner({ cwd });

    const result = await runner.run(
      runInput(
        node(
          `require('fs').writeFileSync(${JSON.stringify(marker)}, require('fs').readdirSync('.').join(','))`,
        ),
      ),
    );

    expect(result.exitCode).toBe(0);
    // The copy holds the tree…
    expect(readFileSync(marker, 'utf8')).toContain('marker.txt');
  });
});

describe('the timeout reaps the whole process group', () => {
  it('kills grandchildren too, not just the direct child', async () => {
    const dir = scratchDir();
    const grandchildMarker = join(dir, 'grandchild-survived.txt');
    const script = join(dir, 'spawner.js');

    // The parent spawns a grandchild that writes after 1.5s, then spins forever. With a
    // 200ms timeout, a bare `kill` would reap the parent and let the grandchild write the
    // marker — which is exactly the leak a test runner suffers.
    writeFileSync(
      script,
      [
        "const { spawn } = require('child_process');",
        "const fs = require('fs');",
        `spawn(process.execPath, ['-e', ${JSON.stringify(
          `setTimeout(() => require('fs').writeFileSync(${JSON.stringify(grandchildMarker)}, 'alive'), 1500)`,
        )}], { stdio: 'ignore' });`,
        'setInterval(() => {}, 1000);',
      ].join('\n'),
      'utf8',
    );

    const runner = createLocalRunner({ cwd: dir });
    const result = await runner.run(runInput([process.execPath, script], 200));

    expect(result.timedOut).toBe(true);
    // Unmeasured, never a pass and never a fail the wall cannot justify.
    expect(result.exitCode).toBeNull();

    await new Promise((resolvePromise) => setTimeout(resolvePromise, 2_000));
    expect(() => readFileSync(grandchildMarker, 'utf8')).toThrow();
  });
});

describe('a summary that disagrees with the exit code is unmeasured', () => {
  it('drops a summary whose exitCode contradicts the observed one, so the wall reads unknown', async () => {
    const runner = createLocalRunner({ cwd: worktree() });
    const script = `console.log('FACTORY_SUMMARY {"passed":12,"failed":0,"unknown":0,"exitCode":0}'); process.exit(2);`;

    const result = await runner.run(runInput(node(script)));

    // `exitCode: null` is the wall's existing encoding for "not measured" — the disagreement
    // is not evidence in either direction.
    expect(result.exitCode).toBeNull();
    expect(result.summary).toBeUndefined();
  });

  it('keeps a summary that agrees, so the oracle has counts to read', async () => {
    const runner = createLocalRunner({ cwd: worktree() });
    const script = `console.log('FACTORY_SUMMARY {"passed":12,"failed":0,"unknown":0,"exitCode":0}'); process.exit(0);`;

    const result = await runner.run(runInput(node(script)));

    expect(result.exitCode).toBe(0);
    expect(result.summary).toEqual({ passed: 12, failed: 0, unknown: 0, exitCode: 0 });
  });

  it('parses the last summary line and ignores noise', () => {
    expect(
      parseSummary('hello\nFACTORY_SUMMARY {"passed":1,"failed":0,"unknown":0,"exitCode":0}\n'),
    ).toEqual({
      passed: 1,
      failed: 0,
      unknown: 0,
      exitCode: 0,
    });
    expect(parseSummary('FACTORY_SUMMARY not json')).toBeUndefined();
    expect(parseSummary('FACTORY_SUMMARY {"passed":"12"}')).toBeUndefined();
    expect(parseSummary('no summary here')).toBeUndefined();
  });
});

describe('a scenario that needs containment is refused, not degraded', () => {
  it('refuses a scenario that requires a container', async () => {
    const runner = createLocalRunner({ cwd: worktree() });

    await expect(
      runner.run({ ...runInput(node('process.exit(0)')), requires: 'container' }),
    ).rejects.toBeInstanceOf(LocalRunnerRefusal);
  });

  it('refuses a scenario that requires no network, naming the requirement', async () => {
    const runner = createLocalRunner({ cwd: worktree() });

    await expect(
      runner.run({ ...runInput(node('process.exit(0)')), network: 'none' }),
    ).rejects.toThrow(/no network isolation/);
  });

  it('turns a refusal into unknown at the wall, never into a pass', async () => {
    // A throw from the runner is caught per-run by the wall and classified unmeasured: the
    // candidate is not blamed, and promotion does not happen.
    const runner = createLocalRunner({ cwd: worktree() });
    const spec: UnitSpec = {
      slug: 'add-probe',
      revision: 1,
      repo: '/repo',
      baseRev: 'b'.repeat(40),
      intent: 'Add a probe endpoint that answers with the unit id, so operators can see it.',
      restateBack: 'Add /probe returning the unit id as JSON, with a command oracle proving it.',
      acceptance: [
        {
          id: 'probe-answers',
          text: 'criterion probe-answers holds',
          oracle: {
            kind: 'command',
            target: JSON.stringify([process.execPath, '-e', 'process.exit(0)']),
            expect: '0',
          },
        } satisfies AcceptanceCriterion,
      ],
      touchPaths: ['src/'],
      operationClasses: ['code-change'],
      sizeBudget: { files: 10, lines: 400 },
      budgetEstimateUsd: 2,
    };
    const receipt = toDecisionReceipt({
      unitId: 'unit-1',
      attemptId: 'attempt-1',
      sessionId: 'session-1',
      startedAt: '2026-12-01T00:00:00.000Z',
      endedAt: '2026-12-01T00:30:00.000Z',
      exitCode: 0,
      diff: {
        patchFile: '/attempts/a/change.patch',
        sha: `sha256:${sha256Hex('patch')}`,
        filesChanged: 1,
        insertions: 1,
        deletions: 0,
        baseRev: 'b'.repeat(40),
      },
      commands: [],
      suite: null,
      ceilings: { turnsUsed: 1, wallClockMs: 1000, hit: [] },
      artifacts: [],
      narrative: 'Complete.',
    });

    const verdict = await evaluate({
      spec,
      receipt,
      // Every scenario in this class demands a container: the local runner must not measure
      // the holdout at all, so no pass is reachable.
      holdout: {
        revision: 'r0001',
        taskClass: 'core',
        scenarios: [
          {
            id: 'alpha',
            taskClass: 'core',
            argv: [process.execPath, '-e', 'process.exit(0)'],
            expectExit: [0],
            requires: 'container',
          },
        ],
      },
      runner,
      policy: {
        deltaThreshold: 0,
        commandTimeoutMs: 30_000,
        wallVersion: 'wall/0.1.0',
        runsPerScenario: 1,
        maxNonDiscriminating: 0,
      },
      diff: {
        async changedFiles() {
          return [{ path: 'src/probe.ts', kind: 'added' }];
        },
      },
      nowIso: '2026-12-01T00:00:00.000Z',
    });

    expect(verdict.outcome).toBe('unknown');
    // The refusal surfaces as unmeasured-holdout, not as a failure of the candidate.
    expect(verdict.reasons).toContain('holdout_unavailable');
    // The instrument identity says it was not a container run.
    expect(verdict.wallVersion).toContain('+local');
  });
});
