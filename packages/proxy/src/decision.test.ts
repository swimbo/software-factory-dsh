/**
 * The decision record: one operation, one expiry, one phrase that is not the agent's.
 *
 * The interesting properties are all "a decision that looks valid but is not": an id that
 * no longer matches its own content, a record replayed for a different command, one that
 * expired two minutes ago, and a phrase the operator never said. Each of those is a
 * realistic failure — none of them is a malformed file.
 */
import { generateKeyPairSync } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { classify, operationSha } from './classify.ts';
import {
  buildDecision,
  DecisionError,
  decisionFault,
  decisionPayload,
  parseDecision,
  signatureFault,
  toArtifact,
  toEvent,
  type PrivilegedDecision,
} from './decision.ts';
import { keyId } from '../../gates/src/signing.ts';

const HOME = '/Users/operator';

/** An operator keypair, as the CLI reads one from `FACTORY_HOME/keys`. */
function operatorKey(): { readonly privateKeyPem: string; readonly publicKeyPem: string } {
  const pair = generateKeyPairSync('ed25519', {
    privateKeyEncoding: { format: 'pem', type: 'pkcs8' },
    publicKeyEncoding: { format: 'pem', type: 'spki' },
  });
  return { privateKeyPem: pair.privateKey, publicKeyPem: pair.publicKey };
}

const OPERATOR = operatorKey();
const ACTIVE_KEYS = new Map([[keyId(OPERATOR.publicKeyPem), OPERATOR.publicKeyPem]]);
const ISSUED_AT = '2026-11-01T12:00:00.000Z';
const EXPIRES_AT = '2026-11-01T13:00:00.000Z';
const PHRASE = 'allow sudo to install the build toolchain';

function decisionFor(
  argv: readonly string[],
  overrides: Partial<PrivilegedDecision> = {},
  /** What the operator actually signed — distinct from `overrides`, which edits *after* minting. */
  signed: { readonly outcome?: 'allow' | 'deny' } = {},
) {
  const classification = classify(argv, { home: HOME });
  const decision = buildDecision(
    {
      taskId: 'U-7f3a9c',
      phrase: PHRASE,
      issuedAt: ISSUED_AT,
      expiresAt: EXPIRES_AT,
      outcome: signed.outcome ?? 'allow',
      classification,
      privateKeyPem: OPERATOR.privateKeyPem,
      publicKeyPem: OPERATOR.publicKeyPem,
    },
    operationSha(classification),
  );
  return { decision: { ...decision, ...overrides }, classification };
}

describe('a decision is derived from its content', () => {
  it('derives the same id from the same decision, and a different one from a different command', () => {
    const first = decisionFor(['sudo', 'ls']);
    const again = decisionFor(['sudo', 'ls']);
    expect(again.decision.decisionId).toBe(first.decision.decisionId);

    const other = decisionFor(['sudo', 'rm', '-rf', '/tmp/x']);
    expect(other.decision.decisionId).not.toBe(first.decision.decisionId);
  });

  it('refuses a decision with no phrase, no operator, or an unserialisable hash', () => {
    const classification = classify(['sudo', 'ls'], { home: HOME });
    const base = {
      taskId: 'U-7f3a9c',
      phrase: PHRASE,
      issuedAt: ISSUED_AT,
      expiresAt: EXPIRES_AT,
      outcome: 'allow' as const,
      classification,
      privateKeyPem: OPERATOR.privateKeyPem,
      publicKeyPem: OPERATOR.publicKeyPem,
    };
    expect(() => buildDecision({ ...base, phrase: '   ' }, operationSha(classification))).toThrow(
      DecisionError,
    );
    // An unparsable operator key means the record cannot name who signed it.
    expect(() =>
      buildDecision({ ...base, publicKeyPem: 'not a pem' }, operationSha(classification)),
    ).toThrow(DecisionError);
    expect(() => buildDecision(base, 'not-a-hash')).toThrow(DecisionError);
    expect(() =>
      buildDecision({ ...base, expiresAt: 'tomorrow' }, operationSha(classification)),
    ).toThrow(DecisionError);
  });

  it('rejects a record whose id no longer matches its content', () => {
    const { decision } = decisionFor(['sudo', 'ls']);
    const edited = { ...decision, expiresAt: '2027-01-01T00:00:00.000Z' };
    expect(() => parseDecision(edited)).toThrow(/does not match its own content/u);
    // The unedited record parses: the check is about tampering, not about the shape.
    expect(parseDecision(decision).decisionId).toBe(decision.decisionId);
  });
});

