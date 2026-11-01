/**
 * The promotion gate: the artifact is a signature or it does not exist.
 *
 * Every refusal case asserts the *absence* of the file as well as the code, because the
 * expensive failure here is not "the gate said no" — it is "the gate said no and left a
 * plausible-looking `promotion.yaml` behind". The idempotency case asserts byte equality,
 * which is the only definition of "same promotion" that survives a restart.
 */
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  FactoryError,
  contentHash,
  type DecisionReceipt,
  type VerdictType,
} from '@factory/contracts';
import {
  PROMOTION_FORMAT,
  buildPromotion,
  promotionSignaturePayload,
  requiresHumanSignature,
  type PromotionInput,
} from './promotion.ts';
import { keyId, signPayload } from './signing.ts';
import { IMPOSTOR, OPERATOR } from '../test-support/keys.ts';

const UNIT = 'U-7f3a9c';
const ATTEMPT = 'A-01';

function makeReceipt(overrides: Partial<DecisionReceipt> = {}): DecisionReceipt {
  return {
    unitId: UNIT,
    attemptId: ATTEMPT,
    sessionId: 'sess-0001',
    startedAt: '2026-11-01T10:00:00.000Z',
    endedAt: '2026-11-01T10:12:00.000Z',
    exitCode: 0,
    diff: {
      patchFile: 'change.patch',
      sha: `sha256:${'3'.repeat(64)}`,
      filesChanged: 2,
      insertions: 38,
      deletions: 4,
      baseRev: '0123456789abcdef0123456789abcdef01234567',
    },
    commands: [],
    suite: {
      command: ['pnpm', 'test'],
      exitCode: 0,
      passed: 12,
      failed: 0,
      skipped: 0,
      unknown: 0,
    },
    ceilings: { turnsUsed: 9, wallClockMs: 720_000, hit: [] },
    artifacts: [],
    ...overrides,
  };
}

function makeVerdict(overrides: Partial<VerdictType> = {}): VerdictType {
  return {
    unitId: UNIT,
    attemptId: ATTEMPT,
    receiptSha: `sha256:${'4'.repeat(64)}`,
    holdoutRevision: 'h-88f1',
    policyVersion: 'q-2026.11.1',
    wallVersion: 'wall/0.1.0',
    outcome: 'pass',
    scenarios: [
      { id: 'items-page-two', source: 'acceptance', outcome: 'pass', observed: 'exit 0, 3 items' },
    ],
    delta: {
      checked: true,
      baseRate: 0.5,
      candidateRate: 0.5,
      threshold: 0,
      observed: 0,
      holdoutRevision: 'h-88f1',
    },
    reasons: [],
    evaluatedAt: '2026-11-01T11:00:00.000Z',
    ...overrides,
  };
}

/** A signature the gate will accept: over the exact payload the gate publishes. */
function signedByOperator(verdict: VerdictType, approvedBy = 'operator@host'): string {
  const { payload } = promotionSignaturePayload({ unitId: UNIT, verdict, approvedBy });
  return signPayload(payload, OPERATOR.privateKeyPem);
}

let dir = '';
let promotionPath = '';

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'gates-promotion-'));
  promotionPath = join(dir, 'promotion.yaml');
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

function input(overrides: Partial<PromotionInput> = {}): PromotionInput {
  const verdict = overrides.verdict ?? makeVerdict();
  return {
    unitId: UNIT,
    verdict,
    receipt: makeReceipt(),
    signedBy: 'operator@host',
    signaturePem: signedByOperator(verdict),
    operatorPublicKeyPem: OPERATOR.publicKeyPem,
    promotionPath,
    ...overrides,
  };
}

function refusal(run: () => unknown): FactoryError {
  try {
    run();
  } catch (error) {
    if (error instanceof FactoryError) return error;
    throw error;
  }
  throw new Error('expected a FactoryError, but the call returned normally');
}

