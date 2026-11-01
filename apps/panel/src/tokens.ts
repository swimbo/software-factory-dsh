/**
 * The visual system, as data.
 *
 * Nine colour roles, one 4/8 spacing scale, five type sizes, two families and no
 * webfont — the complete system from `ui-plan.md` §3, written down once so the
 * stylesheet, the renderer and the contrast test cannot disagree about it.
 *
 * The contrast numbers here are **calculated**, not asserted: `CONTRAST_PAIRS`
 * carries the ratio each pair is documented to achieve, and
 * `tokens.test.ts` re-computes every one of them from the hex values with the
 * WCAG 2.x relative-luminance formula. A token edit that breaks a ratio fails the
 * build instead of shipping a page that merely looks fine.
 */

/** The nine roles. `info` is the tenth value — links and commands, never a state. */
export const TOKEN_ROLES = [
  'bg',
  'surface',
  'text',
  'muted',
  'border',
  'ok',
  'warn',
  'danger',
  'unknown',
  'info',
] as const;
export type TokenRole = (typeof TOKEN_ROLES)[number];

export type Palette = Readonly<Record<TokenRole, string>>;

/** Light scheme — `ui-plan.md` §3.1. */
export const LIGHT: Palette = {
  bg: '#FFFFFF',
  surface: '#F5F5F2',
  text: '#141413',
  muted: '#57574F',
  border: '#C9C8C0',
  ok: '#14603A',
  warn: '#7A4A00',
  danger: '#9E1B1B',
  unknown: '#4B3A8C',
  info: '#17568F',
};

/**
 * Dark scheme. `unknown` keeps its own hue deliberately (violet): it must never be
 * mistakable for `ok` (green) or `danger` (red) under deuteranopia or protanopia,
 * and it must never be grey either — grey is how "we didn't check" hides.
 */
export const DARK: Palette = {
  bg: '#141413',
  surface: '#1E1E1C',
  text: '#F4F3EE',
  muted: '#A6A59C',
  border: '#3A3A34',
  ok: '#5FB57F',
  warn: '#D9A03C',
  danger: '#EE8A80',
  unknown: '#B3A1EF',
  info: '#7FB2E6',
};

/** Spacing scale — 4/8 base, eight steps, and no other values anywhere. */
export const SPACING = {
  s1: 4,
  s2: 8,
  s3: 12,
  s4: 16,
  s5: 24,
  s6: 32,
  s7: 48,
  s8: 64,
} as const;

export type TypeFamily = 'sans' | 'mono';

export interface TypeSpec {
  readonly size: number;
  readonly lineHeight: number;
  readonly weight: 400 | 600;
  readonly family: TypeFamily;
}

/** Five sizes, two families. No webfont is loaded, so the page renders offline. */
export const TYPE = {
  h1: { size: 20, lineHeight: 28, weight: 600, family: 'sans' },
  h2: { size: 15, lineHeight: 22, weight: 600, family: 'sans' },
  body: { size: 15, lineHeight: 22, weight: 400, family: 'sans' },
  meta: { size: 13, lineHeight: 18, weight: 400, family: 'sans' },
  mono: { size: 12, lineHeight: 18, weight: 400, family: 'mono' },
} as const satisfies Record<string, TypeSpec>;

export const FONTS: Readonly<Record<TypeFamily, string>> = {
  sans: '-apple-system, "Segoe UI", system-ui, sans-serif',
  mono: 'ui-monospace, "SF Mono", Menlo, Consolas, monospace',
};

export type ContrastLevel = 'AA' | 'AAA' | 'decorative';

/**
 * Every text/background pair the page actually uses, with the ratio `ui-plan.md`
 * §3.3 documents for it. `level` is what the pair is *claimed* to clear: body text
 * needs 4.5:1, large text and UI boundaries 3:1, and the plan claims AAA for all
 * text pairs except the two muted-on-surface ones.
 */
export interface ContrastPair {
  readonly id: string;
  readonly scheme: 'light' | 'dark';
  readonly fg: TokenRole | '#FFFFFF';
  readonly bg: TokenRole;
  readonly ratio: number;
  readonly level: ContrastLevel;
}

