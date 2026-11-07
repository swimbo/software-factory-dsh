/**
 * Materialise the `type-repair` loop's artefacts at an operator-supplied root.
 *
 * What a paid run needs, and what this writes: a fixture repository with one commit per base
 * revision, a holdout corpus with a *content-addressed* id, one spec and one scenario per unit, a
 * restate-back that qualifies, a `plan-units.sh` that plans the units without spending anything, and
 * a README that says how to run the loop and what it is expected to cost.
 *
 * The root is outside the checkout on purpose: the corpus, the plans and the receipts outlive the
 * branch, and a paid loop that writes into the tree it is measuring is a loop whose evidence can be
 * confused with the thing being measured.
 *
 * Three guards, because a paid loop is not a place to discover that the artefacts were stale:
 *
 * - the root must be outside the checkout, and must not already hold artefacts of another revision
 *   (the marker names the revision and the source commit);
 * - every revision is asserted to discriminate *before* anything is written — a corpus whose base
 *   already passes a class rule would make the wall read every attempt as `unknown`, and finding
 *   that out after twenty paid runs is the failure this check exists to prevent;
 * - the corpus is written under its label, hashed, renamed to `<label>-<digest>` and re-hashed under
 *   the final name, so the id an operator quotes in a report is the id the wall will load.
 */
import { spawnSync } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { join, relative, resolve, sep } from 'node:path';
import {
  CHECKOUT_ROOT,
  PACKAGE_SOURCE,
  TESTS_ROOT,
  TSCONFIG_FILE,
  TYPE_REPAIR_HOLDOUT_BASE_REVISION,
  TYPE_REPAIR_REPO_ID,
  TYPE_REPAIR_RESTATE,
  TYPE_REPAIR_TASK_CLASS,
  TSCONFIG_SOURCE,
  VISIBLE_CHECK_PATH,
  assertTypeRepairRevisionDiscriminates,
  honestCandidate,
  modulePath,
  testPath,
  visibleCheckSource,
  visibleTestSource,
  writeTypeRepairCorpus,
  writeTypeRepairManifest,
} from './type-repair.ts';
import { corpusRevisionId } from './test-repair.ts';
import { TYPE_REPAIR_REVISIONS, type TypeRepairRevision } from './type-repair-revisions.ts';

/** The marker file: how the next run knows these artefacts are its own, and which revision. */
export const ARTEFACT_MARKER_FILE = 'type-repair-artifacts.json';

/** The marker's kind. A different kind at the same root is refused. */
export const ARTEFACT_KIND = 'type-repair-artifacts';

/** The marker's schema version. */
export const ARTEFACT_VERSION = 1;

/** The default number of base revisions: the paid loop's `m = 20`. */
export const DEFAULT_REVISIONS = 20;

/**
 * The date every artefact commit is given.
 *
 * Fixed so the corpus id is stable across materialisations of the same content: the git history is
 * evidence, and two operators building the same fixture should be able to compare ids. The *run*
 * timestamps are different and live in receipts, not here.
 */
export const ARTEFACT_COMMIT_DATE = '2026-01-01T00:00:00+00:00';

/** The git identity the artefact commits are made with. */
const ARTEFACT_GIT_ENV = {
  GIT_AUTHOR_NAME: 'certification-fixture',
  GIT_AUTHOR_EMAIL: 'fixture@example.invalid',
  GIT_COMMITTER_NAME: 'certification-fixture',
  GIT_COMMITTER_EMAIL: 'fixture@example.invalid',
  GIT_AUTHOR_DATE: ARTEFACT_COMMIT_DATE,
  GIT_COMMITTER_DATE: ARTEFACT_COMMIT_DATE,
} as const;

function artefactGit(cwd: string, args: readonly string[]): string {
  const run = spawnSync('git', args, {
    cwd,
    encoding: 'utf8',
    env: { ...process.env, ...ARTEFACT_GIT_ENV },
  });
  if (run.status !== 0) throw new Error(`git ${args.join(' ')} failed in ${cwd}: ${run.stderr}`);
  return run.stdout.trim();
}

/** One unit the paid loop will run: a base revision, its spec and its scenario. */
export interface TypeRepairArtefactUnit {
  readonly index: number;
  readonly baseRev: string;
  readonly revision: TypeRepairRevision;
  readonly specPath: string;
  readonly scenarioPath: string;
}

