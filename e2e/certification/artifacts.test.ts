/**
 * `scripts/certification-artifacts.sh` builds the *persistent* artefacts a live loop runs against,
 * and this spec is what keeps that build honest without spending anything.
 *
 * The 20-revision build is too expensive for every gate run, so this spec builds three revisions and
 * verifies independently of the build's own report:
 *
 *   1. the artefacts repository is a copy of this repository's documentation with the class's five
 *      defects planted in it — a checkout of each planted base fails all five class rules and the
 *      visible check, while the root commit (the repair target) passes all of them;
 *   2. the corpus is outside the repository, absent from its history and loads through `loadHoldout`
 *      — a corpus the wall cannot read certifies nothing;
 *   3. the planner is emitted, not executed: the store directory stays empty, because submitting a
 *      unit writes the ledger and materialising artefacts has to stay free;
 *   4. the build never writes into the checkout it copied. The first version of this module resolved
 *      the copied paths against the artefacts repository instead of the source tree, and planted its
 *      defects into three real documents of this checkout. That is the failure the last test pins.
 */
import { execFileSync } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { assertHoldoutOutsideRepo, loadHoldout } from '../../packages/wall/src/index.ts';
import {
  ARTEFACT_HOLDOUT_REVISION,
  ARTEFACT_KIND,
  ARTEFACT_MARKER_FILE,
  ARTEFACT_REPO_ID,
  MIN_DOCUMENTS,
  RESTATE_TEXT,
  markdownFilesIn,
  materializeArtifacts,
} from './artifacts.ts';
import { TASK_CLASS } from './docs-substrate.ts';

const REPO_ROOT = fileURLToPath(new URL('../../', import.meta.url));
const SCRIPT = join(REPO_ROOT, 'scripts', 'certification-artifacts.sh');
const REVISIONS = 3;
const BUILD_TIMEOUT_MS = 120_000;

interface RunResult {
  readonly code: number;
  readonly stdout: string;
  readonly stderr: string;
}

