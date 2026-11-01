/**
 * The executor end to end, with `dsh` replaced by a shell script.
 *
 * Nothing here reaches the network, the real `dsh` binary or a model: every
 * behavioural assertion runs a fixture that writes the NDJSON stream the adapter
 * must understand. The only real subprocesses are the fixture itself and `git`.
 */

import { chmodSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { FactoryError, WorkerReceipt, type WorkerReceiptType } from '@factory/contracts';
import { beforeAll, describe, expect, it, vi } from 'vitest';

import {
  buildChildEnv,
  createDshExecutor,
  DEFAULT_MAX_OUTPUT_BYTES,
  DEFAULT_WALL_CLOCK_MS,
  DSH_PROFILE,
  PINNED_DSH_VERSION,
  statusPathsFrom,
  TASK_FILE,
  type DshExecutorOptions,
  type LaunchPayload,
} from '../src/executor.ts';
import { attemptHomePath, listHomeFiles } from '../src/home.ts';
import { buildOverlay } from '../src/overlay.ts';
import {
  ATTEMPT_ID,
  UNIT_ID,
  entryValue,
  eventually,
  fixturePath,
  fixtureRepo,
  isDead,
  tempDir,
  type FixtureRepo,
} from './helpers.ts';

/**
 * Every fixture must be executable, whatever the checkout's umask did.
 *
 * The list is explicit so adding a fixture without listing it here is visible in
 * review; a missing entry fails loudly on the chmod rather than silently.
 */
beforeAll(() => {
  const fixtures = [
    'fake-dsh-success.sh',
    'fake-dsh-error.sh',
    'fake-dsh-max-tokens.sh',
    'fake-dsh-crash.sh',
    'fake-dsh-hang.sh',
    'fake-dsh-noisy.sh',
    'fake-dsh-degraded.sh',
    'fake-dsh-env.sh',
    'fake-dsh-ignored.sh',
    'fake-dsh-embedded.sh',
    'fake-dsh-wrongversion.sh',
  ];
  for (const name of fixtures) chmodSync(fixturePath(name), 0o755);
});

const PAYLOAD: Omit<LaunchPayload, 'attemptDir'> = { unitId: UNIT_ID, attemptId: ATTEMPT_ID };
const CTX = { effectId: 'effect-1', attempt: 0 };
const PROXY = 'http://127.0.0.1:4010';
const MODEL = 'factory-worker-tier';

function silentLog() {
  return { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
}

/** An executor wired to one fixture over an already-prepared attempt. */
function executorFor(
  repo: FixtureRepo,
  fixture = 'fake-dsh-success.sh',
  overrides: Partial<DshExecutorOptions> = {},
) {
  return createDshExecutor({
    dshBin: fixturePath(fixture),
    factoryHome: repo.factoryHome,
    proxyBaseUrl: PROXY,
    modelId: MODEL,
    log: silentLog(),
    parentEnv: { PATH: process.env['PATH'] ?? '' },
    ...overrides,
  });
}

interface Harness {
  repo: FixtureRepo;
  run: () => Promise<WorkerReceiptType>;
}

function harness(
  fixture = 'fake-dsh-success.sh',
  overrides: Partial<DshExecutorOptions> = {},
): Harness {
  const repo = fixtureRepo();
  const executor = executorFor(repo, fixture, overrides);
  const payload: LaunchPayload = { ...PAYLOAD, attemptDir: repo.attemptDir };
  return { repo, run: () => executor.run(payload, CTX) };
}

/** Assert the run was refused with a `FactoryError` and return it. */
async function rejection(promise: Promise<unknown>): Promise<FactoryError> {
  const outcome = await promise.then(
    (value) => ({ ok: true as const, value }),
    (cause: unknown) => ({ ok: false as const, cause }),
  );
  if (outcome.ok) throw new Error('expected the run to be rejected');
  if (!(outcome.cause instanceof FactoryError)) {
    throw new Error(`expected a FactoryError, got ${String(outcome.cause)}`);
  }
  return outcome.cause;
}

describe('createDshExecutor — a completed attempt', () => {
  it('returns a schema-valid receipt with the mechanical facts', async () => {
    const { run } = harness();
    const receipt = await run();

    expect(WorkerReceipt.safeParse(receipt).success).toBe(true);
    expect(receipt.exitCode).toBe(0);
    expect(receipt.sessionId).toBe('sess-fixture-success');
    expect(receipt.unitId).toBe(UNIT_ID);
    expect(receipt.attemptId).toBe(ATTEMPT_ID);
    expect(receipt.ceilings.hit).toStrictEqual([]);
    expect(receipt.ceilings.turnsUsed).toBe(1);
    expect(receipt.ceilings.wallClockMs).toBeGreaterThan(0);
    // v1 does not parse test output; `null` is the contract's word for unmeasured.
    expect(receipt.suite).toBeNull();
  });

  it('captures the patch against the pre-run revision', async () => {
    const { run, repo } = harness();
    const receipt = await run();

    // The fixture commits its edit, so HEAD moved during the run. A base captured
    // afterwards would be the agent's own commit and the patch would be empty.
    expect(receipt.diff.baseRev).toBe(repo.baseRev);
    expect(receipt.diff.baseRev).toMatch(/^[0-9a-f]{40}$/);
    expect(receipt.diff.sha).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(receipt.diff.filesChanged).toBe(2);
    expect(receipt.diff.insertions).toBe(2);
    expect(receipt.diff.deletions).toBe(0);

    const patch = readFileSync(receipt.diff.patchFile, 'utf8');
    expect(patch).toContain('README.md');
    // The untracked file is the one a plain `git diff` would silently omit.
    expect(patch).toContain('NEW.md');
    expect(patch).toContain('new file mode');

    // The wall reads `statusPaths` to tell "changed nothing" from "did work it
    // never staged". A faithful capture leaves nothing outside the patch, so the
    // list is empty — and empty is a claim, not a default: it says the patch
    // contains everything the working tree reports.
    expect(receipt.diff.statusPaths).toStrictEqual([]);
  });

  it('keeps the factory record outside the checkout it describes', async () => {
    const { run, repo } = harness();
    const receipt = await run();

    // The checkout is the repo and the only mount; a patch or log written inside
    // it would appear as an untracked change in the patch being taken.
    expect(receipt.diff.patchFile.startsWith(repo.attemptDir)).toBe(false);
    expect(receipt.diff.patchFile.startsWith(repo.recordDir)).toBe(true);

    const patch = readFileSync(receipt.diff.patchFile, 'utf8');
    for (const artefact of ['attempt.patch', 'stdout.log', 'dsh-overlay.yml', TASK_FILE]) {
      expect(patch, `${artefact} leaked into the patch`).not.toContain(artefact);
    }
    // And the checkout contains nothing the adapter wrote.
    for (const name of ['dsh-overlay.yml', 'attempt.patch', 'stdout.log', TASK_FILE]) {
      expect(existsSync(join(repo.attemptDir, name))).toBe(false);
    }
  });

  it('records the model text as narrative and nothing else', async () => {
    const { run } = harness();
    const receipt = await run();
    expect(receipt.narrative).toBe('Implemented the unit.');
    expect(JSON.stringify(receipt.diff)).not.toContain('Implemented');
  });

  it('writes every artefact it names in the receipt', async () => {
    const { run, repo } = harness();
    const receipt = await run();

    expect(receipt.artifacts.length).toBeGreaterThanOrEqual(4);
    for (const artifact of receipt.artifacts) {
      expect(existsSync(artifact.path), `missing artefact ${artifact.path}`).toBe(true);
      expect(artifact.sha).toMatch(/^sha256:[0-9a-f]{64}$/);
      expect(artifact.bytes).toBe(readFileSync(artifact.path).byteLength);
    }

    const overlay = readFileSync(join(repo.recordDir, 'dsh-overlay.yml'), 'utf8');
    expect(overlay).toBe(
      buildOverlay({ attemptDir: repo.attemptDir, proxyBaseUrl: PROXY, modelId: MODEL }),
    );

    const toolCalls = readFileSync(join(repo.recordDir, 'tool-calls.jsonl'), 'utf8');
    expect(toolCalls).toContain('"tool":"bash"');
    expect(toolCalls).toContain('"type":"tool_result"');
  });

  it('reads the session log out of the attempt home before destroying it', async () => {
    const { run, repo } = harness();
    const receipt = await run();

    // A13: the session log is the only durable token-usage source, so it has to
    // survive the home it was written to.
    const sessionArtifacts = receipt.artifacts.filter((a) => a.path.includes('/session/'));
    expect(sessionArtifacts.length).toBeGreaterThan(0);
    const log = sessionArtifacts.find((a) => a.path.endsWith('.jsonl'));
    expect(log).toBeDefined();
    expect(readFileSync(log?.path ?? '', 'utf8')).toContain('sess-fixture-success');
    expect(log?.path.startsWith(repo.recordDir)).toBe(true);

    // …and the home itself is gone, so attempt N cannot configure attempt N+1.
    expect(existsSync(attemptHomePath(repo.factoryHome, ATTEMPT_ID))).toBe(false);
  });

  it('records the launch itself as a command the factory ran', async () => {
    const { run, repo } = harness();
    const receipt = await run();
    const launch = receipt.commands[0];
    expect(launch?.exitCode).toBe(0);
    expect(launch?.timedOut).toBe(false);
    expect(launch?.outputSha).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(launch?.cwd).toBe(repo.attemptDir);
    expect(launch?.argv.slice(0, 6)).toStrictEqual([
      fixturePath('fake-dsh-success.sh'),
      '--profile',
      DSH_PROFILE,
      '--patch',
      join(repo.recordDir, 'dsh-overlay.yml'),
      '--json',
    ]);
    // The git captures are real commands with real exit codes, not narration.
    expect(receipt.commands.some((command) => command.argv[0] === 'git')).toBe(true);
    for (const command of receipt.commands) {
      expect(command.argv.length).toBeGreaterThan(0);
      expect(command.argv.every((arg) => arg.length > 0)).toBe(true);
    }
  });

  it('never lets the prompt itself reach the receipt as prose', async () => {
    const { run, repo } = harness();
    const receipt = await run();
    const prompt = readFileSync(join(repo.recordDir, TASK_FILE), 'utf8');
    expect(receipt.narrative).not.toContain(prompt.trim());
    // The prompt is argv verbatim, byte for byte.
    expect(receipt.commands[0]?.argv.at(-1)).toBe(prompt);
  });
});

describe('createDshExecutor — a failed attempt', () => {
  it('still returns a receipt, with the real exit code', async () => {
    const { run } = harness('fake-dsh-error.sh');
    const receipt = await run();

    expect(receipt.exitCode).toBe(1);
    expect(receipt.sessionId).toBe('sess-fixture-error');
    expect(WorkerReceipt.safeParse(receipt).success).toBe(true);
    // DSH writes an empty `final` on the error path; the adapter must not turn
    // that into a claim that anything was completed.
    expect(receipt.narrative).toBe('');
    const stderr = readFileSync(
      receipt.artifacts.find((a) => a.path.endsWith('stderr.log'))?.path ?? '',
      'utf8',
    );
    expect(stderr).toContain('PROVIDER_ERROR');
  });

  it('returns a receipt for a crash with no turn end at all', async () => {
    const { run } = harness('fake-dsh-crash.sh');
    const receipt = await run();
    expect(receipt.exitCode).toBe(2);
    expect(receipt.sessionId).toBe('sess-fixture-crash');
    expect(receipt.narrative).toBeNull();
    expect(WorkerReceipt.safeParse(receipt).success).toBe(true);
  });

  it('keeps a truncated stream visible in the receipt artefacts', async () => {
    const { run } = harness('fake-dsh-crash.sh');
    const receipt = await run();
    const stdout = readFileSync(
      receipt.artifacts.find((a) => a.path.endsWith('stdout.log'))?.path ?? '',
      'utf8',
    );
    expect(stdout).toContain('"phase":"step_st');
  });

  it('names the max-tokens ceiling as a failure, not as success', async () => {
    const { run } = harness('fake-dsh-max-tokens.sh');
    const receipt = await run();
    expect(receipt.exitCode).toBe(1);
    expect(receipt.ceilings.turnsUsed).toBe(2);
    expect(receipt.narrative).toBe('I was part way through');
  });

  it('captures a write to a gitignored path, which the diff cannot show', async () => {
    // A3.5: `git status --porcelain` hides `!! ignored.txt`, so a worker can write
    // a `.env` or a token there and the diff, the untracked list and the receipt
    // all miss it unless the adapter asks for ignored paths explicitly.
    const { run } = harness('fake-dsh-ignored.sh');
    const receipt = await run();
    const artifact = receipt.artifacts.find((a) => a.path.endsWith('ignored-paths.txt'));
    expect(artifact).toBeDefined();
    expect(readFileSync(artifact?.path ?? '', 'utf8')).toContain('ignored.txt');
    // It is a finding about the attempt, not a change in the patch.
    expect(readFileSync(receipt.diff.patchFile, 'utf8')).not.toContain('ignored.txt');
  });
});

describe('createDshExecutor — work the patch cannot see', () => {
  it('records the paths the working tree reports but the patch does not contain', async () => {
    // `statusPaths` is what lets the wall tell "changed nothing" from "did work it
    // never staged". Here the work is real and nearly invisible: a nested git
    // repository. The outer status reports `?? nested/` and never looks inside,
    // and `git add --all .` stores a *gitlink*, not the content.
    const receipt = await harness('fake-dsh-embedded.sh').run();

    expect(receipt.diff.statusPaths).toStrictEqual(['nested/']);
    // The wall only consults `statusPaths` when the diff is empty, and this diff is
    // not: it holds one submodule pointer. That is a real hole in the *wall's*
    // view — one changed path, an empty patch body — and recording the pointer
    // verbatim is the most the adapter can honestly do about it.
    const patch = readFileSync(receipt.diff.patchFile, 'utf8');
    expect(patch).toContain('new file mode 160000');
    expect(patch).toContain('Subproject commit');
    expect(patch).not.toContain('work the outer tree cannot see');
    expect(receipt.diff.filesChanged).toBe(1);
  });
});

describe('createDshExecutor — a runaway attempt', () => {
  it('trips the wall clock, kills the process group and reaps the grandchild', async () => {
    const dir = tempDir('hang');
    const pidFile = join(dir, 'grandchild.pid');
    const { run } = harness('fake-dsh-hang.sh', {
      wallClockMs: 400,
      parentEnv: { PATH: process.env['PATH'] ?? '', FACTORY_FAKE_GRANDCHILD_PID: pidFile },
    });

    const receipt = await run();

    // Killed by a signal, so there is no exit code — recorded verbatim.
    expect(receipt.exitCode).toBeNull();
    expect(receipt.ceilings.hit).toStrictEqual(['wall-clock']);
    expect(receipt.sessionId).toBe('sess-fixture-hang');
    expect(WorkerReceipt.safeParse(receipt).success).toBe(true);
    expect(receipt.diff.baseRev).toMatch(/^[0-9a-f]{40}$/);

    const grandchild = Number(readFileSync(pidFile, 'utf8').trim());
    expect(Number.isInteger(grandchild)).toBe(true);
    expect(await eventually(() => isDead(grandchild), 5000)).toBe(true);
  });

  it('trips the output-bytes ceiling on a stream that never ends', async () => {
    const { run } = harness('fake-dsh-noisy.sh', { maxOutputBytes: 50_000 });
    const receipt = await run();
    expect(receipt.ceilings.hit).toStrictEqual(['output-bytes']);
    expect(receipt.exitCode).toBeNull();
    expect(WorkerReceipt.safeParse(receipt).success).toBe(true);
  });
});

describe('createDshExecutor — refusals', () => {
  it('refuses a checkout whose .git is a file, which no single mount can use', async () => {
    // The exact A3.2 failure: a linked worktree's `.git` is a file holding an
    // absolute host path, so git inside the container resolves nothing.
    const repo = fixtureRepo();
    const linked = join(repo.factoryHome, 'linked');
    mkdirSync(linked);
    writeFileSync(
      join(linked, '.git'),
      `gitdir: ${join(repo.sourceRepo, '.git', 'worktrees', 'x')}\n`,
    );
    const error = await rejection(executorFor(repo).run({ ...PAYLOAD, attemptDir: linked }, CTX));
    expect(error.code).toBe('EXECUTOR_UNAVAILABLE');
    expect(error.message).toMatch(/file, not a directory/);
  });

  it('refuses a directory with no checkout at all', async () => {
    const repo = fixtureRepo();
    const empty = join(repo.factoryHome, 'empty');
    mkdirSync(empty);
    const error = await rejection(executorFor(repo).run({ ...PAYLOAD, attemptDir: empty }, CTX));
    expect(error.message).toMatch(/is missing/);
  });

  it('refuses an attempt id that would escape the record directory', async () => {
    const repo = fixtureRepo();
    const error = await rejection(
      executorFor(repo).run(
        { ...PAYLOAD, attemptId: '../escape', attemptDir: repo.attemptDir },
        CTX,
      ),
    );
    expect(error.code).toBe('INTERNAL');
    expect(error.message).toMatch(/unsafe attemptId/);
  });

  it('tells the operator to provision when the profile is missing', async () => {
    // DSH's own failure here is a node stack trace recommending `dsh plugin add`,
    // which is the wrong remedy. The adapter must say what to actually run.
    const repo = fixtureRepo();
    rmSync(join(repo.factoryHome, 'dsh-home'), { recursive: true, force: true });
    const error = await rejection(
      executorFor(repo).run({ ...PAYLOAD, attemptDir: repo.attemptDir }, CTX),
    );
    expect(error.code).toBe('EXECUTOR_UNAVAILABLE');
    expect(error.message).toContain('provision-dsh-home.sh');
  });

  it('refuses to dispatch to a dsh that is not the pinned build', async () => {
    const dir = tempDir('wrongversion');
    const canary = join(dir, 'dispatched');
    const { run } = harness('fake-dsh-wrongversion.sh', {
      parentEnv: { PATH: process.env['PATH'] ?? '', FACTORY_FAKE_DISPATCHED: canary },
    });
    const error = await rejection(run());
    expect(error.code).toBe('DSH_VERSION_MISMATCH');
    expect(error.details['expected']).toBe(PINNED_DSH_VERSION);
    expect(error.details['actual']).toBe('0.2.1-rc.4');
    expect(existsSync(canary)).toBe(false);
  });

  it('accepts a caller-supplied pin, so the contract module can own it later', async () => {
    const { run } = harness('fake-dsh-success.sh', { expectedVersion: '0.2.1-rc.3' });
    const receipt = await run();
    expect(receipt.exitCode).toBe(0);
  });

  it('refuses to report a run whose profile silently degraded', async () => {
    // DSH exits 0 here. Only the stderr warning says the permission service fell
    // back to defaults, so this must fail loudly rather than produce a receipt
    // that looks healthy.
    const { run, repo } = harness('fake-dsh-degraded.sh');
    const error = await rejection(run());
    expect(error.code).toBe('EXECUTOR_UNAVAILABLE');
    expect(error.message).toMatch(/did not activate/);
    // Even a refused attempt destroys its home.
    expect(existsSync(attemptHomePath(repo.factoryHome, ATTEMPT_ID))).toBe(false);
  });

  it('refuses an attempt record with no prompt', async () => {
    const { run, repo } = harness();
    rmSync(join(repo.recordDir, TASK_FILE));
    const error = await rejection(run());
    expect(error.code).toBe('EXECUTOR_UNAVAILABLE');
    expect(error.message).toContain(TASK_FILE);
  });

  it('refuses an empty prompt', async () => {
    const repo = fixtureRepo({ task: '   \n\n' });
    const error = await rejection(
      executorFor(repo).run({ ...PAYLOAD, attemptDir: repo.attemptDir }, CTX),
    );
    expect(error.message).toMatch(/is empty/);
  });

  it('refuses a negative attempt ordinal', async () => {
    const repo = fixtureRepo();
    const error = await rejection(
      executorFor(repo).run(
        { ...PAYLOAD, attemptDir: repo.attemptDir },
        { effectId: 'e', attempt: -1 },
      ),
    );
    expect(error.code).toBe('INTERNAL');
  });
});

describe('the worker environment', () => {
  it('carries no credential into the child process', async () => {
    const dir = tempDir('env');
    const envOut = join(dir, 'child.env');
    const { run } = harness('fake-dsh-env.sh', {
      parentEnv: {
        PATH: process.env['PATH'] ?? '',
        BIFROST_API_KEY: 'sk-ant-api03-not-a-real-key',
        ANTHROPIC_API_KEY: 'sk-ant-also-not-real',
        HOME: '/host/home/must-not-cross',
        FACTORY_FAKE_ENV_OUT: envOut,
        FACTORY_OK: 'yes',
        FACTORY_PROXY_TOKEN: 'must-be-dropped',
      },
    });
    await run();

    const childEnv = readFileSync(envOut, 'utf8');
    const names = childEnv.split('\n').map((line) => line.split('=')[0] ?? '');
    expect(names).not.toContain('BIFROST_API_KEY');
    expect(names).not.toContain('ANTHROPIC_API_KEY');
    expect(names).not.toContain('HOME');
    expect(childEnv).not.toContain('sk-ant');
    expect(names).toContain('DSH_TELEMETRY_DISABLED');
    expect(names).toContain('DSH_HOME');
    expect(childEnv).toMatch(/^FACTORY_OK=yes$/m);
    // Credential-shaped names are dropped even when factory-prefixed.
    expect(names).not.toContain('FACTORY_PROXY_TOKEN');
  });

  it('points DSH_HOME at a per-attempt home, never at the shared template', async () => {
    const dir = tempDir('env');
    const envOut = join(dir, 'child.env');
    const repo = fixtureRepo();
    await executorFor(repo, 'fake-dsh-env.sh', {
      parentEnv: { PATH: process.env['PATH'] ?? '', FACTORY_FAKE_ENV_OUT: envOut },
    }).run({ ...PAYLOAD, attemptDir: repo.attemptDir }, CTX);

    const expected = attemptHomePath(repo.factoryHome, ATTEMPT_ID);
    expect(readFileSync(envOut, 'utf8')).toContain(`DSH_HOME=${expected}`);
    // A13: the shared per-domain home is a seed, never a runtime home.
    expect(expected).not.toContain(join('dsh-home', 'worker'));
    expect(existsSync(expected)).toBe(false);
  });

  it('leaves the provisioned template intact after a run', async () => {
    const dir = tempDir('env');
    const envOut = join(dir, 'child.env');
    const repo = fixtureRepo();
    await executorFor(repo, 'fake-dsh-env.sh', {
      parentEnv: { PATH: process.env['PATH'] ?? '', FACTORY_FAKE_ENV_OUT: envOut },
    }).run({ ...PAYLOAD, attemptDir: repo.attemptDir }, CTX);
    // The template is only ever read; the attempt writes to its own home.
    expect(listHomeFiles(join(repo.factoryHome, 'dsh-home', 'worker'))).toStrictEqual([
      `profiles/${DSH_PROFILE}/cordis.patch.yml`,
      `profiles/${DSH_PROFILE}/cordis.yml`,
      `profiles/${DSH_PROFILE}/package.json`,
    ]);
  });
});

describe('statusPathsFrom', () => {
  const none = new Set<string>();

  it('reports untracked and unstaged paths the patch does not contain', () => {
    const porcelain = ['?? scratch.md', ' M src/a.ts', 'A  staged.ts'].join('\n');
    // `A ` is already in the index; whether the patch carries it is decided by
    // the patch, not by the letter.
    expect(statusPathsFrom(porcelain, new Set(['staged.ts']))).toStrictEqual([
      'scratch.md',
      'src/a.ts',
    ]);
  });

  it('never reports a path the patch already describes', () => {
    // Otherwise every successful capture would claim untracked work and the
    // wall's `receipt_unfaithful` check would fire on honest attempts.
    const porcelain = '?? NEW.md\n M README.md';
    expect(statusPathsFrom(porcelain, new Set(['NEW.md', 'README.md']))).toStrictEqual([]);
  });

  it('ignores ignored paths, which A3.5 records separately', () => {
    expect(statusPathsFrom('!! ignored.txt\n?? real.txt', none)).toStrictEqual(['real.txt']);
  });

  it('takes the new name of a rename', () => {
    expect(statusPathsFrom('R  old.md -> new.md', none)).toStrictEqual(['new.md']);
  });

  it('unescapes a quoted path', () => {
    expect(statusPathsFrom('?? "weird\\tname.md"', none)).toStrictEqual(['weird\\tname.md']);
  });

  it('does not repeat a path that moved between columns', () => {
    // `MM` is one path in two states, not two paths.
    // `MM a.ts` and ` M a.ts` are the same path in two states.
    expect(statusPathsFrom('MM a.ts\n M a.ts', none)).toStrictEqual(['a.ts']);
  });

  it('is empty for a clean tree', () => {
    expect(statusPathsFrom('', none)).toStrictEqual([]);
    expect(statusPathsFrom('\n', none)).toStrictEqual([]);
  });

  it('is capped where the contract caps it', () => {
    const many = Array.from({ length: 5000 }, (_, index) => `?? file-${String(index)}.txt`).join(
      '\n',
    );
    expect(statusPathsFrom(many, none)).toHaveLength(4096);
  });
});

describe('buildChildEnv', () => {
  it('allows only PATH, the DSH vars and non-credential FACTORY_ names', () => {
    const env = buildChildEnv('/factory/dsh-home/attempts/a1', {
      PATH: '/usr/bin',
      FOO: 'bar',
      FACTORY_A: '1',
    });
    expect(env).toStrictEqual({
      DSH_HOME: '/factory/dsh-home/attempts/a1',
      DSH_TELEMETRY_DISABLED: '1',
      PATH: '/usr/bin',
      FACTORY_A: '1',
    });
  });

  it('reports what it dropped, by name only', () => {
    const dropped: string[] = [];
    buildChildEnv('/h', { FACTORY_CLIENT_SECRET: 'x' }, (name) => dropped.push(name));
    expect(dropped).toStrictEqual(['FACTORY_CLIENT_SECRET']);
  });

  it('does not require the parent to have a PATH', () => {
    expect(buildChildEnv('/h', {}).PATH).toBe('/usr/local/bin:/usr/bin:/bin');
  });
});

describe('the documented defaults', () => {
  it('bounds every run even when the caller configures nothing', () => {
    expect(DEFAULT_WALL_CLOCK_MS).toBe(15 * 60 * 1000);
    expect(DEFAULT_MAX_OUTPUT_BYTES).toBe(8 * 1024 * 1024);
  });

  it('keeps the sandbox root, the mount target and the cwd one path', () => {
    // A3.2: DSH keys its session log by cwd and `--session-id` adoption refuses
    // when cwd differs, so the overlay's workspaceRoot must be the clone itself.
    const repo = fixtureRepo();
    const overlay = buildOverlay({
      attemptDir: repo.attemptDir,
      proxyBaseUrl: PROXY,
      modelId: MODEL,
    });
    expect(entryValue(overlay, 'workspaceRoot')).toBe(repo.attemptDir);
  });
});
