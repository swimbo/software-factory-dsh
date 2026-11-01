/**
 * The criteria log and the non-discriminating-holdout control.
 *
 * The tests are organised around the two questions an operator actually asks:
 * "does this holdout measure anything?" and "can someone make the answer go away by
 * damaging the log?". The second is why several tests here deliberately write a log
 * and then delete or corrupt parts of it.
 */
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { FactoryError } from '@factory/contracts';
import type { HoldoutStore } from './holdout.ts';
import {
  assessDiscrimination,
  assertDiscriminating,
  createCriteriaLog,
  criteriaLogPath,
  discrimination,
  readCriteriaLog,
  recordRun,
  recordRuns,
  type CriteriaLogEntry,
} from './criteria-log.ts';

const TASK_CLASS = 'ts-cli';
const HOLDOUT_REVISION = 'h-2026-02-01';
const BASE_REV = 'base-rev-1';

const scratch: string[] = [];
afterEach(() => {
  for (const dir of scratch.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function scratchDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'factory-criteria-'));
  scratch.push(dir);
  return dir;
}

function store(scenarioIds: readonly string[]): HoldoutStore {
  return {
    revision: HOLDOUT_REVISION,
    taskClass: TASK_CLASS,
    scenarios: scenarioIds.map((id) => ({
      id,
      taskClass: TASK_CLASS,
      argv: [`run-${id}`],
      expectExit: [0],
    })),
  };
}

function entry(
  overrides: Partial<CriteriaLogEntry> & Pick<CriteriaLogEntry, 'scenarioId' | 'outcome'>,
): CriteriaLogEntry {
  return {
    taskClass: overrides.taskClass ?? TASK_CLASS,
    holdoutRevision: overrides.holdoutRevision ?? HOLDOUT_REVISION,
    scenarioId: overrides.scenarioId,
    revision: overrides.revision ?? BASE_REV,
    side: overrides.side ?? 'base',
    outcome: overrides.outcome,
    at: overrides.at ?? '2026-02-01T00:00:00.000Z',
  };
}

describe('the criteria log is append-only and self-describing', () => {
  it('writes one self-describing JSON line per observation and reads it back', () => {
    const logPath = criteriaLogPath(scratchDir());
    expect(logPath.endsWith(join('audit', 'criteria-log.jsonl'))).toBe(true);

    recordRun(entry({ scenarioId: 's-1', outcome: 'pass' }), logPath);
    recordRun(entry({ scenarioId: 's-2', outcome: 'fail' }), logPath);

    const raw = readFileSync(logPath, 'utf8').trimEnd().split('\n');
    expect(raw).toHaveLength(2);
    // Every line carries the full shape, so a reader never has to guess a field's
    // meaning from position or from the file it is in.
    const parsed = JSON.parse(raw[0] ?? '{}') as Record<string, unknown>;
    for (const field of [
      'at',
      'taskClass',
      'holdoutRevision',
      'revision',
      'side',
      'scenarioId',
      'outcome',
    ]) {
      expect(parsed[field], `missing field ${field}`).toBeDefined();
    }

    const read = readCriteriaLog(logPath);
    expect(read.corruptLines).toBe(0);
    expect(read.entries.map((item) => item.scenarioId)).toEqual(['s-1', 's-2']);
  });

  it('appends rather than replacing: history is the point', () => {
    const dir = scratchDir();
    const logPath = criteriaLogPath(dir);
    recordRun(entry({ scenarioId: 's-1', outcome: 'fail' }), logPath);
    recordRuns(
      [
        entry({
          scenarioId: 's-1',
          outcome: 'pass',
          at: '2026-02-02T00:00:00.000Z',
          revision: 'base-rev-2',
        }),
      ],
      logPath,
    );

    expect(readCriteriaLog(logPath).entries).toHaveLength(2);
  });

  it('refuses to append a malformed entry instead of writing an unreadable line', () => {
    const logPath = criteriaLogPath(scratchDir());
    const bad = {
      ...entry({ scenarioId: 's-1', outcome: 'pass' }),
      outcome: 'maybe',
    } as unknown as CriteriaLogEntry;

    expect(() => recordRun(bad, logPath)).toThrow(TypeError);
  });

  it('treats a missing log as empty, and a damaged line as corruption rather than absence', () => {
    const dir = scratchDir();
    const logPath = criteriaLogPath(dir);

    // Fresh install: no file, no corruption, no observations.
    expect(readCriteriaLog(logPath)).toEqual({ entries: [], corruptLines: 0 });

    mkdirSync(join(dir, 'audit'), { recursive: true });
    writeFileSync(
      logPath,
      `${JSON.stringify(entry({ scenarioId: 's-1', outcome: 'pass' }))}\n{ this is not json\n`,
      'utf8',
    );
    const read = readCriteriaLog(logPath);
    expect(read.entries).toHaveLength(1);
    expect(read.corruptLines).toBe(1);
  });

  it('counts a well-formed line that is not an entry as corruption too', () => {
    const dir = scratchDir();
    const logPath = criteriaLogPath(dir);
    mkdirSync(join(dir, 'audit'), { recursive: true });
    writeFileSync(logPath, '{"hello":"world"}\n', 'utf8');
    expect(readCriteriaLog(logPath).corruptLines).toBe(1);
  });
});

