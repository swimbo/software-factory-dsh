/**
 * The *persistent* certification artefacts: the tree, the corpus and the planner a live loop runs
 * against, built from this repository's own documentation.
 *
 * `docs-substrate.ts` is the same idea at test scale: a throwaway repository whose prose is
 * invented, so the spec that proves the certificate flips costs nothing and leaves nothing behind.
 * A live loop cannot use it. Twenty paid attempts have to be measured against a tree that is
 * *plausible* — real markdown, real defects, a real history — and the operator has to be able to
 * find the evidence a week later, which a `mkdtemp` fixture is not. This module materialises that
 * tree at a path the operator chooses (`~/.factory/certification` by default):
 *
 *   1. `<root>/docs` — a git repository holding a **copy of this repository's `docs/` markdown as
 *      it stands today**, with five class violations planted into a rotating set of three files on
 *      each of twenty commits. The prose is the repository's own; the defects are deliberate and
 *      named in the README, because a claim about "docs repair" measured on lorem ipsum would be a
 *      claim about lorem ipsum;
 *   2. `<root>/docs.git` — the bare mirror the wall clones as `FACTORY_PRISTINE_REPO`;
 *   3. `<root>/holdout/docs-typo-fix/<revision>/` — the class corpus. It is the **same five rule
 *      scripts** the fixture uses (`HOLDOUT_RULES`), so both substrates measure one rulebook, under
 *      a distinct revision token so a store measured on invented docs and one measured on the real
 *      tree can never be confused;
 *   4. `<root>/spec-1.json … spec-N.json`, `<root>/restate.md` and `<root>/plan-units.sh` — the
 *      planner, emitted rather than executed: submitting a unit writes the store, and materialising
 *      artefacts must stay a free, idempotent, store-free operation;
 *   5. `<root>/README.md` — what each piece is, why the corpus is invisible to the worker, and that
 *      the whole thing is disposable.
 *
 * The build **refuses to finish** if a rule stops discriminating: every planted revision must fail
 * all five rules, and the repaired tree (the pristine docs) must pass all five. A corpus that
 * passes a defective tree, or fails a repaired one, cannot certify anything — it would certify
 * whatever the worker happened to write.
 *
 * This module is imported by `e2e/certification/artifacts.test.ts` and by
 * `e2e/certification/artifacts-main.ts`, which `scripts/certification-artifacts.sh` runs. Nothing in
 * `packages/` or `apps/` imports it.
 */
import { execFileSync } from 'node:child_process';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { basename, dirname, isAbsolute, join, relative, resolve } from 'node:path';

import { assertHoldoutOutsideRepo, loadHoldout } from '../../packages/wall/src/index.ts';
import { HOLDOUT_RULES, TASK_CLASS, VISIBLE_CHECK, writeHoldoutCorpus } from './docs-substrate.ts';

/** The marker that identifies a directory as artefacts this module may rebuild. */
export const ARTEFACT_MARKER_FILE = 'certification-artifacts.json';

/** The marker's `kind`. A directory without it is not ours, and is never deleted. */
export const ARTEFACT_KIND = 'factory-certification-artifacts';

/** The marker's schema version. */
export const ARTEFACT_VERSION = 1;

/** The repository identity every spec is submitted against; `FACTORY_REPO` names the same. */
export const ARTEFACT_REPO_ID = 'docs-certification';

/**
 * The corpus token recorded on every verdict measured against the real tree.
 *
 * Deliberately different from the fixture's `h-docs-typo-2026-11-02`: the rules are the same, the
 * trees are not, and a verdict that cannot say which tree it measured is a verdict about nothing.
 */
export const ARTEFACT_HOLDOUT_REVISION = 'h-docs-typo-real-2026-11-02';

/** How many distinct bases a certificate needs: the ratified `m`. */
export const DEFAULT_REVISIONS = 20;

/**
 * The fewest real documents the build will proceed with.
 *
 * Filtering removes files that already broke a class rule before anything was planted (this
 * repository's planning documents really do link to files that do not exist). If so much of the
 * tree has to be dropped that fewer than this remain, the fixture would be a handful of pages
 * pretending to be a documentation set and the build refuses instead.
 */
export const MIN_DOCUMENTS = 6;

/** Directories the rule scripts skip; kept in step with `HOLDOUT_RULES` by construction. */
const SKIP_DIRS = new Set(['.git', 'node_modules', 'dist', 'coverage']);

/** How many times filtering may re-run the rules while dropping non-conforming documents. */
const MAX_FILTER_ROUNDS = 12;

/** One document, relative to the artefacts repository root. */
export interface ArtefactDoc {
  readonly path: string;
  readonly content: string;
}

/** One commit of the artefacts repository, and the documents its defects were planted into. */
export interface ArtefactRevision {
  /** 1-based; also `spec.revision`, because the store's unit identity is `(repo, slug, revision)`. */
  readonly index: number;
  /** The commit's sha: what a unit's `baseRev` names and what the wall checks out. */
  readonly commit: string;
  /** The documents this revision planted defects into. */
  readonly plantedIn: readonly string[];
}

