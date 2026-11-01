/**
 * The verdict contract — "a pass must be earned".
 *
 * A verdict is the wall's own signed statement about an attempt, and the one
 * thing it must never do is certify success without measuring it. Each test
 * below removes exactly one measurement from a fully-earned pass and expects the
 * refiner to refuse: zero scenarios, a non-pass scenario, an unmeasured Δ, a
 * null Δ, a Δ under threshold, or a reason code attached to a pass. `unknown`
 * and `fail` are accepted in any measurement state because neither can claim
 * success.
 */
import { describe, expect, it } from 'vitest';
import {
  assertVerdictIsEarned,
  Verdict,
  WALL_VERSION,
  type Verdict as VerdictType,
} from './verdict.ts';

const sha = (fill: string): string => `sha256:${fill.repeat(64)}`;

const earnedPass = (): VerdictType => ({
  unitId: 'U-7f3a9c',
  attemptId: 'A-01',
  receiptSha: sha('a'),
  holdoutRevision: 'h-88f1',
  policyVersion: 'q-2026.11.1',
  wallVersion: WALL_VERSION,
  outcome: 'pass',
  scenarios: [
    { id: 'ac-1', source: 'acceptance', outcome: 'pass', observed: 'exit 0' },
    { id: 'h-01', source: 'holdout', outcome: 'pass', observed: '2-of-3' },
    { id: 'd-01', source: 'delta', outcome: 'pass', observed: '0.10' },
  ],
  delta: {
    checked: true,
    baseRate: 0.2,
    candidateRate: 0.1,
    threshold: 0.05,
    observed: 0.1,
    holdoutRevision: 'h-88f1',
  },
  reasons: [],
  evaluatedAt: '2026-11-01T12:10:00.000Z',
});

describe('assertVerdictIsEarned', () => {
  it('accepts a fully measured pass (the fixture used below)', () => {
    expect(Verdict.safeParse(earnedPass()).success).toBe(true);
    expect(() => assertVerdictIsEarned(earnedPass())).not.toThrow();
  });

  it('accepts a pass whose observed Δ equals the threshold exactly (the gate is ≥, not >)', () => {
    const atThreshold = {
      ...earnedPass(),
      delta: { ...earnedPass().delta, baseRate: 0.1, candidateRate: 0.05, observed: 0.05 },
    };
    expect(() => assertVerdictIsEarned(atThreshold)).not.toThrow();
  });

  it('rejects a pass with zero measured scenarios', () => {
    const vacuous = { ...earnedPass(), scenarios: [] };
    expect(() => assertVerdictIsEarned(vacuous)).toThrow(/at least one measured scenario/);
  });

  it('rejects a pass when any scenario is not a pass', () => {
    const partial = {
      ...earnedPass(),
      scenarios: [
        { id: 'ac-1', source: 'acceptance' as const, outcome: 'pass' as const, observed: 'exit 0' },
        { id: 'h-07', source: 'holdout' as const, outcome: 'unknown' as const, observed: null },
      ],
    };
    expect(() => assertVerdictIsEarned(partial)).toThrow(/every scenario to pass/);
  });

  it('rejects a pass whose Δ was not checked (an unmeasured Δ is unknown, not pass)', () => {
    const unchecked = { ...earnedPass(), delta: { ...earnedPass().delta, checked: false } };
    expect(() => assertVerdictIsEarned(unchecked)).toThrow(/measured Δ/);
  });

  it('rejects a pass whose observed Δ is null', () => {
    const unmeasured = { ...earnedPass(), delta: { ...earnedPass().delta, observed: null } };
    expect(() => assertVerdictIsEarned(unmeasured)).toThrow(/observed Δ value/);
  });

  it('rejects a pass whose observed Δ is below the threshold', () => {
    const regressed = {
      ...earnedPass(),
      delta: { ...earnedPass().delta, baseRate: 0.2, candidateRate: 0.19, observed: 0.01 },
    };
    expect(() => assertVerdictIsEarned(regressed)).toThrow(/observed Δ .* ≥ threshold/);
  });

  it('rejects a pass that carries a reason code', () => {
    const reasoned = { ...earnedPass(), reasons: ['suite_unknown' as const] };
    expect(() => assertVerdictIsEarned(reasoned)).toThrow(/cannot carry reasons/);
  });

  it('rejects a fail that carries no reason code', () => {
    const unexplained = { ...earnedPass(), outcome: 'fail' as const };
    expect(() => assertVerdictIsEarned(unexplained)).toThrow(/at least one reason code/);
  });

  it('accepts an unknown verdict with an unmeasured Δ, because unknown cannot claim success', () => {
    const unknown = {
      ...earnedPass(),
      outcome: 'unknown' as const,
      scenarios: [],
      delta: { ...earnedPass().delta, checked: false, observed: null },
    };
    expect(() => assertVerdictIsEarned(unknown)).not.toThrow();
  });

  it('accepts a fail verdict whatever the Δ says (it claims no success to defend)', () => {
    const failed = {
      ...earnedPass(),
      outcome: 'fail' as const,
      reasons: ['suite_failed' as const],
      delta: { ...earnedPass().delta, checked: false, observed: null },
    };
    expect(() => assertVerdictIsEarned(failed)).not.toThrow();
  });
});
