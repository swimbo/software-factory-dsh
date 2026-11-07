/**
 * The scheduled re-certification's own specs.
 *
 * The interesting property is not "it can spend" — it is **when it refuses to**. A nightly job that
 * spends without a person is the first such component in this system, so the specs here are about the
 * fence: no budget means no spend, an unreadable plan means no spend, a refusal never reaches the
 * driver, and a failing driver stops the run instead of grinding through the next class.
 *
 * The plan itself is the CLI's, so these specs feed a fixed plan through `RECERTIFY_CLI` and a stub
 * driver through `RECERTIFY_RUNNER`; nothing here touches a store or spends a token.
 */
import { execFileSync } from 'node:child_process';
import { chmodSync, existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const SCRIPT = join(import.meta.dirname, 'recertify-due.sh');

interface RunResult {
  readonly status: number;
  readonly stdout: string;
  readonly stderr: string;
}

function planJson(
  entries: ReadonlyArray<{
    decision: string;
    taskClass: string;
    remaining?: number;
    projectedTokens?: number | null;
    budgetTokens?: number | null;
    unitsFile?: string | null;
  }>,
): string {
  return JSON.stringify({
    kind: 'certifications',
    recertification: {
      budgetVariable: 'FACTORY_RECERTIFY_BUDGET_TOKENS',
      unitsVariable: 'FACTORY_RECERTIFY_UNITS_DIR',
      entries: entries.map((entry) => ({
        taskClass: entry.taskClass,
        state: 'never-certified',
        samples: 1,
        m: 20,
        remaining: entry.remaining ?? 19,
        estimate: {
          basis: entry.projectedTokens === null ? 'unknown' : 'measured',
          medianTokensPerAttempt: entry.projectedTokens === null ? null : 76_494,
          measuredAttempts: 1,
          projectedTokens: entry.projectedTokens ?? null,
        },
        budgetTokens: entry.budgetTokens ?? null,
        unitsFile: entry.unitsFile ?? null,
        decision: entry.decision,
        reason: 'seeded plan',
      })),
    },
  });
}

/** A store-free sandbox: a fake CLI that prints `plan`, a fake driver that records its argv and env. */
function sandbox(plan: string): {
  env: Record<string, string>;
  driverCalls: () => string[];
  setDriverExit: (code: number) => void;
} {
  const dir = mkdtempSync(join(tmpdir(), 'recertify-'));
  const planPath = join(dir, 'plan.json');
  writeFileSync(planPath, plan);
  const cliPath = join(dir, 'fake-cli.sh');
  writeFileSync(
    cliPath,
    `#!/usr/bin/env bash\nif [ "$1" = "audit" ]; then cat ${planPath}; exit 0; fi\nexit 0\n`,
  );
  chmodSync(cliPath, 0o755);
  const callsPath = join(dir, 'driver-calls.txt');
  const exitPath = join(dir, 'driver-exit.txt');
  writeFileSync(exitPath, '0');
  const driverPath = join(dir, 'fake-driver.sh');
  writeFileSync(
    driverPath,
    `#!/usr/bin/env bash\nprintf '%s|%s\\n' "\${FACTORY_HOLDOUT_TASK_CLASS:-}" "$*" >> ${callsPath}\nexit "$(cat ${exitPath})"\n`,
  );
  chmodSync(driverPath, 0o755);
  return {
    env: {
      FACTORY_HOME: dir,
      // No quoting: the script word-splits these into a command line, and the temp dir has no spaces.
      RECERTIFY_CLI: `bash ${cliPath}`,
      RECERTIFY_RUNNER: `bash ${driverPath}`,
      RECERTIFY_NODE_BIN: process.execPath,
    },
    driverCalls: () =>
      existsSync(callsPath) ? readFileSync(callsPath, 'utf8').trim().split('\n') : [],
    setDriverExit: (code: number) => writeFileSync(exitPath, String(code)),
  };
}

function run(args: readonly string[], env: Record<string, string>): RunResult {
  try {
    const stdout = execFileSync('bash', [SCRIPT, ...args], {
      env: { ...process.env, ...env },
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    return { status: 0, stdout, stderr: '' };
  } catch (error) {
    const failure = error as { status?: number; stdout?: string; stderr?: string };
    return {
      status: failure.status ?? 1,
      stdout: failure.stdout ?? '',
      stderr: failure.stderr ?? '',
    };
  }
}

describe('scripts/recertify-due.sh', () => {
  it('plans and spends nothing without --spend, even when the plan is spendable', () => {
    const box = sandbox(
      planJson([
        {
          decision: 'would-spend',
          taskClass: 'docs-hygiene',
          projectedTokens: 1_000,
          budgetTokens: 2_000,
          unitsFile: '/tmp/u.txt',
        },
      ]),
    );
    const result = run([], box.env);
    expect(result.status).toBe(0);
    expect(result.stdout).toContain('would spend');
    expect(box.driverCalls()).toEqual([]);
  });

  it('never reaches the driver for a refused class', () => {
    const box = sandbox(
      planJson([
        { decision: 'refused-no-budget', taskClass: 'docs-hygiene' },
        { decision: 'refused-unknown-estimate', taskClass: 'mystery', projectedTokens: null },
        {
          decision: 'refused-over-budget',
          taskClass: 'type-repair',
          projectedTokens: 9_000_000,
          budgetTokens: 1_000,
        },
      ]),
    );
    const result = run(['--spend'], box.env);
    expect(result.status).toBe(0);
    expect(result.stdout).toContain('3 refused');
    expect(box.driverCalls()).toEqual([]);
  });

  it('spends on a would-spend class with that class named for the run', () => {
    const box = sandbox(
      planJson([
        {
          decision: 'would-spend',
          taskClass: 'docs-hygiene',
          projectedTokens: 1_000,
          budgetTokens: 2_000,
          unitsFile: '/tmp/docs-hygiene.txt',
        },
        { decision: 'not-due', taskClass: 'type-repair', remaining: 0 },
      ]),
    );
    const result = run(['--spend'], box.env);
    expect(result.status).toBe(0);
    expect(box.driverCalls()).toEqual(['docs-hygiene|--units-file /tmp/docs-hygiene.txt']);
    expect(result.stdout).toContain('spent on docs-hygiene');
  });

  it('stops on a failing driver instead of moving to the next class', () => {
    const box = sandbox(
      planJson([
        {
          decision: 'would-spend',
          taskClass: 'docs-hygiene',
          projectedTokens: 1_000,
          budgetTokens: 2_000,
          unitsFile: '/tmp/a.txt',
        },
        {
          decision: 'would-spend',
          taskClass: 'type-repair',
          projectedTokens: 1_000,
          budgetTokens: 2_000,
          unitsFile: '/tmp/b.txt',
        },
      ]),
    );
    box.setDriverExit(1);
    const result = run(['--spend'], box.env);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('driver FAILED');
    // One call: the second class was never attempted after the first failed.
    expect(box.driverCalls()).toHaveLength(1);
  });

  it('calls a night that ran out of units incomplete, not failed, and still raises the alert', () => {
    // The driver's exit 2 is `units-exhausted`: it measured what the operator's units file held and the
    // class is still short of m. Before this spec existed, the script took that branch to `driver FAILED`
    // and exited before the alert — so the one night that made progress was the night nobody heard about.
    const box = sandbox(
      planJson([
        {
          decision: 'would-spend',
          taskClass: 'docs-hygiene',
          projectedTokens: 1_000,
          budgetTokens: 2_000,
          unitsFile: '/tmp/a.txt',
        },
      ]),
    );
    box.setDriverExit(2);
    const result = run(['--spend'], box.env);
    // 4 is "unknown, not a pass": the class did not reach a certificate tonight, and saying "nothing was
    // left undone" would be a lie. It is not 1, because nothing went wrong and a retry is not the fix.
    expect(result.status).toBe(4);
    expect(result.stdout).toContain('incomplete, not failed');
    expect(result.stdout).toContain('spent on');
    expect(result.stderr).toContain('did not reach a certificate tonight');
    expect(box.driverCalls()).toHaveLength(1);
  });

  it('refuses to act on a plan it cannot read', () => {
    const box = sandbox('');
    const result = run(['--spend'], box.env);
    expect(result.status).toBe(9);
    expect(result.stderr).toContain('no plan');
    expect(box.driverCalls()).toEqual([]);
  });

  it('is a usage error to ask for a bypass that does not exist', () => {
    const box = sandbox(planJson([]));
    const result = run(['--force'], box.env);
    expect(result.status).toBe(2);
    expect(result.stderr).toContain('unknown argument');
  });
});