export interface Artefacts {
  readonly root: string;
  /** `<root>/docs` — the git repository the worker edits. */
  readonly repo: string;
  /** `<root>/docs.git` — the `--mirror` clone the wall reads as `FACTORY_PRISTINE_REPO`. */
  readonly mirror: string;
  readonly holdoutRoot: string;
  /** The corpus revision directory (`<holdoutRoot>/<TASK_CLASS>/<revision>`). */
  readonly holdoutRevision: string;
  /** `<root>/home` — the `FACTORY_HOME` the store will be created in. */
  readonly home: string;
  readonly taskClass: string;
  readonly repoId: string;
  readonly revisions: readonly ArtefactRevision[];
  /** The documents that survived filtering, relative to the repository root. */
  readonly documents: readonly string[];
  /** Documents dropped because they already violated a class rule before anything was planted. */
  readonly dropped: readonly string[];
  /** The source checkout this was built from, and its HEAD, when it has one. */
  readonly sourceRoot: string;
  readonly sourceCommit: string | null;
  /** ISO-8601, supplied by the caller: this module never reads a clock (discipline-lint rule 5). */
  readonly createdAt: string | null;
}

export interface ArtefactsOptions {
  readonly root: string;
  readonly sourceRoot: string;
  /** Distinct bases to build. Defaults to `DEFAULT_REVISIONS`. */
  readonly revisions?: number;
  readonly createdAt?: string;
  readonly sourceCommit?: string;
  /** One line per phase, so the operator sees the build thinking rather than hanging. */
  readonly onProgress?: (line: string) => void;
}

interface ProcessResult {
  readonly code: number;
  readonly stdout: string;
  readonly stderr: string;
}

/**
 * Run a command and return its exit code instead of throwing.
 *
 * Every check in this module is "did the rule exit non-zero", so a helper that turns a non-zero
 * exit into a value is what keeps the control flow honest: no `try`/`catch` around an assertion.
 */
function runProcess(argv: readonly string[], cwd: string, env?: NodeJS.ProcessEnv): ProcessResult {
  const [executable, ...args] = argv;
  if (executable === undefined) throw new Error('runProcess needs an executable');
  try {
    return {
      code: 0,
      stdout: execFileSync(executable, args, {
        cwd,
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'pipe'],
        maxBuffer: 64 * 1024 * 1024,
        ...(env === undefined ? {} : { env }),
      }),
      stderr: '',
    };
  } catch (error) {
    const failed = error as { status?: number; stdout?: string | Buffer; stderr?: string | Buffer };
    return {
      code: typeof failed.status === 'number' ? failed.status : 1,
      stdout: String(failed.stdout ?? ''),
      stderr: String(failed.stderr ?? ''),
    };
  }
}

/**
 * `git` with the operator's global config out of the way.
 *
 * A machine with `commit.gpgsign = true` or a `core.hooksPath` would otherwise turn a free build
 * into a signing prompt or a hook that runs someone else's script. The artefacts are a disposable
 * repository; their history has to be reproducible without a key.
 */
function git(cwd: string, args: readonly string[]): string {
  const result = runProcess(
    [
      'git',
      '-c',
      'user.name=factory-certification',
      '-c',
      'user.email=certification@factory.invalid',
      '-c',
      'commit.gpgsign=false',
      '-c',
      'core.hooksPath=/dev/null',
      ...args,
    ],
    cwd,
    gitEnv(),
  );
  if (result.code !== 0) {
    throw new Error(`git ${args.join(' ')} failed in ${cwd}: ${result.stderr.trim()}`);
  }
  return result.stdout.trim();
}

/** The env a git subprocess gets: no global/system config, fixed identity, no interactive prompts. */
function gitEnv(): NodeJS.ProcessEnv {
  return {
    ...process.env,
    GIT_CONFIG_GLOBAL: '/dev/null',
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_TERMINAL_PROMPT: '0',
  };
}

/**
 * The real path of a target that may not exist yet.
 *
 * `/tmp` is a symlink to `/private/tmp` on macOS, and the rule scripts report paths derived from
 * `process.cwd()`, which is the *real* path. Comparing that against the path the caller typed makes
 * every violation look like it came from outside the tree, which the filter would then ignore — a
 * filter that silently drops nothing is worse than no filter. Resolve both sides into the same space.
 */
function realPath(target: string): string {
  const absolute = resolve(target);
  const pending: string[] = [];
  let current = absolute;
  for (;;) {
    try {
      const real = realpathSync(current);
      return pending.length === 0 ? real : join(real, ...pending.reverse());
    } catch {
      const parent = dirname(current);
      if (parent === current) return absolute;
      pending.push(basename(current));
      current = parent;
    }
  }
}

/** Byte-order comparison. `localeCompare` would pick a different file set on a different host. */
function compareCodeUnits(a: string, b: string): number {
  if (a === b) return 0;
  return a < b ? -1 : 1;
}

/** Every markdown file under `dir`, recursive, sorted. Paths are relative to `root`. */
function markdownFiles(dir: string, root: string, out: string[]): string[] {
  if (!existsSync(dir)) return out;
  const names = readdirSync(dir).sort(compareCodeUnits);
  for (const name of names) {
    if (SKIP_DIRS.has(name)) continue;
    const path = join(dir, name);
    if (statSync(path).isDirectory()) markdownFiles(path, root, out);
    else if (name.endsWith('.md')) out.push(relative(root, path));
  }
  return out;
}

