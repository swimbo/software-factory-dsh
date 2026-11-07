# ADR-006 — DeepSeek only, behind Bifrost, and no paid call in any test

**Status:** accepted (Phase 9b/9d); amended 2026-11-01 for the live-model path and **again 2026-11-02** — the proxy exists now, so the 2026-11-01 amendment's central concession ("the worker receives the key when live mode is on") is superseded by [ADR-007](007-scoped-credential-proxy.md), not retracted. Statements below marked _superseded_ are kept as written so the record of what was believed on 2026-11-01 survives; the 2026-11-02 amendment is what is true at `HEAD`.
**Context:** [architecture.md](../planning/dark-factory-dsh/architecture.md) §9, [consensus-plan.md](../planning/dark-factory-dsh/consensus-plan.md) constraint C5
**Proven by:** `packages/dsh-adapter` (overlay + executor tests), `docs/verification/*/summary.json` (`modelKeys: {BIFROST_API_KEY: false, DEEPSEEK_API_KEY: false}`)

## Context

The factory runs an agent, so it needs a model. Three pressures met here: the organisation had
already standardised on the **Bifrost** gateway (so a vendor SDK in this repo would be a second,
unaudited egress path); model access is the one place where a test can spend real money and leak a
real key; and the harness-under-test is DSH, which owns its own provider configuration.

The plan's constraint C5 was blunt: **the offline suite must pass with no model key set at all.**
That constraint is what makes "no paid call in any test" a structural property rather than a
promise, and it is checked on every verification run, not just at review time.

## Decision

- **DeepSeek models only, reached through Bifrost.** The adapter composes a DSH overlay that targets
  the gateway's `llm-pi-ai` provider with `apiKeyEnv: BIFROST_API_KEY`
  (`packages/dsh-adapter/src/overlay.ts`) — it never points at a vendor endpoint and never imports a
  vendor SDK.
