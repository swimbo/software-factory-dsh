/**
 * The detection half of β, as a count rather than a rate.
 *
 * Each case here is a candidate the wall *should* refuse: the repair the scripted worker writes with
 * one class rule (or two, for the control) deliberately left broken. The question these specs answer
 * is not "how often does the wall detect a bad patch" — a corpus written by the same side cannot
 * answer that — but "does this wall, whose visible check is green, refuse each of these known-bad
 * patches, and does it still pass a genuinely clean repair". The reported number is therefore
 * `5 of 5 planted single-rule regressions refused, 1 of 1 multi-rule refused, 1 of 1 clean repair
 * passed`, and it is a count over a fixed fixture, not a detection rate.
 *
 * The count is proved non-vacuous by deletion: drop one rule from the corpus's manifest and the
 * regression planted for that rule passes (it is not refused by anything else), while the first
 * assertion below — "the corpus measures exactly the five rules the class claims" — reddens. That
 * mutation was run by hand and its output is in the round report; the assertions that make it red are
 * these ones, not a comment.
 *
 * Two of the five rules are also checked by `tools/check-docs.mjs`. For those the candidate's own
 * oracle fails first, so the wall refuses it for `acceptance_unmet` *and* `holdout_failed`; the
 * `receipt.commands[0].exitCode` assertion pins which layer saw it. The other three can only be
 * caught by the class holdout, and those are the detections this suite exists to demonstrate.
 */
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { openStore } from '../../packages/store/src/index.ts';
import { jsonOf, runFactory, type FactoryRun } from '../harness/factory.ts';
import {
  createDocsSubstrate,
  fixedDocs,
  holdoutScenarios,
  HOLDOUT_REVISION,
  TASK_CLASS,
  writeCandidateScenario,
  type DocsSubstrate,
  type DocsUnit,
} from './docs-substrate.ts';
import {
  holdoutHandle,
  REGRESSION_RULES,
  regressionDocs,
  VISIBLE_RULES,
  type RegressionRule,
} from './regressions.ts';

/** One unit per case: five single-rule regressions, the two-rule control, and the clean repair. */
const CASES = REGRESSION_RULES.length + 2;

let substrate: DocsSubstrate;
let units: readonly { readonly unitId: string; readonly scenarioPath: string }[];

interface Attempt {
  readonly run: FactoryRun;
  readonly body: Record<string, unknown>;
  readonly unitId: string;
}

/**
 * Run one candidate through `factory run`, exactly as an operator would: intent → qualify happened
 * in `submit`, the worker is the offline scripted executor, the wall is the real wall.
 */
function attempt(
  unitIndex: number,
  docs: readonly { readonly path: string; readonly content: string }[],
): Attempt {
  const unit = substrate.units[unitIndex];
  const target = units[unitIndex];
  if (unit === undefined || target === undefined) {
    throw new Error(`no unit ${String(unitIndex)} in this substrate`);
  }
  writeCandidateScenario(target.scenarioPath, unit, docs);
  const run = runFactory(['run', target.unitId, '--scenario', target.scenarioPath, '--json'], {
    home: substrate.home,
    env: substrate.wallEnv(),
    timeoutMs: 180_000,
  });
  return { run, body: jsonOf(run), unitId: target.unitId };
}

interface StoredRefusal {
  readonly reasons: readonly string[];
  readonly outcome: unknown;
  readonly failing: readonly { readonly id: unknown; readonly observed: unknown }[];
  readonly unitState: string | undefined;
  /** The exit code of the command the worker itself ran — the visible check, when it is green. */
  readonly workerCommandExit: number | null | undefined;
}

function storedRefusal(unitId: string): StoredRefusal {
  const store = openStore({ dir: join(substrate.home, 'state') });
  try {
    const verdict = store.latestVerdictForUnit(unitId);
    if (verdict === null) throw new Error(`unit ${unitId} has no verdict`);
    const receipt = store.latestReceiptForUnit(unitId);
    return {
      reasons: verdict.verdict.reasons,
      outcome: verdict.verdict.outcome,
      failing: (verdict.verdict.scenarios ?? []).filter((row) => row.outcome !== 'pass'),
      unitState: store.getUnit(unitId)?.state,
      workerCommandExit: receipt?.receipt.commands[0]?.exitCode,
    };
  } finally {
    store.close();
  }
}

beforeAll(() => {
  substrate = createDocsSubstrate({ units: CASES });
  units = substrate.units.map((unit) => ({
    unitId: substrate.submit(unit),
    scenarioPath: unit.scenarioPath,
  }));
});

afterAll(() => {
  substrate.cleanup();
});

describe('the corpus of planted regressions', () => {
  it('[the corpus measures exactly the five rules the class claims — a deleted rule reddens here]', () => {
    const measured = holdoutScenarios(join(substrate.holdoutRoot, TASK_CLASS, HOLDOUT_REVISION))
      .map((scenario) => scenario.id)
      .sort();
    expect(measured).toEqual([...REGRESSION_RULES].sort());
    // And every rule has a planted regression that the fixture can build, in one file, from the
    // repair: a rule with no defect here would make the count below silently smaller.
    for (const rule of REGRESSION_RULES) {
      expect(() => regressionDocs(0, [rule])).not.toThrow();
    }
  });
});