/**
 * Resolve `<tree>/<path>` and refuse anything that escapes the tree.
 *
 * The paths come from a directory listing of a checkout, and a relative path computed against the
 * wrong root resolves to a real file. That is not a hypothetical: the first build of this module
 * wrote its planted defects into three files of the source checkout, silently, because `relative()`
 * had been taken against the artefacts repository instead of the repository being copied. A build
 * that deletes what it was asked to copy is the worst failure this file can have, so every write and
 * every delete goes through this check.
 */
function insideTree(tree: string, path: string): string {
  const target = resolve(tree, path);
  const rel = relative(realPath(tree), realPath(target));
  if (rel === '' || rel.startsWith('..') || isAbsolute(rel)) {
    throw new Error(`refusing to touch ${target}: it is outside ${resolve(tree)}`);
  }
  return target;
}

/** Every markdown file under `tree`, relative to `tree`. Public so the spec can count documents. */
export function markdownFilesIn(tree: string): string[] {
  return markdownFiles(tree, tree, []).sort(compareCodeUnits);
}

/** Write `<tree>/<path>`, creating parents. */
function writeTreeFile(tree: string, path: string, content: string): void {
  const target = insideTree(tree, path);
  mkdirSync(dirname(target), { recursive: true });
  writeFileSync(target, content);
}

/** Read every document from the source checkout's `docs/` directory. */
function readSourceDocs(sourceRoot: string): ArtefactDoc[] {
  const docsRoot = join(sourceRoot, 'docs');
  if (!existsSync(docsRoot)) {
    throw new Error(`no documentation to copy: ${docsRoot} does not exist (pass --source <repo>)`);
  }
  const paths = markdownFiles(docsRoot, sourceRoot, []);
  if (paths.length === 0) throw new Error(`no markdown under ${docsRoot}`);
  return paths.map((path) => ({ path, content: readFileSync(join(sourceRoot, path), 'utf8') }));
}

/**
 * The files a rule's output names, as paths relative to `tree`.
 *
 * Every rule prints `<absolute path>[:<line>]: <message>`; the absolute path is what separates the
 * rule from a regex over the tree in this process, and parsing it is how the filter reuses the
 * *same* implementation the wall will run rather than a second, possibly diverging one.
 */
function violatedFiles(stdout: string, tree: string): string[] {
  const found = new Set<string>();
  for (const line of stdout.split('\n')) {
    // A rule prints `<rule id>: <absolute path>[:<line>]: <message>`, so the path is the first
    // absolute `.md` path on the line, not the start of the line.
    const match = /(\/[^\n]*?\.md):/u.exec(line);
    if (match === null) continue;
    const absolute = match[1];
    if (absolute === undefined) continue;
    const rel = relative(realPath(tree), realPath(resolve(tree, absolute)));
    if (rel === '' || rel.startsWith('..') || isAbsolute(rel)) continue;
    found.add(rel);
  }
  return [...found].sort(compareCodeUnits);
}

/** Run one holdout rule against `tree`; returns the rule's exit code and output. */
function runRule(rulesDir: string, ruleFile: string, tree: string): ProcessResult {
  return runProcess([process.execPath, join(rulesDir, ruleFile)], tree);
}

/** Run the repository's visible check (the subset the worker may see) against `tree`. */
function runVisibleCheck(tree: string): ProcessResult {
  return runProcess([process.execPath, join(tree, 'tools', 'check-docs.mjs')], tree);
}

/** The `FACTORY_SUMMARY` object the visible check prints, or `null` when it printed none. */
function visibleSummary(stdout: string): { failed?: number; exitCode?: number } | null {
  const line = stdout
    .split('\n')
    .reverse()
    .find((candidate) => candidate.startsWith('FACTORY_SUMMARY '));
  if (line === undefined) return null;
  try {
    const parsed: unknown = JSON.parse(line.slice('FACTORY_SUMMARY '.length));
    if (typeof parsed === 'object' && parsed !== null) return parsed as { failed?: number };
    return null;
  } catch {
    return null;
  }
}

/**
 * Drop documents that already broke a class rule, then assert the remainder passes every rule.
 *
 * This repository's own `docs/` is not a certified documentation set — thirty relative links in
 * `docs/planning/` point at files that are not there. Copying them verbatim and planting defects on
 * top would make the *repair* impossible (the repaired tree would still fail the link rule), so the
 * build filters instead: run the five rules, drop every document they name, repeat until clean.
 * Dropping a document can break a link that pointed at it, which is why this iterates.
 *
 * A violation attributed to `README.md` is a bug in this generator, not in the source tree — it is
 * thrown rather than filtered, because silently dropping a file this module wrote would hide it.
 */
