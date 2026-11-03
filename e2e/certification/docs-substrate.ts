/**
 * The certification substrate for the task class `docs-typo-fix`.
 *
 * A class is not certified by a fixture that knows one file. It is certified by
 * accumulating *measured attempts* of the class at an operating point, so the substrate has
 * to produce the thing the wall measures, not the answer to one instance:
 *
 *   1. a **real git repository** whose successive commits each contain a documentation tree
 *      that violates the class's rulebook in the same five ways — a doubled word, a broken
 *      relative link, a duplicated heading, an unbalanced code fence, and a leftover `TODO`.
 *      Every commit is a distinct `baseRev`, which is what makes each unit a separate
 *      *attempt* rather than a re-run of one;
 *   2. a **holdout corpus** under `<root>/docs-typo-fix/<revision>/` whose scenarios assert
 *      the *documentation rules* (they scan the whole tree, not the file a unit touched),
 *      live outside the repository, and are never named in a prompt, an overlay or a launch
 *      record;
 *   3. a **scripted worker** (`FACTORY_EXECUTOR=fake`) that writes the corrected tree, so the
 *      whole pipeline runs offline for nothing. The worker is a stand-in for the model; the
 *      patch, the receipt, the holdout and Δ are all measured by the real wall.
 *
 * The visible check (`tools/check-docs.mjs`, in the repository) covers only a *subset* of the
 * rulebook — doubled words and balanced fences. The holdout covers all five. That asymmetry is
 * the point: a worker can make the visible check green and still fail the class, which is the
 * difference between "the file it touched looks fixed" and "the documentation obeys the rules".
 *
 * This module is test scaffolding, like `e2e/harness/wall-fixture.ts`; it is imported by the
 * specs under `e2e/certification/` and by nothing in `packages/` or `apps/`.
 */
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

import { contentHash } from '../../packages/contracts/src/index.ts';
import { hashableScenarios, type HoldoutScenario } from '../../packages/wall/src/index.ts';
import { jsonOf, runFactory } from '../harness/factory.ts';

/** The task class the corpus is filed under. `FACTORY_HOLDOUT_TASK_CLASS` names it at run time. */
export const TASK_CLASS = 'docs-typo-fix';

/** The repo identity every unit is submitted against; `FACTORY_REPO` must name the same. */
export const REPO_ID = 'docs-fixture';

/** The corpus revision. Opaque to the wall; it exists so a verdict can say what it measured. */
export const HOLDOUT_REVISION = 'h-docs-typo-2026-11-02';

/** The visible check the worker may read and run. Deliberately a *subset* of the rulebook. */
const VISIBLE_CHECK = `#!/usr/bin/env node
/**
 * The repository's own documentation check — the part of the rulebook the worker can see.
 *
 * It covers two of the five class rules on purpose. The holdout measures all five, so a
 * worker that only satisfies what it can read here can still fail the class. Do not "fix"
 * that asymmetry by copying the holdout into this file: the holdout is generator-blind by
 * design (E2E-33) and this file lives inside the tree the worker writes.
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';

const root = process.cwd();
const SKIP = new Set(['node_modules', '.git', 'dist', 'coverage']);

function markdownFiles(dir) {
  const out = [];
  for (const name of readdirSync(dir)) {
    if (SKIP.has(name)) continue;
    const path = join(dir, name);
    const stat = statSync(path);
    if (stat.isDirectory()) out.push(...markdownFiles(path));
    else if (name.endsWith('.md')) out.push(relative(root, path));
  }
  return out.sort();
}

const problems = [];
let checks = 0;
for (const file of markdownFiles(root)) {
  const text = readFileSync(join(root, file), 'utf8');
  checks += 1;
  if (/\\b(\\w+)\\s+\\1\\b/iu.test(text)) problems.push(\`\${file}: doubled word\`);
  if ((text.match(/^\`\`\`/gmu) ?? []).length % 2 !== 0) problems.push(\`\${file}: unbalanced code fence\`);
}

for (const problem of problems) console.log(\`check-docs: \${problem}\`);
const failed = problems.length;
const passed = checks - failed;
const summary = { passed: Math.max(0, passed), failed, unknown: 0, exitCode: failed === 0 ? 0 : 1 };
console.log(\`FACTORY_SUMMARY \${JSON.stringify(summary)}\`);
process.exit(summary.exitCode);
`;

