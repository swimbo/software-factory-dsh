/**
 * The credential proxy's public surface.
 *
 * The claim it makes true: **the worker process never holds the gateway key.** It holds a
 * token that this process minted, for one attempt, for one upstream prefix, for the life of
 * the attempt's lease — and the key is written into the upstream `Authorization` header by
 * this package and nowhere else.
 *
 * Five lines of threat model, repeated here because a reader of a package's index should not
 * have to open `server.ts` to find out what is *not* claimed:
 *
 *   1. a worker that reads its own environment gets the scoped token, not the key;
 *   2. the token is bounded in lifetime, confined to one path prefix, and revoked on settle;
 *   3. a root-level attacker on the host, who can read the controller's memory or environ, is
 *      out of scope — this is a boundary between processes, not between people and machines;
 *   4. DSH's sandbox is not a security boundary and is not relied on here;
 *   5. the gateway sees only requests the factory authorised, from a token it can revoke.
 *
 * Deliberately *not* here: any decision path. `packages/proxy` brokers privileged operations
 * with a recorded human decision; this package brokers a credential, and a credential check
 * that could be blocked behind an operation decision would be a denial of service on the
 * worker. Separate packages, separate failure modes, no shared process.
 */
export {
  startCredentialProxy,
  pathWithinPrefix,
  PROXY_REFUSALS,
  type CredentialProxy,
  type CredentialProxyOptions,
  type ProxyEvent,
  type ProxyRefusal,
  type UpstreamTarget,
} from './server.ts';
export {
  createTokenRegistry,
  TOKEN_BYTES,
  TOKEN_REFUSALS,
  type ScopedToken,
  type TokenRefusal,
  type TokenRegistry,
  type TokenVerdict,
} from './tokens.ts';
