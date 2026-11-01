/**
 * The credential proxy: a localhost door the worker may knock on, holding the key itself.
 *
 * ## The threat model, in five lines
 *
 * 1. A worker that can read its own environment gets the **scoped token**: bounded to this
 *    process's socket, bounded in lifetime by the attempt's lease, confined to one upstream
 *    path prefix, and revoked the moment the attempt settles.
 * 2. It does **not** get the gateway key, and no request it makes can cause the key to appear
 *    in a response, a log line, or the launch record.
 * 3. A worker that can read `/proc/<pid>/environ` of the *controller* (same uid, no isolation)
 *    is a host-level attacker and is **out of scope**: this proxy is a boundary between the
 *    worker process and the credential, not between the operator and the machine.
 * 4. DSH's sandbox is not a security boundary (it is `workspace-write`, same uid) and nothing
 *    here claims otherwise.
 * 5. The gateway sees the factory, not the worker: every request that arrives is one the
 *    factory authorised, on a path the factory confined, from a token the factory can revoke.
 *
 * ## Why this is not `packages/proxy`
 *
 * `packages/proxy` brokers *privileged operations* — a `sudo`, a `docker`, a write into
 * `/etc` — with a human decision. This package brokers a *credential*: it has no decision
 * path, no operator phrase and no operation classification, because the thing being
 * constrained is not "may this command run" but "may this token reach this prefix". They are
 * separate for a mechanical reason too: a proxy in front of its own supervisor deadlocks, and
 * `packages/proxy/src/operations.ts` classifies `docker` — the container the wall might run in
 * — as a brokered operation, so the two must never be one process. Reusing one module for both
 * would mean a credential check that can be stalled by a privileged-operation decision.
 *
 * ## Shape
 *
 * `127.0.0.1:<ephemeral>`, `http://`, one upstream base URL, one path prefix. Every request is
 * checked in this order — token, method, path, body size — and each refusal has its own reason
 * so an operator reading a log can tell a wrong path from a dead token. Only then is the
 * request forwarded, with `Authorization: Bearer <gateway key>` written by *this* file.
 */
import {
  createServer,
  request as httpRequest,
  type ClientRequest,
  type IncomingMessage,
  type Server,
} from 'node:http';
import { request as httpsRequest } from 'node:https';
import type { ServerResponse } from 'node:http';
import {
  createTokenRegistry,
  type ScopedToken,
  type TokenRefusal,
  type TokenRegistry,
} from './tokens.ts';

/** Refusals the proxy can make. Each is a different fact, so each has a different reason. */
export const PROXY_REFUSALS = [
  ...(['unknown-token', 'token-expired', 'token-revoked'] as const),
  'method-not-allowed',
  'path-outside-upstream',
  'body-too-large',
  'upstream-unavailable',
] as const;
export type ProxyRefusal = (typeof PROXY_REFUSALS)[number];

export interface UpstreamTarget {
  /** e.g. `https://hermes-control.tail4296e6.ts.net/openai/v1`. The path becomes the prefix. */
  readonly baseUrl: string;
  /** The gateway key. Lives here and in the upstream `Authorization` header, nowhere else. */
  readonly apiKey: string;
}

export interface CredentialProxyOptions {
  readonly upstream: UpstreamTarget;
  /** Injected clock; the proxy never reads the wall clock itself. */
  readonly now: () => string;
  /** HTTP methods the proxy forwards. Default `['GET', 'POST']` — a model call is both. */
  readonly allowedMethods?: readonly string[];
  /** Body cap, in bytes. Default 1 MiB; a chat request with a large prompt is far under it. */
  readonly maxBodyBytes?: number;
  /** Upstream timeout. Default 10 minutes, matching a long streaming completion. */
  readonly requestTimeoutMs?: number;
  /** Structured refusal/forward events. Never contains the key or a full token. */
  readonly onEvent?: (event: ProxyEvent) => void;
}

export interface ProxyEvent {
  readonly kind: 'forward' | 'refuse';
  readonly reason?: ProxyRefusal | undefined;
  readonly method?: string | undefined;
  readonly path?: string | undefined;
  readonly status?: number | undefined;
  readonly durationMs?: number | undefined;
}

export interface CredentialProxy {
  /** `http://127.0.0.1:<port><upstream path>` — the value the overlay's `baseURL` gets. */
  readonly baseUrl: string;
  readonly port: number;
  readonly tokens: TokenRegistry;
  /**
   * What `launch.json` records about the credential: that it is scoped and when it dies.
   * Never the token itself — a launch record is evidence and gets copied around.
   */
  describe(token: ScopedToken): { readonly token: 'scoped'; readonly expiresAt: string };
  close(): Promise<void>;
}

const DEFAULT_MAX_BODY_BYTES = 1024 * 1024;
const DEFAULT_TIMEOUT_MS = 10 * 60 * 1000;

