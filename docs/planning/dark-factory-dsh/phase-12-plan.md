# Phase 12 — Delivery

**Status:** pending
**Owner:** lead (+ `docs-author` for the runbooks/ADRs)
**Artifacts produced:** `/Users/bo/code/dark-factory-dsh/{README.md,AGENTS.md,CHANGELOG.md}`, `/Users/bo/code/dark-factory-dsh/docs/adr/001-…-006-….md`, `/Users/bo/code/dark-factory-dsh/docs/runbooks/{recovery,quarantine,budget-raise,first-promotion,holdout-authoring}.md`, `docs/planning/dark-factory-dsh/handover-checklist.md`, `evidence/` demo transcript

## Objective

Hand over a repo a stranger can operate and distrust correctly: documentation that matches what was actually built, six ADRs recording the decisions the debate produced, runbooks for the five operations that go wrong at 2am, a handover checklist, and an explicit **"what was NOT built"** list mirroring the OUT scope so nobody mistakes a fenced v1 for a finished product.

## Prerequisites

- Phases 1–11 closed (or explicitly `complete_with_override` with a recorded reason), Phase 11 evidence present under `evidence/`.
- `phased-plan.md > ## Scope fence > ### OUT` as the source for the not-built list; `architecture.md > ## 10. Alternatives considered and rejected` as the source for the ADR "rejected because" sections.

## Tasks

- [~] `/Users/bo/code/dark-factory-dsh/README.md` — what the factory is and is not, the three laws (L1 receipts-not-reports, L2 deterministic controls enforce / LLMs advise, L3 unknown is not pass), install + `pnpm run preflight` + the canonical commands block verbatim, the 3 human gates, the trust zones, and an honest limitations section (**planning against a hypothesis**; live model calls UNVERIFIED here).
- [ ] `/Users/bo/code/dark-factory-dsh/AGENTS.md` — agent-facing contract: what a worker may touch (worktree only), the receipt contract, that model prose is audit-only, the opaque-failure rule, and that the factory's ledger — never DSH — decides whether a unit ran.
- [ ] `/Users/bo/code/dark-factory-dsh/docs/adr/` — six ADRs, each with context / decision / consequences / alternatives-rejected / revisit-trigger: **001** four planes with the control plane owning all authoritative state · **002** SQLite WAL + append-only events + effect outbox instead of Temporal/Restate · **003** headless `dsh --profile factory-worker --json` subprocess per attempt (ACP the documented upgrade path) · **004** Docker container as the isolation boundary — the DSH sandbox is explicitly not one · **005** receipts-not-reports with a Δ-gated generator-blind holdout wall · **006** gates as capabilities (budget, destructive-op, initial-production deploy, credentials), never prompts.
- [ ] `/Users/bo/code/dark-factory-dsh/docs/runbooks/recovery.md` — `factory recover` after a crash/`kill -9`: what `ambiguous` means, why nothing is redispatched, how to re-observe under the original identity, when `retry` is legitimate.
- [ ] `docs/runbooks/quarantine.md` — how to quarantine a unit/class and the hard rule: never reset a quarantined store, never delete active markers, never unfence (inherited invariant 3).
- [ ] `docs/runbooks/budget-raise.md` — raising a spend envelope is human-only; what evidence to read first; how `unknown` reservations are reconciled.
- [ ] `docs/runbooks/first-promotion.md` — the signed `promotion.yaml` path, why the first promotion of any unit can never run dark, what the human is actually signing.
- [ ] `docs/runbooks/holdout-authoring.md` — writing spec-derived scenarios that never enter a worktree: storage location, revision bump, Δ baseline update, and the leak check to run afterwards.
- [ ] `docs/planning/dark-factory-dsh/handover-checklist.md` — one page: commands to run, env vars to set, the token paths, the three gates, and what "green" looks like on a fresh machine.
- [ ] `docs/planning/dark-factory-dsh/handover-checklist.md > ## What was NOT built` — mirrors all 9 OUT items: no real merge or production deploy, no live NUC/Railway/fleet deployment, no GitHub/Feishu intake, no ACP, no model routing, no multi-tenant/HA/K8s, no billing-grade accounting, no design system/SPA, no rewrite of `stapled-factory/`.
- [ ] `/Users/bo/code/dark-factory-dsh/CHANGELOG.md` — one entry in conventional format describing the v1 slice actually shipped.
- [~] Cleanup pass: remove dead code, commented-out blocks, scratch scripts, unused deps; `pnpm why` each of the three runtime deps to confirm they earn their place.
- [ ] Demo evidence: a terminal recording or transcript of `factory qualify|run|status|audit|receipts|promote` on the dogfood fixture → linked from `progress.md`.
- [~] Dependency + secret audit: `pnpm audit` reviewed (high/critical fixed or accepted with rationale in `progress.md`); `gitleaks detect` clean; `.env.example` matches `tech-guide.md > ## 6` env-var contract; no secrets in the repo.
- [ ] `progress.md` — final delivery entry with timestamp and the user sign-off line.

