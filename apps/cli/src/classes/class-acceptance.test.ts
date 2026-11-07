/**
 * The definition of done for the authoring path: re-create `import-hygiene` through `class new` and
 * `class doctor`, with nothing copied from `e2e/certification/import-substrate.ts`.
 *
 * That suite builds the same class by writing its corpus from TypeScript, which is how a class was
 * authored before `factory class`. Its rules, its fixture farm and its manifest are deliberately *not*
 * imported here: the question is whether a person with a repository can arrive at a class the doctor
 * accepts, so the corpus below is written from the repository up — two stubs from the scaffolder, a
 * repository with two defective revisions and one repaired revision, and the descriptor rows that name
 * what each rule must catch.
 *
 * The negative half matters as much as the positive one: the same class, judged against the repaired tree
 * as if it were a base, must be refused. A doctor that only ever says yes is a doctor that certifies
 * classes which pass defective trees.
 */
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { diagnoseClass, type ClassDoctorRunner } from './doctor.ts';
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

const git = (cwd: string, args: readonly string[]): string => {
  const result = spawnSync('git', args, { cwd, encoding: 'utf8' });
  if (result.status !== 0) throw new Error(`git ${args.join(' ')}: ${result.stderr}`);
  return result.stdout;
};

const runner: ClassDoctorRunner = (argv, cwd) => {
  const [program, ...rest] = argv;
  if (program === undefined) return { code: null, output: 'empty argv' };
  const result = spawnSync(program, rest, { cwd, encoding: 'utf8' });
  return {
    code: result.error === undefined ? result.status : null,
    output: `${result.stdout ?? ''}${result.stderr ?? ''}`,
  };
};

/** Two rules that a real repository can exhibit: extensionless relative imports, and default exports. */
const IMPORT_EXTENSION_RULE = `import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';

const walk = (dir) => {
  const out = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...walk(path));
    else if (entry.name.endsWith('.ts')) out.push(path);
  }
  return out;
};

const problems = [];
for (const file of walk('src')) {
  const text = readFileSync(file, 'utf8');
  for (const match of text.matchAll(/from '(\\.[^']*)'/gu)) {
    const target = match[1];
    if (!target.endsWith('.ts')) problems.push(file + ': import "' + target + '" has no .ts extension');
  }
}
for (const problem of problems) console.log('import-extension: ' + problem);
process.exit(problems.length === 0 ? 0 : 1);
`;

const NO_DEFAULT_EXPORT_RULE = `import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

const walk = (dir) => {
  const out = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...walk(path));
    else if (entry.name.endsWith('.ts')) out.push(path);
  }
  return out;
};

const problems = [];
for (const file of walk('src')) {
  if (/^export default /mu.test(readFileSync(file, 'utf8'))) problems.push(file + ': default export');
}
for (const problem of problems) console.log('no-default-export: ' + problem);
process.exit(problems.length === 0 ? 0 : 1);
`;

/** The visible check: it enforces one rule of the two, and prints the summary the wall reads. */
const VISIBLE_CHECK = `import { spawnSync } from 'node:child_process';

const result = spawnSync('node', ['tools/check-extensions.mjs'], { encoding: 'utf8' });
process.stdout.write(result.stdout ?? '');
const ok = result.status === 0;
console.log('FACTORY_SUMMARY ' + JSON.stringify({ passed: ok ? 1 : 0, failed: ok ? 0 : 1, unknown: 0, exitCode: ok ? 0 : 1 }));
process.exit(ok ? 0 : 1);
`;

const CHECK_EXTENSIONS = `import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

const walk = (dir) => {
  const out = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...walk(path));
    else if (entry.name.endsWith('.ts')) out.push(path);
  }
  return out;
};

let bad = 0;
for (const file of walk('src')) {
  if (/from '\\.[^']*[^s]'/u.test(readFileSync(file, 'utf8'))) { bad += 1; console.log(file + ': extensionless import'); }
}
process.exit(bad === 0 ? 0 : 1);
`;

