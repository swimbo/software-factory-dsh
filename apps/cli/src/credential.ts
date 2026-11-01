/**
 * Opening the model credential for one attempt — the launcher's half of the boundary.
 *
 * Before ADR-007 this was not a function: `packages/dsh-adapter` copied `BIFROST_API_KEY` into
 * the `dsh` child's environment when the operator set `FACTORY_LIVE_MODEL=1`, which made the
 * README's "the worker never holds the gateway key" false on exactly the path that spends
 * money. Here the controller reads its own key, starts a localhost proxy in front of the
 * gateway, mints one token for this attempt, and returns the proxy's URL and that token. The
 * key never leaves this process.
 *
 * The lifetime is the attempt's lease, not a constant: a token that outlives the attempt's
 * authority would let a zombie worker spend after the factory stopped owning it. `settle()`
 * revokes it, and `launch.ts` calls it in a `finally` **before** the verdict is written — the
 * verdict is the record that the attempt is over, so the credential must be dead by then.
 */
import {
  startCredentialProxy,
  type CredentialProxy,
  type PriceTable,
  type UsageTotals,
} from '@factory/credential-proxy';
import type { ErrorCode } from '@factory/contracts';

/** Fifteen minutes when no lease is readable: a clock-bounded ceiling for the fallback path. */
export const DEFAULT_CREDENTIAL_TTL_MS = 15 * 60 * 1000;

export interface AttemptCredential {
  /** `http://127.0.0.1:<port><prefix>`: what the overlay's `baseURL` gets. */
  readonly baseUrl: string;
  /** The scoped token the worker holds. Never the gateway key. */
  readonly token: string;
  readonly expiresAt: string;
  /**
   * What the gateway reported for this attempt, read *before* the token is revoked.
   *
   * `undefined` means no response was ever observed. A defined total whose `costUsd` is `null`
   * means the gateway priced nothing: that is `unknown` and must be written as such, never as
   * a measured zero.
   */
  usage(): UsageTotals | undefined;
  /**
   * Revoke the token. Idempotent, and safe to call when the launch threw: an attempt that
   * failed must not leave a live token behind, which is the whole point of revocation.
   *
   * This does **not** stop the proxy: revocation is the security property, and closing the
   * socket is bookkeeping. Keeping them apart is what makes the property testable — a
   * closed socket answers nothing, so "the token is refused" could not be observed if settle
   * also took the door down. The launcher calls {@link close} immediately after, in the same
   * `finally`, so the listener does not outlive the attempt either.
   */
  settle(): Promise<void>;
  /** Stop listening. Idempotent; all tokens are revoked first as a belt-and-braces. */
  close(): Promise<void>;
}

export type CredentialOpen =
  | { readonly ok: true; readonly credential: AttemptCredential }
  | { readonly ok: false; readonly code: ErrorCode; readonly detail: string };

export interface AttemptCredentialOptions {
  /** The **controller's** environment. Read here, never forwarded: that is the whole change. */
  readonly env: NodeJS.ProcessEnv;
  /** The controller's clock, injected so this module reads no wall clock of its own. */
  readonly nowIso: () => string;
  readonly attemptId: string;
  /**
   * The attempt lease's expiry, if a lease is readable. The token expires with it: a credential
   * must not outlive the authority it borrows.
   */
  readonly leaseExpiresAt: string | null;
  readonly defaultTtlMs?: number;
  /**
   * The attempt's remaining spend authority, in USD. When the observed cost crosses it the
   * proxy revokes the token — ND3's "enforce, do not negotiate". `undefined` means no ceiling
   * (already exhausted envelopes are refused earlier, before a credential is ever minted).
   */
  readonly spendCeilingUsd?: number | undefined;
  /** Only for a gateway that reports tokens and not prices; the observation says `estimated`. */
  readonly priceTable?: PriceTable | undefined;
  /** Called once, after the token is revoked, so the caller can record the crossing. */
  readonly onCeilingReached?: (input: {
    readonly attemptId: string;
    readonly spendUsd: number;
    readonly ceilingUsd: number;
  }) => void;
}

/**
 * Start the proxy for one attempt.
 *
 * Refuses rather than half-configures: a key with no upstream (or the reverse) is a
 * provisioning mistake, and a worker that starts without a credential fails later, inside
 * `dsh`, as an unexplained 401 that looks like a product fault. Refusing here names the
 * variable.
 */
export async function openAttemptCredential(
  options: AttemptCredentialOptions,
): Promise<CredentialOpen> {
  const upstream = (options.env['FACTORY_PROXY_BASE_URL'] ?? '').trim();
  const apiKey = (options.env['BIFROST_API_KEY'] ?? '').trim();
  if (upstream === '') {
    return {
      ok: false,
      code: 'EXECUTOR_UNAVAILABLE',
      detail:
        'a live model run needs FACTORY_PROXY_BASE_URL (the gateway the credential proxy fronts)',
    };
  }
  if (apiKey === '') {
    return {
      ok: false,
      code: 'EXECUTOR_UNAVAILABLE',
      detail:
        'a live model run needs BIFROST_API_KEY in the controller environment; it is read here ' +
        'and injected by the proxy, never forwarded to the worker',
    };
  }
  let parsed: URL;
  try {
    parsed = new URL(upstream);
  } catch {
    return {
      ok: false,
      code: 'EXECUTOR_UNAVAILABLE',
      detail: `FACTORY_PROXY_BASE_URL is not a URL: ${JSON.stringify(upstream)}`,
    };
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    return {
      ok: false,
      code: 'EXECUTOR_UNAVAILABLE',
      detail: `FACTORY_PROXY_BASE_URL must be http or https, not ${parsed.protocol}`,
    };
  }

  const now = options.nowIso();
  const ttlMs = options.defaultTtlMs ?? DEFAULT_CREDENTIAL_TTL_MS;
  const fallback = new Date(Date.parse(now) + ttlMs).toISOString();
  const leaseExpiry = options.leaseExpiresAt;
  if (leaseExpiry !== null && leaseExpiry <= now) {
    return {
      ok: false,
      code: 'EXECUTOR_UNAVAILABLE',
      detail: `the attempt lease expired at ${leaseExpiry}; a credential minted now would be dead on arrival`,
    };
  }
  const expiresAt = leaseExpiry ?? fallback;

  const proxy: CredentialProxy = await startCredentialProxy({
    upstream: { baseUrl: upstream, apiKey },
    now: options.nowIso,
    ...(options.spendCeilingUsd === undefined ? {} : { spendCeilingUsd: options.spendCeilingUsd }),
    ...(options.priceTable === undefined ? {} : { priceTable: options.priceTable }),
    ...(options.onCeilingReached === undefined
      ? {}
      : { onCeilingReached: options.onCeilingReached }),
  });
  const minted = proxy.tokens.mint({
    attemptId: options.attemptId,
    issuedAt: now,
    expiresAt,
  });
  let settled = false;
  return {
    ok: true,
    credential: {
      baseUrl: proxy.baseUrl,
      token: minted.token,
      expiresAt,
      usage() {
        return proxy.usageFor(minted.token);
      },
      async settle() {
        if (settled) return;
        settled = true;
        // Revoked, not merely forgotten: the entry stays in the registry so a late request is
        // answered `token-revoked` (401) rather than `unknown-token` — the honest reason.
        proxy.tokens.revoke(minted.token);
      },
      async close() {
        await proxy.close();
      },
    },
  };
}
