/**
 * The fake executor's own tests — a double that is wrong is worse than no double.
 *
 * Three properties matter, and each one has bitten a real seam before:
 *
 *   1. a scenario typo fails loudly, with the step index, rather than running the
 *      prefix of a scenario and looking like a worker failure;
 *   2. only `turn_end.reason.kind === 'completed'` counts as a finished turn, so
 *      "exited 0" cannot be mistaken for "did the work";
 *   3. the receipt it returns is schema-valid, names itself as fake, and claims no
 *      suite result — `suite: null` is the contract's word for "not measured".
 */
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { FactoryError, WorkerReceipt } from '@factory/contracts';
import {
  createFakeExecutor,
  createFakeExecutorFromFile,
  parseFakeScenario,
  scenarioTurnCompleted,
  type FakeScenario,
} from './fake-executor.ts';

function home(): string {
  return mkdtempSync(join(tmpdir(), 'fake-executor-'));
}

const payload = {
  attemptId: 'A-1',
  unitId: 'U-1',
  attemptDir: join(tmpdir(), 'unused-clone'),
};

/**
 * These tests exercise the executor directly, so they create the attempt directory
 * themselves — the deliberate bypass of `createAttemptClone`. In `run` the clone is the
 * factory's job and the executor *refuses* to invent a tree (see the last spec in this
 * file): a worker that makes its own directory is the situation the clone exists to
 * prevent, and a fake that did it would hide a missing clone step behind a green test.
 */
function cloneDir(parent: string, name = 'clone'): string {
  const dir = join(parent, name);
  mkdirSync(dir, { recursive: true });
  return dir;
}
const ctx = { effectId: 'E-1', attempt: 0 };

function completedScenario(): FakeScenario {
  return {
    steps: [
      { kind: 'emit', events: [{ type: 'session', sessionId: 's-1' }] },
      { kind: 'emit', events: [{ type: 'turn_end', reason: { kind: 'completed' } }] },
      { kind: 'exit', code: 0 },
    ],
    receipt: { filesChanged: 2, insertions: 3, deletions: 1, patch: 'diff\n' },
  };
}

describe('parseFakeScenario', () => {
  it('rejects an unknown step kind, naming its index', () => {
    expect(() =>
      parseFakeScenario({ steps: [{ kind: 'exit', code: 0 }, { kind: 'teleport' }] }),
    ).toThrow(/step 1 has unknown kind/);
  });

  it('rejects a body with no steps array', () => {
    expect(() => parseFakeScenario({ steps: 'none' })).toThrow(/steps array/);
  });
});

describe('scenarioTurnCompleted', () => {
  it('is true only for a completed turn end', () => {
    expect(scenarioTurnCompleted(completedScenario())).toBe(true);
  });

  it('is false when the worker exits without ending a turn', () => {
    expect(scenarioTurnCompleted({ steps: [{ kind: 'exit', code: 0 }] })).toBe(false);
  });

  it('is false for a turn end that failed', () => {
    expect(
      scenarioTurnCompleted({
        steps: [{ kind: 'emit', events: [{ type: 'turn_end', reason: { kind: 'error' } }] }],
      }),
    ).toBe(false);
  });

  it('accepts the status-shaped turn end the older dsh build emits', () => {
    expect(
      scenarioTurnCompleted({
        steps: [
          {
            kind: 'emit',
            events: [{ type: 'status', phase: 'turn_end', reason: { kind: 'completed' } }],
          },
        ],
      }),
    ).toBe(true);
  });
});

