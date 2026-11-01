/**
 * Scoped, expiring, revocable tokens — the worker's half of the credential boundary.
 *
 * ## The claim this file helps keep
 *
 * `README.md` says the worker never holds the gateway key. Offline that was true because
 * nothing was forwarded; live it was false, because `dsh` has to authenticate *somewhere* and
 * the adapter handed it `BIFROST_API_KEY`. This registry is what replaces that: the worker gets
 * a token that is (a) useless anywhere but this process's proxy, (b) dead at the attempt's own
 * expiry, and (c) revoked when the attempt settles. The key stays in the CLI process and in
 * the `Authorization` header this package writes upstream.
 *
 * ## Why the token is 128 bits of randomness, not a signed claim
 *
 * A signed claim would be verifiable without state, which is attractive — and wrong here,
 * because revocation is the requirement: a token that stays valid until its signature says
 * otherwise cannot be revoked on settle, only waited out. A random handle plus a registry
 * gives revocation for free and costs one map lookup per request.
 *
 * ## Time is an argument, never a process-wide clock read
 *
 * The discipline lint forbids a wall-clock read outside the allowlisted composition roots, and
 * that rule earns its keep here: expiry is the property under test, so a spec must be able to
 * say "it is now one second after expiry" without sleeping.
 */
import { randomBytes } from 'node:crypto';

/** 128 bits, base64url-encoded: 22 characters, no padding, safe in a header and a log line. */
export const TOKEN_BYTES = 16;

/** Why a presented token was refused. Distinct reasons, because each one is a different bug. */
export const TOKEN_REFUSALS = ['unknown-token', 'token-expired', 'token-revoked'] as const;
export type TokenRefusal = (typeof TOKEN_REFUSALS)[number];

export interface ScopedToken {
  /** The opaque handle the worker holds. Never logged in full by this package. */
  readonly token: string;
  /** The attempt this token authenticates. A token is not a session: it names one attempt. */
  readonly attemptId: string;
  readonly issuedAt: string;
  /** The attempt lease's expiry: the token cannot outlive the authority it borrows. */
  readonly expiresAt: string;
}

export type TokenVerdict =
  | { readonly ok: true; readonly token: ScopedToken }
  | { readonly ok: false; readonly reason: TokenRefusal; readonly detail: string };

export interface TokenRegistry {
  /** Mint a token for one attempt, expiring with the attempt's lease. */
  mint(input: {
    readonly attemptId: string;
    readonly expiresAt: string;
    readonly issuedAt: string;
  }): ScopedToken;
  /** Check a presented handle. A missing handle is `unknown-token`, never "anonymous allowed". */
  verify(presented: string | null): TokenVerdict;
  /** Revoke one token. Idempotent: settling twice is not an error. */
  revoke(token: string): boolean;
  /** Revoke every live token: what a shutdown or a panic path must do. */
  revokeAll(): number;
  /** Live/revoked counts, for `status` and for specs. */
  census(): { readonly live: number; readonly revoked: number };
}

interface Entry {
  readonly token: ScopedToken;
  revoked: boolean;
}

export function createTokenRegistry(options: { readonly now: () => string }): TokenRegistry {
  const entries = new Map<string, Entry>();

  return {
    mint(input) {
      const token = randomBytes(TOKEN_BYTES).toString('base64url');
      const scoped: ScopedToken = {
        token,
        attemptId: input.attemptId,
        issuedAt: input.issuedAt,
        expiresAt: input.expiresAt,
      };
      entries.set(token, { token: scoped, revoked: false });
      return scoped;
    },

    verify(presented) {
      if (presented === null || presented.trim() === '') {
        return {
          ok: false,
          reason: 'unknown-token',
          detail:
            'no bearer token presented; the proxy accepts only a token it minted for an attempt',
        };
      }
      const entry = entries.get(presented.trim());
      if (entry === undefined) {
        // Never echo the presented value: a request that guessed at a token must not get it
        // back in a response body that another log will copy.
        return {
          ok: false,
          reason: 'unknown-token',
          detail: 'the presented token was not minted by this proxy',
        };
      }
      // Revocation outranks expiry: a settled attempt's token is dead even if its clock has
      // not run out, and saying "expired" would misdescribe what happened.
      if (entry.revoked) {
        return {
          ok: false,
          reason: 'token-revoked',
          detail: `the token for attempt ${entry.token.attemptId} was revoked when the attempt settled`,
        };
      }
      if (options.now() >= entry.token.expiresAt) {
        return {
          ok: false,
          reason: 'token-expired',
          detail: `the token expired at ${entry.token.expiresAt}; a token cannot outlive its attempt's lease`,
        };
      }
      return { ok: true, token: entry.token };
    },

    revoke(token) {
      const entry = entries.get(token);
      if (entry === undefined || entry.revoked) return false;
      entry.revoked = true;
      return true;
    },

    revokeAll() {
      let revoked = 0;
      for (const entry of entries.values()) {
        if (entry.revoked) continue;
        entry.revoked = true;
        revoked += 1;
      }
      return revoked;
    },

    census() {
      let live = 0;
      let revoked = 0;
      const now = options.now();
      for (const entry of entries.values()) {
        if (entry.revoked || now >= entry.token.expiresAt) revoked += 1;
        else live += 1;
      }
      return { live, revoked };
    },
  };
}
