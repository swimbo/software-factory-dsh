/**
 * The live layer: two real model calls, and nothing that can run without them.
 *
 * These are the only specs in the tree that spend money, and they are gated twice: on
 * `BIFROST_API_KEY` **and** on `DSH_BIN`, because a spec that runs with a key but no binary
 * reports `EXECUTOR_UNAVAILABLE`, which reads like a product fault instead of a missing
 * prerequisite. With either unset the whole file skips with a reason naming both variables, so
 * the offline gate (`scripts/verify.sh`, `pnpm run test:e2e`) never makes a paid call.
 *
 * E2E-47 and E2E-48 of `e2e-tests.md`. What is proven here:
 *
 *   1. a one-shot turn through the **factory's own path** — real executor, factory-composed
 *      overlay, factory-rendered prompt — completes and leaves a receipt faithful enough to be
 *      reproduced: `turn_end.reason.kind === 'completed'`, non-zero token usage, exit 0, and the
 *      command the receipt recorded re-runs green;
 *   2. a model that cannot answer is recorded as a **failure**, never as a pass: the attempt's
 *      evidence holds no completed turn, and the run does not report success.
 *
 * Two calls, one per spec. The prompt is the fixture's one-file task (`src/slug.js`, proven by
 * `node tests/suite.js`), so the spend stays at a single short turn each.
 *
 * KNOWN RED, deliberately: the happy-path spec below fails today on `receipt_unfaithful` because
 * the wall replays the recorded *worker launch* command (receipt `commands[0]`) and the two
 * index-dependent `git diff` commands, none of which can reproduce. The adapter now emits
 * provenance for every recorded command (`packages/dsh-adapter/src/launch-record.ts`:
 * `source: 'worker-launch' | 'worker-command' | 'factory-verification'` with `replayable` and
 * `replaySkipReason`), and writes it as `command-provenance.json` beside the receipt because the
 * receipt contract strips unknown keys. The wall owner is implementing the replay policy that
 * consumes it; until that lands, this spec stays red rather than asserting around the defect.
 */
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { jsonOf, runFactory } from '../../harness/factory.ts';
import { createWallFixture, type WallFixture } from '../../harness/wall-fixture.ts';

const KEY = (process.env['BIFROST_API_KEY'] ?? '').trim();
const DSH_BIN = (process.env['DSH_BIN'] ?? '').trim();
/** Both are required, and the reason says so: a half-provisioned host must skip, not half-run. */
const READY = KEY !== '' && DSH_BIN !== '';

const BASE_URL = (
  process.env['FACTORY_PROXY_BASE_URL'] ?? 'https://hermes-control.tail4296e6.ts.net/openai/v1'
).trim();
/** `auto` resolves server-side to the pinned model; the spec prints what the gateway answers. */
const MODEL_ID = (process.env['FACTORY_MODEL_ID'] ?? 'auto').trim();

/** The prompt the factory renders: one file, one checkable oracle, no room to wander. */
const LIVE_INTENT =
  'In src/slug.js, export a function uniqueSlug(existing, candidate) that returns ' +
  'slugify(candidate) when that slug is not already in the existing array, and returns null ' +
  'when it is: a duplicate slug must be refused, not renamed. Keep the existing slugify export ' +
  'unchanged and do not edit the tests.';
const LIVE_RESTATE =
  'You asked for: a uniqueSlug(existing, candidate) export in src/slug.js that returns the ' +
  'slug when it is free and null when it collides. Not asking for: any change to slugify, any ' +
  'suffix-renaming, or any edit to the test file.';

interface TurnFact {
  readonly raw: string;
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly totalTokens: number;
}

/**
 * Read the attempt's NDJSON stream and summarise the turn.
 *
 * Read from `stdout.log` rather than from the receipt, deliberately: the receipt carries the
 * *conclusion* (`turnsUsed`, ceilings), and the raw stream is where the model's own claims live.
 * A faithful-receipt spec has to look at both, or it proves only that a file exists.
 */
