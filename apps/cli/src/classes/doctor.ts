/**
 * `factory class doctor`: the checks that decide whether a task class is worth certifying.
 *
 * Every check here exists because a class can look finished and measure nothing. The doctor is not a
 * linter for style; it is the list of ways a corpus lies about itself, each answered by running something
 * rather than reading it:
 *
 * | finding | what would be true if it were skipped |
 * | --- | --- |
 * | `corpus_loads` | the wall would verify candidates against scenarios the operator already replaced |
 * | `revision_selected` | the class you are looking at is not the class the wall would use |
 * | `descriptor_present` | nobody declared what the class measures, so nothing can be checked |
 * | `descriptor_matches_manifest` | the class promises rules the corpus does not run |
 * | `visible_check_is_strict_subset` | the wall is a mirror: the worker can see every rule it is judged by |
 * | `matrix_covers_every_rule` | a rule has never been observed failing |
 * | `matrix_defect_reddens_something` | a matrix row proves nothing about the defect it names |
 * | `bases_red` | the corpus passes a defective tree, so it certifies nothing |
 * | `visible_check_sees_a_base` | the visible signal cannot see the defect at all |
 * | `repair_green` | the class is unrepairable, so every candidate fails for the base's reason |
 * | `visible_check_green_on_repair` | a correct change is refused by the worker's own gate |
 * | `suite_prints_summary` | the pinned suite is `unknown`, never a pass |
 *
 * Two rules of the doctor itself:
 *
 * - **It runs everything it can and reports every finding**, rather than stopping at the first. A report
 *   that names one fault per invocation turns fixing a class into a queue.
 * - **It never repairs anything.** It prints the command that would show the fault and the sentence that
 *   says what would have to change. Editing a corpus to satisfy the doctor is the operator's decision.
 *
 * Exit code is the worst finding's severity: 3 policy (the class's contract is wrong), 8 environment (a
 * check could not run), 9 integrity (the corpus or descriptor is unreadable or lies about its own hash), 0
 * clean. `unknown` is never a pass, here as everywhere else.
 */
import { EXIT, type ExitCode } from '../exit.ts';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { loadHoldout, type HoldoutStore } from '@factory/wall';
import { readClassDescriptor, type ClassDescriptor } from './descriptor.ts';

export interface CommandOutcome {
  /** `null` when the command could not be started at all. */
  readonly code: number | null;
  readonly output: string;
}

export type ClassDoctorRunner = (argv: readonly string[], cwd: string) => CommandOutcome;

export type FindingSeverity = 'ok' | 'policy' | 'integrity' | 'environment';

export interface DoctorFinding {
  readonly id: string;
  readonly severity: FindingSeverity;
  /** One sentence, in the operator's terms: what is true, or what is wrong and what would fix it. */
  readonly detail: string;
}

export interface DoctorInput {
  readonly corpusRoot: string;
  readonly taskClass: string;
  readonly runner: ClassDoctorRunner;
  /** Directories holding each base revision, already materialised by the caller. */
  readonly basePaths?: readonly string[];
  /** A directory holding the repaired tree. */
  readonly repairPath?: string;
  /** When set, the loader's chosen revision must be this one. */
  readonly expectedRevision?: string;
}

export interface DoctorReport {
  readonly findings: readonly DoctorFinding[];
  readonly exitCode: ExitCode;
  readonly taskClass: string;
  readonly revision: string | null;
  readonly revisionHash: string | null;
  readonly rules: readonly string[];
}

const SEVERITY_ORDER: readonly FindingSeverity[] = ['ok', 'environment', 'integrity', 'policy'];

function ok(id: string, detail: string): DoctorFinding {
  return { id, severity: 'ok', detail };
}

function bad(id: string, severity: Exclude<FindingSeverity, 'ok'>, detail: string): DoctorFinding {
  return { id, severity, detail };
}

function exitCodeFor(findings: readonly DoctorFinding[]): ExitCode {
  let worst: FindingSeverity = 'ok';
  for (const finding of findings) {
    if (SEVERITY_ORDER.indexOf(finding.severity) > SEVERITY_ORDER.indexOf(worst))
      worst = finding.severity;
  }
  if (worst === 'policy') return EXIT.policy;
  if (worst === 'integrity') return EXIT.integrity;
  if (worst === 'environment') return EXIT.environment;
  return EXIT.ok;
}