export function filterNonConforming(
  tree: string,
  documents: readonly ArtefactDoc[],
  rulesDir: string,
  onProgress: (line: string) => void,
): { readonly kept: readonly ArtefactDoc[]; readonly dropped: readonly string[] } {
  let kept = [...documents];
  const dropped: string[] = [];
  for (let round = 0; round < MAX_FILTER_ROUNDS; round += 1) {
    const offenders = new Set<string>();
    for (const rule of HOLDOUT_RULES) {
      const result = runRule(rulesDir, rule.file, tree);
      for (const file of violatedFiles(result.stdout, tree)) offenders.add(file);
    }
    if (offenders.size === 0) return { kept, dropped };
    const removable = kept.filter((doc) => offenders.has(doc.path));
    if (removable.length === 0) {
      throw new Error(
        `a class rule fails on the document tree and names no document this build may drop: ` +
          `${[...offenders].join(', ')}`,
      );
    }
    for (const doc of removable) {
      rmSync(insideTree(tree, doc.path), { force: true });
      dropped.push(doc.path);
    }
    kept = kept.filter((doc) => !offenders.has(doc.path));
    onProgress(
      `artifacts: dropped ${removable.length.toString()} document(s) that already broke a class ` +
        `rule: ${removable.map((doc) => doc.path).join(', ')}`,
    );
    if (kept.length < MIN_DOCUMENTS) {
      throw new Error(
        `only ${kept.length.toString()} document(s) survived filtering; fewer than ` +
          `${MIN_DOCUMENTS.toString()} would not be a documentation set worth certifying`,
      );
    }
  }
  throw new Error(`filtering did not converge after ${MAX_FILTER_ROUNDS.toString()} rounds`);
}

/**
 * Plant the five class violations of revision `index` into three documents.
 *
 * The defects are the class's own rulebook, one per rule, in the shape a real repair produces a
 * diff for: a doubled word inside a real sentence, a "see also" link to a page that was never
 * written, a section copied under a heading that already exists, an opening fence with no closing
 * one, and an unfinished-work marker. Rotation over the surviving documents is what makes twenty
 * attempts twenty *trees* rather than one tree replayed.
 */
export function plantDefects(
  documents: readonly ArtefactDoc[],
  index: number,
): { readonly docs: readonly ArtefactDoc[]; readonly plantedIn: readonly string[] } {
  const count = documents.length;
  if (count < MIN_DOCUMENTS) throw new RangeError(`need at least ${MIN_DOCUMENTS} documents`);
  // Three positions a third of the pool apart, rotated by one per revision. With six or more
  // documents the three are distinct, and consecutive revisions plant into different files.
  const firstIndex = (index - 1) % count;
  const secondIndex = (firstIndex + Math.floor(count / 3)) % count;
  const thirdIndex = (firstIndex + Math.floor((2 * count) / 3)) % count;
  const plant = new Map<number, (content: string) => string>();
  plant.set(firstIndex, (content) => unclosedFence(doubleWord(content)));
  plant.set(secondIndex, (content) => leftoverTodo(brokenLink(content, index), index));
  plant.set(thirdIndex, (content) => duplicateHeading(content, index));
  const docs = documents.map((doc, position) => {
    const transform = plant.get(position);
    return transform === undefined ? doc : { path: doc.path, content: transform(doc.content) };
  });
  const plantedIn = [...plant.keys()]
    .map((position) => documents[position]?.path)
    .filter((path): path is string => path !== undefined)
    .sort(compareCodeUnits);
  return { docs, plantedIn };
}

