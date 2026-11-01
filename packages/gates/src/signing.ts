/**
 * ed25519, the human signature.
 *
 * Every gate that a person opens is closed by a *proof of a person*, not by a flag.
 * For the promotion gate the proof is an ed25519 signature over a payload this file
 * defines (`promotionSignaturePayload`), and the gate prints exactly the bytes it will
 * accept — a signature scheme an operator cannot reproduce by hand is a signature
 * scheme that becomes a passphrase.
 *
 * Deliberate choices:
 *
 * - **Verification never throws.** A malformed PEM, a truncated signature, a key of the
 *   wrong algorithm — each returns `false`. An unparseable key is not evidence of a
 *   signature, and a gate must refuse rather than crash on bad input. (A PEM that is an
 *   ed25519 *private* key is accepted: Node derives its public half, and an operator who
 *   points the config at the wrong file gets a working gate instead of a mystery. The
 *   private part is never used by this module.)
 * - **The payload is a hash, not free text.** Signing `sha256:...` means the signed
 *   bytes are ASCII and identical on every platform, so a signature made on a Mac
 *   verifies on the CI host without normalisation rules anyone has to remember.
 * - **No key material in any return value.** The signature is public; the private key
 *   never enters this package (`ux-plan.md` §3.10: the operator key is read by the CLI).
 */
import { createPrivateKey, createPublicKey, sign, verify } from 'node:crypto';
import { sha256Hex } from '@factory/contracts';

const SIGNATURE_HEADER = '-----BEGIN SIGNATURE-----';
const SIGNATURE_FOOTER = '-----END SIGNATURE-----';

/** Wrap a binary ed25519 signature as an ASCII-armoured PEM block (64 columns, as usual). */
export function signaturePemOf(signature: Uint8Array): string {
  const base64 = Buffer.from(signature).toString('base64');
  const lines: string[] = [SIGNATURE_HEADER];
  for (let offset = 0; offset < base64.length; offset += 64) {
    lines.push(base64.slice(offset, offset + 64));
  }
  lines.push(SIGNATURE_FOOTER);
  return lines.join('\n');
}

/**
 * Accept either the armoured form or a bare base64 signature.
 *
 * The bare form exists so a signature pasted from another tool is not rejected for its
 * packaging; the armoured form is what this package writes. Anything else is `null`,
 * which callers treat as "no signature".
 */
export function signatureBytesOf(signaturePem: string): Buffer | null {
  const text = signaturePem.trim();
  if (text.length === 0) return null;
  const inner = text.startsWith(SIGNATURE_HEADER)
    ? text.slice(
        SIGNATURE_HEADER.length,
        text.endsWith(SIGNATURE_FOOTER) ? text.length - SIGNATURE_FOOTER.length : undefined,
      )
    : text;
  const base64 = inner.replace(/\s+/g, '');
  if (base64.length === 0) return null;
  try {
    const bytes = Buffer.from(base64, 'base64');
    // ed25519 signatures are exactly 64 bytes; anything else is not a signature.
    return bytes.length === 64 ? bytes : null;
  } catch {
    return null;
  }
}

/** Normalise a signature to the exact text stored in an artifact, so replays compare equal. */
export function normaliseSignature(signaturePem: string): string {
  const bytes = signatureBytesOf(signaturePem);
  if (bytes === null) throw new TypeError('signature is not armoured base64 of exactly 64 bytes');
  return signaturePemOf(bytes);
}

/**
 * Sign a payload with the operator's private key. Used by the CLI and by tests; the
 * gate itself only ever verifies.
 */
export function signPayload(payload: string, privateKeyPem: string): string {
  const key = createPrivateKey({ key: privateKeyPem, format: 'pem' });
  if (key.asymmetricKeyType !== 'ed25519') {
    throw new TypeError(`signing key is ${String(key.asymmetricKeyType)}, not ed25519`);
  }
  return signaturePemOf(sign(null, Buffer.from(payload, 'utf8'), key));
}

/** Verify a signature over `payload`. Returns `false` for every kind of bad input. */
export function verifyPayloadSignature(input: {
  readonly payload: string;
  readonly signaturePem: string;
  readonly publicKeyPem: string;
}): boolean {
  const signature = signatureBytesOf(input.signaturePem);
  if (signature === null) return false;
  try {
    const key = createPublicKey({ key: input.publicKeyPem, format: 'pem' });
    if (key.asymmetricKeyType !== 'ed25519') return false;
    return verify(null, Buffer.from(input.payload, 'utf8'), key, signature);
  } catch {
    return false;
  }
}

/**
 * A stable, short identity for a public key: `ed25519:<8 hex>` from the sha256 of the
 * key's DER encoding. This is the `human_key_id` recorded on a `Promotion`
 * (`data-map.md` §2.24) and the `ed25519:ab02…` the CLI prints.
 */
export function keyId(publicKeyPem: string): string {
  try {
    const der = createPublicKey({ key: publicKeyPem, format: 'pem' }).export({
      format: 'der',
      type: 'spki',
    });
    return `ed25519:${sha256Hex(new Uint8Array(der)).slice(0, 8)}`;
  } catch {
    throw new TypeError('operator public key is not a parsable public key');
  }
}