describe('createFakeExecutor', () => {
  it('returns a schema-valid receipt that names itself as fake and measures no suite', async () => {
    const factoryHome = home();
    const executor = createFakeExecutor({ scenario: completedScenario(), factoryHome });

    const receipt = await executor.run({ ...payload, attemptDir: cloneDir(factoryHome) }, ctx);

    expect(WorkerReceipt.safeParse(receipt).success).toBe(true);
    expect(receipt.sessionId).toBe('fake-A-1');
    expect(receipt.suite).toBeNull();
    expect(receipt.exitCode).toBe(0);
    expect(receipt.diff.filesChanged).toBe(2);
    // The record is written outside the clone, so the patch never describes itself.
    const recordDir = join(factoryHome, 'attempts', 'U-1', 'A-1');
    expect(readFileSync(join(recordDir, 'stdout.log'), 'utf8')).toContain('turn_end');
    expect(readFileSync(join(recordDir, 'receipt.json'), 'utf8')).toContain(
      '"sessionId": "fake-A-1"',
    );
  });

  it('throws ATTEMPT_AMBIGUOUS instead of returning a receipt for an unfinished turn', async () => {
    const factoryHome = home();
    const executor = createFakeExecutor({
      scenario: { steps: [{ kind: 'exit', code: 0 }] },
      factoryHome,
    });

    await expect(
      executor.run({ ...payload, attemptDir: cloneDir(factoryHome) }, ctx),
    ).rejects.toThrow(/ambiguous, not failed/);
  });

  it('fails on a scenario whose declared receipt cannot parse', async () => {
    const factoryHome = home();
    const executor = createFakeExecutor({
      scenario: {
        steps: [{ kind: 'emit', events: [{ type: 'turn_end', reason: { kind: 'completed' } }] }],
        // `insertions` is a uint in the contract; a negative value is a scenario bug.
        receipt: { insertions: -1 },
      },
      factoryHome,
    });

    await expect(
      executor.run({ ...payload, attemptDir: cloneDir(factoryHome) }, ctx),
    ).rejects.toThrow(/failed its own schema/);
  });

  it('refuses to invent an attempt tree: the clone is the caller’s job', async () => {
    const factoryHome = home();
    const executor = createFakeExecutor({ scenario: completedScenario(), factoryHome });

    await expect(
      executor.run({ ...payload, attemptDir: join(factoryHome, 'absent') }, ctx),
    ).rejects.toThrow(/does not exist; the caller must create the clone/);
  });

  it('runs a `command` step for real and records what it actually printed', async () => {
    const factoryHome = home();
    const executor = createFakeExecutor({
      scenario: {
        steps: [
          {
            kind: 'command',
            argv: ['node', '-e', 'process.stdout.write("measured\\n")'],
          },
          { kind: 'emit', events: [{ type: 'turn_end', reason: { kind: 'completed' } }] },
          { kind: 'exit', code: 0 },
        ],
      },
      factoryHome,
    });

    const receipt = await executor.run({ ...payload, attemptDir: cloneDir(factoryHome) }, ctx);
    const command = receipt.commands[0];
    expect(command?.exitCode).toBe(0);
    expect(command?.argv).toEqual(['node', '-e', 'process.stdout.write("measured\\n")']);
    // A hash the wall can re-derive; a declared one would be a claim, not a measurement.
    expect(command?.outputSha).toMatch(/^sha256:[0-9a-f]{64}$/);
  });

  it('replays a stored receipt verbatim, so a spec can try to file another attempt’s evidence', async () => {
    const factoryHome = home();
    const stored = join(factoryHome, 'other-receipt.json');
    writeFileSync(
      stored,
      JSON.stringify({
        ...(await createFakeExecutor({
          scenario: completedScenario(),
          factoryHome,
        }).run({ ...payload, attemptDir: cloneDir(factoryHome) }, ctx)),
        attemptId: 'A-other',
      }),
    );

    const executor = createFakeExecutor({
      scenario: { steps: [{ kind: 'replayReceipt', path: stored }] },
      factoryHome,
    });
    const receipt = await executor.run(
      { ...payload, attemptId: 'A-2', attemptDir: cloneDir(factoryHome, 'clone-2') },
      ctx,
    );
    expect(receipt.attemptId).toBe('A-other');
  });

  it('refuses a scenario file that is not JSON', () => {
    const factoryHome = home();
    const scenarioPath = join(factoryHome, 'scenario.json');
    writeFileSync(scenarioPath, '{ not json');
    expect(() => createFakeExecutorFromFile(scenarioPath, { factoryHome })).toThrow(
      /could not be read as JSON/,
    );
  });
});

describe('the broker: a scenario cannot launder a privileged command', () => {
  /** A scenario whose whole purpose is to run `sudo` without a decision. */
  function scenarioWith(argv: readonly string[]): FakeScenario {
    return {
      steps: [
        { kind: 'command', argv: [...argv] },
        { kind: 'emit', events: [{ type: 'turn_end', reason: { kind: 'completed' } }] },
        { kind: 'exit', code: 0 },
      ],
    };
  }

  it('fails the attempt with GATE_REQUIRED when brokering is on', async () => {
    const factoryHome = home();
    const executor = createFakeExecutor({
      scenario: scenarioWith(['sudo', 'ls']),
      factoryHome,
      privilegedBrokering: 'on',
    });
    const error = await executor
      .run({ ...payload, attemptDir: cloneDir(factoryHome) }, ctx)
      .catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(FactoryError);
    expect((error as FactoryError).code).toBe('GATE_REQUIRED');
    // The step is named, so a reader of the failure knows which line of the scenario was the
    // privileged one — not merely that "the attempt failed".
    expect((error as FactoryError).details['argv']).toEqual(['sudo', 'ls']);
  });

  it('runs an ordinary command step with brokering on', async () => {
    const factoryHome = home();
    const executor = createFakeExecutor({
      scenario: scenarioWith(['node', '-e', 'process.stdout.write("ok\\n")']),
      factoryHome,
      privilegedBrokering: 'on',
    });
    const receipt = await executor.run({ ...payload, attemptDir: cloneDir(factoryHome) }, ctx);
    expect(WorkerReceipt.safeParse(receipt).success).toBe(true);
    expect(receipt.commands).toHaveLength(1);
    expect(receipt.commands[0]?.exitCode).toBe(0);
  });

  it('with brokering off, the same command runs — off is the default, not an accident', async () => {
    // Pins the default: turning brokering on is a policy decision, and the fake must not
    // quietly become a broker because a test forgot to say so.
    const factoryHome = home();
    const executor = createFakeExecutor({
      scenario: scenarioWith(['node', '-e', 'process.exit(0)']),
      factoryHome,
    });
    const receipt = await executor.run({ ...payload, attemptDir: cloneDir(factoryHome) }, ctx);
    expect(receipt.commands[0]?.exitCode).toBe(0);
  });
});