/** A doubled word inside a real sentence — the typo the class exists to repair. */
function doubleWord(content: string): string {
  const lines = content.split('\n');
  for (let position = 0; position < lines.length; position += 1) {
    const line = lines[position] ?? '';
    if (/^\s*(?:#{1,6}\s|```|\||>|[*+-]\s| {4,})/u.test(line)) continue;
    if (line.length < 60) continue;
    if (/[`[\]<>]/u.test(line)) continue;
    const at = line.indexOf(' the ');
    if (at === -1) continue;
    lines[position] = `${line.slice(0, at)} the the ${line.slice(at + ' the '.length)}`;
    return lines.join('\n');
  }
  // No sentence to corrupt: append one that reads like a stale copy-paste.
  return `${content.trimEnd()}\n\nThe note was was copied from the old page.\n`;
}

/** An opening fence with no closing fence: the rest of the page is swallowed. */
function unclosedFence(content: string): string {
  return `${content.trimEnd()}\n\n\`\`\`bash\nmake docs\n`;
}

/** A "see also" link whose target was never written: exactly the shape of a broken docs set. */
function brokenLink(content: string, index: number): string {
  return `${content.trimEnd()}\n\nSee [the reference](./reference-${index.toString()}.md) for the details.\n`;
}

/** A section copied under a heading the page already uses. */
function duplicateHeading(content: string, index: number): string {
  return (
    `${content.trimEnd()}\n\n## Steps\n\n1. Open the page for revision ${index.toString()}.\n\n` +
    '## Steps\n\n1. Close the page when the check is green.\n'
  );
}

/** An unfinished-work marker in published documentation. */
function leftoverTodo(content: string, index: number): string {
  return `${content.trimEnd()}\n\nTODO: replace the example in revision ${index.toString()} with a real one.\n`;
}

/** Assert every rule fails on the tree at `tree`; returns the rules that passed (must be none). */
function rulesPassing(tree: string, rulesDir: string): string[] {
  const passing: string[] = [];
  for (const rule of HOLDOUT_RULES) {
    const result = runRule(rulesDir, rule.file, tree);
    if (result.code === 0) passing.push(rule.id);
  }
  return passing;
}

/** Assert the visible check fails on `tree`, with a summary that says so. */
function visibleCheckFails(tree: string): boolean {
  const result = runVisibleCheck(tree);
  if (result.code === 0) return false;
  const summary = visibleSummary(result.stdout);
  return summary !== null && (summary.failed ?? 0) > 0;
}

/**
 * Build the artefacts at `options.root`.
 *
 * Refuses rather than guesses: a root inside the source repository (the holdout would be reachable
 * by the worker), a non-empty directory that is not previous artefacts (the build deletes what it
 * rebuilds, so it may only delete its own), a revision count below `MIN_DOCUMENTS`, and any corpus
 * whose rules stop discriminating.
 */
export function materializeArtifacts(options: ArtefactsOptions): Artefacts {
  const progress = options.onProgress ?? ((): void => {});
  const root = resolve(options.root);
  const sourceRoot = resolve(options.sourceRoot);
  const revisions = options.revisions ?? DEFAULT_REVISIONS;
  if (!Number.isInteger(revisions) || revisions < 1) {
    throw new RangeError(`--revisions must be a positive integer, got ${String(revisions)}`);
  }
  const relToSource = relative(sourceRoot, root);
  if (relToSource === '' || (!relToSource.startsWith('..') && !isAbsolute(relToSource))) {
    throw new Error(
      `the artefacts root must live outside the repository: ${root} is inside ${sourceRoot}`,
    );
  }
  if (existsSync(root)) {
    const entries = readdirSync(root);
    const marker = join(root, ARTEFACT_MARKER_FILE);
    if (entries.length > 0 && !existsSync(marker)) {
      throw new Error(
        `${root} is not empty and is not a previous artefacts root (no ${ARTEFACT_MARKER_FILE}); ` +
          'refusing to delete a directory this build did not create',
      );
    }
    rmSync(root, { recursive: true, force: true });
  }
  mkdirSync(root, { recursive: true });

  const repo = join(root, 'docs');
  const mirror = join(root, 'docs.git');
  const holdoutRoot = join(root, 'holdout');
  const home = join(root, 'home');
  mkdirSync(home, { recursive: true });
  // The holdout must be outside the repository the worker can write. The wall asserts this at
  // measurement time; asserting it at build time is what stops a corpus being built in a place
  // that cannot be used.
  assertHoldoutOutsideRepo(holdoutRoot, repo);

  const holdoutRulesDir = writeHoldoutCorpus(holdoutRoot, ARTEFACT_HOLDOUT_REVISION);
  const rulesDir = join(holdoutRulesDir, 'rules');
  const corpus = loadHoldout(holdoutRoot, TASK_CLASS);
  if (corpus === null || corpus.revision !== ARTEFACT_HOLDOUT_REVISION) {
    throw new Error(`the corpus just written does not load: ${holdoutRulesDir}`);
  }
  progress(
    `artifacts: corpus ${TASK_CLASS}@${corpus.revision} with ` +
      `${corpus.scenarios.length.toString()} rule(s) at ${holdoutRoot}`,
  );

  // The artefacts repository mirrors the source layout: `<root>/docs/docs/…` is the copy of
  // `<checkout>/docs/…`. Keeping `doc.path` as-is (relative to the source *tree*) is what makes
  // every write land inside the artefacts repository.
  const documents: ArtefactDoc[] = readSourceDocs(sourceRoot).map((doc) => ({
    path: doc.path,
    content: doc.content,
  }));
  mkdirSync(join(repo, 'tools'), { recursive: true });
  writeFileSync(join(repo, 'tools', 'check-docs.mjs'), VISIBLE_CHECK);
  progress(
    `artifacts: copying ${documents.length.toString()} markdown file(s) from ${join(sourceRoot, 'docs')}`,
  );

  // Write once, then let the filter delete what cannot pass; a dropped document is never rewritten.
  for (const doc of documents) writeTreeFile(repo, doc.path, doc.content);
  const written = markdownFiles(repo, repo, []);
  if (written.length !== documents.length) {
    throw new Error(
      `wrote ${documents.length.toString()} document(s) but ${written.length.toString()} are in ` +
        `${repo}: the artefacts repository is not a copy of the source tree`,
    );
  }
  const filtered = filterNonConforming(repo, documents, rulesDir, progress);
  if (filtered.kept.length < MIN_DOCUMENTS) {
    throw new Error(`only ${filtered.kept.length.toString()} document(s) survived filtering`);
  }

  // The repaired tree must pass every rule, or the class could never be certified no matter what
  // the worker wrote. This is the assertion that makes the corpus a measurement rather than a wish.
  const passingOnRepair = rulesPassing(repo, rulesDir);
  if (passingOnRepair.length !== HOLDOUT_RULES.length) {
    throw new Error(
      `the repaired tree fails ${passingOnRepair.join(', ')}: a defect planted at build time ` +
        'cannot be repaired by deleting the planted text, so the corpus would certify nothing',
    );
  }
  if (!visibleCheckPasses(repo)) {
    throw new Error('the repaired tree does not pass its own visible check');
  }
  progress(
    `artifacts: repaired tree passes all ${HOLDOUT_RULES.length.toString()} rule(s) and the ` +
      'visible check',
  );

  git(repo, ['init', '--quiet']);
  git(repo, ['add', '--all']);
  git(repo, ['commit', '--quiet', '--message', 'docs: the documentation set as it stands']);
  const pristine = git(repo, ['rev-parse', 'HEAD']);

  const built: ArtefactRevision[] = [];
  const pristineContent = new Map(filtered.kept.map((doc) => [doc.path, doc.content]));
  let previousPlanted: readonly string[] = [];
  for (let index = 1; index <= revisions; index += 1) {
    // Every base is *pristine plus five*, not a growing pile. Revisions are independent snapshots of
    // the same documentation set, because the wall clones one base per unit and the intent says five
    // defects: a tenth base that quietly carried fifty defects would be a different task class.
    for (const path of previousPlanted) {
      const original = pristineContent.get(path);
      if (original !== undefined) writeTreeFile(repo, path, original);
    }
    const planted = plantDefects(filtered.kept, index);
    previousPlanted = planted.plantedIn;
    for (const doc of planted.docs) {
      const before = filtered.kept.find((candidate) => candidate.path === doc.path);
      if (before === undefined || before.content === doc.content) continue;
      writeTreeFile(repo, doc.path, doc.content);
    }
    git(repo, ['add', '--all']);
    git(repo, ['commit', '--quiet', '--message', `docs: revision ${index.toString()}`]);
    const commit = git(repo, ['rev-parse', 'HEAD']);
    if (commit === pristine) throw new Error(`revision ${index.toString()} made no change`);

    const passing = rulesPassing(repo, rulesDir);
    if (passing.length !== 0) {
      throw new Error(
        `revision ${index.toString()} does not violate ${passing.join(', ')}: the planted defects ` +
          'stopped discriminating, so a passing verdict on this base would prove nothing',
      );
    }
    if (!visibleCheckFails(repo)) {
      throw new Error(
        `revision ${index.toString()} does not fail the visible check: the worker could mistake ` +
          'a broken tree for a repaired one',
      );
    }
    built.push({ index, commit, plantedIn: planted.plantedIn });
  }
  progress(
    `artifacts: ${built.length.toString()} revision(s) each violate all ` +
      `${HOLDOUT_RULES.length.toString()} rule(s); the repair target passes them`,
  );

  git(root, ['clone', '--quiet', '--mirror', repo, mirror]);
  for (const revision of built) {
    const exists = runProcess(['git', 'cat-file', '-e', `${revision.commit}^{commit}`], mirror);
    if (exists.code !== 0) {
      throw new Error(`revision ${revision.index.toString()} is not in the mirror ${mirror}`);
    }
  }

  // The corpus must be unreachable from the repository: not a file in it, not a line in its
  // history. The wall anonymises scenario ids too, but this is the half that a build can prove.
  if (existsSync(join(repo, 'holdout'))) {
    throw new Error('the holdout was written inside the artefacts repository');
  }
  const leaked = runProcess(['git', 'grep', '--fixed-strings', '--quiet', holdoutRoot], repo);
  if (leaked.code === 0) {
    throw new Error(`the repository's history mentions the holdout path ${holdoutRoot}`);
  }

  const artefacts: Artefacts = {
    root,
    repo,
    mirror,
    holdoutRoot,
    holdoutRevision: ARTEFACT_HOLDOUT_REVISION,
    home,
    taskClass: TASK_CLASS,
    repoId: ARTEFACT_REPO_ID,
    revisions: built,
    documents: filtered.kept.map((doc) => doc.path).sort(compareCodeUnits),
    dropped: [...filtered.dropped].sort(compareCodeUnits),
    sourceRoot,
    sourceCommit:
      options.sourceCommit === undefined || options.sourceCommit.trim() === ''
        ? null
        : options.sourceCommit.trim(),
    createdAt: options.createdAt ?? null,
  };

  writeArtefactFiles(artefacts);
  writeFileSync(
    join(root, ARTEFACT_MARKER_FILE),
    `${JSON.stringify(markerOf(artefacts), null, 2)}\n`,
  );
  return artefacts;
}

/** The visible check passes (exit 0) on `tree`. */
function visibleCheckPasses(tree: string): boolean {
  return runVisibleCheck(tree).code === 0;
}

/** The marker contents: what this directory is, where it came from, and when. */
export function markerOf(artefacts: Artefacts): unknown {
  return {
    kind: ARTEFACT_KIND,
    version: ARTEFACT_VERSION,
    sourceRoot: artefacts.sourceRoot,
    sourceCommit: artefacts.sourceCommit,
    taskClass: artefacts.taskClass,
    repoId: artefacts.repoId,
    holdoutRevision: artefacts.holdoutRevision,
    revisions: artefacts.revisions.length,
    documents: artefacts.documents.length,
    dropped: artefacts.dropped.length,
    createdAt: artefacts.createdAt,
    note: 'Disposable. Rebuilding deletes this directory; the store is not in it.',
  };
}

/** The `restateBack` sentence every spec binds. It has to match `spec.restateBack` exactly. */
export const RESTATE_TEXT =
  'You asked for: repair the documentation — a repeated word, a broken relative link, a duplicated ' +
  'heading, an unclosed code fence and a leftover TODO. Not asking for: a code change or a ' +
  'dependency upgrade.';

/** One unit spec, in the shape `factory intent --file` accepts. */
export function specOf(artefacts: Artefacts, revision: ArtefactRevision): unknown {
  return {
    slug: artefacts.taskClass,
    revision: revision.index,
    repo: artefacts.repoId,
    baseRev: revision.commit,
    intent:
      `Repair the documentation for revision ${revision.index.toString()}: a repeated word, a ` +
      'broken relative link, a duplicated heading, an unclosed code fence and a leftover TODO.',
    restateBack: RESTATE_TEXT,
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
}

/** The `export` block an operator pastes before planning and running the loop. */
export function envBlock(artefacts: Artefacts): readonly string[] {
  return [
    `export FACTORY_HOLDOUT_ROOT="${artefacts.holdoutRoot}"`,
    `export FACTORY_HOLDOUT_TASK_CLASS="${artefacts.taskClass}"`,
    `export FACTORY_PRISTINE_REPO="${artefacts.mirror}"`,
    `export FACTORY_REPO="${artefacts.repoId}"`,
    'export FACTORY_TEST_ROOT="tools"',
    'export FACTORY_WALL_SUITE="node tools/check-docs.mjs"',
    `export FACTORY_HOME="${artefacts.home}"`,
    '# Recorded on the certificate so a model change is detectable rather than inferred:',
    '# export FACTORY_MODEL_ID="<the model id this loop spends on>"',
    '# Spend consent, deliberately set here rather than remembered:',
    'export FACTORY_LIVE_MODEL=1',
  ];
}

/**
 * `plan-units.sh`: submit and qualify the twenty specs against `$FACTORY_HOME`.
 *
 * Emitted rather than executed. A unit id is assigned by the store, so `units.txt` cannot exist
 * before planning — the planner writes it, and refuses to run twice so a second pass cannot pay
 * for twenty more attempts against the same bases.
 */
function planUnitsSource(artefacts: Artefacts): string {
  const factoryEntry = join(artefacts.sourceRoot, 'apps', 'cli', 'src', 'main.ts');
  return `#!/usr/bin/env bash
# Plan (submit + qualify) the units this certification needs, then say how to run them.
#
# Generated by scripts/certification-artifacts.sh; the specs, the corpus and the store are already
# on disk, so this step costs nothing and writes only to \$FACTORY_HOME.
set -uo pipefail

ARTEFACTS="\${ARTEFACTS_ROOT:-${artefacts.root}}"
FACTORY_ENTRY="\${CERTIFY_FACTORY_ENTRY:-${factoryEntry}}"
NODE_BIN="\${NODE_BIN:-node}"

if [ -z "\${FACTORY_HOME:-}" ]; then
  echo "plan-units: FACTORY_HOME is not set; paste the export block from the artefacts README first" >&2
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

cd "\$(dirname "\$0")" || exit 1
: > units.txt
for spec in spec-*.json; do
  unitId="\$("$NODE_BIN" "\$FACTORY_ENTRY" intent --file "\$spec" --restate restate.md --json | jq -r .unitId)"
  if [ -z "\$unitId" ] || [ "\$unitId" = "null" ]; then
    echo "plan-units: \$spec was refused by intent; nothing more was submitted" >&2
    exit 1
  fi
  if ! "$NODE_BIN" "\$FACTORY_ENTRY" qualify "\$unitId" --cold-start --json >/dev/null; then
    echo "plan-units: qualify refused \$unitId; drop it from units.txt or fix the spec" >&2
    exit 1
  fi
  printf '%s\\n' "\$unitId" >> units.txt
done
printf 'plan-units: %s unit(s) qualified dark\\n' "\$(wc -l < units.txt | tr -d ' ')"
printf 'plan-units: next: bash ${join(artefacts.sourceRoot, 'scripts', 'certify-class.sh')} --units-file %s/units.txt\\n' "\$ARTEFACTS"
`;
}

/** The README the operator reads first. */
function readmeSource(artefacts: Artefacts): string {
  const code = (text: string): string => '`' + text + '`';
  // A fence has to be assembled rather than typed: three backticks in this file would close the
  // template literal the README is written in.
  const fence = '`'.repeat(3);
  const provenance =
    'Built from ' +
    code(artefacts.sourceRoot) +
    (artefacts.sourceCommit === null ? '' : ` at ${code(artefacts.sourceCommit.slice(0, 12))}`) +
    (artefacts.createdAt === null ? '' : ` on ${artefacts.createdAt}`) +
    '.';
  const revisionLines = artefacts.revisions
    .map(
      (revision) =>
        `| ${revision.index.toString()} | ${code(revision.commit.slice(0, 12))} | ` +
        revision.plantedIn.map((path) => code(path)).join(', ') +
        ' |',
    )
    .join('\n');
  const envLines = envBlock(artefacts).join('\n');
  // Inside a fenced block the paths are literal, so no inline-code markers here: a reader copies
  // these two lines as they are.
  const planCommand = `bash ${join(artefacts.root, 'plan-units.sh')}`;
  const driverCommand =
    `bash ${join(artefacts.sourceRoot, 'scripts', 'certify-class.sh')} --units-file ` +
    join(artefacts.root, 'units.txt');
  return `# Certification artefacts — task class ${code(artefacts.taskClass)}

${provenance}

This directory exists so a **live loop** can measure twenty attempts of one task class against a
documentation set that looks like this repository's, and so the evidence is still here afterwards.
It is disposable: rebuilding deletes and replaces it, and it holds no live store — ${code('FACTORY_HOME')}
points at ${code('home/')}, which is empty until the loop creates one.

## What each piece is

| Path | What it is |
| ---- | ---------- |
| ${code('docs/')} | The repository the worker edits: a copy of this repository's ${code('docs/')} markdown with five class violations planted into three files per commit, one commit per attempt base. Every base is the repaired tree plus its own five, never a growing pile. |
| ${code('docs.git/')} | The bare mirror the wall clones. ${code('FACTORY_PRISTINE_REPO')} points here; it is the only repository the wall trusts. |
| ${code(`holdout/${artefacts.taskClass}/${artefacts.holdoutRevision}/`)} | The class corpus: five rule scripts plus ${code('manifest.json')}, read by ${code('loadHoldout')} from outside every worktree. |
| ${code(`spec-1.json … spec-${artefacts.revisions.length.toString()}.json`)} | One unit spec per base revision: ${code('slug')}, ${code('repo')}, ${code('baseRev')}, the acceptance oracle, the budget estimate. |
| ${code('restate.md')} | The restate-back sentence every spec binds. ${code('factory intent --restate')} hashes it into the mandate. |
| ${code('plan-units.sh')} | Submits and qualifies the specs against ${code('$FACTORY_HOME')} and writes ${code('units.txt')}. |
| ${code('home/')} | ${code('FACTORY_HOME')}. Empty until ${code('plan-units.sh')} runs; the store, attempts and certificates live here. |
| ${code(ARTEFACT_MARKER_FILE)} | The marker that makes this directory rebuildable and nothing else deletable. |

## The corpus is invisible to the worker

The rule scripts live under ${code('holdout/')}, which is outside ${code('docs/')} and appears in no prompt, no
launch record and no attempt clone; the verdict anonymises the scenario ids as ${code('holdout:01')} … so a
worker cannot learn which rules it missed. ${code('materializeArtifacts')} refuses to build a holdout inside
the repository and refuses to finish if the repository's history mentions the holdout path. The
visible check the worker *can* read (${code('docs/tools/check-docs.mjs')}) covers two of the five rules on
purpose: making it green is necessary, not sufficient.

## What to run

${fence}bash
${envLines}
${fence}

Then, from the DSH checkout:

${fence}bash
${planCommand}   # free: intent + qualify, no model call
${driverCommand}
${fence}

The driver stops at the third failure (${code('m - k + 1')} = 3), prints one line per unit, and reads the
final answer from the store rather than from its own tally. A certificate needs all twenty
attempts; a class that cannot be certified costs as few as three. See
${code('docs/runbooks/certify-class.md')} in the checkout for the meaning of the certificate, the cost model
and the honest limits.

## The revision table

| # | base commit | defects planted in |
| - | ----------- | ------------------ |
${revisionLines}

Each revision plants the same five rule violations — a doubled word, a link to a
${code('./reference-<n>.md')} that was never written, a duplicated ${code('## Steps')} heading, an opening fence with
no closing one, and a ${code('TODO')} — into a different rotating set of documents. That is what makes the
twenty attempts twenty samples: the rules are measured against trees they have not seen.

Documents that already violated a class rule before anything was planted are **not** in ${code('docs/')};
they were dropped at build time and are listed in ${code(ARTEFACT_MARKER_FILE)} (${code('dropped')}).
Planting defects on a tree that was already broken would have made the repair impossible.

## What a certificate measured here means

It means the class's rulebook was measured twenty times on this repository's own prose. It does
**not** mean the documentation is correct: the corpus was written by the same side that is being
certified, so it can only measure what its author thought of. ${code('docs-typo-fix')} has five rules and
the certificate is a floor on class quality, not a proof. Nothing here was measured against a model
unless ${code('FACTORY_MODEL_ID')} is set and the loop actually ran.
`;
}

/** Write the specs, the restate file, the planner and the README. */
function writeArtefactFiles(artefacts: Artefacts): void {
  for (const revision of artefacts.revisions) {
    writeFileSync(
      join(artefacts.root, `spec-${revision.index.toString()}.json`),
      `${JSON.stringify(specOf(artefacts, revision), null, 2)}\n`,
    );
  }
  writeFileSync(join(artefacts.root, 'restate.md'), `${RESTATE_TEXT}\n`);
  const planner = join(artefacts.root, 'plan-units.sh');
  writeFileSync(planner, planUnitsSource(artefacts));
  chmodSync(planner, 0o755);
  writeFileSync(join(artefacts.root, 'README.md'), readmeSource(artefacts));
}

/** The commit the source checkout is on, for the provenance line; `null` when it is not a repo. */
export function readSourceCommit(sourceRoot: string): string | null {
  const head = runProcess(['git', 'rev-parse', 'HEAD'], sourceRoot);
  if (head.code !== 0) return null;
  const sha = head.stdout.trim();
  return sha === '' ? null : sha;
}