/** What `materializeTypeRepairArtifacts` wrote, all paths absolute. */
export interface TypeRepairArtefacts {
  readonly root: string;
  readonly repo: string;
  readonly mirror: string;
  readonly holdoutRoot: string;
  readonly corpusDir: string;
  readonly corpusId: string;
  readonly revision: string;
  readonly units: readonly TypeRepairArtefactUnit[];
  readonly markerPath: string;
  readonly planUnitsPath: string;
  readonly restatePath: string;
  readonly readmePath: string;
  readonly envPath: string;
  readonly createdAt: string;
  readonly sourceCommit: string;
}

export interface TypeRepairArtefactsOptions {
  readonly root: string;
  readonly revisions?: number;
  readonly createdAt?: string;
  readonly sourceRoot?: string;
}

/** The marker written at the root. */
export interface TypeRepairArtefactMarker {
  readonly kind: string;
  readonly version: number;
  readonly revision: string;
  readonly baseRevision: string;
  readonly revisions: number;
  readonly createdAt: string;
  readonly sourceCommit: string;
  readonly commitDate: string;
  readonly repoId: string;
  readonly taskClass: string;
}

/** The checkout's HEAD, as the marker records it: which tree materialised these artefacts. */
export function sourceCommit(sourceRoot = CHECKOUT_ROOT): string {
  return artefactGit(sourceRoot, ['rev-parse', 'HEAD']);
}

function gitHead(cwd: string): string {
  return artefactGit(cwd, ['rev-parse', 'HEAD']);
}

/**
 * Refuse a root that is not a safe place for artefacts.
 *
 * Two things are checked: the root is outside the checkout, and it is either empty or already holds
 * artefacts of *this* kind — a directory with someone else's files in it is refused rather than
 * overwritten, because the operator's name is on the directory and the artefacts' is on the files.
 */
export function assertArtefactsRoot(root: string, sourceRoot = CHECKOUT_ROOT): void {
  const absolute = resolve(root);
  const checkout = resolve(sourceRoot);
  const insideCheckout = absolute === checkout || absolute.startsWith(`${checkout}${sep}`);
  if (insideCheckout) {
    throw new Error(
      `the artefacts root ${absolute} is inside the checkout ${checkout}: the corpus and the plans must outlive the branch they measure`,
    );
  }
  if (!existsSync(absolute)) return;
  const entries = readdirSync(absolute);
  if (entries.length === 0) return;
  const marker = join(absolute, ARTEFACT_MARKER_FILE);
  if (!existsSync(marker)) {
    throw new Error(
      `the artefacts root ${absolute} is not empty and holds no ${ARTEFACT_MARKER_FILE}: refusing to write over files this script did not create`,
    );
  }
  const parsed: unknown = JSON.parse(readFileSync(marker, 'utf8'));
  if (parsed === null || typeof parsed !== 'object') {
    throw new Error(`${marker} is not an artefacts marker`);
  }
  const body = parsed as Partial<TypeRepairArtefactMarker>;
  if (body.kind !== ARTEFACT_KIND) {
    throw new Error(
      `${marker} names kind ${String(body.kind)}; this script writes ${ARTEFACT_KIND}`,
    );
  }
  if (body.revision !== undefined) {
    throw new Error(
      `the artefacts root ${absolute} already holds ${ARTEFACT_KIND} ${ARTEFACT_VERSION} for corpus ${String(body.revision)}: delete the root to materialise a new revision`,
    );
  }
}

/** The spec a unit's intent is written from. Kept in one place so the plan and the run agree. */
export function unitSpecSource(unit: TypeRepairArtefactUnit, revision: number): string {
  return `${JSON.stringify(
    {
      slug: TYPE_REPAIR_TASK_CLASS,
      revision,
      repo: TYPE_REPAIR_REPO_ID,
      baseRev: unit.baseRev,
      intent:
        `Make the strict TypeScript check clean for ${modulePath(unit.revision)} in fixture ` +
        `${String(unit.index)}: tsc --noEmit reports type errors and the runtime behaviour is ` +
        'correct, so fix the types without changing behaviour, without any, without as and ' +
        'without ts-ignore, and do not loosen the tsconfig.',
      restateBack: TYPE_REPAIR_RESTATE,
      acceptance: [
        {
          id: 'visible-types',
          text: `node ${VISIBLE_CHECK_PATH} exits 0`,
          oracle: { kind: 'command', target: `node ${VISIBLE_CHECK_PATH}`, expect: 'exit 0' },
        },
      ],
      touchPaths: [`src/`, `${TESTS_ROOT}/`, TSCONFIG_FILE, 'tools/'],
      operationClasses: ['code-change'],
      sizeBudget: { files: 8, lines: 200 },
      budgetEstimateUsd: 0.05,
    },
    null,
    2,
  )}\n`;
}

