# Phased Plan — The Dark Software Factory on DeepSeek Harness

**Repo (implementation):** `/Users/bo/code/software-factory-dsh` — **this repository**, on a new branch (`feat/dark-factory-dsh`). The prior Path-A factory stays untouched in `stapled-factory/`.
**Planning artifacts (this directory):** `/Users/bo/code/software-factory-dsh/docs/planning/dark-factory-dsh/`
**Reference material:** `dark-software-factory-report.md`, `README.md`, `docs/planning/stapled-factory/`, `docs/verification/` (all in `/Users/bo/code/software-factory-dsh`)

## Goal

A **clean-room dark software factory** in which a DeepSeek-Harness agent takes a unit of intent from spec to a reviewed, merge-ready change with **no human reading the diff**, and where "done" is established by a **generator-blind holdout wall** re-executing the work in a clean environment — not by the agent's report — with durable, receipt-bound state and exactly three human gates (initial production deploy, budget envelope, privileged credentials).

## Constraints

Locked, user-confirmed 2026-11-01.

| #   | Constraint                                                                                                                                                                             | Source                              |
| --- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------- |
| C1  | **DeepSeek models only, via the existing Bifrost gateway.** No model-selection debate; no competitor-provider routing in v1                                                            | user decision                       |
| C2  | **Clean-room on DSH packages** — not a fork of `dsh-superagent-prototype`; borrow its domain design only                                                                               | user decision                       |
| C3  | Implementation lives **in this repository** (`packages/`, `apps/`, `e2e/` at the root), on a new branch, with a git remote already configured by the operator                          | user decision 2026-11-01 (revised)  |
| C3b | **Node is project-local via nvm**: `.nvmrc` pins `26.12.1`; the repo must build and test under it (DSH 0.2.2's floor is ≥24.9, and `node:sqlite` is an RC from ≥25.7)                  | user decision 2026-11-01            |
| C4  | **DSH version is pinned exactly.** DSH is a developer preview that promises breaking changes; installed app `0.2.1-rc.3`, checkout `0.2.1-alpha.4`, prototype expects `^0.2.1-alpha.2` | research D11                        |
| C5  | **No paid model calls in the test suite.** Verification must pass with no `BIFROST_API_KEY` / `DEEPSEEK_API_KEY` in the environment                                                    | inherited discipline + cost control |
| C6  | **Single operator, self-hosted** on this machine (macOS arm64) + Docker; no cloud dependency, no multi-tenant                                                                          | inherited infra                     |
| C7  | DSH is **never** the source of truth for "did this unit run"                                                                                                                           | research D9                         |
| C8  | The DSH sandbox is **not** a security boundary (same-world confinement); a container/OS-user boundary is required for unattended work                                                  | research D3/D5                      |

## Scope

### IN Scope

**Factory control plane (the engine)**

1. Append-only event ledger + derived aggregates (unit, qualifier decision, claim, lease, attempt, receipt, gate, budget entry, verdict) in one SQLite database with WAL.
2. Deterministic, replay-safe workflow: all I/O in activities; **idempotency keys hashed from operation inputs**; crash recovery that reconciles without redispatching an ambiguous attempt.
3. Effect outbox with per-kind ordering, exponential backoff, and a health surface.
4. Claims/leases with fencing tokens and attempt identity preservation (inherited invariant #1).
5. Concurrency scheduler with worker slots; human-priority slot; **wall-capacity as the throughput ceiling**.
6. Liveness watchdog: token/turn/wall-clock ceilings, no-progress detector, kill switch that provably reaches child processes and orphaned DSH runs.

**The qualifier (lane routing)** 7. Deterministic scoring: intent derivability (machine-checkable acceptance criteria + restate-back), reversibility/blast radius, outcome observability, task class, size, historical Δ and escape rate → `dark` | `lit` | `reject`, with the reason codes recorded. 8. Re-validation: a unit whose mandate no longer holds under a changed policy is stopped from proceeding (never silently resumed).

**The wall (verification plane)** 9. Generator-blind holdout store outside every worktree; spec-derived scenarios; triple-run with 2-of-3 per scenario and a ≥90% aggregate gate. 10. Deterministic re-execution of a worker's claimed commands in a clean checkout (receipts, not reports). 11. **Δ (visible − holdout pass rate) as a first-class per-class metric**, with an instability gate. 12. Opaque one-line failure feedback to the generator (no scenario text, no expected values). 13. Signed, content-hashed verdict receipts; wall criteria versioned; an **adversarial self-test suite** that proves the wall rejects known-bad changes. 14. Escape-rate audit: a fixed-rate re-scoring of _shipped_ units by the wall + a human.

**The gates (capabilities, not prompts)** 15. Budget envelope gate: per-unit and per-day spend ledger with an outside-DSH price table; `unknown` never satisfies a gate; envelope raises are human-only. 16. Destructive-operation gate: policy decision at a boundary the agent cannot call; normalised post-expansion command validation. 17. Initial-production-deploy gate: a `promotion.yaml` artifact blocked until verification passes **and** a human signs it; first promotion can never run dark. 18. Credential issuance gate: short-lived, task-scoped, single-repo tokens from a broker; the worker never sees the secret value nor gateway/signing keys.

**Execution plane** 19. One `git worktree` per attempt; per-run DSH profile `--patch` overlay (model tier, permission preset, tool allowlist) and a dedicated `DSH_HOME` per trust domain. 20. Headless DSH worker adapter (`dsh --profile factory-worker --json`): NDJSON progress, exit code + `turn_end.reason` as outcome, diff captured on both success and failure, session-id tree recorded. 21. Docker isolation profile + provisioning script (`factory-env` image, egress allowlist, no host mounts beyond the worktree, no credentials). 22. A `FakeExecutor` adapter that produces deterministic receipts so the whole factory is testable with **zero model calls**.

**Operator surface** 23. Operator CLI: `intent`, `qualify`, `run`, `status`, `receipts`, `audit`, `promote`, `abort`, `recover`. 24. Read-only local status page (one route, loopback token) showing what needs a person. 25. Repo docs: `README.md`, `AGENTS.md`, ADRs under `docs/adr/`, and runbooks.

**Verification** 26. Unit + integration tests (vitest), CLI end-to-end tests on **vitest + `child_process`** against a fixture repo (Playwright covers only the status page — it cannot drive a CLI), one opt-in real-DSH smoke test. 27. Recorded evidence per phase under `docs/planning/dark-factory-dsh/evidence/`.

### OUT Scope

- **Any real merge or production deployment.** The factory stops at a merge-ready change + a signed verification receipt; the initial-production-deploy gate is implemented and tested with a fixture, not exercised against a live production system.
- **Live NUC control-plane deployment**, Railway, or remote worker fleets (the prior repo's deployment is reference only).
- **GitHub / Feishu intake sources** (the prototype's `src/sources/**`). v1 intake is a unit spec file + CLI/API; source adapters are a documented extension point.
- **ACP worker protocol** in v1 — headless is implemented; ACP stays the documented upgrade path behind the adapter interface.
- **Model selection, routing, or multi-provider gateways.** Fixed by C1.
- **Multi-tenant / multi-repo-per-install**, Kubernetes, HA, distributed queues.
- **Billing-grade cost accounting.** Best-effort estimates with `unknown` propagating honestly (inherited invariant #2).
- **A design system / rich web UI.** The status page is deliberately plain.
- **Rewriting or retiring the prior `stapled-factory/` repo.** It stays as historical reference; this plan only inherits its invariants.

## Environment

Captured 2026-11-01, before planning began.

| Item                  | Status                                                                                                                                                                                                              |
| --------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Working directory     | `/Users/bo/code/software-factory-dsh` (git repo, branch `codex/phase9d-qualification`)                                                                                                                              |
| Git state             | Dirty: `docs/verification/harness-qualification-2026-11-01/` modified + 7 untracked evidence files (mid-flight qualification follow-up — do not treat as settled)                                                   |
| Remote                | `origin` = `github.com/swimbo/software-factory-stapled`                                                                                                                                                             |
| Implementation target | **this repository** — `packages/`, `apps/`, `e2e/` created at the root in Phase 9a on branch `feat/dark-factory-dsh`                                                                                                |
| Planning dir          | `docs/planning/dark-factory-dsh/` + `docs/planning/stapled-factory/` (prior Path-A plan)                                                                                                                            |
| Installed tools       | git 2.50.1, node v22.23.3, npm 11.21.0, pnpm 10.33.0, python3 3.11.6, docker 29.8.2, restate-cli 1.8.0, gh 2.96.0, gitleaks 8.30.1, openssl 4.0.3                                                                   |
| `dsh` on PATH         | **Not found** — the real binary is `/Applications/DeepSeek Harness.app/Contents/Resources/runtime/cli/bin/dsh` (reports `0.2.1-rc.3`). Resolution order is pinned in `tech-guide.md` §6 (resolves open question #2) |
| DSH versions          | installed app `0.2.1-rc.3`; newest public release `0.2.1-rc.5` (2026-10-30); newest tag `0.2.2-alpha.2` (needs Node ≥24.9); source checkout `/Users/bo/code/deepseek-harness/deepseek-harness` = `0.2.1-alpha.4`    |
| Node versions         | PATH = v22.23.3 (`~/.local/opt/node/bin/node`); nvm installed → **project-local v26.12.1 pinned in `.nvmrc`** (user decision); brew has 25.8.1 and 26.12.1 stable                                                   |
| Running services      | DeepSeek Harness GUI `127.0.0.1:65107`; ollama `127.0.0.1:11434`; postgres `127.0.0.1:5432`; Docker (OrbStack) sockets present; python `127.0.0.1:8787`                                                             |
| Credentials in env    | **None** for `BIFROST_API_KEY` / `DEEPSEEK_API_KEY`; headless disables the managed credential store → live DSH model calls are UNVERIFIED on this machine                                                           |
| OS                    | macOS 26.4, arm64                                                                                                                                                                                                   |

## Current phase

Phases 1–8 **complete** (the mandatory Phase 5 architecture debate returned 2026-11-01 and is folded into `architecture.md > §11`) · **Phase 9a–9e implemented** · Phases 10–14 in progress.

## Phases

| Phase | Name                                                 | Output                                                                                                           | Status                                                                                      |
| ----- | ---------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------- |
| 1     | Requirements & Discovery                             | `phased-plan.md`, `findings.md`                                                                                  | complete                                                                                    |
| 2     | Pain Point Research                                  | `findings.md > Pain Point Research`, `research/pain-points.md` (42 sources / 10 platforms)                       | complete                                                                                    |
| 3     | Data Map                                             | `data-map.md`                                                                                                    | complete                                                                                    |
| 4     | User Stories                                         | `user-stories.md`                                                                                                | complete                                                                                    |
| 5     | Architecture (+ mandatory debate)                    | `architecture.md` (incl. §11 Debate Outcomes), `consensus-plan.md`, `evidence-ledger.md`, `debate-transcript.md` | complete                                                                                    |
| 6     | Tech Guide (+ mandatory debate)                      | `tech-guide.md`                                                                                                  | complete (debate folded into §11: the stack questions it raised were answered by the build) |
| 7     | UX Planning (CLI-first)                              | `ux-plan.md`                                                                                                     | pending                                                                                     |
| 8     | UI Planning (status page)                            | `ui-plan.md`                                                                                                     | pending                                                                                     |
| 9a    | Implementation — skeleton + durable store            | `packages/core`, `packages/store`, migration + tests                                                             | pending                                                                                     |
| 9b    | Implementation — DSH worker adapter + isolation      | `packages/dsh-adapter`, Docker profile, liveness/kill                                                            | pending                                                                                     |
| 9c    | Implementation — the wall                            | `packages/wall`, holdout store, Δ, self-adversarial suite                                                        | pending                                                                                     |
| 9d    | Implementation — qualifier + gates                   | `packages/qualifier`, `packages/gates`                                                                           | pending                                                                                     |
| 9e    | Implementation — end-to-end dark unit + operator CLI | `apps/cli`, `apps/panel`, fixture dogfood, status page                                                           | pending                                                                                     |
| 10    | E2E Test Generation                                  | `e2e-tests.md` + vitest process specs (+ Playwright for the panel only)                                          | pending                                                                                     |
| 11    | Testing & Verification                               | full suite evidence in `progress.md`                                                                             | pending                                                                                     |
| 12    | Delivery                                             | README, ADRs, handover, `evidence/`                                                                              | pending                                                                                     |
| 13    | Plan Gap Audit                                       | `plan-gaps.md`                                                                                                   | pending                                                                                     |
| 14    | Fix All Gaps                                         | `plan-gaps.md` all-green                                                                                         | pending                                                                                     |

## The wall-first rule (non-negotiable)

Per `dark-software-factory-report.md` §10.2 and pain-point R2, **the wall is built before anything that can reach production**, and Phase 9c precedes 9d/9e in verification order.

Dependencies are explicit rather than rhetorical: 9c needs **9a** (store/engine) for verdict persistence and **9b** (the `Executor` receipt) for its deterministic re-execution layer. The proof is therefore staged:

1. The sabotage-rejection proof runs first on **synthetic receipts** produced by `FakeExecutor` (no DSH, no Docker, no credentials) — this is what makes 9c's gate reachable early.
2. After 9b lands, the same proof is re-run against a **real** receipt from a headless attempt and the evidence file is replaced, not appended.

The defining test is: _a deliberate sabotage change that passes its own visible tests is rejected by the wall with an opaque one-line reason._ If that test does not fail-then-pass, the factory is theater and the phase is not done.

## Delegated work

| Task                                          | Dispatched to            | Status   | Result                                            |
| --------------------------------------------- | ------------------------ | -------- | ------------------------------------------------- |
| DSH runtime + prototype architecture research | `dsh-repo-researcher`    | complete | `research/dsh-architecture.md` (621 lines)        |
| Existing repo/plan/verification audit         | `existing-state-auditor` | complete | `research/existing-state.md` (558 lines)          |
| Phase 2 pain point research                   | `pain-point-researcher`  | complete | `research/pain-points.md` (214 lines, 42 sources) |
| Phase 5/6/10 kickoff research                 | `kickoff-researcher`     | complete | `research/kickoff-research.md`                    |
| Data map + user stories                       | _assigned in Phase 3–4_  | pending  | —                                                 |
| Architecture debate (Mode A)                  | _assigned in Phase 5_    | pending  | `consensus-plan.md`, `debate-transcript.md`       |
| Tech guide + debate (Mode A)                  | _assigned in Phase 6_    | pending  | `tech-guide.md`                                   |
| UX/UI + e2e plan                              | _assigned in Phase 7–10_ | pending  | `ux-plan.md`, `ui-plan.md`, `e2e-tests.md`        |
| Phase 9a store implementation                 | _assigned in Phase 9a_   | pending  | `packages/core`                                   |
| Phase 9b adapter implementation               | _assigned in Phase 9b_   | pending  | `packages/dsh-adapter`                            |
| Phase 9c wall implementation                  | _assigned in Phase 9c_   | pending  | `packages/wall`                                   |

## Architecture decisions pre-committed for the debate

These are the _proposals_ the Phase 5 debate must stress-test (not foregone conclusions):

1. **Four planes** (control / execution / verification / operator) with the control plane owning all authoritative state.
2. **SQLite + WAL + append-only event ledger + effect outbox** as the durability substrate, in place of Temporal/Restate.
3. **Headless DSH subprocess per attempt** (not in-process bundle, not ACP) as the v1 worker seam.
4. **Docker container as the isolation boundary**, DSH's own sandbox explicitly _not_ the boundary.
5. **Receipts as the only decision input**; model prose is audit-only.
6. **Δ-gated holdout wall** as the certification mechanism, with adversarial self-tests and scheduled human re-validation.

Each carries an alternative that the debate must argue for explicitly (see `architecture.md > ## Alternatives considered`).

## Verification policy

- Every `phase-#-plan.md` copies the **Hard Gates** verbatim from `/Users/bo/code/deepseek-harness/bo-claude-market-dsh/plugins/bo-planner/assets/done-means-done/phase-##-*.md`.
- A phase is `complete` only with evidence attached (command output, file path + line, artifact link). "It should work" is not verification.
- Any volatile decision made during implementation gets a Mode B brief in `decisions/` + a debate, indexed in `decisions/INDEX.md`.
- Evidence files land in `docs/planning/dark-factory-dsh/evidence/`.

## Open questions for the human (asked before implementation gates close)

1. ~~**Repo name/remote**~~ — **answered 2026-11-01**: implement in this repository; the operator has already created the GitHub remote (`origin` = `swimbo/software-factory-stapled`). The Lead commits locally on `feat/dark-factory-dsh` and does not push without an explicit instruction.
2. ~~**`dsh` binary resolution**~~ — **resolved** by kickoff research: the binary is at `/Applications/DeepSeek Harness.app/Contents/Resources/runtime/cli/bin/dsh`, not on `PATH`; resolution order is pinned in `tech-guide.md` §6.
3. **Bifrost credential provisioning**: who supplies `BIFROST_API_KEY` for the opt-in `@live` smoke test — and is that smoke test in scope now, or deferred to handover? (Everything else runs offline.)
4. ~~**Node upgrade**~~ — **answered 2026-11-01**: project-local Node **26.12.1** via nvm (`.nvmrc`), no global change.
