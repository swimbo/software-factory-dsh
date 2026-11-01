# Phase 1 — Requirements & Discovery

**Status:** complete
**Owner:** lead (+ `dsh-repo-researcher`, `existing-state-auditor`)
**Artifacts produced:** `docs/planning/dark-factory-dsh/phased-plan.md`, `docs/planning/dark-factory-dsh/findings.md`, `docs/planning/dark-factory-dsh/research/dsh-architecture.md` (621 lines), `docs/planning/dark-factory-dsh/research/existing-state.md` (558 lines)

## Objective

Capture the direct request of 2026-11-01 in the user's words, pin the four scope decisions that constrain every later phase, fence IN/OUT scope for a dark software factory on DeepSeek Harness, and snapshot the actual machine so no downstream phase plans against an environment that does not exist. Done means the scope is fenced, the environment is known, and the user confirmed both.

## Prerequisites

- `/Users/bo/code/software-factory-dsh` checked out on branch `codex/phase9d-qualification`, with `dark-software-factory-report.md`, `README.md`, `docs/planning/stapled-factory/` and `docs/verification/` readable as reference material.
- No prior `docs/planning/dark-factory-dsh/` directory, and `/Users/bo/code/dark-factory-dsh` does not yet exist.

## Tasks

- [ ] `phased-plan.md > ## Goal` — the request in the user's terms: a unit of intent goes spec → reviewed, merge-ready change with **no human reading the diff**, certified by a generator-blind holdout wall re-execution, with exactly three human gates (initial production deploy, budget envelope, privileged credentials).
- [ ] `findings.md > ## Requirements` — the three request items: use the existing research/plan documents as reference; produce a bo-planner plan for a dark software factory; use DSH and the public `dsh-superagent-prototype` as the architecture base.
- [ ] `findings.md > ## Scope decisions` — the four user answers of 2026-11-01 each with its consequence: **deliverable** = planning artifacts + full implementation; **architecture base** = clean-room on DSH packages, not a fork of the prototype; **location** = separate new checkout at `/Users/bo/code/dark-factory-dsh`; **model routing** = fixed DeepSeek models via the existing Bifrost gateway.
- [ ] `phased-plan.md > ## Constraints` — C1–C8 locked, each with its source: C1 DeepSeek-only via Bifrost, C2 clean-room on DSH packages, C3 separate repo, C4 DSH version pinned exactly, C5 no paid model calls in the test suite, C6 single operator self-hosted on macOS arm64 + Docker, C7 DSH is never the source of truth for "did this unit run", C8 the DSH sandbox is not a security boundary.
- [ ] `phased-plan.md > ## Scope fence > ### IN` — 27 numbered deliverables across control plane (ledger, replay-safe workflow, outbox, claims/leases, scheduler, watchdog), qualifier, wall, gates, execution plane, operator surface, verification.
- [ ] `phased-plan.md > ## Scope fence > ### OUT` — 9 explicit non-goals: no real merge or production deploy, no live NUC/Railway/fleet deployment, no GitHub/Feishu intake, no ACP in v1, no model routing, no multi-tenant/HA/K8s, no billing-grade cost accounting, no design system or SPA, no rewrite of `stapled-factory/`.
- [ ] `phased-plan.md > ## Environment snapshot` — macOS 26.4 arm64; node 22.23.3 at `~/.local/opt/node/bin/node`; brew node 25.8.1 installed with 26.12.1 stable; pnpm 10.33.0; docker 29.8.2; postgres on `127.0.0.1:5432`; `dsh` 0.2.1-rc.3 at `/Applications/DeepSeek Harness.app/Contents/Resources/runtime/cli/bin/dsh`, **not on `PATH`**; cwd `/Users/bo/code/software-factory-dsh`, branch `codex/phase9d-qualification`, dirty `docs/verification/harness-qualification-2026-11-01/`; no model credentials in env.
- [ ] `phased-plan.md > ## Phases overview` — phases 1–14 with phase 9 split into 9a–9e (skeleton+store · adapter+isolation · wall · qualifier+gates · dark unit+CLI), each row carrying output and status.
- [ ] `findings.md > ## DSH architecture findings` + `### The prototype design we borrow` — D1–D12 and the clean-room borrow table (take the domain design, change the trust model).
- [ ] `findings.md > ## Technical decisions log` — TD1–TD8 with rationale and reversal cost.
- [ ] `phased-plan.md > ## Delegated work` — both research dispatches recorded `complete` with file and line counts.
- [ ] `phased-plan.md > ## Open questions for the human` — repo remote, `dsh` binary resolution, Bifrost credential provisioning for the opt-in smoke test.

