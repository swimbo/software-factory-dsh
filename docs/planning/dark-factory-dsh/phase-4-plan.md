# Phase 4 — User Stories

**Status:** in_progress
**Owner:** lead (+ `story-author` teammate)
**Artifacts produced:** `docs/planning/dark-factory-dsh/user-stories.md` (written by the `story-author` teammate — not the Lead)

## Objective

Turn R1–R7 and the 27 IN-scope deliverables into a prioritized, testable backlog with stable story IDs. Those IDs are the traceability spine for `e2e-tests.md`, every `phase-#-plan.md`, and `plan-gaps.md`, so the backlog must cover the IN list without inventing scope and must carry the P0 set that the three gates and the unknown-never-passes rule depend on.

## Prerequisites

- `phased-plan.md > ## Scope fence > ### IN` (27 deliverables) and `### OUT` (9 non-goals) fixed.
- `findings.md > ### The seven design requirements` (R1–R7) and `### Top findings, condensed` (P1–P8) available for `source:` links.
- `architecture.md > ## 3. Components` (C1–C10) as the capability vocabulary, and the 9a–9e split as the phase-mapping targets.

## Tasks

- [x] `user-stories.md` header — personas (`operator`, `worker agent`, `evaluator/wall`, `human gate signer`), the source taxonomy (`source: pain P#/R#` · `source: user request` · `source: internal`), and the ID convention `US-<area><n>` (e.g. `US-E3-02` for engine/attempts).
- [x] `user-stories.md` — every story in the canonical `As a <role>, I want <capability>, so that <outcome>` shape, with a non-empty `source:` line linking to a pain-point row/P requirement or flagged `source: user request` / `source: internal`.
- [x] `user-stories.md` — **≥2 acceptance criteria per story** in Given/When/Then form, each testable by a command or an artifact assertion (no "should feel right" criteria).
- [x] `user-stories.md` — `P0`–`P3` priority on every story with a one-line rationale, and a mapping to one or more of phases 9a–9e / 10 / 11 / 12 (no floating stories).
- [ ] `user-stories.md > ## Coverage sanity check` — a table mapping all 27 IN-scope deliverables to at least one story ID, so an uncovered deliverable is visible as a named gap rather than a surprise in Phase 13.
- [x] `user-stories.md > ## P0 set` — explicit coverage of **R1–R7**, the **three gates** (budget envelope, initial-production deploy, credential issuance) plus the destructive-operation gate, and the **unknown-never-passes** rule as its own P0 story with a failing test attached.
- [x] `user-stories.md > ## Deferred` — OUT-scope wishes (GitHub/Feishu intake, ACP, multi-tenant, design system, real merge) recorded as deferred with their reason, not dropped silently.
- [x] `user-stories.md` — non-functional stories: durability under `kill -9`, idempotency under replay, p95 control-plane latency < 50 ms, worker-cannot-read-holdouts, `NO_COLOR` output.
- [x] Lead read-only review: every `US-` id referenced by `architecture.md`/`e2e-tests.md` exists here; the P0 count is small enough to be walked through in Phase 11.

## Delegation plan

Single writer: `story-author` owns `user-stories.md`. The Lead reviews read-only and records the ID index that later phases must consume; no other agent writes this file, so there is no write-scope overlap with Phases 3, 5 or 6, which run concurrently on their own artifacts.

## Verification

### Hard Gates (copied verbatim from `done-means-done/phase-04-user-stories.md`)

- [x] **Pain reference**: every story links to at least one entry in `findings.md > ## Pain Point Research` OR is explicitly flagged `source: user request` / `source: internal`. No story may have an empty source.
- [x] **Canonical shape**: each story uses the form `As a <role>, I want <capability>, so that <outcome>`.
- [x] **Acceptance criteria**: each story has **≥ 2 acceptance criteria** written in `Given / When / Then` (or equivalent) form. Criteria are testable, not aspirational.
- [x] **Priority assigned**: every story is tagged `P0`, `P1`, `P2`, or `P3` (or equivalent) with a one-line rationale.
- [x] **Phase mapping**: every story is mapped to one or more of Phases 9–12. Unmapped stories are rejected or deferred, not left floating.
- [x] **Scope alignment**: every story is reconciled against `phased-plan.md > ## Scope`. Stories outside IN scope are either moved to a "Deferred" section or Scope is renegotiated with the user.
- [ ] **Coverage sanity check**: for each IN-scope deliverable in `phased-plan.md`, at least one story exists that exercises it.
- [~] **User review**: the story list has been presented to the user and confirmed. Confirmation noted in `progress.md`.

### Project-specific evidence

- [x] `user-stories.md` exists, is non-empty, and every story carries an ID, a `source:`, ≥2 Given/When/Then criteria, a priority with rationale, and a phase mapping.
- [ ] The coverage table lists all **27** IN-scope deliverables against ≥1 story ID each; zero blank cells.
- [x] The P0 set names all of R1–R7, all four gates, and one story whose acceptance criterion is literally "a skipped or missing measurement yields `unknown` and cannot promote".
- [ ] `grep -c 'As a ' user-stories.md` equals the number of story IDs (no orphan headings, no duplicate IDs).
- [ ] User confirmation of the story list recorded in `progress.md` before this phase flips to `complete`.

## Acceptance criteria

Every in-scope outcome has at least one testable, prioritized story mapped to a phase and traceable to a pain point, an R-requirement or an explicit user request — and the P0 set is sufficient that Phase 11 could walk all of it.

## Risks / notes

- The Phase 2 user review already fixed scope; this phase must **not** reopen it. Any genuinely new scope discovered here goes to `## Deferred` and, if it is a real IN gap, is reported to the Lead rather than absorbed into a story.
- "User review" for this phase is a genuine outstanding gate: `phased-plan.md` still lists Phase 4 as `pending`, while this file records `in_progress` because the artifact is being authored now. The status difference is intentional and flagged to the Lead.
- Story IDs are load-bearing for Phases 10, 11 and 13. Renaming an ID after Phase 10 starts breaks traceability, so the ID scheme is frozen once `e2e-tests.md` references it.

**Unproven (audit 2026-11-01):** 44 — `progress.md:12` records the scope exchange, not a story-list confirmation; no other record of that gate exists.
