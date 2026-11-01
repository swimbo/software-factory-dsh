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
 * The replay contract this spec asserts (landed with the wall owner's scoped replay): the
 * worker launch is `worker-launch`, never replayable — it is the attempt under test, and on a
 * live attempt replaying it would spend money. The factory's post-attempt git reads are
 * `factory-verification`, replayable **as a sequence** from the receipt's base once the wall has
 * rebuilt the attempt index. So a healthy live attempt replays 7 of its 8 recorded commands,
 * reports the scope, and can actually pass. A verdict of `unknown` here would mean every real
 * worker is unpromotable, which is why that assertion is a `pass` and not a shrug.
 */
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

import { openStore } from '../../../packages/store/src/index.ts';
import { selectSuiteCommand, testRefusal } from '../../harness/suite-command.ts';
import { readTurn } from '../../harness/turn-facts.ts';
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

/**
 * One fixture home per spec.
 *
 * The first version shared one home between the two specs, and the second spec died with
 * `UNIT_ALREADY_TERMINAL`: the happy path had already run that home's only unit. A live pair
 * that can only run one at a time is not a suite, and reusing a terminal unit would also have
 * meant measuring a store that already held a verdict.
 */
function liveFixture(): WallFixture {
  const created = createWallFixture();
  // Provisioning against the fixture's own home: a live run that depended on an operator's
  // `dsh-home` would pass on one machine and nowhere else. `--dump-config` composes the profile
  // instead of booting it, so no turn can start here — the claim below is that it did not.
  const output = execFileSync(
    'bash',
    ['scripts/provision-dsh-home.sh', '--root', created.home, '--dsh', DSH_BIN],
    { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] },
  );
  expect(output).not.toMatch(/"usage"|turn_end/u);
  return created;
}

