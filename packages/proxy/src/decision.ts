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
import { keyId, signPayload, verifyPayloadSignature } from '../../gates/src/signing.ts';
import { contentHash } from '../../contracts/src/index.ts';

import { classify, operationSha, type Classification } from './classify.ts';

/** ISO-8601 UTC. The decision is refused rather than coerced if it is not. */
const ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/u;
const SHA = /^sha256:[0-9a-f]{64}$/u;

/**
 * The part of the record that is signed. Everything here is covered by the signature, so
 * editing *any* field invalidates it — that is the property that makes the artifact a
 * record rather than a suggestion.
 */
export interface DecisionContent {
  /** What the decision is about: the unit id (or task id) the operator was looking at. */
  readonly taskId: string;
  /** Who decided — the *key* identity (`ed25519:ab02…`), not a name the worker can assert. */
  readonly operator: string;
  /** The phrase from the operator's envelope, stored so the decision can be re-read. */
  readonly phrase: string;
  readonly expiresAt: string;
  /** `sha256:` over the normalised operation this decision allows. */
  readonly operationSha: string;
  readonly issuedAt: string;
  readonly outcome: 'allow' | 'deny';
  /** Which operator key signed it, so a retired key can be refused by identity. */
  readonly keyId: string;
}

export interface PrivilegedDecision extends DecisionContent {
  /** `gd_<hash[0:24]>`, derived from the decision content — never minted randomly. */
  readonly decisionId: string;
  /**
   * ed25519 over `sha256:` of the content (armoured PEM), or `null` for an unsigned
   * record. `null` is a *refusal* in the broker, never a fallback: an artifact whose
   * authenticity rests on a phrase in `ps` is the appearance of a gate.
   */
  readonly signature: string | null;
}

/** The bytes a signature covers: the hash of the content, ASCII on every platform. */
export function decisionPayload(content: DecisionContent): string {
  return contentHash({
    taskId: content.taskId,
    operator: content.operator,
    phrase: content.phrase,
    expiresAt: content.expiresAt,
    operationSha: content.operationSha,
    issuedAt: content.issuedAt,
    outcome: content.outcome,
    keyId: content.keyId,
  });
}

