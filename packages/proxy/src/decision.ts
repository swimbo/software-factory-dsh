/**
 * The privileged-operation decision: a record a person made, that the factory can audit.
 *
 * Three properties make this a control rather than a formality, and each is a field:
 *
 * - **it binds one operation, not a session.** `operationSha` is the hash of the
 *   *normalised* operation (`classify.operationSha`), so a decision granted for `sudo ls`
 *   cannot be replayed for `sudo rm`. A decision for a session would be a permission, and
 *   a permission is what the worker already has too much of.
 * - **it expires, against an injected clock.** `expiresAt` is absolute, and every check
 *   takes `nowIso` from the caller so a test can stand three hours later without sleeping.
 * - **the phrase comes from the operator's envelope, never from the worker's text.** The
 *   broker compares `decision.phrase` to the phrase the *operator* supplied on the command
 *   line envelope; the worker's narrative is not an input to this module at all (L1). An
 *   agent that writes "operator approved: yes, go ahead" into its receipt changes nothing.
 *
 * The record is persistable: `toEvent` produces the `privileged.decided` ledger event (the
 * append-only history an audit replays), and `toArtifact` the JSON file under
 * `FACTORY_HOME/gates/` that a person can read without a database. Both are written by the
 * caller through the `DecisionSink` port — this package deliberately does not import the
 * store, because a broker that can write the ledger can also lie in it.
 */
import { contentHash } from '../../contracts/src/index.ts';

import type { Classification } from './classify.ts';

/** ISO-8601 UTC. The decision is refused rather than coerced if it is not. */
const ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/u;
const SHA = /^sha256:[0-9a-f]{64}$/u;

export interface PrivilegedDecision {
  /** `gd_<hash[0:24]>`, derived from the decision content — never minted randomly. */
  readonly decisionId: string;
  /** What the decision is about: the unit id (or task id) the operator was looking at. */
  readonly taskId: string;
  /** Who decided. A key id or handle, not a claim the worker can assert. */
  readonly operator: string;
  /** The phrase from the operator's envelope, stored so the decision can be re-read. */
  readonly phrase: string;
  readonly expiresAt: string;
  /** `sha256:` over the normalised operation this decision allows. */
  readonly operationSha: string;
  readonly issuedAt: string;
  readonly outcome: 'allow' | 'deny';
}

export interface DecisionInput {
  readonly taskId: string;
  readonly operator: string;
  readonly phrase: string;
  readonly expiresAt: string;
  readonly issuedAt: string;
  readonly outcome: 'allow' | 'deny';
  readonly classification: Classification;
}

export class DecisionError extends Error {
  readonly code = 'SPEC_INVALID';
  readonly exitCode = 3;

  constructor(message: string) {
    super(message);
    this.name = 'DecisionError';
  }
}

/** The decision id is a function of the content, so replay cannot mint a second record. */
function deriveId(fields: Omit<PrivilegedDecision, 'decisionId'>): string {
  return `gd_${contentHash(fields).slice('sha256:'.length, 'sha256:'.length + 24)}`;
}

/**
 * Build a decision from the operator's envelope and the classified operation.
 *
 * Every field is required and validated: an absent phrase, an absent expiry or a
 * malformed hash throws `DecisionError` (exit 3) rather than producing a record that
 * would later fail in the broker with a message about something else.
 */
export function buildDecision(input: DecisionInput, operationSha: string): PrivilegedDecision {
  if (input.phrase.trim() === '') {
    throw new DecisionError(
      'a privileged decision needs the operator phrase from the envelope; an empty phrase is not a decision',
    );
  }
  if (input.operator.trim() === '') {
    throw new DecisionError('a privileged decision needs an operator identifier');
  }
  if (!ISO.test(input.expiresAt)) {
    throw new DecisionError(
      `expiresAt must be an ISO-8601 UTC timestamp, got ${JSON.stringify(input.expiresAt)}`,
    );
  }
  if (!ISO.test(input.issuedAt)) {
    throw new DecisionError(
      `issuedAt must be an ISO-8601 UTC timestamp, got ${JSON.stringify(input.issuedAt)}`,
    );
  }
  if (!SHA.test(operationSha)) {
    throw new DecisionError(
      `operationSha must be a sha256 hash of the normalised operation, got ${JSON.stringify(operationSha)}`,
    );
  }
  const fields = {
    taskId: input.taskId,
    operator: input.operator,
    phrase: input.phrase,
    expiresAt: input.expiresAt,
    operationSha,
    issuedAt: input.issuedAt,
    outcome: input.outcome,
  } as const;
  return { decisionId: deriveId(fields), ...fields };
}

/**
 * Read a decision back from an artifact, strictly.
 *
 * A lenient parse is how a decision file with a typo becomes an allow: every field is
 * checked here, and an extra field is a schema change nobody agreed to.
 */
