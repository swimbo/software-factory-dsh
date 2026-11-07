/**
 * `factory class` — authoring a task class, and judging whether it is worth certifying.
 *
 * Two actions, two different kinds of verb:
 *
 * - **`class new`** writes a class that is red by construction into a holdout root. It touches no
 *   repository and generates no rules: a rule is a claim about a defect, and a generator would produce
 *   plausible patterns with no defect behind them.
 * - **`class doctor`** runs the class and answers the twelve questions in `classes/doctor.ts`. It is
 *   read-only with respect to the corpus — it checks out base revisions into a temp directory, runs the
 *   rules, and reports. It never repairs anything, because "the doctor said my class was wrong" and "the
 *   doctor changed my class" must not be the same event.
 *
 * Neither action spends model tokens: rules and the visible check are local commands. Certification is a
 * separate verb with a separate budget (`docs/runbooks/certify-class.md`).
 *
 * Exit codes follow the doctor's worst finding: 0 clean, 3 the class's contract is wrong, 8 a check could
 * not run (no repo, no repaired tree), 9 the corpus or descriptor is unreadable or lies about itself.
 */
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { defaultHoldoutRoot } from '@factory/wall';

import { diagnoseClass, type CommandOutcome, type DoctorReport } from '../classes/doctor.ts';
import { scaffoldClass } from '../classes/scaffold.ts';
import { EXIT, UsageError } from '../exit.ts';
import { field } from '../render/format.ts';
import { boolOption, requiredOption, textOption, type VerbInput, type VerbSpec } from './types.ts';

function collect(value: string, previous: string[]): string[] {
  return [...previous, value];
}

/** Run one local command with the tree as its working directory. Never through a shell. */
function runLocal(argv: readonly string[], cwd: string): CommandOutcome {
  const [program, ...rest] = argv;
  if (program === undefined) return { code: null, output: 'empty argv' };
  const result = spawnSync(program, rest, {
    cwd,
    encoding: 'utf8',
    env: { ...process.env, FACTORY_CLASS_DOCTOR: '1' },
    maxBuffer: 16 * 1024 * 1024,
  });
  if (result.error !== undefined) return { code: null, output: result.error.message };
  const output = `${result.stdout ?? ''}${result.stderr ?? ''}`;
  return { code: result.status, output };
}

/**
 * Extract one revision of a repository into a directory.
 *
 * `git archive` works on both a bare mirror and a working clone, and produces the tree without a `.git`,
 * so a rule that walks the tree cannot see history and cannot be satisfied by it.
 */
function extractRevision(repo: string, revision: string, into: string): void {
  const archive = spawnSync('git', ['-C', repo, 'archive', '--format=tar', revision], {
    encoding: 'buffer',
    maxBuffer: 512 * 1024 * 1024,
  });
  if (archive.error !== undefined || archive.status !== 0) {
    const detail = Buffer.isBuffer(archive.stderr) ? archive.stderr.toString('utf8') : '';
    throw new UsageError(
      `USAGE: cannot read ${revision} from ${repo}: ${archive.error?.message ?? detail.trim() ?? 'git archive failed'}`,
    );
  }
  const extract = spawnSync('tar', ['-x', '-C', into], {
    input: archive.stdout,
    encoding: 'buffer',
  });
  if (extract.error !== undefined || extract.status !== 0) {
    const detail = Buffer.isBuffer(extract.stderr) ? extract.stderr.toString('utf8') : '';
    throw new UsageError(
      `USAGE: cannot extract ${revision}: ${extract.error?.message ?? detail.trim()}`,
    );
  }
}

function renderReport(report: DoctorReport): string[] {
  const lines: string[] = [];
  for (const finding of report.findings) {
    const mark =
      finding.severity === 'ok' ? 'ok  ' : finding.severity === 'policy' ? 'FAIL' : 'CANNOT';
    lines.push(`  ${mark} ${finding.id.padEnd(32)} ${finding.detail}`);
  }
  return lines;
}

function runClassNew(input: VerbInput): number {
  const taskClass = requiredOption(
    input.options,
    'class',
    'The task class name; it becomes <root>/<class>/ and must match ^[a-z0-9][a-z0-9-]{0,63}$.',
  );
  const root = textOption(input.options, 'root') ?? defaultHoldoutRoot();
  const rules = Array.isArray(input.options['rule']) ? (input.options['rule'] as string[]) : [];
  if (rules.length === 0) {
    throw new UsageError(
      'USAGE: at least one --rule <id> is required. A class with no rules certifies everything; write one ' +
        'stub per defect the class exists to catch, e.g. --rule no-trailing-whitespace.',
    );
  }
  const visible = textOption(input.options, 'visible');
  if (visible === undefined) {
    throw new UsageError(
      'USAGE: --visible "<command>" is required: the wall needs the command the worker can also run. ' +
        'Quote it, e.g. --visible "node tools/check.sh".',
    );
  }
  const result = scaffoldClass({
    corpusRoot: root,
    taskClass,
    ruleIds: rules,
    visibleCheckArgv: visible.split(/\s+/u).filter((part) => part !== ''),
    requireSummary: !boolOption(input.options, 'no-summary'),
    ...(textOption(input.options, 'revision') === undefined
      ? {}
      : { revision: textOption(input.options, 'revision') as string }),
  });

  for (const path of result.files) console.log(`  wrote ${path}`);
  console.log('');
  console.log(
    `Class ${taskClass} revision ${result.revision} is red by construction (${result.revisionHash}).`,
  );
  console.log('');
  console.log(
    'It is not authorable yet. The next command shows why, and every finding is a sentence to write:',
  );
  console.log(`  ${result.doctorCommand}`);
  input.emit({
    ok: true,
    action: 'new',
    taskClass,
    revision: result.revision,
    revisionHash: result.revisionHash,
    directory: result.directory,
    files: result.files,
    doctor: result.doctorCommand,
  });
  return EXIT.ok;
}

