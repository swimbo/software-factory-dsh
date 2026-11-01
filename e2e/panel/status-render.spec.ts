/**
 * E2E-35, E2E-38, E2E-39, E2E-42 — the page renders the regions, the budget provenance
 * and the per-class Δ, and it degrades sanely when the browser cannot help it.
 *
 * Everything asserted here is server-rendered: the panel ships one inline stylesheet and
 * no script, so "the page works with JavaScript off" is not a special case, it is the
 * only case. The viewport test proves the narrow layout does not become a horizontal
 * scroll — a status page read on a phone must not hide its rightmost column.
 */
import { expect, test } from '@playwright/test';

import { startPanel, writeDshStub, type PanelHandle } from './harness/panel.ts';
import {
  EXPECTED_DSH_VERSION,
  cliStatusJson,
  cliUnit,
  newSeed,
  seedDispatchedOnly,
  seedUnknownSpend,
  seedVerdict,
  type Seed,
} from './harness/seed.ts';

let seed: Seed;
let panel: PanelHandle;
let workingUnitId: string;
let passUnitId: string;
let unknownUnitId: string;
let litUnitId: string;

test.beforeAll(async () => {
  seed = newSeed();
  // One unit in flight (a dispatch whose effect is still pending), one pass, one
  // unknown, one lit. Between them they put something in every region of the page.
  workingUnitId = cliUnit(seed, { lane: 'dark' });
  seedDispatchedOnly(seed, workingUnitId);
  passUnitId = cliUnit(seed, { lane: 'dark' });
  seedVerdict(seed, { unitId: passUnitId, outcome: 'pass' });
  unknownUnitId = cliUnit(seed, { lane: 'dark' });
  seedVerdict(seed, {
    unitId: unknownUnitId,
    outcome: 'unknown',
    reasons: ['holdout_unavailable'],
  });
  // One attempt the factory could not price: the budget has a real gap to disclose.
  seedUnknownSpend(seed, unknownUnitId);
  litUnitId = cliUnit(seed, { lane: 'lit' });

  // A readable DSH keeps the health strip out of the way: this spec is about layout,
  // and the strip has its own spec.
  writeDshStub(seed.home, EXPECTED_DSH_VERSION);
  panel = await startPanel(seed.home, { env: { FACTORY_DSH_BIN: `${seed.home}/bin/dsh` } });
});

test.afterAll(async () => {
  await panel.close();
  seed.cleanup();
});

