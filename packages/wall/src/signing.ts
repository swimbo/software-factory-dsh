/**
 * Signed verdicts.
 *
 * A verdict is the factory's only statement that work is done, so it has to be
 * attributable. An unsigned verdict is a claim that anyone who can write to the
 * verdict store can forge — including, in a bad week, an executor process that
 * shares a mount with the store. Signing does not make the wall *correct*; it makes
 * the wall's output *non-repudiable*, which is the property the promotion gate
 * actually needs: "did the evaluator say this, about this receipt, under this
 * policy?"
 *
 * Three rules this file enforces:
 *
 * 1. **The signature covers the canonical content hash**, not the JSON text. Two
 *    serializations of the same verdict (different key order, different whitespace)
 *    must verify identically, because the signature is over a *decision*, not over
 *    a formatting choice. `contentHash` from the contract is the one canonical form.
 * 2. **The wall is the only signer.** This module is imported by the wall's CLI and
 *    by nothing in the decision path. `evaluate()` cannot sign and cannot see a key
 *    — there is no field on `EvaluateInput` for one, and `evaluate.ts` does not
 *    import this file. `signing.test.ts` asserts both, one of them at type level.
 * 3. **Verification never throws.** An unreadable signature, a truncated one, or a
 *    key that is not ed25519 all return `false`. A verifier that throws on garbage
 *    is a verifier that turns a malformed input into an unclassified outcome, and
 *    the factory's rule is that only classified outcomes may decide anything.
 */
import { createPrivateKey, createPublicKey, generateKeyPairSync, sign, verify } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { contentHash, type Verdict } from '@factory/contracts';

/** Where the operator's keys live. A convenience for the CLI; never used implicitly by signing. */
export function defaultKeyDir(): string {
  return join(homedir(), '.factory', 'keys');
}

/** The operator-facing key filenames, so the CLI and the docs cannot drift apart. */
export const EVALUATOR_PRIVATE_KEY_FILE = 'evaluator.ed25519';
export const EVALUATOR_PUBLIC_KEY_FILE = 'evaluator.ed25519.pub';

/** A PEM read from disk. Kept as a function so tests can prove "keys come from files". */
export function readKeyFile(path: string): string {
  return readFileSync(path, 'utf8');
}

/**
 * The exact bytes a signature covers: the canonical content hash of the verdict,
 * with any `signature` field removed.
 *
 * The strip matters even though `Verdict` has no signature field today: the signed
 * envelope is almost certainly going to grow one, and a signing routine that
 * silently includes its own output would produce a signature that can never be
 * reproduced.
 */
export function verdictSigningPayload(verdict: Verdict): string {
  const { signature, ...rest } = verdict as Verdict & { readonly signature?: string };
  void signature;
  return contentHash(rest);
}

/**
 * Sign a verdict with the evaluator's ed25519 private key. Returns base64.
 *
 * ed25519 signatures are deterministic: the same verdict and the same key always
 * produce the same signature, which is what lets a re-derivation be compared
 * byte-for-byte in an audit rather than merely "verified".
 */
export function signVerdict(verdict: Verdict, privateKeyPem: string): string {
  const key = createPrivateKey(privateKeyPem);
  if (key.asymmetricKeyType !== 'ed25519') {
    throw new TypeError(
      `signVerdict requires an ed25519 key, got ${String(key.asymmetricKeyType)}`,
    );
  }
  const payload = verdictSigningPayload(verdict);
  return sign(null, Buffer.from(payload, 'utf8'), key).toString('base64');
}

/**
 * Verify a verdict's signature against the evaluator's public key.
 *
 * Returns `false` for every failure — wrong key, edited body, malformed signature,
 * non-ed25519 key, unparseable PEM. Callers must treat `false` as "not attributable"
 * and therefore as not promoting; there is no third answer here.
 */
export function verifyVerdict(verdict: Verdict, signature: string, publicKeyPem: string): boolean {
  if (typeof signature !== 'string' || signature.length === 0) return false;
  let payload: string;
  try {
    payload = verdictSigningPayload(verdict);
  } catch {
    return false;
  }
  try {
    const key = createPublicKey(publicKeyPem);
    if (key.asymmetricKeyType !== 'ed25519') return false;
    const bytes = Buffer.from(signature, 'base64');
    if (bytes.length === 0) return false;
    return verify(null, Buffer.from(payload, 'utf8'), key, bytes);
  } catch {
    return false;
  }
}

/**
 * A fresh ed25519 keypair, as PEMs.
 *
 * Exists so the CLI's `keys init` path and the tests use the same generation code.
 * The private key is never logged, never returned in a verdict, and never written
 * anywhere but the path the operator chose.
 */
export function generateSigningKeyPair(): { privateKeyPem: string; publicKeyPem: string } {
  const { privateKey, publicKey } = generateKeyPairSync('ed25519');
  return {
    privateKeyPem: privateKey.export({ type: 'pkcs8', format: 'pem' }).toString(),
    publicKeyPem: publicKey.export({ type: 'spki', format: 'pem' }).toString(),
  };
}
