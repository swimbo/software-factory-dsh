/**
 * Materialise the *persistent* artefacts for the task class `import-hygiene`: a twenty-commit source
 * repository, the bare mirror the wall clones, the four-rule holdout corpus, twenty unit specs, and a
 * planner that submits them.
 *
 * This is the `import-hygiene` counterpart of `artifacts-main.ts` (which builds the docs class): same
 * contract, different class. It never calls a model, never reads a credential and never writes a store,
 * so building it is free and repeatable. The planner is *emitted* as `<root>/plan-units.sh`, not run,
 * because submitting a unit writes the ledger.
 *
 * It refuses three things, and each refusal is a certificate claim rather than tidiness:
 *
 * 1. a root inside the checkout — a corpus inside the repository is a corpus the worker can read;
 * 2. a non-empty directory it did not build — it replaces its own artefacts, nothing else;
 * 3. finishing if a planted base revision stops breaking all four rules, because a corpus that passes
 *    a defective tree certifies nothing.
 */
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, sep } from 'node:path';

import {
  brokenTree,
  fixedTree,
  HOLDOUT_REVISION,
  REPO_ID,
  runRules,
  TASK_CLASS,
  writeHoldoutCorpus,
  writeTree,
} from './import-substrate.ts';

/** The marker that makes a root rebuildable — and that a stranger's directory is not. */
export const MARKER = 'import-hygiene-artifacts.json';

export const INTENT =
  'Repair the source tree: every relative import carries its .ts extension, type-only symbols are ' +
  'imported with import type, and no enum or export = remains, so node can load every source file.';

export const RESTATE =
  'You asked for: repair the source tree — every relative import carries its .ts extension, ' +
  'type-only symbols are imported with import type, and no enum or export = remains, so node can ' +
  'load every source file. Not asking for: a behaviour change or a dependency upgrade.';

export interface ImportArtifactsOptions {
  readonly root: string;
  readonly revisions: number;
  /** The checkout this script lives in, used only to refuse a root inside it. */
  readonly source: string;
  readonly createdAt: string;
}

export interface ImportArtifacts {
  readonly root: string;
  readonly repo: string;
  readonly mirror: string;
  readonly holdoutRoot: string;
  readonly revisionDir: string;
  readonly baseRevs: readonly string[];
  readonly specPaths: readonly string[];
  readonly unitsFile: string;
  readonly planScript: string;
}

function git(cwd: string, args: readonly string[]): string {
  return execFileSync('git', args, {
    cwd,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  }).trim();
}

function specFor(revision: number, baseRev: string): string {
  return `${JSON.stringify(
    {
      slug: TASK_CLASS,
      revision,
      repo: REPO_ID,
      baseRev,
      intent: INTENT,
      restateBack: RESTATE,
      acceptance: [
        {
          id: 'check-imports',
          text: 'node tools/check-imports.mjs exits 0',
          oracle: { kind: 'command', target: 'node tools/check-imports.mjs', expect: 'exit 0' },
        },
      ],
      touchPaths: ['src/'],
      operationClasses: ['code-change'],
      sizeBudget: { files: 8, lines: 200 },
      budgetEstimateUsd: 0.05,
    },
    null,
    2,
  )}\n`;
}

