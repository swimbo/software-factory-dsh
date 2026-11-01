# Phase 13 — Plan Gap Audit

**Status:** pending
**Owner:** lead (+ per-artifact auditors on disjoint sections of `plan-gaps.md`)
**Artifacts produced:** `docs/planning/dark-factory-dsh/plan-gaps.md` (severity-ordered, every row with `open | fixed | wont_fix`)

## Objective

Diff the code that exists against every planning artifact and record every missing, partial or deviated item as one authoritative, severity-ordered gap list. This is the honesty checkpoint of the whole project: a row that says "we planned a signed verdict receipt and the promotion gate accepts a bare verdict" is worth more than a green test suite, and Phase 14 has nothing to work from without it.

## Prerequisites

- Phases 9a–9e implemented and Phase 11/12 evidence present — there is nothing to diff otherwise.
- All planning artifacts readable: `user-stories.md`, `architecture.md`, `tech-guide.md`, `ux-plan.md`, `ui-plan.md`, `e2e-tests.md`, and `phase-1-plan.md … phase-14-plan.md`.
- `docs/planning/dark-factory-dsh/decisions/` inspected for Mode B briefs (it exists but may be empty — an empty directory is itself a finding if Phase 9 made volatile choices).

## Tasks

- [ ] `plan-gaps.md` header — the severity rubric verbatim: `blocker` = IN-scope requirement missing or broken core flow · `major` = significant quality/accessibility/correctness gap · `minor` = cosmetic or low-impact drift · `nit` = style/polish; plus the allowed statuses `open | fixed | wont_fix`.
- [ ] `plan-gaps.md` completeness line — `Audited against: user-stories.md, architecture.md, tech-guide.md, ux-plan.md, ui-plan.md, e2e-tests.md, phase-1-plan.md … phase-14-plan.md`, with a stated reason for any artifact marked not applicable.
- [ ] Diff against `user-stories.md` — every story ID: does a code path exist that satisfies each acceptance criterion? Untraced stories become rows citing the story ID and the missing code location.
- [ ] Diff against `architecture.md` — every component C1–C10 and every API operation: implemented, partial, or absent; deviations from the declared interface (e.g. `recordReceipt` accepting an untrusted receipt) become rows.
- [ ] Diff against `tech-guide.md` — every pin and convention: actual `package.json` versions vs. §3, `types: ["node"]` / `erasableSyntaxOnly` in tsconfig, ≤3 runtime deps, prettier/eslint config, the canonical command names in `package.json` scripts.
- [ ] Diff against `ux-plan.md` — every flow and every error/empty/loading/partial state: is it implemented and reachable from a CLI verb? Is the generator-facing failure really opaque, or does it leak scenario text?
- [ ] Diff against `ui-plan.md` — every token, every state render, the `/api/status` contract field-for-field, measured contrast ratios as built, and the "unknown is not success" rendering.
- [ ] Diff against `e2e-tests.md` — every mapped story/flow has a test; all 8 adversarial scenarios exist and are green; no safety test is skipped or retried.
- [ ] Diff against each `phase-#-plan.md` — every unchecked task in `## Tasks` and every item in `## Verification`: satisfied, partial, or missing.
- [ ] Silent volatile decisions: any Phase 9 choice in a volatile category (datastore, dep major, auth strategy, deploy/CI, observability, data contract…) adopted without a Mode B brief in `decisions/` is recorded as a `major` gap.
- [ ] "Better than planned" deviations: where the implementation is genuinely better than the artifact, record a row recommending an **artifact update** rather than a code revert (soft check, prevents Phase 14 from making the code worse).
- [ ] Sort rows `blocker → major → minor → nit`, assign stable ids (`GAP-001`…), and cross-reference related rows so Phase 14 does not fix one twice.
- [ ] Present the list to the user, capture severity corrections and the `wont_fix` designations with rationale in `progress.md`.

## Delegation plan

Three auditors run in parallel over **disjoint sections of one document** — coordination is by pre-assigned id ranges, not by file locking: **`audit-stories`** (`plan-gaps.md` §stories+ux, ids `GAP-1xx`), **`audit-architecture`** (§architecture+tech-guide, `GAP-2xx`), **`audit-tests-docs`** (§e2e+ui+phase-plans, `GAP-3xx`). The Lead merges, re-sorts by severity and owns the user presentation — no agent edits another's section.

