/**
 * The promotion gate — human gate 1, the initial production deploy.
 *
 * The gate is closed by a **signature from a human key**, not by a flag and not by a
 * typed phrase. `promotion.yaml` is the artifact a merge depends on (`architecture.md`
 * §2.4), so the rule is: `verdict.outcome === 'pass'` **and** an ed25519 signature over
 * `contentHash({unitId, verdictSha, approvedBy})` that verifies against the operator's
 * public key — otherwise `PROMOTION_UNSIGNED` and **no file at all**.
 *
 * "No file at all" is the point. A draft written before the signature check is how
 * "unsigned" becomes "signed by accident": some later step finds a plausible
 * `promotion.yaml`, the human signature field is empty, and nothing in the file says so
 * loudly enough. So the artifact is rendered *after* every refusal path, written to a
 * temporary name and renamed into place — a crash leaves either the old state or the
 * complete artifact, never a half-written one.
 *
 * Replaying the same promotion is idempotent: the content is a pure function of the
 * verdict and the signature, so a second `factory promote` of the same verdict produces
 * byte-identical output and writes nothing. A *different* promotion at the same path is
 * `RECEIPT_CONFLICT`, because a signed artifact is never overwritten.
 */
import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { dirname } from 'node:path';
import {
  FactoryError,
  assertVerdictIsEarned,
  contentHash,
  sha256Hex,
  type DecisionReceipt,
  type VerdictType,
} from '@factory/contracts';
import { GateUsageError, makeGateDecision, type GateDecisionResult } from './decision.ts';
import { keyId, normaliseSignature, verifyPayloadSignature } from './signing.ts';

/** The artifact format. A change to the shape below must bump this string. */
export const PROMOTION_FORMAT = 'promotion/1';

export interface PromotionInput {
  readonly unitId: string;
  readonly verdict: VerdictType;
  /** The receipt the verdict was produced against; its diff hash is recorded for traceability. */
  readonly receipt: DecisionReceipt;
  /** The operator's identity, e.g. `operator@host` or an email. Recorded, never invented. */
  readonly signedBy: string;
  /** The human signature, armoured PEM or bare base64 of the 64 signature bytes. */
  readonly signaturePem: string;
  /** The trusted operator key. The CLI loads this from operator config — never from argv. */
  readonly operatorPublicKeyPem: string;
  /** Where `promotion.yaml` goes (inside `~/.factory/artifacts/<unitId>/`). */
  readonly promotionPath: string;
  /**
   * The store's current holdout revision, when the caller knows it. A verdict produced
   * under a different revision is stale and refuses (`VERDICT_STALE`); leaving it out is
   * only for callers that have no store (tests, a dry run).
   */
  readonly currentHoldoutRevision?: string;
  /** The current qualifier policy version, when the caller knows it. A mismatch is stale. */
  readonly currentPolicyVersion?: string;
}

export interface PromotionArtifact {
  /** `sha256:` over every field of the artifact except itself. This is the artifact's identity. */
  readonly promotionSha: string;
  readonly promotionPath: string;
  readonly verdictSha: string;
  readonly signaturePayloadSha: string;
  /** `ed25519:<8 hex>` — the `human_key_id` the store records (`data-map.md` §2.24). */
  readonly humanKeyId: string;
  /** The exact bytes on disk, so a caller can print or compare them without re-deriving. */
  readonly content: string;
  /** `false` when an identical artifact was already present (an idempotent replay). */
  readonly written: boolean;
  readonly decision: GateDecisionResult;
}

export interface PromotionSignaturePayload {
  readonly unitId: string;
  readonly verdictSha: string;
  readonly approvedBy: string;
  /** The exact string the operator must sign. */
  readonly payload: string;
  readonly signaturePayloadSha: string;
}

/**
 * The bytes to sign, published so an operator's tooling can reproduce them.
 *
 * `verdictSha` is the verdict's content hash and `approvedBy` is the operator identity, so
 * a signature can never be lifted from one unit to another or from one verdict to the
 * next. `payload` is a `sha256:` string: ASCII, fixed length, no normalisation rules.
 */
export function promotionSignaturePayload(input: {
  readonly unitId: string;
  readonly verdict: VerdictType;
  readonly approvedBy: string;
}): PromotionSignaturePayload {
  const verdictSha = contentHash(input.verdict);
  const payload = contentHash({
    unitId: input.unitId,
    verdictSha,
    approvedBy: input.approvedBy,
  });
  return {
    unitId: input.unitId,
    verdictSha,
    approvedBy: input.approvedBy,
    payload,
    signaturePayloadSha: `sha256:${sha256Hex(payload)}`,
  };
}