- **The worker never receives the key.** The child-process environment is an explicit allowlist that
  does not contain `BIFROST_API_KEY` (`packages/dsh-adapter/src/executor.ts`; asserted by
  `packages/dsh-adapter/tests/executor.test.ts` — the child env is inspected and the key must be
  absent, and the overlay's secret scrubber refuses a config that embeds a key). The credential
  _broker_ is the gate that would hand a worker a scoped, expiring credential
  (`factory credential`); the gateway key is meant to live in a proxy the worker cannot read.
- **No paid call in any test.** The vitest suite and `bash scripts/verify.sh` run offline. Live-model
  specs (`e2e/cli/live/*`) are skipped unless `BIFROST_API_KEY` **and** `DSH_BIN` are set, and the gate
  stage that runs them is opt-in (`FACTORY_VERIFY_LIVE=1`) because each run spends. _Superseded
  (2026-11-02): they are no longer `expect.unreachable()` placeholders — both `@live` specs make a real
  turn through the proxy, and the verification summary records which keys were present, so a run that
  did have a key is visible in the artifact._

## Amendment (2026-11-01) — the live path, and the one credential it must forward

The original decision made "no paid call in any test" structural by never passing a key to a child.
That held while no live call existed. The operator then provisioned a Bifrost program key, and the
first real run proved the model path — which forced one honest exception rather than a quiet one:

- **`FACTORY_LIVE_MODEL=1` forwards exactly one credential name**, `BIFROST_API_KEY`, to the `dsh`
  child, and records `credentialsForwarded: ['BIFROST_API_KEY']` in `launch.json` — the **name**, never
  the value (`packages/dsh-adapter/src/launch-record.ts`). With the flag unset the allowlist is
  unchanged and the key is dropped; both directions are pinned in specs.
- **The reason is the missing proxy, not a change of mind.** In v1 there is no credential proxy
  container, so the process that talks to the gateway must hold the gateway credential. The container
  path (E2E-44) is the one that removes that need, and it is still `UNKNOWN`.
- **C5 is unchanged as a gate.** The offline suite and `scripts/verify.sh` stay free: both `@live`
  specs skip unless `BIFROST_API_KEY` **and** `DSH_BIN` are set, and the verification summary records
  which of them were present. A run with the key unset prints
  `live-model SKIPPED — BIFROST_API_KEY is not set`.
- **The credential is a program key, not a virtual-user key.** It lives on `hermes-control` with mode
  `0600`, is read per command over SSH, and must never be written into this repository, a launch
  record, or a receipt. `git grep` for the value returns nothing, and a spec asserts no key bytes
  appear in `launch.json`.

What this amendment does **not** buy: the worker still receives a credential when live mode is on, so
"the worker never receives the key" is true of every offline and container path and **false** of the
live path until the proxy exists. _Superseded (2026-11-02): the proxy exists; the worker receives a
scoped token, never the key. See the amendment below._

## Amendment (2026-11-02) — the proxy exists, and the exception is gone

The 2026-11-01 amendment recorded a real concession because `packages/credential-proxy` did not exist.
It does now ([ADR-007](007-scoped-credential-proxy.md), commit `bfd0ca5` and the specs named there), and
every sentence above that depended on its absence is superseded rather than edited away:

- **The key is no longer forwarded.** A per-attempt proxy on `127.0.0.1:<ephemeral>` holds
  `BIFROST_API_KEY`; the `dsh` child gets `FACTORY_PROXY_TOKEN` — one token, minted per attempt, bound
  to that socket, that lease and one upstream path prefix, revoked before the verdict is written.
  `forwardedCredentials()` copies **no** credential-shaped name from the parent, under
  `FACTORY_LIVE_MODEL=1` or otherwise (`packages/dsh-adapter/src/launch-record.ts`); the spec that
  asserts the child's env has no `BIFROST_API_KEY` is `packages/dsh-adapter/tests/launch-record.test.ts`.
- **`launch.json` says what happened**, not what was intended: `credentialsForwarded: []` and
  `credentialProxy: { token: 'scoped', expiresAt }` — the token's _existence_, never its value.
- **`FACTORY_LIVE_MODEL=1` is now only a consent switch** ("this run may spend"). It no longer changes
  the child's environment, and the by-category refusal of `*_KEY` names never moved.
- **`packages/proxy` exists too**, and it is a different thing: the privileged-operation broker R5
  asked for (post-expansion classifier, brokered-operation table, signed one-operation decision). The
  "Not built" paragraph below is therefore wrong about both packages. What is genuinely still missing
  is narrower and is stated in `README.md`: no verb mints a decision and neither call site passes a
  `DecisionSink`, so the allow path has no end-to-end proof, and a real `dsh` turn's own tool calls are
  an agent-reported artefact that never reaches the broker.

What remains true from the 2026-11-01 amendment: C5 is unchanged as a gate (the offline suite and
`verify.sh` pass with no key at all, and the summary records the key state), the live stage is opt-in
because it spends, and the credential is a program key kept on `hermes-control` at `0600`, read per
command and never written into this repository, a launch record or a receipt.

## Alternatives rejected

- **Call the DeepSeek API directly from the adapter.** Rejected: it creates an egress path outside
  Bifrost, which means the organisation's gateway-level logging, rate limiting and key custody no
  longer cover the agent, and the repo would need its own retry/backoff/redaction stack.
- **Allow a real model call in CI behind a secret.** Rejected because it makes the suite's green
  line depend on a credential and a network, and because a paid call in a test is an unrepeatable
  measurement: a flaky provider response would look like a factory bug. It also invites a key into
  a CI environment where a compromised test could exfiltrate it.
- **Fake the provider and call it "integration tested".** Rejected as a claim, not as a technique:
  the fake executor is legitimate for pipeline tests, but the DSH-facing integration is proven by
  adapter tests plus one recorded probe (`evidence/phase-9b-dsh-integration-probe.md`), and the
  docs say so rather than implying continuous live coverage.
- **Ship the credential proxy in v1 (a real HTTP proxy holding the key).** _Superseded (2026-11-02):
  it shipped._ Both halves exist — `packages/credential-proxy` for the credential
  ([ADR-007](007-scoped-credential-proxy.md)) and `packages/proxy` for privileged operations — and they
  are deliberately two processes, because a proxy in front of its own supervisor can deadlock
  (ADR-007, "Why this is not `packages/proxy`"). When this bullet was written they did not exist, and
  privileged work was _refused_ rather than brokered.

## Consequences

**Good.** A stranger can clone this repo, run `pnpm test` on a machine with no keys and no network,
and get a green suite — which is the only way the suite can be trusted as evidence. The worker's
environment is inspectable and small; the gateway key is nowhere in it. Nothing in the test suite can
cost money, so a test failure always means the code is wrong.

**Bad.** The model path is not continuously proven: what is proven is that the overlay is composed
correctly, that the key is absent from the child env, and that the fake executor drives the pipeline.
The real DeepSeek turn is exercised by a recorded probe, not by CI. The proxy gap also means the
credential story is narrower than the plan's R5: `factory credential` mints a scoped credential and a
worker token, but the "opaque proxy token" the help text describes has no proxy behind it in v1.

**Not built.** _Superseded (2026-11-02) — every clause here was true at `c363900` and is false at
`HEAD`._ `packages/credential-proxy` holds the key and meters the gateway per attempt
(revoking the token at the ceiling); `packages/proxy` is the post-expansion classifier and
brokered-operation table; ND1–ND4 were ratified on 2026-11-01 (`findings.md` § DECIDED), so proxy
metering semantics is a decision, not an open question. What is still not built is narrower:
billing-grade accounting (`budget reconcile` reports `unknown`, exit 6, rather than guessing) and an
end-to-end allow path through `packages/proxy` (no verb mints a decision, no `DecisionSink` at either
call site).
