# Phase 7 — UX Planning (CLI-first)

**Status:** pending
**Owner:** lead (+ `ux-author` teammate)
**Artifacts produced:** `docs/planning/dark-factory-dsh/ux-plan.md` (written by the `ux-author` teammate — not the Lead); `findings.md > ## Phase 7 (UX Planning) Kickoff`

## Objective

Design the operator surface as a CLI-first experience: `factory intent | qualify | run | status | receipts | audit | promote | abort | recover`. Every P0 story needs a walked-through flow with its error, empty, loading and partial states, plus the one rule that makes a dark factory readable — the **human/agent message asymmetry**: a failure line must be opaque to the generator and complete for the operator.

## Prerequisites

- `user-stories.md` (Phase 4) with P0/P1 stories and their acceptance criteria.
- `architecture.md > ## 4. API surface` — the CLI verbs are thin clients over `submitUnit`…`recover`, so flows follow those operations.
- `findings.md > ## Phase 7 (UX Planning) Kickoff` — terminal UX practice, `NO_COLOR`, non-color state redundancy.

## Tasks

- [x] `ux-plan.md > ## Flows` — a step-by-step flow for **every P0 story**, entry point → command → output → outcome, with branch points and dead-ends named (`LANE_NOT_DARK`, `LEASE_HELD`, `BUDGET_EXCEEDED`, `GATE_REQUIRED`, `VERDICT_STALE`, `WALL_UNAVAILABLE`).
- [x] `ux-plan.md > ## Human / agent message asymmetry` — state the rule explicitly and give both renderings for one failure: to the **operator** `unit <id> attempt 2: holdout scenario 7 failed (Δ 0.31 exceeds class threshold 0.20); receipt attached`; to the **generator** exactly one opaque line `scenario failed: 500 on checkout` with no scenario text, expected values or holdout path.
- [x] `ux-plan.md > ## Interaction patterns` — exit codes per verb (0 success, non-zero typed failure), `--json` machine-readable mode for every verb, progress signals for long runs (`run` streams attempt state), state persistence across invocations (state lives in SQLite, never in the CLI process).
- [x] `ux-plan.md > ## Error handling` — for each flow: validation, missing-prerequisite, permission/token, budget and wall-unavailable errors, each with a recovery affordance and the exact `FactoryError.code`.
- [~] `ux-plan.md > ## Empty / loading / partial states` — no units yet, unit qualified but not run, attempt `ambiguous`, verdict pending, wall `unknown` — and the rule that a partial state renders as `unknown`, never as a blank success.
- [x] `ux-plan.md > ## Dark Pattern Audit` — the specific question for this product: **does "unknown" read as success anywhere?** Check every status render, every exit code, every summary line; also confirm no forced continuity, no confirmshaming on destructive verbs (`abort`, `quarantine`), no hiding of cost.
- [x] `ux-plan.md > ## Accessibility` — `NO_COLOR` honored, non-color state redundancy (`[PASS]`/`[FAIL]`/`[UNKNOWN]` tokens, not just green/red), screen-reader-safe table widths, plain-text fallback, no motion dependence.
- [x] `ux-plan.md > ## CLI standards` — 12-Factor CLI principles and the Heroku CLI standards mapped to this surface: help output for every verb, `--help` discoverable, stdout for data / stderr for diagnostics, idempotent verbs, no interactive prompts except an explicit confirm.
- [x] `findings.md > ## Phase 7 (UX Planning) Kickoff` — kickoff queries + deltas recorded (terminal UX practice, `NO_COLOR`/non-color meaning, message asymmetry; note that no WCAG-for-CLI standard exists, so WCAG 2.2 AA is applied to the status page and its equivalent discipline to the terminal).

## Delegation plan

Single writer: the `ux-author` teammate owns `ux-plan.md`; the Lead owns the kickoff block in `findings.md` and the read-only review of P0 flow coverage. Disjoint from Phase 8's `ui-plan.md`, which can run concurrently because the status page is composed from these flows, not authored by the same person.

