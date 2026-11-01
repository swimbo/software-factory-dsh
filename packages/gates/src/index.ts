/**
 * `@factory/gates` — capabilities, not requests.
 *
 * Three human gates and one structural one live here (`architecture.md` §2.4):
 *
 * - `buildPromotion` — the initial-production-deploy gate: an earned `pass` verdict plus a
 *   verifiable ed25519 human signature, or nothing is written at all.
 * - `signEnvelopeRaise` — the budget-envelope gate: a typed phrase naming the amount, and
 *   `assertNoBypassFlag` so no verb accepts `--yes`/`--force`/`-f`.
 * - `issueCredential` — the privileged-credential gate: single repo, ≤ 1 h, typed phrase
 *   for privileged classes, and never a secret in the returned handle.
 *
 * Determinism: no model, no network, no new dependencies (`node:crypto` and `node:fs` only).
 * Time enters through an injected `nowIso` everywhere except `readWallClock`, which is the
 * single clock read in the package and exists only to anchor a TTL.
 */
export {
  GATED_VERBS,
  BYPASS_FLAGS,
  ENVELOPE_SCOPES,
  type EnvelopeScope,
  type EnvelopeRaiseInput,
  type EnvelopeDecision,
  type OperatorSignature,
  envelopeRaisePhrase,
  envelopeRaiseSignaturePayload,
  signEnvelopeRaise,
  assertNoBypassFlag,
} from './budget.ts';

export {
  MAX_CREDENTIAL_TTL_SECONDS,
  type IssueCredentialInput,
  type CredentialGrant,
  privilegedCredentialPhrase,
  issueCredential,
} from './credentials.ts';

export {
  PROMOTION_FORMAT,
  type PromotionInput,
  type PromotionArtifact,
  type PromotionSignaturePayload,
  type ExistingPromotion,
  promotionSignaturePayload,
  requiresHumanSignature,
  buildPromotion,
} from './promotion.ts';

export {
  GATE_KINDS,
  type GateKind,
  GATE_OUTCOMES,
  type GateOutcome,
  type GateReason,
  type GateDecisionResult,
  GateUsageError,
  makeGateDecision,
  readWallClock,
  resolveNow,
  addSeconds,
} from './decision.ts';

export {
  signaturePemOf,
  signatureBytesOf,
  normaliseSignature,
  signPayload,
  verifyPayloadSignature,
  keyId,
} from './signing.ts';
