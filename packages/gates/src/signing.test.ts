/**
 * ed25519 helpers: the properties a gate relies on, stated as tests.
 *
 * Two of these are security properties rather than conveniences: a signature does not
 * verify under a different key, and a signature does not verify over different bytes. If
 * either stopped holding, the promotion gate would be a formality.
 */
import { generateKeyPairSync } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  keyId,
  normaliseSignature,
  signPayload,
  signatureBytesOf,
  signaturePemOf,
  verifyPayloadSignature,
} from './signing.ts';
import { IMPOSTOR, OPERATOR } from '../test-support/keys.ts';

const PAYLOAD = 'sha256:0000000000000000000000000000000000000000000000000000000000000000';

describe('sign and verify', () => {
  it('round-trips a signature made by the operator', () => {
    const signature = signPayload(PAYLOAD, OPERATOR.privateKeyPem);
    expect(signature.startsWith('-----BEGIN SIGNATURE-----\n')).toBe(true);
    expect(signature.endsWith('-----END SIGNATURE-----')).toBe(true);
    expect(
      verifyPayloadSignature({
        payload: PAYLOAD,
        signaturePem: signature,
        publicKeyPem: OPERATOR.publicKeyPem,
      }),
    ).toBe(true);
  });

  it('does not verify under a different key', () => {
    const signature = signPayload(PAYLOAD, IMPOSTOR.privateKeyPem);
    expect(
      verifyPayloadSignature({
        payload: PAYLOAD,
        signaturePem: signature,
        publicKeyPem: OPERATOR.publicKeyPem,
      }),
    ).toBe(false);
  });

  it('does not verify over different bytes, even by one character', () => {
    const signature = signPayload(PAYLOAD, OPERATOR.privateKeyPem);
    const tampered = `${PAYLOAD.slice(0, -1)}1`;
    expect(
      verifyPayloadSignature({
        payload: tampered,
        signaturePem: signature,
        publicKeyPem: OPERATOR.publicKeyPem,
      }),
    ).toBe(false);
  });

  it('is deterministic: the same payload and key produce the same signature', () => {
    expect(signPayload(PAYLOAD, OPERATOR.privateKeyPem)).toBe(
      signPayload(PAYLOAD, OPERATOR.privateKeyPem),
    );
  });
});

describe('verification refuses rather than throws', () => {
  it.each([
    { label: 'an empty signature', signaturePem: '' },
    { label: 'prose', signaturePem: 'signed by me, promise' },
    { label: 'a truncated base64 blob', signaturePem: 'A'.repeat(43) },
    { label: 'a private key in the signature slot', signaturePem: OPERATOR.privateKeyPem },
  ])('returns false for $label', ({ signaturePem }) => {
    expect(() =>
      verifyPayloadSignature({
        payload: PAYLOAD,
        signaturePem,
        publicKeyPem: OPERATOR.publicKeyPem,
      }),
    ).not.toThrow();
    expect(
      verifyPayloadSignature({
        payload: PAYLOAD,
        signaturePem,
        publicKeyPem: OPERATOR.publicKeyPem,
      }),
    ).toBe(false);
  });

  it('returns false for an unparsable public key', () => {
    const signature = signPayload(PAYLOAD, OPERATOR.privateKeyPem);
    expect(
      verifyPayloadSignature({
        payload: PAYLOAD,
        signaturePem: signature,
        publicKeyPem: 'not a key',
      }),
    ).toBe(false);
  });

  it('returns false for a key of the wrong algorithm', () => {
    const { publicKey } = generateKeyPairSync('ec', { namedCurve: 'P-256' });
    const signature = signPayload(PAYLOAD, OPERATOR.privateKeyPem);
    expect(
      verifyPayloadSignature({
        payload: PAYLOAD,
        signaturePem: signature,
        publicKeyPem: publicKey.export({ format: 'pem', type: 'spki' }).toString(),
      }),
    ).toBe(false);
  });
});

describe('signature encoding', () => {
  it('wraps the armoured form at 64 columns and decodes back to the same bytes', () => {
    const bytes = Buffer.alloc(64, 7);
    const pem = signaturePemOf(bytes);
    const lines = pem.split('\n');
    expect(lines).toHaveLength(4);
    for (const line of lines.slice(1, -1)) expect(line.length).toBeLessThanOrEqual(64);
    expect(signatureBytesOf(pem)?.equals(bytes)).toBe(true);
  });

  it('accepts the bare base64 form, so a signature from another tool still verifies', () => {
    const signature = signPayload(PAYLOAD, OPERATOR.privateKeyPem);
    const bare = Buffer.from(signatureBytesOf(signature) ?? Buffer.alloc(0)).toString('base64');
    expect(
      verifyPayloadSignature({
        payload: PAYLOAD,
        signaturePem: bare,
        publicKeyPem: OPERATOR.publicKeyPem,
      }),
    ).toBe(true);
  });

  it('normalises the bare form to the armoured one, and the normalised form still verifies', () => {
    const signature = signPayload(PAYLOAD, OPERATOR.privateKeyPem);
    const bare = Buffer.from(signatureBytesOf(signature) ?? Buffer.alloc(0)).toString('base64');
    const normalised = normaliseSignature(bare);
    expect(normalised).toBe(normaliseSignature(signature));
    expect(
      verifyPayloadSignature({
        payload: PAYLOAD,
        signaturePem: normalised,
        publicKeyPem: OPERATOR.publicKeyPem,
      }),
    ).toBe(true);
  });

  it('rejects a blob that is not 64 bytes, which is the only valid ed25519 signature length', () => {
    expect(signatureBytesOf(Buffer.alloc(63, 1).toString('base64'))).toBeNull();
    expect(signatureBytesOf(Buffer.alloc(65, 1).toString('base64'))).toBeNull();
    expect(() => normaliseSignature('A'.repeat(43))).toThrow(TypeError);
  });
});

describe('keyId', () => {
  it('is a stable ed25519 fingerprint, not a key', () => {
    const id = keyId(OPERATOR.publicKeyPem);
    expect(id).toMatch(/^ed25519:[0-9a-f]{8}$/);
    expect(keyId(OPERATOR.publicKeyPem)).toBe(id);
    expect(keyId(IMPOSTOR.publicKeyPem)).not.toBe(id);
    // It must not be derivable from, or contain, the key material itself.
    expect(id).not.toContain('BEGIN');
  });

  it('refuses an unparsable key', () => {
    expect(() => keyId('-----BEGIN PUBLIC KEY-----\nnope\n-----END PUBLIC KEY-----')).toThrow(
      TypeError,
    );
  });
});
