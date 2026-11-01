/**
 * The lane contract — the lane is *derived*, never assigned (L2).
 *
 * Six deterministic signals produce a lane. This file proves the direction of
 * causation: a `dark` lane cannot be stated when any signal is unknown or
 * failing, a `lit` lane cannot mint a mandate, and a `reject` cannot carry a
 * passing score. A decision that violated any of these would be an opinion
 * dressed as a measurement.
 */
import { describe, expect, it } from 'vitest';
import type { Tri } from './errors.ts';
import {
  assertLaneIsDerived,
  LaneDecision,
  SIGNAL_NAMES,
  type LaneDecision as LaneDecisionType,
  type QualifierReasonCode,
  type Signal,
  type SignalName,
} from './lane.ts';

/** The policy threshold used throughout: at or above it a unit must not be rejected. */
const REJECT_THRESHOLD = 40;

const signal = (
  name: SignalName,
  outcome: Tri,
  reason: QualifierReasonCode,
  weight = 16,
): Signal => ({ name, outcome, observed: 'measured', reason, weight });

const darkDecision = (): LaneDecisionType => ({
  unitId: 'U-7f3a9c',
  lane: 'dark',
  score: 96,
  signals: [
    signal('intent_derivability', 'pass', 'INTENT_DERIVABLE'),
    signal('reversibility', 'pass', 'REVERSIBLE'),
    signal('observability', 'pass', 'ORACLE_PRESENT'),
    signal('task_class_history', 'pass', 'TASK_CLASS_STABLE'),
    signal('size', 'pass', 'SIZE_WITHIN_BUDGET'),
    signal('budget', 'pass', 'BUDGET_WITHIN_ENVELOPE'),
  ],
  policyVersion: 'q-2026.11.1',
  decidedAt: '2026-11-01T12:00:00.000Z',
  mandateId: 'M-2b1e',
});

/** Replace one signal's outcome, leaving the other five passing. */
function withOutcome(name: SignalName, outcome: Tri): LaneDecisionType {
  return {
    ...darkDecision(),
    signals: darkDecision().signals.map((entry) =>
      entry.name === name ? { ...entry, outcome } : entry,
    ),
  };
}

describe('the lane decision fixture', () => {
  it('is a valid decision by its own contract', () => {
    expect(LaneDecision.safeParse(darkDecision()).success).toBe(true);
  });

  it('measures exactly the six required signals, one per dimension', () => {
    expect(darkDecision().signals.map((entry) => entry.name)).toEqual([...SIGNAL_NAMES]);
  });
});

describe('assertLaneIsDerived', () => {
  it('accepts a clean all-pass dark decision (the fixture used below)', () => {
    expect(() => assertLaneIsDerived(darkDecision(), REJECT_THRESHOLD)).not.toThrow();
  });

  it('rejects lane=dark when any signal is unknown (an unmeasured dimension cannot route dark)', () => {
    for (const name of SIGNAL_NAMES) {
      expect(() => assertLaneIsDerived(withOutcome(name, 'unknown'), REJECT_THRESHOLD)).toThrow(
        /requires no unknown signals/,
      );
    }
  });

  it('rejects lane=dark when any signal has failed', () => {
    for (const name of SIGNAL_NAMES) {
      expect(() => assertLaneIsDerived(withOutcome(name, 'fail'), REJECT_THRESHOLD)).toThrow(
        /requires no failing signals/,
      );
    }
  });

  it('rejects lane=lit that carries a mandate (lit must not mint one)', () => {
    const lit = { ...darkDecision(), lane: 'lit' as const };
    expect(() => assertLaneIsDerived(lit, REJECT_THRESHOLD)).toThrow(/must not mint a mandate/);
  });

  it('accepts lane=lit with a null mandate', () => {
    const lit = { ...darkDecision(), lane: 'lit' as const, mandateId: null };
    expect(() => assertLaneIsDerived(lit, REJECT_THRESHOLD)).not.toThrow();
  });

  it('rejects lane=reject at or above the reject threshold', () => {
    const atThreshold = { ...darkDecision(), lane: 'reject' as const, score: REJECT_THRESHOLD };
    expect(() => assertLaneIsDerived(atThreshold, REJECT_THRESHOLD)).toThrow(/requires score </);
    const above = { ...darkDecision(), lane: 'reject' as const, score: REJECT_THRESHOLD + 1 };
    expect(() => assertLaneIsDerived(above, REJECT_THRESHOLD)).toThrow(/requires score </);
  });

  it('accepts lane=reject below the reject threshold', () => {
    const below = { ...darkDecision(), lane: 'reject' as const, score: REJECT_THRESHOLD - 1 };
    expect(() => assertLaneIsDerived(below, REJECT_THRESHOLD)).not.toThrow();
  });
});

describe('LaneDecision.parse', () => {
  it('rejects five signals (a missing dimension cannot be interpolated)', () => {
    const five = { ...darkDecision(), signals: darkDecision().signals.slice(0, 5) };
    expect(LaneDecision.safeParse(five).success).toBe(false);
  });

  it('rejects seven signals (an extra dimension has no weight in the policy)', () => {
    const seven = {
      ...darkDecision(),
      signals: [...darkDecision().signals, signal('size', 'pass', 'SIZE_WITHIN_BUDGET')],
    };
    expect(LaneDecision.safeParse(seven).success).toBe(false);
  });

  it('rejects a signal outcome outside pass/fail/unknown', () => {
    const maybe = {
      ...darkDecision(),
      signals: darkDecision().signals.map((entry) => ({ ...entry, outcome: 'maybe' })),
    };
    expect(LaneDecision.safeParse(maybe).success).toBe(false);
  });

  /**
   * GAP — reported to the lead, not fixed here. `LaneDecision` enforces the
   * signal *count* (six) but not that the six names are distinct, so a decision
   * carrying six `size` signals parses while `reversibility` was never measured.
   * `assertLaneIsDerived` then sees six passes and routes the unit dark: an
   * unmeasured dimension silently becomes a passed one, which is the L3
   * inversion in the qualifier.
   *
   * `it.fails` asserts the required rule while keeping the suite green; it goes
   * red when the schema gains a distinctness check, prompting promotion to `it`.
   */
  it('rejects six signals that repeat a name instead of measuring all six dimensions', () => {
    const duplicated = {
      ...darkDecision(),
      signals: darkDecision().signals.map((entry) => ({
        ...entry,
        name: 'size' as const,
        reason: 'SIZE_WITHIN_BUDGET' as const,
      })),
    };
    expect(() => LaneDecision.parse(duplicated)).toThrow();
  });
});
