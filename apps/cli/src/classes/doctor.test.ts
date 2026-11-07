/**
 * `factory class doctor` — every refusal is a spec.
 *
 * The doctor's whole value is that it says *no* for reasons a person can check, so each spec here builds the
 * smallest corpus that is genuinely fine, then breaks exactly one property and asserts the finding that
 * names it. A test that only proved "a good corpus passes" would leave the twelve refusals unproven, and the
 * refusals are the product.
 *
 * The fixture rules are three-line scripts (`marker.mjs`, `todo.mjs`, `twin.mjs`) run with the tree as the
 * working directory, which is the same contract the real corpus uses: exit 0 pass, exit 1 fail, anything
 * else unknown. `node` is the runner, so the specs need no factory, no store and no model.
 */
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';
import { contentHash } from '@factory/contracts';
import { hashableScenarios } from '@factory/wall';

import { parseClassDescriptor } from './descriptor.ts';
import { diagnoseClass, type ClassDoctorRunner, type CommandOutcome } from './doctor.ts';
import { scaffoldClass } from './scaffold.ts';

const scratch: string[] = [];

function tempDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  scratch.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of scratch.splice(0)) rmSync(dir, { recursive: true, force: true });
});

const MARKER_RULE = `import { existsSync } from 'node:fs';
if (!existsSync('marker.txt')) { console.log('marker: marker.txt is missing'); process.exit(1); }
console.log('marker: ok');
`;

const TODO_RULE = `import { readFileSync } from 'node:fs';
const text = readFileSync('todo.txt', 'utf8');
if (text.includes('TODO')) { console.log('todo: unfinished-work marker'); process.exit(1); }
console.log('todo: ok');
`;

/** The visible check: enforces `marker` only, and prints the summary line the wall reads. */
const SUITE = `import { existsSync } from 'node:fs';
const ok = existsSync('marker.txt');
console.log(ok ? 'guard: ok' : 'guard: marker.txt is missing');
console.log('FACTORY_SUMMARY ' + JSON.stringify({ passed: ok ? 1 : 0, failed: ok ? 0 : 1, unknown: 0, exitCode: ok ? 0 : 1 }));
process.exit(ok ? 0 : 1);
`;

interface Fixture {
  readonly root: string;
  readonly base: string;
  readonly repair: string;
  readonly revisionDir: string;
  readonly descriptorPath: string;
  readonly suitePath: string;
}

function writeTree(target: string, files: Record<string, string>): void {
  mkdirSync(target, { recursive: true });
  for (const [name, body] of Object.entries(files)) writeFileSync(join(target, name), body);
}

function fixture(input: { readonly visibleRules?: readonly string[] } = {}): Fixture {
  const root = tempDir('factory-doctor-root-');
  const taskClass = 'docs-hygiene';
  const classDir = join(root, taskClass);
  const revisionDir = join(classDir, 'h-docs-hygiene-2026-11-08T120000-abcd1234');
  mkdirSync(join(revisionDir, 'rules'), { recursive: true });
  mkdirSync(join(revisionDir, 'suite'), { recursive: true });
  const markerPath = join(revisionDir, 'rules', 'marker.mjs');
  const todoPath = join(revisionDir, 'rules', 'todo.mjs');
  const suitePath = join(revisionDir, 'suite', 'guard.mjs');
  writeFileSync(markerPath, MARKER_RULE);
  writeFileSync(todoPath, TODO_RULE);
  writeFileSync(suitePath, SUITE);

  const scenarios = [
    { id: 'marker', taskClass, argv: ['node', markerPath], expectExit: [0] },
    { id: 'todo', taskClass, argv: ['node', todoPath], expectExit: [0] },
  ];
  writeFileSync(
    join(revisionDir, 'manifest.json'),
    `${JSON.stringify(
      {
        revision: 'h-docs-hygiene-2026-11-08T120000-abcd1234',
        taskClass,
        scenarios,
        revisionHash: contentHash(hashableScenarios(scenarios)),
      },
      null,
      2,
    )}\n`,
  );
  const descriptorPath = join(revisionDir, 'class.json');
  writeFileSync(
    descriptorPath,
    `${JSON.stringify(
      {
        taskClass,
        visibleCheck: { argv: ['node', suitePath], requireSummary: true },
        rules: ['marker', 'todo'],
        visibleRules: input.visibleRules ?? ['marker'],
        mutationMatrix: [
          { defect: 'delete marker.txt', redRules: ['marker'] },
          { defect: 'add a TODO to todo.txt', redRules: ['todo'] },
        ],
      },
      null,
      2,
    )}\n`,
  );

  const base = tempDir('factory-doctor-base-');
  writeTree(base, { 'todo.txt': 'ship it\nTODO: wire the detector\n' });
  const repair = tempDir('factory-doctor-repair-');
  writeTree(repair, { 'marker.txt': 'present\n', 'todo.txt': 'ship it\n' });

  return { root, base, repair, revisionDir, descriptorPath, suitePath };
}

