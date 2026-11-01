# Phase 13 evidence — the four ND decisions, implemented

**Date:** 2026-11-01
**Decisions:** `findings.md` § DECIDED 2026-11-01 (ND1–ND4), ratified by the operator that day.
**Purpose:** the decisions were ratified as *answers*, so the claim discipline moves from "we recommend"
to "this is what the code does, and this is where it stops". Each section names the artifact, the
number, and the thing that is still **not built** — because a ratified decision is exactly the kind of
sentence that quietly grows.

---

## ND1 — the certification operating point

**Decision.** Certification is per **task class**, at **m = 20 attempts / k = 18 passes**. The published
number is **α = P(a class that truly passes 95 % of the time fails certification)**, never a global pass
rate and never β.

**Implemented.** `packages/wall/src/operating-point.ts`:

- `DEFAULT_OPERATING_POINT = {m: 20, k: 18, p0: 0.95}`.
- `certificationAlpha()` computes the binomial tail `Σ_{i=0}^{k−1} C(m,i)·p0^i·(1−p0)^{m−i}` in **exact
  rational arithmetic** (BigInt numerators over `100^m`, scaled to 20 decimals), not a float summation
  of a small tail.
- `certificationForClass({samples, passes})` returns
  `{outcome: 'certified' | 'not-certified' | 'insufficient', m, k, p0, alpha, alphaExact, samples, passes}`
  and refuses nonsense (k > m, passes > samples) instead of clamping.
- The wall's `class-certification` scenario publishes `m`, `k`, `p0` and `alpha` in the verdict's
  `observed` text, and its wording rule never says "certified at" unless the outcome is `certified`.
  `insufficient ⇒ promotionRequiresHumanSignature: true` (law L3).
- `policy.certification` lets a policy pin a different point; `minDeltaSamples` is untouched — Δ evidence
  and binomial confidence are two different facts and both still gate.

**The number.** For m = 20, k = 18, p0 = 0.95:

```
α = Σ_{i=0}^{17} C(20,i) · 0.95^i · 0.05^(20−i)
  i=17: 1140  · 0.418120 · 1.25e-4   = 0.059582
  i=16: 4845  · 0.440127 · 6.25e-6   = 0.013330
  i=15: 15504 · 0.463291 · 3.125e-7  = 0.002246
  i=14: 38760 · 0.487675 · 1.5625e-8 = 0.000295
  tail below i=14:                     ≈ 0.000031
                                     ≈ 0.075484
```

**α = 0.07548367378849634297… (0.0755).** The spec recomputes the same sum a second way (factorial-free
coefficients, plain floats) and requires agreement to 1e-12, so the two only agree if both are right.

**Correction to the planning record.** `findings.md` originally carried "α ≈ 0.882" at m=20/k=18 and
"α ≈ 0.687" at m=6/k=6. Under the definition in the same sentence the values are **0.0755** and
**0.2649**. 0.882 and 0.687 are not attainable from this binomial at any k — they were survival
probabilities from another formulation. The decision is unchanged; the published number is now computed,
and the correction is written into `findings.md` rather than silently edited out.

**Specs.** `packages/wall/src/operating-point.test.ts` (8): exact α; 18/20 certifies; 17/20 is
`not-certified` (and *not* `insufficient`); 3/20 is `insufficient` and never certified; a passing 6/6
does not certify (with the old m=6 point asserted in the same spec to certify that same evidence);
refusals for k > m and passes > samples. `packages/wall` 164 passed / 3 skipped; `packages/gates` 101.

**NOT built.** Re-certification is **not mechanical**. The point and α are derived per verdict, which is
the evidence a re-certification job would read, but nothing compares a stored class certificate against
a changed `policyVersion` or model id. The decision says "re-certify on policy/model change"; the code
today says "every verdict carries the point it was measured under". A job is a follow-up, not a claim.

**NOT built, and not published.** β. It needs a known-bad corpus nobody has, so it stays unmeasured. The
module header says so.

---

## ND2 — the two-uid topology

**Decision.** On Linux the wall (verdict store, holdout corpus, operator key) runs as `factory-wall` and
the worker as `factory-worker`; the verdict store is `0750` owned by the wall group. On macOS there is no
second uid, so the claim is scoped: the wall is a separate **process**, not a separate **principal**.

**Implemented.** `packages/store/src/topology.ts` (pure decision + mode arithmetic + marker +
plan/apply/verify), `scripts/provision-topology.sh` (an `exec node` wrapper over
`scripts/topology-entry.ts`, so the operator surface and `factory status` run the same function — there is
no `if uname` anywhere), `factory status` reporting on both the CLI and the panel.

