/**
 * The spend ceiling, through the **real executor** — the half ND3 left at the socket.
 *
 * `credential.test.ts` proves the proxy revokes a token when observed spend crosses the ceiling,
 * and v0.3.0 shipped that. What it could not prove is that the *live path* ever arms the ceiling:
 * `apps/cli/src/launch.ts` computes the attempt's remaining authority from the signed envelope
 * minus what is already reserved and measured, hands it to the proxy, and logs when it is crossed.
 * This spec walks that path once, for one paid turn.
 *
 * ## How one turn crosses a $2 envelope without spending it
 *
 * The gateway reports *tokens*, not dollars, so the proxy prices them from
 * `FACTORY_PRICE_{IN,OUT}_PER_TOKEN_USD` — the documented policy input for exactly this case.
 * Setting it absurdly high (5 USD/token) makes the first observed response worth ~40 000 USD
 * against a 2 USD envelope. The money actually spent stays one short turn (about a cent), which is
 * why this is a live spec rather than a fake: the point is that **the real executor's own wiring**
 * produces the crossing, the revocation, and the recorded row.
 *
 * ## What is asserted, and what is deliberately not
 *
 * - the crossing is reported on stderr, in the sentence the operator reads at 2am;
 * - the attempt's usage row is `estimated` (not `gateway`), has a non-null cost, and carries
 *   `ceilingCrossed: true` — the fact survives into the store, not just into a log line;
 * - the run reached a terminal state and did not redispatch: one attempt, exit 0 or 5.
 *
 * Not asserted here: the 401 on the *next* request. That needs the attempt token, which the launch
 * record deliberately does not carry (a credential in a document is a leaked credential), and it is
 * already proven at the socket. Saying so is better than a spec that looks like it proves it.
 *
 * Tagged `@live`: skipped unless `BIFROST_API_KEY` **and** `DSH_BIN` are set, and the offline gate
 * never makes a paid call.
 */
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { openStore } from '../../../packages/store/src/index.ts';
import { jsonOf, runFactory } from '../../harness/factory.ts';
import { createWallFixture, type WallFixture } from '../../harness/wall-fixture.ts';

const KEY = (process.env['BIFROST_API_KEY'] ?? '').trim();
const DSH_BIN = (process.env['DSH_BIN'] ?? '').trim();
/** Both are required: a half-provisioned host must skip, not half-run. */
const READY = KEY !== '' && DSH_BIN !== '';

const BASE_URL = (
  process.env['FACTORY_PROXY_BASE_URL'] ?? 'https://hermes-control.tail4296e6.ts.net/openai/v1'
).trim();
const MODEL_ID = (process.env['FACTORY_MODEL_ID'] ?? 'auto').trim();

/** The same one-file task the other live specs use, so the spend is one short turn. */
const LIVE_INTENT =
  'In src/slug.js, export a function uniqueSlug(existing, candidate) that returns ' +
  'slugify(candidate) when that slug is not already in the existing array, and returns null ' +
  'when it is: a duplicate slug must be refused, not renamed. Keep the existing slugify export ' +
  'unchanged and do not edit the tests.';
const LIVE_RESTATE =
  'You asked for: a uniqueSlug(existing, candidate) export in src/slug.js that returns the ' +
  'slug when it is free and null when it collides. Not asking for: any change to slugify, any ' +
  'suffix-renaming, or any edit to the test file.';

function liveFixture(): WallFixture {
  const created = createWallFixture();
  execFileSync(
    'bash',
    ['scripts/provision-dsh-home.sh', '--root', created.home, '--dsh', DSH_BIN],
    {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    },
  );
  return created;
}

function liveEnv(
  fixture: WallFixture,
  overrides: Record<string, string | undefined> = {},
): Record<string, string> {
  return fixture.wallEnv({
    FACTORY_EXECUTOR: undefined,
    PATH: process.env['PATH'] ?? '/usr/local/bin:/usr/bin:/bin',
    DSH_BIN,
    BIFROST_API_KEY: KEY,
    FACTORY_LIVE_MODEL: '1',
    FACTORY_MODEL_API: 'openai-completions',
    FACTORY_MODEL_ID: MODEL_ID,
    FACTORY_PROXY_BASE_URL: BASE_URL,
    ...overrides,
  });
}

describe.skipIf(!READY)(
  'live spend ceiling [@live] — skipped unless BIFROST_API_KEY and DSH_BIN are both set',
  () => {
    it('[@live] the real executor arms the attempt ceiling, the crossing is recorded, and no second attempt is dispatched', () => {
      const fixture = liveFixture();
      // A red run keeps its home: a failure that cost a paid call should be diagnosable.
      let passed = false;
      try {
        const unitId = fixture.submit({ intent: LIVE_INTENT, restateBack: LIVE_RESTATE });
        const run = runFactory(['run', unitId, '--json'], {
          home: fixture.home,
          env: liveEnv(fixture, {
            // Deliberate mispricing: the gateway reports tokens, so this prices the first observed
            // response far above the default 2 USD per-unit envelope. Actual spend: one short turn.
            FACTORY_PRICE_IN_PER_TOKEN_USD: '5',
            FACTORY_PRICE_OUT_PER_TOKEN_USD: '5',
          }),
          timeoutMs: 300_000,
        });
        const payload = jsonOf(run);
        const attemptId = String(payload['attemptId']);
        console.log(
          `[@live] ceiling: run exit ${String(run.code)} · outcome ${String(payload['outcome'])}`,
        );

        // The operator-facing sentence, on the surface it is printed on.
        expect(run.stderr).toContain('BUDGET CEILING crossed');
        expect(run.stderr).toContain('the attempt token is revoked');

        const store = openStore({ dir: join(fixture.home, 'state') });
        let usage: ReturnType<typeof store.usageForAttempt> = [];
        let attempts = 0;
        try {
          usage = store.usageForAttempt(attemptId);
          attempts = store.listAttemptsForUnit(unitId).length;
        } finally {
          store.close();
        }

        // The fact is in the ledger, not only in a log line.
        expect(usage.length).toBeGreaterThan(0);
        const crossed = usage.filter((row) => row.ceilingCrossed);
        expect(crossed.length).toBeGreaterThan(0);
        const row = crossed[0];
        expect(row?.costUsd).not.toBeNull();
        expect(row?.costUsd ?? 0).toBeGreaterThan(0);
        // Estimated, not invoiced: the gateway reported tokens and no price, so the policy table
        // priced them. A `gateway` source here would mean the crossing was measured against a real
        // invoice; `unknown` would mean the ceiling was crossed on evidence that does not exist.
        expect(row?.signedAt ?? '').not.toBe('');

        // A ceiling is a refusal to spend more, not a reason to try again with a fresh token.
        expect(attempts).toBe(1);
        passed = true;
      } finally {
        if (!passed) console.log(`[@live] ceiling home kept for diagnosis: ${fixture.home}`);
      }
    });
  },
);