/** Run every rule in the corpus against a tree; returns the ids that failed. */
function failingRules(
  store: HoldoutStore,
  treePath: string,
  runner: ClassDoctorRunner,
): { readonly failed: readonly string[]; readonly passing: readonly string[] } {
  const failed: string[] = [];
  const passing: string[] = [];
  for (const scenario of store.scenarios) {
    const outcome = runner(scenario.argv, treePath);
    // A rule that could not run is not a rule that passed: it counts as failing, and the detail says so
    // through the caller's report of the raw outcome.
    const expectation = scenario.expectExit;
    const matched = outcome.code !== null && expectation.includes(outcome.code);
    if (matched) passing.push(scenario.id);
    else failed.push(scenario.id);
  }
  return { failed, passing };
}

function describeOutcomes(
  store: HoldoutStore,
  treePath: string,
  runner: ClassDoctorRunner,
): string {
  const parts: string[] = [];
  for (const scenario of store.scenarios) {
    const outcome = runner(scenario.argv, treePath);
    const firstLine =
      outcome.output.split('\n').find((line) => line.trim() !== '') ?? '(no output)';
    parts.push(
      `${scenario.id}=${outcome.code === null ? 'not-started' : String(outcome.code)} (${firstLine.trim()})`,
    );
  }
  return parts.join('; ');
}

/**
 * The hash the loader accepted, for the report only. `HoldoutStore` deliberately does not carry it — the
 * wall needs the scenarios, not the digest — so the digest is read back from the manifest that produced
 * the store, and a manifest that changed under us after the load is a race the report should not hide.
 */
function revisionHashOf(revisionDir: string, revision: string): string | null {
  try {
    const parsed: unknown = JSON.parse(readFileSync(join(revisionDir, 'manifest.json'), 'utf8'));
    if (typeof parsed !== 'object' || parsed === null) return null;
    const value = (parsed as Record<string, unknown>)['revisionHash'];
    if (typeof value !== 'string') return null;
    const declared = (parsed as Record<string, unknown>)['revision'];
    return declared === revision ? value : null;
  } catch {
    return null;
  }
}

function summarised(output: string): boolean {
  return output.split('\n').some((line) => line.trimStart().startsWith('FACTORY_SUMMARY '));
}

/** The visible check, as the wall runs it: one command, one exit code, one summary line. */
function runVisibleCheck(
  descriptor: ClassDescriptor,
  treePath: string,
  runner: ClassDoctorRunner,
): CommandOutcome {
  return runner(descriptor.visibleCheck.argv, treePath);
}

/**
 * Judge one class. Pure with respect to the corpus: it reads, runs the declared scenarios, and returns
 * findings. Nothing is written, nothing is repaired.
 */