/** The bearer value of an `Authorization` header, or `null`. Case-insensitive scheme. */
function bearerOf(req: IncomingMessage): string | null {
  const header = req.headers['authorization'];
  if (typeof header !== 'string') return null;
  const match = /^Bearer\s+(.+)$/iu.exec(header.trim());
  return match?.[1]?.trim() ?? null;
}

function refusalStatus(reason: ProxyRefusal): number {
  switch (reason) {
    case 'unknown-token':
    case 'token-expired':
    case 'token-revoked':
      return 401;
    case 'path-outside-upstream':
      return 403;
    case 'method-not-allowed':
      return 405;
    case 'body-too-large':
      return 413;
    case 'upstream-unavailable':
      return 502;
  }
}

/** Where the request path sits relative to the configured prefix, or `null` when outside. */
export function pathWithinPrefix(requestPath: string, prefix: string): string | null {
  // The query string is not part of the confinement decision, but it *is* part of the
  // request: `/openai/v1/chat?stream=1` and `/openai/v1/chat?x=/etc/passwd` are both inside.
  const [rawPath = '/', query] = requestPath.split('?');
  let decoded: string;
  try {
    decoded = decodeURIComponent(rawPath);
  } catch {
    return null;
  }
  // Normalise *before* comparing. `/openai/v1/../admin` starts with the prefix and resolves
  // outside it, which is exactly the bypass a string prefix test invites.
  const segments: string[] = [];
  for (const segment of decoded.split('/')) {
    if (segment === '' || segment === '.') continue;
    if (segment === '..') {
      if (segments.length === 0) return null;
      segments.pop();
      continue;
    }
    segments.push(segment);
  }
  const normalised = `/${segments.join('/')}`;
  if (prefix === '') return requestPath;
  const suffix = query === undefined ? '' : `?${query}`;
  if (normalised === prefix) return suffix;
  if (!normalised.startsWith(`${prefix}/`)) return null;
  return `${normalised.slice(prefix.length)}${suffix}`;
}