/**
 * A prior promotion of a unit, as the store reports it. Only a promotion that carries a
 * non-empty signature counts: a requested-but-unsigned row is not a prior signing.
 */
export interface ExistingPromotion {
  readonly unitId: string;
  readonly promotionSha: string;
  readonly verdictSha: string;
  readonly approvedBy: string;
  readonly signaturePem: string;
}

/**
 * Is this unit's promotion a human gate?
 *
 * Yes while no prior *signed* promotion of the unit exists. The first promotion of any
 * unit is always signed (`architecture.md` §2.4, `data-map.md` §2.24 `is_first_promotion`),
 * and this function is what the CLI uses to decide whether to show the gate block. It is
 * a pure question about recorded state — it never touches the store itself.
 */
export function requiresHumanSignature(
  unitId: string,
  existingPromotions: readonly ExistingPromotion[],
  options: { readonly verdictRequiresHumanSignature?: boolean } = {},
): boolean {
  // Two independent reasons, either of which opens the gate: this unit has never been
  // signed before, or the wall says the verdict verified without being certifiable.
  if (options.verdictRequiresHumanSignature === true) return true;
  const alreadySigned = existingPromotions.some(
    (promotion) => promotion.unitId === unitId && promotion.signaturePem.trim().length > 0,
  );
  return !alreadySigned;
}

/** Every field of the artifact except `promotion_sha` itself. This is what gets hashed. */
interface PromotionPayload {
  readonly promotionFormat: string;
  readonly unitId: string;
  readonly verdictSha: string;
  readonly verdictOutcome: string;
  readonly verdictAttemptId: string;
  readonly receiptDiffSha: string;
  readonly approvedBy: string;
  readonly approvedByKeyId: string;
  readonly signaturePayloadSha: string;
  /** Contract flag: the verdict verified, but its task class is not certifiable. */
  readonly promotionRequiresHumanSignature: boolean;
  readonly signature: string;
}

/**
 * Render the artifact as YAML with a fixed key order.
 *
 * No YAML library: the shape is ten scalars and one block scalar, and a dependency here
 * would be a dependency in the path that writes a signed artifact. Scalars are emitted in
 * JSON double-quoted style, which is valid YAML and escapes every byte that matters;
 * `signature` is a literal block so the PEM stays readable in `git diff` and in an audit.
 *
 * Every field above `promotion_sha` is covered by the hash, so a reader can recompute the
 * hash from the file alone.
 */
function renderPromotionArtifact(payload: PromotionPayload, promotionSha: string): string {
  const lines: readonly string[] = [
    '# Signed promotion record. Written by the factory; never edited by hand.',
    '# Every field above promotion_sha is covered by that hash.',
    `promotion_format: ${yamlScalar(payload.promotionFormat)}`,
    `unit_id: ${yamlScalar(payload.unitId)}`,
    `verdict_sha: ${yamlScalar(payload.verdictSha)}`,
    `verdict_outcome: ${yamlScalar(payload.verdictOutcome)}`,
    `verdict_attempt_id: ${yamlScalar(payload.verdictAttemptId)}`,
    `receipt_diff_sha: ${yamlScalar(payload.receiptDiffSha)}`,
    `approved_by: ${yamlScalar(payload.approvedBy)}`,
    `approved_by_key_id: ${yamlScalar(payload.approvedByKeyId)}`,
    `signature_payload_sha: ${yamlScalar(payload.signaturePayloadSha)}`,
    `promotion_requires_human_signature: ${payload.promotionRequiresHumanSignature ? 'true' : 'false'}`,
    'signature: |',
    ...payload.signature.split('\n').map((line) => `  ${line}`),
    `promotion_sha: ${yamlScalar(promotionSha)}`,
    '',
  ];
  return lines.join('\n');
}

/** A YAML double-quoted scalar, which is exactly a JSON string. Deterministic and total. */
function yamlScalar(value: string): string {
  return JSON.stringify(value);
}

/** Refuse with a `FactoryError`, always naming what the operator must do next. */
function refuse(
  code:
    | 'PROMOTION_UNSIGNED'
    | 'VERDICT_UNKNOWN'
    | 'VERDICT_FAILED'
    | 'VERDICT_STALE'
    | 'RECEIPT_CONFLICT',
  message: string,
  details: Record<string, unknown>,
): never {
  throw new FactoryError(code, message, details);
}

/**
 * Build (and, when allowed, write) the signed promotion artifact.
 *
 * Checks, in order — each refuses before anything is rendered or written:
 * 1. usage: a non-empty `unitId`, `signedBy` and `promotionPath`;
 * 2. identity: the verdict and the receipt must belong to this unit and this attempt;
 * 3. outcome: `unknown` → `VERDICT_UNKNOWN`, `fail` → `VERDICT_FAILED`;
 * 4. soundness: the verdict must satisfy its own earned-pass invariant, or the "pass"
 *    being promoted is a claim rather than a measurement;
 * 5. signature: absent or unverifiable → `PROMOTION_UNSIGNED`, and nothing is written.
 *
 * @throws FactoryError with one of `SPEC`-free codes above; nothing is written unless the
 * gate allows.
 */
