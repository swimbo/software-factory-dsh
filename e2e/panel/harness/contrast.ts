/**
 * In-page colour maths for the contrast spec.
 *
 * The ratios are computed from **computed styles in a real browser**, not from the hex
 * constants: a token edit that breaks a pair has to fail here even when `tokens.ts` and
 * its unit test agree, because the thing an operator looks at is the rendered page.
 */
import type { Page } from '@playwright/test';

interface Rgba {
  readonly r: number;
  readonly g: number;
  readonly b: number;
  readonly a: number;
}

/** Parse `rgb(r, g, b)` / `rgba(r, g, b, a)` (the only forms `getComputedStyle` returns). */
function parse(value: string): Rgba {
  const numbers = (value.match(/-?\d+(?:\.\d+)?/gu) ?? []).map(Number);
  const [r = 0, g = 0, b = 0, a = 1] = numbers;
  return { r, g, b, a };
}

/** Composite a translucent colour over an opaque one, which is what the eye sees. */
function flatten(foreground: Rgba, background: Rgba): Rgba {
  const alpha = foreground.a;
  return {
    r: foreground.r * alpha + background.r * (1 - alpha),
    g: foreground.g * alpha + background.g * (1 - alpha),
    b: foreground.b * alpha + background.b * (1 - alpha),
    a: 1,
  };
}

function channel(value: number): number {
  const channelValue = value / 255;
  return channelValue <= 0.039_28 ? channelValue / 12.92 : ((channelValue + 0.055) / 1.055) ** 2.4;
}

function luminance(color: Rgba): number {
  return 0.2126 * channel(color.r) + 0.7152 * channel(color.g) + 0.0722 * channel(color.b);
}

/** WCAG 2.x contrast ratio, rounded to two decimals so an assertion can name a number. */
export function ratioOf(foreground: string, background: string): number {
  const fg = parse(foreground);
  const bg = parse(background);
  const opaqueBg = bg.a < 1 ? flatten(bg, { r: 255, g: 255, b: 255, a: 1 }) : bg;
  const opaqueFg = fg.a < 1 ? flatten(fg, opaqueBg) : fg;
  const lighter = Math.max(luminance(opaqueFg), luminance(opaqueBg));
  const darker = Math.min(luminance(opaqueFg), luminance(opaqueBg));
  return Math.round(((lighter + 0.05) / (darker + 0.05)) * 100) / 100;
}

export interface ComputedColours {
  /** The selector's `color`. */
  readonly color: string;
  /** The selector's `background-color`. */
  readonly background: string;
  /**
   * Each token resolved to the `rgb(...)` the browser would paint, keyed by name.
   * Resolving through an element rather than reading the custom property matters:
   * the declaration is hex (`#0b0d10`) and the maths needs a colour, not a string.
   */
  readonly tokens: Readonly<Record<string, string>>;
}

/** Read the computed foreground, background and palette tokens for one element. */
export async function computedColours(
  page: Page,
  selector: string,
  tokens: readonly string[],
): Promise<ComputedColours> {
  return page.evaluate(
    ({ selector: target, tokens: names }) => {
      const element = document.querySelector(target);
      if (element === null) throw new Error(`no element matches ${target}`);
      const style = getComputedStyle(element);
      const probe = document.createElement('div');
      document.body.appendChild(probe);
      const resolved: Record<string, string> = {};
      for (const name of names) {
        // A custom property is text; `color: var(--x)` is the computed colour.
        probe.style.color = `var(--${name})`;
        resolved[name] = probe.style.color === '' ? '' : getComputedStyle(probe).color;
      }
      probe.remove();
      return {
        color: style.color,
        background: style.backgroundColor,
        tokens: resolved,
      };
    },
    { selector, tokens },
  );
}