function runClassDoctor(input: VerbInput): number {
  const taskClass = requiredOption(
    input.options,
    'class',
    'The task class name to judge, e.g. docs-hygiene.',
  );
  const root = textOption(input.options, 'root') ?? defaultHoldoutRoot();
  const repo = textOption(input.options, 'repo');
  const repairs = textOption(input.options, 'repair');
  const baseRevs = Array.isArray(input.options['base'])
    ? (input.options['base'] as string[])
    : typeof input.options['base'] === 'string'
      ? [input.options['base'] as string]
      : [];
  if (repo !== undefined && baseRevs.length === 0) {
    throw new UsageError(
      'USAGE: --repo needs at least one --base <sha>; the doctor checks that every base revision fails every ' +
        'rule, and a repo without revisions would check nothing.',
    );
  }

  const scratch: string[] = [];
  const cleanup = (): void => {
    for (const path of scratch) rmSync(path, { recursive: true, force: true });
  };
  try {
    const basePaths = baseRevs.map((revision) => {
      const path = mkdtempSync(join(tmpdir(), 'factory-class-base-'));
      scratch.push(path);
      if (repo !== undefined) extractRevision(repo, revision, path);
      return path;
    });

    const report = diagnoseClass({
      corpusRoot: root,
      taskClass,
      runner: runLocal,
      ...(basePaths.length === 0 ? {} : { basePaths }),
      ...(repairs === undefined ? {} : { repairPath: repairs }),
      ...(textOption(input.options, 'revision') === undefined
        ? {}
        : { expectedRevision: textOption(input.options, 'revision') as string }),
    });

    console.log(
      `CLASS DOCTOR  ${report.taskClass}  revision ${report.revision ?? '(none)'}  ${report.revisionHash ?? ''}`.trim(),
    );
    for (const line of renderReport(report)) console.log(line);
    const failed = report.findings.filter((finding) => finding.severity === 'policy').length;
    const cannot = report.findings.filter(
      (finding) => finding.severity !== 'ok' && finding.severity !== 'policy',
    ).length;
    console.log('');
    if (failed === 0 && cannot === 0) {
      console.log(
        `clean: ${String(report.findings.length)} check(s) passed. The class is authored; certification is a ` +
          'separate, spending decision (docs/runbooks/certify-class.md).',
      );
    } else {
      // FAIL and CANNOT are different answers: a failed check is the class's fault, a check that could not run
      // is the invocation's, and adding the two together would tell an operator their corpus is worse than it is.
      const parts: string[] = [];
      if (failed > 0) parts.push(`${String(failed)} failed`);
      if (cannot > 0) parts.push(`${String(cannot)} could not run`);
      console.log(
        `${parts.join(', ')} of ${String(report.findings.length)} check(s) (exit ${String(report.exitCode)}). ` +
          'Nothing was repaired: each finding names the sentence that would fix it.',
      );
    }
    input.emit({
      ok: report.exitCode === EXIT.ok,
      action: 'doctor',
      taskClass: report.taskClass,
      revision: report.revision,
      revisionHash: report.revisionHash,
      rules: report.rules,
      exitCode: report.exitCode,
      findings: report.findings,
    });
    return report.exitCode;
  } finally {
    cleanup();
  }
}

export const classVerb: VerbSpec = {
  name: 'class',
  verb: 'class',
  summary:
    'Scaffold a task class that starts red, or judge whether an existing class is worth certifying',
  arguments: ['[action]'],
  configure: (command) =>
    command
      .option('--class <name>', 'the task class')
      .option('--root <dir>', 'holdout root (default: ~/.factory/holdout)')
      .option('--rule <id>', 'a rule id to scaffold; repeat per rule', collect, [] as string[])
      .option(
        '--visible <command>',
        'the visible check the wall runs, quoted, e.g. "node tools/check.sh"',
      )
      .option('--no-summary', 'the visible check need not print FACTORY_SUMMARY (not recommended)')
      .option('--revision <name>', 'fix the revision name instead of deriving it')
      .option('--repo <dir>', 'repository or bare mirror holding the base revisions')
      .option(
        '--base <sha>',
        'a base revision that must fail every rule; repeat per revision',
        collect,
        [] as string[],
      )
      .option('--repair <dir>', 'a repaired tree that must pass every rule'),
  action: (input) => {
    const action = (input.args[0] ?? '').trim();
    if (action === 'new') return runClassNew(input);
    if (action === 'doctor') return runClassDoctor(input);
    throw new UsageError(
      `USAGE: factory class <new|doctor>; got ${action === '' ? 'nothing' : JSON.stringify(action)}. ` +
        '`new` writes a corpus that starts red; `doctor` judges one that exists. Neither spends tokens.',
    );
  },
};
