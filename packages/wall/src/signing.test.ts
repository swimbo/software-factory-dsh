/**
 * Signed verdicts: the wall is the only signer, and a verdict cannot be edited after
 * the fact.
 *
 * Note on where these tests have teeth: vitest strips types, so the structural test
 * that `EvaluateInput` has no field for a signing key is enforced by
 * `npx tsc -p packages/wall/tsconfig.json --noEmit`, not by the assertion body. That
 * is deliberate — the *type* is the control, and a runtime assertion would only be
 * checking a claim about a value. The source grep next to it is the runtime half.
 */
import { generateKeyPairSync } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import type { Verdict } from '@factory/contracts';
import type { EvaluateInput } from './evaluate.ts';
import {
  defaultKeyDir,
  generateSigningKeyPair,
  readKeyFile,
  signVerdict,
  verdictSigningPayload,
  verifyVerdict,
} from './signing.ts';

const scratch: string[] = [];
afterEach(() => {
  for (const dir of scratch.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function scratchDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'factory-signing-'));
  scratch.push(dir);
  return dir;
}

function baseVerdict(): Verdict {
  return {
    unitId: 'u-1',
    attemptId: 'a-1',
    receiptSha: 'sha256:1111111111111111111111111111111111111111111111111111111111111111',
    holdoutRevision: 'h-2026-02-01',
    policyVersion: 'wall-policy/abc123',
    wallVersion: '0.3.0',
    outcome: 'pass',
    scenarios: [
      { id: 'holdout:01', source: 'holdout', outcome: 'pass', observed: 'scenario passed' },
    ],
    delta: {
      checked: true,
      baseRate: 0.2,
      candidateRate: 1,
      threshold: 0,
      observed: 0.8,
      holdoutRevision: 'h-2026-02-01',
    },
    reasons: [],
    evaluatedAt: '2026-02-01T00:00:00.000Z',
  };
}