describe('buildPromotion — the happy path', () => {
  it('writes a signed artifact whose fields are all re-derivable', () => {
    const verdict = makeVerdict();
    const artifact = buildPromotion(input({ verdict }));

    expect(artifact.written).toBe(true);
    expect(artifact.promotionSha).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(artifact.humanKeyId).toBe(keyId(OPERATOR.publicKeyPem));
    expect(artifact.decision.decision).toBe('allow');
    expect(artifact.decision.gateKind).toBe('promotion');
    expect(artifact.decision.gateDecisionId).toMatch(/^gd_[0-9a-f]{24}$/);

    const text = readFileSync(promotionPath, 'utf8');
    expect(text).toBe(artifact.content);
    expect(text).toContain(`promotion_format: ${JSON.stringify(PROMOTION_FORMAT)}`);
    expect(text).toContain(`unit_id: ${JSON.stringify(UNIT)}`);
    expect(text).toContain(`verdict_sha: ${JSON.stringify(contentHash(verdict))}`);
    expect(text).toContain('verdict_outcome: "pass"');
    expect(text).toContain(`approved_by: ${JSON.stringify('operator@host')}`);
    expect(text).toContain(`promotion_sha: ${JSON.stringify(artifact.promotionSha)}`);
    // The signature is a readable block scalar, not an escaped one-liner.
    expect(text).toContain('signature: |');
    expect(text).toContain('  -----BEGIN SIGNATURE-----');
  });

  it('echoes the wall\'s "not certifiable" flag into the artifact', () => {
    const uncertified = buildPromotion(
      input({ verdict: makeVerdict({ promotionRequiresHumanSignature: true }) }),
    );
    expect(uncertified.content).toContain('promotion_requires_human_signature: true');

    const certified = buildPromotion(input({ promotionPath: join(dir, 'certified.yaml') }));
    expect(certified.content).toContain('promotion_requires_human_signature: false');
    expect(uncertified.promotionSha).not.toBe(certified.promotionSha);
  });

  it('refuses the flag on a non-pass verdict, because the wall never sets it there', () => {
    const verdict = makeVerdict({
      outcome: 'fail',
      promotionRequiresHumanSignature: true,
      scenarios: [
        { id: 'items-page-two', source: 'acceptance', outcome: 'fail', observed: '1 item' },
      ],
      reasons: ['suite_failed'],
    });
    const error = refusal(() => buildPromotion(input({ verdict })));
    expect(error.code).toBe('RECEIPT_CONFLICT');
    expect(error.details.reason).toBe('inconsistent-verdict-flag');
    expect(existsSync(promotionPath)).toBe(false);
  });

  it('writes the artifact readable by the operator only, and leaves no temporary file', () => {
    buildPromotion(input());
    expect(statSync(promotionPath).mode & 0o777).toBe(0o600);
    expect(readdirSync(dir)).toEqual(['promotion.yaml']);
  });

  it('is deterministic: the same verdict and signature produce byte-identical artifacts', () => {
    const first = buildPromotion(input());
    const secondDir = mkdtempSync(join(tmpdir(), 'gates-promotion-'));
    try {
      const second = buildPromotion(input({ promotionPath: join(secondDir, 'promotion.yaml') }));
      expect(second.content).toBe(first.content);
      expect(second.promotionSha).toBe(first.promotionSha);
      expect(second.decision.decisionHash).toBe(first.decision.decisionHash);
    } finally {
      rmSync(secondDir, { recursive: true, force: true });
    }
  });

  it('treats a replay of the same promotion as idempotent: same sha, no rewrite', () => {
    const first = buildPromotion(input());
    const before = readFileSync(promotionPath, 'utf8');

    const replay = buildPromotion(input());

    expect(replay.written).toBe(false);
    expect(replay.promotionSha).toBe(first.promotionSha);
    expect(replay.content).toBe(before);
    expect(readFileSync(promotionPath, 'utf8')).toBe(before);
    expect(readdirSync(dir)).toEqual(['promotion.yaml']);
  });
});

