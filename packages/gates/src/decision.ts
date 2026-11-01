/**
 * What every gate returns, and the one place this package looks at a clock.
 *
 * A gate is a capability, not a request (`architecture.md` §2.4): it either allows an
 * effect or refuses it, and the refusal is the *same string* on screen, in `--json` and
 * in the ledger (`ux-plan.md` §5.2). So each gate returns a decision object whose
 * `decisionHash` is a deterministic function of the decision — that hash is what
 * `gate_decision_id = gd_<hash[0:24]>` is derived from, which is why this module mints
 * the id but never the timestamp.
 *
 * **Persistence:** there is no `gate_decisions` table in `packages/store` (verified:
 * `grep -rn "gate_decision" packages/store/src` returns nothing), so the promise that a
 * `GateDecision` becomes a row is *not* implemented. What exists is the ledger event
 * (`credential.issued`, `privileged.decided`) plus the `FACTORY_HOME/gates/` artifact.
 * Recorded here rather than papered over; `data-map.md` §2.20 needs the same correction.
 *
 * The clock is isolated here on purpose. `readWallClock` is the only function in
 * `packages/gates` that consults the system time, and only the credential gate needs
 * it (a TTL has to be anchored to something). Every gate accepts an injected `nowIso`
 * and every test passes one, so the decisions are reproducible byte for byte.
 */
import { contentHash, type ErrorCode } from '@factory/contracts';

/** The four capability boundaries the factory has (`data-map.md` §2.20 `gate_kind`). */
export const GATE_KINDS = [
  'budget',
  'destructive_op',
  'promotion',
  'credential',
  'privileged',
] as const;
export type GateKind = (typeof GATE_KINDS)[number];

/** `require_human` is a decision, not an error: the gate is open, waiting for a person. */
export const GATE_OUTCOMES = ['allow', 'deny', 'require_human'] as const;
export type GateOutcome = (typeof GATE_OUTCOMES)[number];

/** The reason shape stored in `GateDecision.reason` (`{code, detail, matched_rule}`). */
export interface GateReason {
  /** `ALLOW` for a satisfied gate; otherwise an `ErrorCode`, so exit codes stay computable. */
  readonly code: ErrorCode | 'ALLOW';
  /** One sentence, printable: what the gate measured. */
  readonly detail: string;
  /** Which rule decided it. Stable strings, because the audit quotes them. */
  readonly matchedRule: string;
}

export interface GateDecisionResult {
  readonly gateKind: GateKind;
  readonly decision: GateOutcome;
  readonly reason: GateReason;
  /** `sha256:` over the decision content. Replay of the same inputs yields the same hash. */
  readonly decisionHash: string;
  /** `gd_<hash[0:24]>`, the `GateDecision` primary key (`data-map.md` §2.20). */
  readonly gateDecisionId: string;
}

/**
 * A usage error, exit `2`.
 *
 * Deliberately *not* a `FactoryError`: the exit-code contract (`ux-plan.md` §5.1) gives
 * `2` to "bad flag/verb/missing argument" — commander's own code — and has no
 * `ErrorCode` for it. Minting a code that maps to 2 would break the rule that one code
 * means one next-action, so the CLI maps this class to exit 2 exactly as it maps
 * commander's own usage failures. Everything the *gate* decides is a `FactoryError`
 * with a code from the contract; anything that is merely malformed input is this.
 */
export class GateUsageError extends Error {
  readonly code = 'USAGE';
  readonly exitCode = 2;

  constructor(message: string) {
    super(message);
    this.name = 'GateUsageError';
  }
}

export interface GateDecisionInput {
  readonly gateKind: GateKind;
  readonly decision: GateOutcome;
  /** What the decision is about — unit id, repo, envelope scope. Part of the hash. */
  readonly subject: string;
  readonly code: ErrorCode | 'ALLOW';
  readonly detail: string;
  readonly matchedRule: string;
}

/**
 * Build the decision object. The hash covers the whole decision *except* itself, so the
 * same inputs always produce the same `gateDecisionId` and a replayed gate cannot
 * create a second `GateDecision` row.
 */
export function makeGateDecision(input: GateDecisionInput): GateDecisionResult {
  const reason: GateReason = {
    code: input.code,
    detail: input.detail,
    matchedRule: input.matchedRule,
  };
  const decisionHash = contentHash({
    gateKind: input.gateKind,
    decision: input.decision,
    subject: input.subject,
    reason,
  });
  return {
    gateKind: input.gateKind,
    decision: input.decision,
    reason,
    decisionHash,
    gateDecisionId: `gd_${decisionHash.slice('sha256:'.length, 'sha256:'.length + 24)}`,
  };
}

const ISO_INSTANT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/;

/** The only clock read in this package. Everything else takes the time as a parameter. */
export function readWallClock(): string {
  return new Date().toISOString();
}

/**
 * Resolve the timestamp a gate anchors its output to: the caller's, or the wall clock.
 *
 * Injected time wins, so a replay can reproduce an `expiresAt` exactly; a malformed
 * timestamp is a usage error rather than a silent "now", because a credential whose
 * expiry came from an unparseable argument is a credential nobody can audit.
 */
export function resolveNow(nowIso?: string): string {
  if (nowIso === undefined) return readWallClock();
  if (!ISO_INSTANT.test(nowIso) || Number.isNaN(Date.parse(nowIso))) {
    throw new GateUsageError(`nowIso must be an ISO-8601 instant, got ${JSON.stringify(nowIso)}`);
  }
  return nowIso;
}

/** Pure calendar arithmetic on an injected instant. Not a clock read. */
export function addSeconds(nowIso: string, seconds: number): string {
  return new Date(Date.parse(nowIso) + seconds * 1000).toISOString();
}
