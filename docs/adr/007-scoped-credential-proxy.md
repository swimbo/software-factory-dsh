# ADR-007 — A scoped credential behind a localhost proxy, not a key in the child

**Status:** accepted 2026-11-01; supersedes the ADR-006 amendment for the live path
**Context:** [ADR-006](006-deepseek-behind-bifrost.md) (the model path and the one credential exception), [architecture.md](../planning/dark-factory-dsh/architecture.md) §9, constraint C8 (DSH's sandbox is not a security boundary)
**Proven by:** `packages/credential-proxy` (14 specs: injection, five refusals, expiry, revocation, path confinement, body cap), `apps/cli/src/credential.test.ts` (9 specs, including _the token that worked a moment ago is answered 401 after settle_), `e2e/cli/live/08-model.test.ts` (the live pair, opt-in)

## Context

ADR-006 recorded an exception rather than hiding one: with no credential proxy, the live path forwarded
`BIFROST_API_KEY` into the `dsh` child's environment, so **"the worker never holds the gateway key"** was
true of every offline and container path and false of the one path that talks to the model. That was
honest, and it was still a claim that changed scope depending on how you ran the factory.

## Decision

A per-attempt **credential proxy** on `127.0.0.1:<ephemeral>` holds the key; the worker gets a token.

- **The token is scoped four ways:** to that proxy's socket, to the attempt's lease lifetime, to one
  upstream path prefix, and to one attempt (revoked on settle, before the verdict is written). It is
  minted per attempt, never reused, and never written to the launch record — the record carries
  `credentialProxy: { token: 'scoped', expiresAt }`.
- **The key never leaves the proxy.** The upstream `Authorization: Bearer <key>` header is written by
  `packages/credential-proxy/src/server.ts` and nowhere else; nothing a worker sends can make the key
  appear in a response, a log line, or a receipt.
- **Refusals are distinct facts**, because an operator reading a log must be able to tell them apart:
  `unknown-token`, `token-expired`, `token-revoked`, `method-not-allowed`, `path-outside-upstream`,
  `body-too-large`, `upstream-unavailable`. Checked token → method → path → size, before forwarding.
- **Revocation is ordered, not incidental.** `launch.ts` settles and closes the proxy in a `finally`
  that runs on the failure path too; the verdict is written after that returns. A token that outlived
  its attempt would be a credential alive while the factory had recorded the attempt as over.
- **Nothing outlives the turn, including the gateway's stream.** The proxy destroys its upstream
  leg when the worker closes its side, and destroys any leg still streaming when it closes itself.
  This is in the ADR because it is not an optimisation: `pipe` destroys the _destination_, not the
  source, so a worker that finished a turn left the gateway streaming into a socket nobody read —
  and a live run completed a verified unit (`outcome: pass`, tokens counted) and then never
  exited, killed at its 300 s guard. `packages/credential-proxy/src/__fixtures__/exit-child.ts`
  reproduces it in one second and the spec asserts process exit, because "the factory must end"
  is not visible to an assertion made inside the same process.
- **`FACTORY_LIVE_MODEL=1` is now only a consent switch** — "this run may spend" — and no longer copies
  a key into the child. The env allowlist still refuses `*_KEY` by category; that rule did not move.

## Why this is not `packages/proxy`

`packages/proxy` brokers **privileged operations** — a `sudo`, a `docker`, a write into `/etc` — with an
operator decision in the loop. This package brokers a **credential**: no decision path, no operator
phrase, no operation classification, because the thing constrained is "may this token reach this prefix",
not "may this command run". They are separate for a mechanical reason as well: a proxy in front of its
own supervisor deadlocks, and `packages/proxy` classifies `docker` (the container a wall might run in) as
brokered, so the two must never be one process. Merging them would let a privileged-operation decision
stall a credential check.

## Threat model, stated so it can be argued with

1. A worker that can read **its own** environment gets the scoped token: bounded lifetime, bounded
   upstream prefix, revoked on settle.
2. It does not get the key, and cannot make the key appear in a response, a log, or the launch record.
3. A worker that can read `/proc/<pid>/environ` of the **controller** (same uid, no isolation) is a
   host-level attacker and is **out of scope**. This is a boundary between the worker and the
   credential, not between the operator and the machine.
4. DSH's sandbox is not a security boundary (`workspace-write`, same uid) and nothing here claims it is.
5. The gateway sees the factory: every request that arrives is one the factory authorised, on a path the
   factory confined, with a token the factory can revoke.

**Explicitly not bought:** protection from a root-level attacker, per-request spend accounting (ND3), or
a second OS uid (ND2). The container path (E2E-44) remains the shape that adds real isolation.

## Alternatives rejected

- **Keep forwarding the key; document it.** Rejected: the README's strongest security sentence would
  depend on how the factory was run, and readers do not read ADRs before trusting a claim.
- **A sidecar container per attempt.** The right long-term shape (it is E2E-44), but it needs the worker
  image and a network namespace the factory does not ship in v1 — refused rather than half-built.
- **Token in the overlay file instead of the environment.** Rejected: the overlay is recorded, hashed and
  attached to the receipt, so a token there would be evidence in a file whose whole purpose is to be
  shared.