## Verification

### Hard Gates (copied verbatim from `done-means-done/phase-13-plan-gap-audit.md`)

- [ ] **Full artifact coverage**: the audit has diffed the implemented code against **each** of these artifacts:
  - `user-stories.md` (every story ID)
  - `architecture.md` (every component + API)
  - `tech-guide.md` (every version + convention)
  - `ux-plan.md` (every flow, error/empty/loading state)
  - `ui-plan.md` (every token, component, state)
  - `e2e-tests.md` (every mapped story/flow)
  - Each `phase-#-plan.md` (every task in Tasks + every item in Verification)
- [ ] **Per-gap fields**: every row in `plan-gaps.md` has: `id`, `source artifact`, `source item`, `gap type (missing | partial | deviated)`, `severity (blocker | major | minor | nit)`, `proposed fix`, `status (open)`.
- [ ] **Severity rubric applied**:
  - `blocker` — IN-scope requirement missing or broken core flow.
  - `major` — significant quality, accessibility, or correctness gap.
  - `minor` — cosmetic or low-impact drift.
  - `nit` — style / polish.
    Rubric stated at the top of `plan-gaps.md`.
- [ ] **No phantom gaps**: every gap cites a concrete source line (artifact file + heading) and, where applicable, a concrete code file + location showing absence or deviation.
- [ ] **No missed artifacts**: a completeness line at the top of `plan-gaps.md` of the form `Audited against: user-stories.md, architecture.md, tech-guide.md, ux-plan.md, ui-plan.md, e2e-tests.md, phase-1-plan.md … phase-N-plan.md`. Any "not applicable" entry lists the reason.
- [ ] **User review**: the gap list has been presented to the user. The user has confirmed severities (or corrected them) and identified `wont_fix` rows with rationale. Confirmation recorded in `progress.md`.
- [ ] **Sorted by severity**: `plan-gaps.md` rows are ordered `blocker → major → minor → nit`.
- [ ] **Silent volatile decisions flagged**: the audit has identified any volatile-category choice (LLM/model, AI SDK, third-party service, datastore, framework version, dep major, architectural pattern, auth strategy, data contract, deploy/CI, observability) that was adopted during Phase 9 without a Mode B debate brief. Each one is recorded as a `major` gap in `plan-gaps.md`.

### Project-specific evidence

- [ ] `plan-gaps.md` opens with the rubric and the completeness line naming all seven artifacts plus `phase-1-plan.md … phase-14-plan.md` (13 phase plans written by the plan author + the five 9a–9e lead plans).
- [ ] Every row cites an artifact heading **and** a code path; `grep -c 'GAP-' plan-gaps.md` equals the number of row ids, and the file is sorted blocker-first (verifiable by the id/severity column order).
- [ ] Specific expected rows are checked for rather than trusted: `recordReceipt` trust boundary, promotion gate accepting an unsigned/stale verdict, `unknown` rendered as success anywhere, holdout path reachability from a worktree, and any safety test that is skipped or retried.
- [ ] `docs/planning/dark-factory-dsh/decisions/INDEX.md` existence/emptiness is reported explicitly; if Phase 9 made volatile choices with no brief, each is a `major` row.
- [ ] User confirmation of severities and `wont_fix` set recorded in `progress.md` before any Phase 14 work starts.

## Acceptance criteria

There is an honest, complete, user-confirmed list of every way the implementation drifted from the plan — each row with an id, a source artifact + heading, a code location, a gap type, a severity from the stated rubric, a proposed fix and an `open` status — ordered by severity, with silent volatile decisions caught.

## Risks / notes

- The dangerous failure mode is a **flattering** audit: rows that describe only cosmetic drift while a gate is unwired. Mitigation is the explicit "expected rows" check above and requiring a code location for every row.
- Do not fix anything in this phase. A fix applied during the audit destroys evidence about what the audit found and makes Phase 14's before/after unverifiable.
- Blocker rows can never later become `wont_fix` (Phase 14 hard gate): if a blocker is genuinely out of scope, that is a scope renegotiation with the user, recorded in `phased-plan.md`, not a status change.