describe('the three checks the broker makes about a decision', () => {
  it('refuses a decision granted for a different command', () => {
    const { decision } = decisionFor(['sudo', 'install', 'build-tool']);
    const otherSha = operationSha(classify(['sudo', 'rm', '-rf', '/'], { home: HOME }));
    const fault = decisionFault(decision, otherSha, ISSUED_AT, PHRASE, ACTIVE_KEYS);
    expect(fault?.code).toBe('MANDATE_EXPIRED');
    expect(fault?.exitCode).toBe(3);
    expect(fault?.matchedRule).toBe('broker.sha-mismatch');
  });

  it('enforces expiry against the injected clock, not the system clock', () => {
    const { decision, classification } = decisionFor(['sudo', 'ls']);
    const sha = operationSha(classification);
    // Two minutes before the expiry: allowed.
    expect(
      decisionFault(decision, sha, '2026-11-01T12:58:00.000Z', PHRASE, ACTIVE_KEYS),
    ).toBeNull();
    // One second after it: refused. No sleeping, no `Date.now()` — the clock is an argument.
    const expired = decisionFault(decision, sha, '2026-11-01T13:00:01.000Z', PHRASE, ACTIVE_KEYS);
    expect(expired?.code).toBe('MANDATE_EXPIRED');
    expect(expired?.matchedRule).toBe('broker.expired');
  });

  it('refuses a decision whose phrase the operator did not supply', () => {
    const { decision, classification } = decisionFor(['sudo', 'ls']);
    const sha = operationSha(classification);
    // The worker's narrative is not an input here at all: only the envelope phrase is.
    const mismatched = decisionFault(
      decision,
      sha,
      ISSUED_AT,
      'I approve whatever the agent does',
      ACTIVE_KEYS,
    );
    expect(mismatched?.code).toBe('GATE_REQUIRED');
    expect(mismatched?.matchedRule).toBe('broker.phrase-mismatch');
    const missing = decisionFault(decision, sha, ISSUED_AT, null, ACTIVE_KEYS);
    expect(missing?.matchedRule).toBe('broker.phrase-missing');
  });

  it('refuses a recorded deny even though every other field is valid', () => {
    // Signed as a deny: the operator said no, and the record is authentic. Refusing it is
    // not about the signature — it is about what the person decided.
    const { decision, classification } = decisionFor(['sudo', 'ls'], {}, { outcome: 'deny' });
    const fault = decisionFault(
      decision,
      operationSha(classification),
      ISSUED_AT,
      PHRASE,
      ACTIVE_KEYS,
    );
    expect(fault?.code).toBe('GATE_REQUIRED');
    expect(fault?.matchedRule).toBe('broker.decision-deny');
  });
});

