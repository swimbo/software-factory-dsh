/**
 * Text primitives, and the one place that decides whether a glyph may be printed.
 *
 * `ux-plan.md` §6.1 is normative here: every state is a **word** in a fixed
 * column, colour is never the only channel, `--plain` emits zero ANSI bytes and
 * no glyphs, and no line exceeds 80 columns. So the state markers below have two
 * spellings — one for a rich terminal, one ASCII — and every renderer asks this
 * module rather than hard-coding a check mark.
 */

/** Heroku's guide, adopted by §6.1: long paths wrap, they are never truncated. */
export const WIDTH = 80;

const SEP = '·';

export function usd(amount: number): string {
  return `$${amount.toFixed(2)}`;
}

/**
 * Estimated spend is always marked as such (§7 A-2): the factory has no
 * billing-grade telemetry, so a bare number would be a claim it cannot support.
 */
export function usdEstimated(amount: number): string {
  return `~${usd(amount)} estimated`;
}

export function sep(): string {
  return SEP;
}

export interface Marker {
  readonly glyph: string;
  readonly word: string;
}

const PASS = { rich: '✓', plain: '+' } as const;
const FAIL = { rich: '×', plain: 'x' } as const;

/** A pass/fail marker as `✓` (rich) or `+` (plain) — never the only channel. */
export function mark(pass: boolean, plain: boolean): string {
  if (pass) return plain ? PASS.plain : PASS.rich;
  return plain ? FAIL.plain : FAIL.rich;
}

/**
 * The pill for a verdict or unit state. Colour lives only in `paint`; the word
 * is always present and always uppercase, so a screen reader hears the state.
 */
export function pill(
  state: 'passed' | 'failed' | 'unknown' | 'ambiguous' | 'rejected' | 'blocked',
  plain: boolean,
): string {
  switch (state) {
    case 'passed':
      return `[${plain ? '+' : '✓'}] PASSED`;
    case 'failed':
      return `[${plain ? 'x' : '×'}] FAILED`;
    case 'unknown':
      return '[?] UNKNOWN';
    case 'ambiguous':
      return '[?] AMBIGUOUS';
    case 'rejected':
      return `[${plain ? '-' : '—'}] REJECTED`;
    case 'blocked':
      return '[!] BLOCKED';
  }
}

export function wrap(text: string, indent = 0, width = WIDTH): string[] {
  const prefix = ' '.repeat(indent);
  const room = Math.max(width - indent, 20);
  const words = text.split(/\s+/u).filter((word) => word.length > 0);
  const lines: string[] = [];
  let current = '';
  for (const word of words) {
    if (current.length === 0) {
      current = word;
      continue;
    }
    if (current.length + 1 + word.length <= room) {
      current = `${current} ${word}`;
      continue;
    }
    lines.push(prefix + current);
    current = word;
  }
  if (current.length > 0) lines.push(prefix + current);
  return lines.length === 0 ? [prefix] : lines;
}

/** `label   value` with the value starting at a fixed column. */
export function field(label: string, value: string, column = 18): string {
  const padded = label.length >= column ? `${label} ` : label.padEnd(column);
  return `${padded}${value}`;
}

/** A continuation-indented wrapped paragraph, for long paths and reasons. */
export function paragraph(text: string, indent: number, column = indent): string[] {
  return wrap(text, indent).map((line, index) =>
    index === 0 ? line : `${' '.repeat(column)}${line.trimStart()}`,
  );
}

/**
 * Records are separated by exactly one blank line (§6.1): a screen reader pauses
 * on the blank line, and a human sees the boundaries without box drawing.
 */
export function record(lines: readonly string[]): string {
  return `${lines.join('\n')}\n`;
}

export function indent(lines: readonly string[], spaces = 2): string[] {
  const prefix = ' '.repeat(spaces);
  return lines.map((line) => (line.length === 0 ? line : `${prefix}${line}`));
}

/** An identity hash, abbreviated for display only; the full value is in `--json` and on the next line. */
export function shortHash(version: string): string {
  const body = version.startsWith('sha256:') ? version.slice('sha256:'.length) : version;
  return `sha256:${body.slice(0, 8)}…`;
}

export function isWide(line: string): boolean {
  return line.length > WIDTH;
}