/** The five rule scripts, as strings so each corpus revision carries its own copy. */
const RULES: readonly { readonly id: string; readonly file: string; readonly source: string }[] = [
  {
    id: 'no-doubled-words',
    file: 'no-doubled-words.mjs',
    source: `/**
 * Class rule: no doubled word in any markdown document.
 *
 * This is a rule of the documentation style the class exists to enforce, not a check on the
 * file a unit happened to touch. It scans every .md in the tree, so a unit that fixes its own
 * page and leaves a second doubled word elsewhere fails.
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';

const SKIP = new Set(['node_modules', '.git', 'dist', 'coverage']);
function walk(dir, out) {
  for (const name of readdirSync(dir)) {
    if (SKIP.has(name)) continue;
    const path = join(dir, name);
    if (statSync(path).isDirectory()) walk(path, out);
    else if (name.endsWith('.md')) out.push(path);
  }
  return out;
}

const problems = [];
for (const file of walk(process.cwd(), [])) {
  const text = readFileSync(file, 'utf8');
  const lines = text.split('\\n');
  for (let index = 0; index < lines.length; index += 1) {
    const match = /\\b(\\w+)\\s+\\1\\b/iu.exec(lines[index] ?? '');
    if (match !== null) problems.push(\`\${file}:\${index + 1}: repeated word "\${match[1]}"\`);
  }
}
for (const problem of problems) console.log(\`no-doubled-words: \${problem}\`);
console.log(problems.length === 0 ? 'no-doubled-words: ok' : \`no-doubled-words: \${problems.length} violation(s)\`);
process.exit(problems.length === 0 ? 0 : 1);
`,
  },
  {
    id: 'relative-links-resolve',
    file: 'relative-links-resolve.mjs',
    source: `/**
 * Class rule: every relative link resolves to a file that exists in the tree.
 *
 * A documentation set whose links point nowhere is broken in the way this class exists to
 * repair, and "the link I edited is fine" says nothing about the rest of the set.
 * External URLs and pure in-page anchors are not relative links and are skipped.
 */
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';

const SKIP = new Set(['node_modules', '.git', 'dist', 'coverage']);
function walk(dir, out) {
  for (const name of readdirSync(dir)) {
    if (SKIP.has(name)) continue;
    const path = join(dir, name);
    if (statSync(path).isDirectory()) walk(path, out);
    else if (name.endsWith('.md')) out.push(path);
  }
  return out;
}

const problems = [];
for (const file of walk(process.cwd(), [])) {
  const text = readFileSync(file, 'utf8');
  const lines = text.split('\\n');
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index] ?? '';
    const pattern = /\\]\\(([^)\\s]+)\\)/gu;
    let match;
    while ((match = pattern.exec(line)) !== null) {
      const target = match[1] ?? '';
      if (/^(?:[a-z][a-z0-9+.-]*:|#|\\/\\/)/iu.test(target)) continue;
      const withoutAnchor = target.split('#')[0] ?? '';
      if (withoutAnchor === '') continue;
      const resolved = resolve(dirname(file), withoutAnchor);
      if (!existsSync(resolved)) problems.push(\`\${file}:\${index + 1}: link target "\${target}" does not exist\`);
    }
  }
}
for (const problem of problems) console.log(\`relative-links-resolve: \${problem}\`);
console.log(problems.length === 0 ? 'relative-links-resolve: ok' : \`relative-links-resolve: \${problems.length} violation(s)\`);
process.exit(problems.length === 0 ? 0 : 1);
`,
  },
  {
    id: 'headings-unique',
    file: 'headings-unique.mjs',
    source: `/**
 * Class rule: the same heading text appears at most once per document.
 *
 * Duplicate headings make a table of contents and every anchor ambiguous, which is the
 * documentation defect the class repairs. Measured per file, across the whole tree.
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';

const SKIP = new Set(['node_modules', '.git', 'dist', 'coverage']);
function walk(dir, out) {
  for (const name of readdirSync(dir)) {
    if (SKIP.has(name)) continue;
    const path = join(dir, name);
    if (statSync(path).isDirectory()) walk(path, out);
    else if (name.endsWith('.md')) out.push(path);
  }
  return out;
}

const problems = [];
for (const file of walk(process.cwd(), [])) {
  const seen = new Map();
  const lines = readFileSync(file, 'utf8').split('\\n');
  for (let index = 0; index < lines.length; index += 1) {
    const match = /^(#{1,6})\\s+(.+?)\\s*#*\\s*$/u.exec(lines[index] ?? '');
    if (match === null) continue;
    const text = (match[2] ?? '').toLowerCase().replaceAll(/\\s+/gu, ' ');
    const first = seen.get(text);
    if (first === undefined) seen.set(text, index + 1);
    else problems.push(\`\${file}:\${index + 1}: heading "\${match[2]}" duplicates line \${first}\`);
  }
}
for (const problem of problems) console.log(\`headings-unique: \${problem}\`);
console.log(problems.length === 0 ? 'headings-unique: ok' : \`headings-unique: \${problems.length} violation(s)\`);
process.exit(problems.length === 0 ? 0 : 1);
`,
  },
  {
    id: 'code-fences-balanced',
    file: 'code-fences-balanced.mjs',
    source: `/**
 * Class rule: every fenced code block is closed, per document.
 *
 * An unbalanced fence swallows the rest of the page into a code block, so the defect is
 * invisible to a reader skimming the rendered page and expensive in a support ticket.
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';

const SKIP = new Set(['node_modules', '.git', 'dist', 'coverage']);
function walk(dir, out) {
  for (const name of readdirSync(dir)) {
    if (SKIP.has(name)) continue;
    const path = join(dir, name);
    if (statSync(path).isDirectory()) walk(path, out);
    else if (name.endsWith('.md')) out.push(path);
  }
  return out;
}

const problems = [];
for (const file of walk(process.cwd(), [])) {
  const count = (readFileSync(file, 'utf8').match(/^\`\`\`/gmu) ?? []).length;
  if (count % 2 !== 0) problems.push(\`\${file}: \${count} fence marker(s) — an odd number cannot be balanced\`);
}
for (const problem of problems) console.log(\`code-fences-balanced: \${problem}\`);
console.log(problems.length === 0 ? 'code-fences-balanced: ok' : \`code-fences-balanced: \${problems.length} violation(s)\`);
process.exit(problems.length === 0 ? 0 : 1);
`,
  },
  {
    id: 'no-todo-markers',
    file: 'no-todo-markers.mjs',
    source: `/**
 * Class rule: no unfinished-work marker reaches a documentation set.
 *
 * A \`TODO\` left in published documentation is a promise the page cannot keep. The rule is
 * checked across every document, not only the one a unit edited.
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';

const SKIP = new Set(['node_modules', '.git', 'dist', 'coverage']);
function walk(dir, out) {
  for (const name of readdirSync(dir)) {
    if (SKIP.has(name)) continue;
    const path = join(dir, name);
    if (statSync(path).isDirectory()) walk(path, out);
    else if (name.endsWith('.md')) out.push(path);
  }
  return out;
}

const problems = [];
for (const file of walk(process.cwd(), [])) {
  const lines = readFileSync(file, 'utf8').split('\\n');
  for (let index = 0; index < lines.length; index += 1) {
    if (/\\b(?:TODO|FIXME|XXX)\\b/u.test(lines[index] ?? '')) {
      problems.push(\`\${file}:\${index + 1}: unfinished-work marker\`);
    }
  }
}
for (const problem of problems) console.log(\`no-todo-markers: \${problem}\`);
console.log(problems.length === 0 ? 'no-todo-markers: ok' : \`no-todo-markers: \${problems.length} violation(s)\`);
process.exit(problems.length === 0 ? 0 : 1);
`,
  },
];

