# Phase 9a — Implementation: Skeleton & Durable Store

**Status:** pending
**Owner:** lead
**Artifacts produced:** ``{package.json,pnpm-workspace.yaml,tsconfig*.json,.nvmrc,.gitignore}` (repo root)`, `packages/contracts/**`, `packages/store/**`, `packages/core/**` (engine skeleton), `packages/effects/**`, `fixtures/**`

## Objective

Stand up the implementation repo and the part of the factory that everything else depends on: a **single-writer SQLite append-only ledger** with derived aggregates, a **command-per-transaction engine**, and an **effect outbox with deterministic idempotency keys**. At the end of this phase, a unit can be submitted and qualified and survives a `kill -9` with zero duplicate effects — proven by test, not by inspection.

## Prerequisites

- Phase 3–6 artifacts exist (`data-map.md`, `architecture.md`, `tech-guide.md`) — the schema follows `data-map.md > ## Entities`, versions follow `tech-guide.md`.
- `/Users/bo/code/dark-factory-dsh` does not exist yet (created here).
- No model credentials required: this phase has **zero** network I/O.

## Tasks

- [~] Create the workspace at the **repo root** on branch `feat/dark-factory-dsh` (no `git init` — this repo exists): `package.json` (private, workspaces), `pnpm-workspace.yaml`, `tsconfig.base.json` (strict, `noUncheckedIndexedAccess`, `exactOptionalPropertyTypes`), per-package `tsconfig.json`, `.gitignore` (`.env`, `*.db`, `dist/`, `node_modules/`, `artifacts/`), `README.md` stub.
- [x] `packages/contracts`: Zod schemas + inferred types for `UnitSpec`, `AcceptanceCriterion`, `LaneDecision`, `WorkerReceipt`, `CommandRecord`, `Verdict`, `Promotion`, `UnitEvent` (discriminated union), `ErrorCode` enum; one exported `canonicalJson()` + `sha256Hex()` used by every idempotency key.
- [ ] `packages/store`: `schema.sql` v1 (tables per `data-map.md`: `events`, `units`, `mandates`, `lane_decisions`, `claims`, `leases`, `attempts`, `receipts`, `verdicts`, `gate_decisions`, `spend_entries`, `issued_tokens`, `promotions`, `effects`, `policy_versions`, `session_trees`), unique indexes for `idempotency_key`, `content_hash`, and `one-open-lease-per-unit`; `migrate.ts` with a version table; `Store.open({path})` acquiring an exclusive file lock; `atomic(fn)`; `ledger.append(events)`; repo readers.
- [x] Schema invariants encoded in SQL (not just documented): append-only triggers rejecting `UPDATE`/`DELETE` on `events`, `receipts`, `verdicts`; `CHECK` constraints that make a "passed" verdict impossible without a non-null `receipt_id` and `holdout_revision` (i.e. `unknown` cannot be stored as pass); unique partial index on `leases(unit_id) WHERE released_at IS NULL`; a `lit_parked` unit cannot have an open lease or an attempt.
- [~] `packages/core`: `Engine` with `submitUnit`, `qualifyUnit`, `runUnit` (dispatches a `launch` effect), `observeAttempt`, `recordReceipt`, `abortUnit`, `recover`; the `Unit` state machine from `data-map.md` **including the `lit_parked` terminal** (contradiction X5); a `DecisionInput` type that structurally excludes `narrative` (law L1 enforced by the type system).
- [~] `packages/effects`: `enqueue(kind, key, payload)` inside the caller's transaction; `start()/drain()`; one handler per kind (`qualify`, `launch`, `delivery`, `verify`, `promote`, `notice`); per-kind ordering; exponential backoff with a `Later` sentinel that defers without counting a failure; `health()` surface.
- [~] Recovery: `recover()` finds attempts without terminal events, marks them `ambiguous`, and produces a `ReconciliationReport` **without dispatching**; a unit in `ambiguous` requires an explicit operator `retry` (inherited invariant #1).
- [x] Tests (`vitest`, no network): schema-invariant tests (attempting an update on `events` throws; a pass verdict without receipt is rejected); idempotency tests per command (same input twice → one row, identical result); effect-replay test (replay the ledger → identical effects); crash simulation (open store, enqueue, abandon without `drain`, reopen, `recover` → no duplicate effect, attempts `ambiguous`); `unknown`-not-pass test.
- [x] `progress.md` entries: build/test/typecheck commands and their output; the crash-simulation evidence.

## Delegation plan

Two independent write scopes, safe to run in parallel:

- **Agent A (`store-builder`)** — `packages/store/**` + `packages/contracts/**` + schema/invariant tests.
- **Agent B (`engine-builder`)** — `packages/core/**` + `packages/effects/**` + idempotency/recovery tests.
  Contracts are frozen first (Lead writes `packages/contracts` interfaces, then both agents work against them). Overlap on `contracts` is avoided by Lead ownership.

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

- [~] `nvm use && pnpm -r typecheck` exits 0 — output in `progress.md`.
- [x] `pnpm -r test` exits 0 with the schema-invariant, idempotency, replay and crash-simulation suites present and passing.
- [~] The crash-simulation test demonstrably fails if `recover()` is changed to dispatch (mutation check: revert-dispatch locally, observe red, restore).
- [~] `sqlite3 <db> ".schema events"` shows the append-only triggers; `SELECT` on a mutated verdict shows the `CHECK` constraint firing.
- [x] No network calls in the suite (`BIFROST_API_KEY` unset, tests pass).

## Acceptance criteria

A unit can be submitted and qualified, the ledger is provably append-only, every command and effect is idempotent under replay, and a simulated crash produces `ambiguous` attempts with zero duplicated side effects.

## Risks / notes

- `node:sqlite` stability is verified by `tech-guide.md`'s kickoff research; if it is still experimental, `better-sqlite3` is the fallback and the swap touches only `packages/store`.
- Do not build a "replay engine": the durability claim rests on _effect idempotency + reconciliation_, not on re-executing deterministic workflow code. Say so plainly in the README so nobody mistakes this for Temporal.

### Phase 9a — completion evidence (2026-11-01)

`contracts 121 · store 60 · core 50, `audit().divergences === []`after every flow,`kill -9`reconciliation covered by`recover``.

Full gate output, per-package suites and the four never-regress controls: [`evidence/phase-9-implementation.md`](evidence/phase-9-implementation.md). Whole-tree gate at close: `verify: 6 passed, 1 skipped, 0 failed` — `972 passed | 10 skipped (982)`.

**Unproven (audit 2026-11-01):** 19 `tsconfig.base.json` does not exist (one root `tsconfig.json` carries the same flags); 23 `Engine` has no `recordReceipt` — receipts are filed inside `observeAttempt`; 24 `packages/effects` has `enqueue`/`drain` but no per-kind handlers and **no production caller of `drain()`** (see `phase-13-audit.md` GAP-001); 25 no operator `retry` verb exists for `ambiguous` units; 42/43 the per-story and per-component deviation maps were never written; 47/48 no mutation-entry evidence; 56 `pnpm -r typecheck` was not run as such (root `pnpm run typecheck` is green); 58 the revert-dispatch mutation check was never recorded; 59 the `sqlite3 .schema`/`CHECK` transcript was never recorded.
