/**
 * The non-discriminating-holdout control — and the criteria-drift log it produces.
 *
 * The hole this closes is the one the research names and the first implementation
 * could not see: Δ is a *relative* rate, so a holdout whose scenarios already pass
 * on the base revision yields Δ = 0, which satisfies a threshold of 0. A scenario
 * set that cannot tell the change apart from no change therefore passes its own
 * gate, silently, and the wall becomes theatre for that task class.
 *
 * The control is simple: **a scenario that passes on every base run observed is
 * non-discriminating**, and too many of those means the wall cannot certify the
 * class. It is not a proof that the holdout is *good* — a scenario can discriminate
 * and still be shallow — but it is the cheapest honest signal that the wall is
 * measuring nothing, and it is the one that must exist before any lane is widened.
 *
 * ## Trust model
 *
 * The log is **advisory history; the current run is authoritative.** `evaluate()`
 * always folds in the base observations it just made itself, because an
 * append-only log that an attacker can delete from would otherwise be a way to
 * un-degrade a non-discriminating holdout: delete the base passes, and the
 * remaining history looks discriminating. Folding the live measurement in means
 * log tampering can only make the *report* less informative, never the gate more
 * permissive.
 *
 * The log's other job is the phase plan's `criteria-log.ts` requirement: an
 * append-only record of scenario behaviour per revision, so that criteria drift
 * (EvalGen) is *visible* to a human re-validating the wall rather than assumed
 * away. It is a record, not a gate; the gate is the live measurement.
 */
import { appendFileSync, mkdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { FactoryError } from '@factory/contracts';
import type { HoldoutStore } from './holdout.ts';

/** One scenario observation, in a form that appends to JSONL and hashes deterministically. */
export interface CriteriaLogEntry {
  readonly taskClass: string;
  readonly holdoutRevision: string;
  readonly scenarioId: string;
  /** The code revision the scenario ran against (the base revision of the attempt). */
  readonly revision: string;
  /**
   * Which side of Δ this observation belongs to. Only `base` observations decide
   * discrimination.
   *
   * This field is an addition to the `{ at, taskClass, holdoutRevision, revision,
   * scenarioId, outcome }` shape the phase specifies, and it is load-bearing: base
   * and candidate runs of the same scenario share the same `revision` (the candidate
   * adds a patch, not a commit), so without `side` the log cannot distinguish "this
   * scenario already passes without the change" from "the change made it pass" —
   * which is the only distinction this control exists to make.
   */
  readonly side: 'base' | 'candidate';
  /** `unknown` means the run produced no measurement (timeout, crash, unstartable). */
  readonly outcome: 'pass' | 'fail' | 'unknown';
  readonly at: string;
}

/** Per-scenario base statistics. Ids live here — this is the wall's private audit surface. */
export interface ScenarioDiscrimination {
  readonly scenario: string;
  /** Fraction of measured base runs that passed. `1` means "cannot distinguish". */
  readonly baseRate: number;
  /** Measured base runs (`pass`/`fail`); unmeasured runs are excluded rather than counted as failures. */
  readonly runs: number;
}

export interface DiscriminationReport {
  /** False when no base run could be measured at all, which is already an `unknown` verdict elsewhere. */
  readonly checked: boolean;
  readonly scenarios: readonly ScenarioDiscrimination[];
  readonly nonDiscriminating: readonly string[];
  readonly maxAllowed: number;
  /** False means the wall must degrade to `unknown`; it never means "fail the candidate". */
  readonly discriminates: boolean;
  /** Counts only — safe to place in a verdict, which must never carry scenario ids. */
  readonly observed: string;
}

/** `<holdoutRoot>/audit/criteria-log.jsonl`, next to the store and never inside a repo. */
export function criteriaLogPath(holdoutRoot: string): string {
  return join(holdoutRoot, 'audit', 'criteria-log.jsonl');
}

/**
 * Append one observation.
 *
 * The wall is the only writer. Validation is strict because a corrupt log line is
 * a line that will be skipped on read, and a log that silently drops records is a
 * log that lies about which criteria were ever exercised.
 */
export function recordRun(entry: CriteriaLogEntry, logPath: string): void {
  assertEntryShape(entry);
  mkdirSync(dirname(logPath), { recursive: true });
  appendFileSync(logPath, `${JSON.stringify(entry)}\n`, 'utf8');
}

/** Append several observations in one write, so a run's records land together or not at all. */
export function recordRuns(entries: readonly CriteriaLogEntry[], logPath: string): void {
  if (entries.length === 0) return;
  for (const entry of entries) assertEntryShape(entry);
  mkdirSync(dirname(logPath), { recursive: true });
  appendFileSync(logPath, entries.map((entry) => `${JSON.stringify(entry)}\n`).join(''), 'utf8');
}

/** What a read of the log produced, including the evidence that it was damaged. */
export interface CriteriaLogReadResult {
  readonly entries: readonly CriteriaLogEntry[];
  /**
   * Lines that could not be parsed as an entry.
   *
   * These are **not** skipped silently and they are **not** treated as absence. A
   * log that can be reset by corrupting one line is not a control: an attacker who
   * wants a non-discriminating holdout to look discriminating only has to damage
   * the records that incriminate it. So damage is reported, and the caller degrades
   * to `unknown` — fewer usable observations never means "fresh, clean history".
   *
   * Operational cost, accepted deliberately: a process killed mid-append leaves a
   * torn final line, and the next run degrades until an operator looks. The writer
   * mitigates this by appending each run's records in a single write, and the log is
   * append-only, so repairing it means inspecting the tail rather than rewriting.
   */
  readonly corruptLines: number;
}

/**
 * Read the log.
 *
 * A missing file is an empty log (a fresh install), not corruption. Any line that
 * fails to parse — JSON error, or JSON that is not an entry — is counted as
 * `corruptLines`.
 */
export function readCriteriaLog(logPath: string): CriteriaLogReadResult {
  let raw: string;
  try {
    raw = readFileSync(logPath, 'utf8');
  } catch {
    return { entries: [], corruptLines: 0 };
  }
  const entries: CriteriaLogEntry[] = [];
  let corruptLines = 0;
  for (const line of raw.split('\n')) {
    if (line.trim() === '') continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      corruptLines += 1;
      continue;
    }
    if (isEntry(parsed)) entries.push(parsed);
    else corruptLines += 1;
  }
  return { entries, corruptLines };
}

