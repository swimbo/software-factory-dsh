/**
 * The Discord half of `factory alerts --notify`.
 *
 * The operator's channel (`#dsh`) is a Discord webhook, and Discord does not accept the `alerts.v1`
 * document the raw transport posts: it wants `content`/`embeds`, answers **204 No Content** on
 * success, and rate-limits with **429 + `retry_after`**. The specs here pin four properties, in the
 * order a reader would doubt them:
 *
 * 1. **The body.** A summary line, one card per integrity alert, red for expired evidence and amber
 *    for an unreachable anchor — and `allowed_mentions: { parse: [] }` on *every* body, including the
 *    truncated one. That last field is the difference between a notification channel and a way for a
 *    message to ping `@here` at 04:00; the alert text is data from a spec, a store or an anchor, so
 *    the guarantee cannot be "no message will ever contain an @".
 * 2. **The limits.** Discord rejects over-long bodies, so ten embeds and 6000 characters are enforced
 *    here, and a dropped alert is counted in the content ("…and N more, see `~/.factory/alerts.log`")
 *    rather than silently lost.
 * 3. **The responses.** 204/200 delivered, 400 quoted back with Discord's own `message`, 429 retried
 *    exactly once after `retry_after` (capped at 5 s), 5xx retried once, redirects refused. The 429
 *    wait is injected so the retry is a spec, not a pause in the suite.
 * 4. **The credential.** The URL comes from `FACTORY_ALERTS_WEBHOOK_URL`, from a file it names, or
 *    from `$FACTORY_HOME/secrets/alerts-webhook`; a 0644 file is refused with `chmod 600` and never
 *    POSTed. The URL never reaches a log line beyond scheme + host.
 *
 * Every request in this file goes to a loopback listener this file starts. No spec resolves
 * `discord.com`, and no spec reads the operator's real secret: the specs that read a secret file write
 * their own into a fresh `FACTORY_HOME`, and the ones that do not pass that home explicitly.
 */
import { chmodSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import type { Server, ServerResponse } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { AlertsV1, type Alert } from '@factory/contracts';

import { EXIT } from './exit.ts';
import {
  deliverNotification,
  DISCORD_EMBED_LIMIT,
  DISCORD_PAYLOAD_LIMIT,
  discordPayload,
  isDiscordWebhook,
  postAlerts,
  postDiscord,
  resolveWebhookConfig,
  WEBHOOK_ENV,
  WEBHOOK_FILE_ENV,
  WEBHOOK_RESPONSE_LIMIT,
  type DiscordPayload,
  type WebhookTarget,
} from './notify.ts';
import { tempHome } from './testing.ts';

// ---------------------------------------------------------------------------
// Fixtures: documents that pass `alerts.v1`'s own refinement, so each spec starts from a real answer
// ---------------------------------------------------------------------------

const FRESH_ANCHOR = {
  state: 'fresh',
  scope: 'off-host',
  ageHours: 1.5,
  transport: 'ssh hermes-control:/var/lib/factory/ledger-anchors.jsonl',
  reason: 'anchored 1.5 h ago, off-host',
} as const;

const UNREACHABLE_ANCHOR = {
  state: 'unreachable',
  scope: 'unknown',
  ageHours: null,
  transport: 'ssh hermes-control:/var/lib/factory/ledger-anchors.jsonl',
  reason: 'the anchor host could not be reached (connection refused)',
} as const;

const BUDGET_WARNING: Alert = {
  code: 'BUDGET_CEILING_REACHED',
  severity: 'warning',
  subject: 'spend',
  at: '2026-11-01T03:00:00.000Z',
  reason: 'the gateway reported a spend ceiling crossing',
  investigation: 'factory budget show',
};

function certNever(subject = 'all task classes'): Alert {
  return {
    code: 'CERT_NEVER',
    severity: 'integrity',
    subject,
    at: null,
    reason: 'no class has ever been certified in this store; nothing to audit is not a licence',
    investigation: 'factory audit --certifications; docs/runbooks/certificate-expired.md',
  };
}

function certStale(subject: string): Alert {
  return {
    code: 'CERT_STALE',
    severity: 'integrity',
    subject,
    at: '2026-10-01T00:00:00.000Z',
    reason: 're-certify: policy changed (certified under policy/old, running policy/new)',
    investigation: 'factory audit --certifications; docs/runbooks/certificate-expired.md',
  };
}

function alertDocument(
  alerts: readonly Alert[],
  anchor: Partial<AlertsV1['anchor']> = {},
): AlertsV1 {
  const merged = { ...FRESH_ANCHOR, ...anchor };
  const integrity = alerts.filter((alert) => alert.severity === 'integrity').length;
  const reached = merged.state !== 'unreachable' && merged.state !== 'unconfigured';
  return AlertsV1.parse({
    schema: 'alerts.v1',
    ok: integrity === 0 && reached,
    generatedAt: '2026-11-01T12:00:00.000Z',
    anchor: merged,
    alerts,
    counts: { total: alerts.length, bySeverity: { integrity, warning: alerts.length - integrity } },
  });
}

/** The payload for a fixture, with the null case turned into a fixture bug rather than an `undefined`. */
function payloadFor(document: AlertsV1, exitCode: number): DiscordPayload {
  const payload = discordPayload(document, exitCode);
  if (payload === null) throw new Error('the fixture must produce a Discord payload');
  return payload;
}

function target(url: string): WebhookTarget {
  return { url, origin: new URL(url).origin };
}

// ---------------------------------------------------------------------------
// The payload: what is said, how it is coloured, and what is never allowed to ping
// ---------------------------------------------------------------------------

describe('the Discord payload (pure)', () => {
  it('[exit 9: one summary line, one red card per integrity alert, and an empty mention allow-list]', () => {
    const document = alertDocument([certNever()]);
    const payload = discordPayload(document, EXIT.integrity);
    // The whole body is pinned: a channel whose wording drifts is a channel nobody can grep, and this
    // object is exactly what Discord receives.
    expect(payload).toEqual({
      content: 'factory alerts — 1 integrity, anchor fresh',
      embeds: [
        {
          title: 'CERT_NEVER',
          description:
            'all task classes — no class has ever been certified in this store; nothing to audit is not a licence\n' +
            'next: factory audit --certifications; docs/runbooks/certificate-expired.md',
          color: 0xed4245,
        },
      ],
      allowed_mentions: { parse: [] },
    });
    // And the serialized body is the same object: asserting the in-memory value is not enough if the
    // POST path stringifies something else.
    expect(JSON.parse(JSON.stringify(payload))).toEqual(payload);
  });

  it('[exit 8 with an unreachable anchor: one amber card that says nothing is known, never a missing anchor]', () => {
    const payload = discordPayload(alertDocument([], UNREACHABLE_ANCHOR), EXIT.environment);
    expect(payload).toEqual({
      content: 'factory alerts — anchor unreachable (exit 8)',
      embeds: [
        {
          title: 'ANCHOR_UNREACHABLE',
          description:
            'evidence: UNKNOWN — the anchor host did not answer (exit 8)\n' +
            'next: factory ledger verify; docs/runbooks/ledger-anchor.md',
          color: 0xf0b232,
        },
      ],
      allowed_mentions: { parse: [] },
    });
    // Unreachable is not missing (`alerts.v1` is explicit about it); an amber card must not claim a
    // ledger fact that nobody observed.
    expect(payload?.embeds.map((embed) => embed.title)).not.toContain('ANCHOR_MISSING');
  });

  it('[exit 0 is no payload at all: a clean run cannot deliver a message]', () => {
    expect(discordPayload(alertDocument([]), EXIT.ok)).toBeNull();
    // A warning is printed and logged and does not page; an exit-0 run with one is still silence.
    expect(discordPayload(alertDocument([BUDGET_WARNING]), EXIT.ok)).toBeNull();
  });

  it('[a warning never becomes a card, and never inflates the summary count]', () => {
    const payload = payloadFor(alertDocument([certNever(), BUDGET_WARNING]), EXIT.integrity);
    expect(payload.embeds.map((embed) => embed.title)).toEqual(['CERT_NEVER']);
    expect(payload.content).toBe('factory alerts — 1 integrity, anchor fresh');
  });

  it('[12 alerts: ten cards at most, and the content counts the rest into the log instead]', () => {
    const alerts = Array.from({ length: 12 }, (_, index) => certStale(`class-${String(index)}`));
    const payload = payloadFor(alertDocument(alerts), EXIT.integrity);
    expect(payload.embeds).toHaveLength(DISCORD_EMBED_LIMIT);
    expect(payload.embeds.map((embed) => embed.title)).toEqual(
      Array.from({ length: DISCORD_EMBED_LIMIT }, () => 'CERT_STALE'),
    );
    // The tail is the honest part: the two cards that did not fit are named as existing somewhere the
    // reader can still find them, rather than dropped in silence.
    expect(payload.content).toBe(
      'factory alerts — 12 integrity, anchor fresh …and 2 more, see `~/.factory/alerts.log`',
    );
    expect(payload.embeds[9]?.description).toContain('class-9');
    expect(JSON.stringify(payload)).not.toContain('class-10');
    expect(JSON.stringify(payload)).not.toContain('class-11');
    expect(JSON.stringify(payload).length).toBeLessThanOrEqual(DISCORD_PAYLOAD_LIMIT);
    expect(payload.allowed_mentions).toEqual({ parse: [] });
  });

  it('[the 6000-character budget drops cards too, and says how many]', () => {
    const reason = 'r'.repeat(3_000);
    const alerts = ['a', 'b', 'c'].map((subject) => ({ ...certStale(subject), reason }));
    const payload = payloadFor(alertDocument(alerts), EXIT.integrity);
    // One 3000-character reason is a legal card; three of them are over the whole-message budget, so
    // the payload has to shrink by dropping cards, not by silently truncating their meaning.
    expect(payload.embeds.length).toBeLessThan(alerts.length);
    expect(payload.embeds.length).toBeGreaterThan(0);
    expect(JSON.stringify(payload).length).toBeLessThanOrEqual(DISCORD_PAYLOAD_LIMIT);
    expect(payload.content).toContain(
      `…and ${String(alerts.length - payload.embeds.length)} more, see \`~/.factory/alerts.log\``,
    );
    expect(payload.allowed_mentions).toEqual({ parse: [] });
  });

  it('[a message containing @here still carries allowed_mentions: { parse: [] }]', () => {
    const noisy: Alert = {
      ...certStale('class-1'),
      reason: '@here and <@&123456789> — a reason is data, not a command to ping',
    };
    const payload = payloadFor(alertDocument([noisy]), EXIT.integrity);
    // The literal text is allowed to exist; what must never exist is permission to act on it.
    expect(payload.embeds[0]?.description).toContain('@here');
    expect(payload.allowed_mentions).toEqual({ parse: [] });
    expect(JSON.stringify(payload)).toContain('"allowed_mentions":{"parse":[]}');
  });
});

describe('Discord detection', () => {
  it('[discord.com and discordapp.com under /api/webhooks/ are Discord; every other URL is not]', () => {
    expect(isDiscordWebhook(target('https://discord.com/api/webhooks/1234/fake-token'))).toBe(true);
    expect(isDiscordWebhook(target('https://discordapp.com/api/webhooks/1234/fake-token'))).toBe(
      true,
    );
    // Host and path both matter: a raw `alerts.v1` consumer on another host keeps its POST, and the
    // bare host is not a webhook endpoint.
    expect(isDiscordWebhook(target('https://discord.com/hooks/1234/fake-token'))).toBe(false);
    expect(isDiscordWebhook(target('https://discord.com/api/webhooks'))).toBe(false);
    expect(isDiscordWebhook(target('https://example.com/api/webhooks/1234/fake-token'))).toBe(
      false,
    );
    expect(isDiscordWebhook(target('https://discord.com.evil.test/api/webhooks/1/t'))).toBe(false);
    // The loopback listener a spec uses is *not* Discord: the adapter is reached through the injected
    // detector, never by disguising a test server as discord.com.
    expect(isDiscordWebhook(target('http://127.0.0.1:1/api/webhooks/1/t'))).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// The POST, against a loopback listener — never a real Discord URL
// ---------------------------------------------------------------------------

interface RecordedRequest {
  readonly method: string;
  readonly path: string;
  readonly body: string;
  readonly contentType: string;
}

interface LoopbackRecorder {
  readonly origin: string;
  readonly url: string;
  readonly requests: RecordedRequest[];
  close(): Promise<void>;
}

/**
 * A listener on 127.0.0.1 only, defaulting to Discord's success answer (204, no body). This is the same
 * pattern `alerts.test.ts` uses; it is repeated rather than imported because importing that file would
 * register its specs a second time.
 */
async function loopback(
  respond: (index: number, response: ServerResponse) => void = (_index, response) => {
    response.writeHead(204);
    response.end();
  },
): Promise<LoopbackRecorder> {
  const requests: RecordedRequest[] = [];
  const server: Server = createServer((request, response) => {
    const chunks: Buffer[] = [];
    request.on('data', (chunk: Buffer) => chunks.push(chunk));
    request.on('end', () => {
      requests.push({
        method: request.method ?? '',
        path: request.url ?? '',
        body: Buffer.concat(chunks).toString('utf8'),
        contentType:
          typeof request.headers['content-type'] === 'string'
            ? request.headers['content-type']
            : '',
      });
      respond(requests.length - 1, response);
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
  const address = server.address();
  if (address === null || typeof address === 'string') throw new Error('no loopback port');
  const origin = `http://127.0.0.1:${String(address.port)}`;
  return {
    origin,
    url: `${origin}/hook`,
    requests,
    async close() {
      server.closeAllConnections();
      await new Promise<void>((resolve, reject) => {
        server.close((error) => (error === undefined ? resolve() : reject(error)));
      });
    },
  };
}

describe('postDiscord (loopback only)', () => {
  it('[a 204 No Content is a delivery, with exactly one POST of the exact body]', async () => {
    const recorder = await loopback();
    try {
      const payload = payloadFor(alertDocument([certNever()]), EXIT.integrity);
      const result = await postDiscord(recorder.url, payload, { timeoutMs: 2_000 });
      expect(result).toEqual({ ok: true, attempts: 1, status: 204, detail: 'HTTP 204' });
      expect(recorder.requests).toHaveLength(1);
      const request = recorder.requests[0];
      expect(request?.method).toBe('POST');
      expect(request?.contentType).toContain('application/json');
      expect(JSON.parse(request?.body ?? '{}')).toEqual(payload);
      expect(JSON.parse(request?.body ?? '{}').allowed_mentions).toEqual({ parse: [] });
    } finally {
      await recorder.close();
    }
  });

  it('[a 200 is also a delivery: Discord answers both, and neither has a document to parse]', async () => {
    const recorder = await loopback((_index, response) => {
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end('{"ok":true}');
    });
    try {
      const payload = payloadFor(alertDocument([certNever()]), EXIT.integrity);
      const result = await postDiscord(recorder.url, payload, { timeoutMs: 2_000 });
      expect(result.ok).toBe(true);
      expect(result.status).toBe(200);
      expect(result.attempts).toBe(1);
      expect(recorder.requests).toHaveLength(1);
    } finally {
      await recorder.close();
    }
  });

  it('[429 then success: one retry, and the wait is retry_after rather than a fixed pause]', async () => {
    const recorder = await loopback((index, response) => {
      if (index === 0) {
        response.writeHead(429, { 'content-type': 'application/json' });
        response.end(
          JSON.stringify({
            message: 'You are being rate limited.',
            retry_after: 0.25,
            global: false,
          }),
        );
        return;
      }
      response.writeHead(204);
      response.end();
    });
    const slept: number[] = [];
    try {
      const payload = payloadFor(alertDocument([certNever()]), EXIT.integrity);
      const result = await postDiscord(recorder.url, payload, {
        timeoutMs: 2_000,
        sleep: async (ms) => {
          slept.push(ms);
        },
      });
      expect(result.ok).toBe(true);
      expect(result.attempts).toBe(2);
      expect(result.status).toBe(204);
      // `retry_after` is in seconds and may be fractional: 0.25 becomes 250 ms, not 0.25 ms or 25 s.
      expect(slept).toEqual([250]);
      expect(recorder.requests).toHaveLength(2);
      expect(JSON.parse(recorder.requests[1]?.body ?? '{}')).toEqual(payload);
      expect(result.detail).toContain('retry_after 0.25 s');
    } finally {
      await recorder.close();
    }
  });

  it('[still 429 after the one retry: reported failure, and no third attempt]', async () => {
    const recorder = await loopback((_index, response) => {
      response.writeHead(429, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ message: 'You are being rate limited.', retry_after: 0.1 }));
    });
    const slept: number[] = [];
    try {
      const payload = payloadFor(alertDocument([certNever()]), EXIT.integrity);
      const result = await postDiscord(recorder.url, payload, {
        timeoutMs: 2_000,
        sleep: async (ms) => {
          slept.push(ms);
        },
      });
      expect(result.ok).toBe(false);
      expect(result.status).toBe(429);
      expect(result.attempts).toBe(2);
      expect(slept).toEqual([100]);
      expect(recorder.requests).toHaveLength(2);
      expect(result.detail).toContain('still rate-limited after one retry');
    } finally {
      await recorder.close();
    }
  });

  it('[a 429 that asks for a minute is capped at five seconds and says so]', async () => {
    const recorder = await loopback((index, response) => {
      if (index === 0) {
        response.writeHead(429, { 'content-type': 'application/json' });
        response.end(JSON.stringify({ message: 'You are being rate limited.', retry_after: 60 }));
        return;
      }
      response.writeHead(204);
      response.end();
    });
    const slept: number[] = [];
    try {
      const payload = payloadFor(alertDocument([certNever()]), EXIT.integrity);
      const result = await postDiscord(recorder.url, payload, {
        timeoutMs: 2_000,
        sleep: async (ms) => {
          slept.push(ms);
        },
      });
      // A timer job must not sleep for a minute: it waits the cap and reports the difference.
      expect(slept).toEqual([5_000]);
      expect(result.ok).toBe(true);
      expect(result.detail).toContain('capped at 5 s');
    } finally {
      await recorder.close();
    }
  });

  it("[a 400 is not retried, and quotes Discord's own message rather than the token]", async () => {
    const token = 'token-that-must-not-leak';
    const recorder = await loopback((_index, response) => {
      response.writeHead(400, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ message: 'Invalid Webhook Token', code: 50035 }));
    });
    try {
      const payload = payloadFor(alertDocument([certNever()]), EXIT.integrity);
      const result = await postDiscord(`${recorder.url}/api/webhooks/42/${token}`, payload, {
        timeoutMs: 2_000,
      });
      expect(result.ok).toBe(false);
      expect(result.status).toBe(400);
      expect(result.attempts).toBe(1);
      expect(recorder.requests).toHaveLength(1);
      // Discord's own sentence is the actionable part; the URL (which carries the token) is not.
      expect(result.detail).toBe('HTTP 400: Invalid Webhook Token');
      expect(result.detail).not.toContain(token);
    } finally {
      await recorder.close();
    }
  });

  it('[a 5xx is retried exactly once, like the raw transport]', async () => {
    const recorder = await loopback((_index, response) => {
      response.writeHead(503, { 'content-type': 'text/plain' });
      response.end('not now');
    });
    try {
      const payload = payloadFor(alertDocument([certNever()]), EXIT.integrity);
      const result = await postDiscord(recorder.url, payload, { timeoutMs: 2_000 });
      expect(result.ok).toBe(false);
      expect(result.status).toBe(503);
      expect(result.attempts).toBe(2);
      expect(recorder.requests).toHaveLength(2);
    } finally {
      await recorder.close();
    }
  });

  it('[a redirect is refused, not followed: nothing is re-POSTed to the location]', async () => {
    const recorder = await loopback((_index, response) => {
      response.writeHead(307, { location: '/elsewhere' });
      response.end();
    });
    try {
      const payload = payloadFor(alertDocument([certNever()]), EXIT.integrity);
      const result = await postDiscord(recorder.url, payload, { timeoutMs: 2_000 });
      expect(result.ok).toBe(false);
      expect(result.status).toBeNull();
      // Both attempts went to the configured path as POSTs; the Location was never dialled.
      expect(recorder.requests.map((request) => request.path)).toEqual(['/hook', '/hook']);
      expect(recorder.requests.every((request) => request.method === 'POST')).toBe(true);
    } finally {
      await recorder.close();
    }
  });

  it('[an endpoint that never answers is bounded by the timeout, twice and no more]', async () => {
    const recorder = await loopback(() => {
      // Deliberately never responds: the client's own budget has to end the attempt.
    });
    try {
      const payload = payloadFor(alertDocument([certNever()]), EXIT.integrity);
      const started = performance.now();
      const result = await postDiscord(recorder.url, payload, { timeoutMs: 60 });
      const elapsed = performance.now() - started;
      expect(result.ok).toBe(false);
      expect(result.attempts).toBe(2);
      expect(elapsed).toBeLessThan(5_000);
    } finally {
      await recorder.close();
    }
  });

  it('[a refused connection is a failure value, not a throw]', async () => {
    const recorder = await loopback();
    const url = recorder.url;
    await recorder.close();
    const payload = payloadFor(alertDocument([certNever()]), EXIT.integrity);
    const result = await postDiscord(url, payload, { timeoutMs: 2_000 });
    expect(result.ok).toBe(false);
    expect(result.status).toBeNull();
    expect(result.attempts).toBe(2);
    expect(result.detail).toMatch(/fetch failed|ECONNREFUSED/u);
  });
});

// ---------------------------------------------------------------------------
// Delivery: the adapter is selected on the URL, and the log line still carries only scheme + host
// ---------------------------------------------------------------------------

describe('deliverNotification over the Discord adapter', () => {
  it('[a Discord target gets the Discord body, and the NOTIFY line carries only the origin]', async () => {
    const recorder = await loopback();
    try {
      const document = alertDocument([certNever()]);
      const lines: string[] = [];
      const outcome = await deliverNotification(document, EXIT.integrity, {
        home: tempHome('factory-discord-home-'),
        env: { [WEBHOOK_ENV]: `${recorder.url}?token=super-secret` },
        platform: 'darwin',
        warn: (line) => lines.push(line),
        // The URL is loopback, so detection is pointed at it explicitly: a spec must never resolve a
        // discord.com URL it would then POST to.
        detectsDiscord: () => true,
      });
      expect(outcome.status).toBe('delivered');
      expect(outcome.delivered).toBe(true);
      expect(recorder.requests).toHaveLength(1);
      expect(JSON.parse(recorder.requests[0]?.body ?? '{}')).toEqual(
        payloadFor(document, EXIT.integrity),
      );
      expect(lines).toHaveLength(1);
      expect(lines[0]).toContain('NOTIFY  DELIVERED');
      expect(lines[0]).toContain('accepted the Discord message');
      expect(lines[0]).toContain(recorder.origin);
      expect(lines[0]).not.toContain('super-secret');
      expect(lines[0]).not.toContain('/hook');
    } finally {
      await recorder.close();
    }
  });

  it('[the raw alerts.v1 POST is unchanged for a non-Discord URL]', async () => {
    const recorder = await loopback();
    try {
      const document = alertDocument([certNever()]);
      const lines: string[] = [];
      const outcome = await deliverNotification(document, EXIT.integrity, {
        home: tempHome('factory-discord-home-'),
        env: { [WEBHOOK_ENV]: recorder.url },
        platform: 'darwin',
        warn: (line) => lines.push(line),
      });
      expect(outcome.status).toBe('delivered');
      expect(recorder.requests).toHaveLength(1);
      const received = JSON.parse(recorder.requests[0]?.body ?? '{}') as Record<string, unknown>;
      // Byte-for-byte the document `--json` prints: no content/embeds, no allowed_mentions — the
      // pre-existing integration is not migrated behind the operator's back.
      expect(received).toEqual(document);
      expect(received).not.toHaveProperty('allowed_mentions');
      expect(lines[0]).toContain('answered HTTP 204');
    } finally {
      await recorder.close();
    }
  });

  it('[a Discord 400 is a reported failure value, never a throw: the code stays the evidence]', async () => {
    const recorder = await loopback((_index, response) => {
      response.writeHead(400, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ message: 'Invalid Webhook Token', code: 50035 }));
    });
    try {
      const lines: string[] = [];
      const outcome = await deliverNotification(alertDocument([certNever()]), EXIT.integrity, {
        home: tempHome('factory-discord-home-'),
        env: { [WEBHOOK_ENV]: recorder.url },
        platform: 'darwin',
        warn: (line) => lines.push(line),
        detectsDiscord: () => true,
        timeoutMs: 2_000,
      });
      // `runAlerts` returns the decision's own code whatever this outcome says; a transport failure is
      // one reported NOTIFY line, which is what the specs in alerts.test.ts pin through the binary.
      expect(outcome.status).toBe('failed');
      expect(outcome.delivered).toBe(false);
      expect(outcome.detail).toContain('HTTP 400: Invalid Webhook Token');
      expect(lines).toHaveLength(1);
      expect(lines[0]).toContain('NOTIFY  FAILED');
      expect(lines[0]).toContain('(the exit code describes the evidence, not the transport)');
    } finally {
      await recorder.close();
    }
  });
});

// ---------------------------------------------------------------------------
// The URL is a credential: 0600 or refused, and scheme + host is all a log may carry
// ---------------------------------------------------------------------------

/** A fresh factory home with `$FACTORY_HOME/secrets/alerts-webhook` written at the given mode. */
function secretHome(contents: string, mode: number): { home: string; path: string } {
  const home = tempHome('factory-discord-secret-');
  const directory = join(home, 'secrets');
  mkdirSync(directory, { recursive: true });
  const path = join(directory, 'alerts-webhook');
  writeFileSync(path, `${contents}\n`, { mode });
  // `writeFileSync`'s mode is filtered by the umask; `chmod` is what the spec is actually asserting.
  chmodSync(path, mode);
  return { home, path };
}

describe('the webhook secret file', () => {
  it('[a 0644 secret is refused with the chmod 600 fix, and nothing is POSTed]', async () => {
    const recorder = await loopback();
    try {
      const token = 'top-secret-token';
      const { home, path } = secretHome(`${recorder.origin}/api/webhooks/42/${token}`, 0o644);
      const lines: string[] = [];
      const outcome = await deliverNotification(alertDocument([certNever()]), EXIT.integrity, {
        home,
        env: {},
        platform: 'linux',
        warn: (line) => lines.push(line),
        detectsDiscord: () => true,
      });
      expect(outcome.status).toBe('failed');
      expect(outcome.delivered).toBe(false);
      // The refusal names the file, the mode and the exact fix — not "insecure".
      expect(outcome.detail).toContain(path);
      expect(outcome.detail).toContain('644');
      expect(outcome.detail).toContain('chmod 600');
      expect(recorder.requests).toEqual([]);
      expect(lines).toHaveLength(1);
      expect(lines[0]).toContain('NOTIFY  FAILED');
      expect(lines[0]).toContain('chmod 600');
      expect(lines[0]).not.toContain(token);
    } finally {
      await recorder.close();
    }
  });

  it('[the refusal message is exact enough to follow without opening the file]', () => {
    const { home, path } = secretHome('http://127.0.0.1:1/api/webhooks/1/fake-token', 0o644);
    const config = resolveWebhookConfig({}, home);
    expect(config.kind).toBe('invalid');
    if (config.kind !== 'invalid') throw new Error('a 0644 secret must not resolve to a webhook');
    expect(config.detail).toContain(`${path} is mode 644`);
    expect(config.detail).toContain(`chmod 600 ${path}`);
    expect(config.detail).not.toContain('fake-token');
  });

  it('[a 0600 secret is used, and the URL is never printed beyond scheme + host]', async () => {
    const recorder = await loopback();
    try {
      const token = 'top-secret-token';
      const { home } = secretHome(`${recorder.origin}/api/webhooks/42/${token}`, 0o600);
      const document = alertDocument([certNever()]);
      const lines: string[] = [];
      const outcome = await deliverNotification(document, EXIT.integrity, {
        home,
        env: {},
        platform: 'darwin',
        warn: (line) => lines.push(line),
        detectsDiscord: () => true,
      });
      expect(outcome.status).toBe('delivered');
      expect(recorder.requests).toHaveLength(1);
      expect(recorder.requests[0]?.path).toBe(`/api/webhooks/42/${token}`);
      expect(JSON.parse(recorder.requests[0]?.body ?? '{}')).toEqual(
        payloadFor(document, EXIT.integrity),
      );
      expect(lines[0]).toContain(recorder.origin);
      expect(lines[0]).not.toContain(token);
      expect(lines[0]).not.toContain('/api/webhooks');
    } finally {
      await recorder.close();
    }
  });

  it('[the direct URL wins over both files, including a default that would be refused]', async () => {
    const direct = await loopback();
    const fallback = await loopback();
    try {
      // The default file is 0644 and would be a reported failure if it were consulted; the direct value
      // must be used without touching it, so the operator's one-off override cannot be blocked by an
      // unrelated bad file.
      const { home } = secretHome(`${fallback.origin}/api/webhooks/1/fake-token`, 0o644);
      const lines: string[] = [];
      const outcome = await deliverNotification(alertDocument([certNever()]), EXIT.integrity, {
        home,
        env: { [WEBHOOK_ENV]: direct.url, [WEBHOOK_FILE_ENV]: '/nonexistent/alerts-webhook' },
        platform: 'darwin',
        warn: (line) => lines.push(line),
      });
      expect(outcome.status).toBe('delivered');
      expect(direct.requests).toHaveLength(1);
      expect(fallback.requests).toEqual([]);
    } finally {
      await direct.close();
      await fallback.close();
    }
  });

  it('[FACTORY_ALERTS_WEBHOOK_URL_FILE wins over the default path]', async () => {
    const named = await loopback();
    const fallback = await loopback();
    try {
      const { home } = secretHome(`${fallback.origin}/api/webhooks/1/fake-token`, 0o644);
      const namedPath = join(home, 'named-webhook');
      writeFileSync(namedPath, `${named.url}\n`, { mode: 0o600 });
      chmodSync(namedPath, 0o600);
      const outcome = await deliverNotification(alertDocument([certNever()]), EXIT.integrity, {
        home,
        env: { [WEBHOOK_FILE_ENV]: namedPath },
        platform: 'darwin',
        warn: () => undefined,
      });
      expect(outcome.status).toBe('delivered');
      expect(named.requests).toHaveLength(1);
      expect(fallback.requests).toEqual([]);
    } finally {
      await named.close();
      await fallback.close();
    }
  });

  it('[a named secret file that does not exist is a reported failure, not a silent fallback]', async () => {
    const lines: string[] = [];
    const outcome = await deliverNotification(alertDocument([certNever()]), EXIT.integrity, {
      home: tempHome('factory-discord-missing-'),
      env: { [WEBHOOK_FILE_ENV]: '/nonexistent/alerts-webhook' },
      platform: 'linux',
      warn: (line) => lines.push(line),
    });
    // `skipped` would be the local channel on a non-macOS host; `failed` is the configured webhook
    // saying it cannot be used, which is what the operator must see.
    expect(outcome).toEqual({
      planned: true,
      delivered: false,
      status: 'failed',
      transport: 'none',
      detail: expect.stringContaining('does not exist'),
    });
    expect(outcome.detail).toContain(WEBHOOK_FILE_ENV);
    expect(lines[0]).toContain('NOTIFY  FAILED');
  });

  it('[a blank secret file is a reported failure with the reason]', async () => {
    const { home, path } = secretHome('', 0o600);
    const lines: string[] = [];
    const outcome = await deliverNotification(alertDocument([certNever()]), EXIT.integrity, {
      home,
      env: {},
      platform: 'linux',
      warn: (line) => lines.push(line),
    });
    expect(outcome.status).toBe('failed');
    expect(outcome.detail).toContain(`${path} is empty`);
    expect(lines[0]).toContain('NOTIFY  FAILED');
  });

  it('[a missing default secret falls through to the local channel, not an error]', async () => {
    const lines: string[] = [];
    const outcome = await deliverNotification(alertDocument([certNever()]), EXIT.integrity, {
      home: tempHome('factory-discord-no-secret-'),
      env: {},
      platform: 'linux',
      warn: (line) => lines.push(line),
    });
    // No webhook was ever configured: that is the normal local-notification case, and the reason it
    // did not display must still be stated.
    expect(outcome).toEqual({
      planned: true,
      delivered: false,
      status: 'skipped',
      transport: 'none',
      detail: expect.stringContaining('no local notification transport on linux'),
    });
    expect(lines[0]).toContain('NOTIFY  SKIPPED');
  });
});

// ---------------------------------------------------------------------------
// The raw transport's response body: drained, but never unbounded
// ---------------------------------------------------------------------------

interface BoundedProbe {
  readonly url: string;
  /**
   * How the listener's response ended. `finished` means it wrote every byte it had; `cancelled`
   * means the client closed the connection first. This is an observation of the socket, which is
   * what the bound is about — not a measurement of elapsed time.
   */
  readonly ended: Promise<'finished' | 'cancelled'>;
  close(): Promise<void>;
}

/**
 * A listener that answers with a body far larger than {@link WEBHOOK_RESPONSE_LIMIT}.
 *
 * It writes `WEBHOOK_RESPONSE_LIMIT * 128` bytes (8 MiB) in 64 KiB turns, yielding between writes,
 * and then ends the response. A client that honours the bound reads a chunk or two, cancels and
 * closes the connection: the listener observes `close` without `finish` and stops writing. A client
 * that drains the body instead lets the listener reach `end()`, so `ended` resolves `finished`.
 * That is how the spec tells "cancelled" from "read to the end".
 */
async function oversizeListener(): Promise<BoundedProbe> {
  const total = WEBHOOK_RESPONSE_LIMIT * 128;
  const chunk = Buffer.alloc(64 * 1024, 'x');
  let sent = 0;
  let stopped = false;
  let resolveEnded: ((ended: 'finished' | 'cancelled') => void) | null = null;
  const ended = new Promise<'finished' | 'cancelled'>((resolve) => {
    resolveEnded = resolve;
  });
  const server: Server = createServer((_request, response) => {
    // The client tearing the connection down is the expected end of this response, not a failure.
    response.on('error', () => undefined);
    response.on('finish', () => {
      resolveEnded?.('finished');
    });
    response.on('close', () => {
      stopped = true;
      resolveEnded?.('cancelled');
    });
    response.writeHead(200, { 'content-type': 'application/octet-stream' });
    const pump = (): void => {
      if (stopped || response.destroyed || response.writableEnded) return;
      if (sent >= total) {
        response.end();
        return;
      }
      sent += chunk.length;
      response.write(chunk);
      setImmediate(pump);
    };
    pump();
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
  const address = server.address();
  if (address === null || typeof address === 'string') throw new Error('no loopback port');
  return {
    url: `http://127.0.0.1:${String(address.port)}/hook`,
    ended,
    async close() {
      server.closeAllConnections();
      await new Promise<void>((resolve, reject) => {
        server.close((error) => (error === undefined ? resolve() : reject(error)));
      });
    },
  };
}

describe('postAlerts bounds the response body it drains', () => {
  it('[a body past the bound is cancelled, still delivered, and the detail names the truncation]', async () => {
    const probe = await oversizeListener();
    try {
      const result = await postAlerts(probe.url, '{}', 5_000);
      // (a) The outcome is unchanged in kind. The status arrived with the headers, so a 200 is a
      // delivery; whether the rest of the body was read is not evidence about whether the alert was
      // accepted, and a truncated body must not turn a delivered alert into a failure.
      expect(result.ok).toBe(true);
      expect(result.attempts).toBe(1);
      expect(result.status).toBe(200);
      // (b) The truncation is reported, with the bound, rather than silently swallowed.
      expect(result.detail).toContain('truncated');
      expect(result.detail).toContain(String(WEBHOOK_RESPONSE_LIMIT));
      // (c) The socket was closed rather than read to the end: the listener says how its response
      // ended, and `finished` would mean this client buffered all 8 MiB — the defect.
      expect(await probe.ended).toBe('cancelled');
    } finally {
      await probe.close();
    }
  });

  it('[the NOTIFY line for a truncated 200 is DELIVERED, and names the truncation]', async () => {
    const probe = await oversizeListener();
    try {
      const lines: string[] = [];
      const outcome = await deliverNotification(alertDocument([certNever()]), EXIT.integrity, {
        home: tempHome('factory-raw-bound-home-'),
        env: { [WEBHOOK_ENV]: probe.url },
        platform: 'linux',
        warn: (line) => lines.push(line),
        timeoutMs: 5_000,
      });
      // The exit code still describes the evidence, and the one line a person reads says the body
      // was not finished — not just "HTTP 200" as if nothing had happened.
      expect(outcome.status).toBe('delivered');
      expect(outcome.delivered).toBe(true);
      expect(outcome.detail).toContain('truncated');
      expect(lines).toHaveLength(1);
      expect(lines[0]).toContain('NOTIFY  DELIVERED');
      expect(lines[0]).toContain('truncated');
      expect(await probe.ended).toBe('cancelled');
    } finally {
      await probe.close();
    }
  });
});
