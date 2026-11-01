/**
 * The design tokens, checked rather than trusted.
 *
 * `ui-plan.md` §3.3 claims a WCAG ratio for every pairing the page uses. A claim
 * in a document drifts the first time a hex value is nudged, so this test
 * re-computes each ratio from the palette with the WCAG 2.x relative-luminance
 * formula and fails if the number in the code stops matching the number in the
 * plan — or if the pairing stops clearing the level it claims.
 */
import { describe, expect, it } from 'vitest';

import {
  CONTRAST_PAIRS,
  DARK,
  FONTS,
  LIGHT,
  SPACING,
  TOKEN_ROLES,
  TYPE,
  contrastRatio,
  paletteValue,
  relativeLuminance,
  stylesheet,
} from './tokens.ts';

const RATIO_TOLERANCE = 0.011;

describe('the palette', () => {
  it('has the nine roles of ui-plan §3.1 plus info, in both schemes', () => {
    expect(TOKEN_ROLES).toHaveLength(10);
    expect(Object.keys(LIGHT).sort()).toEqual([...TOKEN_ROLES].sort());
    expect(Object.keys(DARK).sort()).toEqual([...TOKEN_ROLES].sort());
    for (const role of TOKEN_ROLES) {
      expect(LIGHT[role]).toMatch(/^#[0-9A-F]{6}$/);
      expect(DARK[role]).toMatch(/^#[0-9A-F]{6}$/);
    }
  });

  it('gives `unknown` a hue that is neither the ok green nor the danger red', () => {
    // A grey or green "unknown" is how "we did not check" hides in a healthy page.
    for (const palette of [LIGHT, DARK]) {
      expect(palette.unknown).not.toBe(palette.ok);
      expect(palette.unknown).not.toBe(palette.danger);
      const unknown = contrastRatio(palette.unknown, palette.bg);
      const ok = contrastRatio(palette.ok, palette.bg);
      expect(unknown).toBeGreaterThan(4.5);
      expect(ok).toBeGreaterThan(4.5);
    }
  });
});

describe('contrast', () => {
  it('computes relative luminance with the WCAG anchors', () => {
    expect(relativeLuminance('#FFFFFF')).toBeCloseTo(1, 6);
    expect(relativeLuminance('#000000')).toBeCloseTo(0, 6);
    expect(contrastRatio('#000000', '#FFFFFF')).toBeCloseTo(21, 6);
    // Order-independent, and identical colours have no contrast.
    expect(contrastRatio('#FFFFFF', '#000000')).toBeCloseTo(21, 6);
    expect(contrastRatio('#17568F', '#17568F')).toBeCloseTo(1, 6);
  });

  it('rejects a colour it cannot parse instead of guessing', () => {
    expect(() => relativeLuminance('white')).toThrow(/not a #RRGGBB colour/);
    expect(() => relativeLuminance('#FFF')).toThrow(/not a #RRGGBB colour/);
  });

  it('matches the ratio documented in ui-plan §3.3 for every pairing', () => {
    for (const pair of CONTRAST_PAIRS) {
      const palette = pair.scheme === 'light' ? LIGHT : DARK;
      const actual = contrastRatio(paletteValue(palette, pair.fg), palette[pair.bg]);
      expect(
        Math.abs(actual - pair.ratio),
        `${pair.id}: documented ${pair.ratio}, computed ${actual.toFixed(2)}`,
      ).toBeLessThanOrEqual(RATIO_TOLERANCE);
    }
  });

  it('clears the level each pairing claims', () => {
    for (const pair of CONTRAST_PAIRS) {
      const palette = pair.scheme === 'light' ? LIGHT : DARK;
      const actual = contrastRatio(paletteValue(palette, pair.fg), palette[pair.bg]);
      if (pair.level === 'AAA') expect(actual, pair.id).toBeGreaterThanOrEqual(7);
      if (pair.level === 'AA') expect(actual, pair.id).toBeGreaterThanOrEqual(4.5);
      if (pair.level === 'decorative') expect(actual, pair.id).toBeGreaterThanOrEqual(1.5);
    }
  });

  it('keeps a documented ratio and a recomputed ratio from disagreeing by rounding', () => {
    // Every ratio is recorded to two decimals, so rounding may never be invisible.
    for (const pair of CONTRAST_PAIRS) {
      expect(Number(pair.ratio.toFixed(2))).toBe(pair.ratio);
    }
  });

  it('covers every state colour against both page backgrounds, in both schemes', () => {
    const ids = new Set(CONTRAST_PAIRS.map((pair) => pair.id));
    for (const scheme of ['light', 'dark'] as const) {
      for (const role of ['text', 'muted', 'ok', 'warn', 'danger', 'unknown', 'info'] as const) {
        for (const background of ['bg', 'surface'] as const) {
          expect(
            ids.has(`${scheme}/${role}-on-${background}`),
            `${scheme}/${role}-on-${background}`,
          ).toBe(true);
        }
      }
    }
  });
});

describe('the scale', () => {
  it('is 4/8 based with eight steps', () => {
    expect(Object.values(SPACING)).toEqual([4, 8, 12, 16, 24, 32, 48, 64]);
    for (const value of Object.values(SPACING)) expect(value % 4).toBe(0);
  });

  it('has five type sizes and two families, with no webfont', () => {
    expect(Object.keys(TYPE)).toEqual(['h1', 'h2', 'body', 'meta', 'mono']);
    expect(Object.keys(FONTS).sort()).toEqual(['mono', 'sans']);
    for (const family of Object.values(FONTS)) {
      expect(family).not.toMatch(/url\(/);
      expect(family).not.toMatch(/^@font-face/);
    }
    for (const spec of Object.values(TYPE)) {
      expect(spec.lineHeight).toBeGreaterThan(spec.size);
      expect([400, 600]).toContain(spec.weight);
    }
  });
});

describe('the stylesheet', () => {
  const css = stylesheet();

  it('carries both schemes as custom properties', () => {
    for (const role of TOKEN_ROLES) {
      expect(css).toContain(`--${role}: ${LIGHT[role]};`);
    }
    expect(css).toContain('@media (prefers-color-scheme: dark)');
    for (const role of TOKEN_ROLES) {
      expect(css).toContain(DARK[role]);
    }
  });

  it('requests nothing over the network', () => {
    // No fonts, no images, no imports: the page must look identical offline.
    expect(css).not.toMatch(/url\(/);
    expect(css).not.toMatch(/@import/);
    expect(css).not.toMatch(/https?:/);
    expect(css).not.toMatch(/@font-face/);
  });

  it('draws the estimated segment of the meter with a dashed pattern', () => {
    // The dash is the non-colour channel that says "this part is an estimate".
    expect(css).toMatch(
      /\.meter__estimated[^}]*background-image: repeating-linear-gradient\(45deg/,
    );
    expect(css).toMatch(/\.meter__gap[^}]*border-right: 1px dashed/);
  });

  it('declares the spacing scale as custom properties and uses it', () => {
    for (const [name, value] of Object.entries(SPACING)) {
      expect(css).toContain(`--${name}: ${value}px;`);
    }
    expect(css).toMatch(/padding: var\(--s[1-8]\)/);
    expect(css).toMatch(/margin: var\(--s[1-8]\)/);
  });
});