export const CONTRAST_PAIRS: readonly ContrastPair[] = [
  // light — text on page and on surfaces
  { id: 'light/text-on-bg', scheme: 'light', fg: 'text', bg: 'bg', ratio: 18.43, level: 'AAA' },
  {
    id: 'light/text-on-surface',
    scheme: 'light',
    fg: 'text',
    bg: 'surface',
    ratio: 16.88,
    level: 'AAA',
  },
  { id: 'light/muted-on-bg', scheme: 'light', fg: 'muted', bg: 'bg', ratio: 7.29, level: 'AAA' },
  {
    id: 'light/muted-on-surface',
    scheme: 'light',
    fg: 'muted',
    bg: 'surface',
    ratio: 6.67,
    level: 'AA',
  },
  { id: 'light/ok-on-bg', scheme: 'light', fg: 'ok', bg: 'bg', ratio: 7.6, level: 'AAA' },
  { id: 'light/ok-on-surface', scheme: 'light', fg: 'ok', bg: 'surface', ratio: 6.96, level: 'AA' },
  { id: 'light/warn-on-bg', scheme: 'light', fg: 'warn', bg: 'bg', ratio: 7.48, level: 'AAA' },
  {
    id: 'light/warn-on-surface',
    scheme: 'light',
    fg: 'warn',
    bg: 'surface',
    ratio: 6.85,
    level: 'AA',
  },
  { id: 'light/danger-on-bg', scheme: 'light', fg: 'danger', bg: 'bg', ratio: 8.0, level: 'AAA' },
  {
    id: 'light/danger-on-surface',
    scheme: 'light',
    fg: 'danger',
    bg: 'surface',
    ratio: 7.32,
    level: 'AAA',
  },
  { id: 'light/unknown-on-bg', scheme: 'light', fg: 'unknown', bg: 'bg', ratio: 9.2, level: 'AAA' },
  {
    id: 'light/unknown-on-surface',
    scheme: 'light',
    fg: 'unknown',
    bg: 'surface',
    ratio: 8.42,
    level: 'AAA',
  },
  { id: 'light/info-on-bg', scheme: 'light', fg: 'info', bg: 'bg', ratio: 7.6, level: 'AAA' },
  {
    id: 'light/info-on-surface',
    scheme: 'light',
    fg: 'info',
    bg: 'surface',
    ratio: 6.96,
    level: 'AA',
  },
  // light — filled pills: white on the state colour
  {
    id: 'light/white-on-ok-pill',
    scheme: 'light',
    fg: '#FFFFFF',
    bg: 'ok',
    ratio: 7.6,
    level: 'AAA',
  },
  {
    id: 'light/white-on-warn-pill',
    scheme: 'light',
    fg: '#FFFFFF',
    bg: 'warn',
    ratio: 7.48,
    level: 'AAA',
  },
  {
    id: 'light/white-on-danger-pill',
    scheme: 'light',
    fg: '#FFFFFF',
    bg: 'danger',
    ratio: 8.0,
    level: 'AAA',
  },
  {
    id: 'light/white-on-unknown-pill',
    scheme: 'light',
    fg: '#FFFFFF',
    bg: 'unknown',
    ratio: 9.2,
    level: 'AAA',
  },
  // dark — text on page and on surfaces
  { id: 'dark/text-on-bg', scheme: 'dark', fg: 'text', bg: 'bg', ratio: 16.59, level: 'AAA' },
  {
    id: 'dark/text-on-surface',
    scheme: 'dark',
    fg: 'text',
    bg: 'surface',
    ratio: 15.03,
    level: 'AAA',
  },
  { id: 'dark/muted-on-bg', scheme: 'dark', fg: 'muted', bg: 'bg', ratio: 7.45, level: 'AAA' },
  {
    id: 'dark/muted-on-surface',
    scheme: 'dark',
    fg: 'muted',
    bg: 'surface',
    ratio: 6.75,
    level: 'AA',
  },
  { id: 'dark/ok-on-bg', scheme: 'dark', fg: 'ok', bg: 'bg', ratio: 7.38, level: 'AAA' },
  { id: 'dark/ok-on-surface', scheme: 'dark', fg: 'ok', bg: 'surface', ratio: 6.68, level: 'AA' },
  { id: 'dark/warn-on-bg', scheme: 'dark', fg: 'warn', bg: 'bg', ratio: 7.94, level: 'AAA' },
  {
    id: 'dark/warn-on-surface',
    scheme: 'dark',
    fg: 'warn',
    bg: 'surface',
    ratio: 7.19,
    level: 'AAA',
  },
  { id: 'dark/danger-on-bg', scheme: 'dark', fg: 'danger', bg: 'bg', ratio: 7.53, level: 'AAA' },
  {
    id: 'dark/danger-on-surface',
    scheme: 'dark',
    fg: 'danger',
    bg: 'surface',
    ratio: 6.82,
    level: 'AA',
  },
  { id: 'dark/unknown-on-bg', scheme: 'dark', fg: 'unknown', bg: 'bg', ratio: 8.13, level: 'AAA' },
  {
    id: 'dark/unknown-on-surface',
    scheme: 'dark',
    fg: 'unknown',
    bg: 'surface',
    ratio: 7.36,
    level: 'AAA',
  },
  { id: 'dark/info-on-bg', scheme: 'dark', fg: 'info', bg: 'bg', ratio: 8.26, level: 'AAA' },
  {
    id: 'dark/info-on-surface',
    scheme: 'dark',
    fg: 'info',
    bg: 'surface',
    ratio: 7.48,
    level: 'AAA',
  },
  // dark — filled pills: the page background used as ink on the state colour
  // (light pills use white, which is that scheme's page background — the pairing
  // is "ink equals `--bg`" in both schemes, so one CSS rule serves both).
  { id: 'dark/ink-on-ok-pill', scheme: 'dark', fg: 'bg', bg: 'ok', ratio: 7.38, level: 'AAA' },
  { id: 'dark/ink-on-warn-pill', scheme: 'dark', fg: 'bg', bg: 'warn', ratio: 7.94, level: 'AAA' },
  {
    id: 'dark/ink-on-danger-pill',
    scheme: 'dark',
    fg: 'bg',
    bg: 'danger',
    ratio: 7.53,
    level: 'AAA',
  },
  {
    id: 'dark/ink-on-unknown-pill',
    scheme: 'dark',
    fg: 'bg',
    bg: 'unknown',
    ratio: 8.13,
    level: 'AAA',
  },
  // hairlines: decorative separators, never the sole channel for a state
  {
    id: 'light/border-on-bg',
    scheme: 'light',
    fg: 'border',
    bg: 'bg',
    ratio: 1.68,
    level: 'decorative',
  },
  {
    id: 'dark/border-on-bg',
    scheme: 'dark',
    fg: 'border',
    bg: 'bg',
    ratio: 1.61,
    level: 'decorative',
  },
];