/**
 * `it` per rule rather than one looped assertion, so the failure output names the rule that got
 * through. The expectations are identical by construction; only the rule differs.
 */
for (const rule of REGRESSION_RULES) {
  const visible = VISIBLE_RULES.includes(rule);
  it(`[${rule}: refused, holdout_failed, one failing holdout row, unit rejected${visible ? ' (visible check also red)' : ' (visible check green)'}]`, () => {
    const unit = substrate.units[REGRESSION_RULES.indexOf(rule)];
    if (unit === undefined) throw new Error('no unit');
    const { run, body, unitId } = attempt(unit.index, regressionDocs(unit.index, [rule]));

    // The wall refuses: a `fail` verdict on a rejected unit, not a crash and not an `unknown`.
    expect(run.code, run.stderr).toBe(3);
    expect(body['state']).toBe('rejected');
    expect(body['outcome']).toBe('fail');

    const stored = storedRefusal(unitId);
    expect(stored.outcome).toBe('fail');
    expect(stored.reasons).toContain('holdout_failed');
    expect(stored.unitState).toBe('rejected');

    // Exactly one *holdout* scenario failed, and it is the scenario for this rule: the wall
    // anonymises handles positionally over the scenarios sorted by corpus id
    // (`scenarioHandle` in packages/wall/src/evaluate.ts), so the index is the rule's alphabetical
    // rank among the five. A refusal by "everything failed" would not be detection.
    const holdoutFailing = stored.failing.filter((row) => /^holdout:\d+$/u.test(String(row.id)));
    expect(holdoutFailing).toHaveLength(1);
    expect(holdoutFailing[0]?.id).toBe(holdoutHandle(rule));
    expect(holdoutFailing[0]?.observed).toMatch(
      /^scenario failed \(runs=2 pass=0 fail=2 unknown=0\)$/u,
    );

    if (visible) {
      // The worker's own oracle caught it first, and the wall's own suite ran the same check: this
      // rule is not invisible, so on its own it is not evidence of holdout detection. All three
      // layers fire, and the exact reason list says so.
      expect(stored.workerCommandExit).toBe(1);
      expect(stored.reasons).toEqual(['acceptance_unmet', 'suite_failed', 'holdout_failed']);
      expect(stored.failing.map((row) => row.id)).toEqual([
        'acceptance:docs-check',
        'suite',
        holdoutHandle(rule),
      ]);
    } else {
      // The interesting case: every command the worker could run exited 0, the wall's own suite
      // passed, and the class rule it cannot see is the only thing that refused the patch.
      expect(stored.workerCommandExit).toBe(0);
      expect(stored.reasons).toEqual(['holdout_failed']);
      expect(stored.failing).toHaveLength(1);
    }
  });
}

describe('the controls that keep the count from being vacuous', () => {
  it('[two rules broken at once: refused with two holdout rows, visible check still green]', () => {
    const index = REGRESSION_RULES.length;
    const unit = substrate.units[index];
    if (unit === undefined) throw new Error('no unit');
    const rules: readonly RegressionRule[] = ['relative-links-resolve', 'headings-unique'];
    const { run, body, unitId } = attempt(unit.index, regressionDocs(unit.index, rules));

    expect(run.code, run.stderr).toBe(3);
    expect(body['outcome']).toBe('fail');
    const stored = storedRefusal(unitId);
    expect(stored.reasons).toContain('holdout_failed');
    expect(stored.unitState).toBe('rejected');
    // Two rules, two failing holdout scenarios — the count is per rule, not "any failure at all".
    expect(stored.failing).toHaveLength(2);
    for (const row of stored.failing) expect(row.id).toMatch(/^holdout:\d+$/u);
    expect(new Set(stored.failing.map((row) => row.id)).size).toBe(2);
    // Both rules are invisible to the visible check, so its greenness is not what refused them.
    expect(stored.workerCommandExit).toBe(0);
  });

  it('[a genuinely clean repair still passes — the wall is not simply refusing everything]', () => {
    const index = REGRESSION_RULES.length + 1;
    const unit = substrate.units[index];
    if (unit === undefined) throw new Error('no unit');
    const { run, body, unitId } = attempt(unit.index, fixedDocs(unit.index));

    expect(run.code, run.stderr).toBe(0);
    expect(body['state']).toBe('verified');
    expect(body['outcome']).toBe('pass');
    const stored = storedRefusal(unitId);
    expect(stored.outcome).toBe('pass');
    expect(stored.reasons).toEqual([]);
    expect(stored.failing).toEqual([]);
    expect(stored.unitState).toBe('verified');
    expect(stored.workerCommandExit).toBe(0);
  });
});