export function diagnoseClass(input: DoctorInput): DoctorReport {
  const findings: DoctorFinding[] = [];
  const store = loadHoldout(input.corpusRoot, input.taskClass);

  if (store === null) {
    findings.push(
      bad(
        'corpus_loads',
        'integrity',
        `no loadable corpus for class ${input.taskClass} under ${input.corpusRoot}; the wall would verify ` +
          'candidates against nothing. Check that <root>/<class>/<revision>/manifest.json exists and that its ' +
          'revisionHash describes the scenarios it contains.',
      ),
    );
    return {
      findings,
      exitCode: exitCodeFor(findings),
      taskClass: input.taskClass,
      revision: null,
      revisionHash: null,
      rules: [],
    };
  }

  findings.push(
    ok(
      'corpus_loads',
      `corpus ${store.revision} with ${String(store.scenarios.length)} scenario(s)`,
    ),
  );
  if (input.expectedRevision !== undefined && store.revision !== input.expectedRevision) {
    findings.push(
      bad(
        'revision_selected',
        'policy',
        `the loader chose ${store.revision}, not the revision under test ${input.expectedRevision}; a newer ` +
          'revision wins by design, so this class would be measured against a corpus you are not looking at.',
      ),
    );
  } else if (input.expectedRevision !== undefined) {
    findings.push(
      ok('revision_selected', `the loader chose the revision under test, ${store.revision}`),
    );
  }

  const revisionDir = `${input.corpusRoot}/${input.taskClass}/${store.revision}`;
  const parsed = readClassDescriptor(revisionDir);
  let descriptor: ClassDescriptor | null = null;
  if (parsed.kind === 'missing') {
    findings.push(
      bad(
        'descriptor_present',
        'policy',
        `no ${'class.json'} in ${revisionDir}; nobody declared which rules the worker can see, so "the wall is ` +
          'not a mirror" cannot be checked for this class. Write one (see docs/runbooks/author-a-task-class.md).',
      ),
    );
  } else if (parsed.kind === 'unreadable') {
    findings.push(bad('descriptor_present', 'integrity', `${parsed.path}: ${parsed.reason}`));
  } else {
    descriptor = parsed.descriptor;
    findings.push(
      ok('descriptor_present', `class.json declares ${String(descriptor.rules.length)} rule(s)`),
    );
  }

  const scenarioIds = store.scenarios.map((scenario) => scenario.id);
  if (descriptor !== null) {
    const declared = [...descriptor.rules].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
    const actual = [...scenarioIds].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
    const missing = actual.filter((id) => !declared.includes(id));
    const extra = declared.filter((id) => !actual.includes(id));
    if (missing.length > 0 || extra.length > 0) {
      findings.push(
        bad(
          'descriptor_matches_manifest',
          'policy',
          `the descriptor and the corpus disagree: ${missing.length > 0 ? `not declared: ${missing.join(', ')}` : ''}` +
            `${missing.length > 0 && extra.length > 0 ? '; ' : ''}${extra.length > 0 ? `declared but not run: ${extra.join(', ')}` : ''}. ` +
            'A class that promises a rule it does not run certifies a subset of what it claims.',
        ),
      );
    } else {
      findings.push(
        ok('descriptor_matches_manifest', `${String(actual.length)} rule(s) declared and run`),
      );
    }

    if (descriptor.taskClass !== input.taskClass) {
      findings.push(
        bad(
          'descriptor_names_class',
          'integrity',
          `class.json declares taskClass ${descriptor.taskClass} but lives under ${input.taskClass}; a descriptor ` +
            'that names another class describes another corpus.',
        ),
      );
    }

    const unknownVisible = descriptor.visibleRules.filter((id) => !descriptor.rules.includes(id));
    const hidden = descriptor.rules.filter((id) => !descriptor.visibleRules.includes(id));
    if (descriptor.visibleRules.length === 0) {
      findings.push(
        bad(
          'visible_check_enforces_something',
          'policy',
          'visibleRules is empty, so the visible check gives the worker no signal at all — every rule is a ' +
            'surprise. Name at least one rule it enforces (strictly fewer than all of them).',
        ),
      );
    } else {
      findings.push(
        ok(
          'visible_check_enforces_something',
          `the worker can see ${String(descriptor.visibleRules.length)} rule(s)`,
        ),
      );
    }
    if (unknownVisible.length > 0) {
      findings.push(
        bad(
          'visible_check_is_strict_subset',
          'policy',
          `visibleRules names ${unknownVisible.join(', ')}, which are not rules of this class; the visible check ` +
            'cannot enforce a rule the corpus does not have.',
        ),
      );
    } else if (hidden.length === 0) {
      findings.push(
        bad(
          'visible_check_is_strict_subset',
          'policy',
          'the visible check covers every rule, so the wall is a mirror: the worker can satisfy all of it and ' +
            'be judged by nothing it could not see. Leave at least one rule invisible.',
        ),
      );
    } else {
      findings.push(
        ok(
          'visible_check_is_strict_subset',
          `visible check enforces ${String(descriptor.visibleRules.length)} of ${String(descriptor.rules.length)} rule(s); ` +
            `invisible: ${hidden.join(', ')}`,
        ),
      );
    }

    const covered = new Set(descriptor.mutationMatrix.flatMap((row) => row.redRules));
    const uncovered = descriptor.rules.filter((id) => !covered.has(id));
    if (uncovered.length > 0) {
      findings.push(
        bad(
          'matrix_covers_every_rule',
          'policy',
          `no planted defect reddens ${uncovered.join(', ')}; a rule never observed failing is a rule whose ` +
            'failure nobody has seen. Add a defect to class.json that must redden it.',
        ),
      );
    } else {
      findings.push(ok('matrix_covers_every_rule', `every rule is reddened by a named defect`));
    }

    const vacuous = descriptor.mutationMatrix.filter((row) => row.redRules.length === 0);
    if (vacuous.length > 0) {
      findings.push(
        bad(
          'matrix_defect_reddens_something',
          'policy',
          `${String(vacuous.length)} matrix row(s) name a defect but no rule: ${vacuous.map((row) => row.defect).join('; ')}`,
        ),
      );
    } else if (descriptor.mutationMatrix.length === 0) {
      findings.push(
        bad(
          'matrix_defect_reddens_something',
          'policy',
          'the mutation matrix is empty; a class with no planted defects has never been seen to catch one.',
        ),
      );
    } else {
      findings.push(
        ok(
          'matrix_defect_reddens_something',
          `${String(descriptor.mutationMatrix.length)} defect(s) each name what they redden`,
        ),
      );
    }
  }

  // Bases: every rule must fail on every base revision, or the corpus certifies trees that were already
  // broken in the way it claims to detect.
  const bases = input.basePaths ?? [];
  if (bases.length === 0) {
    findings.push(
      bad(
        'bases_red',
        'environment',
        'no base trees were given, so "every base revision breaks every rule" was not checked. Re-run with ' +
          '--repo <mirror> --base <sha> (repeatable).',
      ),
    );
  } else {
    const greenBases: string[] = [];
    for (const basePath of bases) {
      const { passing } = failingRules(store, basePath, input.runner);
      if (passing.length > 0) greenBases.push(`${basePath}: ${passing.join(', ')}`);
    }
    if (greenBases.length > 0) {
      findings.push(
        bad(
          'bases_red',
          'policy',
          `a base revision passes rules it should fail — ${greenBases.join(' | ')}. A corpus that passes a defective ` +
            'tree certifies nothing: every attempt would inherit the base’s pass.',
        ),
      );
    } else {
      findings.push(
        ok(
          'bases_red',
          `all ${String(bases.length)} base tree(s) fail all ${String(store.scenarios.length)} rule(s)`,
        ),
      );
    }

    if (descriptor !== null) {
      const blind = bases.every(
        (basePath) => runVisibleCheck(descriptor, basePath, input.runner).code === 0,
      );
      if (blind) {
        findings.push(
          bad(
            'visible_check_sees_a_base',
            'policy',
            'the visible check passes on every base revision, so the worker’s own signal cannot see the defect: ' +
              'it would have to find the problem from the intent alone, and the class would measure luck.',
          ),
        );
      } else {
        findings.push(
          ok('visible_check_sees_a_base', 'the visible check fails on at least one base revision'),
        );
      }
    }
  }

  // The repair target: everything green, including the worker's own check.
  if (input.repairPath === undefined) {
    findings.push(
      bad(
        'repair_green',
        'environment',
        'no repaired tree was given, so "the class is satisfiable" was not checked. Re-run with --repair <dir>.',
      ),
    );
  } else {
    const { failed } = failingRules(store, input.repairPath, input.runner);
    if (failed.length > 0) {
      findings.push(
        bad(
          'repair_green',
          'policy',
          `the repaired tree fails ${failed.join(', ')} — ${describeOutcomes(store, input.repairPath, input.runner)}. ` +
            'A class whose own repair cannot pass is unrepairable: every candidate would fail for the base’s reason.',
        ),
      );
    } else {
      findings.push(
        ok(
          'repair_green',
          `all ${String(store.scenarios.length)} rule(s) pass on the repaired tree`,
        ),
      );
    }
    if (descriptor !== null) {
      const visible = runVisibleCheck(descriptor, input.repairPath, input.runner);
      if (visible.code !== 0) {
        findings.push(
          bad(
            'visible_check_green_on_repair',
            'policy',
            `the visible check exits ${visible.code === null ? 'not-started' : String(visible.code)} on the repaired tree ` +
              `(${visible.output.split('\n')[0]?.trim() ?? 'no output'}); a correct change would be refused by the ` +
              'worker’s own gate.',
          ),
        );
      } else if (descriptor.visibleCheck.requireSummary && !summarised(visible.output)) {
        findings.push(
          bad(
            'suite_prints_summary',
            'policy',
            'the visible check passed but printed no FACTORY_SUMMARY line; the wall reads that line, so the pinned ' +
              'suite would be unknown — not a pass.',
          ),
        );
      } else {
        findings.push(
          ok('visible_check_green_on_repair', 'the visible check passes on the repaired tree'),
        );
        if (descriptor.visibleCheck.requireSummary) {
          findings.push(ok('suite_prints_summary', 'the visible check prints FACTORY_SUMMARY'));
        }
      }
    }
  }

  return {
    findings,
    exitCode: exitCodeFor(findings),
    taskClass: input.taskClass,
    revision: store.revision,
    revisionHash: revisionHashOf(revisionDir, store.revision),
    rules: scenarioIds,
  };
}
