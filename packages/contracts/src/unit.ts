/**
 * The unit of intent, and the state machine that guards it.
 *
 * A `UnitSpec` is immutable: a re-scoped unit is a new unit (append-only). Every
 * field here exists because a later control needs it — `acceptance` for
 * derivability, `operationClasses` for blast radius, `oracle` for observability,
 * `sizeBudget` for the size signal, `budgetEstimateUsd` for the envelope.
 */
import { z } from 'zod';

export const OPERATION_CLASSES = [
  'code-change',
  'test-change',
  'schema-migration',
  'data-delete',
  'force-push',
  'dependency-upgrade',
  'credential-use',
  'network-egress',
  'config-change',
  // Privileged work — `sudo`, `docker`, `gh`, `kubectl`, `security`, `defaults write`,
  // writes under `/etc`, `~/.ssh`, `~/.aws`. Deliberately *not* in
  // `IRREVERSIBLE_OPERATION_CLASSES`: a declared class is a claim (L1), and the control
  // for this one is the broker (`packages/proxy`) refusing to perform an operation that
  // has no recorded human decision. Making the declaration force review would let an
  // honest label cost throughput while a dishonest one changed nothing.
  'privileged',
] as const;
export type OperationClass = (typeof OPERATION_CLASSES)[number];

/** The classes that make an outcome irreversible enough to keep a human in the loop. */
export const IRREVERSIBLE_OPERATION_CLASSES: readonly OperationClass[] = [
  'schema-migration',
  'data-delete',
  'force-push',
  'credential-use',
];

export const ORACLE_KINDS = ['unit-test', 'command', 'http', 'data'] as const;
export type OracleKind = (typeof ORACLE_KINDS)[number];

/**
 * An acceptance criterion is machine-checkable or it does not exist. There is
 * deliberately no `manual` kind: "manual" is the most common authoring mistake
 * and the qualifier rejects it with a dedicated message.
 */
export const AcceptanceCriterion = z.object({
  id: z.string().regex(/^[a-z][a-z0-9-]{0,63}$/),
  text: z.string().min(1).max(2000),
  oracle: z.object({
    kind: z.enum(ORACLE_KINDS),
    /** For `command`: the argv that proves it. For `http`: a URL. For `data`: a SQL/assertion file. */
    target: z.string().min(1).max(2000),
    expect: z.string().min(1).max(2000),
  }),
});
export type AcceptanceCriterion = z.infer<typeof AcceptanceCriterion>;

export const SizeBudget = z.object({
  files: z.number().int().positive().max(10_000),
  lines: z.number().int().positive().max(1_000_000),
});
export type SizeBudget = z.infer<typeof SizeBudget>;

export const UnitSpec = z.object({
  /** Operator-facing identity, slug-like, unique per repo. */
  slug: z.string().regex(/^[a-z0-9][a-z0-9-]{0,63}$/),
  /** Bumped by the operator when the *intent* changes; the same slug+revision+hash is the same unit. */
  revision: z.number().int().positive(),
  repo: z.string().min(1),
  /** The base commit the work is cut from. A 40-hex SHA: a branch name is not a reproducible base. */
  baseRev: z.string().regex(/^[0-9a-f]{40}$/),
  intent: z.string().min(20).max(20_000),
  /** The agent's restatement of the intent, checked against `intent` by the qualifier. */
  restateBack: z.string().min(20).max(20_000),
  acceptance: z.array(AcceptanceCriterion).min(1).max(64),
  touchPaths: z.array(z.string().min(1)).min(1).max(512),
  operationClasses: z.array(z.enum(OPERATION_CLASSES)).max(16),
  sizeBudget: SizeBudget,
  /** Best-effort estimate. `unknown` is allowed and never satisfies the budget gate by itself. */
  budgetEstimateUsd: z.number().nonnegative().max(1_000_000).nullable(),
});
export type UnitSpec = z.infer<typeof UnitSpec>;

export const UNIT_STATES = [
  'submitted',
  'qualified',
  'lit_parked',
  'dispatched',
  'receipted',
  'verified',
  'promoted',
  'rejected',
  'aborted',
  'ambiguous',
] as const;
export type UnitState = (typeof UNIT_STATES)[number];

export const TERMINAL_UNIT_STATES: readonly UnitState[] = [
  'promoted',
  'rejected',
  'aborted',
  'lit_parked',
];

export function isTerminal(state: UnitState): boolean {
  return TERMINAL_UNIT_STATES.includes(state);
}

/**
 * The transition table. Every mutation of a unit goes through this, and
 * `dispatched → verified` is deliberately absent: a unit cannot be verified
 * without first being receipted, which is what keeps a narrative from
 * short-circuiting into a verdict.
 */
const TRANSITIONS: Record<UnitState, readonly UnitState[]> = {
  submitted: ['qualified', 'rejected', 'aborted', 'ambiguous'],
  qualified: ['dispatched', 'lit_parked', 'aborted', 'ambiguous'],
  lit_parked: [],
  dispatched: ['receipted', 'aborted', 'ambiguous'],
  // A *measured* failure is a known outcome: it rejects the unit. Without this
  // edge the only exits from `receipted` would be `aborted` (needs an operator)
  // or `ambiguous` — i.e. a fail verdict would have to be reclassified as
  // unknown, which is the L3 inversion the whole design forbids.
  receipted: ['verified', 'rejected', 'aborted', 'ambiguous'],
  verified: ['promoted', 'aborted', 'ambiguous'],
  promoted: [],
  rejected: [],
  aborted: [],
  ambiguous: ['receipted', 'rejected', 'aborted'],
};

export function canTransition(from: UnitState, to: UnitState): boolean {
  return TRANSITIONS[from].includes(to);
}

export function assertTransition(from: UnitState, to: UnitState): void {
  if (!canTransition(from, to)) {
    throw new Error(`illegal unit transition ${from} → ${to}`);
  }
}

/** How many attempts a unit may consume before the factory refuses to dispatch it again. */
export const MAX_ATTEMPTS_PER_UNIT = 3;

export const ATTEMPT_STATES = [
  'planned',
  'launching',
  'running',
  'produced-receipt',
  'aborted',
  'ambiguous',
] as const;
export type AttemptState = (typeof ATTEMPT_STATES)[number];