/** A repository with two defective revisions and one repaired revision. */
function buildRepository(): {
  readonly repo: string;
  readonly bases: readonly string[];
  readonly repair: string;
} {
  const repo = tempDir('factory-acceptance-repo-');
  git(repo, ['init', '--quiet', '--initial-branch=main']);
  git(repo, ['config', 'user.email', 'operator@example.test']);
  git(repo, ['config', 'user.name', 'operator']);
  mkdirSync(join(repo, 'src'), { recursive: true });
  mkdirSync(join(repo, 'tools'), { recursive: true });
  writeFileSync(join(repo, 'tools', 'check-extensions.mjs'), CHECK_EXTENSIONS);

  const defective = (label: string): string => {
    writeFileSync(join(repo, 'src', 'b.ts'), `export const b = 1; // ${label}\n`);
    writeFileSync(join(repo, 'src', 'a.ts'), `import { b } from './b';\nexport const a = b + 1;\n`);
    writeFileSync(join(repo, 'src', 'c.ts'), `export default function c() {\n  return 2;\n}\n`);
    git(repo, ['add', '-A']);
    git(repo, ['commit', '--quiet', '-m', `defective ${label}`]);
    return git(repo, ['rev-parse', 'HEAD']).trim();
  };

  const first = defective('one');
  const second = defective('two');

  writeFileSync(
    join(repo, 'src', 'a.ts'),
    `import { b } from './b.ts';\nexport const a = b + 1;\n`,
  );
  writeFileSync(join(repo, 'src', 'c.ts'), `export function c() {\n  return 2;\n}\n`);
  git(repo, ['add', '-A']);
  git(repo, ['commit', '--quiet', '-m', 'repair']);
  const repairRev = git(repo, ['rev-parse', 'HEAD']).trim();

  const repair = tempDir('factory-acceptance-repair-');
  const archive = spawnSync('git', ['-C', repo, 'archive', '--format=tar', repairRev], {
    encoding: 'buffer',
  });
  spawnSync('tar', ['-x', '-C', repair], { input: archive.stdout });
  return { repo, bases: [first, second], repair };
}

function materialise(repo: string, revision: string): string {
  const dir = tempDir('factory-acceptance-base-');
  const archive = spawnSync('git', ['-C', repo, 'archive', '--format=tar', revision], {
    encoding: 'buffer',
  });
  spawnSync('tar', ['-x', '-C', dir], { input: archive.stdout });
  return dir;
}

describe('import-hygiene, re-created through the authoring path', () => {
  it('goes from a scaffold that fails every rule to a class the doctor accepts', () => {
    const root = tempDir('factory-acceptance-holdout-');
    const { repo, bases, repair } = buildRepository();

    const scaffold = scaffoldClass({
      corpusRoot: root,
      taskClass: 'import-hygiene',
      ruleIds: ['import-extension', 'no-default-export'],
      visibleCheckArgv: ['node', 'tools/check-visible.mjs'],
      now: new Date('2026-11-08T12:00:00.000Z'),
    });

    // The scaffolder wrote stubs, and stubs fail: that is the property it exists for.
    const beforeAuthoring = diagnoseClass({
      corpusRoot: root,
      taskClass: 'import-hygiene',
      runner,
    });
    expect(beforeAuthoring.exitCode).toBe(3);
    expect(
      beforeAuthoring.findings.filter((finding) => finding.severity === 'policy').length,
    ).toBeGreaterThan(0);

    // Author the corpus: real rules, a visible check that enforces one of the two, and the matrix.
    writeFileSync(join(scaffold.directory, 'rules', 'import-extension.mjs'), IMPORT_EXTENSION_RULE);
    writeFileSync(
      join(scaffold.directory, 'rules', 'no-default-export.mjs'),
      NO_DEFAULT_EXPORT_RULE,
    );
    writeFileSync(join(scaffold.directory, 'suite', 'import-hygiene-guard.mjs'), VISIBLE_CHECK);
    writeFileSync(
      join(scaffold.directory, 'class.json'),
      `${JSON.stringify(
        {
          taskClass: 'import-hygiene',
          visibleCheck: {
            argv: ['node', join(scaffold.directory, 'suite', 'import-hygiene-guard.mjs')],
            requireSummary: true,
          },
          rules: ['import-extension', 'no-default-export'],
          visibleRules: ['import-extension'],
          mutationMatrix: [
            {
              defect: 'write a relative import without its .ts extension',
              redRules: ['import-extension'],
            },
            { defect: 'add an export default to src/c.ts', redRules: ['no-default-export'] },
          ],
        },
        null,
        2,
      )}\n`,
    );

    // The visible check runs from the tree, so the tree needs it: the repaired revision carries tools/.
    const basePaths = bases.map((revision) => materialise(repo, revision));
    const report = diagnoseClass({
      corpusRoot: root,
      taskClass: 'import-hygiene',
      runner,
      basePaths,
      repairPath: repair,
      expectedRevision: scaffold.revision,
    });
    const failures = report.findings.filter((finding) => finding.severity !== 'ok');
    expect(failures.map((finding) => `${finding.id}: ${finding.detail}`)).toEqual([]);
    expect(report.exitCode).toBe(0);
    expect(report.rules).toEqual(['import-extension', 'no-default-export']);

    // The same class judged against the repaired tree as if it were a base: refused, because a corpus that
    // passes a defective tree certifies nothing.
    const dishonest = diagnoseClass({
      corpusRoot: root,
      taskClass: 'import-hygiene',
      runner,
      basePaths: [repair],
      repairPath: repair,
    });
    expect(dishonest.exitCode).toBe(3);
    expect(dishonest.findings.find((finding) => finding.id === 'bases_red')?.severity).toBe(
      'policy',
    );
  }, 60_000);
});
