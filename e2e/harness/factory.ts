/**
 * The process-level harness: spawn the real `factory` binary and read what it left behind.
 *
 * Every call is a separate OS process — that is the whole point. The e2e layer asserts exit
 * codes, the two streams and on-disk effects, none of which an in-process import can prove.
 *
 * Three environment facts are fixed here rather than left to chance:
 *
 *   - `FACTORY_HOME` always points at a fresh `mkdtemp` directory, so no test can see the
 *     operator's real store;
 *   - `PATH` never contains a `dsh` binary, and `DSH_BIN` is unset: "no harness installed" is
 *     the default condition, and the `run` refusal (exit 8 + runbook) is the honest assertion
 *     of it. A spec that needs a dsh supplies its own stub;
 *   - no model credential is present, because the suite must pass without one.
 */
import { spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

/** The binary under test: the CLI entry point, run through the same runtime as the suite. */
export const CLI_MAIN = fileURLToPath(new URL('../../apps/cli/src/main.ts', import.meta.url));

/** Node's own directory plus the POSIX defaults; deliberately no `dsh`. */
export const NO_DSH_PATH = [
  dirname(process.execPath),
  '/usr/bin',
  '/bin',
  '/usr/sbin',
  '/sbin',
].join(delimiter);

export interface FactoryRun {
  readonly args: readonly string[];
  readonly code: number;
  readonly stdout: string;
  readonly stderr: string;
}

export interface RunOptions {
  readonly home?: string;
  readonly env?: Readonly<Record<string, string | undefined>>;
  readonly path?: string;
  readonly cwd?: string;
  readonly timeoutMs?: number;
}

export function newFactoryHome(prefix = 'factory-e2e-home-'): string {
  return mkdtempSync(join(tmpdir(), prefix));
}

/** Deterministic bytes: no ANSI, no spinner, no TTY-dependent colour. */
export function baseEnv(home: string, options: RunOptions = {}): Record<string, string> {
  const path = options.path ?? NO_DSH_PATH;
  const env: Record<string, string> = {
    PATH: path,
    FACTORY_HOME: home,
    TERM: 'dumb',
    NO_COLOR: '1',
  };
  for (const [key, value] of Object.entries(options.env ?? {})) {
    if (value === undefined) delete env[key];
    else env[key] = value;
  }
  return env;
}

export function runFactory(args: readonly string[], options: RunOptions = {}): FactoryRun {
  const home = options.home ?? newFactoryHome();
  const result = spawnSync(process.execPath, [CLI_MAIN, ...args], {
    encoding: 'utf8',
    timeout: options.timeoutMs ?? 60_000,
    ...(options.cwd === undefined ? {} : { cwd: options.cwd }),
    env: baseEnv(home, options),
  });
  return {
    args,
    code: result.status ?? -1,
    stdout: result.stdout ?? '',
    stderr: result.stderr ?? '',
  };
}

/**
 * The `--json` contract: exactly one object on stdout, ever.
 *
 * Returning the parse rather than a boolean means a broken contract fails as a parse error
 * with the offending streams attached, instead of as a confusing assertion two lines later.
 */
export function jsonOf(run: FactoryRun): Record<string, unknown> {
  const lines = run.stdout
    .trim()
    .split('\n')
    .filter((line) => line.length > 0);
  if (lines.length !== 1) {
    throw new Error(
      `--json printed ${String(lines.length)} line(s) on stdout, expected exactly 1\n` +
        `args: ${run.args.join(' ')}\nstdout:\n${run.stdout}\nstderr:\n${run.stderr}`,
    );
  }
  return JSON.parse(lines[0] ?? '{}') as Record<string, unknown>;
}

export interface SpecShape {
  readonly [key: string]: unknown;
}

/** A spec the qualifier scores without a structural refusal; overrides replace whole keys. */
export function specFor(overrides: SpecShape = {}): SpecShape {
  return {
    slug: 'slug-check',
    revision: 1,
    repo: 'fixture',
    baseRev: 'a'.repeat(40),
    intent:
      'Add a slug-uniqueness check on the read path so duplicate slugs are rejected before insert.',
    restateBack:
      'You asked for: a slug uniqueness check on the read path, proven by a unit test. Not asking for: a schema migration.',
    acceptance: [
      {
        id: 'suite-green',
        text: 'node --test tests/ exits 0',
        oracle: { kind: 'command', target: 'node --test tests/', expect: 'exit 0' },
      },
    ],
    touchPaths: ['src/slug.js', 'tests/slug.test.js'],
    operationClasses: ['code-change'],
    sizeBudget: { files: 8, lines: 200 },
    budgetEstimateUsd: 0.71,
    ...overrides,
  };
}

export function writeJsonFile(dir: string, name: string, value: unknown): string {
  const path = join(dir, name);
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`);
  return path;
}

export function writeTextFile(dir: string, name: string, text: string): string {
  const path = join(dir, name);
  writeFileSync(path, text.endsWith('\n') ? text : `${text}\n`);
  return path;
}

/** Submit one unit and return its id; fails the calling spec if `intent` refuses. */
export function submitUnit(
  home: string,
  options: RunOptions & { readonly spec?: SpecShape } = {},
): { unitId: string; run: FactoryRun } {
  const spec = options.spec ?? specFor();
  const specPath = writeJsonFile(home, 'spec.json', spec);
  const restatePath = writeTextFile(home, 'restate.md', String(spec['restateBack'] ?? ''));
  const run = runFactory(['intent', '--file', specPath, '--restate', restatePath, '--json'], {
    home,
    ...options,
  });
  const json = jsonOf(run);
  if (run.code !== 0 || typeof json['unitId'] !== 'string') {
    throw new Error(`intent refused (exit ${String(run.code)}):\n${run.stderr}\n${run.stdout}`);
  }
  return { unitId: json['unitId'], run };
}

/** A `status --json` payload, parsed — the canonical read of what the store holds. */
export function statusJson(home: string, options: RunOptions = {}): Record<string, unknown> {
  const run = runFactory(['status', '--json'], { home, ...options });
  return jsonOf(run);
}

/** Every unit the store knows, in submission order. */
export function units(home: string, options: RunOptions = {}): readonly Record<string, unknown>[] {
  const json = statusJson(home, options);
  const list = json['units'];
  return Array.isArray(list) ? (list as Record<string, unknown>[]) : [];
}
