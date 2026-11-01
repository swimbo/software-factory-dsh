#!/usr/bin/env -S node --experimental-strip-types
/**
 * `wall` — the operator's handle on the verification gate.
 *
 * One command so far, and it is the honest one: `self-test` runs the adversarial
 * corpus against the wall itself and exits non-zero if any declared expectation is
 * unmet. A verification system that cannot fail its own audit is a verification
 * system nobody has tried to fool.
 *
 * This file is the *only* place in the package allowed to touch a process, an exit
 * code or a terminal. `evaluate()` decides; the CLI reports. Keeping them apart is
 * what lets the decision be tested without spawning anything.
 */
import { existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { formatSelfTestReport, runSelfTest } from './selftest.ts';

const USAGE = `wall — verification gate for the software factory

usage:
  wall self-test [--corpus=<dir>]   run the adversarial corpus against this wall

  The corpus declares, per sabotage, the verdict it must produce. Exit codes:
    0  every expectation met
    1  an expectation was unmet — the wall is weaker than it claims
    2  usage error (bad command, missing corpus)

  Nothing else is exposed here yet: signing is done by the executor with keys under
  ~/.factory/keys, and the key path is never an argument to the wall's decision.`;

/** `<package>/tests/corpus`, resolved from this module rather than from the caller's cwd. */
export function defaultCorpusDir(): string {
  return join(dirname(fileURLToPath(import.meta.url)), '..', 'tests', 'corpus');
}

export function parseCorpusArg(
  argv: readonly string[],
): { readonly dir: string } | { readonly error: string } {
  const flag = argv.find((arg) => arg.startsWith('--corpus='));
  if (flag === undefined) return { dir: defaultCorpusDir() };
  const value = flag.slice('--corpus='.length);
  if (value.trim() === '') return { error: '--corpus= needs a directory' };
  return { dir: resolve(value) };
}

/** Returns the process exit code; never calls `process.exit`, so output is never truncated. */
export async function main(argv: readonly string[]): Promise<number> {
  const [command, ...rest] = argv;

  if (command === undefined) {
    console.error(USAGE);
    return 2;
  }
  if (command === '--help' || command === '-h' || command === 'help') {
    console.log(USAGE);
    return 0;
  }
  if (command !== 'self-test') {
    console.error(`unknown command: ${command}`);
    console.error(USAGE);
    return 2;
  }

  const corpus = parseCorpusArg(rest);
  if ('error' in corpus) {
    console.error(corpus.error);
    return 2;
  }
  if (!existsSync(corpus.dir)) {
    console.error(`corpus directory not found: ${corpus.dir}`);
    return 2;
  }

  const report = await runSelfTest(corpus.dir);
  console.log(formatSelfTestReport(report));
  return report.ok ? 0 : 1;
}

const invokedDirectly =
  process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url);

if (invokedDirectly) {
  main(process.argv.slice(2))
    .then((code) => {
      process.exitCode = code;
    })
    .catch((error: unknown) => {
      console.error(error instanceof Error ? (error.stack ?? error.message) : String(error));
      process.exitCode = 2;
    });
}
