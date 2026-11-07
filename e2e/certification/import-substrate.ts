/**
 * The corpus and fixture farm for the task class `import-hygiene`.
 *
 * ## Why this class exists
 *
 * `docs-typo-fix`, `test-repair` and `type-repair` all fail the same way: the compiler tells the worker
 * it is not finished. This class is hard for a different reason — its convention is **not visible to
 * TypeScript**. This repository's `AGENTS.md` states the rule: every relative import carries its `.ts`
 * extension, because the tree is `module: nodenext` + `verbatimModuleSyntax` + `erasableSyntaxOnly`.
 * `tsc` accepts `import { Shape } from './shape'` whenever a `.ts` sibling resolves; `node` rejects it
 * at runtime. `tsc` accepts importing an interface as a value; `verbatimModuleSyntax` keeps the import
 * in the emitted JavaScript and `node` fails to link it. So the visible signal is green exactly when
 * the hidden convention is violated — the failure mode a merge-ready verdict has to catch and a
 * compiler never will.
 *
 * ## The four rules, and why the fourth is the oracle
 *
 * Three rules are static and one is dynamic. The static rules say *what* is wrong; `runtime-resolve`
 * says *that the tree does not run*, by importing every source file the way `node` would. It is the
 * rule that cannot be argued with, and it is red whenever any of the others is — which is honest, and
 * is why the mutation matrix below expects more than one red rule per planted defect.
 *
 * ## The visible check covers one rule on purpose
 *
 * `tools/check-imports.mjs` (in the fixture repository) checks the extension rule only. It is the
 * acceptance oracle a unit declares, so a worker that reads the visible check and fixes what it names
 * produces a tree that passes acceptance and still fails the class: `almostFixedTree` is exactly that
 * candidate, exported so the tests and the loop share one definition of "looks done, is not".
 */
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { pathToFileURL } from 'node:url';

import { contentHash } from '../../packages/contracts/src/index.ts';
import { jsonOf, runFactory } from '../harness/factory.ts';
import { hashableScenarios, type HoldoutScenario } from '../../packages/wall/src/index.ts';

export const TASK_CLASS = 'import-hygiene';
/** The repo identity every unit is submitted against; `FACTORY_REPO` must name the same. */
export const REPO_ID = 'import-fixture';
/** The corpus revision. Opaque to the wall; it exists so a verdict can say what it measured. */
export const HOLDOUT_REVISION = 'h-import-hygiene-2026-11-07';

export interface FixtureFile {
  readonly path: string;
  readonly content: string;
}

export interface ClassRule {
  readonly id: string;
  readonly file: string;
  readonly source: string;
}

// Walk every `.ts` file under `src` in the tree the rule runs in. Inlined into each rule script, since
// a corpus rule is a standalone `.mjs` file with no imports from this repository.
const WALK = `
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
function sources(dir) {
  const out = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...sources(path));
    else if (entry.name.endsWith('.ts')) out.push(path);
  }
  return out.sort();
}
`;