/** Run a command, returning its exit code instead of throwing: every check here is an exit code. */
function run(argv: readonly string[], cwd: string, env?: NodeJS.ProcessEnv): RunResult {
  const [executable, ...args] = argv;
  if (executable === undefined) throw new Error('run needs an executable');
  try {
    return {
      code: 0,
      stdout: execFileSync(executable, args, {
        cwd,
        env: env ?? process.env,
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'pipe'],
        maxBuffer: 128 * 1024 * 1024,
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

/** Extract `commit` into a fresh directory under the spec's workspace. */
function checkout(repo: string, commit: string, label: string): string {
  const tree = join(workspace, `tree-${label}`);
  mkdirSync(tree, { recursive: true });
  const archive = execFileSync('git', ['archive', '--format=tar', commit], {
    cwd: repo,
    maxBuffer: 128 * 1024 * 1024,
  });
  execFileSync('tar', ['-x', '-C', tree], { input: archive });
  return tree;
}

/** Paths (relative to `repo`) whose content differs between `before` and `after`. */
function changedFiles(repo: string, before: string, after: string): string[] {
  return run(['git', 'diff', '--name-only', before, after], repo)
    .stdout.split('\n')
    .filter((path) => path !== '');
}

interface ArtefactBuild extends RunResult {
  readonly root: string;
}

let workspace = '';
let build!: ArtefactBuild;
let specs: readonly Record<string, unknown>[] = [];
let baseRevs: readonly string[] = [];
let rootCommit = '';

beforeAll(() => {
  workspace = mkdtempSync(join(tmpdir(), 'factory-artifacts-spec-'));
  const root = join(workspace, 'artefacts');
  const result = run(
    ['bash', SCRIPT, '--root', root, '--revisions', String(REVISIONS), '--source', REPO_ROOT],
    REPO_ROOT,
  );
  build = { ...result, root };
  specs = Array.from({ length: REVISIONS }, (_, index) => {
    const path = join(root, `spec-${String(index + 1)}.json`);
    return existsSync(path)
      ? (JSON.parse(readFileSync(path, 'utf8')) as Record<string, unknown>)
      : {};
  });
  baseRevs = specs.map((spec) => String(spec['baseRev']));
  const repo = join(root, 'docs');
  if (existsSync(join(repo, '.git'))) {
    rootCommit = run(['git', 'rev-list', '--max-parents=0', 'HEAD'], repo).stdout.trim();
  }
}, BUILD_TIMEOUT_MS);

afterAll(() => {
  rmSync(workspace, { recursive: true, force: true });
});

describe('the persistent certification artefacts', () => {
  it('builds the repository, the mirror, the corpus and the planner at the path it was given', () => {
    expect(build.code, build.stderr).toBe(0);
    const root = build.root;

    // The repository: a copy of this repository's docs plus the visible check, one commit per base.
    const repo = join(root, 'docs');
    expect(existsSync(join(repo, '.git')), 'the artefacts repository is a git repository').toBe(
      true,
    );
    expect(run(['git', 'rev-list', '--count', 'HEAD'], repo).stdout.trim()).toBe(
      String(REVISIONS + 1),
    );
    const documents = markdownFilesIn(repo);
    expect(documents.length).toBeGreaterThanOrEqual(MIN_DOCUMENTS);
    expect(existsSync(join(repo, 'tools', 'check-docs.mjs'))).toBe(true);

    // The mirror: what the wall clones as FACTORY_PRISTINE_REPO.
    const mirror = join(root, 'docs.git');
    expect(existsSync(join(mirror, 'HEAD')), 'the mirror is a bare repository').toBe(true);
    for (const baseRev of baseRevs) {
      expect(run(['git', 'cat-file', '-e', `${baseRev}^{commit}`], mirror).code).toBe(0);
    }

    // The corpus: the layout `loadHoldout` reads, with the real five rules in the manifest's argv.
    const holdoutRoot = join(root, 'holdout');
    const corpus = loadHoldout(holdoutRoot, TASK_CLASS);
    expect(corpus, 'the corpus must load or every verdict would be unknown').not.toBeNull();
    if (corpus === null) throw new Error('unreachable: asserted above');
    expect(corpus.taskClass).toBe(TASK_CLASS);
    expect(corpus.revision).toBe(ARTEFACT_HOLDOUT_REVISION);
    expect(corpus.scenarios).toHaveLength(5);
    const ids = corpus.scenarios.map((scenario) => scenario.id);
    expect(ids).toEqual([...ids].sort());
    for (const scenario of corpus.scenarios) {
      expect(scenario.expectExit).toEqual([0]);
      expect(scenario.argv[0]).toBe('node');
      const script = scenario.argv[1] ?? '';
      expect(existsSync(script), `the corpus script ${script} exists`).toBe(true);
      expect(script.startsWith(join(holdoutRoot, TASK_CLASS, ARTEFACT_HOLDOUT_REVISION))).toBe(
        true,
      );
    }

    // The specs: one per base, distinct revisions, the repo identity the wall policy will enforce.
    expect(specs).toHaveLength(REVISIONS);
    expect(new Set(specs.map((spec) => String(spec['revision']))).size).toBe(REVISIONS);
    expect(new Set(baseRevs).size).toBe(REVISIONS);
    for (const spec of specs) {
      expect(spec['slug']).toBe(TASK_CLASS);
      expect(spec['repo']).toBe(ARTEFACT_REPO_ID);
      expect(spec['restateBack']).toBe(RESTATE_TEXT);
      expect(spec['touchPaths']).toEqual(['docs/']);
    }

    // The restate file the intent verb hashes into the mandate: the same text the specs bind.
    expect(readFileSync(join(root, 'restate.md'), 'utf8').trim()).toBe(RESTATE_TEXT);

    // The planner and the marker.
    const planner = join(root, 'plan-units.sh');
    expect(existsSync(planner)).toBe(true);
    const plannerText = readFileSync(planner, 'utf8');
    expect(plannerText).toContain('intent --file');
    expect(plannerText).toContain('--cold-start');
    expect(plannerText).toContain('units.txt');
    expect(existsSync(join(root, 'README.md'))).toBe(true);
    const marker = JSON.parse(readFileSync(join(root, ARTEFACT_MARKER_FILE), 'utf8')) as Record<
      string,
      unknown
    >;
    expect(marker['kind']).toBe(ARTEFACT_KIND);
    expect(marker['revisions']).toBe(REVISIONS);
    expect(marker['taskClass']).toBe(TASK_CLASS);
    expect(marker['holdoutRevision']).toBe(ARTEFACT_HOLDOUT_REVISION);
    expect(typeof marker['createdAt']).toBe('string');
    expect(build.stdout).toContain(`export FACTORY_HOLDOUT_ROOT="${holdoutRoot}"`);
    expect(build.stdout).toContain(`export FACTORY_PRISTINE_REPO="${mirror}"`);
  });

  it(
    'plants the defects in real prose: every base fails every rule, the repair target passes all',
    () => {
      const repo = join(build.root, 'docs');
      const corpus = loadHoldout(join(build.root, 'holdout'), TASK_CLASS);
      if (corpus === null) throw new Error('the corpus did not load');
      const rules = corpus.scenarios.map((scenario) => scenario.argv);

      // The repair target: the commit the defects were planted on top of. If this tree failed a
      // rule, no worker could ever earn a verdict, so the corpus would certify nothing.
      const pristine = checkout(repo, rootCommit, 'pristine');
      for (const argv of rules) {
        const rule = run([process.execPath, ...argv.slice(1)], pristine);
        expect(rule.code, `the repaired tree must pass ${argv.join(' ')}:\n${rule.stdout}`).toBe(0);
      }
      expect(
        run([process.execPath, join('tools', 'check-docs.mjs')], pristine).code,
        'the repaired tree must pass the visible check',
      ).toBe(0);

      // Every planted base: all five rules refuse it, and the visible check the worker can read is
      // red too — otherwise a worker could mistake a broken tree for a repaired one.
      for (const [index, baseRev] of baseRevs.entries()) {
        const label = String(index + 1);
        const tree = checkout(repo, baseRev, `base-${label}`);
        for (const argv of rules) {
          const rule = run([process.execPath, ...argv.slice(1)], tree);
          expect(rule.code, `${argv.join(' ')} must fail base ${label}`).not.toBe(0);
        }
        const visible = run([process.execPath, join('tools', 'check-docs.mjs')], tree);
        expect(visible.code).toBe(1);
        expect(visible.stdout).toContain('FACTORY_SUMMARY');
        expect(visible.stdout).not.toContain('"failed":0');

        // The defects are the class's five and they are *this* revision's: the broken link and the
        // leftover marker name the revision, so a base measured twice cannot be a re-run of another.
        const changed = changedFiles(repo, rootCommit, baseRev);
        expect(changed).toHaveLength(3);
        const contents = changed.map((path) => readFileSync(join(tree, path), 'utf8')).join('\n');
        expect(contents).toContain(`./reference-${label}.md`);
        expect(contents).toContain(`TODO: replace the example in revision ${label}`);
      }
    },
    BUILD_TIMEOUT_MS,
  );

  it('keeps the corpus outside the repository and out of its history', () => {
    const repo = join(build.root, 'docs');
    const holdoutRoot = join(build.root, 'holdout');
    expect(() => assertHoldoutOutsideRepo(holdoutRoot, repo)).not.toThrow();
    expect(existsSync(join(repo, 'holdout'))).toBe(false);
    expect(readdirSync(repo)).not.toContain('holdout');
    // Neither the working tree nor the history mentions where the corpus lives.
    expect(run(['git', 'grep', '-F', '-l', holdoutRoot], repo).stdout).toBe('');
    expect(run(['git', 'log', '--all', '-p'], repo).stdout).not.toContain(holdoutRoot);
    // The worker's tree has no rule scripts: the corpus is not a file the worker can read.
    const moduleFiles = run(['git', 'ls-files'], repo)
      .stdout.split('\n')
      .filter((path) => path.endsWith('.mjs'));
    expect(moduleFiles).toEqual(['tools/check-docs.mjs']);
  });

  it('emits the planner instead of running it: the store stays empty', () => {
    const home = join(build.root, 'home');
    expect(existsSync(home)).toBe(true);
    expect(readdirSync(home)).toEqual([]);
    expect(existsSync(join(build.root, 'units.txt'))).toBe(false);

    // Without FACTORY_HOME the planner refuses rather than submitting units into an unknown store.
    const env: NodeJS.ProcessEnv = { ...process.env };
    delete env['FACTORY_HOME'];
    const refused = run(['bash', join(build.root, 'plan-units.sh')], build.root, env);
    expect(refused.code).toBe(2);
    expect(refused.stderr).toContain('FACTORY_HOME');
    expect(existsSync(join(build.root, 'units.txt'))).toBe(false);
  });

  it('refuses a directory it did not create, and a root inside the checkout', () => {
    const foreign = join(workspace, 'not-ours');
    mkdirSync(foreign, { recursive: true });
    writeFileSync(join(foreign, 'keep.txt'), 'someone else was here\n');
    const refusedForeign = run(
      ['bash', SCRIPT, '--root', foreign, '--revisions', '1', '--source', REPO_ROOT],
      REPO_ROOT,
    );
    expect(refusedForeign.code).toBe(1);
    expect(refusedForeign.stderr).toContain('not a previous artefacts root');
    expect(readFileSync(join(foreign, 'keep.txt'), 'utf8')).toBe('someone else was here\n');

    const inside = join(REPO_ROOT, '.artefacts-inside-the-checkout');
    expect(() =>
      materializeArtifacts({ root: inside, sourceRoot: REPO_ROOT, revisions: 1 }),
    ).toThrow(/must live outside the repository/u);
    expect(existsSync(inside)).toBe(false);
  });

  it('never writes into the checkout it copied: the source documents stay pristine', () => {
    // The first build of this module resolved the copied paths against the artefacts repository
    // instead of the source tree, so `join(root, '../…')` pointed back into this checkout and the
    // planted defects landed in three real documents. This is that bug's regression test: the files
    // the build changed in its own repository must still be exactly what git has on disk here.
    const repo = join(build.root, 'docs');
    const planted = new Set<string>();
    for (const baseRev of baseRevs) {
      for (const path of changedFiles(repo, rootCommit, baseRev)) planted.add(path);
    }
    expect(planted.size).toBeGreaterThanOrEqual(3);
    for (const path of planted) {
      const source = join(REPO_ROOT, path);
      expect(existsSync(source), `${path} exists in this checkout`).toBe(true);
      const content = readFileSync(source, 'utf8');
      expect(content, `${path} in this checkout must not carry a planted defect`).not.toMatch(
        /reference-\d+\.md|TODO: replace the example in revision \d+/u,
      );
    }
  });
});
