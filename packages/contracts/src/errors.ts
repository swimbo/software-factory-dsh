/**
 * The error and exit-code contract.
 *
 * The exit codes below are normative (`ux-plan.md` §5.1): scripts may switch on
 * the number alone, so a code may never mean two different next-actions and `1`
 * is never a catch-all for a classified outcome. Every refusal in the factory is
 * one of these — the CLI, the status page and the ledger all read from here.
 */

export const ERROR_CODES = [
  // 3 — policy refusal: known, correct, fixable by editing or resubmitting
  'SPEC_INVALID',
  'DUPLICATE_UNIT',
  'LANE_NOT_DARK',
  'UNIT_NOT_FOUND',
  'ATTEMPT_NOT_FOUND',
  'MANDATE_EXPIRED',
  'UNIT_ALREADY_TERMINAL',
  /**
   * The unit's task class has been measured and refused: its latest class certificate is
   * `not-certified` (at least `m` attempts were judged and fewer than `k` passed). Exit 3, like
   * `LANE_NOT_DARK`: the request is well-formed and the class is known — the class is what the
   * evidence refuses. Distinct from `VERDICT_FAILED` (3) because nothing about *this* attempt
   * failed: the refusal is a fact about the population it belongs to, and the remedy is a corpus or
   * an operating-point decision, not a re-run. `insufficient` certificates never refuse — every
   * first-of-class unit is insufficient by construction, which is what cold start exists for.
   */
  'CLASS_NOT_CERTIFIED',
  'VERDICT_FAILED',
  // 4 — unknown / ambiguous: never implies success, never implies failure
  'ATTEMPT_AMBIGUOUS',
  'WALL_UNAVAILABLE',
  // 5 — human gate
  'GATE_REQUIRED',
  'PROMOTION_UNSIGNED',
  'VERDICT_MISSING',
  'VERDICT_STALE',
  'VERDICT_UNKNOWN',
  // 6 — budget
  'BUDGET_EXCEEDED',
  /**
   * Metered spend could not be reconciled against the gateway: either the gateway's own
   * export was missing/unreadable, or a recorded usage fact disagrees with it. Exit 6 with
   * `BUDGET_EXCEEDED`'s family, because the subject is spend — but distinct, because
   * "we overspent" and "we cannot account for what we spent" are different sentences and an
   * operator needs to know which one they are being told.
   */
  'USAGE_UNRECONCILED',
  // 7 — concurrency / conflict
  'LEASE_HELD',
  'RECEIPT_CONFLICT',
  // 8 — environment
  /**
   * No ledger anchor target is configured (or the configured one cannot be reached). Exit 8, not 9:
   * the ledger may be perfectly intact — nobody has told the factory where the off-host copy lives, so
   * "is this ledger anchored?" has no answer yet. The distinction matters because exit 9 tells an
   * operator to stop and investigate, while 8 tells them to finish configuring.
   */
  'ANCHOR_UNAVAILABLE',
  'EXECUTOR_UNAVAILABLE',
  'DSH_VERSION_MISMATCH',
  'CONTAINER_UNAVAILABLE',
  /**
   * Two settings are each valid and cannot both be honoured — today the only case is
   * `FACTORY_WORKER_ISOLATION=container` with a live model: the container runs with
   * `--network none`, and the credential proxy that fronts the gateway binds `127.0.0.1` on this
   * host. Exit 8 like the other "the environment cannot do this" codes, but distinct because the
   * next action is the opposite of `CONTAINER_UNAVAILABLE`'s: nothing is missing and nothing needs
   * to be built, so a reader sent to `docker build` would rebuild a daemon and an image that are
   * both fine. The fix is to unset one of the two levers.
   */
  'CONFIGURATION_CONFLICT',
  /**
   * A dispatch ceiling the operator set is already reached. Exit 7 (conflict), like
   * `LEASE_HELD`: the request is well-formed and the factory is healthy — the *world* is
   * busy. Distinct from `BUDGET_EXCEEDED` (6) because nothing was spent, and from
   * `LEASE_HELD` because the conflict is with the factory's own ceiling rather than with
   * another controller's lease on this unit.
   */
  'CONCURRENCY_LIMIT',
  // 9 — integrity
  'STORE_QUARANTINED',
  // 1 — internal: the factory is in a state it cannot account for
  'INTERNAL',
] as const;

export type ErrorCode = (typeof ERROR_CODES)[number];

/** Code → exit code. Total by construction: every ErrorCode has exactly one. */
const EXIT: Record<ErrorCode, number> = {
  SPEC_INVALID: 3,
  DUPLICATE_UNIT: 3,
  LANE_NOT_DARK: 3,
  UNIT_NOT_FOUND: 3,
  ATTEMPT_NOT_FOUND: 3,
  MANDATE_EXPIRED: 3,
  UNIT_ALREADY_TERMINAL: 3,
  CLASS_NOT_CERTIFIED: 3,
  VERDICT_FAILED: 3,
  ATTEMPT_AMBIGUOUS: 4,
  WALL_UNAVAILABLE: 4,
  GATE_REQUIRED: 5,
  PROMOTION_UNSIGNED: 5,
  VERDICT_MISSING: 5,
  VERDICT_STALE: 5,
  VERDICT_UNKNOWN: 5,
  BUDGET_EXCEEDED: 6,
  USAGE_UNRECONCILED: 6,
  LEASE_HELD: 7,
  RECEIPT_CONFLICT: 7,
  ANCHOR_UNAVAILABLE: 8,
  EXECUTOR_UNAVAILABLE: 8,
  DSH_VERSION_MISMATCH: 8,
  CONTAINER_UNAVAILABLE: 8,
  CONFIGURATION_CONFLICT: 8,
  CONCURRENCY_LIMIT: 7,
  STORE_QUARANTINED: 9,
  INTERNAL: 1,
};

export function exitCodeFor(code: ErrorCode): number {
  return EXIT[code];
}

/**
 * The one class of error the factory raises. Anything else that escapes is a
 * bug and the CLI turns it into `INTERNAL` with a trace id — never into one of
 * the classified codes, because a misclassified outcome is worse than a crash.
 */
export class FactoryError extends Error {
  readonly code: ErrorCode;
  readonly exitCode: number;
  readonly details: Readonly<Record<string, unknown>>;

  constructor(code: ErrorCode, message: string, details: Record<string, unknown> = {}) {
    super(message);
    this.name = 'FactoryError';
    this.code = code;
    this.exitCode = exitCodeFor(code);
    this.details = Object.freeze({ ...details });
  }
}

export function isFactoryError(value: unknown): value is FactoryError {
  return value instanceof FactoryError;
}

/**
 * `unknown` is a first-class outcome, not a missing value. These helpers keep
 * the "unknown never satisfies a gate" rule in one place so no call site has to
 * remember it.
 */
export type Tri = 'pass' | 'fail' | 'unknown';

export function triFromBool(value: boolean): Tri {
  return value ? 'pass' : 'fail';
}

export function triIsPass(value: Tri): boolean {
  return value === 'pass';
}

/** A gate is satisfied only by an explicit pass. `unknown` and `fail` both refuse. */
export function gateSatisfied(value: Tri): boolean {
  return value === 'pass';
}
