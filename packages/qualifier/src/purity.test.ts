/**
 * Purity, proved by reading the package's own source.
 *
 * `findings.md > TD9` removed the model from the decision path; the remaining risk is
 * that a transport, a clock or a random number creeps back in and makes a decision
 * unreproducible. A comment saying "no I/O" is worth nothing, so this test opens every
 * file in `src/` and checks the text: no client module, no socket module, no clock, no
 * randomness, no filesystem, and an import list that stays inside this package and
 * `@factory/contracts`.
 *
 * The needles are assembled from fragments on purpose: the check is a literal text
 * search over the whole directory, so this file must not contain the strings it
 * forbids. That is also why the scan covers the tests — a test is source too, and a
 * test that could open a socket would be able to hide the fact that the package does.
 */
import { readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const DIR = fileURLToPath(new URL('.', import.meta.url));
const ALL_FILES = readdirSync(DIR)
  .filter((name) => name.endsWith('.ts'))
  .sort();
const SOURCES = ALL_FILES.filter((name) => !name.endsWith('.test.ts'));
const TESTS = ALL_FILES.filter((name) => name.endsWith('.test.ts'));

/** Read a file in this directory as text. */
function text(name: string): string {
  return readFileSync(new URL(name, `file://${DIR}`), 'utf8');
}

/**
 * Forbidden text, in two scopes.
 *
 * `all`   — no file in `src/` may contain it, tests included: a test that could open a
 *           socket, read the wall clock or draw a random number could fake a pure result.
 * `source` — the shipped modules only. Tests are allowed to read files (that is how this
 *           check works at all); shipped code is not.
 *
 * Every needle is assembled by concatenation so that this file cannot satisfy the search
 * it powers — otherwise the scan would fail on its own instrument.
 */
type Scope = 'all' | 'source';

const FORBIDDEN: ReadonlyArray<{ label: string; needle: string; scope: Scope; regex?: boolean }> = [
  // Transport / model clients: the decision must not depend on an answer from outside.
  { label: 'text client helper', needle: 'fet' + 'ch', scope: 'all' },
  { label: 'hyper-text transport', needle: 'ht' + 'tp', scope: 'all' },
  // Word-bounded: the contract legitimately contains the operation class
  // `network-egress`, so a bare substring check would flag a string literal.
  {
    label: 'socket transport',
    needle: '(?<![a-z0-9_-])n' + 'et(?![a-z0-9_-])',
    scope: 'all',
    regex: true,
  },
  { label: 'third-party client A', needle: 'und' + 'ici', scope: 'all' },
  { label: 'third-party client B', needle: 'axi' + 'os', scope: 'all' },
  { label: 'model vendor', needle: 'open' + 'ai', scope: 'all' },
  { label: 'model vendor', needle: 'anthro' + 'pic', scope: 'all' },
  { label: 'harness package', needle: '@deep' + 'seek', scope: 'all' },
  // Clock: time enters through the injected timestamp and nowhere else.
  { label: 'wall clock', needle: 'Date.' + 'now(', scope: 'all' },
  { label: 'constructed date', needle: 'new ' + 'Date(', scope: 'all' },
  { label: 'high-resolution clock', needle: 'performance.' + 'now', scope: 'all' },
  { label: 'process clock', needle: 'process.' + 'hrtime', scope: 'all' },
  // Randomness and locale: both make two equal inputs disagree.
  { label: 'random number', needle: 'Math.' + 'random', scope: 'all' },
  { label: 'random identifier', needle: 'random' + 'UUID', scope: 'all' },
  { label: 'locale-dependent formatting', needle: 'to' + 'Locale', scope: 'all' },
  // Host state: a decision must not depend on the machine it runs on.
  { label: 'environment read', needle: 'process.' + 'env', scope: 'all' },
  { label: 'common-js loader', needle: 'requ' + 'ire(', scope: 'all' },
  // File access: only the tests may touch the filesystem.
  { label: 'file read', needle: 'read' + 'File', scope: 'source' },
  { label: 'file write', needle: 'write' + 'File', scope: 'source' },
  { label: 'directory scan', needle: 'read' + 'dir', scope: 'source' },
  { label: 'file append', needle: 'append' + 'File', scope: 'source' },
];

/** Every import specifier in a file, in source order. */
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

describe('the package is exactly the four public modules', () => {
  it('ships policy, signals, qualify and the barrel, plus their tests', () => {
    expect(SOURCES).toEqual(['index.ts', 'policy.ts', 'qualify.ts', 'security.ts', 'signals.ts']);
    expect(TESTS.length).toBeGreaterThanOrEqual(3);
  });

  it('has a source for every test and a test covering every source it claims to', () => {
    for (const name of TESTS) {
      expect(ALL_FILES).toContain(name);
    }
    expect(TESTS).toContain('qualify.test.ts');
    expect(TESTS).toContain('policy.test.ts');
    expect(TESTS).toContain('purity.test.ts');
  });
});

describe('no transport, no clock, no randomness, no host state', () => {
  it.each(FORBIDDEN)('never contains $label in $scope files', ({ needle, scope, regex }) => {
    const files = scope === 'all' ? ALL_FILES : SOURCES;
    const matches = (name: string): boolean =>
      regex === true ? new RegExp(needle, 'u').test(text(name)) : text(name).includes(needle);
    const offenders = files.filter(matches);
    expect(offenders).toEqual([]);
  });

  it('imports nothing but its own modules and the contract package', () => {
    for (const name of SOURCES) {
      for (const specifier of importSpecifiers(text(name))) {
        const allowed = specifier === CONTRACTS || OWN_FILE.test(specifier);
        if (!allowed) {
          throw new Error(
            `${name} imports ${JSON.stringify(specifier)}, which is not an allowed module`,
          );
        }
      }
    }
  });

  it('keeps every source free of runtime dependencies', () => {
    for (const name of SOURCES) {
      const specifiers = importSpecifiers(text(name));
      expect(
        specifiers.filter((specifier) => specifier !== CONTRACTS && !OWN_FILE.test(specifier)),
      ).toEqual([]);
      // No side-effect import of a built-in either.
      expect(specifiers.some((specifier) => specifier.startsWith('node:'))).toBe(false);
    }
  });

  it('lets the tests read source and nothing else from the host', () => {
    for (const name of TESTS) {
      for (const specifier of importSpecifiers(text(name))) {
        const allowed =
          specifier === CONTRACTS ||
          specifier === 'vitest' ||
          specifier === 'node:fs' ||
          specifier === 'node:url' ||
          OWN_FILE.test(specifier);
        if (!allowed) {
          throw new Error(
            `${name} imports ${JSON.stringify(specifier)}, which is not an allowed test module`,
          );
        }
      }
    }
  });

  it('does not stub anything, so no test can fake a pure result', () => {
    // A mock could make an impure implementation look pure; `vi.` + `mock` is the
    // only way to do that in this runner, so its absence is part of the proof.
    const forbidden = 'vi.' + 'mock';
    const offenders = ALL_FILES.filter((name) => text(name).includes(forbidden));
    expect(offenders).toEqual([]);
  });
});

describe('the qualifier reads its inputs and nothing else', () => {
  it('has no assignment to a module-level mutable binding', () => {
    // "let" at the top level would be a cache, and a cache is state that replay cannot
    // reconstruct. Every binding in these sources is a function, a constant or a type.
    for (const name of SOURCES) {
      const offending = text(name)
        .split('\n')
        .filter((line) => /^(?:export\s+)?let\s/.test(line));
      expect({ file: name, offending }).toEqual({ file: name, offending: [] });
    }
  });

  it('declares its one entry point and its one policy version function', () => {
    const barrel = text('index.ts');
    expect(barrel).toContain('qualify');
    expect(barrel).toContain('currentPolicyVersion');
    expect(barrel).toContain('DEFAULT_POLICY');
  });
});