export const HOLDOUT_RULES: readonly ClassRule[] = [
  {
    id: 'import-extension',
    file: 'import-extension.mjs',
    source: `/**
 * Class rule: every relative import in the source carries its \`.ts\` extension.
 *
 * TypeScript resolves \`./shape\` to \`shape.ts\` and emits nothing to say so; \`node\` resolves the
 * emitted specifier literally and fails. The rule is about the whole tree, not the file a unit
 * happened to touch.
 */${WALK}
const problems = [];
for (const file of sources('src')) {
  const text = readFileSync(file, 'utf8');
  for (const match of text.matchAll(/from\\s+['"](\\.{1,2}\\/[^'"]*)['"]/g)) {
    const specifier = match[1];
    if (!specifier.endsWith('.ts')) problems.push(file + ': relative import "' + specifier + '" has no .ts extension');
  }
}
for (const problem of problems) console.log('import-extension: ' + problem);
process.exit(problems.length === 0 ? 0 : 1);
`,
  },
  {
    id: 'type-only-import',
    file: 'type-only-import.mjs',
    source: `/**
 * Class rule: a symbol that exists only in the type system is imported with \`import type\`.
 *
 * \`import { Shape } from './shape.ts'\` compiles, and under \`verbatimModuleSyntax\` it stays a value
 * import in the emitted module; \`node\` then fails to link an export that does not exist at runtime.
 */${WALK}
const problems = [];
for (const file of sources('src')) {
  const text = readFileSync(file, 'utf8');
  for (const match of text.matchAll(/import\\s*\\{([^}]*)\\}\\s*from\\s+['"](\\.{1,2}\\/[^'"]+)['"]/g)) {
    const names = match[1]
      .split(',')
      .map((name) => name.trim().replace(/\\s+as\\s+.*$/, ''))
      .filter((name) => name !== '');
    const target = match[2].endsWith('.ts') ? match[2] : match[2] + '.ts';
    // The imported path is relative to the importing file, not to the tree root.
    const targetPath = resolve(dirname(file), target);
    let targetText;
    try {
      targetText = readFileSync(targetPath, 'utf8');
    } catch {
      continue; // a missing target is the runtime rule's failure, not this one's
    }
    for (const name of names) {
      const typeOnly = new RegExp('export\\\\s+(interface|type)\\\\s+' + name + '\\\\b').test(targetText);
      const valueAlso = new RegExp('export\\\\s+(const|function|class|let)\\\\s+' + name + '\\\\b').test(targetText);
      if (typeOnly && !valueAlso) {
        problems.push(file + ': "' + name + '" is type-only in ' + target + ' but imported as a value');
      }
    }
  }
}
for (const problem of problems) console.log('type-only-import: ' + problem);
process.exit(problems.length === 0 ? 0 : 1);
`,
  },
  {
    id: 'no-transpiler-syntax',
    file: 'no-transpiler-syntax.mjs',
    source: `/**
 * Class rule: no syntax that needs a transpiler — \`enum\` and \`export =\`.
 *
 * The tree is run by node's type stripping, not by tsc: those two constructs are rejected at load
 * time, so a source file containing them cannot run at all.
 */${WALK}
const problems = [];
for (const file of sources('src')) {
  const text = readFileSync(file, 'utf8');
  for (const match of text.matchAll(/\\benum\\s+[A-Za-z_$]/g)) problems.push(file + ': enum needs a transpiler');
  for (const match of text.matchAll(/export\\s*=/g)) problems.push(file + ': export = needs a transpiler');
}
for (const problem of problems) console.log('no-transpiler-syntax: ' + problem);
process.exit(problems.length === 0 ? 0 : 1);
`,
  },
  {
    id: 'runtime-resolve',
    file: 'runtime-resolve.mjs',
    source: `/**
 * Class rule: the tree runs. Every source file is imported the way node imports it.
 *
 * This is the oracle the other three rules describe: an extensionless relative import, a value import
 * of a type-only symbol and an \`enum\` all fail here, whatever the static rules say. It is the whole
 * point of the class that \`tsc\` cannot see this.
 */${WALK}
import { pathToFileURL } from 'node:url';
const problems = [];
for (const file of sources('src')) {
  try {
    await import(pathToFileURL(process.cwd() + '/' + file).href);
  } catch (error) {
    problems.push(file + ': ' + String(error && error.message ? error.message : error).split('\\n')[0]);
  }
}
for (const problem of problems) console.log('runtime-resolve: ' + problem);
process.exit(problems.length === 0 ? 0 : 1);
`,
  },
];

