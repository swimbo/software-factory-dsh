/**
 * E2E-36 — the health strip is silent when everything is fine, and when it speaks it
 * leads with the worst thing.
 *
 * Both halves matter. A strip that is always visible teaches the operator to ignore it,
 * and a strip that lists facts in declaration order buries the one that is on fire. So
 * the spec asserts the absence first (with a genuinely healthy store), then asserts that
 * the first line is the unavailable item and the second line is everything else.
 */
import { expect, test } from '@playwright/test';

import { startPanel, writeDshStub, type PanelHandle } from './harness/panel.ts';
import {
  EXPECTED_DSH_VERSION,
  cliAbort,
  cliUnit,
  newSeed,
  seedDispatchedOnly,
  seedVerdict,
  type Seed,
} from './harness/seed.ts';

test.describe('E2E-36 — absent when all-ok', () => {
  let seed: Seed;
  let panel: PanelHandle;

  test.beforeAll(async () => {
    seed = newSeed();
    // A lit unit and an aborted unit: the page has content and decisions to show, but
    // nothing is wrong with the machinery, and the DSH probe reads the pinned version.
    cliUnit(seed, { lane: 'lit' });
    const aborted = cliUnit(seed, { lane: 'dark' });
    cliAbort(seed, aborted);
    writeDshStub(seed.home, EXPECTED_DSH_VERSION);
    panel = await startPanel(seed.home, { env: { FACTORY_DSH_BIN: `${seed.home}/bin/dsh` } });
  });

  test.afterAll(async () => {
    await panel.close();
    seed.cleanup();
  });

  test('renders no health region at all when every check is ok', async ({ page }) => {
    const status = await panel.statusRequest();
    const health = status.json?.['health'] as Record<string, { state?: string }> | undefined;
    const notOk = Object.entries(health ?? {}).filter(
      ([key, value]) => key !== 'taskClasses' && value.state !== 'ok',
    );
    expect(notOk, `seeded health is not all-ok: ${JSON.stringify(notOk)}`).toEqual([]);

    await page.goto(panel.urlFor('/'));
    await expect(page.locator('#health-title')).toHaveCount(0);
    expect(await page.content()).not.toContain('HEALTH');
  });
});

test.describe('E2E-36 — worst first when something is wrong', () => {
  let seed: Seed;
  let panel: PanelHandle;

  test.beforeAll(async () => {
    seed = newSeed();
    // Three independent faults: the wall could not certify (unavailable), an effect is
    // stuck in the outbox (degraded), and no DSH version can be read (unavailable).
    const unknown = cliUnit(seed, { lane: 'dark' });
    seedVerdict(seed, { unitId: unknown, outcome: 'unknown', reasons: ['holdout_unavailable'] });
    const inFlight = cliUnit(seed, { lane: 'dark' });
    seedDispatchedOnly(seed, inFlight);
    // No dsh stub: the probe fails, which is the truthful "could not look" case.
    panel = await startPanel(seed.home);
  });

  test.afterAll(async () => {
    await panel.close();
    seed.cleanup();
  });

  test('leads with the worst item and lists the rest on one line', async ({ page }) => {
    await page.goto(panel.urlFor('/'));
    await expect(page.locator('#health-title')).toBeVisible();

    const firstLine = page.locator('aside.health p').first();
    await expect(firstLine).toContainText('WALL UNAVAILABLE');
    await expect(firstLine).toContainText('since');

    // The second line carries the rest, each with its own word and `since` when known.
    const rest = page.locator('aside.health p.meta');
    await expect(rest).toContainText('OUTBOX DEGRADED');
    await expect(rest).toContainText('DSH VERSION UNAVAILABLE');

    // The strip is a view of the JSON, not a second opinion.
    const status = await panel.statusRequest();
    const health = status.json?.['health'] as Record<string, { state?: string }> | undefined;
    expect(health?.['wall']?.state).toBe('unavailable');
    expect(health?.['outbox']?.state).toBe('degraded');
    expect(health?.['dshVersion']?.state).toBe('unavailable');
    expect(health?.['store']?.state).toBe('ok');
  });

  test('never claims an ok it could not observe', async ({ page }) => {
    await page.goto(panel.urlFor('/'));
    const body = await page.locator('body').innerText();
    // `DSH VERSION UNAVAILABLE` is the case this spec creates on purpose: the probe had
    // nothing to read, and the page says so instead of assuming the pinned version.
    // The strip only prints the *first* item's detail, so the sentence itself is a
    // contract fact and is asserted on the JSON.
    expect(body).toContain('DSH VERSION UNAVAILABLE');
    expect(body).not.toContain('DSH VERSION ok');

    const status = await panel.statusRequest();
    const dsh = (status.json?.['health'] as Record<string, { detail?: string | null }>)[
      'dshVersion'
    ];
    expect(dsh?.detail ?? '').toContain('no DSH version could be read at startup');
  });
});
