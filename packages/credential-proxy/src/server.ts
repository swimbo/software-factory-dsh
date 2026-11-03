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
 * `127.0.0.1:<ephemeral>` by default, `http://`, one upstream base URL, one path prefix. The
 * bind address is configurable (`bindAddress`), because a worker in a container that has no
 * loopback to this host needs the proxy to sit on an address the container's network can route
 * to; the loopback default is preserved exactly, so nothing changes when the container lever is
 * off. Every request is checked in this order — token, method, path, body size — and each
 * refusal has its own reason so an operator reading a log can tell a wrong path from a dead
 * token. Only then is the request forwarded, with `Authorization: Bearer <gateway key>` written
 * by *this* file.
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
import {
  foldUsage,
  MAX_PARSE_BYTES,
  observeUsage,
  type PriceTable,
  type UsageObservation,
  type UsageTotals,
} from './usage.ts';

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
  /**
   * The interface address the proxy listens on. Default `127.0.0.1` — the loopback door, which
   * is what every caller got before this option existed and what a host-side worker needs.
   *
   * It exists for one caller shape: a worker inside a container whose network namespace cannot
   * reach this host's loopback. That caller must pass an address the container can route to
   * (a docker bridge gateway on a native-Linux daemon, for instance), and it must be a *concrete*
   * address — binding a wildcard (`0.0.0.0`, `::`) opens the token door on every interface the
   * host has, and the base URL this proxy reports then names an address no client can dial.
   * The token is still the wall, but a narrower door costs nothing.
   *
   * An address this host does not own is refused at start (`EADDRNOTAVAIL`), which is a fact
   * worth surfacing rather than binding loopback "instead": see
   * `e2e/cli/docker/10-internal-bridge.test.ts`, which pins exactly that difference between a
   * docker-in-a-VM host and a native-Linux one.
   */
  readonly bindAddress?: string;
  /** HTTP methods the proxy forwards. Default `['GET', 'POST']` — a model call is both. */
  readonly allowedMethods?: readonly string[];
  /** Body cap, in bytes. Default 1 MiB; a chat request with a large prompt is far under it. */
  readonly maxBodyBytes?: number;
  /** Upstream timeout. Default 10 minutes, matching a long streaming completion. */
  readonly requestTimeoutMs?: number;
  /**
   * The operator's price table, for a gateway that reports tokens without a price.
   *
   * Optional on purpose: without it, an unpriced response is recorded as *unknown* cost rather
   * than guessed, and a ceiling over unknown costs cannot fire — which is the honest outcome,
   * not a silent one (the observation says `costSource: 'unknown'`).
   */
  readonly priceTable?: PriceTable | undefined;
  /**
   * The spend ceiling for this attempt, in USD. When the **observed** cost crosses it, the
   * attempt's token is revoked: the request that crossed is served (the money is spent), and
   * the *next* one is answered `token-revoked`. This is ND3's "enforce, do not negotiate": a
   * ceiling that only refuses the next attempt is a suggestion, because the attempt already
   * running never asks again.
   *
   * Revocation is not a retry: the attempt that owned the token fails, and the launcher records
   * the failure. Nothing redispatches it — a ceiling that redispached would spend past itself.
   */
  readonly spendCeilingUsd?: number | undefined;
  /** Called once per attempt when the ceiling is crossed, after the token is revoked. */
  readonly onCeilingReached?: (input: {
    readonly attemptId: string;
    readonly spendUsd: number;
    readonly ceilingUsd: number;
  }) => void;
  /** Structured refusal/forward/usage/ceiling events. Never contains the key or a full token. */
  readonly onEvent?: (event: ProxyEvent) => void;
}

export interface ProxyEvent {
  /**
   * `usage` is the observation, `ceiling` the enforcement: both on the same channel as
   * forward/refuse, because a second channel would be a second thing to keep in sync.
   */
  readonly kind: 'forward' | 'refuse' | 'usage' | 'ceiling';
  /** The metered fact, present on `usage` and on the `ceiling` that followed it. */
  readonly usage?: UsageObservation | undefined;
  readonly reason?: ProxyRefusal | undefined;
  readonly method?: string | undefined;
  readonly path?: string | undefined;
  readonly status?: number | undefined;
  readonly durationMs?: number | undefined;
  /** One line of English for the log: what happened, in the operator's terms. */
  readonly detail?: string | undefined;
}

export interface CredentialProxy {
  /** `http://<bound address>:<port><upstream path>` — the value the overlay's `baseURL` gets. */
  readonly baseUrl: string;
  /**
   * The address the listener actually bound, as reported by the kernel (`server.address()`), not
   * as requested — so "where the door was" is evidence rather than a copy of the configuration.
   * `'127.0.0.1'` is the default and means the loopback door. The CLI does not write this into
   * `launch.json` yet (it still passes the default), so today it is a seam and a spec fact, not
   * a recorded field.
   */
  readonly boundAddress: string;
  readonly port: number;
  readonly tokens: TokenRegistry;
  /**
   * What the gateway reported for this token so far, or `undefined` before the first response.
   * The launcher reads this after the attempt to write the usage record; it is *observed* data,
   * not an estimate, and `costUsd: null` means "no priced call yet".
   */
  usageFor(token: string): UsageTotals | undefined;
  /**
   * What `launch.json` records about the credential: that it is scoped and when it dies.
   * Never the token itself — a launch record is evidence and gets copied around.
   */
  describe(token: ScopedToken): { readonly token: 'scoped'; readonly expiresAt: string };
  close(): Promise<void>;
}