## Delegation plan

Two disjoint scopes run in parallel: **`docs-author`** → `README.md`, `AGENTS.md`, `docs/adr/**`, `docs/runbooks/**`; **`cleanup-auditor`** → dead-code/dependency/secret sweep reporting into `progress.md` (no file writes outside its own evidence note). The Lead owns `handover-checklist.md` and the sign-off, so the two agents never write the same file.

## Verification

### Hard Gates (copied verbatim from `done-means-done/phase-12-delivery.md`)

- [ ] **All earlier phases closed**: every non-skipped phase 1–11 is `complete`. Phases marked `skipped` or `complete_with_override` list a reason in `phased-plan.md`.
- [~] **README / docs updated**: user-facing documentation reflects what was actually built. Outdated sections edited, not abandoned.
- [ ] **Changelog / release note**: a single entry describing what shipped, in the project's conventional format (CHANGELOG.md, release description, PR body).
- [ ] **Demo evidence** _(where applicable)_: for UI / CLI features, a screenshot, terminal recording, or short GIF exists and is linked from `progress.md`.
- [ ] **Cleanup**: dead code, commented-out code, temporary scripts, and scratch files removed. Dependencies added during exploration but unused are removed.
- [ ] **Dependency audit**: `npm audit` / `pip-audit` / `cargo audit` (whichever applies) reviewed. High/critical issues either fixed or accepted with a logged rationale.
- [~] **Secrets & config**: no live secrets in the repo; `.env.example` updated if env-var contract changed; rotation recorded if any secret was exposed during work.
- [~] **Verification before completion applied**: the commands were run, the output was shown, and the evidence is attached for the final sign-off run.
- [ ] **User sign-off**: the user has explicitly confirmed the work is acceptable. Evidence: timestamped line in `progress.md`: `User signed off on delivery <date>: <quote or paraphrase>`.

### Project-specific evidence

- [ ] `docs/adr/` contains exactly six ADRs (001–006); each has context, decision, consequences, rejected alternatives and a revisit trigger, and 004 states that the DSH sandbox is **not** the security boundary.
- [ ] `docs/runbooks/` contains all five runbooks and `recovery.md` states that `factory recover` never redispatches an ambiguous attempt.
- [ ] `handover-checklist.md > ## What was NOT built` lists all **9** OUT items; `grep -c '^- ' ` on that section ≥ 9 and every item traces to `phased-plan.md > ## Scope fence > ### OUT`.
- [~] `README.md` carries the canonical command block verbatim from `tech-guide.md > ## 7` and an explicit limitations line ("live model calls UNVERIFIED on this machine; no real merge or deploy").
- [ ] `gitleaks detect` exits clean and `.env.example` keys match `tech-guide.md > ## 6` exactly (no extra, no missing).
- [~] Cleanup verified by `pnpm why commander zod pino` — three runtime deps, no unused dependency in any `package.json`.

## Acceptance criteria

A stranger can clone the repo, run the canonical commands, understand what the factory does and does not do, recover it after a crash from a runbook, and sign a first promotion deliberately — and the "what was NOT built" list makes the OUT scope as visible as the IN scope.

## Risks / notes

- "What was NOT built" is the honesty mechanism for this project: the OUT list includes _any real merge or production deployment_ and _live model calls are UNVERIFIED on this machine_, so the docs must not imply a working end-to-end dark factory against a live model.
- ADR 004 must state plainly that the DSH sandbox is **not** a security boundary (C8, research D3) — the container is. Getting this backwards would be the most expensive documentation error in the repo.
- Runbook `quarantine.md` is where inherited invariant 3 lives: a coordinated rollback of ledger and anchor is explicitly undetectable, and the runbook must say so rather than offering a "reset" procedure.

**Unproven (audit 2026-11-01):** 18 `README.md` was rewritten at `4ab57bf` and carries L1–L3, but not the verbatim canonical-command block or limitations line; 29/31/48/49 the cleanup, `gitleaks`, `npm audit` and verification passes were never recorded; 57 no verbatim command block exists.
