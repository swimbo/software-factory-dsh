/**
 * The holdout corpus is a *class* test, and it is genuinely hidden from the worker.
 *
 * Two claims are made here, and neither is allowed to be a description of the fixture:
 *
 * 1. **Class, not instance.** A scenario asserts a documentation rule over the whole tree. The
 *    same five rule scripts must fail every unit's broken tree and pass every unit's repaired
 *    tree — trees the rule script has never seen, including other units' trees. If a scenario
 *    passed only on the tree it was written against, a certificate earned on twenty units would
 *    be a certificate about one file, which is the failure mode this corpus exists to avoid.
 *    The visible check (`tools/check-docs.mjs`) covers two of the five rules; a candidate that
 *    satisfies it and still breaks a third rule fails the class. That asymmetry is asserted
 *    rather than described, because it is the whole argument for a hidden holdout.
 *
 * 2. **Hidden.** The corpus lives outside the repository and outside the attempt clone; the
 *    prompt, the launch record and the attempt tree name neither the store's path nor its
 *    private scenario ids. The wall is only a wall if the measured thing cannot read the
 *    measurement, so this is checked against the real pipeline (a real mirror, a real clone, a
 *    real wall evaluation), not against the fixture's intentions.
 */
import { execFileSync } from 'node:child_process';
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, relative } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { contentHash } from '../../packages/contracts/src/index.ts';
import { openStore } from '../../packages/store/src/index.ts';
import {
  assertHoldoutOutsideRepo,
  hashableScenarios,
  loadHoldout,
} from '../../packages/wall/src/index.ts';
import { runFactory } from '../harness/factory.ts';
import {
  brokenDocs,
  createDocsSubstrate,
  fixedDocs,
  HOLDOUT_REVISION,
  TASK_CLASS,
  type DocFile,
  type DocsSubstrate,
  type DocsUnit,
} from './docs-substrate.ts';

let substrate: DocsSubstrate;
let unit: DocsUnit;

/** Materialise one documentation tree in its own directory, so a scenario can be run against it. */
function treeWith(root: string, docs: readonly DocFile[], withVisibleCheck: boolean): string {
  const tree = mkdtempSync(join(root, 'tree-'));
  for (const file of docs) {
    mkdirSync(dirname(join(tree, file.path)), { recursive: true });
    writeFileSync(join(tree, file.path), file.content);
  }
  if (withVisibleCheck) {
    mkdirSync(join(tree, 'tools'), { recursive: true });
    copyFileSync(
      join(substrate.repo, 'tools', 'check-docs.mjs'),
      join(tree, 'tools', 'check-docs.mjs'),
    );
  }
  return tree;
}

/** The repaired tree except the broken relative link: the shape of a plausible-but-wrong patch. */
function almostFixedDocs(index: number): readonly DocFile[] {
  return fixedDocs(index).map((file) =>
    file.path === 'docs/index.md'
      ? {
          path: file.path,
          content: file.content.replace('](./reference.md)', `](./reference-${index}.md)`),
        }
      : file,
  );
}

interface ExitResult {
  readonly code: number;
  readonly output: string;
}

function run(argv: readonly string[], cwd: string): ExitResult {
  const [bin = process.execPath, ...args] = argv;
  try {
    const output = execFileSync(bin, args, { cwd, encoding: 'utf8', timeout: 30_000 });
    return { code: 0, output };
  } catch (error) {
    const failure = error as { status?: number; stdout?: string; stderr?: string };
    return {
      code: failure.status ?? -1,
      output: `${String(failure.stdout ?? '')}${String(failure.stderr ?? '')}`,
    };
  }
}

function filesUnder(dir: string): readonly string[] {
  const out: string[] = [];
  const walk = (current: string): void => {
    for (const name of readdirSync(current)) {
      const path = join(current, name);
      if (statSync(path).isDirectory()) walk(path);
      else out.push(path);
    }
  };
  walk(dir);
  return out;
}