function readTurn(recordDir: string): {
  readonly completed: boolean;
  readonly usage: TurnFact | null;
  readonly errors: readonly string[];
} {
  const path = join(recordDir, 'stdout.log');
  if (!existsSync(path)) return { completed: false, usage: null, errors: [] };
  let completed = false;
  let usage: TurnFact | null = null;
  const errors: string[] = [];
  for (const line of readFileSync(path, 'utf8').split('\n')) {
    if (line.trim() === '') continue;
    let event: Record<string, unknown>;
    try {
      event = JSON.parse(line) as Record<string, unknown>;
    } catch {
      continue;
    }
    const type = String(event['type'] ?? '');
    const phase = String(event['phase'] ?? '');
    const isTurnEnd = type === 'turn_end' || (type === 'status' && phase === 'turn_end');
    if (isTurnEnd) {
      const reason = (event['reason'] ?? {}) as { kind?: unknown };
      if (reason.kind === 'completed') completed = true;
    }
    if (type === 'step_end' || isTurnEnd) {
      const raw = (event['usage'] ?? {}) as Record<string, unknown>;
      const total = typeof raw['totalTokens'] === 'number' ? raw['totalTokens'] : undefined;
      if (total !== undefined && total > 0) {
        const model = typeof event['model'] === 'string' ? event['model'] : '(not reported)';
        usage = {
          raw: model,
          inputTokens: typeof raw['inputTokens'] === 'number' ? raw['inputTokens'] : 0,
          outputTokens: typeof raw['outputTokens'] === 'number' ? raw['outputTokens'] : 0,
          totalTokens: total,
        };
      }
    }
    if (type === 'error' || event['error'] !== undefined) {
      const message = String((event['error'] as { message?: unknown })?.message ?? event['error']);
      errors.push(message.slice(0, 300));
    }
  }
  return { completed, usage, errors };
}

let fixture: WallFixture | null = null;
let provisioned = '';

beforeAll(() => {
  if (!READY) return;
  fixture = createWallFixture();
  // Provisioning inside the spec, against the fixture's own home: a live run that depended on
  // an operator's `dsh-home` would pass on one machine and nowhere else. `--dump-config` is what
  // makes this free — it composes the profile instead of booting it, so no turn can start here.
  provisioned = execFileSync(
    'bash',
    ['scripts/provision-dsh-home.sh', '--root', fixture.home, '--dsh', DSH_BIN],
    { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] },
  );
  // The claim, not the exit code: provisioning must have produced no model call at all.
  expect(provisioned).not.toMatch(/"usage"|turn_end/u);
}, 600_000);

afterAll(() => {
  fixture?.cleanup();
});

/** The live environment: the wall's knobs, plus the one thing that makes a call possible. */
function liveEnv(overrides: Record<string, string | undefined> = {}): Record<string, string> {
  if (fixture === null) throw new Error('fixture missing');
  return fixture.wallEnv({
    // Absent, so the CLI takes the real executor path instead of the scripted one.
    FACTORY_EXECUTOR: undefined,
    PATH: process.env['PATH'] ?? '/usr/local/bin:/usr/bin:/bin',
    DSH_BIN,
    BIFROST_API_KEY: KEY,
    // The single documented opt-in: without it the allowlist refuses to hand `dsh` a key.
    FACTORY_LIVE_MODEL: '1',
    FACTORY_MODEL_API: 'openai-completions',
    FACTORY_MODEL_ID: MODEL_ID,
    FACTORY_PROXY_BASE_URL: BASE_URL,
    ...overrides,
  });
}

