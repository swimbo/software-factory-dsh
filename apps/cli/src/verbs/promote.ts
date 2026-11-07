/**
 * `factory promote` — human gate 1, and the gate that writes nothing at all when
 * it is closed.
 *
 * The order of refusals is deliberate: the **signature** is checked before the
 * verdict is even read, because an unsigned promotion can never be written, and
 * `ux-plan.md` §3.7 is explicit that a refusal must leave no `promotion.yaml` —
 * not even a draft. A half-written artifact is how "unsigned" becomes "signed by
 * accident". When the unit also has no verdict, that fact is printed in the same
 * breath so the operator is not sent on a second round trip.
 *
 * The typed phrase (`sign promotion <unitId>`, §4.4) is checked *before* the
 * cryptographic signature is read: the phrase proves the operator read the gate;
 * the ed25519 signature proves it is the operator. Neither substitutes for the
 * other, and the CLI can mint neither.
 */
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

import { contentHash, FactoryError, toDecisionReceipt } from '@factory/contracts';
import { buildPromotion, promotionSignaturePayload, requiresHumanSignature } from '@factory/gates';

import { UsageError } from '../exit.ts';
import { field } from '../render/format.ts';
import { renderPromotionGate } from '../render/gate.ts';
import { textOption, type VerbInput, type VerbSpec } from './types.ts';

export const PROMOTION_PHRASE_PREFIX = 'sign promotion';

export function promotionPhrase(unitId: string): string {
  return `${PROMOTION_PHRASE_PREFIX} ${unitId}`;
}

/**
 * `--signature <path>` names a **file**, and the help has always said so.
 *
 * The value is read when it is an existing file, and otherwise used verbatim so an
 * operator can paste an armoured signature through a shell variable. Reading first
 * matters: passing the *path* to the verifier — as this verb used to — fails every real
 * promotion with `PROMOTION_UNSIGNED`, which is a refusal the operator cannot fix by
 * doing what the error asks.
 */
function resolveSignature(value: string | undefined): string | undefined {
  if (value === undefined) return undefined;
  if (existsSync(value)) {
    try {
      const text = readFileSync(value, 'utf8').trim();
      if (text.length > 0) return text;
    } catch {
      return value;
    }
  }
  return value;
}

function operatorPublicKeyPem(ctx: VerbInput['ctx']): string | null {
  const configured = (ctx.env.FACTORY_OPERATOR_KEY ?? '').trim();
  const candidates = [
    ...(configured.length === 0 ? [] : [configured]),
    join(ctx.paths.keys, 'operator.pub.pem'),
    join(ctx.paths.keys, 'operator.ed25519.pub'),
  ];
  for (const candidate of candidates) {
    if (!existsSync(candidate)) continue;
    try {
      const text = readFileSync(candidate, 'utf8').trim();
      if (text.length > 0) return text;
    } catch {
      continue;
    }
  }
  return null;
}

/**
 * Reason codes that mean "this pass was not measured".
 *
 * `fake_verdict_not_measured` is the explicit one. The rest are the wall's own
 * vocabulary for a check it could not run: a pass carrying any of them is a
 * contradiction (the contract refuses to store such a pass today), so this list is
 * belt-and-braces against a future wall that records an unmeasured check as a note
 * rather than as `unknown`.
 */
const UNMEASURED_REASONS: ReadonlySet<string> = new Set([
  'fake_verdict_not_measured',
  'acceptance_unmeasured',
  'delta_unmeasured',
  'holdout_unavailable',
  'receipt_unavailable',
  'suite_unknown',
]);

export function isUnmeasuredReason(reason: string): boolean {
  return UNMEASURED_REASONS.has(reason);
}

/** A wall version this build stamps on a replayed verdict (`<base>-fake`). */
export function isFakeWall(wallVersion: string | null | undefined): boolean {
  return typeof wallVersion === 'string' && wallVersion.endsWith('-fake');
}