- `decideTopology({platform, uid, accounts, marker})` → `{kind: 'two-uid' | 'single-uid', source,
  reason, claim, principal, modes, refusal}`. Ordering is load-bearing: a missing account beats a marker
  that claims otherwise, and an unreadable marker never degrades to "probably two-uid" (L3).
- The marker is `state/topology.json`, written only by a verified `--apply` on Linux. The running factory
  reads the marker, not a build flag — which is why the wall's own `status` can be trusted.
- Modes: `state-dir 0750 wall:wall`, `store-db 0640`, `corpus 0750`, `key-dir 0700 wall` (no group bits),
  `dsh-home/{worker,evaluator} 0700`, `topology.json 0640 wall:wall`. Isolation is "others = 0" plus the
  worker not being in the wall group; a spec asserts zero world bits on every target rather than trusting
  the octal literal.
- Refusal: on Linux with the accounts missing, exit **8**, the four `groupadd`/`useradd` lines printed and
  **nothing created** — provisioning a factory does not mint system users.
- `packages/contracts/src/status.ts` makes `factory.topology` **required**, and the panel (which builds its
  own status) must carry it too: a single-uid page cannot compile without saying so.

**Proven on real Linux, in a `node:26-bookworm` container** (the only reason two bugs were found):
refusal with the printed commands → operator creates the accounts → `--apply` verified and wrote the
marker → re-run byte-identical → `factory-worker` got **EACCES** on the store, the corpus and the operator
key while `factory-wall` read the store → `factory status` as `factory-wall` reported `principals
two-uid`. Two defects that no unit spec could see: `chmod 0o750` (GNU rejects the `0o` form; the plan now
emits `750` while `octal()` stays for display), and the marker written `0640 root:root`, which made
**the wall's own status report single-uid on a provisioned host** (now chowned to `factory-wall`, and the
run exits 8 rather than leaving unreadable evidence if the chown fails).

**Specs.** 58 new: `packages/store/src/topology.test.ts` 44, `scripts/provision-topology.test.ts` 9
(spawning the real script), `apps/cli/src/status.test.ts` +4, panel +1. `vitest.config.ts` now runs
`scripts/**/*.test.ts` — a provisioner nobody spawns is a provisioner nobody has run.

**NOT built.** No run on the Linux target itself: no systemd unit, no real `/var/lib/factory`, no operator
key that already exists. The macOS host is single-uid by construction, so everything here that requires
two uids is proven by specs and one container run.

---

## ND3 — metered spend, enforced by revocation

**Decision.** The gateway is the source of truth for spend. The proxy records a signed usage fact per
attempt `{tokensIn, tokensOut, costUsd, gatewayRequestId, signedAt}` into the ledger, reconciles against
Bifrost's own usage on a daily job, and when observed spend crosses the envelope it **revokes the attempt
token** so the run stops. The reservation stays an estimate and says so.

**Implemented.**

- `packages/credential-proxy/src/usage.ts` — usage extracted from the **response**, for JSON and SSE.
  The response is **teed, not buffered**: the worker's bytes stream untouched, a capped copy (1 MiB) is
  folded after `end`. SSE **folds every `data:` chunk** rather than taking the last one, because Anthropic
  splits input and output across `message_start` and `message_delta` — a last-chunk rule reports
  input-only. Folding is also right for an interrupted stream: the spend still happened.
- **No usage block ⇒ `unknown`, never zero**: `tokensIn/out: null`, `costUsd: null`,
  `costSource: 'unknown'`, `unpricedRequests: 1`. A body over the cap or unparseable is
  `truncated: true` / unknown. An opt-in price table (`FACTORY_PRICE_IN_PER_TOKEN_USD`, …, read at the
  composition root) prices an unpriced gateway and is labelled `costSource: 'estimated'`.
- `usage_records` (append-only table) + ledger event `usage.recorded` carrying the **same digest** —
  one fact, two places, checkable. `cost_usd` is nullable with no default: "tokens reported, no price"
  stays `null` all the way into the ledger. What the digest buys: the row and the event are the same
  fact. What it does not buy: a signature over a claim the gateway made — that comparison is reconcile.
- **Enforcement.** `spendCeilingUsd` + `onCeilingReached` on the proxy; the ceiling is the attempt's
  remaining authority (`envelope − reserved − recorded`) from `packages/core/src/rules.ts`. On the
  crossing, the request **is served** (the money is already spent), then the token is revoked, a
  `ceiling` event fires, and the next request is `401 token-revoked`. Unpriced calls cannot cross a
  dollar ceiling: the token stays alive and the record says unknown. The attempt then fails; nothing
  redispatches it (never-regress control 3).