function assertEntryShape(entry: CriteriaLogEntry): void {
  if (
    typeof entry.taskClass !== 'string' ||
    entry.taskClass === '' ||
    typeof entry.holdoutRevision !== 'string' ||
    entry.holdoutRevision === '' ||
    typeof entry.scenarioId !== 'string' ||
    entry.scenarioId === '' ||
    typeof entry.revision !== 'string' ||
    entry.revision === '' ||
    (entry.side !== 'base' && entry.side !== 'candidate') ||
    (entry.outcome !== 'pass' && entry.outcome !== 'fail' && entry.outcome !== 'unknown') ||
    typeof entry.at !== 'string' ||
    entry.at === ''
  ) {
    throw new TypeError('criteria-log entry is malformed; refusing to append it');
  }
}

function isEntry(value: unknown): value is CriteriaLogEntry {
  if (typeof value !== 'object' || value === null) return false;
  const candidate = value as Record<string, unknown>;
  return (
    typeof candidate['taskClass'] === 'string' &&
    typeof candidate['holdoutRevision'] === 'string' &&
    typeof candidate['scenarioId'] === 'string' &&
    typeof candidate['revision'] === 'string' &&
    (candidate['side'] === 'base' || candidate['side'] === 'candidate') &&
    (candidate['outcome'] === 'pass' ||
      candidate['outcome'] === 'fail' ||
      candidate['outcome'] === 'unknown') &&
    typeof candidate['at'] === 'string'
  );
}

/**
 * Base statistics per scenario of the store.
 *
 * `extraBaseRuns` are the current run's own observations. They are merged with the
 * log rather than replacing it, so the control has both history and the measurement
 * in front of it, and neither alone can be gamed by deleting a file.
 */