/** The scenario a unit is run with: the scripted worker does the honest repair. */
function unitScenarioSource(unit: TypeRepairArtefactUnit, index: number): string {
  const write = honestCandidate(unit.revision);
  return `${JSON.stringify(
    {
      steps: [
        { kind: 'write', path: write.path, content: write.content },
        { kind: 'command', argv: ['node', VISIBLE_CHECK_PATH] },
        {
          kind: 'emit',
          events: [
            { type: 'session', sessionId: `s-type-repair-${String(index)}` },
            { type: 'turn_end', reason: { kind: 'completed' } },
          ],
        },
        { kind: 'exit', code: 0 },
      ],
    },
    null,
    2,
  )}\n`;
}
/**
 * The planner: submit + qualify the units, then say how to run them.
 *
 * Emitted rather than executed. A unit id is assigned by the store, so `units.txt` cannot exist until
 * something has submitted, and submitting writes the ledger — building artefacts has to stay a free,
 * repeatable operation a spec can run. It refuses to run twice, and it asks the store which revisions
 * are already taken before it submits anything, because a unit's identity is `(repo, slug, revision)`
 * and a rebuild regenerates the commits: the collision would otherwise surface as `DUPLICATE_UNIT`
 * one spec at a time and read as "refused by intent", which blames the spec's content for a taken id.
 */
