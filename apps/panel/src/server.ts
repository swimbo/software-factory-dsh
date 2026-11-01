/**
 * The panel's two routes, and the four ways a request can be refused.
 *
 * `GET /` renders the page; `GET /api/status` returns the same facts as
 * `status.v1`. Both are built from the same `buildStatus()` call in the same
 * request, so the page and the JSON can never disagree about one moment — and
 * both are validated before they leave the process: an object that fails
 * `status.v1` is answered with a 500 and a refusal page, never half-drawn
 * (ui-plan §5.3, fail closed).
 *
 * Read-only by construction, not by discipline: there is no route that accepts a
 * body, `Allow: GET` is sent with every 405, and the socket binds to loopback or
 * refuses to start.
 */
import { createServer } from 'node:http';
import type { IncomingMessage, Server, ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { timingSafeEqual } from 'node:crypto';

import { FactoryError, parseStatus } from '@factory/contracts';
import type { StatusV1 } from '@factory/contracts';
import type { Store } from '@factory/store';

import {
  renderNotFoundHtml,
  renderRefusalHtml,
  renderStatusPage,
  renderUnauthorizedHtml,
} from './render.ts';
import { buildStatus } from './status.ts';

export interface PanelServerOptions {
  readonly store: Store;
  /** The shared secret. Empty is refused: an unauthenticated panel is a data leak. */
  readonly token: string;
  /** Injected clock; the page never reads the wall clock behind the caller's back. */
  readonly now?: () => Date;
  /** Process start, for control-plane uptime. Defaults to `now()` at construction. */
  readonly startedAt?: Date;
  /**
   * The observed DSH version, read once at startup and injected. Absent is exactly
   * as honest as `null`: the page then reports `unavailable` and shows the health
   * strip. A provider that throws is treated the same way — a failed probe is a
   * fact, not a reason to answer 500.
   */
  readonly dshVersionObserved?: () => string | null;
  /** Loopback only. A non-loopback value makes `createPanelServer` throw. */
  readonly host?: string;
}

export interface PanelListener {
  readonly url: string;
  close(): Promise<void>;
}

export interface PanelServer {
  listen(port: number): Promise<PanelListener>;
}

/** The only addresses this process will listen on. */
const LOOPBACK_HOSTS: ReadonlySet<string> = new Set(['127.0.0.1', '::1', 'localhost']);

const BASE_HEADERS: Readonly<Record<string, string>> = {
  'Cache-Control': 'no-store',
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'no-referrer',
};

const HTML_HEADERS: Readonly<Record<string, string>> = {
  ...BASE_HEADERS,
  'Content-Type': 'text/html; charset=utf-8',
  // No script, no image, no font, no form: a page that cannot load anything is a
  // page that cannot be made to load anything from somewhere else.
  'Content-Security-Policy':
    "default-src 'none'; style-src 'unsafe-inline'; img-src 'none'; font-src 'none'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
};

const JSON_HEADERS: Readonly<Record<string, string>> = {
  ...BASE_HEADERS,
  'Content-Type': 'application/json; charset=utf-8',
};

/** Constant-time comparison that does not leak the token's length via early exit. */
function tokensMatch(candidate: string, expected: string): boolean {
  const left = Buffer.from(candidate, 'utf8');
  const right = Buffer.from(expected, 'utf8');
  if (left.length !== right.length) {
    // Compare against itself so the work is constant even on a length mismatch.
    timingSafeEqual(right, right);
    return false;
  }
  return timingSafeEqual(left, right);
}

interface AuthedRequest {
  readonly url: URL;
  readonly token: string;
}

/**
 * One credential, two carriers, no bypass: `Authorization: Bearer` for scripts,
 * `?token=` for the first human click. Loopback is not a credential.
 */
function authenticate(
  req: IncomingMessage,
  expectedToken: string,
  host: string,
): AuthedRequest | null {
  const url = new URL(req.url ?? '/', `http://${host}`);
  const header = req.headers['authorization'];
  if (typeof header === 'string' && /^Bearer /i.test(header)) {
    const candidate = header.slice('Bearer '.length).trim();
    if (tokensMatch(candidate, expectedToken)) return { url, token: candidate };
  }
  const query = url.searchParams.get('token');
  if (query !== null && tokensMatch(query, expectedToken)) return { url, token: query };
  return null;
}

function send(
  res: ServerResponse,
  status: number,
  headers: Readonly<Record<string, string>>,
  body: string,
): void {
  res.writeHead(status, { ...headers, 'Content-Length': Buffer.byteLength(body, 'utf8') });
  res.end(body);
}

function sendJson(
  res: ServerResponse,
  status: number,
  payload: unknown,
  extra: Readonly<Record<string, string>> = {},
): void {
  send(res, status, { ...JSON_HEADERS, ...extra }, `${JSON.stringify(payload, null, 2)}\n`);
}

/** Turn a `status.v1` validation failure into lines an operator can act on. */
function describeProblems(error: unknown): string[] {
  const issues = (error as { issues?: unknown }).issues;
  if (Array.isArray(issues)) {
    return issues.map((issue: unknown) => {
      const record = issue as { path?: unknown; message?: unknown };
      const path = Array.isArray(record.path) ? record.path.join('.') : 'status';
      const message = typeof record.message === 'string' ? record.message : 'invalid';
      return `${path === '' ? 'status' : path}: ${message}`;
    });
  }
  return [error instanceof Error ? error.message : String(error)];
}

/**
 * Build the status object for this request, or the list of reasons it cannot be
 * sent. The store read and the validation happen together so nothing can observe
 * a status object that was valid under a different contract.
 */
function statusOrProblems(
  store: Store,
  now: () => Date,
  startedAt: Date,
  dshVersionObserved: () => string | null,
): { status: StatusV1 } | { problems: string[] } {
  let observed: string | null;
  try {
    observed = dshVersionObserved();
  } catch {
    // A probe that throws is indistinguishable from a probe that failed: `null`.
    observed = null;
  }
  try {
    const status = parseStatus(
      buildStatus(store, { now, startedAt, dshVersionObserved: observed }),
    );
    return { status };
  } catch (error) {
    return { problems: describeProblems(error) };
  }
}

export function createPanelServer(options: PanelServerOptions): PanelServer {
  const token = options.token;
  if (typeof token !== 'string' || token.trim().length === 0) {
    throw new FactoryError(
      'INTERNAL',
      'the panel refuses to start without a token: an unauthenticated status page leaks the factory',
    );
  }
  const host = options.host ?? '127.0.0.1';
  if (!LOOPBACK_HOSTS.has(host)) {
    throw new FactoryError(
      'INTERNAL',
      `refusing to bind the panel to '${host}': it listens on loopback only (127.0.0.1)`,
    );
  }
  const now = options.now ?? ((): Date => new Date());
  const startedAt = options.startedAt ?? now();
  const dshVersionObserved = options.dshVersionObserved ?? ((): string | null => null);
  const { store } = options;

  const handle = (req: IncomingMessage, res: ServerResponse): void => {
    const authed = authenticate(req, token, host);
    if (authed === null) {
      // The refusal names the two accepted carriers. It does not say whether the
      // token was wrong, missing or empty — that distinction is a guessing oracle.
      const message = missingCredentialMessage(req);
      sendJson(
        res,
        401,
        { ok: false, code: 'UNAUTHORIZED', message },
        { 'WWW-Authenticate': 'Bearer realm="factory-panel"' },
      );
      return;
    }

    if (req.method !== 'GET') {
      // No route accepts a body, and no method but GET is answerable: `Allow: GET`
      // is the whole read-only guarantee, stated on every refusal.
      sendJson(
        res,
        405,
        {
          ok: false,
          code: 'METHOD_NOT_ALLOWED',
          message: 'this surface is read-only: the only method is GET',
        },
        { Allow: 'GET' },
      );
      return;
    }

    const path = authed.url.pathname;
    if (path !== '/' && path !== '/api/status') {
      if (path.startsWith('/api/')) {
        sendJson(res, 404, {
          ok: false,
          code: 'NOT_FOUND',
          message: 'no such route; this surface serves / and /api/status',
        });
      } else {
        send(res, 404, HTML_HEADERS, renderNotFoundHtml(path));
      }
      return;
    }

    const result = statusOrProblems(store, now, startedAt, dshVersionObserved);
    if ('problems' in result) {
      if (path === '/api/status') {
        sendJson(res, 500, {
          ok: false,
          code: 'INTERNAL',
          message: 'refusing to serve a status object that does not satisfy status.v1',
          problems: result.problems,
        });
      } else {
        send(res, 500, HTML_HEADERS, renderRefusalHtml(result.problems));
      }
      return;
    }

    if (path === '/api/status') sendJson(res, 200, result.status);
    else send(res, 200, HTML_HEADERS, renderStatusPage(result.status));
  };

  return {
    listen(port: number): Promise<PanelListener> {
      return new Promise<PanelListener>((resolve, reject) => {
        const server: Server = createServer((req, res) => {
          try {
            handle(req, res);
          } catch (error) {
            // A throw in a render path must not take the process down, and must not
            // leave a half-written response looking like an answer.
            if (!res.headersSent) {
              sendJson(res, 500, {
                ok: false,
                code: 'INTERNAL',
                message: error instanceof Error ? error.message : String(error),
              });
            } else {
              res.end();
            }
          }
        });
        server.once('error', reject);
        server.listen(port, host, () => {
          server.removeListener('error', reject);
          const address = server.address();
          const boundPort =
            typeof address === 'object' && address !== null ? (address as AddressInfo).port : port;
          resolve({
            url: `http://${host}:${boundPort}`,
            close: (): Promise<void> =>
              new Promise<void>((done, fail) => {
                server.close((error) =>
                  error === undefined || error === null ? done() : fail(error),
                );
              }),
          });
        });
      });
    },
  };
}

function missingCredentialMessage(req: IncomingMessage): string {
  const header = req.headers['authorization'];
  if (typeof header === 'string' && header.trim().length > 0) {
    return 'the token in `Authorization: Bearer <token>` did not match the panel token';
  }
  return 'a token is required: send `Authorization: Bearer <token>` or open the page with `?token=<token>`';
}
