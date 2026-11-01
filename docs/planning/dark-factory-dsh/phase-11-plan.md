# Phase 11 — Testing & Verification

**Status:** pending
**Owner:** lead (+ parallel evidence runs where the suites are disjoint)
**Artifacts produced:** `docs/planning/dark-factory-dsh/evidence/` (`test-summary.md`, `<suite>-<sha>.log`, `chaos-kill9.json`, `audit-trace.txt`, `dogfood-<sha>.json`), plus `progress.md > ## Test Results` and `## Errors`

## Objective

Run every layer for real and produce evidence a skeptic can check: the full offline suite, the `@docker` isolation suite, the panel Playwright suite, a `kill -9` chaos test, and `factory audit` traceability for one dark unit. The law applies to our own suite: **a skipped `@docker`/`@live` test is reported as `unknown`, never as pass.**

## Prerequisites

- Phases 9a–9e implemented, Phase 10 tests committed and discovered.
- Docker 29.8.2 available for `@docker`; **no** `BIFROST_API_KEY`/`DEEPSEEK_API_KEY` for any required suite (C5).
- Canonical commands from `tech-guide.md > ## 7` run from `/Users/bo/code/dark-factory-dsh`.

## Tasks

- [ ] Offline suite: `pnpm test` (unit + integration + CLI process e2e) — exit 0, output to `evidence/test-summary.md`; confirm it passes with no credential env vars set.
- [ ] `pnpm run typecheck`, `pnpm run lint`, `pnpm run format:check`, `pnpm run build` — each exit 0, output appended to `evidence/typecheck.log`, `evidence/lint.log`, `evidence/build.log`.
- [ ] `@docker` isolation suite: `pnpm test:docker` — container isolation, egress allowlist, holdout-store leak, signing-key absence. Log to `evidence/docker-suite.log`.
- [ ] Panel suite: `pnpm run panel` then `pnpm test:e2e:panel` — log to `evidence/panel-suite.log`; assert `unknown` renders as non-success.
- [ ] `kill -9` chaos test: kill the control plane mid-attempt, restart, run `factory recover`; record that the attempt is `ambiguous`, no redispatch happened, and no duplicate effect exists (`SELECT count(*) FROM effects WHERE idempotency_key = …` = 1) → `evidence/chaos-kill9.json`.
- [ ] `factory audit <unit>` on one completed dark unit — the trace from every decision to `(event, receipt, verdict, policyVersion)` → `evidence/audit-trace.txt`; every promotion row must resolve to a signed verdict.
- [ ] `pnpm run dogfood` — the offline full loop on `fixtures/dogfood` → `evidence/dogfood-<sha>.json`, with wall-clock timing recorded for the throughput NFR.
- [ ] `evidence/test-summary.md` — a suite table with command, exit code, timestamp, counts (passed/failed/skipped) and, for every skipped test, the literal word **`unknown`** with its reason; skipped never appears as passed.
- [ ] `evidence/MISSING.md` (or a section in `test-summary.md`) — the explicit unknowns: `@live` not run (no Bifrost key), real merge/deploy not exercised, live DSH model calls UNVERIFIED.
- [ ] Walk every P0 story's acceptance criteria in `user-stories.md` against a **live run** (not code inspection) and tick them in `progress.md`, citing the test id or evidence file per story.
- [ ] `progress.md > ## Errors` — zero open entries; each resolved entry carries its resolution, each accepted risk carries a user sign-off line.
- [ ] Manual pass against `ux-plan.md > ## Dark Pattern Audit` (especially: does `unknown` read as success in any command output?) and an accessibility spot-check of the panel (keyboard, focus order, contrast) — findings filed as `plan-gaps` rows if any.

## Delegation plan

Three disjoint evidence jobs can run in parallel because their write scopes are separate files: **`suite-runner`** → `evidence/{test-summary,typecheck,lint,build,dogfood}.log|json`; **`docker-chaos-runner`** → `evidence/{docker-suite.log,chaos-kill9.json}`; **`audit-runner`** → `evidence/audit-trace.txt`. The Lead owns `progress.md` and the P0 walkthrough, and reconciles the three outputs into `test-summary.md` — no two agents append to the same file.

## Verification

### Hard Gates (copied verbatim from `done-means-done/phase-11-testing-verification.md`)

- [ ] **Unit tests pass**: full suite run, exit code 0. Evidence: command + output timestamp.
- [ ] **Integration tests pass** (if present): exit code 0.
- [ ] **E2E / Playwright tests pass** (if Phase 10 applies): exit code 0; no tests skipped without a logged reason.
- [ ] **Lint clean**: canonical lint command exit code 0.
- [ ] **Type-check clean** (typed languages): exit code 0.
- [ ] **Build succeeds**: canonical build exit code 0.
- [ ] **User-story acceptance**: for each P0 story, acceptance criteria have been walked through and checked off. For web/CLI projects, this means a live run of the flow — not code inspection.
- [ ] **Dark-pattern sanity**: for UX projects, a manual pass against `ux-plan.md > ## Dark Pattern Audit` confirms no regressions.
- [ ] **Accessibility spot-check** (UI projects): keyboard navigation, focus order, and contrast sampled on primary flows. Issues filed as `plan-gaps` if found.
- [ ] **No unresolved errors**: `progress.md > ## Errors` has zero open entries.
- [ ] **Cross-plugin verification considered**: `/bo-planner-done` warnings on Enterprise Assessment, Design Compliance, and Test Coverage reviewed (if those artifacts exist). Blocker-class issues either fixed or explicitly accepted by the user in `progress.md`.

### Project-specific evidence

- [ ] `pnpm test`, `pnpm test:docker`, `pnpm test:e2e:panel`, `pnpm run typecheck`, `pnpm run lint`, `pnpm run format:check`, `pnpm run build`, `pnpm run dogfood` — each exits 0 with its timestamped log under `docs/planning/dark-factory-dsh/evidence/`.
- [ ] Every skipped `@docker`/`@live`/optional test appears in `test-summary.md` labelled **`unknown`** with a reason; a `grep -i unknown evidence/test-summary.md` shows the entries and no skipped test is counted in a pass total.
- [ ] `evidence/chaos-kill9.json` shows attempt state `ambiguous`, `recover()` dispatch count `0`, and one effect row per idempotency key.
- [ ] `evidence/audit-trace.txt` proves the traceability NFR: every decision line resolves to `(event, receipt, verdict, policyVersion)`, and no promotion exists without a signed verdict.
- [ ] `evidence/dogfood-<sha>.json` records ≥1 dark unit end-to-end offline and its wall-clock time.
- [ ] All 8 adversarial scenarios from Phase 10 are green in `pnpm test` / `pnpm test:docker` output; a missing or skipped safety test fails this phase.

## Acceptance criteria

Every automated layer is green with timestamped evidence, every P0 story has been exercised live and checked off, the chaos and audit evidence proves ambiguity is never redispatched and every decision is traceable, and the error log is empty.

## Risks / notes

- **`@live` is not part of this phase or of CI.** Live DSH model calls are UNVERIFIED on this machine; the honest report says so in `test-summary.md` rather than implying full coverage.
- The checklist points at `progress.md > ## Test Results`; this project also wants per-phase evidence under `evidence/`. Both are produced — `progress.md` holds the summary and timestamps, `evidence/` holds the raw logs.
- Docker-dependent suites can be skipped locally; they are **required for release**. If skipped, this phase cannot be `complete`, only `unknown`-carrying.