export interface DocFile {
  readonly path: string;
  readonly content: string;
}

export interface DocsUnit {
  /** 0-based, and part of every committed tree so the base revisions are distinct. */
  readonly index: number;
  /** The commit the unit is cut from. Distinct per unit — one *attempt* is one paired revision. */
  readonly baseRev: string;
  /** The documentation tree at `baseRev`, as committed (every class rule violated). */
  readonly broken: readonly DocFile[];
  /** What the scripted worker writes to repair the class's violations. */
  readonly fixed: readonly DocFile[];
  /** The scripted worker's scenario (`FACTORY_EXECUTOR=fake` / `--scenario`). */
  readonly scenarioPath: string;
}

export interface DocsSubstrate {
  readonly root: string;
  readonly repo: string;
  /** A bare mirror the attempt clone and every wall scenario run are cut from. */
  readonly mirror: string;
  readonly holdoutRoot: string;
  readonly home: string;
  readonly units: readonly DocsUnit[];
  /** The environment every `factory run` needs: mirror, class, corpus, wall suite. */
  wallEnv(overrides?: Record<string, string | undefined>): Record<string, string>;
  /** Submit one unit and qualify it dark, exactly as an operator would. Returns its unit id. */
  submit(unit: DocsUnit): string;
  cleanup(): void;
}