beforeAll(() => {
  // Two units is enough for the "a scenario passes a tree it was not written against" claim, and
  // the 20-unit loop that flips the certificate lives in certification.test.ts where it is the
  // subject rather than the scenery.
  substrate = createDocsSubstrate({ units: 2 });
  const first = substrate.units[0];
  if (first === undefined) throw new Error('substrate produced no units');
  unit = first;
});

afterAll(() => {
  substrate.cleanup();
});

describe('the holdout corpus for docs-typo-fix', () => {
  it('loads as a five-scenario corpus under the class, from outside the repository', () => {
    const store = loadHoldout(substrate.holdoutRoot, TASK_CLASS);
    expect(
      store,
      'the corpus must load: a null store would make every verdict unknown',
    ).not.toBeNull();
    if (store === null) throw new Error('unreachable: asserted above');
    expect(store.taskClass).toBe(TASK_CLASS);
    expect(store.revision).toBe(HOLDOUT_REVISION);
    expect(store.scenarios).toHaveLength(5);
    // Every scenario is an argv plus the exit codes that mean "the rule holds" — no prose, no
    // free-text grader, no path into the candidate tree.
    for (const scenario of store.scenarios) {
      expect(scenario.argv.length).toBeGreaterThan(0);
      expect(scenario.expectExit).toEqual([0]);
      expect(scenario.taskClass).toBe(TASK_CLASS);
      expect(scenario.argv.some((part) => part.includes(substrate.holdoutRoot))).toBe(true);
    }
    // The loader re-derives the revision hash from the manifest; a corpus whose bytes changed
    // under it would load as a different revision, so this equality is the anti-tamper check.
    expect(contentHash(hashableScenarios(store.scenarios))).toBe(
      contentHash(hashableScenarios([...store.scenarios].sort((a, b) => (a.id < b.id ? -1 : 1)))),
    );
    // Outside the repository, which is what `assertHoldoutOutsideRepo` is for.
    expect(() => assertHoldoutOutsideRepo(substrate.holdoutRoot, substrate.repo)).not.toThrow();
    expect(relative(substrate.repo, substrate.holdoutRoot).startsWith('..')).toBe(true);
    // The scripts themselves are nowhere inside the tree the worker writes.
    expect(existsSync(join(substrate.repo, 'rules'))).toBe(false);
    const repoNames = filesUnder(substrate.repo).map((path) => path.split('/').at(-1) ?? '');
    expect(repoNames).not.toContain('no-doubled-words.mjs');
    expect(repoNames).not.toContain('relative-links-resolve.mjs');
  });

  it('every rule fails every unit’s broken tree and passes every unit’s repaired tree', () => {
    const store = loadHoldout(substrate.holdoutRoot, TASK_CLASS);
    if (store === null) throw new Error('no holdout');
    const temp = mkdtempSync(join(tmpdir(), 'holdout-class-'));
    try {
      for (const candidate of substrate.units) {
        const broken = treeWith(temp, brokenDocs(candidate.index), false);
        const fixed = treeWith(temp, fixedDocs(candidate.index), false);
        const brokenOutcomes = store.scenarios.map((scenario) => run(scenario.argv, broken));
        const fixedOutcomes = store.scenarios.map((scenario) => run(scenario.argv, fixed));
        // Every scenario discriminates on every base revision: none of them passes a broken tree,
        // which is also what the wall's `maxNonDiscriminating = 0` requires to certify the class.
        for (const [index, outcome] of brokenOutcomes.entries()) {
          const scenario = store.scenarios[index];
          expect(
            outcome.code,
            `${scenario?.id ?? '?'} must fail build ${candidate.index.toString()}: ${outcome.output}`,
          ).not.toBe(0);
        }
        for (const [index, outcome] of fixedOutcomes.entries()) {
          const scenario = store.scenarios[index];
          expect(
            outcome.code,
            `${scenario?.id ?? '?'} must pass build ${candidate.index.toString()}: ${outcome.output}`,
          ).toBe(0);
        }
      }
    } finally {
      rmSync(temp, { recursive: true, force: true });
    }
  });

  it('measures more than the visible check: a green visible suite can still fail the class', () => {
    // The visible check covers doubled words and fences. This candidate repairs those — the
    // repository's own check is green — and leaves the broken relative link. A wall that used the
    // visible suite as its oracle would call this done; the holdout does not.
    const temp = mkdtempSync(join(tmpdir(), 'holdout-asymmetry-'));
    try {
      const tree = treeWith(temp, almostFixedDocs(unit.index), true);
      const visible = run([process.execPath, 'tools/check-docs.mjs'], tree);
      expect(visible.code).toBe(0);
      expect(visible.output).toContain('FACTORY_SUMMARY');

      const store = loadHoldout(substrate.holdoutRoot, TASK_CLASS);
      if (store === null) throw new Error('no holdout');
      const outcomes = new Map(
        store.scenarios.map((scenario) => [scenario.id, run(scenario.argv, tree)] as const),
      );
      expect(outcomes.get('relative-links-resolve')?.code).toBe(1);
      // And it is *that* rule only: the other four repaired rules are measured as repaired.
      for (const [id, outcome] of outcomes) {
        if (id === 'relative-links-resolve') continue;
        expect(outcome.code, `${id}: ${outcome.output}`).toBe(0);
      }
    } finally {
      rmSync(temp, { recursive: true, force: true });
    }
  });

  it('is invisible to the worker: no prompt, no launch record and no attempt tree names it', () => {
    const unitId = substrate.submit(unit);
    const runResult = runFactory(['run', unitId, '--scenario', unit.scenarioPath, '--json'], {
      home: substrate.home,
      env: substrate.wallEnv(),
      timeoutMs: 180_000,
    });
    expect(runResult.code, runResult.stderr).toBe(0);

    const store = openStore({ dir: join(substrate.home, 'state') });
    let attemptId = '';
    let attemptDir = '';
    let verdictBody = '';
    let holdoutRevision = '';
    try {
      const attempts = store.listAttemptsForUnit(unitId);
      const attempt = attempts.at(-1);
      expect(attempt).toBeDefined();
      attemptId = attempt?.attemptId ?? '';
      attemptDir = attempt?.attemptDir ?? '';
      const verdict = store.latestVerdictForUnit(unitId);
      expect(verdict).not.toBeNull();
      verdictBody = JSON.stringify(verdict?.verdict ?? {});
      holdoutRevision = verdict?.verdict.holdoutRevision ?? '';
    } finally {
      store.close();
    }

    // The verdict names *which* corpus it was measured against, and nothing about what is in it.
    expect(holdoutRevision).toBe(HOLDOUT_REVISION);
    const store2 = loadHoldout(substrate.holdoutRoot, TASK_CLASS);
    const scenarioIds = (store2?.scenarios ?? []).map((scenario) => scenario.id);
    for (const id of scenarioIds) expect(verdictBody).not.toContain(id);

    // The record directory: prompt + launch record + logs. A worker that reads them learns the
    // task, never the measurement.
    const recordDir = join(substrate.home, 'attempts', unitId, attemptId);
    const recordFiles = filesUnder(recordDir);
    expect(recordFiles.some((path) => path.endsWith('task.md'))).toBe(true);
    expect(recordFiles.some((path) => path.endsWith('launch.json'))).toBe(true);
    const recordText = recordFiles.map((path) => readFileSync(path, 'utf8')).join('\n');
    expect(recordText).not.toContain(substrate.holdoutRoot);
    for (const id of scenarioIds) expect(recordText).not.toContain(id);

    // The attempt clone: the worker's whole world. The corpus is not in it, by name or by path.
    const cloneDir = attemptDir;
    expect(existsSync(cloneDir)).toBe(true);
    const cloneFiles = filesUnder(cloneDir);
    expect(cloneFiles.some((path) => path.includes('/rules/'))).toBe(false);
    const cloneText = cloneFiles
      .filter((path) => !path.includes('/.git/'))
      .map((path) => readFileSync(path, 'utf8'))
      .join('\n');
    expect(cloneText).not.toContain(substrate.holdoutRoot);
  });
});
