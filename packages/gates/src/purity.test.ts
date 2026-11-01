/**
 * The gates package reads its own source: no transport, one clock, no ambient state.
 *
 * The rule from `findings.md > TD9` is that a decision must be reproducible, and the way a
 * decision stops being reproducible is that something in the path picked up an ambient
 * dependency — a socket, a random number, an environment variable. A comment cannot prove
 * the absence of those, so this test opens every shipped module and checks the text.
 *
 * The one exception is stated rather than hidden: a credential TTL has to be anchored to
 * *some* clock, so `readWallClock` exists and this test pins the number of clock reads to
 * exactly one, in exactly one file. Everything else takes the time as a parameter.
 *
 * This file's own text is scanned too — the rule is a property of the directory, not of the
 * modules someone thought to list.
 */
import { readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const DIR = fileURLToPath(new URL('.', import.meta.url));
const ALL_FILES = readdirSync(DIR)
  .filter((name) => name.endsWith('.ts'))
  .sort();
const SOURCES = ALL_FILES.filter((name) => !name.endsWith('.test.ts'));

function text(name: string): string {
  return readFileSync(new URL(name, `file://${DIR}`), 'utf8');
}

function importSpecifiers(source: string): readonly string[] {
  const pattern = /(?:from\s+|import\s+)'([^']+)'/g;
  const found: string[] = [];
  for (const match of source.matchAll(pattern)) {
    const specifier = match[1];
    if (specifier !== undefined) found.push(specifier);
  }
  return found;
}

const OWN_FILE = /^\.\/[a-z0-9-]+\.ts$/;
const CONTRACTS = '@factory/contracts';
/** The two standard modules a gate is allowed: hashing/signatures, and the artifact write. */
const ALLOWED_STDLIB = ['node:crypto', 'node:fs', 'node:path'];

describe('the package is exactly the gates it claims', () => {
  it('ships the three gates, the shared decision module, the signer and the barrel', () => {
    expect(SOURCES).toEqual([
      'budget.ts',
      'credentials.ts',
      'decision.ts',
      'index.ts',
      'promotion.ts',
      'signing.ts',
    ]);
  });

  it('has a test for each gate', () => {
    expect(ALL_FILES).toContain('promotion.test.ts');
    expect(ALL_FILES).toContain('budget.test.ts');
    expect(ALL_FILES).toContain('credentials.test.ts');
    expect(ALL_FILES).toContain('signing.test.ts');
    expect(ALL_FILES).toContain('purity.test.ts');
  });
});

describe('no transport, no model, no ambient state', () => {
  it('imports only the contract package, its own modules and the two allowed stdlib modules', () => {
    for (const name of SOURCES) {
      for (const specifier of importSpecifiers(text(name))) {
        const allowed =
          specifier === CONTRACTS ||
          OWN_FILE.test(specifier) ||
          (ALLOWED_STDLIB as readonly string[]).includes(specifier);
        if (!allowed) {
          throw new Error(
            `${name} imports ${JSON.stringify(specifier)}, which is not an allowed module`,
          );
        }
      }
    }
  });

  it.each([
    { label: 'an outbound transport module', needle: 'node:' + 'ht' + 'tp' },
    { label: 'a socket module', needle: 'node:' + 'ne' + 't' },
    { label: 'a tls module', needle: 'node:tls' },
    { label: 'a dns module', needle: 'node:dns' },
    { label: 'an http client library', needle: 'und' + 'ici' },
    { label: 'a promise http client', needle: 'axi' + 'os' },
    { label: 'a model vendor sdk', needle: 'open' + 'ai' },
    { label: 'a model vendor sdk', needle: 'anthro' + 'pic' },
    { label: 'the harness package', needle: '@deep' + 'seek' },
    { label: 'a child process', needle: 'node:child_process' },
  ])('never imports $label', ({ needle }) => {
    const offenders = SOURCES.filter((name) =>
      importSpecifiers(text(name)).some((specifier) => specifier === needle),
    );
    expect(offenders).toEqual([]);
  });

  it('reads no environment variable', () => {
    const needle = 'process.' + 'env';
    expect(ALL_FILES.filter((name) => text(name).includes(needle))).toEqual([]);
  });

  it('draws no random number', () => {
    for (const needle of ['Math.' + 'random', 'random' + 'UUID', 'random' + 'Bytes']) {
      expect(ALL_FILES.filter((name) => text(name).includes(needle))).toEqual([]);
    }
  });

  it('stubs nothing, so no test can fake a gate decision', () => {
    const needle = 'vi.' + 'mock';
    expect(ALL_FILES.filter((name) => text(name).includes(needle))).toEqual([]);
  });
});

describe('exactly one clock read, in exactly one file', () => {
  it('has a single bare date construction across all sources', () => {
    const bare = 'new ' + 'Date()';
    const offenders = SOURCES.filter((name) => text(name).includes(bare));
    expect(offenders).toEqual(['decision.ts']);
    // One occurrence, inside `readWallClock`.
    const occurrences = text('decision.ts').split(bare).length - 1;
    expect(occurrences).toBe(1);
    expect(text('decision.ts')).toContain('export function readWallClock');
  });

  it('never reads the system clock through the epoch', () => {
    const needle = 'Date.' + 'now(';
    expect(ALL_FILES.filter((name) => text(name).includes(needle))).toEqual([]);
  });

  it('takes the time as a parameter everywhere else', () => {
    // Every gate exposes `nowIso` in its input, and the credential gate is explicit about it.
    expect(text('credentials.ts')).toContain('nowIso');
    expect(text('budget.ts')).toContain('nowIso');
  });
});