export function runPromote(input: VerbInput): number {
  const { ctx } = input;
  const unitId = input.args[0];
  if (unitId === undefined || unitId.trim().length === 0) {
    throw new UsageError(
      `USAGE: factory promote <unitId> --signature <file> --confirm "${PROMOTION_PHRASE_PREFIX} <unitId>"`,
    );
  }

  const unit = ctx.store.getUnit(unitId);
  if (unit === null) {
    throw new FactoryError(
      'UNIT_NOT_FOUND',
      `UNIT_NOT_FOUND: no unit ${unitId}. See: factory status --all`,
      {
        unitId,
      },
    );
  }

  const verdictRow = ctx.store.latestVerdictForUnit(unitId);
  const signaturePem = resolveSignature(textOption(input.options, 'signature'));
  const phrase = promotionPhrase(unitId);

  // The payload an operator has to sign, computed once: `sha256(unitId, verdictSha, approvedBy)`.
  // `contentHash(verdict.verdict)` is the verdict hash, not the payload, and printing that one would
  // be a different kind of lie.
  const payloadToSign =
    verdictRow === null
      ? null
      : promotionSignaturePayload({
          unitId,
          verdict: verdictRow.verdict,
          approvedBy: textOption(input.options, 'signedBy') ?? 'operator',
        });

  if (signaturePem === undefined) {
    // One renderer for the gate: the refusal and the prompt must be the same
    // block, or the operator has to compare two layouts to find the difference.
    const gateBlock = renderPromotionGate({
      unitId,
      title: unit.spec.intent.split('\n')[0]?.slice(0, 40) ?? unit.slug,
      lane: unit.lane ?? 'pending',
      verdictId: verdictRow?.verdictId ?? null,
      verdictState: verdictRow?.outcome ?? null,
      deltaText: 'none',
      wallVersion: verdictRow?.wallVersion ?? null,
      holdoutRevision: verdictRow?.holdoutRevision ?? null,
      receiptId: null,
      artifactPath: join(ctx.paths.artifacts, unitId, 'promotion.yaml'),
      phrase,
      firstPromotion: true,
    });
    for (const line of gateBlock.trimEnd().split('\n')) ctx.ui.err(line);
    throw new FactoryError(
      'PROMOTION_UNSIGNED',
      // The payload hash belongs in the refusal: it is the *only* thing the operator has to sign, and
      // the gates layer prints it (`packages/gates/src/promotion.ts`). This path used to say just "a
      // human signature" while the runbook promised the hash, so an operator following the runbook
      // looked for a value that was not printed (found 2026-11-07, the first live promotion).
      'promotion requires a human signature' +
        (payloadToSign === null ? '' : ` over ${payloadToSign.payload}`) +
        '; none was provided and none can be synthesized. ' +
        `No artifact was written${verdictRow === null ? ', and there is no verdict to sign against either' : ''}.`,
      {
        unitId,
        gate: 'initial-production-deploy',
        signaturePayload: payloadToSign?.payload ?? null,
      },
    );
  }

  const typed = textOption(input.options, 'confirm');
  const artifactPath = join(ctx.paths.artifacts, unitId, 'promotion.yaml');
  const approvedBy = textOption(input.options, 'signedBy') ?? 'operator';
  const payload =
    verdictRow === null
      ? null
      : promotionSignaturePayload({ unitId, verdict: verdictRow.verdict, approvedBy });

  if (typed !== phrase) {
    const gateBlock = renderPromotionGate({
      unitId,
      title: unit.spec.intent.split('\n')[0]?.slice(0, 40) ?? unit.slug,
      lane: unit.lane ?? 'pending',
      verdictId: verdictRow?.verdictId ?? null,
      verdictState: verdictRow?.outcome ?? null,
      deltaText:
        verdictRow === null || verdictRow.verdict.delta.observed === null
          ? 'unknown'
          : verdictRow.verdict.delta.observed.toFixed(2),
      wallVersion: verdictRow?.wallVersion ?? null,
      holdoutRevision: verdictRow?.holdoutRevision ?? null,
      receiptId: null,
      artifactPath,
      phrase,
      firstPromotion: true,
    });
    for (const line of gateBlock.trimEnd().split('\n')) ctx.ui.err(line);
    throw new FactoryError(
      'GATE_REQUIRED',
      `GATE_REQUIRED: initial-production-deploy. ${typed === undefined ? 'No phrase was typed' : 'The phrase did not match'}; ` +
        `nothing was written. Sign by typing exactly: "${phrase}" (non-interactive: --confirm "${phrase}")`,
      {
        gate: 'initial-production-deploy',
        expectedPhrase: phrase,
        signaturePayload: payload?.payload ?? null,
      },
    );
  }

  if (verdictRow === null) {
    throw new FactoryError(
      'VERDICT_MISSING',
      `VERDICT_MISSING: ${unitId} has no verdict. Run: factory run ${unitId}`,
      { unitId },
    );
  }

  // The unmeasured-evidence gate, and the reason it sits *before* the signature
  // check: a fake wall can mint a `pass` from a JSON template, and if promotion
  // accepted it the fake would be the shortest path to a signed artifact — the one
  // control the design rests on ("a pass is earned") satisfiable by a file. Two
  // independent markers are refused here, because either one alone is a single
  // point of failure: an unmeasured reason code, and the `-fake` wall version this
  // build stamps on every fake verdict.
  //
  // Be precise about what each arm does today. The **reason** arm is currently
  // unreachable by construction: `assertVerdictIsEarned` refuses to store a `pass`
  // carrying any reason at all, so a passing verdict always arrives with `reasons: []`
  // — which is why the fake wall labels its pass with `wallVersion: '<base>-fake'`
  // instead of a caveat string. That is fine, not a hole: the arm is the guard for the
  // day a real runner can return a *labelled* pass (a pass that measured most of its
  // scenarios and honestly reported the one it could not), and removing it now would
  // mean re-deriving the rule under deadline pressure later. It costs one filter over
  // an array that is usually empty.
  const unmeasured = verdictRow.verdict.reasons.filter(isUnmeasuredReason);
  if (unmeasured.length > 0 || isFakeWall(verdictRow.wallVersion)) {
    throw new FactoryError(
      'VERDICT_UNKNOWN',
      `VERDICT_UNKNOWN: verdict ${verdictRow.verdictId} is not evidence. ` +
        `${unmeasured.length > 0 ? `It carries ${unmeasured.join(', ')}` : `It was produced by ${verdictRow.wallVersion}`}` +
        `; a pass that no scenario measured cannot promote, and there is no override. ` +
        `Re-measure with the real wall: factory run ${unitId} --verify-only`,
      {
        unitId,
        verdictId: verdictRow.verdictId,
        wallVersion: verdictRow.wallVersion,
        reasons: [...verdictRow.verdict.reasons],
      },
    );
  }
  if (verdictRow.outcome === 'unknown') {
    throw new FactoryError(
      'VERDICT_UNKNOWN',
      `VERDICT_UNKNOWN: verdict ${verdictRow.verdictId} was not measured. An unknown verdict cannot promote; ` +
        'there is no override. Restore the missing dependency, then: ' +
        `factory run ${unitId} --verify-only`,
      { unitId, verdictId: verdictRow.verdictId },
    );
  }
  if (verdictRow.outcome === 'fail') {
    throw new FactoryError(
      'VERDICT_FAILED',
      `VERDICT_FAILED: verdict ${verdictRow.verdictId} failed. Fix the unit and resubmit a new revision; ` +
        'a failed verdict cannot promote and there is no override.',
      { unitId, verdictId: verdictRow.verdictId },
    );
  }

  const receiptRow = ctx.store.latestReceiptForUnit(unitId);
  if (receiptRow === null) {
    throw new FactoryError(
      'VERDICT_MISSING',
      `VERDICT_MISSING: verdict ${verdictRow.verdictId} names receipt ${String(verdictRow.receiptId)} but no receipt ` +
        'is stored, so there is nothing to promote against. Run the unit again.',
      { unitId, verdictId: verdictRow.verdictId },
    );
  }

  const operatorKey = operatorPublicKeyPem(ctx);
  if (operatorKey === null) {
    throw new FactoryError(
      'GATE_REQUIRED',
      'GATE_REQUIRED: initial-production-deploy. No operator public key is configured, so the signature cannot be ' +
        `verified and the promotion cannot be recorded. Place it at ${join(ctx.paths.keys, 'operator.pub.pem')} ` +
        'or set FACTORY_OPERATOR_KEY to its path.',
      { gate: 'initial-production-deploy', expectedPhrase: phrase },
    );
  }

  const signedBy = textOption(input.options, 'signedBy') ?? 'operator';
  const firstPromotion = requiresHumanSignature(unitId, []);

  const artifact = buildPromotion({
    unitId,
    verdict: verdictRow.verdict,
    receipt: toDecisionReceipt(receiptRow.receipt),
    signedBy,
    signaturePem,
    operatorPublicKeyPem: operatorKey,
    promotionPath: artifactPath,
  });

  ctx.store.insertPromotion({
    promotionId: `P-${artifact.promotionSha.slice(7, 15)}`,
    unitId,
    verdictId: verdictRow.verdictId,
    verdictSha: artifact.verdictSha,
    promotionSha: artifact.promotionSha,
    signedBy,
    createdAt: ctx.nowIso(),
  });
  // `insertPromotion` already moved the unit to `promoted` and wrote the
  // `unit.promoted` event, inside the same transaction as the promotion row. Calling
  // `setUnitState` here as well was a second, illegal transition: the unit was terminal
  // by the time it ran, so every *successful* promotion threw `UNIT_ALREADY_TERMINAL`
  // after writing its artifact — the failure mode that made a real promotion impossible
  // and left the ledger claiming a promotion the caller believed had failed.

  input.emit({
    unitId,
    promotionId: `P-${artifact.promotionSha.slice(7, 15)}`,
    promotionSha: artifact.promotionSha,
    promotionPath: artifact.promotionPath,
    verdictId: verdictRow.verdictId,
    humanKeyId: artifact.humanKeyId,
    signedBy,
    wrote: artifact.written,
    firstPromotion,
    traceId: ctx.traceId,
  });

  const id = `P-${artifact.promotionSha.slice(7, 15)}`;
  ctx.ui.err(
    `PROMOTION ${id} signed ${'·'} ${artifact.promotionSha.slice(0, 15)}… ${'·'} wrote ${artifact.promotionPath}`,
  );
  ctx.ui.err(field('  apply', `git apply ${receiptRow.receipt.diff.patchFile}`));
  ctx.ui.err(field('  inspect', `factory audit ${unitId}`));
  ctx.ui.err(field('  gate', 'first-promotion-only (this was the first signing of this unit)'));
  return 0;
}

export const promoteVerb: VerbSpec = {
  name: 'promote',
  verb: 'promote',
  summary: 'Sign the first promotion of a verified unit (writes a patch + signed record)',
  arguments: ['<unitId>'],
  configure: (command) =>
    command
      .option(
        '--signature <path>',
        'the operator ed25519 signature over the promotion payload (required)',
      )
      .option(
        '--signed-by <identity>',
        'the human identity recorded in the ledger (default: operator)',
      )
      .option('--confirm <phrase>', 'the typed phrase, exactly: sign promotion <unitId>')
      .option('--verdict <verdictId>', 'pin a specific verdict (a stale one still refuses)'),
  action: runPromote,
};