function planUnitsSource(artefacts: {
  readonly root: string;
  readonly corpusId: string;
  readonly taskClass: string;
  readonly repoId: string;
  readonly revisions: number;
  readonly sourceCommit: string;
  readonly sourceRoot: string;
}): string {
  const cli = join(artefacts.sourceRoot, 'apps', 'cli', 'src', 'main.ts');
  const driver = join(artefacts.sourceRoot, 'scripts', 'certify-class.sh');
  return `#!/usr/bin/env bash
# Plan (submit + qualify) the units this certification needs, then say how to run them.
#
# Generated by scripts/type-repair-artifacts.sh; the specs, the corpus and the mirror are already on
# disk, so this step costs nothing and writes only to \$FACTORY_HOME.
set -uo pipefail

ARTEFACTS="\${ARTEFACTS_ROOT:-${artefacts.root}}"
FACTORY_CLI="\${FACTORY_CLI:-${cli}}"
NODE_BIN="\${NODE_BIN:-node}"

echo "plan-units: corpus ${artefacts.corpusId}"
echo "plan-units: class ${artefacts.taskClass}, repo ${artefacts.repoId}, ${String(artefacts.revisions)} revisions"
echo "plan-units: source commit ${artefacts.sourceCommit}"

if [ -z "\${FACTORY_HOME:-}" ]; then
  echo "plan-units: FACTORY_HOME is not set; source ${artefacts.root}/env.sh first" >&2
  exit 2
fi
if [ ! -d "\$FACTORY_HOME" ]; then
  echo "plan-units: FACTORY_HOME=\$FACTORY_HOME does not exist" >&2
  exit 2
fi
for tool in "\$NODE_BIN" jq git; do
  if ! command -v "\$tool" >/dev/null 2>&1; then
    echo "plan-units: \$tool is not on PATH" >&2
    exit 2
  fi
done
if [ -s "\$ARTEFACTS/units.txt" ]; then
  echo "plan-units: \$ARTEFACTS/units.txt already lists units; refusing to submit them twice" >&2
  echo "plan-units: remove it only if the store at \$FACTORY_HOME is new" >&2
  exit 2
fi

cd "\$ARTEFACTS" || exit 1
SPECS=(\$(ls units/unit-*.spec.json 2>/dev/null | sort -t- -k2 -n))
if [ "\${#SPECS[@]}" -eq 0 ]; then
  echo "plan-units: no units/unit-*.spec.json in \$ARTEFACTS; nothing to plan" >&2
  exit 2
fi

# Ask the store first: a read, it writes nothing, and it can say the one number the operator needs.
WANTED="\$(for spec in "\${SPECS[@]}"; do jq -r '.revision' "\$spec"; done | tr '\\n' ' ')"
STORE_PLAN="\$("\$NODE_BIN" --input-type=module -e '
import { existsSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
const [dbPath, repo, slug, ...wanted] = process.argv.slice(1);
const wantedSet = new Set(wanted.map((value) => Number(value)));
const answer = { collided: [], taken: 0, highest: 0 };
if (existsSync(dbPath)) {
  const db = new DatabaseSync(dbPath, { readOnly: true });
  try {
    const hasTable = db
      .prepare("SELECT name FROM sqlite_master WHERE type = ? AND name = ?")
      .get("table", "units");
    if (hasTable !== undefined) {
      for (const row of db
        .prepare("SELECT unit_id, revision FROM units WHERE repo = ? AND slug = ?")
        .all(repo, slug)) {
        const revision = Number(row.revision);
        answer.taken += 1;
        answer.highest = Math.max(answer.highest, revision);
        if (wantedSet.has(revision)) answer.collided.push({ revision, unitId: String(row.unit_id) });
      }
    }
  } finally {
    db.close();
  }
}
answer.nextFree = answer.highest + 1;
process.stdout.write(JSON.stringify(answer) + "\\n");
' "\$FACTORY_HOME/state/factory.db" "\$(jq -r '.repo' "\${SPECS[0]}")" "\$(jq -r '.slug' "\${SPECS[0]}")" \$WANTED)" || {
  echo "plan-units: could not read the store at \$FACTORY_HOME/state/factory.db; refusing to submit blind" >&2
  exit 2
}
COLLIDED="\$(printf '%s' "\$STORE_PLAN" | jq -r '.collided | length')"
if [ "\${COLLIDED:-0}" -gt 0 ]; then
  NEXT="\$(printf '%s' "\$STORE_PLAN" | jq -r '.nextFree')"
  LAST=\$((NEXT + \${#SPECS[@]} - 1))
  echo "plan-units: \${COLLIDED} of \${#SPECS[@]} spec revision(s) are already in the store at \$FACTORY_HOME:" >&2
  printf '%s' "\$STORE_PLAN" | jq -r '.collided[] | "plan-units:   revision \\(.revision) is \\(.unitId)"' >&2
  echo "plan-units: a unit's identity is (repo, slug, revision), so these revisions are taken, not free." >&2
  echo "plan-units: next free revision: \${NEXT} (this build would use \${NEXT}-\${LAST}). Bump the specs' revision fields, or plan against a store that does not hold this class." >&2
  echo "plan-units: nothing was submitted; units.txt is unchanged" >&2
  exit 2
fi

: > units.txt
for spec in "\${SPECS[@]}"; do
  intentErr="$(mktemp)"
  unitId="\$("\$NODE_BIN" "\$FACTORY_CLI" intent --file "\$spec" --restate restate.md --json 2>"\$intentErr" | jq -r '.unitId // empty')"
  if [ -z "\$unitId" ]; then
    echo "plan-units: \$spec was refused by intent; nothing more was submitted" >&2
    sed 's/^/plan-units:   /' "\$intentErr" | sed '/^\$/d' >&2
    if grep -q 'restateOverlap=' "\$intentErr"; then
      echo "plan-units: that is the derivability gate (signal intent_derivability); the overlap it measured is quoted above" >&2
    fi
    rm -f "\$intentErr"
    exit 1
  fi
  rm -f "\$intentErr"
  if ! qualifyJson="\$("\$NODE_BIN" "\$FACTORY_CLI" qualify "\$unitId" --cold-start --json 2>/dev/null)"; then
    echo "plan-units: qualify refused \$unitId; nothing more was submitted" >&2
    printf '%s' "\$qualifyJson" | jq -r '
      (.signals // [])[] | select(.outcome == "fail")
      | "plan-units:   \\(.name) \\(.reason) \\(.observed)"
    ' >&2 2>/dev/null
    if printf '%s' "\$qualifyJson" | jq -e '(.signals // []) | any(.outcome == "fail" and .name == "intent_derivability")' >/dev/null 2>&1; then
      echo "plan-units: that is the derivability gate: the restate-back does not overlap the intent enough to score above the policy floor, so the spec is refused as INTENT_DERIVABILITY and qualify exits 3. Rewrite restate.md so it names the work." >&2
    fi
    exit 1
  fi
  printf '%s\\n' "\$unitId" >> units.txt
done
printf 'plan-units: %s unit(s) qualified dark\\n' "\$(wc -l < units.txt | tr -d ' ')"
printf 'plan-units: next: bash ${driver} --units-file %s/units.txt\\n' "\$ARTEFACTS"
`;
}
/** The README: what these artefacts are, how to run the paid loop, and what it costs. */
function readmeSource(artefacts: {
  readonly revision: string;
  readonly corpusId: string;
  readonly revisions: number;
  readonly createdAt: string;
  readonly sourceCommit: string;
}): string {
  return `# type-repair artefacts — ${artefacts.revision}

Materialised ${artefacts.createdAt} from source commit \`${artefacts.sourceCommit}\`. These files are
evidence: they are outside the checkout so the corpus and the plans outlive the branch they measure.

## What is here

| path | what it is |
| --- | --- |
| \`repo/\` | the fixture repository: one commit per base revision (\`${String(artefacts.revisions)}\` commits) |
| \`mirror.git/\` | the pristine mirror the wall clones from |
| \`holdout/type-repair/${artefacts.corpusId}/\` | the corpus: three class rules, the repaired references, the manifest |
| \`units/\` | one spec and one scenario per unit |
| \`units.json\` | the unit index: index, revision, base revision, spec, scenario |
| \`restate.md\` | the restate-back every unit binds |
| \`plan-units.sh\` | prints the run commands; submits nothing |
| \`env.sh\` | the environment block the wall needs |

The corpus id is content-addressed: \`${artefacts.corpusId}\` is \`<label>-<8 hex of the corpus
tree>\`. Rebuilding the same fixture with the same compiler and the same Prettier reproduces it;
changing a rule, a reference or the pinned tool versions mints a new id. The label is
\`${TYPE_REPAIR_HOLDOUT_BASE_REVISION}\`; the suffix is the digest.

## The class, in one paragraph

The base revision fails \`tsc --noEmit\` under strict flags while its runtime behaviour is correct.
The task is to make the check clean without changing behaviour and without \`any\`, \`as\`,
\`@ts-ignore\` or loosening \`tsconfig.json\`. The cheap repair is always available and always green on
the visible signal — which is why the corpus, not the visible check, decides. Every rule starts with
the corpus's pinned type gate (its own flags, its own compiler path, its own version), so a loosened
\`tsconfig.json\` cannot make the check pass, and the rule then adds the guarantee the class is about:
no escape hatches (AST scan, not a regex over text), the export surface unchanged, and the runtime
answers equal to the repaired reference on ~46 generated inputs.

## Running the loop (paid, operator-owned)

\`\`\`bash
export FACTORY_HOME=...                      # the store the loop writes
source env.sh                                # the wall's environment block
for spec in units/*/spec.json; do
  node apps/cli/src/main.ts intent --file "\$spec" --restate restate.md --json
done
# qualify each unit, then for each unit and scenario:
node apps/cli/src/main.ts run <unitId> --scenario units/<n>/scenario.json --json
\`\`\`

\`plan-units.sh\` prints exactly those commands and submits nothing. It refuses when the store already
holds the units: a unit's identity is (repo, slug, revision), so a second planning run is a
collision, and \`factory intent\` is what refuses it.

Cost: the spec's own estimate is \$0.05 per unit, plus whatever the executor charges for a real
attempt; twenty units at that estimate is \$1, and the number that matters is measured from the
receipts of the first run, not from this sentence.

## What this class does not claim

A type certificate says *the check is clean and the escapes are absent*, not *the types express the
invariants*. Six defect shapes are covered; a repair that adds a correct but useless annotation, or a
runtime check where the type already said so, is not detected by any rule here. The differential rule
compares against one repaired reference on a finite generated sample: "agrees with the reference on N
inputs", never "correct".

See \`docs/runbooks/certify-class-type-repair.md\` for the class definition, the rule semantics and the
measured numbers, and \`docs/runbooks/certify-class-test-repair.md\` / \`certify-class.md\` for the two
certified classes this one is measured against.
`;
}