function git(cwd: string, args: readonly string[]): string {
  return execFileSync('git', [...args], {
    cwd,
    encoding: 'utf8',
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: 'factory-certification',
      GIT_AUTHOR_EMAIL: 'certification@factory.invalid',
      GIT_COMMITTER_NAME: 'factory-certification',
      GIT_COMMITTER_EMAIL: 'certification@factory.invalid',
      GIT_CONFIG_NOSYSTEM: '1',
    },
  }).trim();
}

/**
 * The documentation tree for unit `index`.
 *
 * Each unit is a *different* documentation set — different titles, different prose, the same
 * five class violations. That is what makes twenty attempts twenty samples rather than one
 * attempt replayed twenty times: the holdout is measuring the rulebook against a tree it has
 * not seen before, which is the only thing that lets a passing certificate mean anything.
 */
export function brokenDocs(index: number): readonly DocFile[] {
  return [
    {
      path: 'docs/index.md',
      content: `# Documentation set ${index.toString()}

Welcome to the the documentation set for fixture ${index.toString()}.

- [Guide](./guide.md)
- [Reference](./reference-${index.toString()}.md)

Start with the guide, then read the reference.
`,
    },
    {
      path: 'docs/guide.md',
      content: `# Guide ${index.toString()}

## Steps

First, open the fixture ${index.toString()} project.

## Steps

Then, read the index page for fixture ${index.toString()}.

## Notes

TODO: describe the release process for fixture ${index.toString()}.
`,
    },
    {
      path: 'docs/reference.md',
      content: `# Reference ${index.toString()}

The options for fixture ${index.toString()} are listed below.

\`\`\`
--flag=<value>   set the value
`,
    },
  ];
}

/** The same tree with every one of the five class violations repaired. */
export function fixedDocs(index: number): readonly DocFile[] {
  return [
    {
      path: 'docs/index.md',
      content: `# Documentation set ${index.toString()}

Welcome to the documentation set for fixture ${index.toString()}.

- [Guide](./guide.md)
- [Reference](./reference.md)

Start with the guide, then read the reference.
`,
    },
    {
      path: 'docs/guide.md',
      content: `# Guide ${index.toString()}

## Steps

First, open the fixture ${index.toString()} project.

## Next steps

Then, read the index page for fixture ${index.toString()}.

## Notes

The release process for fixture ${index.toString()} is described in the reference.
`,
    },
    {
      path: 'docs/reference.md',
      content: `# Reference ${index.toString()}

The options for fixture ${index.toString()} are listed below.

\`\`\`
--flag=<value>   set the value
\`\`\`
`,
    },
  ];
}

/** The holdout scenario list, in the frozen `HoldoutScenario` shape. */
export function holdoutScenarios(revisionDir: string): readonly HoldoutScenario[] {
  const scenarios: HoldoutScenario[] = RULES.map((rule) => ({
    id: rule.id,
    taskClass: TASK_CLASS,
    argv: ['node', join(revisionDir, 'rules', rule.file)],
    expectExit: [0],
  }));
  return [...scenarios].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
}

