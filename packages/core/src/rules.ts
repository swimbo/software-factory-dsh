/**
 * The pure rules of dispatch.
 *
 * Everything here is a function of plain data: no store, no clock, no I/O. That
 * is deliberate — these are the decisions an auditor has to be able to re-derive
 * years later from the ledger alone, so they must not depend on ambient state.
 *
 * The rule with the most teeth: **unknown never satisfies a gate.** A missing
 * estimate is not zero, a missing measurement is not a pass, and an unmeasured Δ
 * is not a regression-free Δ.
 */
import {
  FactoryError,
  type UnitState,
  isTerminal,
  MAX_ATTEMPTS_PER_UNIT,
} from '@factory/contracts';

export interface BudgetInputs {
  /** Per-unit envelope in USD, from the signed envelope row. */
  readonly envelopeUsd: number;
  /** Already reserved for this unit (dispatch-time reservations). */
  readonly reservedUsd: number;
  /** Already measured or estimated as spent for this unit. */
  readonly spentUsd: number;
  /** The spec's best-effort estimate. `null` means the operator did not estimate. */
  readonly estimateUsd: number | null;
}

export interface BudgetDecision {
  readonly allowed: boolean;
  /** What will be reserved if allowed. `null` when the amount is genuinely unknown. */
  readonly reserveUsd: number | null;
  readonly kind: 'estimate' | 'unknown';
  /** Plain-language reason, printed by the CLI and stored on the refusal. */
  readonly reason: string;
}

/**
 * Reservation policy: reserve the estimate, or — when there is no estimate —
 * reserve the *remaining* envelope. The second case is why `kind` exists: a
 * reservation of "everything left" is not an estimate, it is a placeholder, and
 * the status page has to say so rather than render it as a precise number.
 */
export function planReservation(inputs: BudgetInputs): BudgetDecision {
  const committed = Math.max(0, inputs.reservedUsd) + Math.max(0, inputs.spentUsd);
  const remaining = inputs.envelopeUsd - committed;

  if (remaining <= 0) {
    return {
      allowed: false,
      reserveUsd: null,
      kind: 'estimate',
      // Committed spend is recorded, so it is labelled as such: it is a measurement, not a
      // projection, and the comparison only means something if the reader can tell them apart.
      reason: `envelope exhausted: committed (recorded) $${committed.toFixed(2)} of $${inputs.envelopeUsd.toFixed(2)}`,
    };
  }

  if (inputs.estimateUsd === null) {
    return {
      allowed: true,
      reserveUsd: remaining,
      kind: 'unknown',
      reason: `no estimate; reserving the remaining envelope $${remaining.toFixed(2)} (a ceiling, not an estimate; spend will be reported as unknown, not as zero)`,
    };
  }

  if (inputs.estimateUsd > remaining) {
    return {
      allowed: false,
      reserveUsd: null,
      kind: 'estimate',
      // A-2: money that is a guess must say so. "estimates the run as $2.41" is the claim; a
      // bare dollar figure next to a recorded ceiling reads as if both were measurements.
      reason: `estimates the run as $${inputs.estimateUsd.toFixed(2)} > remaining envelope $${remaining.toFixed(2)} (the run cost is an estimate, not a measurement)`,
    };
  }

  return {
    allowed: true,
    reserveUsd: inputs.estimateUsd,
    kind: 'estimate',
    reason: `reserving estimated $${inputs.estimateUsd.toFixed(2)} of $${remaining.toFixed(2)} remaining`,
  };
}

export interface MandateView {
  readonly mandateId: string;
  readonly lane: 'dark' | 'lit';
  readonly expiresAt: string;
  readonly revokedAt: string | null;
  readonly budgetUsd: number;
}

export function mandateIsLive(mandate: MandateView, nowIso: string): boolean {
  if (mandate.revokedAt !== null) return false;
  if (mandate.lane !== 'dark') return false;
  return Date.parse(mandate.expiresAt) > Date.parse(nowIso);
}

export interface DispatchInputs {
  readonly unitId: string;
  readonly state: UnitState;
  readonly lane: 'dark' | 'lit' | 'reject' | null;
  readonly attemptCount: number;
  readonly mandate: MandateView | null;
  readonly liveLease: { leaseId: string; owner: string } | null;
  readonly nowIso: string;
  readonly budget: BudgetInputs;
}

export interface DispatchApproval {
  readonly reserveUsd: number | null;
  readonly budgetKind: 'estimate' | 'unknown';
}

/**
 * The single gate between "qualified" and "a container gets a repo". Every
 * refusal here is a `FactoryError` with the contract's code, because the CLI
 * prints the code and scripts switch on the exit class.
 */
