/**
 * `node apps/panel/src/main.ts` — start the read-only status page.
 *
 * Prints the URL and the token it will accept, then serves until signalled. The
 * token goes to stdout because that is the only channel that is not a file, a
 * shell history entry or a screenshot: the operator reads it once and keeps the
 * tab open.
 *
 * Exit codes: `0` on a clean shutdown, `1` when the panel cannot start (unusable
 * token, port already bound, non-loopback bind). A failure to start is never
 * silent and never a retry loop: the operator asked for a page that
 * authenticates, and there isn't one.
 */
import { homedir } from 'node:os';
import { join } from 'node:path';

import { PINNED_DSH_VERSION } from '@factory/dsh-adapter';
import { openStore } from '@factory/store';

import { probeDshVersion } from './dsh-version.ts';
import { createPanelServer } from './server.ts';
import { resolvePanelToken } from './token.ts';

export const DEFAULT_PORT = 7373;
export const DEFAULT_HOST = '127.0.0.1';
const EXIT_FAILURE = 1;

/** `FACTORY_PANEL_PORT`, with a parsed value or the default. */
export function resolvePort(env: Readonly<Record<string, string | undefined>>): number {
  const raw = env['FACTORY_PANEL_PORT'];
  if (raw === undefined || raw.trim().length === 0) return DEFAULT_PORT;
  const parsed = Number.parseInt(raw, 10);
  if (!Number.isInteger(parsed) || parsed < 0 || parsed > 65_535) {
    throw new Error(`FACTORY_PANEL_PORT='${raw}' is not a port number`);
  }
  return parsed;
}

/** `FACTORY_STATE_DIR` holds `factory.db`; the CLI uses the same default. */
export function resolveStateDir(env: Readonly<Record<string, string | undefined>>): string {
  const override = env['FACTORY_STATE_DIR'];
  if (typeof override === 'string' && override.trim().length > 0) return override;
  return join(homedir(), '.factory', 'state');
}

function fail(message: string): never {
  process.stderr.write(`factory panel: ${message}\n`);
  process.exit(EXIT_FAILURE);
}

async function main(): Promise<void> {
  const env = process.env;
  let port: number;
  try {
    port = resolvePort(env);
  } catch (error) {
    fail(error instanceof Error ? error.message : String(error));
  }

  const resolved = resolvePanelToken(env);
  if (!resolved.ok) fail(resolved.message);

  const stateDir = resolveStateDir(env);
  let store;
  try {
    store = openStore({ dir: stateDir });
  } catch (error) {
    fail(
      `cannot open the store at ${stateDir}: ${error instanceof Error ? error.message : String(error)}`,
    );
  }

  // Probe the observed DSH version once, here, and inject it. The page then has
  // three honest states — ok, degraded (a skew), unavailable (could not look) — and
  // the health strip appears only when one of them is true of the actual machine.
  const dshVersionObserved = probeDshVersion();

  const server = createPanelServer({
    store,
    token: resolved.token,
    dshVersionObserved: () => dshVersionObserved,
  });
  let listener;
  try {
    // Loopback only. `createPanelServer` refuses anything else, so this line is
    // also the assertion that the page is not on the network.
    listener = await server.listen(port);
  } catch (error) {
    fail(
      `cannot listen on ${DEFAULT_HOST}:${port}: ${error instanceof Error ? error.message : String(error)}`,
    );
  }

  // The token is printed on its own line, `token: <value>`, so a script can read it
  // with one regex and never has to guess where it ends.
  process.stdout.write(`factory panel: ${listener.url}\n`);
  process.stdout.write(`token: ${resolved.token}\n`);
  process.stdout.write(`token source: ${resolved.source} ${resolved.path}\n`);
  process.stdout.write(`store: ${stateDir}\n`);
  process.stdout.write(
    `dsh: ${dshVersionObserved ?? 'unavailable'} (expected ${PINNED_DSH_VERSION})\n`,
  );
  process.stdout.write('read-only: no route accepts a body; loopback only\n');
  process.stdout.write('stop with ctrl-c\n');

  const shutdown = (): void => {
    void listener.close().then(() => process.exit(0));
  };
  process.once('SIGINT', shutdown);
  process.once('SIGTERM', shutdown);
}

await main();
