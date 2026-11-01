/**
 * The credential gate: a handle and an expiry, never a secret.
 *
 * The refusals are the product here — an unscoped repo, a TTL that outlives the attempt,
 * a privileged class with no phrase — and the one assertion that matters most is the last
 * one: nothing in the returned grant, serialised, looks like a credential.
 */
import { describe, expect, it } from 'vitest';
import { FactoryError, isFactoryError } from '@factory/contracts';
import {
  MAX_CREDENTIAL_TTL_SECONDS,
  issueCredential,
  privilegedCredentialPhrase,
  type CredentialGrant,
  type IssueCredentialInput,
} from './credentials.ts';
import { GateUsageError } from './decision.ts';

const NOW = '2026-11-01T14:00:00.000Z';
const REPO = 'fixture';

function request(overrides: Partial<IssueCredentialInput> = {}): IssueCredentialInput {
  return {
    repo: REPO,
    ttlSeconds: 900,
    privileged: true,
    typedPhrase: privilegedCredentialPhrase(REPO),
    unitId: 'U-7f3a9c',
    attemptId: 'A-01',
    nowIso: NOW,
    ...overrides,
  };
}

function refusal(run: () => unknown): FactoryError {
  try {
    run();
  } catch (error) {
    if (isFactoryError(error)) return error;
    throw error;
  }
  throw new Error('expected a FactoryError, but the call returned normally');
}

/** Every string reachable in the grant, for the "no secret" sweep. */
function everyString(value: unknown, into: string[] = []): string[] {
  if (typeof value === 'string') {
    into.push(value);
  } else if (Array.isArray(value)) {
    for (const item of value) everyString(item, into);
  } else if (value !== null && typeof value === 'object') {
    for (const item of Object.values(value)) everyString(item, into);
  }
  return into;
}

describe('issueCredential — the happy path', () => {
  it('issues a privileged grant whose expiry is exactly the TTL after issuance', () => {
    const grant = issueCredential(request());

    expect(grant.grantId).toMatch(/^it_[0-9a-f]{24}$/);
    expect(grant.issuedAt).toBe(NOW);
    expect(grant.expiresAt).toBe('2026-11-01T14:15:00.000Z');
    expect(grant.scope).toEqual({ repo: REPO });
    expect(grant.ttlSeconds).toBe(900);
    expect(grant.privileged).toBe(true);
    expect(grant.decision.decision).toBe('allow');
    expect(grant.decision.reason.matchedRule).toBe('credential.privileged.typed-phrase');
    expect(grant.decision.gateDecisionId).toMatch(/^gd_[0-9a-f]{24}$/);
    expect(grant.gateDecisionId).toBe(grant.decision.gateDecisionId);
  });

  it('accepts the maximum TTL of one hour', () => {
    const grant = issueCredential(request({ ttlSeconds: MAX_CREDENTIAL_TTL_SECONDS }));
    expect(grant.expiresAt).toBe('2026-11-01T15:00:00.000Z');
  });

  it('issues an unprivileged grant without any phrase — there is no gate to close', () => {
    const grant = issueCredential(request({ privileged: false, typedPhrase: '' }));

    expect(grant.privileged).toBe(false);
    expect(grant.decision.decision).toBe('allow');
    expect(grant.decision.reason.matchedRule).toBe('credential.unprivileged.no-gate');
  });
});

