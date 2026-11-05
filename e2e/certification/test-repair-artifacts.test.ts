/**
 * `scripts/test-repair-artifacts.sh` builds the *persistent* artefacts a live loop for the
 * `test-repair` class runs against, and this spec is what keeps that build honest without spending
 * anything.
 *
 * The 20-revision build is too expensive for every gate run, so this spec builds three revisions and
 * verifies independently of the build's own report:
 *
 *   1. the artefacts repository is a git history of one small module per base revision with a test
 *      that fails on it; a clone of each planted base fails every class rule and its visible check,
 *      while the same clone with the source repaired passes every rule and the check;
 *   2. the corpus is outside the repository, absent from its history, loads through `loadHoldout`,
 *      and its hidden probe index names the module each base revision actually ships — a probe that
 *      named the wrong module would measure the wrong tree;
 *   3. the planner is emitted, not executed: the store directory stays empty, because submitting a
 *      unit writes the ledger and materialising artefacts has to stay free;
 *   4. the build refuses what it cannot certify: a directory it did not create, a root inside the
 *      checkout, and a revision whose probe or repair stops discriminating;
 *   5. the build never writes into the checkout it was built from.
 */
import { execFileSync } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
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
  RESTATE_TEXT,
  materializeTestRepairArtifacts,
} from './test-repair-artifacts.ts';
import { TEST_REPAIR_REVISIONS, type TestRepairRevision } from './test-repair-revisions.ts';
import {
  TEST_REPAIR_TASK_CLASS,
  assertRevisionDiscriminates,
  modulePath,
  testPath,
} from './test-repair.ts';

const REPO_ROOT = fileURLToPath(new URL('../../', import.meta.url));
const SCRIPT = join(REPO_ROOT, 'scripts', 'test-repair-artifacts.sh');
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

/** The revision a 1-based spec revision names. */
function revisionForSpec(revision: unknown): TestRepairRevision {
  if (typeof revision !== 'number')
    throw new Error(`a spec has no numeric revision: ${String(revision)}`);
  const found = TEST_REPAIR_REVISIONS[revision - 1];
  if (found === undefined) throw new Error(`no fixture revision ${revision.toString()}`);
  return found;
}

/** Clone the mirror the way the wall does, then check out `baseRev`. */
function cloneTree(mirror: string, baseRev: string, label: string): string {
  const tree = join(workspace, `tree-${label}`);
  const clone = run(['git', 'clone', '--quiet', '--no-hardlinks', mirror, tree], workspace);
  if (clone.code !== 0) throw new Error(`clone failed: ${clone.stderr}`);
  const checkout = run(['git', 'checkout', '--quiet', '--detach', baseRev], tree);
  if (checkout.code !== 0) throw new Error(`checkout ${baseRev} failed: ${checkout.stderr}`);
  return tree;
}

interface ArtefactBuild extends RunResult {
  readonly root: string;
}

let workspace = '';
let build!: ArtefactBuild;
let specs: readonly Record<string, unknown>[] = [];
let baseRevs: readonly string[] = [];
let sourceState = '';

beforeAll(() => {
  workspace = mkdtempSync(join(tmpdir(), 'factory-test-repair-artifacts-'));
  sourceState = run(['git', 'status', '--porcelain'], REPO_ROOT).stdout;
  const root = join(workspace, 'artefacts');
  const result = run(
    ['bash', SCRIPT, '--root', root, '--revisions', String(REVISIONS), '--source', REPO_ROOT],
    REPO_ROOT,
  );
  build = { ...result, root };
  specs = Array.from({ length: REVISIONS }, (_unused, index) => {
    const path = join(root, `spec-${(index + 1).toString()}.json`);
    return existsSync(path)
      ? (JSON.parse(readFileSync(path, 'utf8')) as Record<string, unknown>)
      : {};
  });
  baseRevs = specs.map((spec) => String(spec['baseRev']));
}, BUILD_TIMEOUT_MS);

afterAll(() => {
  rmSync(workspace, { recursive: true, force: true });
});