const planUnitsScript = (checkout: string): string => `#!/usr/bin/env bash
#
# Submit and qualify the ${TASK_CLASS} units against $FACTORY_HOME.
#
# This script is emitted rather than run by the artefacts build: submitting a unit writes the ledger,
# and building artefacts has to stay a free, repeatable operation. Run it yourself, once, against the
# store you intend to certify. It calls the checkout's own CLI, named here at build time so the run
# cannot pick up a different one from its working directory.
#
#   FACTORY_HOME=<root>/home FACTORY_REPO=${REPO_ID} bash <root>/plan-units.sh
#
set -uo pipefail
ROOT="$(cd "$(dirname "\${BASH_SOURCE[0]}")" && pwd)"
CHECKOUT='${checkout}'
NODE_BIN="\${PLAN_NODE_BIN:-node}"
[ -n "\${FACTORY_HOME:-}" ] || { echo "plan-units: FACTORY_HOME is not set" >&2; exit 2; }
[ -n "\${FACTORY_REPO:-}" ] || { echo "plan-units: FACTORY_REPO is not set" >&2; exit 2; }
: > "\${ROOT}/units.txt"
for spec in "\${ROOT}"/spec-*.json; do
  unitId="$("\${NODE_BIN}" "\${CHECKOUT}/apps/cli/src/main.ts" intent --file "\${spec}" --restate "\${ROOT}/restate.md" --json 2>/dev/null |
    "\${NODE_BIN}" --input-type=module -e 'let raw="";for await (const c of process.stdin) raw+=c;process.stdout.write(JSON.parse(raw).unitId)')"
  [ -n "\${unitId}" ] || { echo "plan-units: \${spec} produced no unit id" >&2; exit 1; }
  echo "\${unitId}" >> "\${ROOT}/units.txt"
done
# --cold-start is a policy decision, not a measurement: the class has no measured history before the
# first verdict, and every decision prints that it was cold-started.
while read -r unitId; do
  "\${NODE_BIN}" "\${CHECKOUT}/apps/cli/src/main.ts" qualify "\${unitId}" --cold-start --json >/dev/null || exit 1
done < "\${ROOT}/units.txt"
wc -l < "\${ROOT}/units.txt"
`;

/**
 * Build the artefacts. Throws a `RangeError`/`Error` with a sentence a person can act on; the shell
 * wrapper turns the message into exit 2 (usage) or 1 (build failure).
 */