const runner: ClassDoctorRunner = (argv, cwd) => {
  const result = require('node:child_process').spawnSync(argv[0], argv.slice(1), {
    cwd,
    encoding: 'utf8',
  }) as { status: number | null; stdout: string; stderr: string };
  const outcome: CommandOutcome = {
    code: result.status,
    output: `${result.stdout}${result.stderr}`,
  };
  return outcome;
};

function findingsById(report: ReturnType<typeof diagnoseClass>): Map<string, string> {
  return new Map(report.findings.map((finding) => [finding.id, finding.severity]));
}

describe('a corpus that is worth certifying passes every check', () => {
  it('exits 0 only when the bases are red, the repair is green and the declaration matches', () => {
    const f = fixture();
    const report = diagnoseClass({
      corpusRoot: f.root,
      taskClass: 'docs-hygiene',
      runner,
      basePaths: [f.base],
      repairPath: f.repair,
      expectedRevision: 'h-docs-hygiene-2026-11-08T120000-abcd1234',
    });
    const severities = findingsById(report);
    const failures = report.findings.filter((finding) => finding.severity !== 'ok');
    expect(failures.map((finding) => `${finding.id}: ${finding.detail}`)).toEqual([]);
    expect(report.exitCode).toBe(0);
    expect(severities.get('bases_red')).toBe('ok');
    expect(severities.get('repair_green')).toBe('ok');
    expect(severities.get('visible_check_is_strict_subset')).toBe('ok');
    expect(severities.get('matrix_covers_every_rule')).toBe('ok');
    expect(report.revision).toBe('h-docs-hygiene-2026-11-08T120000-abcd1234');
    expect(report.revisionHash).toBe(
      contentHash(
        hashableScenarios([
          {
            id: 'marker',
            taskClass: 'docs-hygiene',
            argv: ['node', join(f.revisionDir, 'rules', 'marker.mjs')],
            expectExit: [0],
          },
          {
            id: 'todo',
            taskClass: 'docs-hygiene',
            argv: ['node', join(f.revisionDir, 'rules', 'todo.mjs')],
            expectExit: [0],
          },
        ]),
      ),
    );
  });
});