describe('discrimination: does the holdout measure anything?', () => {
  it('marks a scenario that passes on every base run as non-discriminating', () => {
    const log = [
      entry({ scenarioId: 'always-green', outcome: 'pass' }),
      entry({ scenarioId: 'always-green', outcome: 'pass', revision: 'base-rev-0' }),
      entry({ scenarioId: 'catches-the-bug', outcome: 'fail' }),
    ];

    const rows = discrimination(store(['always-green', 'catches-the-bug']), log);

    expect(rows).toEqual([
      { scenario: 'always-green', baseRate: 1, runs: 2 },
      { scenario: 'catches-the-bug', baseRate: 0, runs: 1 },
    ]);
  });

  it('ignores candidate-side observations: only the base says whether a scenario discriminates', () => {
    const log = [entry({ scenarioId: 's-1', outcome: 'fail', side: 'candidate' })];
    const rows = discrimination(store(['s-1']), log);

    expect(rows).toEqual([{ scenario: 's-1', baseRate: 0, runs: 0 }]);
  });

  it('ignores other task classes and other holdout revisions', () => {
    const log = [
      entry({ scenarioId: 's-1', outcome: 'pass', taskClass: 'other-class' }),
      entry({ scenarioId: 's-1', outcome: 'pass', holdoutRevision: 'h-old' }),
    ];
    expect(discrimination(store(['s-1']), log)).toEqual([
      { scenario: 's-1', baseRate: 0, runs: 0 },
    ]);
  });

  it('excludes unmeasured base runs rather than counting them as failures', () => {
    const log = [
      entry({ scenarioId: 's-1', outcome: 'unknown' }),
      entry({ scenarioId: 's-1', outcome: 'pass' }),
      entry({ scenarioId: 's-1', outcome: 'fail' }),
    ];

    // Two measured runs, one pass: rate 0.5. Counting the timeout as a failure would
    // report 0.33 and make a flaky wall look sharper than it is.
    expect(discrimination(store(['s-1']), log)).toEqual([
      { scenario: 's-1', baseRate: 0.5, runs: 2 },
    ]);
  });

  it('folds in the live run, so damaging the log cannot un-degrade a blunt holdout', () => {
    const log = [
      entry({ scenarioId: 's-1', outcome: 'pass' }),
      entry({ scenarioId: 's-2', outcome: 'pass' }),
    ];
    const scenarioSet = store(['s-1', 's-2']);

    const withHistory = assessDiscrimination(scenarioSet, log, { maxNonDiscriminating: 0 });
    // An attacker deletes both incriminating lines.
    const afterTamper = assessDiscrimination(scenarioSet, [], {
      maxNonDiscriminating: 0,
      extraBaseRuns: [
        entry({ scenarioId: 's-1', outcome: 'pass' }),
        entry({ scenarioId: 's-2', outcome: 'pass' }),
      ],
    });

    expect(withHistory.discriminates).toBe(false);
    expect(afterTamper.discriminates).toBe(false);
    expect(afterTamper.nonDiscriminating).toEqual(['s-1', 's-2']);
  });

  it('respects the threshold and reports counts without ids for the verdict', () => {
    const scenarioSet = store(['s-1', 's-2', 's-3']);
    const log = [
      entry({ scenarioId: 's-1', outcome: 'pass' }),
      entry({ scenarioId: 's-2', outcome: 'pass' }),
      entry({ scenarioId: 's-3', outcome: 'fail' }),
    ];

    const strict = assessDiscrimination(scenarioSet, log, { maxNonDiscriminating: 0 });
    const lenient = assessDiscrimination(scenarioSet, log, { maxNonDiscriminating: 2 });

    expect(strict.discriminates).toBe(false);
    expect(strict.observed).toContain('2 of 3');
    expect(strict.observed).toContain('max 0');
    expect(strict.observed).not.toContain('s-1');

    expect(lenient.discriminates).toBe(true);
    expect(lenient.observed).toContain('max 2');
  });

  it('reports the check as unchecked when no base run could be measured', () => {
    const report = assessDiscrimination(store(['s-1']), [], { maxNonDiscriminating: 0 });

    expect(report.checked).toBe(false);
    // Unchecked is not "discriminating": it must not be read as a clean bill of health.
    expect(report.observed).toContain('unassessed');
  });

  it('throws the wall-unavailable error from the preflight form', () => {
    const scenarioSet = store(['s-1']);
    const log = [entry({ scenarioId: 's-1', outcome: 'pass' })];

    let thrown: unknown;
    try {
      assertDiscriminating(scenarioSet, log, { maxNonDiscriminating: 0 });
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(FactoryError);
    expect(thrown instanceof FactoryError ? thrown.code : null).toBe('WALL_UNAVAILABLE');

    // …and the same log with a permissive threshold returns the report instead.
    expect(assertDiscriminating(scenarioSet, log, { maxNonDiscriminating: 1 }).discriminates).toBe(
      true,
    );
    // An unchecked holdout is not refused by the preflight: it is the delta check's
    // job to call that unmeasured, and two checks must not both refuse for one fact.
    expect(() => assertDiscriminating(scenarioSet, [], { maxNonDiscriminating: 0 })).not.toThrow();
  });
});

describe('the log port', () => {
  it('reads and records through an injected path', () => {
    const logPath = criteriaLogPath(scratchDir());
    const port = createCriteriaLog(logPath);

    expect(port.read()).toEqual({ entries: [], corruptLines: 0 });

    port.record([entry({ scenarioId: 's-1', outcome: 'pass' })]);

    const read = port.read();
    expect(read.entries).toHaveLength(1);
    expect(read.corruptLines).toBe(0);
  });
});
