/**
 * `wall self-test` — the wall adversarially testing itself.
 *
 * Research requirement R6: a verification system that nobody attacks is assumed to
 * work until the day it silently stops. Every case in `tests/corpus/` is a sabotage
 * (or one honest change) with a *declared* expected verdict. If the wall's observed
 * verdict disagrees with the declaration, self-test exits non-zero — so a refactor
 * that quietly stops catching test deletion, or starts passing a sabotaged change,
 * fails the build rather than the factory.
 *
 * The corpus is deliberately data, not code:
 *
 * - Each case's receipt is parsed through the contract's own `WorkerReceipt` schema,
 *   so a corpus entry cannot describe a receipt the factory could never produce.
 * - Each case's receipt carries a `narrative` and is passed through
 *   `toDecisionReceipt`, so the corpus exercises the L1 barrier rather than assuming
 *   it.
 * - Expected verdicts are declared next to the fixture, so the person adding a case
 *   has to say what *should* happen before seeing what does.
 *
 * What this does NOT prove: that the corpus is complete. Six cases prove six
 * behaviours. A sabotage nobody thought of is not caught by self-test; it is caught
 * by reading the wall and by the holdout being separate from the visible suite.
 */
import { readFileSync, readdirSync } from 'node:fs';
import { basename, join } from 'node:path';
import {
  toDecisionReceipt,
  UnitSpec as UnitSpecSchema,
  WALL_REASON_CODES,
  WorkerReceipt as WorkerReceiptSchema,
} from '@factory/contracts';
import type { UnitSpec, Verdict, WallReasonCode, WorkerReceipt } from '@factory/contracts';
import {
  NO_PATCH,
  evaluate,
  type ChangedFile,
  type DiffInspector,
  type ScenarioRunner,
  type ScenarioRunInput,
  type ScenarioRunResult,
} from './evaluate.ts';
import type { HoldoutScenario, HoldoutStore } from './holdout.ts';

/** Fixed clock: a self-test that depends on "now" is a self-test that fails on Tuesdays. */
const CORPUS_NOW = '2026-12-01T00:00:00.000Z';

interface CorpusRunOutcome {
  readonly exitCode: number | null;
  /** `sha256:…`, the same form the receipt uses, so re-execution can be compared exactly. */
  readonly outputSha: string;
  readonly timedOut?: boolean;
  /** The machine-readable suite summary a real runner reports; the wall's oracle reads it. */
  readonly summary?: {
    readonly passed: number;
    readonly failed: number;
    readonly unknown: number;
    readonly exitCode: number | null;
  };
}

interface CorpusCaseFile {
  readonly name: string;
  readonly description: string;
  readonly expected: {
    readonly outcome: 'pass' | 'fail' | 'unknown';
    readonly reasons?: readonly WallReasonCode[];
    readonly absentReasons?: readonly WallReasonCode[];
    /** Why this case is interesting, printed by the CLI for the operator. */
    readonly note?: string;
  };
  readonly spec: unknown;
  readonly receipt: unknown;
  readonly holdout: unknown | null;
  readonly diff: readonly unknown[] | null;
  readonly runner: {
    readonly patched: readonly {
      readonly argv: readonly string[];
      readonly outcome: CorpusRunOutcome;
    }[];
    readonly base: readonly {
      readonly argv: readonly string[];
      readonly outcome: CorpusRunOutcome;
    }[];
    readonly fallback?: CorpusRunOutcome;
  };
  readonly policy: {
    readonly deltaThreshold: number;
    readonly commandTimeoutMs: number;
    readonly runsPerScenario?: number;
    readonly maxNonDiscriminating?: number;
    /** The wall's own entrypoint (A4.1). Every case declares it, because no wall without an oracle can pass. */
    readonly pinnedSuite: readonly string[];
    readonly minDeltaSamples?: number;
  };
}

export interface SelfTestCaseResult {
  readonly name: string;
  readonly description: string;
  readonly expected: string;
  readonly observed: string;
  readonly met: boolean;
  readonly failures: readonly string[];
  readonly note: string | null;
}

export interface SelfTestReport {
  readonly corpusDir: string;
  readonly cases: readonly SelfTestCaseResult[];
  readonly ok: boolean;
}

function runOutcome(raw: CorpusRunOutcome): ScenarioRunResult {
  return {
    exitCode: raw.exitCode,
    // Already a digest: the corpus spells out the same `sha256:…` in the receipt and in
    // the runner table, so faithfulness has something real to compare.
    outputSha: raw.outputSha,
    durationMs: 1,
    timedOut: raw.timedOut ?? false,
    ...(raw.summary === undefined ? {} : { summary: raw.summary }),
  };
}