/** The live environment: the wall's knobs, plus the one thing that makes a call possible. */
function liveEnv(
  fixture: WallFixture,
  overrides: Record<string, string | undefined> = {},
): Record<string, string> {
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
      const fixture = liveFixture();
      // A red run keeps its home: a spec that deletes its own evidence turns a diagnosis into a
      // guess (it cost one paid call already). Green removes it.
      let passed = false;
      try {
        const unitId = fixture.submit({ intent: LIVE_INTENT, restateBack: LIVE_RESTATE });
        const run = runFactory(['run', unitId, '--json'], {
          home: fixture.home,
          env: liveEnv(fixture),
          timeoutMs: 300_000,
        });

        // Assert the CLI's own account first: everything below reads what the run recorded.
        const verdict = jsonOf(run);
        const attemptId = String(verdict['attemptId']);
        // The real executor keeps the attempt *artifacts* (launch.json, task.md, stdout.log, the
        // patch) under `attempts/<unit>/<attempt>`, while the child runs in `state/attempts/<id>`
        // and the receipt itself exists only in the store — three different places, and the guard
        // that read a `receipt.json` file here was describing one that is never written.
        const recordDir = join(fixture.home, 'attempts', unitId, attemptId);
        const turn = readTurn(recordDir);

        const store = openStore({ dir: join(fixture.home, 'state') });
        let stored: ReturnType<typeof store.latestReceiptForUnit> = null;
        try {
          stored = store.latestReceiptForUnit(unitId);
        } finally {
          store.close();
        }
        if (stored === null) {
          const lastStatus = run.stderr
            .split('\n')
            .map((line) => line.trim())
            .filter((line) => line !== '')
            .slice(-1)[0];
          expect.fail(
            'no receipt row in the store for this attempt — the run recorded nothing that can be ' +
              'checked\n' +
              `  cli exit code   ${String(run.code)}\n` +
              `  attempt state   ${String(verdict['attemptState'])} (unit state ${String(
                verdict['state'],
              )})\n` +
              `  last status     ${String(lastStatus ?? '(stderr was empty)')}\n` +
              `  record dir      ${recordDir}\n` +
              `  stdout          ${run.stdout.trim().split('\n').slice(-1)[0] ?? ''}`,
          );
        }
        const receipt = stored.receipt;
        const launch = JSON.parse(readFileSync(join(recordDir, 'launch.json'), 'utf8')) as {
          profile: { requested: string; effective: string | null };
          overlay: { sha256: string | null };
          credentialsForwarded: string[];
          credentialProxy: { token: string; expiresAt: string } | null;
        };

        // Printed so the evidence file can cite the real model, the real spend and the outcome.
        console.log(
          `[@live] run exit ${String(run.code)} · requested model ${MODEL_ID} → reported ${
            turn.usage?.raw ?? '(none)'
          } · tokens in ${String(turn.usage?.inputTokens ?? 0)} / out ${String(
            turn.usage?.outputTokens ?? 0,
          )} / total ${String(turn.usage?.totalTokens ?? 0)} · outcome ${String(verdict['outcome'])}`,
        );

        // 1. a real attempt is promotable: the wall replayed the deterministic half of the
        //    factory-verification group, in recorded order, from the receipt's base (5 of 8 commands), the launch was not replayed
        //    because it is the attempt under test, and nothing mismatched. A verdict of `unknown`
        //    here would mean every real worker is unpromotable, which is not caution, it is a wall
        //    that can never open.
        expect(verdict['outcome']).toBe('pass');
        expect(run.code).toBe(0);
        expect(verdict['reasons']).not.toContain('faithfulness_partial');

        // 2. the scope line, read from the stored verdict rather than from stdout: it must say
        //    how much was replayed, that nothing mismatched, and name the launch as excluded.
        const verdictStore = openStore({ dir: join(fixture.home, 'state') });
        let scope = '';
        try {
          const row = verdictStore.latestVerdictForUnit(unitId);
          expect(row).not.toBeNull();
          const faithfulness = (row?.verdict.scenarios ?? []).filter(
            (scenario) => scenario.source === 'faithfulness',
          );
          expect(faithfulness.every((scenario) => scenario.outcome === 'pass')).toBe(true);
          scope = faithfulness
            .map((scenario) => `${scenario.id} ${scenario.observed ?? ''}`)
            .join(' | ');
        } finally {
          verdictStore.close();
        }
        console.log(
          `[@live] verdict ${String(verdict['outcome'])} · reasons [${String(
            (verdict['reasons'] as string[]).join(', '),
          )}] · ${scope} · exit ${String(run.code)}`,
        );
        expect(scope).toMatch(/replayed\s+5\s+of\s+8/u);
        expect(scope).toMatch(/commands\[0\]|worker-launch/u);
        expect(scope).toMatch(/0\s+mismatched/u);

        // 3. the turn completed, by the model's own event stream, and it cost tokens: a
        //    "completed" turn with no usage would be a fabricated receipt.
        expect(turn.completed).toBe(true);
        expect(turn.usage?.totalTokens ?? 0).toBeGreaterThan(0);

        // 4. the receipt is faithful about the process and the change
        expect(receipt.exitCode).toBe(0);
        expect(receipt.ceilings.hit).toStrictEqual([]);
        expect(receipt.diff.filesChanged).toBeGreaterThan(0);

        // 5. every recorded command carries provenance, and the kinds that cannot be replayed say
        //    why: this is the adapter half of the replay contract.
        for (const command of receipt.commands) {
          expect(['worker-launch', 'worker-command', 'factory-verification']).toContain(
            command.source,
          );
          if (command.replayable !== true) expect(command.replaySkipReason).toBeTruthy();
        }
        expect(receipt.commands[0]?.source).toBe('worker-launch');
        expect(receipt.commands[0]?.replayable).toBe(false);
        expect(receipt.commands[0]?.replaySkipReason).toMatch(/paid|money|spend/iu);
        const verification = receipt.commands.filter(
          (command) => command.source === 'factory-verification',
        );
        expect(verification.length).toBeGreaterThan(0);
        // Replayable as a sequence, from the receipt's base — never independently.
        expect(verification.filter((command) => command.replayable === true)).toHaveLength(5);
        // The two `status` reads also depend on untracked/ignored working-tree contents, which a
        // replay cannot reconstruct from a commit. They are evidence, not claims: measured, the
        // first replay reproduced everything else and mismatched exactly these two.
        const worktreeReads = verification.filter((command) => command.replayable !== true);
        expect(worktreeReads).toHaveLength(2);
        for (const read of worktreeReads) {
          expect(read.argv.join(' ')).toMatch(/status/u);
          expect(read.replaySkipReason).toMatch(/untracked|ignored/iu);
        }

        // 6. the overlay is the factory's, and the worker held a **scoped** credential rather
        //    than the gateway key. This assertion used to read `['BIFROST_API_KEY']`: the live
        //    path forwarded the key, which is the one sentence of the README that was false.
        //    ADR-007's credential proxy retires it, so the record now shows the opposite — no
        //    forwarded credential, and a scoped token that expires with the attempt's lease.
        expect(launch.profile.effective).not.toBeNull();
        expect(launch.overlay.sha256).toMatch(/^sha256:[0-9a-f]{64}$/u);
        expect(launch.credentialsForwarded).toStrictEqual([]);
        expect(launch.credentialProxy?.token).toBe('scoped');
        expect(launch.credentialProxy?.expiresAt).toMatch(/^\d{4}-\d{2}-\d{2}T/u);
        expect(JSON.stringify(launch)).not.toContain(KEY);

        // 7. the suite the receipt names still passes when re-run by hand — selected structurally,
        //    and refused if the selection is ever the worker itself. A substring finder on the
        //    argv matched `commands[0]` (the launch carries the whole prompt, and the prompt says
        //    "suite"), which executed `dsh` a second time: a paid model call made by a test.
        const oracle = selectSuiteCommand(receipt.commands);
        // The real receipt records **no** suite command: the wall runs the suite itself as its own
        // oracle (`acceptance`/`suite` scenarios), and the attempt's `commands[]` are the launch
        // plus the factory's git reads. So the absence is the expected shape and is asserted as
        // such — the fallback to a guess is what made the old finder reachable, and it executed
        // `dsh` a second time.
        if (oracle !== null) {
          const refusal = testRefusal(oracle.argv, DSH_BIN);
          expect(refusal, `refusing to execute ${oracle.argv.join(' ')}`).toBeNull();
          const cwd = oracle.cwd ?? join(fixture.home, 'attempts', unitId, attemptId);
          expect(() =>
            execFileSync(oracle.argv[0] ?? 'node', oracle.argv.slice(1), { cwd, encoding: 'utf8' }),
          ).not.toThrow();
        }
        // Whatever the receipt holds, the launch is present and a test refuses to execute it.
        const launchCommand = receipt.commands[0];
        expect(launchCommand?.source).toBe('worker-launch');
        expect(testRefusal(launchCommand?.argv ?? [], DSH_BIN)).toMatch(/never re-run the worker/u);
        passed = true;
      } finally {
        if (passed) fixture.cleanup();
        else console.error(`[@live] fixture retained for post-mortem: ${fixture.home}`);
      }
    });

    it('[@live] a model that cannot answer is recorded as a failure, never as a pass', () => {
      const fixture = liveFixture();
      // A red run keeps its home: a spec that deletes its own evidence turns a diagnosis into a
      // guess (it cost one paid call already). Green removes it.
      let passed = false;
      try {
        const unitId = fixture.submit({ intent: LIVE_INTENT, restateBack: LIVE_RESTATE });
        // Provoked honestly: the overlay asks the gateway for a model id it cannot resolve, so
        // the failure comes from the real provider handshake rather than from a stubbed error.
        const run = runFactory(['run', unitId, '--json'], {
          home: fixture.home,
          env: liveEnv(fixture, { FACTORY_MODEL_ID: 'factory-worker-tier-that-does-not-exist' }),
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
        // Exit 5 is the documented "the worker's turn failed" code, and it is asserted exactly
        // rather than as "not zero". `runFactory` reports -1 when *this harness* killed the child
        // at `timeoutMs`, and `not.toBe(0)` accepted that: a CLI that hung for five minutes and
        // was shot counted as a passing refusal test, which is a green that means nothing.
        expect(run.code, 'a killed child is a hung factory, not a refused model').toBe(5);
        if (hasReceipt) {
          const receipt = JSON.parse(readFileSync(join(recordDir, 'receipt.json'), 'utf8')) as {
            exitCode: number | null;
          };
          // A failed launch is a non-zero child, not a clean exit with an empty diff.
          expect(receipt.exitCode === 0 && turn.completed).toBe(false);
        }
        passed = true;
      } finally {
        if (passed) fixture.cleanup();
        else console.error(`[@live] fixture retained for post-mortem: ${fixture.home}`);
      }
    }, 420_000);
  },
);