describe('signing a verdict', () => {
  it('signs and verifies an unmodified verdict', () => {
    const { privateKeyPem, publicKeyPem } = generateSigningKeyPair();
    const verdict = baseVerdict();

    const signature = signVerdict(verdict, privateKeyPem);

    expect(signature.length).toBeGreaterThan(0);
    expect(verifyVerdict(verdict, signature, publicKeyPem)).toBe(true);
  });

  it('rejects a verdict signed by a different key: the wall is the only signer', () => {
    const wall = generateSigningKeyPair();
    const attacker = generateSigningKeyPair();
    const verdict = baseVerdict();

    // The attacker can sign anything, including a genuine verdict, with their own
    // key — and a promotion gate holding the wall's public key must not care.
    const forged = signVerdict(verdict, attacker.privateKeyPem);

    expect(verifyVerdict(verdict, forged, wall.publicKeyPem)).toBe(false);
    // …and the attacker's own verifier would accept it, which is exactly why the
    // gate has to pin the wall's public key rather than trust whoever signed.
    expect(verifyVerdict(verdict, forged, attacker.publicKeyPem)).toBe(true);
  });

  it('rejects a verdict whose body was edited after signing', () => {
    const { privateKeyPem, publicKeyPem } = generateSigningKeyPair();
    const verdict = baseVerdict();
    const signature = signVerdict(verdict, privateKeyPem);

    const edits: Verdict[] = [
      { ...verdict, outcome: 'unknown' },
      { ...verdict, reasons: ['holdout_failed'] },
      { ...verdict, unitId: 'u-2' },
      { ...verdict, attemptId: 'a-2' },
      { ...verdict, evaluatedAt: '2026-02-01T00:00:01.000Z' },
      { ...verdict, delta: { ...verdict.delta, observed: 0.79 } },
      {
        ...verdict,
        scenarios: [
          { id: 'holdout:01', source: 'holdout', outcome: 'fail', observed: 'scenario failed' },
        ],
      },
    ];

    for (const edited of edits) {
      expect(verifyVerdict(edited, signature, publicKeyPem), JSON.stringify(edited)).toBe(false);
    }
  });

  it('returns false for a malformed signature instead of throwing', () => {
    const { publicKeyPem } = generateSigningKeyPair();
    const verdict = baseVerdict();

    // A verifier that throws turns a malformed input into an unclassified outcome.
    // Every one of these must be a clean `false`.
    for (const signature of ['', 'not base64 at all', 'AAAA', Buffer.alloc(7).toString('base64')]) {
      expect(verifyVerdict(verdict, signature, publicKeyPem)).toBe(false);
    }
  });

  it('returns false for a key that is not ed25519', () => {
    const { privateKeyPem } = generateSigningKeyPair();
    const verdict = baseVerdict();
    const signature = signVerdict(verdict, privateKeyPem);

    const notAnEd25519Key =
      '-----BEGIN PUBLIC KEY-----\nnot a real key\n-----END PUBLIC KEY-----\n';

    expect(verifyVerdict(verdict, signature, notAnEd25519Key)).toBe(false);
  });

  it('refuses to sign with a key that is not ed25519, and with unparseable key material', () => {
    const verdict = baseVerdict();

    // A real RSA key: it parses, so this exercises the algorithm check rather than
    // the PEM parser. ed25519-only is not fussiness — a verdict signed with a
    // different algorithm must not verify against the same trust anchor.
    const rsa = generateKeyPairSync('rsa', { modulusLength: 2048 });
    const rsaPem = rsa.privateKey.export({ type: 'pkcs8', format: 'pem' }).toString();
    expect(() => signVerdict(verdict, rsaPem)).toThrow(TypeError);

    // Garbage PEM throws too (from OpenSSL, not from us). Either way it fails closed
    // rather than producing a signature nobody can verify.
    expect(() =>
      signVerdict(verdict, '-----BEGIN PRIVATE KEY-----\nnope\n-----END PRIVATE KEY-----\n'),
    ).toThrow();
  });

  it('is deterministic, so an audit can compare signatures rather than merely verify them', () => {
    const { privateKeyPem } = generateSigningKeyPair();
    const verdict = baseVerdict();

    expect(signVerdict(verdict, privateKeyPem)).toBe(signVerdict(verdict, privateKeyPem));
  });

  it('covers canonical content, not key order', () => {
    const { privateKeyPem, publicKeyPem } = generateSigningKeyPair();
    const verdict = baseVerdict();
    const signature = signVerdict(verdict, privateKeyPem);

    // Same verdict, keys inserted in the opposite order. A signature over the JSON
    // text would break here; a signature over `contentHash` must not.
    const reordered = Object.fromEntries(Object.entries(verdict).reverse()) as unknown as Verdict;

    expect(verdictSigningPayload(reordered)).toBe(verdictSigningPayload(verdict));
    expect(verifyVerdict(reordered, signature, publicKeyPem)).toBe(true);
  });

  it('ignores a signature field on the verdict, so the payload cannot include its own output', () => {
    const { privateKeyPem } = generateSigningKeyPair();
    const verdict = baseVerdict();
    const withSignature = { ...verdict, signature: 'stale' } as Verdict;

    expect(verdictSigningPayload(withSignature)).toBe(verdictSigningPayload(verdict));
    expect(signVerdict(withSignature, privateKeyPem)).toBe(signVerdict(verdict, privateKeyPem));
  });

  it('reads keys from an injected path, and the default path is a convention not a hardcode', () => {
    const dir = scratchDir();
    const { privateKeyPem, publicKeyPem } = generateSigningKeyPair();
    const privatePath = join(dir, 'evaluator.ed25519');
    const publicPath = join(dir, 'evaluator.ed25519.pub');
    writeFileSync(privatePath, privateKeyPem, 'utf8');
    writeFileSync(publicPath, publicKeyPem, 'utf8');

    const verdict = baseVerdict();
    const signature = signVerdict(verdict, readKeyFile(privatePath));

    expect(verifyVerdict(verdict, signature, readKeyFile(publicPath))).toBe(true);
    expect(join(homedir(), '.factory', 'keys')).toBe(defaultKeyDir());
  });
});

describe('the signing key is unreachable from the decision path', () => {
  it('EvaluateInput has no field for a signing key', () => {
    // The control is the type: if `privateKeyPem` (or anything like it) is ever added
    // to `EvaluateInput`, this `@ts-expect-error` becomes an unused directive and
    // `tsc` fails. vitest itself does not check types, so this test is enforced by
    // `npx tsc -p packages/wall/tsconfig.json --noEmit`.
    const build = (input: EvaluateInput): EvaluateInput => ({
      ...input,
      // @ts-expect-error — the wall decides; the wall's CLI signs. No key on the input.
      privateKeyPem: '-----BEGIN PRIVATE KEY-----',
    });
    expect(build).toBeTypeOf('function');
  });

  it('evaluate.ts imports no signing code and mentions no key material', () => {
    const source = readFileSync(fileURLToPath(new URL('./evaluate.ts', import.meta.url)), 'utf8');

    // Comments are stripped first: the decision module *documents* that the CLI signs,
    // and that sentence names `signing.ts`. Scanning the code rather than the prose is
    // what makes this a real assertion instead of a grep that rewards silence.
    const code = source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');
    for (const forbidden of [
      'signing.ts',
      'signVerdict',
      'verifyVerdict',
      'privateKey',
      'publicKeyPem',
      'node:crypto',
    ]) {
      expect(code, `evaluate.ts must not reference ${forbidden} in code`).not.toContain(forbidden);
    }
    // And the decision path cannot shell out to a container runner either: execution is
    // injected, never constructed here.
    expect(code).not.toContain('child_process');
    expect(code).not.toContain('createContainerRunner');
  });
});