export function parseDecision(raw: unknown): PrivilegedDecision {
  const body = raw as Partial<Record<keyof PrivilegedDecision, unknown>> | null;
  if (body === null || typeof body !== 'object') {
    throw new DecisionError('a privileged decision must be a JSON object');
  }
  const keys: readonly (keyof PrivilegedDecision)[] = [
    'decisionId',
    'taskId',
    'operator',
    'phrase',
    'expiresAt',
    'operationSha',
    'issuedAt',
    'outcome',
  ];
  for (const key of keys) {
    if (typeof body[key] !== 'string') {
      throw new DecisionError(`a privileged decision needs a string '${key}'`);
    }
  }
  const decision = body as unknown as PrivilegedDecision;
  if (decision.outcome !== 'allow' && decision.outcome !== 'deny') {
    throw new DecisionError(`outcome must be 'allow' or 'deny', got ${String(decision.outcome)}`);
  }
  if (!SHA.test(decision.operationSha)) {
    throw new DecisionError(`operationSha is not a sha256 hash: ${decision.operationSha}`);
  }
  if (!ISO.test(decision.expiresAt)) {
    throw new DecisionError(`expiresAt is not an ISO-8601 UTC timestamp: ${decision.expiresAt}`);
  }
  // The id must be the one the content implies, or the artifact was edited after signing.
  const expected = deriveId({
    taskId: decision.taskId,
    operator: decision.operator,
    phrase: decision.phrase,
    expiresAt: decision.expiresAt,
    operationSha: decision.operationSha,
    issuedAt: decision.issuedAt,
    outcome: decision.outcome,
  });
  if (decision.decisionId !== expected) {
    throw new DecisionError(
      `decisionId ${decision.decisionId} does not match its own content (${expected}); ` +
        'the record was edited after it was minted',
    );
  }
  return decision;
}

export interface DecisionFault {
  readonly code: 'GATE_REQUIRED' | 'MANDATE_EXPIRED';
  readonly exitCode: number;
  readonly detail: string;
  readonly matchedRule: string;
}

/**
 * The three decisions the broker can make about a decision record.
 *
 * Order matters: the hash first (is this decision about *this* operation?), then the
 * clock (is it still live?), then the phrase (did the operator say it?). A decision that
 * fails the hash check would also usually fail the phrase check, and reporting the
 * mismatch is the honest message.
 */
export function decisionFault(
  decision: PrivilegedDecision,
  operationSha: string,
  nowIso: string,
  operatorPhrase: string | null,
): DecisionFault | null {
  if (decision.outcome === 'deny') {
    return {
      code: 'GATE_REQUIRED',
      exitCode: 5,
      detail: `the operator decided to deny this operation (decision ${decision.decisionId})`,
      matchedRule: 'broker.decision-deny',
    };
  }
  if (decision.operationSha !== operationSha) {
    return {
      code: 'MANDATE_EXPIRED',
      exitCode: 3,
      detail:
        `decision ${decision.decisionId} was granted for operation ${decision.operationSha}, ` +
        `but this operation hashes to ${operationSha}; a decision binds one exact command`,
      matchedRule: 'broker.sha-mismatch',
    };
  }
  if (nowIso >= decision.expiresAt) {
    return {
      code: 'MANDATE_EXPIRED',
      exitCode: 3,
      detail: `decision ${decision.decisionId} expired at ${decision.expiresAt} (it is now ${nowIso})`,
      matchedRule: 'broker.expired',
    };
  }
  if (operatorPhrase === null) {
    return {
      code: 'GATE_REQUIRED',
      exitCode: 5,
      detail:
        'no operator phrase was supplied for this invocation, so the decision cannot be shown to have ' +
        'come from the operator rather than from the worker',
      matchedRule: 'broker.phrase-missing',
    };
  }
  if (decision.phrase !== operatorPhrase) {
    return {
      code: 'GATE_REQUIRED',
      exitCode: 5,
      detail:
        `the decision carries a phrase the operator did not supply on this invocation; the phrase comes ` +
        'from the operator envelope, never from the worker',
      matchedRule: 'broker.phrase-mismatch',
    };
  }
  return null;
}

/** The ledger event an audit replays. */
export function toEvent(decision: PrivilegedDecision): {
  readonly type: 'privileged.decided';
  readonly decisionId: string;
  readonly taskId: string;
  readonly operator: string;
  readonly operationSha: string;
  readonly expiresAt: string;
  readonly outcome: 'allow' | 'deny';
} {
  return {
    type: 'privileged.decided',
    decisionId: decision.decisionId,
    taskId: decision.taskId,
    operator: decision.operator,
    operationSha: decision.operationSha,
    expiresAt: decision.expiresAt,
    outcome: decision.outcome,
  };
}

/** The artifact a person reads without a database. */
export function toArtifact(decision: PrivilegedDecision): Record<string, unknown> {
  return {
    decisionId: decision.decisionId,
    taskId: decision.taskId,
    operator: decision.operator,
    phraseSha: contentHash({ phrase: decision.phrase }),
    operationSha: decision.operationSha,
    issuedAt: decision.issuedAt,
    expiresAt: decision.expiresAt,
    outcome: decision.outcome,
  };
}
