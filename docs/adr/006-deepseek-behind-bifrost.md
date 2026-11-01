# ADR-006 — DeepSeek only, behind Bifrost, and no paid call in any test

**Status:** accepted (Phase 9b/9d); amended 2026-11-01 for the live-model path; the credential proxy half is **not built**
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
  specs (`e2e/cli/live/*`) are placeholders that do not call a model — they are skipped without a
  key (`@live`), and their bodies are `expect.unreachable()` so a future implementation must be
  written deliberately. The verification summary records the key state next to the results, so a
  run that did have a key would be visible in the artifact.

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
live path until the proxy exists. That is stated in `README.md` next to the limitation, because a
security claim that silently changes scope is worse than one that is narrower than advertised.

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
- **Ship the credential proxy in v1 (a real HTTP proxy holding the key).** Not rejected on merit —
  it is simply not built. `packages/proxy` does not exist (`phase-13-audit.md` GAP-003), so
  privileged work is _refused_ rather than brokered.

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

**Not built.** `packages/proxy` (credential proxy), the normalised destructive-command classifier,
and proxy-side spend metering are all absent — see `phase-13-audit.md` GAP-003 and ND3 (proxy metering
semantics is an open human decision, `docs/handover.md`). Budget ceilings therefore **refuse**
dispatch but do not **enforce** spend.
