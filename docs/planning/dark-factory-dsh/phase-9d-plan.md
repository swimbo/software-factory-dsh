# Phase 9d — Implementation: Qualifier & Gates

**Status:** pending
**Owner:** lead
**Artifacts produced:** `packages/qualifier/**`, `packages/gates/**`, `packages/proxy/**`, `fixtures/credentials/**`

## Objective

Decide _what may run dark_ deterministically, and make every gate a capability rather than a request: budget envelopes, destructive-operation boundaries, credential issuance, and the first-production-promotion signature. A unit that cannot be verified, cannot be undone, or cannot be afforded must be routed to a human — by code, not by a prompt.

## Prerequisites

- Phase 9a (engine/store), 9b (executor/proxy target), 9c (wall/verdict) complete.
- Operator signing key file path configured; credential proxy has the Bifrost key in its own process env (never in a worker).

## Tasks

- [~] `qualifier/score.ts`: the deterministic signal set from `architecture.md §2.4` — intent derivability (machine-checkable criteria + hash-matched restate-back), reversibility/blast radius (declared touch paths + operation classes), outcome observability (named oracle), task-class Δ stability + escape rate, size budget, projected spend. Pure function `qualify(unit, policy, history) → {lane, score, reasons[]}` with stable reason codes (`intent_not_derivable`, `irreversible_effect`, `no_observable_oracle`, `delta_unstable`, `size_over_budget`, `budget_over_envelope`).
- [~] `qualifier/policy.ts`: versioned policy (`policyVersion = sha256(rules)`), `revalidate(mandate)` — a unit whose mandate no longer holds under a changed policy stops (never silently resumes). **No model call exists in this package** (TD9); an import lint rule (`no-llm-in-qualifier`) enforces it.
- [~] `gates/budget.ts`: `reserve(unit, estimate)` before dispatch, `settle(unit, actual | 'unknown')` after; price table in config (input/output tokens per DeepSeek tier); per-unit and per-day envelopes; `unknown` is stored as unknown and **blocks promotion**; envelope raise is an operator command (`factory budget raise`) recorded as a gate decision.
- [ ] `gates/destructive.ts`: classification of the **normalised, post-expansion** command (resolve aliases, `$VAR`, wrappers, `git -c …`, `env …`) into `safe | destructive | privileged`; the worker cannot invoke the resolver (it lives in the control plane / proxy); destructive class requires a recorded human approval.
- [x] `gates/promotion.ts`: `promoteUnit` requires `verdict.passed === true` **and** a valid human signature over `sha256(unitId, verdictId)`; the first promotion of any unit is always signature-required (no auto mode exists in code).
- [ ] `gates/credentials.ts` + `packages/proxy`: broker mints short-lived (≤15 min), task-scoped, single-repo tokens; the proxy is the only holder of `BIFROST_API_KEY` and the only egress target the worker container can reach; worker env contains a proxy token only; `mintToken` records `IssuedToken` with scope + expiry; revocation on attempt end.
- [~] Tests: table-driven qualifier cases (≥10, each asserting lane + reason codes); policy-change revalidation; budget reservation/settlement incl. `unknown`; destructive classifier against a corpus of normalised commands (`rm -rf /`, `git push --force`, `DROP TABLE`, `terraform apply -auto-approve`, `kubectl delete`, plus benign lookalikes); unsigned promotion refused; expired/over-scoped token refused; proxy refuses any upstream other than Bifrost.
- [~] `progress.md`: qualifier table output, classifier corpus results, and the refused-promotion evidence.

## Delegation plan

Two parallel scopes:

- **Agent A (`qualifier-builder`)** — `packages/qualifier/**` + policy versioning + table-driven tests.
- **Agent B (`gates-builder`)** — `packages/gates/**` + `packages/proxy/**` + classifier corpus + token tests.
  Frozen surface: `LaneDecision`, `GateDecision`, `IssuedToken` schemas in `packages/contracts` (Lead-owned).

## Verification

### Hard Gates (copied verbatim from `done-means-done/phase-09-implementation.md`)