describe('each refusal names the property it defends', () => {
  it('refuses a visible check that covers every rule: the wall would be a mirror', () => {
    const f = fixture({ visibleRules: ['marker', 'todo'] });
    const report = diagnoseClass({
      corpusRoot: f.root,
      taskClass: 'docs-hygiene',
      runner,
      basePaths: [f.base],
      repairPath: f.repair,
    });
    expect(report.exitCode).toBe(3);
    const finding = report.findings.find((entry) => entry.id === 'visible_check_is_strict_subset');
    expect(finding?.severity).toBe('policy');
    expect(finding?.detail).toContain('mirror');
  });

  it('refuses an empty visibleRules: the worker gets no signal at all', () => {
    const f = fixture({ visibleRules: [] });
    const report = diagnoseClass({
      corpusRoot: f.root,
      taskClass: 'docs-hygiene',
      runner,
      basePaths: [f.base],
      repairPath: f.repair,
    });
    expect(report.exitCode).toBe(3);
    expect(
      report.findings.find((entry) => entry.id === 'visible_check_enforces_something')?.severity,
    ).toBe('policy');
  });

  it('refuses a base revision that passes a rule it should fail', () => {
    const f = fixture();
    const report = diagnoseClass({
      corpusRoot: f.root,
      taskClass: 'docs-hygiene',
      runner,
      basePaths: [f.repair],
      repairPath: f.repair,
    });
    expect(report.exitCode).toBe(3);
    const finding = report.findings.find((entry) => entry.id === 'bases_red');
    expect(finding?.severity).toBe('policy');
    expect(finding?.detail).toContain('certifies nothing');
  });

  it('refuses a repaired tree that fails the class it is the repair for', () => {
    const f = fixture();
    const report = diagnoseClass({
      corpusRoot: f.root,
      taskClass: 'docs-hygiene',
      runner,
      basePaths: [f.base],
      repairPath: f.base,
    });
    expect(report.exitCode).toBe(3);
    expect(report.findings.find((entry) => entry.id === 'repair_green')?.severity).toBe('policy');
  });

  it('refuses a mutation matrix that leaves a rule uncovered', () => {
    const f = fixture();
    const descriptor = JSON.parse(readFileSync(f.descriptorPath, 'utf8')) as {
      mutationMatrix: { defect: string; redRules: string[] }[];
    };
    descriptor.mutationMatrix = [{ defect: 'delete marker.txt', redRules: ['marker'] }];
    writeFileSync(f.descriptorPath, `${JSON.stringify(descriptor, null, 2)}\n`);
    const report = diagnoseClass({
      corpusRoot: f.root,
      taskClass: 'docs-hygiene',
      runner,
      basePaths: [f.base],
      repairPath: f.repair,
    });
    expect(report.exitCode).toBe(3);
    const finding = report.findings.find((entry) => entry.id === 'matrix_covers_every_rule');
    expect(finding?.detail).toContain('todo');
  });

  it('refuses a class with no descriptor: nothing declared what it measures', () => {
    const f = fixture();
    rmSync(f.descriptorPath);
    const report = diagnoseClass({
      corpusRoot: f.root,
      taskClass: 'docs-hygiene',
      runner,
      basePaths: [f.base],
      repairPath: f.repair,
    });
    expect(report.exitCode).toBe(3);
    expect(report.findings.find((entry) => entry.id === 'descriptor_present')?.severity).toBe(
      'policy',
    );
  });

  it('refuses a corpus whose selected revision is not the one under test', () => {
    const f = fixture();
    const report = diagnoseClass({
      corpusRoot: f.root,
      taskClass: 'docs-hygiene',
      runner,
      basePaths: [f.base],
      repairPath: f.repair,
      expectedRevision: 'h-docs-hygiene-2026-11-08T110000-older000',
    });
    expect(report.exitCode).toBe(3);
    expect(report.findings.find((entry) => entry.id === 'revision_selected')?.severity).toBe(
      'policy',
    );
  });

  it('reports a run it could not make as environment, never as a pass', () => {
    const f = fixture();
    const report = diagnoseClass({ corpusRoot: f.root, taskClass: 'docs-hygiene', runner });
    expect(report.exitCode).toBe(8);
    expect(report.findings.find((entry) => entry.id === 'bases_red')?.severity).toBe('environment');
    expect(report.findings.find((entry) => entry.id === 'repair_green')?.severity).toBe(
      'environment',
    );
  });

  it('reports an unreadable descriptor as integrity, not policy', () => {
    const f = fixture();
    writeFileSync(f.descriptorPath, '{ not json');
    const report = diagnoseClass({
      corpusRoot: f.root,
      taskClass: 'docs-hygiene',
      runner,
      basePaths: [f.base],
      repairPath: f.repair,
    });
    expect(report.exitCode).toBe(9);
    expect(report.findings.find((entry) => entry.id === 'descriptor_present')?.severity).toBe(
      'integrity',
    );
  });

  it('reports a class the loader refuses as integrity: there is nothing to judge', () => {
    const f = fixture();
    rmSync(join(f.revisionDir, 'manifest.json'));
    const report = diagnoseClass({
      corpusRoot: f.root,
      taskClass: 'docs-hygiene',
      runner,
      basePaths: [f.base],
      repairPath: f.repair,
    });
    expect(report.exitCode).toBe(9);
    expect(report.findings.map((entry) => entry.id)).toEqual(['corpus_loads']);
  });
});

