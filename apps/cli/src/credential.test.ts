/**
 * The launcher's credential, proven without a paid call.
 *
 * The upstream is a `node:http` server inside the spec, so every assertion is about a real
 * socket talking to a real proxy: what header the gateway received, what the worker got when
 * its token was wrong, and — the one that matters most — that a token captured before the
 * settle is answered 401 after it. That last spec is the wiring proof for "revoked before the
 * verdict is written": `launch.ts` calls `settle()` in a `finally`, and this is the same call.
 */
import { createServer } from 'node:http';
import { afterEach, describe, expect, it } from 'vitest';
import { openAttemptCredential, type AttemptCredential } from './credential.ts';

const GATEWAY_KEY = 'sk-gateway-never-in-the-worker';

interface Upstream {
  readonly baseUrl: string;
  readonly seen: { path: string; authorization: string | null }[];
  close(): Promise<void>;
}

async function upstreamServer(): Promise<Upstream> {
  const seen: Upstream['seen'] = [];
  const server = createServer((req, res) => {
    seen.push({
      path: req.url ?? '',
      authorization:
        typeof req.headers['authorization'] === 'string' ? req.headers['authorization'] : null,
    });
    req.resume();
    req.on('end', () => {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end('{"ok":true}');
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
  const address = server.address();
  if (address === null || typeof address === 'string') throw new Error('no port');
  return {
    baseUrl: `http://127.0.0.1:${String(address.port)}/openai/v1`,
    seen,
    async close() {
      if (!server.listening) return;
      await new Promise<void>((resolve, reject) =>
        server.close((error) => (error === undefined ? resolve() : reject(error))),
      );
    },
  };
}

let upstream: Upstream | null = null;
let credential: AttemptCredential | null = null;

afterEach(async () => {
  if (credential !== null) {
    await credential.settle();
    await credential.close();
  }
  credential = null;
  await upstream?.close();
  upstream = null;
});

const NOW = '2026-11-01T12:00:00.000Z';

async function open(
  env: NodeJS.ProcessEnv = {},
  leaseExpiresAt: string | null = '2026-11-01T12:30:00.000Z',
): Promise<AttemptCredential> {
  upstream = await upstreamServer();
  const opened = await openAttemptCredential({
    env: {
      FACTORY_PROXY_BASE_URL: upstream.baseUrl,
      BIFROST_API_KEY: GATEWAY_KEY,
      ...env,
    },
    nowIso: () => NOW,
    attemptId: 'A-1',
    leaseExpiresAt,
  });
  if (!opened.ok) throw new Error(`credential refused: ${opened.detail}`);
  credential = opened.credential;
  return opened.credential;
}

async function call(
  target: AttemptCredential,
  token: string | null,
): Promise<{ status: number; body: string }> {
  const response = await fetch(`${target.baseUrl}/chat/completions`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      ...(token === null ? {} : { authorization: `Bearer ${token}` }),
    },
    body: '{"model":"auto"}',
  });
  return { status: response.status, body: await response.text() };
}

describe('opening the credential for one attempt', () => {
  it('points the worker at a localhost proxy and hands it a token, never the key', async () => {
    const opened = await open();
    expect(opened.baseUrl).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/openai\/v1$/u);
    // 128 bits, base64url: 22 characters.
    expect(opened.token).toHaveLength(22);
    expect(opened.token).not.toBe(GATEWAY_KEY);
    // It expires with the lease it borrows, not with a constant.
    expect(opened.expiresAt).toBe('2026-11-01T12:30:00.000Z');
  });

  it('injects the gateway key upstream and forwards the request unchanged', async () => {
    const opened = await open();
    const response = await call(opened, opened.token);
    expect(response.status).toBe(200);
    expect(upstream?.seen).toHaveLength(1);
    // The gateway sees the key the worker never had.
    expect(upstream?.seen[0]?.authorization).toBe(`Bearer ${GATEWAY_KEY}`);
    expect(upstream?.seen[0]?.authorization).not.toContain(opened.token);
    expect(upstream?.seen[0]?.path).toBe('/openai/v1/chat/completions');
    // And the worker never sees the key in a response.
    expect(response.body).not.toContain(GATEWAY_KEY);
  });

  it('refuses a token it did not mint', async () => {
    const opened = await open();
    const response = await call(opened, 'a'.repeat(22));
    expect(response.status).toBe(401);
    expect(JSON.parse(response.body)).toMatchObject({
      error: { reason: 'unknown-token' },
    });
    expect(upstream?.seen).toHaveLength(0);
  });

  it('revokes on settle: the token that worked a moment ago is answered 401', async () => {
    const opened = await open();
    // Captured before the settle, exactly as a worker would hold it.
    const token = opened.token;
    expect((await call(opened, token)).status).toBe(200);

    // The settle path `launch.ts` runs in a `finally`, before the verdict is written.
    await opened.settle();

    const after = await call(opened, token);
    expect(after.status).toBe(401);
    expect(JSON.parse(after.body)).toMatchObject({ error: { reason: 'token-revoked' } });
    // The upstream saw the one authorised call and nothing after it.
    expect(upstream?.seen).toHaveLength(1);
  });

  it('settles idempotently, so a throw and a finally may both call it', async () => {
    const opened = await open();
    await opened.settle();
    await opened.settle();
    expect((await call(opened, opened.token)).status).toBe(401);
  });

  it('closes the door after settling, so no listener outlives the attempt', async () => {
    const opened = await open();
    await opened.settle();
    await opened.close();
    // Closing twice is safe: a settle path and a shutdown path may both run.
    await opened.close();
    await expect(call(opened, opened.token)).rejects.toThrow(/fetch failed|ECONNREFUSED/u);
  });
});

describe('refusing to half-configure a live run', () => {
  it('names the missing upstream', async () => {
    const opened = await openAttemptCredential({
      env: { BIFROST_API_KEY: GATEWAY_KEY },
      nowIso: () => NOW,
      attemptId: 'A-1',
      leaseExpiresAt: null,
    });
    expect(opened.ok).toBe(false);
    if (opened.ok) throw new Error('expected a refusal');
    expect(opened.detail).toContain('FACTORY_PROXY_BASE_URL');
  });

  it('names the missing key rather than launching a worker that cannot authenticate', async () => {
    const opened = await openAttemptCredential({
      env: { FACTORY_PROXY_BASE_URL: 'https://gateway.example/openai/v1' },
      nowIso: () => NOW,
      attemptId: 'A-1',
      leaseExpiresAt: null,
    });
    expect(opened.ok).toBe(false);
    if (opened.ok) throw new Error('expected a refusal');
    expect(opened.detail).toContain('BIFROST_API_KEY');
  });

  it('refuses when the attempt lease has already expired', async () => {
    const opened = await openAttemptCredential({
      env: {
        FACTORY_PROXY_BASE_URL: 'https://gateway.example/openai/v1',
        BIFROST_API_KEY: GATEWAY_KEY,
      },
      nowIso: () => NOW,
      attemptId: 'A-1',
      leaseExpiresAt: '2026-11-01T11:59:00.000Z',
    });
    expect(opened.ok).toBe(false);
    if (opened.ok) throw new Error('expected a refusal');
    // Dead on arrival is refused, not minted and left to fail inside `dsh`.
    expect(opened.detail).toContain('dead on arrival');
  });
});
