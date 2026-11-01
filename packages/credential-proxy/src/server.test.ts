/**
 * The credential proxy, tested against a fake gateway.
 *
 * Every spec here would cost real tokens against the real gateway, so the upstream is a
 * `node:http` server inside the file. That is not a shortcut — it is the only way to assert
 * the two things that matter most: **what header the gateway actually receives**, and what the
 * worker receives when the token is wrong, expired, revoked, out of prefix, or oversized.
 *
 * The five refusals get five specs with five distinct reasons, because "401" alone cannot tell
 * an operator whether a worker had the wrong token, a dead token, or a token for another
 * attempt.
 */
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { join } from 'node:path';
import type { Server } from 'node:http';
import { afterEach, describe, expect, it } from 'vitest';
import { startCredentialProxy, pathWithinPrefix, type CredentialProxy } from './server.ts';

const GATEWAY_KEY = 'sk-gateway-do-not-leak';

interface FakeGateway {
  readonly url: string;
  readonly seen: { method: string; path: string; authorization: string | null; body: string }[];
  close(): Promise<void>;
}

/** A gateway that records what it was asked and answers a small JSON body. */
async function fakeGateway(): Promise<FakeGateway> {
  const seen: FakeGateway['seen'] = [];
  const server: Server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => chunks.push(chunk));
    req.on('end', () => {
      seen.push({
        method: req.method ?? '',
        path: req.url ?? '',
        authorization:
          typeof req.headers['authorization'] === 'string' ? req.headers['authorization'] : null,
        body: Buffer.concat(chunks).toString('utf8'),
      });
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ ok: true, path: req.url }));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
  const address = server.address();
  if (address === null || typeof address === 'string') throw new Error('no port');
  return {
    url: `http://127.0.0.1:${String(address.port)}/openai/v1`,
    seen,
    async close() {
      if (!server.listening) return;
      await new Promise<void>((resolve, reject) =>
        server.close((error) => (error === undefined ? resolve() : reject(error))),
      );
    },
  };
}

/** A clock the spec moves by hand: expiry is a property under test, not a wait. */
function fixedClock(start: string): { now: () => string; set: (iso: string) => void } {
  let current = start;
  return { now: () => current, set: (iso) => (current = iso) };
}

let gateway: FakeGateway | null = null;
let proxy: CredentialProxy | null = null;

afterEach(async () => {
  await proxy?.close();
  proxy = null;
  await gateway?.close();
  gateway = null;
});

async function start(options: { maxBodyBytes?: number; now?: () => string } = {}): Promise<{
  proxy: CredentialProxy;
  baseUrl: string;
  origin: string;
  token: string;
}> {
  const upstream = await fakeGateway();
  gateway = upstream;
  proxy = await startCredentialProxy({
    upstream: { baseUrl: upstream.url, apiKey: GATEWAY_KEY },
    now: options.now ?? (() => '2026-11-01T12:00:00.000Z'),
    ...(options.maxBodyBytes === undefined ? {} : { maxBodyBytes: options.maxBodyBytes }),
  });
  const minted = proxy.tokens.mint({
    attemptId: 'A-1',
    issuedAt: '2026-11-01T11:55:00.000Z',
    expiresAt: '2026-11-01T12:40:00.000Z',
  });
  return {
    proxy,
    baseUrl: proxy.baseUrl,
    origin: `http://127.0.0.1:${String(proxy.port)}`,
    token: minted.token,
  };
}

async function call(
  target: { baseUrl: string; token: string },
  input: {
    method?: string;
    path?: string;
    body?: string;
    token?: string | null;
  } = {},
): Promise<{ status: number; body: string; headers: Record<string, string> }> {
  const token = input.token === undefined ? target.token : input.token;
  const response = await fetch(`${target.baseUrl}${input.path ?? '/chat/completions'}`, {
    method: input.method ?? 'POST',
    headers: {
      'content-type': 'application/json',
      ...(token === null ? {} : { authorization: `Bearer ${token}` }),
    },
    ...(input.method === 'GET' ? {} : { body: input.body ?? '{"model":"auto"}' }),
  });
  const body = await response.text();
  const headers: Record<string, string> = {};
  response.headers.forEach((value, name) => {
    headers[name] = value;
  });
  return { status: response.status, body, headers };
}

const reasonOf = (body: string): string =>
  (JSON.parse(body) as { error: { reason: string } }).error.reason;