/** A lookup-table runner: the corpus has no business executing anything real. */
function corpusRunner(file: CorpusCaseFile): ScenarioRunner {
  const table = (
    entries: readonly { argv: readonly string[]; outcome: CorpusRunOutcome }[],
  ): Map<string, ScenarioRunResult> =>
    new Map(entries.map((entry) => [entry.argv.join('\u0000'), runOutcome(entry.outcome)]));

  const patched = table(file.runner.patched);
  const base = table(file.runner.base);
  const fallback =
    file.runner.fallback === undefined ? undefined : runOutcome(file.runner.fallback);

  return {
    async run(input: ScenarioRunInput): Promise<ScenarioRunResult> {
      const side = input.patchFile === NO_PATCH ? base : patched;
      const hit = side.get(input.argv.join('\u0000')) ?? fallback;
      if (hit === undefined) {
        // Fail loudly: a corpus case that silently falls through to "pass" would make
        // the self-test agree with itself instead of with the wall.
        throw new Error(`corpus runner has no outcome for ${input.argv.join(' ')}`);
      }
      return hit;
    },
  };
}

function corpusDiff(entries: readonly unknown[] | null): DiffInspector {
  const files: readonly ChangedFile[] | null =
    entries === null
      ? null
      : entries.map((raw) => {
          const record = raw as Record<string, unknown>;
          const path = record['path'];
          const kind = record['kind'];
          if (
            typeof path !== 'string' ||
            (kind !== 'added' && kind !== 'modified' && kind !== 'deleted')
          ) {
            throw new Error(
              'corpus diff entry needs a string path and an added/modified/deleted kind',
            );
          }
          const changed: ChangedFile = {
            path,
            kind,
            ...(record['emptied'] === true ? { emptied: true } : {}),
            ...(typeof record['removedAssertions'] === 'number'
              ? { removedAssertions: record['removedAssertions'] }
              : {}),
          };
          return changed;
        });

  return {
    async changedFiles() {
      return files;
    },
  };
}

function corpusHoldout(raw: unknown): HoldoutStore | null {
  if (raw === null) return null;
  const record = raw as Record<string, unknown>;
  const revision = record['revision'];
  const taskClass = record['taskClass'];
  const rawScenarios = record['scenarios'];
  if (
    typeof revision !== 'string' ||
    typeof taskClass !== 'string' ||
    !Array.isArray(rawScenarios)
  ) {
    throw new Error('corpus holdout needs { revision, taskClass, scenarios[] }');
  }
  const scenarios: HoldoutScenario[] = rawScenarios.map((item) => {
    const scenario = item as Record<string, unknown>;
    const id = scenario['id'];
    const argv = scenario['argv'];
    const expectExit = scenario['expectExit'];
    if (
      typeof id !== 'string' ||
      !Array.isArray(argv) ||
      !argv.every((token) => typeof token === 'string') ||
      !Array.isArray(expectExit) ||
      !expectExit.every((code) => typeof code === 'number')
    ) {
      throw new Error(`corpus holdout scenario ${String(id)} needs { id, argv[], expectExit[] }`);
    }
    return { id, taskClass, argv: argv as string[], expectExit: expectExit as number[] };
  });
  return { revision, taskClass, scenarios };
}

/** Load one corpus file, validating every part against the contract where a schema exists. */
export function loadCorpusCase(path: string): CorpusCaseFile & { readonly path: string } {
  const parsed = JSON.parse(readFileSync(path, 'utf8')) as unknown;
  const file = parsed as CorpusCaseFile;
  if (typeof file.name !== 'string' || file.name === '')
    throw new Error(`${path}: case needs a name`);
  if (typeof file.description !== 'string' || file.description === '') {
    throw new Error(`${path}: case needs a description`);
  }
  const outcome = file.expected?.outcome;
  if (outcome !== 'pass' && outcome !== 'fail' && outcome !== 'unknown') {
    throw new Error(`${path}: expected.outcome must be pass, fail or unknown`);
  }
  // A typo'd reason code would otherwise be a silently unmeetable expectation.
  for (const reason of [...(file.expected.reasons ?? []), ...(file.expected.absentReasons ?? [])]) {
    if (!(WALL_REASON_CODES as readonly string[]).includes(reason)) {
      throw new Error(`${path}: '${reason}' is not a wall reason code`);
    }
  }
  // Parsing through the contract is the point: a corpus case cannot describe a unit
  // or a receipt the factory itself would reject.
  UnitSpecSchema.parse(file.spec);
  WorkerReceiptSchema.parse(file.receipt);
  return { ...file, path };
}

function describe(outcome: Verdict['outcome'], reasons: readonly WallReasonCode[]): string {
  return reasons.length === 0 ? outcome : `${outcome}:${reasons.join(',')}`;
}