export async function startCredentialProxy(
  options: CredentialProxyOptions,
): Promise<CredentialProxy> {
  const upstreamUrl = new URL(options.upstream.baseUrl);
  const origin = `${upstreamUrl.protocol}//${upstreamUrl.host}`;
  const prefix = upstreamUrl.pathname.replace(/\/+$/u, '');
  const allowedMethods = options.allowedMethods ?? ['GET', 'POST'];
  const maxBodyBytes = options.maxBodyBytes ?? DEFAULT_MAX_BODY_BYTES;
  const requestTimeoutMs = options.requestTimeoutMs ?? DEFAULT_TIMEOUT_MS;
  const tokens = createTokenRegistry({ now: options.now });
  const send = upstreamUrl.protocol === 'https:' ? httpsRequest : httpRequest;
  // Every upstream request that is still streaming. A proxy that forgets one keeps a socket
  // open for the gateway's full timeout, and an open socket keeps *this* process alive: the
  // factory would finish a verified unit and then sit there until it was killed. That is not a
  // hypothetical — it hung a live run at 300 s with the verdict already written.
  const inFlight = new Set<ClientRequest>();

  const server: Server = createServer((req, res) => {
    const started = performance.now();
    const refused = (reason: ProxyRefusal, detail: string): void => {
      options.onEvent?.({
        kind: 'refuse',
        reason,
        method: req.method,
        path: req.url,
        status: refusalStatus(reason),
        durationMs: Math.round(performance.now() - started),
      });
      const body = JSON.stringify({ error: { reason, detail } });
      res.writeHead(refusalStatus(reason), {
        'content-type': 'application/json; charset=utf-8',
        'content-length': Buffer.byteLength(body),
        // A refusal is data, not a redirect; and the worker learns nothing about the key.
        'cache-control': 'no-store',
      });
      res.end(body);
    };

    // 1. The token, before anything else about the request is believed.
    const verdict = tokens.verify(bearerOf(req));
    if (!verdict.ok) {
      refused(verdict.reason satisfies TokenRefusal, verdict.detail);
      return;
    }

    // 2. The method. A gateway needs GET (models) and POST (completions); anything else is
    // not a model call and has no business crossing this boundary.
    const method = (req.method ?? 'GET').toUpperCase();
    if (!allowedMethods.includes(method)) {
      refused(
        'method-not-allowed',
        `${method} is not one of the methods this proxy forwards (${allowedMethods.join(', ')})`,
      );
      return;
    }

    // 3. The path, confined to the configured upstream prefix.
    const relative = pathWithinPrefix(req.url ?? '/', prefix);
    if (relative === null) {
      refused(
        'path-outside-upstream',
        `the request path is outside the configured upstream prefix ${prefix || '(none)'}`,
      );
      return;
    }

    // 4. The body, capped while it is read rather than after it is buffered: a 100 GB body
    // must never be held in memory waiting for a 413.
    const chunks: Buffer[] = [];
    let size = 0;
    let settled = false;
    req.on('data', (chunk: Buffer) => {
      if (settled) return;
      size += chunk.length;
      if (size > maxBodyBytes) {
        settled = true;
        refused('body-too-large', `the request body exceeds the ${String(maxBodyBytes)}-byte cap`);
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('error', () => {
      // A client that vanished is not a proxy fault; nothing to answer.
      settled = true;
    });
    req.on('end', () => {
      if (settled) return;
      settled = true;
      const body = Buffer.concat(chunks);
      let upstreamResForCleanup: IncomingMessage | null = null;
      const upstream = send(
        {
          method,
          // Composed from the configured origin plus the *request's* confined path, so the
          // worker cannot redirect the factory's key at another host or another prefix.
          host: upstreamUrl.hostname,
          port: upstreamUrl.port === '' ? undefined : Number(upstreamUrl.port),
          path: `${prefix}${relative}`,
          // The key is written here and only here. Any `authorization` the worker sent was
          // already consumed as the token and is never forwarded.
          headers: {
            authorization: `Bearer ${options.upstream.apiKey}`,
            accept: req.headers['accept'] ?? 'application/json',
            'content-type': req.headers['content-type'] ?? 'application/json',
            ...(body.length === 0 ? {} : { 'content-length': String(body.length) }),
          },
          timeout: requestTimeoutMs,
        },
        (upstreamRes) => {
          upstreamResForCleanup = upstreamRes;
          options.onEvent?.({
            kind: 'forward',
            method,
            path: req.url,
            status: upstreamRes.statusCode ?? 502,
            durationMs: Math.round(performance.now() - started),
          });
          // Streaming pass-through: a token-by-token completion must not be buffered, and the
          // headers are copied verbatim (the upstream never sets `authorization` on a
          // response, and if it did, streaming it to the worker would be a leak — so it is
          // dropped below).
          const headers = { ...upstreamRes.headers };
          delete headers['authorization'];
          res.writeHead(upstreamRes.statusCode ?? 502, headers);
          upstreamRes.pipe(res);
          upstreamRes.on('error', () => res.destroy());
        },
      );
      inFlight.add(upstream);
      const forget = (): void => {
        inFlight.delete(upstream);
      };
      upstream.on('close', forget);
      // The worker closing its side (a finished SSE stream, an aborted turn) must destroy the
      // upstream leg too: `pipe` only destroys the *destination*, so without this the gateway
      // keeps streaming into a socket nobody reads and this process never exits.
      res.on('close', () => {
        forget();
        upstream.destroy();
        upstreamResForCleanup?.destroy();
      });
      upstream.on('timeout', () => {
        upstream.destroy(new Error('upstream timed out'));
      });
      upstream.on('error', (error: Error) => {
        if (res.headersSent) {
          res.destroy();
          return;
        }
        options.onEvent?.({
          kind: 'refuse',
          reason: 'upstream-unavailable',
          method,
          path: req.url,
          status: 502,
          durationMs: Math.round(performance.now() - started),
        });
        const errorBody = JSON.stringify({
          error: {
            reason: 'upstream-unavailable',
            detail: `the upstream gateway could not be reached (${error.message})`,
          },
        });
        res.writeHead(502, {
          'content-type': 'application/json; charset=utf-8',
          'content-length': Buffer.byteLength(errorBody),
        });
        res.end(errorBody);
      });
      if (body.length > 0) upstream.write(body);
      upstream.end();
    });
  });

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    // 127.0.0.1 and an ephemeral port: the door exists for one invocation and is not routable
    // from another host. Binding to `0.0.0.0` would put the worker's key behind a LAN address.
    server.listen(0, '127.0.0.1', () => resolve());
  });
  const address = server.address();
  if (address === null || typeof address === 'string') {
    throw new Error('the credential proxy did not bind a TCP port');
  }
  const port = address.port;
  let closed = false;

  return {
    port,
    baseUrl: `http://127.0.0.1:${String(port)}${prefix}`,
    tokens,
    describe(token) {
      return { token: 'scoped', expiresAt: token.expiresAt };
    },
    async close() {
      // Every token dies with the proxy: a close that left a live token in a map would be a
      // credential leak with extra steps once the socket stopped answering.
      tokens.revokeAll();
      if (closed) return;
      closed = true;
      // Before the server teardown: an in-flight upstream response is not a *client* connection,
      // so `closeAllConnections` does not touch it and `server.close` would wait for the stream.
      for (const pending of inFlight) pending.destroy();
      inFlight.clear();
      await new Promise<void>((resolve, reject) => {
        server.close((error) => (error === undefined ? resolve() : reject(error)));
        // In-flight keep-alive sockets would otherwise hold `close` open past the attempt.
        server.closeAllConnections();
      });
    },
  };
}