/** The visible check: the extension rule and nothing else. A subset on purpose — see the header. */
export const VISIBLE_CHECK = `/**
 * The repository's own visible check: relative imports carry a .ts extension.
 *
 * It is a *subset* of the class rules. A worker that fixes only what this prints produces a candidate
 * that passes this check and still fails the class (a value import of a type-only symbol, or an enum,
 * both survive it) — which is the gap the holdout exists to measure.
 *
 * The summary line is what the wall reads: without a parseable \`FACTORY_SUMMARY\` the pinned suite is
 * \`unknown\`, never a pass, so this line is part of the fixture's contract with the wall.
 */
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

function sources(dir) {
  const out = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...sources(path));
    else if (entry.name.endsWith('.ts')) out.push(path);
  }
  return out.sort();
}

const problems = [];
for (const file of sources('src')) {
  const text = readFileSync(file, 'utf8');
  for (const match of text.matchAll(/from\\s+['"](\\.{1,2}\\/[^'"]*)['"]/g)) {
    if (!match[1].endsWith('.ts')) problems.push(file + ': "' + match[1] + '" has no .ts extension');
  }
}
for (const problem of problems) console.log('check-imports: ' + problem);
console.log('FACTORY_SUMMARY ' + JSON.stringify({
  passed: problems.length === 0 ? 1 : 0,
  failed: problems.length === 0 ? 0 : 1,
  unknown: 0,
  exitCode: problems.length === 0 ? 0 : 1,
}));
process.exit(problems.length === 0 ? 0 : 1);
`;

/**
 * A base tree: every one of the four rules is red, in files that differ per revision.
 *
 * `index` moves the numbers rather than the defects, so twenty revisions are twenty trees and no two
 * attempts share a base commit (`samples` counts distinct base revisions).
 */
export function brokenTree(index: number): readonly FixtureFile[] {
  return [
    {
      path: 'package.json',
      content: `${JSON.stringify({ name: REPO_ID, private: true, type: 'module' }, null, 2)}\n`,
    },
    {
      path: 'README.md',
      content: '# import-fixture\n\nA source tree used by the certification suite.\n',
    },
    { path: 'tools/check-imports.mjs', content: VISIBLE_CHECK },
    {
      path: 'src/shape.ts',
      content: `/** A shape, as data: the class keeps the type system and the runtime apart. */
export interface Shape {
  readonly sides: number;
  readonly label: string;
}

export function describe(shape: Shape): string {
  return shape.label + ' with ' + String(shape.sides) + ' sides';
}
`,
    },
    {
      path: 'src/util.ts',
      // Two violations in one file: an extensionless specifier (rule 1) and a value import of an
      // interface (rule 2). Both compile; neither runs.
      content: `import { Shape } from './shape';

export function area(shape: Shape): number {
  return shape.sides * shape.sides;
}
`,
    },
    {
      path: 'src/index.ts',
      // A third violation (rule 3): \`enum\` needs a transpiler.
      content: `import { area } from './util.ts';
import { describe } from './shape.ts';

export enum Level {
  Low = ${String(index)},
  High = ${String(index + 1)},
}

export function report(sides: number): string {
  const shape = { sides, label: 'fixture ' + String(${String(index)}) };
  return describe(shape) + ' area ' + String(area(shape)) + ' level ' + String(Level.Low);
}
`,
    },
  ];
}

/** The same tree with every one of the four class violations repaired. */
export function fixedTree(index: number): readonly FixtureFile[] {
  return [
    {
      path: 'package.json',
      content: `${JSON.stringify({ name: REPO_ID, private: true, type: 'module' }, null, 2)}\n`,
    },
    {
      path: 'README.md',
      content: '# import-fixture\n\nA source tree used by the certification suite.\n',
    },
    { path: 'tools/check-imports.mjs', content: VISIBLE_CHECK },
    {
      path: 'src/shape.ts',
      content: `/** A shape, as data: the class keeps the type system and the runtime apart. */
export interface Shape {
  readonly sides: number;
  readonly label: string;
}

export function describe(shape: Shape): string {
  return shape.label + ' with ' + String(shape.sides) + ' sides';
}
`,
    },
    {
      path: 'src/util.ts',
      content: `import type { Shape } from './shape.ts';

export function area(shape: Shape): number {
  return shape.sides * shape.sides;
}
`,
    },
    {
      path: 'src/index.ts',
      // The enum becomes a union of literal values: same information, no transpiler needed.
      content: `import { area } from './util.ts';
import { describe } from './shape.ts';

export type Level = ${String(index)} | ${String(index + 1)};

export function report(sides: number): string {
  const shape = { sides, label: 'fixture ' + String(${String(index)}) };
  const level: Level = ${String(index)};
  return describe(shape) + ' area ' + String(area(shape)) + ' level ' + String(level);
}
`,
    },
  ];
}