describe('the persistent test-repair artefacts', () => {
  it('builds the fixture repository, the mirror, the corpus and the planner at the path it was given', () => {
    expect(build.code, build.stderr).toBe(0);
    const root = build.root;

    // The repository: one commit per base revision plus the skeleton, each carrying its module.
    const repo = join(root, 'repo');
    expect(existsSync(join(repo, '.git')), 'the artefacts repository is a git repository').toBe(
      true,
    );
    expect(run(['git', 'rev-list', '--count', 'HEAD'], repo).stdout.trim()).toBe(
      String(REVISIONS + 1),
    );
    expect(existsSync(join(repo, 'tools', 'visible-check.mjs'))).toBe(true);

    // The mirror: what the wall clones as FACTORY_PRISTINE_REPO.
    const mirror = join(root, 'repo.git');
    expect(existsSync(join(mirror, 'HEAD')), 'the mirror is a bare repository').toBe(true);
    for (const baseRev of baseRevs) {
      expect(run(['git', 'cat-file', '-e', `${baseRev}^{commit}`], mirror).code).toBe(0);
    }

    // The corpus: the layout `loadHoldout` reads, with the real three rules in the manifest's argv.
    const holdoutRoot = join(root, 'holdout');
    const corpus = loadHoldout(holdoutRoot, TEST_REPAIR_TASK_CLASS);
    expect(corpus, 'the corpus must load or every verdict would be unknown').not.toBeNull();
    if (corpus === null) throw new Error('unreachable: asserted above');
    expect(corpus.taskClass).toBe(TEST_REPAIR_TASK_CLASS);
    expect(corpus.revision).toBe(ARTEFACT_HOLDOUT_REVISION);
    expect(corpus.scenarios).toHaveLength(3);
    const ids = corpus.scenarios.map((scenario) => scenario.id);
    expect(ids).toEqual([...ids].sort());
    expect(ids).toEqual(['differential', 'hidden-behaviour', 'tests-untouched']);
    for (const scenario of corpus.scenarios) {
      expect(scenario.expectExit).toEqual([0]);
      expect(scenario.argv[0]).toBe('node');
      const script = scenario.argv[1] ?? '';
      expect(existsSync(script), `the corpus script ${script} exists`).toBe(true);
      // Every scenario argv names a rule script in this corpus, and the differential rule's own
      // file is there rather than borrowed from the fixture build.
      expect(readFileSync(script, 'utf8')).toContain('holdout:');
      expect(
        script.startsWith(join(holdoutRoot, TEST_REPAIR_TASK_CLASS, ARTEFACT_HOLDOUT_REVISION)),
      ).toBe(true);
    }

    // The specs: one per base, distinct revisions and bases, the repo identity the wall will enforce.
    expect(specs).toHaveLength(REVISIONS);
    expect(new Set(specs.map((spec) => String(spec['revision']))).size).toBe(REVISIONS);
    expect(new Set(baseRevs).size).toBe(REVISIONS);
    for (const spec of specs) {
      expect(spec['slug']).toBe(TEST_REPAIR_TASK_CLASS);
      expect(spec['repo']).toBe(ARTEFACT_REPO_ID);
      expect(spec['restateBack']).toBe(RESTATE_TEXT);
      // The class is enforced by the corpus, not by a path allowlist: the spec deliberately lets a
      // worker edit the test and the fixture, which is what makes the corpus the thing measured.
      expect(spec['touchPaths']).toEqual(['src/', 'tests/', 'fixtures/']);
      const revision = revisionForSpec(spec['revision']);
      expect(String(spec['intent'])).toContain(testPath(revision));
      expect(String(spec['intent'])).toContain(modulePath(revision));
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
    expect(marker['taskClass']).toBe(TEST_REPAIR_TASK_CLASS);
    expect(marker['holdoutRevision']).toBe(ARTEFACT_HOLDOUT_REVISION);
    expect(marker['sourceCommit']).toBe(run(['git', 'rev-parse', 'HEAD'], REPO_ROOT).stdout.trim());
    expect(typeof marker['createdAt']).toBe('string');
    expect(build.stdout).toContain(`export FACTORY_HOLDOUT_ROOT="${holdoutRoot}"`);
    expect(build.stdout).toContain(`export FACTORY_PRISTINE_REPO="${mirror}"`);
    expect(build.stdout).toContain('export FACTORY_TEST_ROOT="tests"');
    expect(build.stdout).toContain(
      `export FACTORY_WALL_SUITE="node ${join(holdoutRoot, TEST_REPAIR_TASK_CLASS, ARTEFACT_HOLDOUT_REVISION, 'suite', 'run-tests.mjs')}"`,
    );
  });

  it(
    'plants a real defect per revision: every base fails every rule, its repaired tree passes them',
    () => {
      const corpus = loadHoldout(join(build.root, 'holdout'), TEST_REPAIR_TASK_CLASS);
      if (corpus === null) throw new Error('the corpus did not load');
      const rules = corpus.scenarios.map((scenario) => scenario.argv);

      for (const [index, spec] of specs.entries()) {
        const label = String(index + 1);
        const revision = revisionForSpec(spec['revision']);
        const tree = cloneTree(
          join(build.root, 'repo.git'),
          baseRevs[index] ?? '',
          `base-${label}`,
        );

        // The base revision: every rule refuses it, and the rule that refused it is the class rule —
        // not "this tree has no git state" or "this base is not in the corpus".
        for (const argv of rules) {
          const rule = run([process.execPath, ...argv.slice(1)], tree);
          expect(rule.code, `${argv.join(' ')} must fail base ${label}`).not.toBe(0);
          expect(rule.stderr, 'the rule must fail for the class reason').not.toMatch(
            /no readable git state|is not in this corpus/u,
          );
        }
        const visible = run([process.execPath, join('tools', 'visible-check.mjs')], tree);
        expect(visible.code).toBe(1);
        expect(visible.stdout).toContain('FACTORY_SUMMARY');
        expect(visible.stdout).not.toContain('"failed":0');

        // The repair target: the same clone with only the source fixed. Both rules and the visible
        // check have to pass, or no worker could ever earn a verdict on this base.
        writeFileSync(join(tree, modulePath(revision)), revision.fixed);
        for (const argv of rules) {
          const rule = run([process.execPath, ...argv.slice(1)], tree);
          expect(rule.code, `the repaired tree must pass ${argv.join(' ')}:\n${rule.stderr}`).toBe(
            0,
          );
        }
        expect(
          run([process.execPath, join('tools', 'visible-check.mjs')], tree).code,
          'the repaired tree must pass the visible check',
        ).toBe(0);
        // And it passed the immutability rule the honest way: the only changed path is the source.
        expect(run(['git', 'status', '--porcelain'], tree).stdout.trim()).toBe(
          `M ${modulePath(revision)}`,
        );
      }
    },
    BUILD_TIMEOUT_MS,
  );

  it('keeps the corpus outside the repository, out of its history, and names the module each base ships', () => {
    const repo = join(build.root, 'repo');
    const holdoutRoot = join(build.root, 'holdout');
    expect(() => assertHoldoutOutsideRepo(holdoutRoot, repo)).not.toThrow();
    expect(existsSync(join(repo, 'holdout'))).toBe(false);
    // Neither the working tree nor the history mentions where the corpus lives.
    expect(run(['git', 'grep', '-F', '-l', holdoutRoot], repo).stdout).toBe('');
    expect(run(['git', 'log', '--all', '-p'], repo).stdout).not.toContain(holdoutRoot);
    // The worker's tree has no rule scripts: the corpus is not a file the worker can read.
    const moduleFiles = run(['git', 'ls-files'], repo)
      .stdout.split('\n')
      .filter((path) => path.endsWith('.mjs'));
    expect(moduleFiles).toEqual(['tools/visible-check.mjs']);

    // The corpus index is keyed by base commit and names the module that commit ships, the repaired
    // reference the differential rule compares against, and the domain it generates from. An index
    // that pointed every base at the same module — or at a reference that was not the repair — would
    // measure a tree the candidate did not get.
    const corpus = loadHoldout(holdoutRoot, TEST_REPAIR_TASK_CLASS);
    if (corpus === null) throw new Error('the corpus did not load');
    const revisionDir = join(holdoutRoot, TEST_REPAIR_TASK_CLASS, ARTEFACT_HOLDOUT_REVISION);
    const index = JSON.parse(
      readFileSync(join(revisionDir, 'hidden', 'index.json'), 'utf8'),
    ) as Record<
      string,
      {
        module: string;
        reference: string;
        fn: string;
        domain: { edges: unknown[]; samples: number };
      }
    >;
    expect(Object.keys(index).sort()).toEqual([...baseRevs].sort());
    for (const [offset, spec] of specs.entries()) {
      const baseRev = baseRevs[offset];
      if (baseRev === undefined) throw new Error('no base revision');
      const entry = index[baseRev];
      if (entry === undefined) throw new Error(`no index entry for ${baseRev}`);
      const revision = revisionForSpec(spec['revision']);
      expect(entry.module).toBe(modulePath(revision));
      expect(entry.fn).toBe(revision.fn);
      // The reference is the repair, verbatim, and it lives in the corpus rather than the tree.
      expect(entry.reference).toBe(`hidden/${baseRev}.reference.mjs`);
      expect(readFileSync(join(revisionDir, entry.reference), 'utf8')).toBe(revision.fixed);
      // The domain is the same one the revision declares, so the claim's N is derivable here.
      expect(entry.domain.edges.length + entry.domain.samples).toBeGreaterThanOrEqual(40);
      expect(existsSync(join(revisionDir, 'hidden', `${baseRev}.probe.mjs`))).toBe(true);
    }
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

  it('refuses a directory it did not create, a root inside the checkout, and a revision that stops discriminating', () => {
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

    const inside = join(REPO_ROOT, '.test-repair-artefacts-inside-the-checkout');
    expect(() =>
      materializeTestRepairArtifacts({ root: inside, sourceRoot: REPO_ROOT, revisions: 1 }),
    ).toThrow(/must live outside the repository/u);
    expect(existsSync(inside)).toBe(false);

    // A revision whose base and repair are the same tree does not discriminate. The wall's
    // `maxNonDiscriminating` is 0 and is not configurable, so one such revision would make every
    // attempt against it unmeasurable — the build refuses before it writes anything.
    const honest = TEST_REPAIR_REVISIONS[0];
    if (honest === undefined) throw new Error('the fixture has no revisions');
    expect(() => assertRevisionDiscriminates({ ...honest, id: 'no-bug', bug: [] })).toThrow(
      /does not discriminate/u,
    );
    expect(() => assertRevisionDiscriminates(honest)).not.toThrow();
  });

  it('never writes into the checkout it was built from', () => {
    // The build copies nothing out of the checkout, but it does read the source commit for the
    // marker and it runs `git` there. This is the tripwire: whatever the operator had on disk
    // before the build must still be exactly what they have now.
    expect(run(['git', 'status', '--porcelain'], REPO_ROOT).stdout).toBe(sourceState);
  });
});