export function buildImportArtifacts(options: ImportArtifactsOptions): ImportArtifacts {
  const { revisions, source, createdAt } = options;
  const root = resolve(options.root);
  if (!Number.isInteger(revisions) || revisions < 1)
    throw new RangeError('--revisions must be positive');

  // 1. A corpus inside the checkout is a corpus the worker can read.
  const sourceRoot = resolve(source);
  if (root === sourceRoot || root.startsWith(`${sourceRoot}${sep}`)) {
    throw new RangeError(
      `--root ${root} is inside the checkout ${sourceRoot}; the holdout would be readable by the worker`,
    );
  }
  // 2. Only replace our own artefacts.
  if (existsSync(root)) {
    if (!existsSync(join(root, MARKER))) {
      throw new RangeError(
        `${root} exists and is not a previous import-hygiene artefacts root (no ${MARKER}); refusing to delete it`,
      );
    }
    rmSync(root, { recursive: true, force: true });
  }
  mkdirSync(root, { recursive: true });

  const repo = join(root, 'repo');
  const mirror = join(root, 'repo.git');
  const holdoutRoot = join(root, 'holdout');
  const home = join(root, 'home');
  mkdirSync(repo, { recursive: true });
  mkdirSync(home, { recursive: true });

  const revisionDir = writeHoldoutCorpus(holdoutRoot);

  git(repo, ['init', '-q', '-b', 'main']);
  git(repo, ['config', 'user.email', 'fixtures@factory.invalid']);
  git(repo, ['config', 'user.name', 'factory fixtures']);

  const baseRevs: string[] = [];
  const specPaths: string[] = [];
  const unitsFile = join(root, 'units.txt');
  for (let index = 0; index < revisions; index += 1) {
    writeTree(repo, brokenTree(index));
    git(repo, ['add', '-A']);
    git(repo, ['commit', '-q', '-m', `base ${String(index + 1)}: the class's four defects`]);
    const baseRev = git(repo, ['rev-parse', 'HEAD']);
    baseRevs.push(baseRev);

    // 3. Measure our own output: a base revision that passes a rule is a corpus that certifies nothing.
    const results = runRules(repo, revisionDir);
    const green = results.filter((result) => result.exitCode === 0).map((result) => result.id);
    if (green.length > 0) {
      throw new Error(
        `base revision ${String(index + 1)} (${baseRev}) passes ${green.join(', ')}; ` +
          'a corpus that passes a defective tree certifies nothing',
      );
    }

    const specPath = join(root, `spec-${String(index + 1)}.json`);
    writeFileSync(specPath, specFor(index + 1, baseRev));
    specPaths.push(specPath);
  }
  writeFileSync(join(root, 'restate.md'), `${RESTATE}\n`);
  writeFileSync(join(root, 'plan-units.sh'), planUnitsScript(sourceRoot));
  execFileSync('chmod', ['+x', join(root, 'plan-units.sh')]);

  // The mirror is what the wall clones: a `--mirror` clone, not the working repository.
  git(root, ['clone', '-q', '--mirror', repo, mirror]);

  // A repair target outside the repository, so an operator (or the loop's first attempt) can see what
  // "fixed" looks like without touching the mirror.
  writeTree(join(root, 'repair'), fixedTree(0));
  const repairResults = runRules(join(root, 'repair'), revisionDir);
  const repairRed = repairResults
    .filter((result) => result.exitCode !== 0)
    .map((result) => result.id);
  if (repairRed.length > 0) {
    throw new Error(
      `the repair target fails ${repairRed.join(', ')}: the class would be unrepairable`,
    );
  }

  writeFileSync(
    join(root, 'README.md'),
    `# import-hygiene certification artefacts

Generated by \`scripts/import-hygiene-artifacts.sh\` at ${createdAt}.

- \`repo/\` — the repository the worker edits: a TypeScript source tree whose every commit breaks all
  four class rules (an extensionless relative import, a value import of a type-only symbol, an enum).
- \`repo.git/\` — its \`--mirror\` clone: the \`FACTORY_PRISTINE_REPO\` the wall clones.
- \`holdout/${TASK_CLASS}/${HOLDOUT_REVISION}/\` — the corpus: four rules and \`manifest.json\`.
- \`spec-1.json … spec-${String(revisions)}.json\`, \`restate.md\` — one unit spec per base revision.
- \`plan-units.sh\` — submits and qualifies them against \`$FACTORY_HOME\`, then writes \`units.txt\`.
- \`home/\` — an empty \`FACTORY_HOME\` for the loop.
- \`repair/\` — the fully repaired tree, kept so "what fixed looks like" is a fact rather than a claim.

The visible check (\`tools/check-imports.mjs\`) covers the extension rule only: a worker that fixes
exactly what it prints produces a tree that passes acceptance and still does not run.
`,
  );
  writeFileSync(
    join(root, MARKER),
    `${JSON.stringify(
      {
        taskClass: TASK_CLASS,
        repo: REPO_ID,
        holdoutRevision: HOLDOUT_REVISION,
        createdAt,
        revisions,
        baseRevs,
      },
      null,
      2,
    )}\n`,
  );

  return {
    root,
    repo,
    mirror,
    holdoutRoot,
    revisionDir,
    baseRevs,
    specPaths,
    unitsFile,
    planScript: join(root, 'plan-units.sh'),
  };
}

/** The `export` block an operator pastes before running the loop. */
export function exportBlock(artifacts: ImportArtifacts): string {
  return [
    `export FACTORY_HOME='${join(artifacts.root, 'home')}'`,
    `export FACTORY_REPO='${REPO_ID}'`,
    `export FACTORY_PRISTINE_REPO='${artifacts.mirror}'`,
    `export FACTORY_HOLDOUT_ROOT='${artifacts.holdoutRoot}'`,
    `export FACTORY_HOLDOUT_TASK_CLASS='${TASK_CLASS}'`,
    // The *check*, not the code: see the wall's `testRootFrom: 'base'` rule.
    `export FACTORY_TEST_ROOT='tools'`,
    `export FACTORY_WALL_SUITE='node tools/check-imports.mjs'`,
    `export FACTORY_LIVE_MODEL=1`,
  ].join('\n');
}

/** A temporary repair tree, so a caller can compare base and repair without writing into the root. */
export function temporaryRepairTree(): string {
  const root = mkdtempSync(join(tmpdir(), 'import-repair-'));
  writeTree(root, fixedTree(0));
  return root;
}