async function runCorpusCase(file: CorpusCaseFile): Promise<SelfTestCaseResult> {
  const spec = UnitSpecSchema.parse(file.spec) as UnitSpec;
  const receipt = toDecisionReceipt(WorkerReceiptSchema.parse(file.receipt) as WorkerReceipt);

  const verdict = await evaluate({
    spec,
    receipt,
    holdout: corpusHoldout(file.holdout),
    runner: corpusRunner(file),
    policy: {
      deltaThreshold: file.policy.deltaThreshold,
      commandTimeoutMs: file.policy.commandTimeoutMs,
      wallVersion: 'wall/0.1.0',
      pinnedSuite: { argv: file.policy.pinnedSuite },
      ...(file.policy.minDeltaSamples === undefined
        ? {}
        : { minDeltaSamples: file.policy.minDeltaSamples }),
      ...(file.policy.runsPerScenario === undefined
        ? {}
        : { runsPerScenario: file.policy.runsPerScenario }),
      ...(file.policy.maxNonDiscriminating === undefined
        ? {}
        : { maxNonDiscriminating: file.policy.maxNonDiscriminating }),
    },
    diff: corpusDiff(file.diff),
    nowIso: CORPUS_NOW,
  });

  const failures: string[] = [];
  if (verdict.outcome !== file.expected.outcome) {
    failures.push(`expected outcome ${file.expected.outcome}, observed ${verdict.outcome}`);
  }
  for (const reason of file.expected.reasons ?? []) {
    if (!verdict.reasons.includes(reason)) failures.push(`expected reason ${reason}, absent`);
  }
  for (const reason of file.expected.absentReasons ?? []) {
    if (verdict.reasons.includes(reason)) failures.push(`reason ${reason} fired but must not`);
  }

  return {
    name: file.name,
    description: file.description,
    expected: describe(file.expected.outcome, file.expected.reasons ?? []),
    observed: describe(verdict.outcome, verdict.reasons),
    met: failures.length === 0,
    failures,
    note: file.expected.note ?? null,
  };
}

/** Run every case in a corpus directory. Order is by filename, so output is stable. */
export async function runSelfTest(corpusDir: string): Promise<SelfTestReport> {
  const names = readdirSync(corpusDir)
    .filter((name) => name.endsWith('.json'))
    .sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));

  const cases: SelfTestCaseResult[] = [];
  for (const name of names) {
    const file = loadCorpusCase(join(corpusDir, name));
    try {
      cases.push(await runCorpusCase(file));
    } catch (error) {
      cases.push({
        name: file.name,
        description: file.description,
        expected: describe(file.expected.outcome, file.expected.reasons ?? []),
        observed: 'threw',
        met: false,
        failures: [error instanceof Error ? error.message : String(error)],
        note: file.expected.note ?? null,
      });
    }
  }

  return { corpusDir, cases, ok: cases.length > 0 && cases.every((item) => item.met) };
}

function pad(value: string, width: number): string {
  return value.length >= width ? value : value + ' '.repeat(width - value.length);
}

/** The operator-facing table: case → expected → observed → met. */
export function formatSelfTestReport(report: SelfTestReport): string {
  const nameWidth = Math.max(4, ...report.cases.map((item) => item.name.length));
  const expectedWidth = Math.max(8, ...report.cases.map((item) => item.expected.length));
  const observedWidth = Math.max(8, ...report.cases.map((item) => item.observed.length));

  const lines = [
    `SELF-TEST ${basename(report.corpusDir)} (${report.cases.length.toString()} cases)`,
    '',
    `${pad('case', nameWidth)}  ${pad('expected', expectedWidth)}  ${pad('observed', observedWidth)}  result`,
    `${'-'.repeat(nameWidth)}  ${'-'.repeat(expectedWidth)}  ${'-'.repeat(observedWidth)}  ------`,
  ];

  for (const item of report.cases) {
    lines.push(
      `${pad(item.name, nameWidth)}  ${pad(item.expected, expectedWidth)}  ${pad(item.observed, observedWidth)}  ${item.met ? 'met' : 'UNMET'}`,
    );
    for (const failure of item.failures) lines.push(`  ! ${failure}`);
  }

  const unmet = report.cases.filter((item) => !item.met).length;
  lines.push('');
  lines.push(
    `${(report.cases.length - unmet).toString()} of ${report.cases.length.toString()} expectations met`,
  );
  // A14, verbatim and deliberately unhedged: this suite measures whether the wall can
  // still refuse. It does NOT establish a pass rate, and printing it next to the results
  // is the cheapest place to stop a reader from inferring one.
  lines.push('');
  lines.push('3 runs per scenario damps flakes; v1 certifies no pass rate.');
  lines.push(
    '  (alpha=0.687 at m=6, beta=0.016; alpha=0.882 at m=20/k=18; alpha=0.836 at m=48/k=44 — see README)',
  );

  const notes = report.cases.filter((item) => item.note !== null);
  if (notes.length > 0) {
    lines.push('');
    lines.push('documented behaviour:');
    for (const item of notes) lines.push(`  ${item.name}: ${item.note ?? ''}`);
  }

  return lines.join('\n');
}
