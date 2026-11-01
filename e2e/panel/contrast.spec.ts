/**
 * E2E-41 — the palette is measured in the browser, in both colour schemes.
 *
 * `tokens.ts` documents 38 contrast pairs and a unit test recomputes them from the hex.
 * That proves the constants; it does not prove what an operator sees, because the
 * cascade can substitute a different token, a translucent background can composite
 * differently, and a `prefers-color-scheme` block can be dropped. So this spec reads
 * computed styles out of a real Chromium page in dark and light and recomputes the WCAG
 * ratio from those.
 *
 * It also proves the ok and unknown pills differ in **text and token**, not only in hue:
 * a greyscale or colour-blind operator has to be able to tell them apart.
 */
import { expect, test } from '@playwright/test';

import { computedColours, ratioOf } from './harness/contrast.ts';
import { startPanel, writeDshStub, type PanelHandle } from './harness/panel.ts';
import { EXPECTED_DSH_VERSION, cliUnit, newSeed, seedVerdict, type Seed } from './harness/seed.ts';

let seed: Seed;
let panel: PanelHandle;

test.beforeAll(async () => {
  seed = newSeed();
  const passed = cliUnit(seed, { lane: 'dark' });
  seedVerdict(seed, { unitId: passed, outcome: 'pass' });
  const unknown = cliUnit(seed, { lane: 'dark' });
  seedVerdict(seed, { unitId: unknown, outcome: 'unknown', reasons: ['holdout_unavailable'] });
  writeDshStub(seed.home, EXPECTED_DSH_VERSION);
  panel = await startPanel(seed.home, { env: { FACTORY_DSH_BIN: `${seed.home}/bin/dsh` } });
});

test.afterAll(async () => {
  await panel.close();
  seed.cleanup();
});

const SCHEMES = [
  { scheme: 'dark' as const, body: 7, pill: 4.5 },
  { scheme: 'light' as const, body: 7, pill: 4.5 },
];

for (const { scheme, body: bodyMinimum, pill: pillMinimum } of SCHEMES) {
  test.describe(`E2E-41 — ${scheme} scheme`, () => {
    test.use({ colorScheme: scheme });

    test('body text meets AAA against the page background', async ({ page }) => {
      await page.goto(panel.urlFor('/'));
      const colours = await computedColours(page, 'body', ['bg', 'text']);

      // The computed background of `body` is transparent, so the page's own token is
      // the honest partner for the measurement.
      const background = colours.tokens['bg'] ?? '';
      expect(background).not.toBe('');
      const ratio = ratioOf(colours.color, `rgb(${background})`);
      expect(ratio, `body text ${colours.color} on ${background}`).toBeGreaterThanOrEqual(
        bodyMinimum,
      );
    });

    test('meta text is still readable', async ({ page }) => {
      await page.goto(panel.urlFor('/'));
      const colours = await computedColours(page, 'p.meta', ['bg', 'muted']);
      const background = colours.tokens['bg'] ?? '';
      const ratio = ratioOf(colours.color, `rgb(${background})`);
      expect(ratio, `muted ${colours.color} on ${background}`).toBeGreaterThanOrEqual(pillMinimum);
    });

    test('the ok and unknown pills are readable and distinguishable without hue', async ({
      page,
    }) => {
      await page.goto(panel.urlFor('/'));

      const ok = await computedColours(page, 'section[aria-labelledby="verdicts-title"] .pill', [
        'ok',
      ]);
      const unknown = await computedColours(
        page,
        'section[aria-labelledby="needs-you-title"] .pill',
        ['unknown'],
      );

      const okRatio = ratioOf(ok.color, ok.background);
      const unknownRatio = ratioOf(unknown.color, unknown.background);
      expect(okRatio, `ok pill ${ok.color} on ${ok.background}`).toBeGreaterThanOrEqual(
        pillMinimum,
      );
      expect(
        unknownRatio,
        `unknown pill ${unknown.color} on ${unknown.background}`,
      ).toBeGreaterThanOrEqual(pillMinimum);

      // Different tokens, so both schemes really are what the config asked for.
      expect(ok.background).not.toBe(unknown.background);
      // Different words, so the distinction survives greyscale.
      const okWord = await page
        .locator('section[aria-labelledby="verdicts-title"] .pill--ok')
        .innerText();
      const unknownWord = await page
        .locator('section[aria-labelledby="needs-you-title"] .pill--unknown')
        .innerText();
      expect(okWord).toContain('PASSED');
      expect(unknownWord).toContain('UNKNOWN');
      expect(okWord.toUpperCase()).not.toBe(unknownWord.toUpperCase());
    });
  });
}

test.describe('E2E-41 — the schemes are not the same page', () => {
  test('a dark-scheme client and a light-scheme client get different backgrounds', async ({
    browser,
  }) => {
    const dark = await browser.newContext({ colorScheme: 'dark' });
    const light = await browser.newContext({ colorScheme: 'light' });
    try {
      const darkPage = await dark.newPage();
      const lightPage = await light.newPage();
      await darkPage.goto(panel.urlFor('/'));
      await lightPage.goto(panel.urlFor('/'));

      const read = async (target: typeof darkPage): Promise<string> =>
        target.evaluate(() => {
          const style = getComputedStyle(document.body);
          return `${style.color}|${style.backgroundColor}`;
        });

      const darkColours = await read(darkPage);
      const lightColours = await read(lightPage);
      expect(darkColours).not.toBe(lightColours);
    } finally {
      await dark.close();
      await light.close();
    }
  });
});
