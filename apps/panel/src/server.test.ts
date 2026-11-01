/**
 * The HTTP surface — auth, methods, routes, headers, and the two payloads.
 *
 * These tests talk to a real socket on `127.0.0.1` with a random port, because the
 * thing being tested is the server, not a handler function: header handling, method
 * refusals and connection lifecycle are exactly where a read-only surface leaks.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { parseStatus } from '@factory/contracts';
import type { StatusV1 } from '@factory/contracts';

import { createPanelServer } from './server.ts';
import type { PanelListener } from './server.ts';
import { AT, LATER, tempStore, walkToVerdict } from '../test/fixtures.ts';
import type { TempStore } from '../test/fixtures.ts';
import { buildStatus } from './status.ts';

const TOKEN = 'a'.repeat(64);

let fixture: TempStore;
let listener: PanelListener;

beforeEach(async () => {
  fixture = tempStore();
  walkToVerdict(fixture.store);
  const server = createPanelServer({
    store: fixture.store,
    token: TOKEN,
    now: () => new Date(LATER),
    startedAt: new Date(AT),
  });
  listener = await server.listen(0);
});

afterEach(async () => {
  await listener.close();
  fixture.cleanup();
});

const url = (path = '/'): string => `${listener.url}${path}`;
const authed = (path = '/'): string =>
  `${url(path)}${path.includes('?') ? '&' : '?'}token=${TOKEN}`;
const bearer = (): Record<string, string> => ({ Authorization: `Bearer ${TOKEN}` });

describe('authentication', () => {
  it('refuses a request with no token and names the header that carries one', async () => {
    const response = await fetch(url('/'));
    expect(response.status).toBe(401);
    expect(response.headers.get('www-authenticate')).toContain('Bearer');
    expect(response.headers.get('cache-control')).toBe('no-store');
    const body = (await response.json()) as { code: string; message: string };
    expect(body.code).toBe('UNAUTHORIZED');
    expect(body.message).toMatch(/authorization: bearer/i);
    expect(body.message).toContain('?token=');
  });

  it('negotiates the refusal: HTML for a browser tab, JSON for a tool', async () => {
    // A person who opens the URL sees the page, not a payload they will paste into a
    // chat. Same status, same challenge, same rule that nothing about the store leaks.
    const browser = await fetch(url('/'), {
      headers: { Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8' },
    });
    expect(browser.status).toBe(401);
    expect(browser.headers.get('content-type')).toContain('text/html');
    expect(browser.headers.get('www-authenticate')).toContain('Bearer');
    expect(browser.headers.get('cache-control')).toBe('no-store');
    // The document keeps the policy the rest of the panel keeps: nothing to load or run.
    const csp = browser.headers.get('content-security-policy') ?? '';
    expect(csp).toContain("default-src 'none'");
    expect(csp).toContain("form-action 'none'");
    expect(csp).not.toContain('script-src');
    const html = await browser.text();
    expect(html).toContain('id="auth-title"');
    expect(html).toContain('TOKEN REQUIRED');
    expect(html).toMatch(/authorization: bearer/i);
    expect(html).not.toContain(TOKEN);
    // A refusal page is not a status page: no region, no unit, no verdict.
    expect(html).not.toContain('NEEDS YOU');
    expect(html).not.toContain('RECENT VERDICTS');
    expect(html).not.toContain('U-');

    // Tooling keeps the machine-readable body, including when it refuses the type.
    const json = await fetch(url('/'), { headers: { Accept: 'application/json' } });
    expect(json.headers.get('content-type')).toContain('application/json');
    expect((await json.json()) as { code: string }).toMatchObject({ code: 'UNAUTHORIZED' });
    const refused = await fetch(url('/'), { headers: { Accept: 'text/html;q=0' } });
    expect(refused.headers.get('content-type')).toContain('application/json');
    expect((await refused.json()) as { code: string }).toMatchObject({ code: 'UNAUTHORIZED' });
  });

  it('refuses a wrong token, including one of a different length', async () => {
    const short = await fetch(url(`/?token=${'b'.repeat(8)}`));
    expect(short.status).toBe(401);
    const sameLength = await fetch(url(`/?token=${'b'.repeat(64)}`));
    expect(sameLength.status).toBe(401);
    const header = await fetch(url('/'), {
      headers: { Authorization: `Bearer ${'c'.repeat(64)}` },
    });
    expect(header.status).toBe(401);
  });

  it('accepts the token as a query parameter and as a bearer header', async () => {
    const query = await fetch(authed('/'));
    expect(query.status).toBe(200);
    const header = await fetch(url('/'), { headers: bearer() });
    expect(header.status).toBe(200);
  });

  it('guards /api/status exactly as it guards the page', async () => {
    const response = await fetch(url('/api/status'));
    expect(response.status).toBe(401);
    // No localhost bypass: the 401 above came from loopback.
    expect((await response.json()) as { code: string }).toMatchObject({ code: 'UNAUTHORIZED' });
  });

  it('never echoes the token into a page', async () => {
    const html = await (await fetch(authed('/'))).text();
    expect(html).not.toContain(TOKEN);
  });
});

describe('read-only by construction', () => {
  it('refuses every write method with 405 and `Allow: GET`', async () => {
    for (const method of ['POST', 'PUT', 'PATCH', 'DELETE']) {
      const response = await fetch(url('/'), { method, headers: bearer() });
      expect(response.status, method).toBe(405);
      expect(response.headers.get('allow'), method).toBe('GET');
      const body = (await response.json()) as { code: string };
      expect(body.code).toBe('METHOD_NOT_ALLOWED');
    }
  });

  it('refuses a write to /api/status too', async () => {
    const response = await fetch(url('/api/status'), {
      method: 'POST',
      headers: bearer(),
      body: '{}',
    });
    expect(response.status).toBe(405);
    expect(response.headers.get('allow')).toBe('GET');
  });

  it('refuses HEAD, so no method but GET is answerable', async () => {
    const response = await fetch(url('/'), { method: 'HEAD', headers: bearer() });
    expect(response.status).toBe(405);
  });

  it('answers an unknown route with 404 and nothing else', async () => {
    const html = await fetch(authed('/units'));
    expect(html.status).toBe(404);
    expect(await html.text()).toContain('NO SUCH ROUTE');
    const api = await fetch(authed('/api/units'));
    expect(api.status).toBe(404);
    expect((await api.json()) as { code: string }).toMatchObject({ code: 'NOT_FOUND' });
  });
});

describe('GET /', () => {
  it('serves the page with a no-store, script-free, loopback-only contract', async () => {
    const response = await fetch(authed('/'));
    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toContain('text/html');
    expect(response.headers.get('cache-control')).toBe('no-store');
    expect(response.headers.get('x-content-type-options')).toBe('nosniff');
    expect(response.headers.get('referrer-policy')).toBe('no-referrer');
    const csp = response.headers.get('content-security-policy') ?? '';
    expect(csp).toContain("default-src 'none'");
    expect(csp).toContain("form-action 'none'");
    expect(csp).not.toContain('unsafe-eval');
    const html = await response.text();
    expect(html).toContain('NEEDS YOU');
    expect(html).toContain('RECENT VERDICTS');
  });

  it('renders the store it was given', async () => {
    const html = await (await fetch(authed('/'))).text();
    expect(html).toContain('U-7f3a9c');
    expect(html).toContain('PASSED');
    expect(html).toContain('~$0.00 of $20.00, estimated');
  });
});

describe('GET /api/status', () => {
  it('serves status.v1 that validates and matches the same build', async () => {
    const response = await fetch(authed('/api/status'));
    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toContain('application/json');
    expect(response.headers.get('cache-control')).toBe('no-store');
    const body = (await response.json()) as StatusV1;
    expect(() => parseStatus(body)).not.toThrow();
    const fresh = parseStatus(
      buildStatus(fixture.store, { now: () => new Date(LATER), startedAt: new Date(AT) }),
    );
    expect(body).toEqual(fresh);
    expect(body.schemaVersion).toBe('status.v1');
    expect(body.health.dshVersion.observed).toBeNull();
  });
});

describe('the injected DSH observation', () => {
  /** Start a second panel that reports a given observed version. */
  async function panelWith(provider: () => string | null): Promise<PanelListener> {
    return createPanelServer({
      store: fixture.store,
      token: TOKEN,
      now: () => new Date(LATER),
      startedAt: new Date(AT),
      dshVersionObserved: provider,
    }).listen(0);
  }

  it('goes silent when the probe read the pinned version', async () => {
    const pinned = await panelWith(() => '0.2.1-rc.5');
    try {
      const html = await (await fetch(`${pinned.url}/?token=${TOKEN}`)).text();
      // The whole point of the injection: an honest all-ok machine gets no strip.
      expect(html).not.toContain('HEALTH');
      expect(html).not.toContain('DSH VERSION');
      const body = (await (
        await fetch(`${pinned.url}/api/status?token=${TOKEN}`)
      ).json()) as StatusV1;
      expect(body.health.dshVersion.state).toBe('ok');
    } finally {
      await pinned.close();
    }
  });

  it('shows a degraded strip when the probe read a different version', async () => {
    const skewed = await panelWith(() => '0.3.0');
    try {
      const html = await (await fetch(`${skewed.url}/?token=${TOKEN}`)).text();
      expect(html).toContain('DSH VERSION DEGRADED');
      expect(html).toContain('expected 0.2.1-rc.5, observed 0.3.0');
      const body = (await (
        await fetch(`${skewed.url}/api/status?token=${TOKEN}`)
      ).json()) as StatusV1;
      expect(body.health.dshVersion.state).toBe('degraded');
    } finally {
      await skewed.close();
    }
  });

  it('treats a provider that throws as a failed probe, not as a 500', async () => {
    const broken = await panelWith(() => {
      throw new Error('spawn failed');
    });
    try {
      const response = await fetch(`${broken.url}/api/status?token=${TOKEN}`);
      expect(response.status).toBe(200);
      const body = (await response.json()) as StatusV1;
      expect(body.health.dshVersion.state).toBe('unavailable');
      expect(body.health.dshVersion.observed).toBeNull();
    } finally {
      await broken.close();
    }
  });
});

describe('starting up', () => {
  it('refuses an empty token', () => {
    expect(() => createPanelServer({ store: fixture.store, token: '   ' })).toThrow(
      /without a token/,
    );
  });

  it('refuses to bind anything but loopback', () => {
    for (const host of ['0.0.0.0', '::', '192.168.1.10', 'example.com']) {
      expect(() => createPanelServer({ store: fixture.store, token: TOKEN, host }), host).toThrow(
        /loopback only/,
      );
    }
    expect(() =>
      createPanelServer({ store: fixture.store, token: TOKEN, host: 'localhost' }),
    ).not.toThrow();
  });

  it('reports the port it actually bound', async () => {
    expect(listener.url).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);
    expect(listener.url).not.toContain(':0');
  });
});
