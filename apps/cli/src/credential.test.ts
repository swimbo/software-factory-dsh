/**
 * The launcher's credential, proven without a paid call.
 *
 * The upstream is a `node:http` server inside the spec, so every assertion is about a real
 * socket talking to a real proxy: what header the gateway received, what the worker got when
 * its token was wrong, and — the one that matters most — that a token captured before the
 * settle is answered 401 after it. That last spec is the wiring proof for "revoked before the
 * verdict is written": `launch.ts` calls `settle()` in a `finally`, and this is the same call.
 */
import { chmodSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  apiKeyPath,
  openAttemptCredential,
  resolveApiKey,
  type AttemptCredential,
} from './credential.ts';

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

// ---------------------------------------------------------------------------
// Where the key comes from: the environment, or a file nobody else can read
//
// The file path exists because operators put `BIFROST_API_KEY` into a launch agent, and a plist
// in `~/Library/LaunchAgents` is readable by other local users and by anything that snapshots the
// home directory. These specs are about the *resolution order and the refusal*, not about the
// proxy: the proxy's own specs already prove what the gateway receives.
// ---------------------------------------------------------------------------

describe('resolveApiKey', () => {
  const scratch = (): string => mkdtempSync(join(tmpdir(), 'factory-key-'));

  /** A factory home with a key file at `secrets/bifrost-key`, in the mode asked for. */
  function homeWithKey(contents: string, mode: number): string {
    const home = scratch();
    mkdirSync(join(home, 'secrets'), { recursive: true });
    const path = join(home, 'secrets', 'bifrost-key');
    writeFileSync(path, contents);
    chmodSync(path, mode);
    return home;
  }

  it('prefers the environment, and does not need a file at all', () => {
    const resolved = resolveApiKey({ BIFROST_API_KEY: 'from-env', FACTORY_HOME: scratch() });
    expect(resolved).toEqual({ ok: true, key: 'from-env', source: 'environment' });
  });

  it('reads a 0600 file when the environment has no key, trimming the newline a paste leaves', () => {
    const home = homeWithKey('sk-from-a-file\n', 0o600);
    const resolved = resolveApiKey({ FACTORY_HOME: home });
    expect(resolved).toEqual({ ok: true, key: 'sk-from-a-file', source: 'file' });
  });

  it('refuses a 0644 file and names chmod 600 instead of using it', () => {
    const home = homeWithKey('sk-should-not-be-read', 0o644);
    const resolved = resolveApiKey({ FACTORY_HOME: home });
    expect(resolved.ok).toBe(false);
    if (resolved.ok) throw new Error('unreachable');
    expect(resolved.detail).toContain('chmod 600');
    expect(resolved.detail).toContain('secrets/bifrost-key');
    // The value must not appear in a refusal that will be printed to a terminal and a log.
    expect(resolved.detail).not.toContain('sk-should-not-be-read');
  });

  it('names both ways to provide a key when there is none anywhere', () => {
    const resolved = resolveApiKey({ FACTORY_HOME: scratch() });
    expect(resolved.ok).toBe(false);
    if (resolved.ok) throw new Error('unreachable');
    expect(resolved.detail).toContain('BIFROST_API_KEY');
    expect(resolved.detail).toContain('0600');
  });

  it('resolves the file under FACTORY_HOME, defaulting to ~/.factory', () => {
    expect(apiKeyPath({ FACTORY_HOME: '/tmp/elsewhere' })).toBe(
      '/tmp/elsewhere/secrets/bifrost-key',
    );
    expect(apiKeyPath({})).toBe(join(homedir(), '.factory', 'secrets', 'bifrost-key'));
  });

  it('treats an empty key file as a mistake, not as "no key configured"', () => {
    const home = homeWithKey('   \n', 0o600);
    const resolved = resolveApiKey({ FACTORY_HOME: home });
    expect(resolved.ok).toBe(false);
    if (resolved.ok) throw new Error('unreachable');
    expect(resolved.detail).toContain('empty');
  });
});