/** WCAG 2.x relative luminance of a `#RRGGBB` colour. */
export function relativeLuminance(hex: string): number {
  const match = /^#([0-9a-fA-F]{6})$/.exec(hex);
  if (!match || match[1] === undefined) throw new Error(`tokens: '${hex}' is not a #RRGGBB colour`);
  const value = match[1];
  const channels = [0, 2, 4].map(
    (offset) => Number.parseInt(value.slice(offset, offset + 2), 16) / 255,
  );
  const linear = channels.map((channel) =>
    channel <= 0.03928 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4,
  );
  const [r, g, b] = linear as [number, number, number];
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

/** The WCAG contrast ratio between two colours (order-independent). */
export function contrastRatio(a: string, b: string): number {
  const first = relativeLuminance(a);
  const second = relativeLuminance(b);
  const lighter = Math.max(first, second);
  const darker = Math.min(first, second);
  return (lighter + 0.05) / (darker + 0.05);
}

export function paletteValue(palette: Palette, role: TokenRole | '#FFFFFF'): string {
  return role === '#FFFFFF' ? role : palette[role];
}

/**
 * The complete stylesheet: nine tokens, two schemes, one 4/8 scale, five sizes.
 * No `@import`, no `url()`, no webfont — zero network requests, so the page looks
 * identical offline and there is nothing to fail to load.
 */
export function stylesheet(): string {
  const s = SPACING;
  const px = (n: number): string => `${n}px`;
  return `
:root {
  color-scheme: light dark;
  --bg: ${LIGHT.bg}; --surface: ${LIGHT.surface}; --text: ${LIGHT.text};
  --muted: ${LIGHT.muted}; --border: ${LIGHT.border};
  --ok: ${LIGHT.ok}; --warn: ${LIGHT.warn}; --danger: ${LIGHT.danger};
  --unknown: ${LIGHT.unknown}; --info: ${LIGHT.info};
  --s1: ${px(s.s1)}; --s2: ${px(s.s2)}; --s3: ${px(s.s3)}; --s4: ${px(s.s4)};
  --s5: ${px(s.s5)}; --s6: ${px(s.s6)}; --s7: ${px(s.s7)}; --s8: ${px(s.s8)};
  --sans: ${FONTS.sans};
  --mono: ${FONTS.mono};
}
@media (prefers-color-scheme: dark) {
  :root {
    --bg: ${DARK.bg}; --surface: ${DARK.surface}; --text: ${DARK.text};
    --muted: ${DARK.muted}; --border: ${DARK.border};
    --ok: ${DARK.ok}; --warn: ${DARK.warn}; --danger: ${DARK.danger};
    --unknown: ${DARK.unknown}; --info: ${DARK.info};
  }
}
*, *::before, *::after { box-sizing: border-box; }
html { background: var(--bg); }
body {
  margin: 0 auto; padding: var(--s4); max-width: 900px;
  background: var(--bg); color: var(--text);
  font-family: var(--sans); font-size: ${px(TYPE.body.size)}; line-height: ${px(TYPE.body.lineHeight)};
  font-weight: ${TYPE.body.weight};
  overflow-wrap: anywhere;
}
h1 { font-size: ${px(TYPE.h1.size)}; line-height: ${px(TYPE.h1.lineHeight)}; font-weight: ${TYPE.h1.weight}; margin: 0; }
h2 {
  font-size: ${px(TYPE.h2.size)}; line-height: ${px(TYPE.h2.lineHeight)}; font-weight: ${TYPE.h2.weight};
  letter-spacing: .01em; text-transform: uppercase; margin: 0 0 var(--s3);
}
p { margin: 0 0 var(--s2); }
code, .mono { font-family: var(--mono); font-size: ${px(TYPE.mono.size)}; line-height: ${px(TYPE.mono.lineHeight)}; }
.meta { font-size: ${px(TYPE.meta.size)}; line-height: ${px(TYPE.meta.lineHeight)}; color: var(--muted); }
header { display: flex; flex-wrap: wrap; gap: var(--s2) var(--s4); align-items: baseline; justify-content: space-between; padding-bottom: var(--s3); border-bottom: 1px solid var(--border); }
section { padding: var(--s5) 0; border-bottom: 1px solid var(--border); }
footer { padding-top: var(--s4); color: var(--muted); font-size: ${px(TYPE.meta.size)}; }
ul { list-style: none; margin: 0; padding: 0; }
li + li { margin-top: var(--s4); }
.record { padding: var(--s3); background: var(--surface); border-left: 2px solid var(--border); }
.record__head { display: flex; flex-wrap: wrap; gap: var(--s2) var(--s3); align-items: baseline; }
.pill { font-family: var(--mono); font-size: ${px(TYPE.mono.size)}; white-space: normal; }
/* Filled state chips: the glyph and the word carry the meaning, the fill is the
   third, redundant channel. Ink is var(--bg), which is white in the light scheme and
   near-black in the dark one, so both pairings are documented in CONTRAST_PAIRS. */
.pill { display: inline-block; padding: 1px var(--s1); border-radius: 2px; }
.pill--ok { background: var(--ok); color: var(--bg); }
.pill--warn { background: var(--warn); color: var(--bg); }
.pill--danger { background: var(--danger); color: var(--bg); }
.pill--unknown { background: var(--unknown); color: var(--bg); }
.pill--muted { color: var(--muted); }
.cmd { color: var(--info); }
.banner { padding: var(--s4); margin-bottom: var(--s4); border: 1px solid var(--border); background: var(--surface); border-left-width: 4px; }
.banner--danger { border-left-color: var(--danger); }
.banner--warn { border-left-color: var(--warn); }
.health { padding: var(--s3) var(--s4); margin: var(--s4) 0; background: var(--surface); border-left: 4px solid var(--warn); }
.health--danger { border-left-color: var(--danger); }
.meter { display: flex; height: var(--s3); margin: var(--s2) 0; border: 1px solid var(--border); background: var(--bg); }
.meter__measured { background: var(--text); }
.meter__estimated { background: var(--muted); background-image: repeating-linear-gradient(45deg, var(--bg) 0 2px, transparent 2px 4px); }
.meter__gap { border-right: 1px dashed var(--muted); }
.meter__headroom { background: var(--bg); flex: 1; }
.answer { font-family: var(--mono); font-size: ${px(TYPE.mono.size)}; }
table { width: 100%; border-collapse: collapse; table-layout: auto; }
th, td { text-align: left; vertical-align: top; padding: var(--s1) var(--s2); border-bottom: 1px solid var(--border); }
th { font-size: ${px(TYPE.meta.size)}; font-weight: 600; color: var(--muted); }
td.num { font-family: var(--mono); font-size: ${px(TYPE.mono.size)}; }
a { color: var(--info); }
a:focus-visible { outline: 2px solid var(--text); outline-offset: 2px; }
`;
}