const DEFAULT_MAX_BODY_BYTES = 1024 * 1024;
const DEFAULT_TIMEOUT_MS = 10 * 60 * 1000;
/**
 * The loopback door, and the default: an address no other machine can route to. Kept a named
 * constant so the spec that pins "the default did not move" and the code that applies it cannot
 * drift apart.
 */
export const DEFAULT_BIND_ADDRESS = '127.0.0.1';

/** `host:port` needs brackets around an IPv6 literal; an IPv4 address and a hostname do not. */
function urlHostOf(address: string): string {
  return address.includes(':') ? `[${address}]` : address;
}

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
  const requestedBind = (options.bindAddress ?? '').trim();
  const bindAddress = requestedBind === '' ? DEFAULT_BIND_ADDRESS : requestedBind;
  const allowedMethods = options.allowedMethods ?? ['GET', 'POST'];
  const maxBodyBytes = options.maxBodyBytes ?? DEFAULT_MAX_BODY_BYTES;
  const requestTimeoutMs = options.requestTimeoutMs ?? DEFAULT_TIMEOUT_MS;
  const tokens = createTokenRegistry({ now: options.now });
  const usageByToken = new Map<string, UsageTotals>();
  const ceilingCrossed = new Set<string>();

  /** Fold an observation into the token's totals and enforce the ceiling when it is crossed. */
  const meter = (token: string, attemptId: string, observation: UsageObservation): void => {
    const totals = foldUsage(usageByToken.get(token), observation);
    usageByToken.set(token, totals);
    options.onEvent?.({ kind: 'usage', usage: observation });
    const ceiling = options.spendCeilingUsd;
    if (ceiling === undefined || ceiling <= 0) return;
    if (totals.costUsd === null || totals.costUsd < ceiling) return;
    if (ceilingCrossed.has(token)) return;
    ceilingCrossed.add(token);
    // The crossing request has already been served; from here the token is dead. This is the
    // enforcement ND3 asked for: the next request is refused, so the attempt stops instead of
    // spending the rest of its budget politely.
    tokens.revoke(token);
    usageByToken.set(token, { ...totals, ceilingCrossed: true });
    options.onEvent?.({
      kind: 'ceiling',
      usage: observation,
      status: 401,
      detail: `observed spend $${totals.costUsd.toFixed(4)} crossed the $${ceiling.toFixed(2)} ceiling; the token is revoked`,
    });
    options.onCeilingReached?.({ attemptId, spendUsd: totals.costUsd, ceilingUsd: ceiling });
  };
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
          // A tee, not a buffer: the same bytes go to the worker immediately and to the
          // meter, which keeps at most MAX_PARSE_BYTES for parsing. A stream larger than that
          // is metered as `truncated` (unknown), never as a confident zero.
          const tapped: Buffer[] = [];
          let tappedBytes = 0;
          upstreamRes.on('data', (chunk: Buffer) => {
            if (tappedBytes >= MAX_PARSE_BYTES) return;
            tapped.push(chunk);
            tappedBytes += chunk.length;
          });
          upstreamRes.on('end', () => {
            const truncated = tappedBytes > MAX_PARSE_BYTES;
            const bodyText = Buffer.concat(tapped).subarray(0, MAX_PARSE_BYTES).toString('utf8');
            const requestId = upstreamRes.headers['x-request-id'];
            const observation = observeUsage({
              body: bodyText,
              headers: upstreamRes.headers,
              requestIdHeader: typeof requestId === 'string' ? requestId : null,
              priceTable: options.priceTable,
              truncated,
            });
            meter(verdict.token.token, verdict.token.attemptId, observation);
          });
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
    const onError = (error: Error): void => {
      // Name the address and keep the kernel's reason: `EADDRNOTAVAIL` is the measured difference
      // between "this host owns the bridge" and "docker is a VM and the bridge is inside it".
      reject(new Error(`the credential proxy cannot listen on ${bindAddress}: ${error.message}`));
    };
    server.once('error', onError);
    server.listen(0, bindAddress, () => {
      server.removeListener('error', onError);
      resolve();
    });
  });
  const address = server.address();
  if (address === null || typeof address === 'string') {
    throw new Error('the credential proxy did not bind a TCP port');
  }
  const boundAddress = address.address;
  const port = address.port;
  let closed = false;

  return {
    port,
    boundAddress,
    baseUrl: `http://${urlHostOf(boundAddress)}:${String(port)}${prefix}`,
    tokens,
    usageFor(token) {
      return usageByToken.get(token);
    },
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