export interface DecisionInput {
  readonly taskId: string;
  readonly phrase: string;
  readonly expiresAt: string;
  readonly issuedAt: string;
  readonly outcome: 'allow' | 'deny';
  readonly classification: Classification;
  /** The operator's private key. Read by the CLI from `FACTORY_HOME/keys`, never by the worker. */
  readonly privateKeyPem: string;
  /** Its public half: the key id is derived from it, so the id cannot be asserted. */
  readonly publicKeyPem: string;
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
function deriveId(content: DecisionContent): string {
  return `gd_${contentHash(content).slice('sha256:'.length, 'sha256:'.length + 24)}`;
}

/**
 * The id a verified envelope will get, so a caller that already holds a signature can assemble the
 * record without holding a private key. `buildDecision` is for the signer; this is for the verifier.
 */
export function decisionIdOf(content: DecisionContent): string {
  return deriveId(content);
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
  let operator: string;
  try {
    operator = keyId(input.publicKeyPem);
  } catch (error) {
    throw new DecisionError(
      `the operator public key is not parsable, so the decision cannot name who signed it: ` +
        `${error instanceof Error ? error.message : String(error)}`,
    );
  }
  const content: DecisionContent = {
    taskId: input.taskId,
    operator,
    phrase: input.phrase,
    expiresAt: input.expiresAt,
    operationSha,
    issuedAt: input.issuedAt,
    outcome: input.outcome,
    keyId: operator,
  };
  // Signed at mint time, not later: a record that exists unsigned is a record somebody can
  // edit between two of our own lines.
  const signature = signPayload(decisionPayload(content), input.privateKeyPem);
  return { decisionId: deriveId(content), ...content, signature };
}

/**
 * Verify the signature, before anything else in the record is believed.
 *
 * Three refusals, all exit 5 and all `GATE_REQUIRED`, because each means "a person has to
 * decide" rather than "the authority ran out": unsigned, signed by a key that is no longer
 * active (retired/rotated), and signed but edited afterwards.
 */
export function signatureFault(
  decision: PrivilegedDecision,
  activeKeys: ReadonlyMap<string, string>,
): DecisionFault | null {
  if (decision.signature === null || decision.signature.trim() === '') {
    return {
      code: 'GATE_REQUIRED',
      exitCode: 5,
      detail:
        'the decision is unsigned. A phrase in `ps` is not proof of a person; without a signature the ' +
        'artifact is an assertion by whoever wrote it',
      matchedRule: 'broker.unsigned',
    };
  }
  const publicKeyPem = activeKeys.get(decision.keyId);
  if (publicKeyPem === undefined) {
    return {
      code: 'GATE_REQUIRED',
      exitCode: 5,
      detail:
        `decision ${decision.decisionId} was signed by ${decision.keyId}, which is not an active operator ` +
        `key (retired or unknown: ${[...activeKeys.keys()].join(', ') || 'no active keys'})`,
      matchedRule: 'broker.key-unknown',
    };
  }
  const valid = verifyPayloadSignature({
    payload: decisionPayload(decision),
    signaturePem: decision.signature,
    publicKeyPem,
  });
  if (!valid) {
    return {
      code: 'GATE_REQUIRED',
      exitCode: 5,
      detail:
        `the signature on decision ${decision.decisionId} does not verify against ${decision.keyId}: the ` +
        'record was edited after it was signed, or signed over different bytes',
      matchedRule: 'broker.signature-invalid',
    };
  }
  return null;
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
    'keyId',
    'signature',
  ];
  for (const key of keys) {
    if (key === 'signature') {
      if (body.signature !== null && typeof body.signature !== 'string') {
        throw new DecisionError("a privileged decision's signature must be a string or null");
      }
      continue;
    }
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
    keyId: decision.keyId,
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
  activeKeys: ReadonlyMap<string, string>,
): DecisionFault | null {
  // Signature first: nothing in an unverified record may be believed, including its own
  // `outcome` field — otherwise a forged record could "decide to deny" and be trusted.
  const signature = signatureFault(decision, activeKeys);
  if (signature !== null) return signature;
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

/**
 * The canonical phrase a decision for this operation carries: `decide <first 8 hex>`.
 *
 * The phrase is the operator's *typed* confirmation, so it belongs to the invocation rather than to
 * the record — but the artifact deliberately writes only `phraseSha`, never the phrase (a reader
 * should not be handed a string they can reuse, and the record should not carry the operator's
 * words in a file). Making the phrase a function of the signed `operationSha` is what lets a later
 * reader recover it, check it against `phraseSha`, and re-verify the signature at all. It also means
 * a decision can only ever confirm the operation it names: there is no "decide something else".
 */
export function gatePhraseOf(operationSha: string): string {
  if (!SHA.test(operationSha)) {
    throw new DecisionError(
      `a gate phrase is derived from a sha256 operation hash, got ${JSON.stringify(operationSha)}`,
    );
  }
  return `decide ${operationSha.slice('sha256:'.length, 'sha256:'.length + 8)}`;
}

/**
 * Which of the live decisions, if any, authorises *this* argv.
 *
 * The lookup is by the classified operation's hash, never by argv equality: the classifier
 * normalises (`/usr/bin/sudo` and `sudo` are one operation, `env X=1 sudo` unwraps to `sudo`),
 * so a match on the raw strings would let a decision for one shape authorise a different one.
 *
 * The `phrase` this returns is safe to hand to the broker as `operatorPhrase` *because* the
 * candidate has already passed `decisionFault` — signature against an active key, `outcome:
 * 'allow'`, this exact operation, and a live expiry. The phrase is a field of the signed
 * content, so a verified signature is what proves the operator committed to it; reading it
 * from the record is not reading it from the worker's fixture. A `deny` record is a refusal,
 * never an "allow with a different phrase".
 *
 * Newest wins when two decisions cover the same operation: the operator's most recent word is
 * the one that counts, and either would be a valid single use.
 */
export function liveDecisionFor(
  argv: readonly string[],
  options: {
    readonly home: string | null;
    readonly nowIso: string;
    readonly activeKeys: ReadonlyMap<string, string>;
    readonly decisions: readonly PrivilegedDecision[];
  },
): PrivilegedDecision | null {
  const classification = classify(argv, { home: options.home });
  // An unprivileged operation needs no decision, and an ambiguous one is refused by the broker
  // whatever we return here — so presenting nothing is the honest answer in both cases.
  if (classification.ambiguous || !classification.privileged) return null;
  const sha = operationSha(classification);
  let best: PrivilegedDecision | null = null;
  for (const decision of options.decisions) {
    if (decision.outcome !== 'allow') continue;
    if (decision.operationSha !== sha) continue;
    if (decisionFault(decision, sha, options.nowIso, decision.phrase, options.activeKeys) !== null)
      continue;
    if (best === null || decision.issuedAt > best.issuedAt) best = decision;
  }
  return best;
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
    keyId: decision.keyId,
    // The signature travels with the artifact so a person can verify that the record they
    // are reading is the record that was signed, with `openssl` and no factory at all.
    signature: decision.signature,
    payloadSha: decisionPayload(decision),
    phraseSha: contentHash({ phrase: decision.phrase }),
    operationSha: decision.operationSha,
    issuedAt: decision.issuedAt,
    expiresAt: decision.expiresAt,
    outcome: decision.outcome,
  };
}