/**
 * The plausible-but-wrong candidate: the extension rule is fixed (so the visible check is green) and
 * the value import of the interface and the enum survive. This is the shape a worker produces when it
 * treats the acceptance oracle as the whole task.
 */
export function almostFixedTree(index: number): readonly FixtureFile[] {
  return fixedTree(index).map((file) => {
    if (file.path === 'src/util.ts') {
      return {
        path: file.path,
        content: file.content.replace('import type { Shape }', 'import { Shape }'),
      };
    }
    if (file.path === 'src/index.ts') {
      return {
        path: file.path,
        content: file.content.replace(
          `export type Level = ${String(index)} | ${String(index + 1)};`,
          `export enum Level {\n  Low = ${String(index)},\n  High = ${String(index + 1)},\n}`,
        ),
      };
    }
    return file;
  });
}

/** The four scenarios, in the frozen `HoldoutScenario` shape. */
export function holdoutScenarios(revisionDir: string): readonly HoldoutScenario[] {
  const scenarios: HoldoutScenario[] = HOLDOUT_RULES.map((rule) => ({
    id: rule.id,
    taskClass: TASK_CLASS,
    argv: ['node', join(revisionDir, 'rules', rule.file)],
    expectExit: [0],
  }));
  return [...scenarios].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
}

/**
 * Write `<holdoutRoot>/<task-class>/<revision>/manifest.json` and the rule scripts beside it.
 *
 * `revision` is the corpus token recorded on every verdict, so a store measured against this synthetic
 * fixture can never be mistaken for one measured against a real source tree: same rules, different
 * revision.
 */
export function writeHoldoutCorpus(
  holdoutRoot: string,
  revision: string = HOLDOUT_REVISION,
): string {
  const revisionDir = join(holdoutRoot, TASK_CLASS, revision);
  mkdirSync(join(revisionDir, 'rules'), { recursive: true });
  for (const rule of HOLDOUT_RULES)
    writeFileSync(join(revisionDir, 'rules', rule.file), rule.source);
  const scenarios = holdoutScenarios(revisionDir);
  writeFileSync(
    join(revisionDir, 'manifest.json'),
    `${JSON.stringify(
      {
        revision,
        taskClass: TASK_CLASS,
        scenarios,
        revisionHash: contentHash(hashableScenarios(scenarios)),
      },
      null,
      2,
    )}\n`,
  );
  return revisionDir;
}

/** Write a tree into a directory (the rules run with that directory as their cwd). */
export function writeTree(root: string, files: readonly FixtureFile[]): void {
  for (const file of files) {
    const path = join(root, file.path);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, file.content);
  }
}

/**
 * The scripted worker: write the repaired tree, run the visible check, end the session.
 *
 * A scenario stands in for the model, so its `command` step is worker output — the wall re-runs the
 * acceptance oracle itself. `files` defaults to the repaired tree; passing `almostFixedTree` produces
 * the candidate that satisfies the visible check and fails the class.
 */
export function scenarioFor(files: readonly FixtureFile[], sessionId: string): unknown {
  return {
    steps: [
      ...files
        .filter((file) => file.path.startsWith('src/'))
        .map((file) => ({
          kind: 'write',
          path: file.path,
          content: file.content,
        })),
      { kind: 'command', argv: ['node', 'tools/check-imports.mjs'] },
      {
        kind: 'emit',
        events: [
          { type: 'session', sessionId },
          { type: 'turn_end', reason: { kind: 'completed' } },
        ],
      },
      { kind: 'exit', code: 0 },
    ],
  };
}

export interface RuleResult {
  readonly id: string;
  readonly exitCode: number;
  readonly output: string;
}