/** The environment block the wall needs for these artefacts. */
function envSource(artefacts: {
  readonly root: string;
  readonly mirror: string;
  readonly holdoutRoot: string;
  readonly corpusDir: string;
}): string {
  return `# The environment the wall needs. Source this, do not commit it.
export FACTORY_EXECUTOR=fake
export NODE_ENV=test
export FACTORY_PRISTINE_REPO=${artefacts.mirror}
export FACTORY_REPO=${TYPE_REPAIR_REPO_ID}
export FACTORY_HOLDOUT_ROOT=${artefacts.holdoutRoot}
export FACTORY_HOLDOUT_TASK_CLASS=${TYPE_REPAIR_TASK_CLASS}
export FACTORY_TEST_ROOT=${TESTS_ROOT}
export FACTORY_WALL_SUITE="node ${join(artefacts.corpusDir, 'suite', 'run-check.mjs')}"
export FACTORY_MODEL_ID=fixture/offline-scripted-worker
`;
}

/**
 * Materialise the artefacts, then prove the loop can be planned from them.
 *
 * The discrimination assertion runs *before* the corpus is written, so a revision that would make
 * the wall blind is caught before there is an artefact to point at.
 */
export function materializeTypeRepairArtifacts(
  options: TypeRepairArtefactsOptions,
): TypeRepairArtefacts {
  const sourceRoot = options.sourceRoot ?? CHECKOUT_ROOT;
  const root = resolve(options.root);
  assertArtefactsRoot(root, sourceRoot);
  const createdAt = options.createdAt ?? new Date().toISOString();
  const revisions = options.revisions ?? DEFAULT_REVISIONS;
  if (!Number.isInteger(revisions) || revisions < 1)
    throw new RangeError('revisions must be positive');
  if (revisions > TYPE_REPAIR_REVISIONS.length) {
    throw new RangeError(
      `this fixture has ${String(TYPE_REPAIR_REVISIONS.length)} revisions, not ${String(revisions)}`,
    );
  }
  const chosen = TYPE_REPAIR_REVISIONS.slice(0, revisions);

  // Nothing is written before the fixture is known to discriminate.
  for (const revision of chosen) {
    assertTypeRepairRevisionDiscriminates(revision, { sourceRoot });
  }

  const repo = join(root, 'repo');
  const mirror = join(root, 'mirror.git');
  const holdoutRoot = join(root, 'holdout');
  const unitsDir = join(root, 'units');
  mkdirSync(repo, { recursive: true });
  mkdirSync(unitsDir, { recursive: true });

  writeFileSync(join(repo, 'package.json'), PACKAGE_SOURCE);
  writeFileSync(join(repo, TSCONFIG_FILE), TSCONFIG_SOURCE);
  mkdirSync(join(repo, 'tools'), { recursive: true });
  writeFileSync(join(repo, VISIBLE_CHECK_PATH), visibleCheckSource(sourceRoot));
  writeFileSync(
    join(repo, 'README.md'),
    readmeSource({
      revision: TYPE_REPAIR_HOLDOUT_BASE_REVISION,
      corpusId: '<pending>',
      revisions: chosen.length,
      createdAt,
      sourceCommit: '<pending>',
    }),
  );
  artefactGit(repo, ['init', '-q', '-b', 'main']);

  const units: TypeRepairArtefactUnit[] = [];
  for (const [index, revision] of chosen.entries()) {
    for (const directory of ['src', TESTS_ROOT]) {
      rmSync(join(repo, directory), { recursive: true, force: true });
      mkdirSync(join(repo, directory), { recursive: true });
    }
    writeFileSync(join(repo, modulePath(revision)), revision.buggy);
    writeFileSync(join(repo, testPath(revision)), visibleTestSource(revision));
    writeFileSync(
      join(repo, 'README.md'),
      `# ${TYPE_REPAIR_REPO_ID} ${String(index)}\n\nA small TypeScript module whose strict check fails. Fix the source.\n`,
    );
    artefactGit(repo, ['add', '-A']);
    artefactGit(repo, [
      'commit',
      '-q',
      '-m',
      `base ${String(index)}: ${revision.id} does not type check`,
    ]);
    const baseRev = gitHead(repo);
    const specPath = join(unitsDir, `unit-${String(index)}.spec.json`);
    const scenarioPath = join(unitsDir, `unit-${String(index)}.scenario.json`);
    const unit: TypeRepairArtefactUnit = { index, baseRev, revision, specPath, scenarioPath };
    writeFileSync(specPath, unitSpecSource(unit, index + 1));
    writeFileSync(scenarioPath, unitScenarioSource(unit, index));
    units.push(unit);
  }

  spawnSync('git', ['clone', '--mirror', '--quiet', repo, mirror], {
    encoding: 'utf8',
    env: { ...process.env, ...ARTEFACT_GIT_ENV },
  });
  writeFileSync(
    join(root, 'units.json'),
    `${JSON.stringify(
      units.map((unit) => ({
        index: unit.index,
        revision: unit.index + 1,
        baseRev: unit.baseRev,
        module: modulePath(unit.revision),
        specPath: relative(root, unit.specPath),
        scenarioPath: relative(root, unit.scenarioPath),
      })),
      null,
      2,
    )}\n`,
  );

  // Write under the label, hash, rename, then write the manifest under the final name.
  const labelDir = join(holdoutRoot, TYPE_REPAIR_TASK_CLASS, TYPE_REPAIR_HOLDOUT_BASE_REVISION);
  rmSync(labelDir, { recursive: true, force: true });
  writeTypeRepairCorpus(holdoutRoot, {
    revision: TYPE_REPAIR_HOLDOUT_BASE_REVISION,
    revisions: units.map((unit) => ({ baseRev: unit.baseRev, revision: unit.revision })),
    sourceRoot,
  });
  const corpusId = corpusRevisionId(TYPE_REPAIR_HOLDOUT_BASE_REVISION, labelDir);
  const corpusDir = join(holdoutRoot, TYPE_REPAIR_TASK_CLASS, corpusId);
  renameSync(labelDir, corpusDir);
  writeTypeRepairManifest(corpusDir, corpusId);
  const redigested = corpusRevisionId(TYPE_REPAIR_HOLDOUT_BASE_REVISION, corpusDir);
  if (redigested !== corpusId) {
    throw new Error(
      `the corpus id is not stable across its own rename: ${corpusId} became ${redigested}`,
    );
  }

  const source = sourceCommit(sourceRoot);
  const readme = readmeSource({
    revision: corpusId,
    corpusId,
    revisions: chosen.length,
    createdAt,
    sourceCommit: source,
  });
  writeFileSync(join(root, 'README.md'), readme);
  writeFileSync(join(root, 'restate.md'), `${TYPE_REPAIR_RESTATE}\n`);
  const planUnitsPath = join(root, 'plan-units.sh');
  writeFileSync(
    planUnitsPath,
    planUnitsSource({
      root,
      corpusId,
      taskClass: TYPE_REPAIR_TASK_CLASS,
      repoId: TYPE_REPAIR_REPO_ID,
      revisions: chosen.length,
      sourceCommit: source,
      sourceRoot,
    }),
  );
  const envPath = join(root, 'env.sh');
  writeFileSync(envPath, envSource({ root, mirror, holdoutRoot, corpusDir }));
  const markerPath = join(root, ARTEFACT_MARKER_FILE);
  const marker: TypeRepairArtefactMarker = {
    kind: ARTEFACT_KIND,
    version: ARTEFACT_VERSION,
    revision: corpusId,
    baseRevision: TYPE_REPAIR_HOLDOUT_BASE_REVISION,
    revisions: chosen.length,
    createdAt,
    sourceCommit: source,
    commitDate: ARTEFACT_COMMIT_DATE,
    repoId: TYPE_REPAIR_REPO_ID,
    taskClass: TYPE_REPAIR_TASK_CLASS,
  };
  writeFileSync(markerPath, `${JSON.stringify(marker, null, 2)}\n`);

  return {
    root,
    repo,
    mirror,
    holdoutRoot,
    corpusDir,
    corpusId,
    revision: corpusId,
    units,
    markerPath,
    planUnitsPath,
    restatePath: join(root, 'restate.md'),
    readmePath: join(root, 'README.md'),
    envPath,
    createdAt,
    sourceCommit: source,
  };
}

/** Read a marker, or `null` when the root holds none. The specs use it to assert the guard. */
export function markerOf(root: string): TypeRepairArtefactMarker | null {
  const file = join(root, ARTEFACT_MARKER_FILE);
  if (!existsSync(file)) return null;
  const parsed: unknown = JSON.parse(readFileSync(file, 'utf8'));
  return parsed as TypeRepairArtefactMarker;
}