export function assertDispatchable(inputs: DispatchInputs): DispatchApproval {
  if (isTerminal(inputs.state)) {
    throw new FactoryError(
      'UNIT_ALREADY_TERMINAL',
      `unit ${inputs.unitId} is already terminal (${inputs.state})`,
      { unitId: inputs.unitId, state: inputs.state },
    );
  }
  if (inputs.state !== 'qualified') {
    throw new FactoryError(
      'UNIT_ALREADY_TERMINAL',
      `unit ${inputs.unitId} is ${inputs.state}; only a qualified unit can be dispatched`,
      { unitId: inputs.unitId, state: inputs.state },
    );
  }
  if (inputs.lane !== 'dark') {
    throw new FactoryError(
      'LANE_NOT_DARK',
      `unit ${inputs.unitId} is lane=${String(inputs.lane)}; the factory does not dispatch it. See: factory qualify ${inputs.unitId}`,
      { unitId: inputs.unitId, lane: inputs.lane },
    );
  }
  if (inputs.mandate === null) {
    throw new FactoryError(
      'MANDATE_EXPIRED',
      `unit ${inputs.unitId} has no mandate; re-qualify it (factory qualify ${inputs.unitId})`,
      { unitId: inputs.unitId },
    );
  }
  if (!mandateIsLive(inputs.mandate, inputs.nowIso)) {
    throw new FactoryError(
      'MANDATE_EXPIRED',
      `mandate ${inputs.mandate.mandateId} for ${inputs.unitId} is not live (expired or revoked at ${inputs.mandate.expiresAt})`,
      { unitId: inputs.unitId, mandateId: inputs.mandate.mandateId },
    );
  }
  if (inputs.attemptCount >= MAX_ATTEMPTS_PER_UNIT) {
    throw new FactoryError(
      'UNIT_ALREADY_TERMINAL',
      `unit ${inputs.unitId} has used ${inputs.attemptCount}/${MAX_ATTEMPTS_PER_UNIT} attempts; a human must abort or re-scope it`,
      { unitId: inputs.unitId, attempts: inputs.attemptCount },
    );
  }
  if (inputs.liveLease !== null) {
    throw new FactoryError(
      'LEASE_HELD',
      `unit ${inputs.unitId} is leased by ${inputs.liveLease.owner} (${inputs.liveLease.leaseId}); wait or abort`,
      { unitId: inputs.unitId, leaseId: inputs.liveLease.leaseId },
    );
  }

  const budget = planReservation(inputs.budget);
  if (!budget.allowed) {
    throw new FactoryError('BUDGET_EXCEEDED', `${inputs.unitId}: ${budget.reason}`, {
      unitId: inputs.unitId,
      envelopeUsd: inputs.budget.envelopeUsd,
    });
  }
  return { reserveUsd: budget.reserveUsd, budgetKind: budget.kind };
}

/**
 * Ceilings are set *before* dispatch and printed in the run header, so an
 * operator can never be surprised by them. Wall clock dominates: a stuck agent
 * that never emits a turn is the failure mode that burns money silently.
 */
export interface Ceilings {
  readonly maxTurns: number;
  readonly wallClockMs: number;
  readonly maxOutputBytes: number;
}

export function ceilingsFor(inputs: { budgetUsd: number }): Ceilings {
  const budget = Math.max(0, inputs.budgetUsd);
  return {
    // Derived from budget rather than configured, so the two cannot disagree:
    // at the worker tier roughly $0.02/turn, a $2 envelope is ~100 turns.
    maxTurns: Math.max(10, Math.min(400, Math.floor((budget / 0.02) * 0.5))),
    wallClockMs: 45 * 60 * 1000,
    maxOutputBytes: 8 * 1024 * 1024,
  };
}

/**
 * The Δ gate. Returns `unknown` when either side is unmeasured — and the caller
 * must treat `unknown` as a refusal, never as a pass.
 */
export function deltaVerdict(inputs: {
  baseRate: number | null;
  candidateRate: number | null;
  threshold: number;
}): { outcome: 'pass' | 'fail' | 'unknown'; observed: number | null } {
  const { baseRate, candidateRate, threshold } = inputs;
  if (baseRate === null || candidateRate === null) {
    return { outcome: 'unknown', observed: null };
  }
  const observed = candidateRate - baseRate;
  return { outcome: observed >= threshold ? 'pass' : 'fail', observed };
}

/** Attempt numbering is 1-based and monotonic; it is part of the launch idempotency key. */
export function nextAttemptNumber(previous: number): number {
  return previous + 1;
}
