/**
 * The read-only guarantee, asserted against a real server rather than a route table.
 *
 * `ui-plan.md` §5 and `ux-plan.md` §7.2 promise that the page cannot change the factory:
 * no route takes a body, no method but `GET` is answered, there is no script to post with,
 * and the content-security policy forbids forms and frames. Each of those is one
 * assertion here, because a promise a spec does not check is a comment.
 *
 * It also pins the two facts that make the page safe to leave open on a monitor: the
 * receipt's narrative never reaches the DOM, and the store is bit-identical before and
 * after a barrage of write attempts.
 */
import { expect, test } from '@playwright/test';

import { startPanel, writeDshStub, type PanelHandle } from './harness/panel.ts';
import {
  EXPECTED_DSH_VERSION,
  NARRATIVE_MARKER,
  cliUnit,
  newSeed,
  seedVerdict,
  type Seed,
} from './harness/seed.ts';

let seed: Seed;
let panel: PanelHandle;

test.beforeAll(async () => {
  seed = newSeed();
  const unitId = cliUnit(seed, { lane: 'dark' });
  // The receipt carries a narrative the page must never render (L1: prose is not evidence).
  seedVerdict(seed, { unitId, outcome: 'pass' });
  writeDshStub(seed.home, EXPECTED_DSH_VERSION);
  panel = await startPanel(seed.home, { env: { FACTORY_DSH_BIN: `${seed.home}/bin/dsh` } });
});

test.afterAll(async () => {
  await panel.close();
  seed.cleanup();
});

test.describe('every write method is refused, with the method that would work', () => {
  for (const method of ['POST', 'PUT', 'PATCH', 'DELETE'] as const) {
    test(`${method} is 405 + Allow: GET on every route`, async ({ request }) => {
      for (const route of ['/', '/api/status', '/nope', '/api/nope']) {
        const response = await request.fetch(`${panel.origin}${route}?token=${panel.token}`, {
          method,
          data: '{"unitId":"U-0001"}',
          headers: { 'content-type': 'application/json' },
        });
        expect(response.status(), `${method} ${route}`).toBe(405);
        expect(response.headers()['allow']).toBe('GET');
        expect(await response.text()).toContain('METHOD_NOT_ALLOWED');
      }
    });
  }

  test('HEAD is refused too: the only method is GET', async ({ request }) => {
    const response = await request.head(`${panel.origin}/?token=${panel.token}`);
    expect(response.status()).toBe(405);
    expect(response.headers()['allow']).toBe('GET');
  });

  test('an unknown route is a 404 that names the two that exist', async ({ page }) => {
    const html = await page.goto(panel.urlFor('/nope'));
    expect(html?.status()).toBe(404);
    await expect(page.locator('body')).toContainText('/api/status');

    const json = await page.goto(panel.urlFor('/api/nope'));
    expect(json?.status()).toBe(404);
    expect(await page.content()).toContain('NOT_FOUND');
  });
});

test.describe('the guarantees behind the refusals', () => {
  test('ships a policy that forbids scripts, forms and framing', async ({ page }) => {
    const response = await page.goto(panel.urlFor('/'));
    const headers = response?.headers() ?? {};

    expect(headers['cache-control']).toContain('no-store');
    expect(headers['x-content-type-options']).toBe('nosniff');
    expect(headers['referrer-policy']).toBe('no-referrer');
    const csp = headers['content-security-policy'] ?? '';
    expect(csp).toContain("default-src 'none'");
    expect(csp).toContain("form-action 'none'");
    expect(csp).toContain("frame-ancestors 'none'");
    // The only exception in the policy is the one stylesheet, inline.
    expect(csp).toContain("style-src 'unsafe-inline'");
    expect(csp).not.toContain('script-src');
  });

  test('never renders the receipt narrative', async ({ page }) => {
    // Both surfaces, because "the JSON is clean" and "the page is clean" are different
    // claims: the renderer could leak prose the API correctly drops.
    const status = await panel.statusRequest();
    expect(status.body).not.toContain(NARRATIVE_MARKER);

    await page.goto(panel.urlFor('/'));
    expect(await page.content()).not.toContain(NARRATIVE_MARKER);
  });

  test('a barrage of write attempts leaves the store bit-identical', async ({ request }) => {
    const before = await panel.statusRequest();
    for (const method of ['POST', 'PUT', 'PATCH', 'DELETE'] as const) {
      await request.fetch(`${panel.origin}/api/status?token=${panel.token}`, {
        method,
        data: '{}',
      });
      await request.fetch(`${panel.origin}/?token=${panel.token}`, { method, data: '{}' });
    }
    const after = await panel.statusRequest();

    // `generatedAt` is the clock, not the state: everything else must be untouched.
    const strip = (body: Record<string, unknown> | null): string => {
      const copy = { ...(body ?? {}) };
      delete copy['generatedAt'];
      return JSON.stringify(copy);
    };
    expect(strip(after.json)).toBe(strip(before.json));
  });
});
