/**
 * E2E-40 — the page is served to exactly one caller, and the token is the whole gate.
 *
 * A status page that reads the entire factory is the most sensitive surface in the
 * product, so the interesting assertions are the refusals: no token, a wrong token, a
 * token in the wrong place — and the fact that the token itself is never echoed back.
 * Loopback is not an exemption here; the spec proves the refusal happens with the
 * request arriving over loopback, which is the only interface the panel binds.
 */
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import { expect, test } from '@playwright/test';

import { startPanel, type PanelHandle } from './harness/panel.ts';
import { cliUnit, newSeed, type Seed } from './harness/seed.ts';

let seed: Seed;
let panel: PanelHandle;

test.beforeAll(async () => {
  seed = newSeed();
  // One real unit, so a served page is distinguishable from an empty one.
  cliUnit(seed, { lane: 'dark' });
  panel = await startPanel(seed.home);
});

test.afterAll(async () => {
  await panel.close();
  seed.cleanup();
});

test.describe('E2E-40 — one caller, one token', () => {
  test('refuses a request with no token, and names the header that would fix it', async ({
    page,
  }) => {
    const response = await page.goto(panel.origin);

    expect(response?.status()).toBe(401);
    // ui-plan §Auth: `401` with no body detail, and the HTML page showing the same 401
    // text. A browser navigation sends `Accept: text/html`, so this is the document.
    expect(response?.headers()['www-authenticate']).toContain('Bearer');
    expect(response?.headers()['content-type']).toContain('text/html');
    await expect(page.locator('#auth-title')).toHaveText('TOKEN REQUIRED');
    const refused = await page.content();
    expect(refused).toContain('401 UNAUTHORIZED');
    expect(refused).toContain('Authorization: Bearer');
    // A refusal page is not a status page: no region, no unit, no verdict, no narrative.
    for (const region of [
      '#needs-you-title',
      '#working-title',
      '#verdicts-title',
      '#budget-title',
    ]) {
      await expect(page.locator(region), region).toHaveCount(0);
    }
    expect(refused).not.toMatch(/U-[0-9a-f]{12}/u);
  });

  test('serves JSON to a tool and the page to a browser, both without detail', async ({
    request,
  }) => {
    // The negotiation, asserted from the outside: the same 401 must not change what it
    // discloses just because the caller asked for a different representation.
    const asTool = await request.get(panel.origin + '/', {
      headers: { accept: 'application/json' },
    });
    expect(asTool.status()).toBe(401);
    expect(asTool.headers()['content-type']).toContain('application/json');
    const body = (await asTool.json()) as { ok: boolean; code: string; message: string };
    expect(body.ok).toBe(false);
    expect(body.code).toBe('UNAUTHORIZED');
    expect(body.message).toContain('Authorization: Bearer');
    expect(JSON.stringify(body)).not.toContain(panel.token);

    const asBrowser = await request.get(panel.origin + '/', {
      headers: { accept: 'text/html' },
    });
    expect(asBrowser.status()).toBe(401);
    expect(asBrowser.headers()['content-type']).toContain('text/html');
    expect(await asBrowser.text()).toContain('TOKEN REQUIRED');
  });

  test('refuses a wrong token as firmly as a missing one', async ({ page }) => {
    const response = await page.goto(`${panel.origin}/?token=${'0'.repeat(panel.token.length)}`);

    expect(response?.status()).toBe(401);
    // Identical refusal for "wrong" and "missing": the difference is a guessing oracle.
    expect(await page.content()).toContain('UNAUTHORIZED');
  });

  test('serves the page to the right token, as a query parameter and as a header', async ({
    page,
    request,
  }) => {
    const viaQuery = await page.goto(panel.urlFor('/'));
    expect(viaQuery?.status()).toBe(200);
    await expect(page.locator('h1')).toHaveText('factory status');

    const viaHeader = await request.get(`${panel.origin}/`, {
      headers: { Authorization: `Bearer ${panel.token}` },
    });
    expect(viaHeader.status()).toBe(200);
    expect(await viaHeader.text()).toContain('factory status');
  });

  test('never renders the token it accepts, in the page or in the JSON', async ({ page }) => {
    await page.goto(panel.urlFor('/'));
    expect(await page.content()).not.toContain(panel.token);

    const status = await panel.statusRequest();
    expect(status.status).toBe(200);
    expect(status.body).not.toContain(panel.token);
  });

  test('refuses to bind anything but loopback, in a real process', async () => {
    // E2E-40's last clause. A unit test can call the factory function; only a real
    // process can prove the refusal is what an operator's mistyped config actually
    // gets, so the probe imports the same module the panel starts from.
    const serverModule = fileURLToPath(new URL('../../apps/panel/src/server.ts', import.meta.url));
    const probe = [
      `const { createPanelServer } = await import(${JSON.stringify(`file://${serverModule}`)});`,
      'try {',
      "  createPanelServer({ store: null, token: 'x'.repeat(24), host: '0.0.0.0' });",
      "  console.error('BOUND');",
      '  process.exit(0);',
      '} catch (error) {',
      '  console.error(error instanceof Error ? error.message : String(error));',
      '  process.exit(1);',
      '}',
    ].join('\n');

    const result = await new Promise<{ code: number | null; stderr: string }>((resolve) => {
      const child = spawn(process.execPath, ['--input-type=module', '-e', probe], {
        stdio: ['ignore', 'ignore', 'pipe'],
      });
      let stderr = '';
      child.stderr.setEncoding('utf8');
      child.stderr.on('data', (chunk: string) => {
        stderr += chunk;
      });
      child.on('close', (code) => resolve({ code, stderr }));
    });

    expect(result.code).toBe(1);
    expect(result.stderr).toContain('loopback only');
    expect(result.stderr).not.toContain('BOUND');
  });

  test('keeps the status JSON behind the same token', async ({ request }) => {
    const refused = await request.get(`${panel.origin}/api/status`);
    expect(refused.status()).toBe(401);

    const served = await request.get(`${panel.origin}/api/status`, {
      headers: { Authorization: `Bearer ${panel.token}` },
    });
    expect(served.status()).toBe(200);
    expect(served.headers()['content-type']).toContain('application/json');
    const body = (await served.json()) as Record<string, unknown>;
    expect(body['schemaVersion']).toBe('status.v1');
  });
});