- [ ] **Scope fidelity**: every IN-scope deliverable in `phased-plan.md` is represented by at least one merged/committed change. Nothing OUT-of-scope was implemented.
- [~] **User-story coverage**: every P0 story from `user-stories.md` has a code path that fulfils its acceptance criteria. Evidence: story ID referenced in commit messages, code comments, or `progress.md`.
- [~] **Architecture adherence**: implemented component boundaries match `architecture.md > ## Components`. Deviations were negotiated and recorded in `progress.md`.
- [x] **Tech-guide adherence**: versions, conventions, and dev-env commands match `tech-guide.md`. Deviations recorded with rationale.
- [ ] **Subagent delegation used where required**: any phase with 2+ independent tasks dispatched parallel agents; delegation table in `phased-plan.md > ## Delegated Work` shows statuses and results.
- [ ] **Error log is clean**: `progress.md > ## Errors` has no open errors. Every entry is either `resolved` with resolution, or tagged `accepted_risk` with a user sign-off line.
- [~] **3-strike protocol respected**: no task shows 3+ repeated identical failing attempts. Every failure has a mutation entry.
- [~] **Mid-phase volatile decisions debated**: every decision made during Implementation that falls into a Volatile Decision Category (LLM/model, AI SDK, third-party API/service, datastore swap, framework version bump, dependency major, architectural pattern change, auth strategy, data contract, deploy/CI pattern, observability) has a Mode B decision brief in `docs/planning/decisions/`, a `/debate` outcome recorded in the brief, and an entry in `docs/planning/decisions/INDEX.md`. No silent adoption.
- [x] **Secrets hygiene**: no secrets in code, commits, or planning files. `.env` present in `.gitignore` if used.
- [x] **Build succeeds**: canonical build command from `tech-guide.md` runs to success locally. Output pasted or linked in `progress.md`.
- [x] **Lint clean**: canonical lint command runs clean. Output linked.
- [x] **Type-check clean** _(typed languages)_: type-check runs clean.

### Project-specific evidence

- [x] ≥10 qualifier cases pass, including: missing restate-back → `reject`/`intent_not_derivable`; schema migration in touch paths → `lit`/`irreversible_effect`; no oracle → `lit`; unstable Δ class → `lit`; over-envelope → `lit`/`budget_over_envelope`.
- [x] The qualifier package has **no** LLM/HTTP import (lint rule + test); `grep -r "fetch(" packages/qualifier` returns nothing.
- [x] Budget: reservation precedes dispatch; a settle with `unknown` blocks `promoteUnit` (`VERDICT_STALE`/`BUDGET_UNKNOWN`), evidence pasted.
- [ ] Destructive classifier corpus: ≥15 normalised commands classified, with zero false-negatives on the destructive set (false positives acceptable and logged).
- [x] Unsigned promotion → `PROMOTION_UNSIGNED`, and the unit stays unpromoted.
- [ ] Proxy test: worker traffic to any host other than Bifrost is refused; `BIFROST_API_KEY` appears in no worker env, file, receipt or log (grep proof).

## Acceptance criteria

Lane routing is a deterministic function with auditable reason codes; no unit can spend beyond an envelope, run an un-approved destructive operation, obtain an over-scoped credential, or be promoted without a signed verdict — each refusal proven by a failing-command test.

## Risks / notes

- The destructive classifier is the weakest link (pain-point T5: pattern-based string validation is "structurally inadequate"). Mitigation: classify the **normalised post-expansion** command _and_ treat the container's capability set (no prod network, no prod credentials) as the real boundary. Say this in the README rather than overclaiming.
- The proxy is the only component holding a model credential; it must be the only egress path. If Docker egress cannot be constrained on macOS, record it as `accepted_risk` and prefer Apple Containerization in a later phase (kickoff research).

### Phase 9d — completion evidence (2026-11-01)

`qualifier 109 · effects 28 · gates 101 — security lock proven both directions, unsigned promotion writes no file`.

Full gate output, per-package suites and the four never-regress controls: [`evidence/phase-9-implementation.md`](evidence/phase-9-implementation.md). Whole-tree gate at close: `verify: 6 passed, 1 skipped, 0 failed` — `972 passed | 10 skipped (982)`.

**Unproven (audit 2026-11-01):** 18 signals live in `signals.ts`, not `score.ts`; 19 `revalidate(mandate)` does not exist (`policy.ts` computes a version only); 20 there is no `settle(actual|unknown)` gate function — spend is reserved and recorded, and `unknown` blocks promotion only through the verdict path; 24 there is no destructive classifier, so there is no classifier corpus; 25 `progress.md` carries the qualifier evidence but no classifier results.