describe('the key is injected by the proxy and never by the worker', () => {
  it('forwards the request with the gateway key, not the token', async () => {
    const started = await start();
    const response = await call(started, {});
    expect(response.status).toBe(200);
    expect(gateway?.seen).toHaveLength(1);
    expect(gateway?.seen[0]?.authorization).toBe(`Bearer ${GATEWAY_KEY}`);
    // The worker's token never reached the gateway, and the key never reaches the worker.
    expect(gateway?.seen[0]?.authorization).not.toContain(started.token);
    expect(response.body).not.toContain(GATEWAY_KEY);
    expect(response.headers['authorization']).toBeUndefined();
  });

  it('forwards the body and the path unchanged, and streams the response back', async () => {
    const started = await start();
    const body = '{"model":"auto","messages":[]}';
    const response = await call(started, { path: '/chat/completions', body });
    expect(response.status).toBe(200);
    expect(gateway?.seen[0]?.path).toBe('/openai/v1/chat/completions');
    expect(gateway?.seen[0]?.body).toBe(body);
    expect(JSON.parse(response.body)).toEqual({ ok: true, path: '/openai/v1/chat/completions' });
  });

  it('mints a 128-bit token that is not the key and is unique per attempt', async () => {
    const started = await start();
    // 16 bytes, base64url, no padding: 22 characters.
    expect(started.token).toHaveLength(22);
    expect(started.token).not.toBe(GATEWAY_KEY);
    const second = started.proxy.tokens.mint({
      attemptId: 'A-2',
      issuedAt: '2026-11-01T11:55:00.000Z',
      expiresAt: '2026-11-01T12:40:00.000Z',
    });
    expect(second.token).not.toBe(started.token);
  });
});

describe('the five refusals, each with its own reason', () => {
  it('refuses an unknown token with 401', async () => {
    const started = await start();
    const response = await call(started, { token: 'not-a-token' });
    expect(response.status).toBe(401);
    expect(reasonOf(response.body)).toBe('unknown-token');
    // A guessed token is not echoed back into a body another log will copy.
    expect(response.body).not.toContain('not-a-token');
    expect(gateway?.seen).toHaveLength(0);
  });

  it('refuses a missing token with 401 rather than treating the request as anonymous', async () => {
    const started = await start();
    const response = await call(started, { token: null });
    expect(response.status).toBe(401);
    expect(reasonOf(response.body)).toBe('unknown-token');
  });

  it('refuses an expired token with 401, judged by the injected clock', async () => {
    const clock = fixedClock('2026-11-01T12:00:00.000Z');
    const started = await start({ now: clock.now });
    // Inside the lease: forwarded.
    expect((await call(started, {})).status).toBe(200);
    // One second past expiry: refused, with no sleep and no wall-clock read.
    clock.set('2026-11-01T12:40:01.000Z');
    const expired = await call(started, {});
    expect(expired.status).toBe(401);
    expect(reasonOf(expired.body)).toBe('token-expired');
    expect(gateway?.seen).toHaveLength(1);
  });

  it('refuses a revoked token with 401 — this is what settling an attempt does', async () => {
    const started = await start();
    expect((await call(started, {})).status).toBe(200);
    expect(started.proxy.tokens.revoke(started.token)).toBe(true);
    const revoked = await call(started, {});
    expect(revoked.status).toBe(401);
    expect(reasonOf(revoked.body)).toBe('token-revoked');
    expect(gateway?.seen).toHaveLength(1);
    // Idempotent: settling twice is not an error.
    expect(started.proxy.tokens.revoke(started.token)).toBe(false);
  });

  it('refuses a path outside the configured upstream prefix with 403', async () => {
    const started = await start();
    const outside = await call(
      { baseUrl: started.origin, token: started.token },
      {
        path: '/other/v1/chat/completions',
      },
    );
    expect(outside.status).toBe(403);
    expect(reasonOf(outside.body)).toBe('path-outside-upstream');
    // Traversal that *starts* with the prefix is the interesting bypass.
    const traversal = await call(
      { baseUrl: started.origin, token: started.token },
      {
        path: '/../../etc/passwd',
      },
    );
    expect(traversal.status).toBe(403);
    expect(gateway?.seen).toHaveLength(0);
  });

  it('refuses a method outside the allowlist with 405', async () => {
    const started = await start();
    const deleted = await call(started, { method: 'DELETE' });
    expect(deleted.status).toBe(405);
    expect(reasonOf(deleted.body)).toBe('method-not-allowed');
    expect(gateway?.seen).toHaveLength(0);
    // GET is allowed: a model listing is a legitimate call.
    expect((await call(started, { method: 'GET', path: '/models' })).status).toBe(200);
  });

  it('refuses a body over the size cap with 413 and forwards nothing', async () => {
    const started = await start({ maxBodyBytes: 64 });
    const big = 'x'.repeat(65);
    const response = await call(started, { body: big });
    expect(response.status).toBe(413);
    expect(reasonOf(response.body)).toBe('body-too-large');
    // The oversized bytes never reached the gateway: the cap is enforced while reading.
    expect(gateway?.seen).toHaveLength(0);
  });
});

describe('revocation on settle, end to end', () => {
  it('lets the same token through before the settle and refuses it after', async () => {
    const started = await start();
    // The token the launcher minted for this attempt.
    const before = await call(started, {});
    expect(before.status).toBe(200);

    // `settle`: the attempt ended, so its authority ends before any verdict is written.
    started.proxy.tokens.revokeAll();
    expect(started.proxy.tokens.census().live).toBe(0);

    const after = await call(started, {});
    expect(after.status).toBe(401);
    expect(reasonOf(after.body)).toBe('token-revoked');
  });

  it('records the scoped credential for the launch record without the token', async () => {
    const started = await start();
    const minted = started.proxy.tokens.mint({
      attemptId: 'A-3',
      issuedAt: '2026-11-01T11:55:00.000Z',
      expiresAt: '2026-11-01T12:40:00.000Z',
    });
    const described = started.proxy.describe(minted);
    expect(described).toEqual({ token: 'scoped', expiresAt: '2026-11-01T12:40:00.000Z' });
    // The value is not in the description, which is what goes into `launch.json`.
    expect(JSON.stringify(described)).not.toContain(minted.token);
  });
});