test.describe('E2E-35 — three regions, the budget and the Δ table', () => {
  test('renders every region heading and puts each unit where it belongs', async ({ page }) => {
    await page.goto(panel.urlFor('/'));

    await expect(page.locator('#needs-you-title')).toContainText('NEEDS YOU');
    await expect(page.locator('#working-title')).toContainText('WORKING');
    await expect(page.locator('#verdicts-title')).toContainText('RECENT VERDICTS');
    await expect(page.locator('#budget-title')).toHaveText('BUDGET');
    await expect(page.locator('#delta-title')).toContainText('Δ BY TASK CLASS');

    // Placement, not just presence: the in-flight unit is working, the lit one is
    // waiting on a person, and the pass has a verdict card.
    await expect(page.locator('section[aria-labelledby="working-title"]')).toContainText(
      workingUnitId,
    );
    await expect(page.locator('section[aria-labelledby="needs-you-title"]')).toContainText(
      litUnitId,
    );
    await expect(page.locator('section[aria-labelledby="verdicts-title"]')).toContainText(
      passUnitId,
    );
    // An unknown verdict is *not* a verdict card: it is a decision, so it lives in
    // NEEDS YOU and nowhere else.
    await expect(page.locator('section[aria-labelledby="needs-you-title"]')).toContainText(
      unknownUnitId,
    );
    await expect(page.locator('section[aria-labelledby="verdicts-title"]')).not.toContainText(
      unknownUnitId,
    );
  });

  test('gives every waiting-on-person item its recommended command as text', async ({ page }) => {
    const status = await panel.statusRequest();
    const items = (status.json?.['waitingOnPerson'] ?? []) as { recommendedCommand?: string }[];
    expect(items.length).toBeGreaterThan(0);

    await page.goto(panel.urlFor('/'));
    const needsYou = page.locator('section[aria-labelledby="needs-you-title"]');
    for (const item of items) {
      expect(typeof item.recommendedCommand).toBe('string');
      await expect(needsYou).toContainText(item.recommendedCommand as string);
    }
  });

  test('offers no interactive control at all', async ({ page }) => {
    await page.goto(panel.urlFor('/'));

    // The read-only promise, asserted on the DOM rather than on the route table.
    for (const selector of ['button', 'input', 'textarea', 'select', 'form', 'script', 'a[href]']) {
      expect(await page.locator(selector).count(), `${selector} must not exist`).toBe(0);
    }
  });

  test('loads nothing from anywhere: no external asset, no inline script', async ({ page }) => {
    await page.goto(panel.urlFor('/'));
    const html = await page.content();

    expect(/(?:src|href)\s*=\s*["']https?:/iu.test(html)).toBe(false);
    expect(html).not.toContain('<script');
    expect(html).not.toContain('<link');
    // One inline stylesheet is the only asset, which is what keeps the page offline.
    expect(html).toContain('<style');
  });
});

test.describe('the two surfaces agree about one store', () => {
  test('the CLI and the page report the same units, lanes and verdicts', async () => {
    // This is the reason the suite seeds through the CLI: `status.v1` is one contract
    // read by two independent implementations, and a divergence between them is a bug
    // in one of the readers, not a matter of taste.
    const cliView = cliStatusJson(seed);
    const panelView = (await panel.statusRequest()).json;
    expect(panelView).not.toBeNull();

    expect(cliView['schemaVersion']).toBe(panelView?.['schemaVersion']);
    const facts = (view: Record<string, unknown>): string[] => {
      const list = (view['units'] ?? []) as {
        unitId?: string;
        lane?: string | null;
        verdict?: { state?: string } | null;
      }[];
      return list
        .map((unit) => `${String(unit.unitId)}|${unit.lane ?? '-'}|${unit.verdict?.state ?? '-'}`)
        .sort();
    };
    expect(facts(panelView ?? {})).toEqual(facts(cliView));

    // The set of *reasons a person is needed* is the contract's real surface: a kind
    // one reader emits and the other drops is a unit the operator is never told about
    // (`ux-plan.md` A-1). Ids legitimately differ — one is derived, one is generated.
    const kinds = (view: Record<string, unknown>): string[] =>
      ((view['waitingOnPerson'] ?? []) as { kind?: string }[])
        .map((item) => String(item.kind))
        .sort();
    expect(kinds(panelView ?? {})).toEqual(kinds(cliView));
    expect(kinds(cliView)).toContain('initial_production_deploy');
  });
});

test.describe('E2E-38 — estimated spend is unmistakable', () => {
  test('marks estimated figures with the word and the dashed meter', async ({ page }) => {
    await page.goto(panel.urlFor('/'));

    const budget = page.locator('section[aria-labelledby="budget-title"]');
    await expect(budget).toContainText('~$');
    await expect(budget).toContainText('estimated');

    // Provenance is not decoration: the estimated share of the meter is dashed, so it
    // survives greyscale and colour-blindness.
    const meterFill = await page.evaluate(() => {
      const element = document.querySelector('.meter__estimated');
      if (element === null) return null;
      const style = getComputedStyle(element);
      return { image: style.backgroundImage, color: style.backgroundColor };
    });
    expect(meterFill).not.toBeNull();
    expect(meterFill?.image).not.toBe('none');
    expect(meterFill?.image).toContain('repeating-linear-gradient');
  });

  test('shows the gap and says spend is understated when a unit is unmeasured', async ({
    page,
  }) => {
    const status = await panel.statusRequest();
    const budget = status.json?.['budget'] as { unknownCount?: number } | undefined;
    expect((budget?.unknownCount ?? 0) > 0, 'the seed must leave one unit unmeasured').toBe(true);

    await page.goto(panel.urlFor('/'));
    const section = page.locator('section[aria-labelledby="budget-title"]');
    await expect(section).toContainText('spend unknown for');
    await expect(section).toContainText('spend understated');
    // A gap without a word is what turns "$6.41" into a lie of precision.
    await expect(section).not.toContainText('0 units unmeasured');
  });
});

test.describe('E2E-39 — Δ is per task class and never blended', () => {
  test('renders one row per class and no aggregate', async ({ page }) => {
    const status = await panel.statusRequest();
    const classes =
      (status.json?.['health'] as { taskClasses?: unknown[] } | undefined)?.taskClasses ?? [];
    expect(classes.length).toBeGreaterThan(0);

    await page.goto(panel.urlFor('/'));
    const section = page.locator('section[aria-labelledby="delta-title"]');
    const rows = section.locator('tbody tr');
    await expect(rows).toHaveCount(classes.length);

    for (const row of await rows.all()) {
      await expect(row).toContainText('Δ');
    }
    // The one number this table must never produce: a blended Δ across classes.
    await expect(section).toContainText('never blended');
    expect(await section.innerText()).not.toMatch(/TOTAL|BLENDED|AVERAGE/u);
  });

  test('renders an unmeasured Δ as `unknown`, not as zero', async ({ page }) => {
    await page.goto(panel.urlFor('/'));
    const section = page.locator('section[aria-labelledby="delta-title"]');
    const text = await section.innerText();
    // `escape unknown (no samples)` is the escape-rate row; `unstable (n<5)` is the
    // Δ row with too few samples to trust. Neither is allowed to read 0.00.
    expect(text).toContain('escape unknown (no samples)');
    expect(text).toMatch(/unstable \(n<\d+\)/u);
  });
});

test.describe('E2E-42 — the page survives a hostile client', () => {
  test.use({ viewport: { width: 320, height: 800 } });

  test('does not scroll horizontally at 320 px', async ({ page }) => {
    await page.goto(panel.urlFor('/'));
    const overflow = await page.evaluate(() => {
      const root = document.documentElement;
      return { scrollWidth: root.scrollWidth, clientWidth: root.clientWidth };
    });
    expect(overflow.scrollWidth).toBeLessThanOrEqual(overflow.clientWidth + 1);
    await expect(page.locator('#needs-you-title')).toBeVisible();
  });
});

test.describe('E2E-42 — no JavaScript, same page', () => {
  test('parses identically with scripting disabled', async ({ browser }) => {
    const context = await browser.newContext({ javaScriptEnabled: false });
    try {
      const page = await context.newPage();
      const response = await page.goto(panel.urlFor('/'));
      expect(response?.status()).toBe(200);
      await expect(page.locator('#needs-you-title')).toContainText('NEEDS YOU');
      await expect(page.locator('#budget-title')).toHaveText('BUDGET');
      await expect(page.locator('section[aria-labelledby="needs-you-title"]')).toContainText(
        litUnitId,
      );
    } finally {
      await context.close();
    }
  });
});