## Verification

### Hard Gates (copied verbatim from `done-means-done/phase-07-ux-planning.md`)

- [x] **Kickoff research done**: `findings.md > ## Phase 7 Kickoff Research` captures current WCAG guidance, interaction patterns, and AI/agent UX references applicable to this project.
- [x] **Primary flows mapped**: `ux-plan.md > ## Flows` traces every P0/P1 user story step-by-step from entry to outcome, including branch points and dead-ends.
- [x] **Interaction patterns**: inputs, controls, navigation, state persistence, and feedback described per surface.
- [x] **Error handling**: every flow lists error states (validation, network, auth, permission, rate-limit) and recovery affordances.
- [~] **Empty / loading / partial states**: every flow calls out its empty, loading, and partial-data states.
- [x] **Accessibility**: WCAG 2.2 AA target declared and applied. Keyboard operation, focus order, screen-reader labels, contrast, motion preferences addressed.
- [x] **Dark pattern audit**: `ux-plan.md > ## Dark Pattern Audit` confirms we are not dark-patterning the user (no forced continuity, roach motels, confirmshaming, sneak-into-basket).
- [x] **CLI / TUI guidance** _(if applicable)_: 12-Factor CLI principles and Heroku CLI standards referenced; help output, exit codes, progress signals, machine-readable mode planned.
- [x] **IDE plugin guidance** _(if applicable)_: host-platform affordances (VS Code containers, JetBrains UI paradigms) respected.
- [~] **AI interaction guidance** _(if applicable)_: Microsoft HAX guidelines considered — disclose AI, handle uncertainty, allow correction/undo.
- [~] **Cross-reference to research**: `research/ux-design.md` cited where applicable.
- [x] **User stories covered**: every P0/P1 story from `user-stories.md` is represented in at least one flow.

### Project-specific evidence

- [x] `ux-plan.md` contains a flow for each P0 story ID (coverage table: story ID → flow name), zero unmapped P0 stories.
- [x] The dark-pattern audit answers the "does unknown read as success anywhere?" question with a concrete pass over `factory status`, `factory receipts`, `factory audit` and the promotion gate, not a generic disclaimer.
- [~] `grep -n 'NO_COLOR' ux-plan.md` shows it applied to every flow that renders state, and that state tokens survive `NO_COLOR=1` rendering (a terminal transcript is attached).
- [~] Every CLI verb in `phased-plan.md` IN item 23 appears in the flow set with `--help` and `--json` behaviour described.
- [x] No `research/ux-design.md` file exists — the cross-reference gate is recorded as "not applicable, evidence lives in `research/kickoff-research.md` §Phase 7" rather than silently skipped.

## Acceptance criteria

Every P0/P1 story has a walked-through CLI flow with explicit error, empty, loading and partial states; the human/agent message asymmetry and the "unknown is never success" rule are stated as testable constraints; and the CLI is accessible without color.

## Risks / notes

- `phased-plan.md` lists Phase 7 as `pending`; the artifact is a teammate deliverable in flight. Status here stays `pending` until the artifact lands.
- The message-asymmetry rule is a security property (R2's opaque feedback) expressed as UX. If the operator-facing and generator-facing strings share a code path, the opacity will erode — the plan should require two distinct formatters.
- Do not invent a TUI. The plan is CLI-first with plain stdout; the only graphical surface is Phase 8's read-only status page.

**Unproven (audit 2026-11-01):** 23/41 there is no empty/loading/partial-states section — the states are described inside flows and §5.5; 46 no Microsoft HAX or AI-interaction guidance anywhere (`grep -i hax ux-plan.md` → none); 47/55 `ux-plan.md:7` cites `research/ux-design.md`, which does not exist (DEV5 explains the deviation but the header still reads as a live citation); 54 no terminal transcript is attached to prove `NO_COLOR=1` rendering.