export function discrimination(
  store: HoldoutStore,
  log: readonly CriteriaLogEntry[],
  extraBaseRuns: readonly CriteriaLogEntry[] = [],
): readonly ScenarioDiscrimination[] {
  const relevant = [...log, ...extraBaseRuns].filter(
    (entry) =>
      entry.side === 'base' &&
      entry.taskClass === store.taskClass &&
      entry.holdoutRevision === store.revision,
  );

  const ordered = [...store.scenarios]
    .map((scenario) => scenario.id)
    .sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));

  return ordered.map((scenarioId) => {
    const runs = relevant.filter((entry) => entry.scenarioId === scenarioId);
    const measured = runs.filter((entry) => entry.outcome !== 'unknown');
    const passed = measured.filter((entry) => entry.outcome === 'pass').length;
    return {
      scenario: scenarioId,
      baseRate: measured.length === 0 ? 0 : passed / measured.length,
      runs: measured.length,
    };
  });
}

/**
 * Establish whether the holdout can distinguish this change from no change.
 *
 * Returns a report rather than throwing, because the wall must *degrade* (to
 * `unknown`) rather than crash: a crash is an unclassified outcome, and the factory
 * only lets classified outcomes decide anything.
 */
export function assessDiscrimination(
  store: HoldoutStore,
  log: readonly CriteriaLogEntry[],
  options: {
    readonly maxNonDiscriminating: number;
    readonly extraBaseRuns?: readonly CriteriaLogEntry[];
  },
): DiscriminationReport {
  const extra = options.extraBaseRuns ?? [];
  const scenarios = discrimination(store, log, extra);
  const nonDiscriminating = scenarios
    .filter((row) => row.runs > 0 && row.baseRate === 1)
    .map((row) => row.scenario);
  const measuredAny = scenarios.some((row) => row.runs > 0);
  const discriminates = nonDiscriminating.length <= options.maxNonDiscriminating;

  const observed = !measuredAny
    ? 'no base run could be measured, so discrimination is unassessed'
    : `${nonDiscriminating.length} of ${scenarios.length} scenarios pass on every base run (max ${options.maxNonDiscriminating})`;

  return {
    checked: measuredAny,
    scenarios,
    nonDiscriminating,
    maxAllowed: options.maxNonDiscriminating,
    discriminates,
    observed,
  };
}

/**
 * The throwing form, for preflight use (`wall revalidate` before a lane is widened).
 *
 * `evaluate()` uses `assessDiscrimination` and degrades; an operator asking "may I
 * widen this class?" wants a refusal, not a report, so this variant exists rather
 * than being emulated with an `if` at each call site.
 */
export function assertDiscriminating(
  store: HoldoutStore,
  log: readonly CriteriaLogEntry[],
  options: {
    readonly maxNonDiscriminating: number;
    readonly extraBaseRuns?: readonly CriteriaLogEntry[];
  },
): DiscriminationReport {
  const report = assessDiscrimination(store, log, options);
  if (report.checked && !report.discriminates) {
    throw new FactoryError(
      'WALL_UNAVAILABLE',
      `holdout is not discriminating: ${report.observed}`,
      {
        taskClass: store.taskClass,
        holdoutRevision: store.revision,
        nonDiscriminating: report.nonDiscriminating.length,
        maxAllowed: report.maxAllowed,
      },
    );
  }
  return report;
}

/**
 * The wall's read/write port, so `evaluate()` can consult history and record its own
 * runs without doing filesystem I/O itself.
 *
 * Keeping the port here (rather than in `evaluate.ts`) is what preserves the
 * decision path's purity: `evaluate.ts` imports only types from this module.
 */
export interface CriteriaLogPort {
  read(): CriteriaLogReadResult;
  record(entries: readonly CriteriaLogEntry[]): void;
}

/** A file-backed port. The wall's CLI constructs exactly one of these per run. */
export function createCriteriaLog(logPath: string): CriteriaLogPort {
  return {
    read: () => readCriteriaLog(logPath),
    record: (entries) => {
      recordRuns(entries, logPath);
    },
  };
}
