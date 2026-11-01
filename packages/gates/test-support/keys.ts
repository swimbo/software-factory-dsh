/**
 * Deterministic ed25519 key pairs for the gate tests.
 *
 * Derived from fixed 32-byte seeds rather than committed as PEM. The reason is
 * psychological as much as technical: a repository that contains a private key — even a
 * labelled test one — teaches every future reader that private keys live in repositories.
 * This way there is no PEM constant to copy, and the fixture key is reproducible byte for
 * byte on every run, so a signature made by one test run verifies in the next.
 *
 * These keys are **not secrets**. The seeds are public, the keys are never written to
 * disk, and nothing outside `packages/gates` may import this file. Real operator keys are
 * read by the CLI from `~/.factory/keys/` and never pass through this package.
 */
import { createPrivateKey, createPublicKey } from 'node:crypto';

export interface TestKeyPair {
  readonly privateKeyPem: string;
  readonly publicKeyPem: string;
}

/** ASN.1 PKCS#8 prefix for ed25519: header, then the raw 32-byte seed. */
const PKCS8_ED25519_PREFIX = Buffer.from('302e020100300506032b657004220420', 'hex');

function keyPairFromSeedHex(seedHex: string): TestKeyPair {
  const seed = Buffer.from(seedHex, 'hex');
  if (seed.length !== 32) {
    throw new Error(`test seed must be 32 bytes, got ${String(seed.length)}`);
  }
  const privateKey = createPrivateKey({
    key: Buffer.concat([PKCS8_ED25519_PREFIX, seed]),
    format: 'der',
    type: 'pkcs8',
  });
  return {
    privateKeyPem: privateKey.export({ format: 'pem', type: 'pkcs8' }).toString(),
    publicKeyPem: createPublicKey(privateKey).export({ format: 'pem', type: 'spki' }).toString(),
  };
}

/** The operator whose signature the gate trusts in these tests. */
export const OPERATOR: TestKeyPair = keyPairFromSeedHex('a1'.repeat(32));

/** A second, untrusted key: the "wrong key" every gate must refuse. */
export const IMPOSTOR: TestKeyPair = keyPairFromSeedHex('b2'.repeat(32));
