/**
 * The command `scripts/type-repair-artifacts.sh` runs.
 *
 * Deliberately dumb, and deliberately the same shape as `test-repair-artifacts-main.ts`: it parses
 * four flags, calls `materializeTypeRepairArtifacts`, prints the environment the loop needs, and
 * exits. Everything that can be wrong about the artefacts — the corpus, the rules, the commits, a
 * revision whose strict errors are not genuine — is refused inside the library, where the spec can
 * call it; this file is the part a shell can reach.
 *
 * `--created-at` is passed in rather than read here: reading the clock is forbidden outside allowlisted
 * clock sites (discipline-lint), and a build whose only source of time is its caller is a build that is
 * the same every time it is replayed.
 */
import { readFileSync } from 'node:fs';

import type { TypeRepairArtefacts } from './type-repair-artifacts.ts';
import {
  DEFAULT_REVISIONS,
  materializeTypeRepairArtifacts,
  sourceCommit,
} from './type-repair-artifacts.ts';

interface Flags {
  readonly root: string;
  readonly source: string;
  readonly revisions: number;
  readonly createdAt: string | undefined;
  readonly sourceCommit: string | undefined;
}

const USAGE =
  'USAGE: type-repair-artifacts-main.ts --root <dir> --source <checkout> [--revisions <n>] ' +
  '[--created-at <iso>] [--source-commit <sha>]';

function fail(message: string, code: number): never {
  process.stderr.write(`type-repair-artifacts: ${message}\n`);
  process.exit(code);
}

function flagValue(argv: readonly string[], position: number, name: string): string {
  const value = argv[position];
  if (value === undefined || value.startsWith('--')) fail(`${name} needs a value\n${USAGE}`, 2);
  return value;
}

function parseFlags(argv: readonly string[]): Flags {
  let root: string | undefined;
  let source: string | undefined;
  let revisions: number | undefined;
  let createdAt: string | undefined;
  let commit: string | undefined;
  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index];
    switch (flag) {
      case '--root':
        root = flagValue(argv, index + 1, '--root');
        index += 1;
        break;
      case '--source':
        source = flagValue(argv, index + 1, '--source');
        index += 1;
        break;
      case '--revisions': {
        const raw = flagValue(argv, index + 1, '--revisions');
        if (!/^\d+$/u.test(raw)) fail(`--revisions must be a positive integer, got ${raw}`, 2);
        revisions = Number(raw);
        index += 1;
        break;
      }
      case '--created-at':
        createdAt = flagValue(argv, index + 1, '--created-at');
        index += 1;
        break;
      case '--source-commit':
        commit = flagValue(argv, index + 1, '--source-commit');
        index += 1;
        break;
      case '--help':
      case '-h':
        process.stdout.write(`${USAGE}\n`);
        process.exit(0);
      default:
        fail(`unknown argument: ${String(flag)}\n${USAGE}`, 2);
    }
  }
  if (root === undefined) fail(`--root is required\n${USAGE}`, 2);
  if (source === undefined) fail(`--source is required\n${USAGE}`, 2);
  return {
    root,
    source,
    revisions: revisions ?? DEFAULT_REVISIONS,
    createdAt,
    sourceCommit: commit ?? sourceCommit(source),
  };
}

function main(): number {
  const flags = parseFlags(process.argv.slice(2));
  let artefacts: TypeRepairArtefacts;
  try {
    artefacts = materializeTypeRepairArtifacts({
      root: flags.root,
      sourceRoot: flags.source,
      revisions: flags.revisions,
      ...(flags.createdAt === undefined ? {} : { createdAt: flags.createdAt }),
      ...(flags.sourceCommit === undefined ? {} : { sourceCommit: flags.sourceCommit }),
    });
  } catch (error) {
    fail(error instanceof Error ? error.message : String(error), 1);
  }
  // The environment is written by the library as `env.sh`, and printed here from that file rather
  // than rebuilt: two copies of the variable list is how a runbook and a script drift.
  const env = readFileSync(artefacts.envPath, 'utf8').trimEnd();
  process.stdout.write(
    `\n# Certification artefacts at ${artefacts.root}\n` +
      `# Paste this block (it is ${artefacts.envPath}), then run ${artefacts.planUnitsPath}.\n\n` +
      `${env}\n\n`,
  );
  process.stdout.write(
    `type-repair-artifacts: ${String(artefacts.units.length)} revision(s), ` +
      `corpus ${artefacts.corpusId}\n`,
  );
  process.stdout.write(`type-repair-artifacts: next: bash ${artefacts.planUnitsPath}\n`);
  return 0;
}

process.exit(main());