describe('buildPromotion — refusals write nothing at all', () => {
  it('refuses without a signature and leaves no artifact, not even a draft', () => {
    const error = refusal(() => buildPromotion(input({ signaturePem: '' })));
    expect(error.code).toBe('PROMOTION_UNSIGNED');
    expect(error.exitCode).toBe(5);
    expect(error.details.reason).toBe('signature-absent');
    expect(existsSync(promotionPath)).toBe(false);
    expect(readdirSync(dir)).toEqual([]);
  });

  it('refuses a signature made by the wrong key, naming the payload that was refused', () => {
    const verdict = makeVerdict();
    const { payload } = promotionSignaturePayload({
      unitId: UNIT,
      verdict,
      approvedBy: 'operator@host',
    });
    const forged = signPayload(payload, IMPOSTOR.privateKeyPem);

    const error = refusal(() => buildPromotion(input({ verdict, signaturePem: forged })));
    expect(error.code).toBe('PROMOTION_UNSIGNED');
    expect(error.details.reason).toBe('signature-invalid');
    expect(error.details.signaturePayload).toBe(payload);
    expect(existsSync(promotionPath)).toBe(false);
  });

  it('refuses a signature over a different unit, so a signature cannot be lifted', () => {
    const verdict = makeVerdict();
    const { payload } = promotionSignaturePayload({
      unitId: 'U-other',
      verdict,
      approvedBy: 'operator@host',
    });
    const lifted = signPayload(payload, OPERATOR.privateKeyPem);
    const error = refusal(() => buildPromotion(input({ verdict, signaturePem: lifted })));
    expect(error.code).toBe('PROMOTION_UNSIGNED');
    expect(existsSync(promotionPath)).toBe(false);
  });

  it('refuses a fail verdict with VERDICT_FAILED', () => {
    const verdict = makeVerdict({
      outcome: 'fail',
      scenarios: [
        { id: 'items-page-two', source: 'acceptance', outcome: 'fail', observed: '1 item' },
      ],
      reasons: ['suite_failed'],
    });
    const error = refusal(() => buildPromotion(input({ verdict })));
    expect(error.code).toBe('VERDICT_FAILED');
    expect(error.exitCode).toBe(3);
    expect(existsSync(promotionPath)).toBe(false);
  });

  it('refuses an unknown verdict with VERDICT_UNKNOWN — unknown is not a pass', () => {
    const verdict = makeVerdict({
      outcome: 'unknown',
      scenarios: [{ id: 'holdout', source: 'holdout', outcome: 'unknown', observed: null }],
      delta: {
        checked: false,
        baseRate: null,
        candidateRate: null,
        threshold: 0,
        observed: null,
        holdoutRevision: 'h-88f1',
      },
      reasons: ['holdout_unavailable'],
    });
    const error = refusal(() => buildPromotion(input({ verdict })));
    expect(error.code).toBe('VERDICT_UNKNOWN');
    expect(error.exitCode).toBe(5);
    expect(existsSync(promotionPath)).toBe(false);
  });

  it('refuses a pass that cannot show its measurement (a vacuous pass)', () => {
    const verdict = makeVerdict({
      delta: {
        checked: false,
        baseRate: null,
        candidateRate: null,
        threshold: 0,
        observed: null,
        holdoutRevision: 'h-88f1',
      },
    });
    const error = refusal(() => buildPromotion(input({ verdict })));
    expect(error.code).toBe('RECEIPT_CONFLICT');
    expect(error.details.reason).toBe('verdict-not-earned');
    expect(existsSync(promotionPath)).toBe(false);
  });

  it('refuses a verdict produced under an older holdout revision, and says how to re-verify', () => {
    const error = refusal(() => buildPromotion(input({ currentHoldoutRevision: 'h-90c2' })));
    expect(error.code).toBe('VERDICT_STALE');
    expect(error.exitCode).toBe(5);
    expect(error.details.reason).toBe('holdout-revision-changed');
    expect(error.message).toContain('h-88f1');
    expect(error.message).toContain('--verify-only');
    expect(existsSync(promotionPath)).toBe(false);
  });

  it('refuses a verdict produced under an older policy version', () => {
    const error = refusal(() => buildPromotion(input({ currentPolicyVersion: 'q-2026.12.1' })));
    expect(error.code).toBe('VERDICT_STALE');
    expect(error.details.reason).toBe('policy-version-changed');
  });

  it('promotes when the caller confirms the revisions still match', () => {
    const artifact = buildPromotion(
      input({ currentHoldoutRevision: 'h-88f1', currentPolicyVersion: 'q-2026.11.1' }),
    );
    expect(artifact.written).toBe(true);
  });

  it('refuses a verdict that belongs to another unit', () => {
    const verdict = makeVerdict({ unitId: 'U-other' });
    const error = refusal(() => buildPromotion(input({ verdict })));
    expect(error.code).toBe('RECEIPT_CONFLICT');
    expect(error.details.reason).toBe('verdict-unit-mismatch');
  });

  it('refuses a receipt for another attempt than the verdict describes', () => {
    const error = refusal(() =>
      buildPromotion(input({ receipt: makeReceipt({ attemptId: 'A-02' }) })),
    );
    expect(error.code).toBe('RECEIPT_CONFLICT');
    expect(error.details.reason).toBe('receipt-verdict-attempt-mismatch');
  });

  it('never overwrites a different promotion at the same path', () => {
    buildPromotion(input());
    const original = readFileSync(promotionPath, 'utf8');

    const other = makeVerdict({ attemptId: 'A-02' });
    const error = refusal(() =>
      buildPromotion(input({ verdict: other, receipt: makeReceipt({ attemptId: 'A-02' }) })),
    );
    expect(error.code).toBe('RECEIPT_CONFLICT');
    expect(error.details.reason).toBe('promotion-artifact-conflict');
    expect(readFileSync(promotionPath, 'utf8')).toBe(original);
  });

  it('refuses a missing unit id, human identity or path as a usage error', () => {
    expect(() => buildPromotion(input({ unitId: '  ' }))).toThrow(/unit id/);
    expect(() => buildPromotion(input({ signedBy: '' }))).toThrow(/signed-by/);
    expect(() => buildPromotion(input({ promotionPath: '' }))).toThrow(/promotion-path/);
  });
});