## Delegation plan

Two research agents ran in parallel on disjoint write scopes, both read-only against the reference material: `dsh-repo-researcher` → `research/dsh-architecture.md` (DSH runtime + prototype architecture), `existing-state-auditor` → `research/existing-state.md` (prior repo / plan / verification audit). The Lead was the sole writer of `phased-plan.md` and `findings.md`, so no two agents ever targeted the same file.

## Verification

### Hard Gates (copied verbatim from `done-means-done/phase-01-requirements.md`)

- [ ] **Intent captured**: `phased-plan.md` has a one-paragraph problem statement written in the user's words, not the assistant's paraphrase.
- [ ] **IN scope fence**: `phased-plan.md > ## Scope > IN` lists concrete deliverables. No vague items like "improve X".
- [ ] **OUT scope fence**: `phased-plan.md > ## Scope > OUT` lists explicit non-goals. At least one non-trivial OUT item is present.
- [ ] **Environment snapshot**: `phased-plan.md > ## Environment` records: cwd, `git status` output summary, languages/frameworks detected, running services observed, existing `docs/planning/` state.
- [ ] **Constraints captured**: hard constraints (deadline, stack lock-in, compliance, budget, team) are listed in `phased-plan.md > ## Constraints`. Absence of a constraint is itself recorded ("None reported by user").
- [ ] **Phase overview drafted**: `phased-plan.md > ## Phases` lists which of phases 2–14 apply, which are skipped, and why.
- [ ] **User confirmation**: user has explicitly confirmed the scope fence. Evidence: timestamped line in `progress.md` of the form `User confirmed scope on <date>: <quote or paraphrase>`.

### Project-specific evidence

- [ ] `findings.md > ## Scope decisions` records **all four** answered questions (deliverable, architecture base, location, model routing) dated 2026-11-01 — the Phase 1 user confirmation.
- [ ] `phased-plan.md > ## Environment snapshot` lists every measured value; the `dsh` row states both the absolute path and `--version` = `0.2.1-rc.3`, and names the "not on PATH" constraint explicitly.
- [ ] `research/dsh-architecture.md` (621 lines) and `research/existing-state.md` (558 lines) exist, are non-empty, and are cited from `findings.md`.
- [ ] The dirty qualification tree is recorded as _mid-flight — do not treat as settled_, not as a clean baseline.
- [ ] `phased-plan.md > ## Current phase` agrees with the phases-overview status column.

## Acceptance criteria

Scope is fenced IN/OUT, the four scope decisions and constraints C1–C8 are locked with sources, the environment snapshot matches the machine as measured on 2026-11-01, and the user confirmed both.

## Risks / notes

- The canonical checklist addresses `docs/planning/phased-plan.md` and `docs/planning/progress.md`; this project nests its artifacts under `docs/planning/dark-factory-dsh/`. Paths are nested, not renamed — gate content is satisfied, but the `progress.md` confirmation line is currently carried by `findings.md > ## Scope decisions` until `progress.md` exists. Flagged to the Lead.
- Heading names differ from the gate wording: the plan uses `## Scope fence > ### IN/### OUT` (gate: `## Scope`), `## Environment snapshot` (gate: `## Environment`), `## Constraints (locked, user-confirmed 2026-11-01)` (gate: `## Constraints`), `## Phases overview` (gate: `## Phases`). Content matches; any automated gate check on exact headings will miss them. Flagged to the Lead rather than renamed, because `phased-plan.md` is outside this file's write scope.
- The dirty `docs/verification/harness-qualification-2026-11-01/` working tree is pre-existing operator state; no phase in this plan may commit, revert or "clean" it.
- Live model calls are **UNVERIFIED** on this machine (no `BIFROST_API_KEY`/`DEEPSEEK_API_KEY`); every offline phase must stay green with those unset (C5).
