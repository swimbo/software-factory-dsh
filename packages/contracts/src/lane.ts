/**
 * The qualifier's output: a lane decision.
 *
 * Six signals, each `pass | fail | unknown`, scored by a deterministic policy.
 * No model is consulted (finding TD9): a lane that depends on a sampled token
 * cannot be replayed, and a decision that cannot be replayed cannot be audited.
 */
import { z } from 'zod';

export const LANES = ['dark', 'lit', 'reject'] as const;
export type Lane = (typeof LANES)[number];

export const SIGNAL_NAMES = [
  'intent_derivability',
  'reversibility',
  'observability',
  'task_class_history',
  'size',
  'budget',
] as const;
export type SignalName = (typeof SIGNAL_NAMES)[number];

/** Reason codes are stable strings: the CLI, the holdout report and the ledger all quote them. */
export const QUALIFIER_REASON_CODES = [
  'INTENT_DERIVABLE',
  'INTENT_NOT_DERIVABLE',
  'RESTATE_BACK_MISSING',
  'SPEC_NOT_MACHINE_CHECKABLE',
  'RESTATE_BACK_MISMATCH',
  'REVERSIBLE',
  'IRREVERSIBLE_OPERATION',
  'TOUCH_PATHS_UNSCOPED',
  'ORACLE_PRESENT',
  'ORACLE_MISSING',
  'TASK_CLASS_STABLE',
  'TASK_CLASS_UNSTABLE',
  'TASK_CLASS_UNKNOWN',
  /** Cold start under an explicit policy: absence of history was accepted, not measured. */
  'TASK_CLASS_COLD_START',
  'SIZE_WITHIN_BUDGET',
  'SIZE_OVER_BUDGET',
  'BUDGET_WITHIN_ENVELOPE',
  'BUDGET_EXCEEDS_ENVELOPE',
  'BUDGET_UNKNOWN',
] as const;
export type QualifierReasonCode = (typeof QUALIFIER_REASON_CODES)[number];

export const Signal = z.object({
  name: z.enum(SIGNAL_NAMES),
  outcome: z.enum(['pass', 'fail', 'unknown']),
  /** The measured number the outcome came from, for the operator. */
  observed: z.string().max(2000).nullable(),
  /** Why it came out this way; the CLI prints the first failing signal first. */
  reason: z.enum(QUALIFIER_REASON_CODES),
  weight: z.number().min(0).max(100),
});
export type Signal = z.infer<typeof Signal>;

export const LaneDecision = z.object({
  unitId: z.string().min(1),
  lane: z.enum(LANES),
  score: z.number().min(0).max(100),
  /**
   * Exactly one signal per dimension, in contract order. A count check alone
   * would let six copies of one passing signal masquerade as a fully measured
   * decision — an unmeasured dimension silently becoming a passing one.
   */
  signals: z
    .array(Signal)
    .length(SIGNAL_NAMES.length)
    .refine(
      (list) => {
        const names = new Set(list.map((s) => s.name));
        return names.size === SIGNAL_NAMES.length;
      },
      { message: 'signals must cover each of the six dimensions exactly once' },
    )
    .refine((list) => list.every((s, i) => s.name === SIGNAL_NAMES[i]), {
      message:
        'signals must be ordered as intent_derivability, reversibility, observability, task_class_history, size, budget',
    }),
  /** Identifies the rule set. A policy change re-scores; the same policy reuses the stored decision. */
  policyVersion: z.string().min(1),
  decidedAt: z.string().datetime(),
  /** The mandate this decision authorises (absent for `reject`). */
  mandateId: z.string().nullable(),
});
export type LaneDecision = z.infer<typeof LaneDecision>;

/**
 * A qualifier decision must be *justified by its signals*: the lane is derived,
 * never assigned. This is the deterministic-controls rule (L2) enforced in code.
 */
export function assertLaneIsDerived(decision: LaneDecision, rejectThreshold: number): void {
  const unknown = decision.signals.filter((s) => s.outcome === 'unknown');
  const failed = decision.signals.filter((s) => s.outcome === 'fail');

  if (decision.lane === 'dark') {
    if (unknown.length > 0) {
      throw new Error(
        `lane=dark requires no unknown signals; unknown: ${unknown.map((s) => s.name).join(',')}`,
      );
    }
    if (failed.length > 0) {
      throw new Error(
        `lane=dark requires no failing signals; failed: ${failed.map((s) => s.name).join(',')}`,
      );
    }
  }
  if (decision.lane === 'reject' && decision.score >= rejectThreshold) {
    throw new Error(`lane=reject requires score < ${rejectThreshold}, got ${decision.score}`);
  }
  if (decision.lane === 'lit' && decision.mandateId !== null) {
    throw new Error('lane=lit must not mint a mandate');
  }
}