- **`factory budget reconcile --usage-file <path|->`** — JSON array or CSV (header-named columns, so a
  renamed column is a refusal, not a silent shift). New code `USAGE_UNRECONCILED`, exit 6, distinct from
  `BUDGET_EXCEEDED` because "we overspent" and "we cannot account for what we spent" are different
  sentences. Missing/unreadable/wrong-shape export ⇒ `state: 'unknown'` at exit 6 naming which of the
  three failed. An incomparable mismatch is `mismatched` with `null` deltas, never a match.

**Specs.** `packages/credential-proxy` 22 (8 new: JSON usage, SSE folding, unknown-not-zero, price-table
estimate, ceiling crossing at the second call + 401 on the third, ceiling silent while unknown);
`apps/cli/src/verbs/reconcile.test.ts` 8; `packages/store` 107 (migration specs included);
`apps/cli/src/credential.test.ts` 9; `packages/contracts` 129.

**NOT built.** No end-to-end spec through the real executor (needs `dsh` + a paid gateway); the wiring is
proven by a real socket and real revocation in `credential.test.ts`. No invoice-grade accounting: reconcile
is best-effort and reports `unknown` rather than guessing.

---

## ND4 — the off-host ledger anchor

**Decision.** A daily job appends the ledger head off-host and the factory refuses to trust a local ledger
whose head has no anchor newer than 48 h. The claim is "detectable within 48 h", never "prevented".

**Implemented.** `packages/anchor` + `factory ledger <anchor|verify>`; ADR-008 records the decision, its
threat model and what it does not buy; `docs/runbooks/ledger-anchor.md` is the 2am procedure.

- **The head is recomputable by a second party:** a chain over the events in `seq` order,
  `chain₀ = sha256("factory-ledger/v1")`, `chainᵢ = sha256(chainᵢ₋₁ + contentHash(eventᵢ))`. Built from the
  events, not from stored per-row hashes: a host that rewrites a row can rewrite its hash too. The spec
  rebuilds the chain independently (its own `sha256` + `canonicalJson` loop) and requires the same string.
- **Four outcomes:** `fresh | stale | missing | rollback`. Only `fresh` permits a claim; `verify` exits
  **9** otherwise. `rollback` — the anchor says more events than the local ledger has — outranks `stale`:
  a recency-only check would call a restored file fresh.
- **A local anchor is reported as local.** `FACTORY_ANCHOR_DIR` is `scope: 'local'` and `verify` says
  "on this machine — this detects truncation, not a host that rewrites both copies". Only
  `FACTORY_ANCHOR_SSH` (with `FACTORY_ANCHOR_PATH`) yields `off-host`.
- The destination is configuration, never data: no unit spec, receipt or verdict field can name the
  command.

**Specs.** `packages/anchor` 17 (chain recomputation, four outcomes with the rollback/stale ordering,
default 48 h window, file transport, truncated-tail tolerance, command transport, failing command
surfaced); `apps/cli/src/ledger.test.ts` 6 through the real binary (refusal with both variable names,
local scope, fresh verify, missing, stale, rollback).

**NOT built.** Nothing schedules the anchor: the runbook gives the `cron`/`launchd` line and the operator
installs it. No alerting on staleness — `verify` is a command a human or a cron job runs, and the exit code
is the whole mechanism.

---

## Cross-cutting: the schema migration, and why it exists

ND3 added a table, which changes `SCHEMA_SQL`. The store's discipline is to refuse a version mismatch
rather than guess, so an operator's existing ledger would have become unopenable — and "reset
`FACTORY_HOME`" is not an allowed repair in this repository. `packages/store` therefore declares
`MIGRATIONS` (v1 → v2: `usage_records` and its two indexes, additive only) and applies them on open:

- a store at a version with **no declared path** is still refused (`declares no migration from there`);
- the checksum check still refuses a drifted schema at the current version;
- each applied step appends a `store.migrated` event `{from, to, note}`, so "your store was upgraded" is a
  ledger fact and not a changelog line;
- the old `schema_migration` row stays — a migration appends history, it does not rewrite it.

A destructive change (dropping or reshaping a column) must never be expressed as a migration here.

**Specs.** two new in `packages/store/src/store.test.ts`: a v1 store opens by applying the declared
migration and records one `store.migrated` event with both version rows present; a version with no path is
still refused.

---

## What this round did **not** do

- No re-certification job (ND1 half two), no alerting on anchor staleness (ND4), no e2e through the real
  executor for the ceiling (ND3), no Linux two-uid run on this macOS host (ND2 — the topology is decided
  and reported, the Linux path is exercised by specs rather than by a machine).
- The soak run and the container worker path remain on the backlog; nothing here changes them.