describe('promotionSignaturePayload', () => {
  it('signs a hash of the unit, the verdict and the approving human', () => {
    const verdict = makeVerdict();
    const first = promotionSignaturePayload({ unitId: UNIT, verdict, approvedBy: 'operator@host' });
    expect(first.payload).toBe(
      contentHash({ unitId: UNIT, verdictSha: contentHash(verdict), approvedBy: 'operator@host' }),
    );
    expect(first.signaturePayloadSha).toMatch(/^sha256:[0-9a-f]{64}$/);

    const otherSigner = promotionSignaturePayload({
      unitId: UNIT,
      verdict,
      approvedBy: 'someone@else',
    });
    expect(otherSigner.payload).not.toBe(first.payload);
    expect(otherSigner.verdictSha).toBe(first.verdictSha);

    const otherVerdict = promotionSignaturePayload({
      unitId: UNIT,
      verdict: makeVerdict({ attemptId: 'A-02' }),
      approvedBy: 'operator@host',
    });
    expect(otherVerdict.payload).not.toBe(first.payload);
  });
});

describe('requiresHumanSignature', () => {
  const signed = {
    unitId: UNIT,
    promotionSha: `sha256:${'5'.repeat(64)}`,
    verdictSha: `sha256:${'6'.repeat(64)}`,
    approvedBy: 'operator@host',
    signaturePem: '-----BEGIN SIGNATURE-----\nx\n-----END SIGNATURE-----',
  };

  it('is required when the unit has never been promoted', () => {
    expect(requiresHumanSignature(UNIT, [])).toBe(true);
  });

  it('is required when the only prior promotion is unsigned', () => {
    expect(requiresHumanSignature(UNIT, [{ ...signed, signaturePem: '' }])).toBe(true);
  });

  it('is not required once a signed promotion of this unit exists', () => {
    expect(requiresHumanSignature(UNIT, [signed])).toBe(false);
  });

  it('is still required for a different unit', () => {
    expect(requiresHumanSignature('U-other', [signed])).toBe(true);
  });

  it('is required when the wall says the verdict verified but is not certifiable', () => {
    expect(requiresHumanSignature(UNIT, [signed], { verdictRequiresHumanSignature: true })).toBe(
      true,
    );
    expect(requiresHumanSignature(UNIT, [signed], { verdictRequiresHumanSignature: false })).toBe(
      false,
    );
    expect(requiresHumanSignature(UNIT, [signed], {})).toBe(false);
  });
});