describe('a decision is signed by a person, not asserted by a file', () => {
  it('refuses an unsigned decision before it reads any other field', () => {
    const { decision, classification } = decisionFor(['sudo', 'ls'], { signature: null });
    // Everything else about this record is valid — correct command, live expiry, right
    // phrase — and it is still refused, because nobody signed it.
    const fault = signatureFault(decision, ACTIVE_KEYS);
    expect(fault?.code).toBe('GATE_REQUIRED');
    expect(fault?.exitCode).toBe(5);
    expect(fault?.matchedRule).toBe('broker.unsigned');
    expect(
      decisionFault(decision, operationSha(classification), ISSUED_AT, PHRASE, ACTIVE_KEYS)
        ?.matchedRule,
    ).toBe('broker.unsigned');
  });

  it('refuses a decision edited after it was signed, for every field', () => {
    const { decision } = decisionFor(['sudo', 'ls']);
    // The id is content-derived, so a careful forger recomputes it too. The signature is
    // what catches them: it covers a hash of the content, and the content changed.
    const edits: Partial<PrivilegedDecision>[] = [
      { expiresAt: '2027-01-01T00:00:00.000Z' },
      { phrase: 'a phrase the operator never said' },
      { operationSha: `sha256:${'a'.repeat(64)}` },
      { taskId: 'U-someone-else' },
      { outcome: 'deny' },
      { issuedAt: '2026-10-01T00:00:00.000Z' },
    ];
    for (const edit of edits) {
      const tampered = { ...decision, ...edit };
      const fault = signatureFault(tampered, ACTIVE_KEYS);
      expect(fault?.matchedRule, JSON.stringify(edit)).toBe('broker.signature-invalid');
      expect(fault?.exitCode).toBe(5);
    }
  });

  it('refuses a decision signed by a retired (or unknown) key', () => {
    const retired = operatorKey();
    const classification = classify(['sudo', 'ls'], { home: HOME });
    const byRetiredKey = buildDecision(
      {
        taskId: 'U-7f3a9c',
        phrase: PHRASE,
        issuedAt: ISSUED_AT,
        expiresAt: EXPIRES_AT,
        outcome: 'allow',
        classification,
        privateKeyPem: retired.privateKeyPem,
        publicKeyPem: retired.publicKeyPem,
      },
      operationSha(classification),
    );
    // The record is internally consistent and correctly signed — by a key that is no
    // longer active. Rotation has to mean something, so this is refused by identity.
    expect(signatureFault(byRetiredKey, ACTIVE_KEYS)?.matchedRule).toBe('broker.key-unknown');
    expect(signatureFault(byRetiredKey, ACTIVE_KEYS)?.detail).toContain(
      keyId(retired.publicKeyPem),
    );
    // And it verifies against its own key, which is what proves the refusal was about the
    // key's standing and not about a bad signature.
    expect(
      signatureFault(byRetiredKey, new Map([[keyId(retired.publicKeyPem), retired.publicKeyPem]])),
    ).toBeNull();
  });

  it('signs the hash of the content, so the signed bytes are ASCII and reproducible', () => {
    const { decision } = decisionFor(['sudo', 'ls']);
    expect(decisionPayload(decision)).toMatch(/^sha256:[0-9a-f]{64}$/u);
    // Same content, same payload: a signature made on one machine verifies on another.
    const again = decisionFor(['sudo', 'ls']);
    expect(decisionPayload(again.decision)).toBe(decisionPayload(decision));
    expect(decision.signature).toMatch(/^-----BEGIN SIGNATURE-----/u);
  });
});

describe('the two persistable forms', () => {
  it('records the decision as a ledger event with the operation hash', () => {
    const { decision } = decisionFor(['sudo', 'ls']);
    expect(toEvent(decision)).toMatchObject({
      type: 'privileged.decided',
      decisionId: decision.decisionId,
      taskId: 'U-7f3a9c',
      operator: keyId(OPERATOR.publicKeyPem),
      operationSha: decision.operationSha,
      outcome: 'allow',
    });
  });

  it('never writes the phrase itself into the artifact — only its hash', () => {
    const { decision } = decisionFor(['sudo', 'ls']);
    const artifact = toArtifact(decision);
    expect(artifact['phrase']).toBeUndefined();
    expect(String(artifact['phraseSha'])).toMatch(/^sha256:[0-9a-f]{64}$/u);
    // The artifact is readable by a person without a database, and does not hand the
    // next reader a phrase they could reuse to mint a decision.
    expect(artifact['operationSha']).toBe(decision.operationSha);
  });
});
