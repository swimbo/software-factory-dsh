/**
 * E2E-37 — `unknown` is never rendered as green, and never as a pass.
 *
 * This is the page's reason for existing: a factory that cannot tell "not measured" from
 * "fine" will promote a unit it never verified. The spec therefore checks three
 * independent things — the words (`not a pass`, the wall's reason code), the arithmetic
 * (`N unknown (not a pass)` in the aggregate line), and the pixels (the pill's computed
 * colour is the unknown token, and nothing in the card is the ok colour).
 */
import { expect, test } from '@playwright/test';

import { computedColours, ratioOf } from './harness/contrast.ts';
import { startPanel, writeDshStub, type PanelHandle } from './harness/panel.ts';
import { EXPECTED_DSH_VERSION, cliUnit, newSeed, seedVerdict, type Seed } from './harness/seed.ts';

let seed: Seed;
let panel: PanelHandle;
let unitId: string;

test.beforeAll(async () => {
  seed = newSeed();
  unitId = cliUnit(seed, { lane: 'dark' });
  seedVerdict(seed, { unitId, outcome: 'unknown', reasons: ['holdout_unavailable'] });
  writeDshStub(seed.home, EXPECTED_DSH_VERSION);
  panel = await startPanel(seed.home, { env: { FACTORY_DSH_BIN: `${seed.home}/bin/dsh` } });
});

test.afterAll(async () => {
  await panel.close();
  seed.cleanup();
});

test.describe('E2E-37 — unknown is a value, never a pass', () => {
  test('says `not a pass` and names the reason the wall could not certify', async ({ page }) => {
    await page.goto(panel.urlFor('/'));
    const needsYou = page.locator('section[aria-labelledby="needs-you-title"]');

    await expect(needsYou).toContainText('UNKNOWN VERDICT');
    await expect(needsYou).toContainText(unitId);
    // The literal words, from `ux-plan.md` §7.2 and the contract's `unknownReason`.
    await expect(needsYou).toContainText('not a pass');
    await expect(needsYou).toContainText('holdout_unavailable');
    // And it is not filed as a verdict: unknowns are decisions awaiting a human.
    await expect(page.locator('section[aria-labelledby="verdicts-title"]')).not.toContainText(
      unitId,
    );
    expect(await page.content()).not.toContain('PASSED');
  });

  test('counts the unknown in the aggregate line, so nobody reads `0 need you`', async ({
    page,
  }) => {
    await page.goto(panel.urlFor('/'));
    const answer = await page.locator('p.answer').innerText();

    expect(answer).toMatch(/\d+ need you/u);
    expect(answer).toContain('1 unknown (not a pass)');
    expect(answer).not.toContain('0 need you');

    // The same fact on the wire, so the page and the JSON cannot disagree.
    const status = await panel.statusRequest();
    const verdict = status.json?.['units'] as {
      verdict?: { state?: string; unknownReason?: string };
    }[];
    const entry = verdict.find((unit) => unit.verdict?.state === 'unknown');
    expect(entry).toBeDefined();
    expect(entry?.verdict?.unknownReason ?? '').toContain('holdout_unavailable');
  });

  test('paints the pill with the unknown token, never the ok token', async ({ page }) => {
    await page.goto(panel.urlFor('/'));
    const pill = 'section[aria-labelledby="needs-you-title"] .pill--unknown';
    const colours = await computedColours(page, pill, ['ok', 'unknown', 'bg']);

    const unknownToken = colours.tokens['unknown'] ?? '';
    const okToken = colours.tokens['ok'] ?? '';
    const inkToken = colours.tokens['bg'] ?? '';
    expect(unknownToken).not.toBe('');
    expect(okToken).not.toBe('');
    expect(unknownToken).not.toBe(okToken);

    // Filled pill: the token is the pill's background and the page ink is its text.
    // So the assertion E2E-37 asks for is exact — this pill *is* `--unknown`, and it is
    // demonstrably not `--ok`.
    expect(colours.background).toBe(unknownToken);
    expect(colours.background).not.toBe(okToken);
    expect(colours.color).toBe(inkToken);

    // And the pair is readable, not merely differently-coloured.
    const ratio = ratioOf(colours.color, colours.background);
    expect(ratio, `${colours.color} on ${colours.background}`).toBeGreaterThanOrEqual(4.5);
  });

  test('has no green anywhere in the unknown card', async ({ page }) => {
    await page.goto(panel.urlFor('/'));
    const okToken = (await computedColours(page, 'body', ['ok'])).tokens['ok'] ?? '';
    expect(okToken).not.toBe('');

    const offenders = await page.evaluate((token) => {
      // Resolve the token through a throwaway element so its computed value matches
      // what `getComputedStyle` reports for real elements.
      const probe = document.createElement('div');
      probe.style.color = token;
      document.body.appendChild(probe);
      const ok = getComputedStyle(probe).color;
      probe.remove();

      const record = document.querySelector('section[aria-labelledby="needs-you-title"] .record');
      if (record === null) return { found: false, hits: [] as string[] };
      const hits: string[] = [];
      for (const element of [record, ...Array.from(record.querySelectorAll('*'))]) {
        const style = getComputedStyle(element);
        for (const property of ['color', 'backgroundColor', 'borderTopColor'] as const) {
          if (style[property] === ok) hits.push(`${element.tagName.toLowerCase()}.${property}`);
        }
      }
      return { found: true, hits };
    }, okToken);

    expect(offenders.found).toBe(true);
    expect(offenders.hits).toEqual([]);
  });
});