describe('the stream lifecycle: nothing outlives the turn that opened it', () => {
  it('lets the process exit after a turn is abandoned mid-stream', async () => {
    // This one is spawned, not called: the property under test is **process exit**, and a factory
    // that finishes a verified unit and then never dies is invisible to an assertion made inside
    // the same process. It hung a live run at its 300 s guard with the verdict already written;
    // the child reproduces it in one second. Without the fix it prints `done` and then hangs
    // forever, because the upstream leg is still streaming into a socket the closed proxy no
    // longer reads.
    const child = spawn(
      process.execPath,
      [join(import.meta.dirname, '__fixtures__', 'exit-child.ts')],
      {
        stdio: ['ignore', 'pipe', 'pipe'],
      },
    );
    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk: string) => (stdout += chunk));
    child.stderr.on('data', (chunk: string) => (stderr += chunk));
    const outcome = await Promise.race([
      new Promise<'exited'>((resolve) => child.once('exit', () => resolve('exited'))),
      new Promise<'hung'>((resolve) => setTimeout(() => resolve('hung'), 5_000)),
    ]);
    if (outcome === 'hung') child.kill('SIGKILL');
    expect(stdout).toContain('done');
    expect(outcome, `${stderr}\nthe proxy kept an upstream stream open past close()`).toBe(
      'exited',
    );
    proxy = null;
  });

  it('tears the upstream leg down when the worker abandons a streaming response', async () => {
    // The in-process half of the same property: the client leg going away must destroy the
    // upstream leg rather than leaving a stream running into a socket nobody reads (`pipe`
    // destroys the destination, not the source).
    const clock = '2026-11-01T00:00:00.000Z';
    let upstreamConnections = 0;
    const gateway: Server = createServer((_req, res) => {
      upstreamConnections += 1;
      res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' });
      res.write('data: {"delta":"half a turn"}\n\n');
    });
    await new Promise<void>((resolve) => gateway.listen(0, '127.0.0.1', () => resolve()));
    const address = gateway.address();
    if (address === null || typeof address === 'string') throw new Error('no port');

    const started = await startCredentialProxy({
      upstream: {
        baseUrl: `http://127.0.0.1:${String(address.port)}/openai/v1`,
        apiKey: GATEWAY_KEY,
      },
      now: () => clock,
    });
    const minted = started.tokens.mint({
      attemptId: 'A-abandoned',
      issuedAt: clock,
      expiresAt: '2026-11-01T00:10:00.000Z',
    });

    const controller = new AbortController();
    const request = fetch(`${started.baseUrl}/chat/completions`, {
      method: 'POST',
      headers: { authorization: `Bearer ${minted.token}`, 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'auto' }),
      signal: controller.signal,
    }).catch(() => null);

    // Read the first chunk, then abandon the response exactly as a finished turn would.
    await new Promise((resolve) => setTimeout(resolve, 50));
    controller.abort();
    await request;

    const closed = await Promise.race([
      started.close().then(() => 'closed' as const),
      new Promise<'hung'>((resolve) => setTimeout(() => resolve('hung'), 2_000)),
    ]);
    expect(upstreamConnections, 'the gateway was asked exactly once').toBe(1);
    expect(closed, 'the proxy held its own stream open after the worker left').toBe('closed');
    await new Promise<void>((resolve) => {
      gateway.closeAllConnections();
      gateway.close(() => resolve());
    });
    proxy = null;
  });
});

describe('path confinement is segment-wise, not a string prefix', () => {
  it('accepts the prefix itself and paths below it', () => {
    expect(pathWithinPrefix('/openai/v1', '/openai/v1')).toBe('');
    expect(pathWithinPrefix('/openai/v1/models', '/openai/v1')).toBe('/models');
    // A *sibling* that shares the string is not inside the prefix.
    expect(pathWithinPrefix('/openai/v1evil/x', '/openai/v1')).toBeNull();
    // Query strings do not smuggle a path through the check.
    expect(pathWithinPrefix('/openai/v1/chat?next=/etc/passwd', '/openai/v1')).toBe(
      '/chat?next=/etc/passwd',
    );
    expect(pathWithinPrefix('/openai/v1/../admin', '/openai/v1')).toBeNull();
    expect(pathWithinPrefix('/openai/v1/a/../models', '/openai/v1')).toBe('/models');
  });

  it('closes the door and revokes every token with it', async () => {
    const started = await start();
    await started.proxy.close();
    // Closing twice is safe: a settle path and a shutdown path may both close.
    await started.proxy.close();
    proxy = null;
    expect(started.proxy.tokens.census()).toEqual({ live: 0, revoked: 1 });
  });
});
