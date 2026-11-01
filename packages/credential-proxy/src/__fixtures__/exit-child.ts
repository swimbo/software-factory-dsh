/**
 * The child process the "does the door outlive the turn" spec spawns.
 *
 * It exists as a file rather than an inline `-e` string because the property under test is
 * **process exit**, and a one-liner would be the sort of thing a future reader cannot run by
 * hand. Run it directly to see the failure mode:
 *
 *   node packages/credential-proxy/src/__fixtures__/exit-child.ts
 *
 * It prints `done` when the proxy has been closed. If the process then stays alive, an upstream
 * socket is still active: that is the bug — a factory that finishes a verified unit and then
 * never exits, killed by its own timeout with the verdict already written.
 */
import { createServer } from 'node:http';
import { startCredentialProxy } from '../index.ts';

const GATEWAY_KEY = 'sk-gateway-do-not-leak';

// An SSE stream that sends one chunk and then never finishes — what a turn looks like between
// the first delta and the last one.
const gateway = createServer((_req, res) => {
  res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' });
  res.write('data: {"delta":"half a turn"}\n\n');
});
await new Promise<void>((resolve) => gateway.listen(0, '127.0.0.1', () => resolve()));
const address = gateway.address();
if (address === null || typeof address === 'string') throw new Error('no port');

// A fixed clock: this fixture has no opinion about time — the token only has to be alive for the
// second the child runs.
const clock = new Date('2026-11-01T00:00:00.000Z').toISOString();
const proxy = await startCredentialProxy({
  upstream: { baseUrl: `http://127.0.0.1:${String(address.port)}/openai/v1`, apiKey: GATEWAY_KEY },
  now: () => clock,
});
const minted = proxy.tokens.mint({
  attemptId: 'A-exit',
  issuedAt: new Date().toISOString(),
  expiresAt: '2026-11-01T00:10:00.000Z',
});

const controller = new AbortController();
const request = fetch(`${proxy.baseUrl}/chat/completions`, {
  method: 'POST',
  headers: { authorization: `Bearer ${minted.token}`, 'content-type': 'application/json' },
  body: JSON.stringify({ model: 'auto' }),
  signal: controller.signal,
}).catch(() => null);

// Let the first chunk arrive, then close the door *while the worker is still holding its leg
// open* — the shape of a shutdown that interrupts a turn. The client socket is torn down by
// `closeAllConnections`; the upstream leg is a separate socket, and a proxy that forgets it
// leaves a stream running, which keeps this process alive forever.
await new Promise((resolve) => setTimeout(resolve, 50));

await proxy.close();
controller.abort();
await request;
// Stop *accepting* on the fake gateway but deliberately leave the already-accepted, still
// streaming connection open: that is the real shape — the gateway is a service the factory does
// not control, and it has no reason to notice that the worker left.
gateway.close();
process.stdout.write('done\n');
