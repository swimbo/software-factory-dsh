/**
 * Two audiences, two sentences — and the asymmetry between them is the control.
 *
 * The operator line is pinned to the exact format the plan specifies, because an
 * operator who cannot read the line at 3 a.m. has no wall. The worker line is
 * pinned to a constant, because an agent that can tell `fail` from `unknown` has
 * an oracle it can steer towards.
 */
import { describe, expect, it } from 'vitest';
import type { Delta, ScenarioResult, Verdict } from '@factory/contracts';
import { oneLineReason, workerFacingReason, WORKER_FACING_REFUSAL } from './reasons.ts';

function scenario(
  id: string,
  source: ScenarioResult['source'],
  outcome: ScenarioResult['outcome'],
): ScenarioResult {
  return { id, source, outcome, observed: null };
}

function delta(over: Partial<Delta> = {}): Delta {
  return {
    checked: true,
    baseRate: 0.85,
    candidateRate: 0.71,
    threshold: 0,
    observed: -0.14,
    holdoutRevision: 'r0001',
    ...over,
  };
}

function verdict(over: Partial<Verdict> = {}): Verdict {
  return {
    unitId: 'unit-1',
    attemptId: 'attempt-1',
    receiptSha: `sha256:${'0'.repeat(64)}`,
    holdoutRevision: 'r0001',
    policyVersion: 'wall-policy/abc',
    wallVersion: 'wall/0.1.0',
    outcome: 'fail',
    scenarios: [scenario('holdout:01', 'holdout', 'pass')],
    delta: delta(),
    reasons: [],
    evaluatedAt: '2026-11-01T12:00:00.000Z',
    ...over,
  };
}

/** The seven-scenario, two-failure shape from the phase plan. */
function sabotageVerdict(): Verdict {
  const scenarios: ScenarioResult[] = [
    scenario('faithfulness:01', 'faithfulness', 'pass'),
    scenario('acceptance:probe-answers', 'acceptance', 'pass'),
    scenario('holdout:01', 'holdout', 'pass'),
    scenario('holdout:02', 'holdout', 'pass'),
    scenario('holdout:03', 'holdout', 'fail'),
    scenario('holdout:04', 'holdout', 'pass'),
    scenario('holdout:05', 'holdout', 'fail'),
    scenario('holdout:06', 'holdout', 'pass'),
    scenario('holdout:07', 'holdout', 'pass'),
    scenario('delta', 'delta', 'fail'),
  ];
  return verdict({
    outcome: 'fail',
    scenarios,
    reasons: ['holdout_failed', 'delta_regression'],
    delta: delta({ baseRate: 0.85, candidateRate: 0.71, observed: -0.14, threshold: 0 }),
  });
}

describe('oneLineReason', () => {
  it('formats a sabotage rejection exactly as the plan specifies', () => {
    expect(oneLineReason(sabotageVerdict())).toBe(
      'REJECTED: holdout_failed, delta_regression — 2 of 7 scenarios failed; Δ -0.14 < 0.00',
    );
  });

  it('formats a pass without reason codes and with the Δ it achieved', () => {
    const line = oneLineReason(
      verdict({
        outcome: 'pass',
        reasons: [],
        scenarios: [
          scenario('holdout:01', 'holdout', 'pass'),
          scenario('acceptance:a', 'acceptance', 'pass'),
        ],
        delta: delta({ observed: 1, candidateRate: 1, baseRate: 0 }),
      }),
    );
    expect(line).toBe('ACCEPTED — all 2 checks passed; Δ 1.00 ≥ 0.00');
  });

  it('names unmeasured checks rather than hiding them behind a failure count', () => {
    const line = oneLineReason(
      verdict({
        outcome: 'unknown',
        reasons: ['holdout_unavailable', 'delta_unmeasured'],
        scenarios: [scenario('holdout', 'holdout', 'unknown')],
        delta: delta({ checked: false, baseRate: null, candidateRate: null, observed: null }),
      }),
    );
    expect(line).toBe(
      'UNVERIFIED: holdout_unavailable, delta_unmeasured — 1 of 1 checks unmeasured; Δ unmeasured',
    );
  });

  it('still reads as a sentence when there are no reason codes at all', () => {
    const line = oneLineReason(
      verdict({
        outcome: 'unknown',
        reasons: [],
        scenarios: [scenario('tests-weakened', 'policy', 'unknown')],
        delta: delta({ checked: false, observed: null }),
      }),
    );
    expect(line).toBe('UNVERIFIED — 1 of 1 checks unmeasured; Δ unmeasured');
  });
});

describe('workerFacingReason', () => {
  it('tells the agent nothing beyond the verdict word', () => {
    expect(workerFacingReason(sabotageVerdict())).toBe(WORKER_FACING_REFUSAL);
    expect(workerFacingReason(sabotageVerdict())).toBe('not accepted');
  });

  it('is identical for fail and unknown, so an agent cannot distinguish them', () => {
    const failed = workerFacingReason(verdict({ outcome: 'fail', reasons: ['holdout_failed'] }));
    const unknown = workerFacingReason(
      verdict({ outcome: 'unknown', reasons: ['holdout_unavailable'] }),
    );
    expect(failed).toBe(unknown);
  });

  it('never names a check, a scenario, a count or a threshold', () => {
    const line = workerFacingReason(sabotageVerdict());
    expect(line).not.toMatch(
      /holdout|delta|acceptance|scope|weakened|irreversible|faithful|scenario|\d/,
    );
  });

  it('reports acceptance on a pass verdict', () => {
    expect(
      workerFacingReason(
        verdict({
          outcome: 'pass',
          reasons: [],
          scenarios: [scenario('holdout:01', 'holdout', 'pass')],
        }),
      ),
    ).toBe('accepted');
  });
});