/** Run the four rules against a tree — the same argv the wall will run, without the wall. */
export function runRules(treeRoot: string, revisionDir: string): readonly RuleResult[] {
  return HOLDOUT_RULES.map((rule) => {
    const argv = ['node', join(revisionDir, 'rules', rule.file)];
    try {
      const output = execFileSync(argv[0] as string, argv.slice(1), {
        cwd: treeRoot,
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      return { id: rule.id, exitCode: 0, output };
    } catch (error) {
      const failure = error as { status?: number; stdout?: string; stderr?: string };
      return {
        id: rule.id,
        exitCode: failure.status ?? 1,
        output: `${failure.stdout ?? ''}${failure.stderr ?? ''}`,
      };
    }
  });
}

export interface ImportSubstrateOptions {
  /** How many distinct base revisions to build. Defaults to 20 — the ratification's m. */
  readonly units?: number;
}

export interface ImportUnit {
  readonly index: number;
  readonly baseRev: string;
  readonly broken: readonly FixtureFile[];
  readonly fixed: readonly FixtureFile[];
}

export interface ImportSubstrate {
  readonly root: string;
  readonly repo: string;
  readonly mirror: string;
  readonly holdoutRoot: string;
  readonly revisionDir: string;
  readonly home: string;
  readonly units: readonly ImportUnit[];
  /** The environment the wall needs for this class; the corpus path is what makes it a class. */
  wallEnv(overrides?: Record<string, string | undefined>): Record<string, string>;
  /**
   * Submit and qualify one unit against this substrate's store. Returns the unit id and the scenario
   * path the fake executor needs (`--scenario`), because the file has to be written after the unit id
   * exists and the caller is what passes it.
   */
  submit(
    unit: ImportUnit,
    files?: readonly FixtureFile[],
  ): { readonly unitId: string; readonly scenarioPath: string };
  cleanup(): void;
}

function git(cwd: string, args: readonly string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();
}

/**
 * Build a disposable farm: a source repository with one commit per base revision, all of them breaking
 * all four rules, plus the holdout corpus. Free — no model, no credential, no store.
 *
 * The build checks its own output before returning: a corpus that passes a defective tree certifies
 * nothing, so a farm whose base revisions are not all red refuses to exist.
 */
export function createImportSubstrate(options: ImportSubstrateOptions = {}): ImportSubstrate {
  const count = options.units ?? 20;
  if (!Number.isInteger(count) || count < 1) throw new RangeError('units must be positive');

  const root = mkdtempSync(join(tmpdir(), 'import-hygiene-'));
  const repo = join(root, 'repo');
  const holdoutRoot = join(root, 'holdout');
  const home = join(root, 'home');
  mkdirSync(repo, { recursive: true });
  mkdirSync(home, { recursive: true });
  const revisionDir = writeHoldoutCorpus(holdoutRoot);

  git(repo, ['init', '-q', '-b', 'main']);
  const units: ImportUnit[] = [];
  for (let index = 0; index < count; index += 1) {
    const broken = brokenTree(index);
    writeTree(repo, broken);
    git(repo, ['add', '-A']);
    git(repo, ['commit', '-q', '-m', `base ${String(index)}: the class's four defects`]);
    const baseRev = git(repo, ['rev-parse', 'HEAD']);
    const unit: ImportUnit = { index, baseRev, broken, fixed: fixedTree(index) };
    // Every base revision must break every rule: a farm whose bases are not red certifies nothing.
    for (const result of runRules(repo, revisionDir)) {
      if (result.exitCode === 0) {
        throw new Error(
          `base revision ${String(index)} passes rule ${result.id}; the corpus would certify a broken tree`,
        );
      }
    }
    units.push(unit);
  }

  // And the repair target must pass all four rules, or the class is unrepairable by construction.
  const repair = join(root, 'repair');
  writeTree(repair, fixedTree(0));
  for (const result of runRules(repair, revisionDir)) {
    if (result.exitCode !== 0) {
      throw new Error(`the repair tree fails rule ${result.id}: ${result.output}`);
    }
  }

  const mirror = join(root, 'mirror.git');
  execFileSync('git', ['clone', '--mirror', '--quiet', repo, mirror], { encoding: 'utf8' });

  return {
    root,
    repo,
    mirror,
    holdoutRoot,
    revisionDir,
    home,
    units,
    wallEnv(overrides = {}) {
      const env: Record<string, string> = {
        FACTORY_EXECUTOR: 'fake',
        NODE_ENV: 'test',
        FACTORY_PRISTINE_REPO: mirror,
        FACTORY_REPO: REPO_ID,
        FACTORY_HOLDOUT_ROOT: holdoutRoot,
        FACTORY_HOLDOUT_TASK_CLASS: TASK_CLASS,
        // The *check*, not the code: the wall restores this root from the base revision, so a
        // candidate cannot weaken the visible check by editing it. Pointing it at `src` would have
        // restored the broken code and made every repaired tree look unrepaired.
        FACTORY_TEST_ROOT: 'tools',
        FACTORY_WALL_SUITE: 'node tools/check-imports.mjs',
        // Recorded on the certificate, so a later model change is detectable rather than inferred.
        // The offline proof is not a model; the fixture says so.
        FACTORY_MODEL_ID: 'fixture/offline-scripted-worker',
      };
      for (const [key, value] of Object.entries(overrides)) {
        if (value === undefined) delete env[key];
        else env[key] = value;
      }
      return env;
    },
    submit(unit, files) {
      const revision = unit.index + 1;
      const intent =
        `Repair the source tree for fixture ${String(unit.index)}: every relative import carries its ` +
        '.ts extension, type-only symbols are imported with import type, and no enum or export = ' +
        'remains, so node can load every source file.';
      const restateBack =
        `You asked for: repair the source tree for fixture ${String(unit.index)} — every relative ` +
        'import carries its .ts extension, type-only symbols are imported with import type, and no ' +
        'enum or export = remains, so node can load every source file. Not asking for: a behaviour ' +
        'change or a dependency upgrade.';
      const spec = {
        slug: TASK_CLASS,
        revision,
        repo: REPO_ID,
        baseRev: unit.baseRev,
        intent,
        restateBack,
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
      };
      const specPath = join(home, `spec-${String(revision)}.json`);
      writeFileSync(specPath, `${JSON.stringify(spec, null, 2)}\n`);
      const restatePath = join(home, `restate-${String(revision)}.md`);
      writeFileSync(restatePath, `${restateBack}\n`);
      const submitted = runFactory(
        ['intent', '--file', specPath, '--restate', restatePath, '--json'],
        {
          home,
        },
      );
      if (submitted.code !== 0)
        throw new Error(`intent refused:\n${submitted.stderr}\n${submitted.stdout}`);
      const unitId = String(jsonOf(submitted)['unitId']);
      const qualified = runFactory(['qualify', unitId, '--cold-start', '--json'], { home });
      if (qualified.code !== 0) {
        throw new Error(`qualify refused:\n${qualified.stderr}\n${qualified.stdout}`);
      }
      // The driver's offline convention: with `FACTORY_EXECUTOR=fake` it passes
      // `--scenario $FACTORY_HOME/scenarios/<unitId>.json` when that file exists. The unit id is only
      // known after submission, so the scenario is written under it here.
      mkdirSync(join(home, 'scenarios'), { recursive: true });
      const scenarioPath = join(home, 'scenarios', `${unitId}.json`);
      writeFileSync(
        scenarioPath,
        `${JSON.stringify(scenarioFor(files ?? unit.fixed, `s-cert-${String(unit.index)}`), null, 2)}\n`,
      );
      return { unitId, scenarioPath };
    },
    cleanup() {
      rmSync(root, { recursive: true, force: true });
    },
  };
}

/** The corpus manifest as the wall's loader will read it (for specs that assert its shape). */
export function readManifest(revisionDir: string): Record<string, unknown> {
  return JSON.parse(readFileSync(join(revisionDir, 'manifest.json'), 'utf8')) as Record<
    string,
    unknown
  >;
}

/** A `file://` URL for a path, so a spec can import a fixture module directly. */
export function fileUrl(path: string): string {
  return pathToFileURL(path).href;
}