describe('the descriptor parser refuses declarations that would certify a subset', () => {
  it('rejects a defect that reddens nothing', () => {
    const parsed = parseClassDescriptor({
      taskClass: 'docs-hygiene',
      visibleCheck: { argv: ['node', 'guard.mjs'], requireSummary: true },
      rules: ['marker'],
      visibleRules: [],
      mutationMatrix: [{ defect: 'delete marker.txt', redRules: [] }],
    });
    expect(parsed.kind).toBe('invalid');
    if (parsed.kind === 'invalid') expect(parsed.reason).toContain('proves nothing');
  });

  it('rejects a visible check with no argv', () => {
    const parsed = parseClassDescriptor({
      taskClass: 'docs-hygiene',
      visibleCheck: { argv: [], requireSummary: true },
      rules: ['marker'],
      visibleRules: [],
      mutationMatrix: [],
    });
    expect(parsed.kind).toBe('invalid');
  });
});

describe('a freshly scaffolded class is red by construction', () => {
  it('fails the doctor on the descriptor counts, and passes the loader', () => {
    const root = tempDir('factory-scaffold-root-');
    const result = scaffoldClass({
      corpusRoot: root,
      taskClass: 'import-hygiene',
      ruleIds: ['no-extensionless-import', 'no-transpiler-syntax'],
      visibleCheckArgv: ['node', 'tools/check-imports.mjs'],
      now: new Date('2026-11-08T12:00:00.000Z'),
    });
    // The revision name carries a hash of the sources that were written (rules, suite, visible argv), not
    // the scenario hash: the same arguments must rewrite the same revision, and a changed stub must be a
    // new one. The exact digest is not asserted here, the property is (it is stable below).
    expect(result.revision).toMatch(/^h-import-hygiene-2026-11-08T120000-[0-9a-f]{8}$/u);
    const report = diagnoseClass({ corpusRoot: root, taskClass: 'import-hygiene', runner });
    // No bases and no repair were given, so those two are `environment`; the scaffold's own faults are policy.
    expect(report.exitCode).toBe(3);
    expect(report.revision).toBe(result.revision);
    const failed = report.findings
      .filter((finding) => finding.severity === 'policy')
      .map((finding) => finding.id);
    expect(failed).toContain('visible_check_enforces_something');
    expect(failed).toContain('matrix_defect_reddens_something');
    expect(failed).toContain('matrix_covers_every_rule');
    // Same inputs, same revision name, even in a different root: a class is identified by what was written.
    const again = scaffoldClass({
      corpusRoot: tempDir('factory-scaffold-root-again-'),
      taskClass: 'import-hygiene',
      ruleIds: ['no-extensionless-import', 'no-transpiler-syntax'],
      visibleCheckArgv: ['node', 'tools/check-imports.mjs'],
      now: new Date('2026-11-08T12:00:00.000Z'),
    });
    expect(again.revision).toBe(result.revision);

    // The stub rules fail, which is the property the scaffold exists to guarantee.
    const ruleRun = runner(
      ['node', join(result.directory, 'rules', 'no-transpiler-syntax.mjs')],
      root,
    );
    expect(ruleRun.code).toBe(1);
    expect(ruleRun.output).toContain('fails on purpose');
  });
});