export function buildPromotion(input: PromotionInput): PromotionArtifact {
  if (input.unitId.trim().length === 0) {
    throw new GateUsageError('promote needs a unit id');
  }
  if (input.promotionPath.trim().length === 0) {
    throw new GateUsageError('promote needs a --promotion-path to write the artifact to');
  }
  if (input.signedBy.trim().length === 0) {
    throw new GateUsageError(
      'promote needs --signed-by: a promotion with no human identity is unauditable',
    );
  }

  const { verdict, receipt } = input;

  if (verdict.unitId !== input.unitId) {
    refuse(
      'RECEIPT_CONFLICT',
      `RECEIPT_CONFLICT: verdict ${verdict.unitId} belongs to another unit; refusing to promote ${input.unitId}`,
      { reason: 'verdict-unit-mismatch', expected: input.unitId, got: verdict.unitId },
    );
  }
  if (receipt.unitId !== input.unitId) {
    refuse(
      'RECEIPT_CONFLICT',
      `RECEIPT_CONFLICT: receipt ${receipt.unitId} belongs to another unit`,
      {
        reason: 'receipt-unit-mismatch',
        expected: input.unitId,
        got: receipt.unitId,
      },
    );
  }
  if (receipt.attemptId !== verdict.attemptId) {
    refuse(
      'RECEIPT_CONFLICT',
      `RECEIPT_CONFLICT: receipt ${receipt.attemptId} and verdict ${verdict.attemptId} describe different attempts`,
      {
        reason: 'receipt-verdict-attempt-mismatch',
        receiptAttempt: receipt.attemptId,
        verdictAttempt: verdict.attemptId,
      },
    );
  }

  if (verdict.promotionRequiresHumanSignature === true && verdict.outcome !== 'pass') {
    // The contract says the flag is never set on `fail` or `unknown` (a reason code, not a
    // flag, describes those). A verdict that breaks that rule was not produced by the wall.
    refuse(
      'RECEIPT_CONFLICT',
      `RECEIPT_CONFLICT: verdict outcome is ${verdict.outcome} but carries promotionRequiresHumanSignature; the wall never sets that flag on a non-pass verdict`,
      { reason: 'inconsistent-verdict-flag', outcome: verdict.outcome },
    );
  }
  if (verdict.outcome === 'unknown') {
    refuse(
      'VERDICT_UNKNOWN',
      'VERDICT_UNKNOWN: the verdict is unknown (not measured). Unknown is not a pass and cannot promote; restore the missing dependency and re-verify.',
      {
        reason: 'verdict-unknown',
        verdictAttempt: verdict.attemptId,
        verdictReasons: verdict.reasons,
      },
    );
  }
  if (verdict.outcome === 'fail') {
    refuse(
      'VERDICT_FAILED',
      'VERDICT_FAILED: the wall ran and the change did not pass; fix and resubmit a new revision.',
      { reason: 'verdict-failed', verdictReasons: verdict.reasons },
    );
  }
  try {
    assertVerdictIsEarned(verdict);
  } catch (error) {
    // A "pass" that cannot show its measurement is a forged or corrupted verdict. There is
    // no dedicated error code for that, so it is an integrity conflict (exit 7) rather than
    // a policy refusal: retrying will not help, inspecting the wall will.
    refuse(
      'RECEIPT_CONFLICT',
      `RECEIPT_CONFLICT: verdict claims pass but fails its own earned-pass invariant: ${error instanceof Error ? error.message : String(error)}`,
      { reason: 'verdict-not-earned' },
    );
  }

  // Staleness is checked before the signature: a verdict produced under an older holdout or
  // policy must be re-verified whatever else is wrong with the request, and telling the
  // operator "sign this" about a stale verdict would send them to the wrong repair.
  if (
    input.currentHoldoutRevision !== undefined &&
    input.currentHoldoutRevision !== verdict.holdoutRevision
  ) {
    refuse(
      'VERDICT_STALE',
      `VERDICT_STALE: verdict was produced under holdout ${verdict.holdoutRevision}; store is now ${input.currentHoldoutRevision}. Re-verify: factory run ${input.unitId} --verify-only`,
      {
        reason: 'holdout-revision-changed',
        verdictHoldoutRevision: verdict.holdoutRevision,
        currentHoldoutRevision: input.currentHoldoutRevision,
      },
    );
  }
  if (
    input.currentPolicyVersion !== undefined &&
    input.currentPolicyVersion !== verdict.policyVersion
  ) {
    refuse(
      'VERDICT_STALE',
      `VERDICT_STALE: verdict was produced under policy ${verdict.policyVersion}; current policy is ${input.currentPolicyVersion}. Re-verify: factory run ${input.unitId} --verify-only`,
      {
        reason: 'policy-version-changed',
        verdictPolicyVersion: verdict.policyVersion,
        currentPolicyVersion: input.currentPolicyVersion,
      },
    );
  }

  const signature = promotionSignaturePayload({
    unitId: input.unitId,
    verdict,
    approvedBy: input.signedBy,
  });

  const signatureVerified =
    input.signaturePem.trim().length > 0 &&
    verifyPayloadSignature({
      payload: signature.payload,
      signaturePem: input.signaturePem,
      publicKeyPem: input.operatorPublicKeyPem,
    });

  if (!signatureVerified) {
    refuse(
      'PROMOTION_UNSIGNED',
      'PROMOTION_UNSIGNED: promotion requires a human signature over ' +
        `${signature.payload}; none was provided and none can be synthesized. No artifact was written.`,
      {
        gate: 'initial-production-deploy',
        reason: input.signaturePem.trim().length === 0 ? 'signature-absent' : 'signature-invalid',
        signaturePayload: signature.payload,
        promotionPath: input.promotionPath,
      },
    );
  }

  const humanKeyId = keyId(input.operatorPublicKeyPem);
  const payload: PromotionPayload = {
    promotionFormat: PROMOTION_FORMAT,
    unitId: input.unitId,
    verdictSha: signature.verdictSha,
    verdictOutcome: verdict.outcome,
    verdictAttemptId: verdict.attemptId,
    receiptDiffSha: receipt.diff.sha,
    approvedBy: input.signedBy,
    approvedByKeyId: humanKeyId,
    signaturePayloadSha: signature.signaturePayloadSha,
    promotionRequiresHumanSignature: verdict.promotionRequiresHumanSignature === true,
    signature: normaliseSignature(input.signaturePem),
  };

  const promotionSha = contentHash(payload);
  const content = renderPromotionArtifact(payload, promotionSha);

  const existing = existsSync(input.promotionPath)
    ? readFileSync(input.promotionPath, 'utf8')
    : null;
  if (existing !== null) {
    if (existing === content) {
      // Idempotent replay: the same verdict, the same signature, the same bytes. Nothing to do.
      return {
        promotionSha,
        promotionPath: input.promotionPath,
        verdictSha: signature.verdictSha,
        signaturePayloadSha: signature.signaturePayloadSha,
        humanKeyId,
        content,
        written: false,
        decision: promotionDecision(input.unitId, promotionSha, signature.verdictSha),
      };
    }
    refuse(
      'RECEIPT_CONFLICT',
      `RECEIPT_CONFLICT: ${input.promotionPath} already holds a different promotion (${promotionSha} is not it). Signed artifacts are never overwritten.`,
      {
        reason: 'promotion-artifact-conflict',
        promotionPath: input.promotionPath,
        expected: promotionSha,
      },
    );
  }

  writeAtomically(input.promotionPath, content);

  return {
    promotionSha,
    promotionPath: input.promotionPath,
    verdictSha: signature.verdictSha,
    signaturePayloadSha: signature.signaturePayloadSha,
    humanKeyId,
    content,
    written: true,
    decision: promotionDecision(input.unitId, promotionSha, signature.verdictSha),
  };
}

function promotionDecision(
  unitId: string,
  promotionSha: string,
  verdictSha: string,
): GateDecisionResult {
  return makeGateDecision({
    gateKind: 'promotion',
    decision: 'allow',
    subject: `unit:${unitId}`,
    code: 'ALLOW',
    detail: `promotion ${promotionSha} for verdict ${verdictSha} signed by human key`,
    matchedRule: 'promotion.verdict-pass+human-signature',
  });
}

/**
 * Write to `<path>.tmp` and rename into place.
 *
 * A rename within a directory is atomic, so an observer sees either no artifact or the
 * complete one. The temporary file is removed on failure: a stray `.tmp` would be a
 * half-written promotion record — exactly what the unsigned refusal promises not to leave.
 */
function writeAtomically(path: string, content: string): void {
  const temporary = `${path}.tmp`;
  mkdirSync(dirname(path), { recursive: true });
  try {
    writeFileSync(temporary, content, { encoding: 'utf8', mode: 0o600 });
    renameSync(temporary, path);
  } catch (error) {
    if (existsSync(temporary)) unlinkSync(temporary);
    throw error;
  }
}