describe('issueCredential — structural refusals', () => {
  it('refuses an unscoped repo', () => {
    for (const repo of ['', '   ', '*', 'a,b', 'two repos']) {
      const error = refusal(() => issueCredential(request({ repo })));
      expect(error.code).toBe('SPEC_INVALID');
      expect(error.exitCode).toBe(3);
      expect(error.details.field).toBe('repo');
      expect(error.message).toContain('Unscoped credentials do not exist');
    }
  });

  it('refuses a TTL outside (0, 3600]', () => {
    for (const ttlSeconds of [0, -5, 3601, 7200]) {
      const error = refusal(() => issueCredential(request({ ttlSeconds })));
      expect(error.code).toBe('SPEC_INVALID');
      expect(error.exitCode).toBe(3);
      expect(error.details.field).toBe('ttlSeconds');
    }
  });

  it('refuses a non-integer TTL as a usage error rather than rounding it', () => {
    expect(() => issueCredential(request({ ttlSeconds: 60.5 }))).toThrow(GateUsageError);
  });

  it('refuses a privileged class with no phrase, naming the phrase to type', () => {
    const error = refusal(() => issueCredential(request({ typedPhrase: '' })));
    expect(error.code).toBe('GATE_REQUIRED');
    expect(error.exitCode).toBe(5);
    expect(error.details.reason).toBe('phrase-absent');
    expect(error.details.expectedPhrase).toBe('issue privileged credential for fixture');
    expect(error.message).toContain('issue privileged credential for fixture');
  });

  it('refuses a wrong phrase, including one for a different repo', () => {
    const wrongRepo = refusal(() =>
      issueCredential(request({ typedPhrase: privilegedCredentialPhrase('other') })),
    );
    expect(wrongRepo.code).toBe('GATE_REQUIRED');
    expect(wrongRepo.details.reason).toBe('phrase-mismatch');

    // The phrase names the repository, so a phrase copied from another gate cannot be replayed.
    expect(privilegedCredentialPhrase('a')).not.toBe(privilegedCredentialPhrase('b'));
  });

  it('refuses a malformed injected timestamp', () => {
    expect(() => issueCredential(request({ nowIso: 'soon' }))).toThrow(GateUsageError);
  });
});

describe('issueCredential — determinism', () => {
  it('derives the same grant id for a replayed request', () => {
    const first = issueCredential(request());
    const second = issueCredential(request());
    expect(second.grantId).toBe(first.grantId);
    expect(second.expiresAt).toBe(first.expiresAt);
    expect(second).toEqual(first);
  });

  it('derives a different grant id for a different repo or TTL', () => {
    const base = issueCredential(request());
    expect(
      issueCredential(request({ repo: 'other', typedPhrase: privilegedCredentialPhrase('other') }))
        .grantId,
    ).not.toBe(base.grantId);
    expect(issueCredential(request({ ttlSeconds: 60 })).grantId).not.toBe(base.grantId);
  });

  it('moves the expiry with the injected clock, so a replay can reproduce it', () => {
    const later = issueCredential(request({ nowIso: '2026-11-01T16:00:00.000Z' }));
    expect(later.issuedAt).toBe('2026-11-01T16:00:00.000Z');
    expect(later.expiresAt).toBe('2026-11-01T16:15:00.000Z');
  });
});

describe('issueCredential — the grant carries no secret', () => {
  const SECRET_SHAPE =
    /(?:-----BEGIN [A-Z ]*PRIVATE KEY|sk-[A-Za-z0-9]{10,}|ghp_[A-Za-z0-9]{10,}|xox[bpa]-[A-Za-z0-9-]{10,}|AKIA[0-9A-Z]{12,}|Bearer\s)/;

  it('has no field named like a secret', () => {
    const grant: CredentialGrant = issueCredential(request());
    const names = Object.keys(grant).map((name) => name.toLowerCase());
    for (const name of names) {
      expect(name).not.toMatch(/token|secret|password|credential_value|value/);
    }
  });

  it('contains no token-shaped string anywhere in the serialised grant', () => {
    const grant = issueCredential(request());
    const serialised = JSON.stringify(grant);
    expect(SECRET_SHAPE.test(serialised)).toBe(false);
    for (const text of everyString(grant)) {
      expect(SECRET_SHAPE.test(text)).toBe(false);
    }
    // Only the formats this package is allowed to emit: ids, hashes, ISO instants, a repo
    // slug and a sentence.
    for (const text of everyString(grant)) {
      expect(text).toMatch(
        /^(?:it_[0-9a-f]{24}|gd_[0-9a-f]{24}|sha256:[0-9a-f]{64}|allow|ALLOW|spec-invalid|[\w.@:/-]+|.*\s.*)$/s,
      );
    }
  });
});