describe.skipIf(!READY)(
  'live model [@live] — skipped unless BIFROST_API_KEY and DSH_BIN are both set',
  () => {
    it('[@live] a one-shot turn through the factory completes and leaves a reproducible receipt', () => {
      if (fixture === null) throw new Error('fixture missing');
      const unitId = fixture.submit({ intent: LIVE_INTENT, restateBack: LIVE_RESTATE });
      const run = runFactory(['run', unitId, '--json'], {
        home: fixture.home,
        env: liveEnv(),
        timeoutMs: 300_000,
      });

      // Assert the CLI's own account first: everything below reads files the run writes, and
      // an ENOENT on `receipt.json` says nothing about why the launch failed.
      expect(run.code, `${run.stdout}${run.stderr}`).toBe(0);
      const attemptId = String(jsonOf(run)['attemptId']);
      const recordDir = join(fixture.home, 'attempts', unitId, attemptId);
      const turn = readTurn(recordDir);
      const receipt = JSON.parse(readFileSync(join(recordDir, 'receipt.json'), 'utf8')) as {
        exitCode: number | null;
        ceilings: { hit: string[]; turnsUsed: number };
        diff: { filesChanged: number };
        commands: { argv: string[]; cwd: string; exitCode: number | null }[];
      };
      const launch = JSON.parse(readFileSync(join(recordDir, 'launch.json'), 'utf8')) as {
        profile: { requested: string; effective: string | null };
        overlay: { sha256: string | null };
        credentialsForwarded: string[];
      };

      // Printed so the evidence file can cite the real model and the real spend.
      console.log(
        `[@live] run exit ${String(run.code)} · requested model ${MODEL_ID} → reported ${
          turn.usage?.raw ?? '(none)'
        } · tokens in ${String(turn.usage?.inputTokens ?? 0)} / out ${String(
          turn.usage?.outputTokens ?? 0,
        )} / total ${String(turn.usage?.totalTokens ?? 0)}`,
      );

      // 1. the turn completed, by the model's own event stream
      expect(turn.completed).toBe(true);
      // 2. and it cost tokens: a "completed" turn with no usage is a fabricated receipt
      expect(turn.usage?.totalTokens ?? 0).toBeGreaterThan(0);
      // 3. the receipt is faithful about the process and the change
      expect(receipt.exitCode).toBe(0);
      expect(receipt.ceilings.hit).toStrictEqual([]);
      expect(receipt.diff.filesChanged).toBeGreaterThan(0);
      // 4. the overlay is the factory's, and the credential reached the child by name only
      expect(launch.profile.effective).not.toBeNull();
      expect(launch.overlay.sha256).toMatch(/^sha256:[0-9a-f]{64}$/u);
      expect(launch.credentialsForwarded).toStrictEqual(['BIFROST_API_KEY']);
      expect(JSON.stringify(launch)).not.toContain(KEY);

      // 5. the recorded command reproduces: re-run what the receipt says was run, in the
      //    directory it says it ran in. The oracle is the one the acceptance names.
      const oracle = receipt.commands.find((command) => command.argv.join(' ').includes('suite'));
      const argv = oracle?.argv ?? ['node', 'tests/suite.js'];
      const cwd = oracle?.cwd ?? join(fixture.home, 'state', 'attempts', attemptId);
      expect(() =>
        execFileSync(argv[0] ?? 'node', argv.slice(1), { cwd, encoding: 'utf8' }),
      ).not.toThrow();
    }, 420_000);

    it('[@live] a model that cannot answer is recorded as a failure, never as a pass', () => {
      if (fixture === null) throw new Error('fixture missing');
      const unitId = fixture.submit({ intent: LIVE_INTENT, restateBack: LIVE_RESTATE });
      // Provoked honestly: the overlay asks the gateway for a model id it cannot resolve, so
      // the failure comes from the real provider handshake rather than from a stubbed error.
      const run = runFactory(['run', unitId, '--json'], {
        home: fixture.home,
        env: liveEnv({ FACTORY_MODEL_ID: 'factory-worker-tier-that-does-not-exist' }),
        timeoutMs: 300_000,
      });
      // Assert the CLI's own account first: everything below reads files the run writes, and
      // an ENOENT on `receipt.json` says nothing about why the launch failed.

      // The failure path asserts the opposite: exit 0 here would be the bug.
      const attemptId = String(jsonOf(run)['attemptId']);
      const recordDir = join(fixture.home, 'attempts', unitId, attemptId);
      const turn = readTurn(recordDir);
      const hasReceipt = existsSync(join(recordDir, 'receipt.json'));

      console.log(
        `[@live] refusal: run exit ${String(run.code)} · receipt ${
          hasReceipt ? 'written' : 'absent'
        } · errors ${String(turn.errors.length)}`,
      );

      // No completed turn anywhere in the evidence, and the run did not claim success.
      expect(turn.completed).toBe(false);
      expect(run.code).not.toBe(0);
      if (hasReceipt) {
        const receipt = JSON.parse(readFileSync(join(recordDir, 'receipt.json'), 'utf8')) as {
          exitCode: number | null;
        };
        // A failed launch is a non-zero child, not a clean exit with an empty diff.
        expect(receipt.exitCode === 0 && turn.completed).toBe(false);
      }
    }, 420_000);
  },
);