/** Write `<root>/<taskClass>/<revision>/manifest.json` and the rule scripts beside it. */
export function writeHoldoutCorpus(holdoutRoot: string): string {
  const revisionDir = join(holdoutRoot, TASK_CLASS, HOLDOUT_REVISION);
  mkdirSync(join(revisionDir, 'rules'), { recursive: true });
  for (const rule of RULES) {
    writeFileSync(join(revisionDir, 'rules', rule.file), rule.source);
  }
  const scenarios = holdoutScenarios(revisionDir);
  writeFileSync(
    join(revisionDir, 'manifest.json'),
    `${JSON.stringify(
      {
        revision: HOLDOUT_REVISION,
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

/**
 * The repaired tree except the broken relative link: the shape of a plausible-but-wrong patch.
 *
 * A candidate that fixes the doubled words and the code fence — everything the *visible* check
 * can see — and leaves the link broken is exactly the candidate a holdout exists to reject. It is
 * exported so the pipeline spec and the 20-unit loop use one definition of "looks done, is not".
 */
export function almostFixedDocs(index: number): readonly DocFile[] {
  return fixedDocs(index).map((file) =>
    file.path === 'docs/index.md'
      ? {
          path: file.path,
          content: file.content.replace(
            '](./reference.md)',
            `](./reference-${index.toString()}.md)`,
          ),
        }
      : file,
  );
}

/** Write a candidate tree as a scripted-worker scenario, the way `scenarioFor` writes the pass. */
export function writeCandidateScenario(
  path: string,
  unit: DocsUnit,
  docs: readonly DocFile[],
): void {
  writeFileSync(path, `${JSON.stringify(scenarioFor(unit, docs), null, 2)}\n`);
}

function scenarioFor(unit: DocsUnit, fixed: readonly DocFile[]): unknown {
  return {
    steps: [
      ...fixed.map((file) => ({ kind: 'write', path: file.path, content: file.content })),
      // The visible check: a subset of the rulebook, printed as a machine-readable summary so
      // the wall's pinned suite can read it.
      { kind: 'command', argv: ['node', 'tools/check-docs.mjs'] },
      {
        kind: 'emit',
        events: [
          { type: 'session', sessionId: `s-cert-${unit.index.toString()}` },
          { type: 'turn_end', reason: { kind: 'completed' } },
        ],
      },
      { kind: 'exit', code: 0 },
    ],
  };
}

export interface DocsSubstrateOptions {
  /** How many distinct base revisions to build. Defaults to 20 — the ratification's m. */
  readonly units?: number;
}

export function createDocsSubstrate(options: DocsSubstrateOptions = {}): DocsSubstrate {
  const count = options.units ?? 20;
  if (!Number.isInteger(count) || count < 1) throw new RangeError('units must be positive');

  const root = mkdtempSync(join(tmpdir(), 'factory-certification-'));
  const repo = join(root, 'repo');
  const home = join(root, 'home');
  mkdirSync(join(repo, 'docs'), { recursive: true });
  mkdirSync(join(repo, 'tools'), { recursive: true });
  mkdirSync(join(home, 'scenarios'), { recursive: true });

  // Everything that is not the documentation tree is identical in every revision: the SUT's
  // own visible check and the project skeleton. Only `docs/` changes between base revisions,
  // so the worker's patch is always "a documentation correction".
  writeFileSync(
    join(repo, 'package.json'),
    `${JSON.stringify({ name: 'docs-fixture', private: true, type: 'module' }, null, 2)}\n`,
  );
  writeFileSync(
    join(repo, 'README.md'),
    '# docs-fixture\n\nA documentation set used by the certification suite.\n',
  );
  writeFileSync(join(repo, 'tools', 'check-docs.mjs'), VISIBLE_CHECK);

  git(repo, ['init', '-q', '-b', 'main']);

  const units: DocsUnit[] = [];
  for (let index = 0; index < count; index += 1) {
    const broken = brokenDocs(index);
    for (const file of broken) {
      mkdirSync(dirname(join(repo, file.path)), { recursive: true });
      writeFileSync(join(repo, file.path), file.content);
    }
    git(repo, ['add', '-A']);
    git(repo, [
      'commit',
      '-q',
      '-m',
      `base ${index.toString()}: documentation with the class's five defects`,
    ]);
    const baseRev = git(repo, ['rev-parse', 'HEAD']);
    const unit: DocsUnit = {
      index,
      baseRev,
      broken,
      fixed: fixedDocs(index),
      scenarioPath: join(home, 'scenarios', `unit-${index.toString()}.json`),
    };
    writeFileSync(unit.scenarioPath, `${JSON.stringify(scenarioFor(unit, unit.fixed), null, 2)}\n`);
    units.push(unit);
  }

  const mirror = join(root, 'mirror.git');
  execFileSync('git', ['clone', '--mirror', '--quiet', repo, mirror], { encoding: 'utf8' });

  const holdoutRoot = join(root, 'holdout');
  writeHoldoutCorpus(holdoutRoot);

  const substrate: DocsSubstrate = {
    root,
    repo,
    mirror,
    holdoutRoot,
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
        FACTORY_TEST_ROOT: 'tests',
        FACTORY_WALL_SUITE: 'node tools/check-docs.mjs',
        // Recorded on the certificate so a later model change is detectable rather than
        // inferred. The offline proof is not a model; the fixture says so.
        FACTORY_MODEL_ID: 'fixture/offline-scripted-worker',
      };
      for (const [key, value] of Object.entries(overrides)) {
        if (value === undefined) delete env[key];
        else env[key] = value;
      }
      return env;
    },
    submit(unit) {
      if (unit.index < 0 || unit.index >= units.length) {
        throw new RangeError(`unit ${String(unit.index)} is outside this substrate`);
      }
      const spec = {
        slug: TASK_CLASS,
        revision: unit.index + 1,
        repo: REPO_ID,
        baseRev: unit.baseRev,
        // The restate-back check is a token-overlap floor (0.5), so the restatement has to
        // name the same task in the same words: that is what the signal measures, and a
        // paraphrase with a disjoint vocabulary is a different unit.
        intent:
          `Repair the documentation for fixture ${unit.index.toString()}: a repeated word, a broken ` +
          'relative link, a duplicated heading, an unclosed code fence and a leftover TODO.',
        restateBack:
          `You asked for: repair the documentation for fixture ${unit.index.toString()} — a repeated ` +
          'word, a broken relative link, a duplicated heading, an unclosed code fence and a leftover ' +
          'TODO. Not asking for: a code change or a dependency upgrade.',
        acceptance: [
          {
            id: 'docs-check',
            text: 'node tools/check-docs.mjs exits 0',
            oracle: { kind: 'command', target: 'node tools/check-docs.mjs', expect: 'exit 0' },
          },
        ],
        touchPaths: ['docs/'],
        operationClasses: ['code-change'],
        sizeBudget: { files: 8, lines: 200 },
        budgetEstimateUsd: 0.05,
      };
      const specPath = join(home, `spec-${String(spec.revision)}.json`);
      writeFileSync(specPath, `${JSON.stringify(spec, null, 2)}\n`);
      const restatePath = join(home, `restate-${String(spec.revision)}.md`);
      writeFileSync(restatePath, `${String(spec.restateBack)}\n`);
      const submitted = runFactory(
        ['intent', '--file', specPath, '--restate', restatePath, '--json'],
        { home },
      );
      if (submitted.code !== 0) {
        throw new Error(`intent refused:\n${submitted.stderr}\n${submitted.stdout}`);
      }
      const unitId = String(jsonOf(submitted)['unitId']);
      const qualified = runFactory(['qualify', unitId, '--cold-start', '--json'], { home });
      if (qualified.code !== 0) {
        throw new Error(`qualify refused:\n${qualified.stderr}\n${qualified.stdout}`);
      }
      // The driver's offline convention: with `FACTORY_EXECUTOR=fake` it passes
      // `--scenario $FACTORY_HOME/scenarios/<unitId>.json` when that file exists. The unit id is
      // only known after submission, so the scenario is copied under it here.
      mkdirSync(join(home, 'scenarios'), { recursive: true });
      writeFileSync(
        join(home, 'scenarios', `${unitId}.json`),
        readFileSync(unit.scenarioPath, 'utf8'),
      );
      return unitId;
    },
    cleanup() {
      rmSync(root, { recursive: true, force: true });
    },
  };

  return substrate;
}
