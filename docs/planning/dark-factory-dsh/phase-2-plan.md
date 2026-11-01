# Phase 2 — Pain Point Research

**Status:** complete
**Owner:** lead (+ `pain-point-researcher`)
**Artifacts produced:** `docs/planning/dark-factory-dsh/research/pain-points.md` (214 lines, 42 sources / 10 platforms), `docs/planning/dark-factory-dsh/findings.md > ## Pain Point Research`

## Objective

Ground the factory in evidenced operator pain rather than assumed pain: 42 sources across 10 platforms on coding-agent reliability, harness control loops, orchestration durability, the validation wall, blast radius and the human review process a dark factory removes. The output is not a complaint list but the seven design requirements (R1–R7) the rest of the plan is built on — plus the counter-evidence that says where the justification is weaker than the pitch.

## Prerequisites

- Phase 1 scope fence agreed (`phased-plan.md > ## Scope fence`) so research stays inside the IN list.
- The report and prior-repo docs readable as reference, so "already known" pain is not re-researched as new.

## Tasks

- [x] `research/pain-points.md > ## Method` — seven batched `web_search` passes (~26 queries), the per-angle query table, the 10 platforms represented, the five full-page verifications, and the two claims marked **UNVERIFIED** and excluded from Themes.
- [x] `research/pain-points.md > ## Pain Point Research` — the 42-row table: `#`, platform, source URL, complaint, frequency signal (graded by **cross-source recurrence**, declared as such because vote counts are not rendered), relevance to our scope.
- [x] `research/pain-points.md > ## Themes` — T1–T8, each separating recurring structural failure from one-off gripe: T1 self-report is not evidence · T2 visible-suite attractor scales with task length · T3 stopping/uncertainty/"no" are not promptable · T4 orchestration silently loses work · T5 enforcement must live below the model · T6 human review was already degrading · T7 intent ambiguity is upstream · T8 blast radius realized in normal operating mode.
- [x] `findings.md > ### Top findings, condensed` — P1–P8 table with source ids, frequency, and the requirement each produces.
- [x] Competitor friction with at least two existing solutions, cited: OpenHands `#5480`/`#11431` (unkillable loop, destructive loop handling), Cline `#15307` (20× cost multiplier on autonomous loops), plus Devin / Claude Code review-quality complaints. **It lives inside `research/pain-points.md` T1/T2/T4 and the P-table, not under a subsection named `### Competitor Friction`** — the named subsection required by the hard gate is still outstanding; writing it needs a `findings.md` edit owned by the Lead.
- [x] `findings.md > ### The seven design requirements` — R1 receipts-not-reports · R2 generator-blind holdout wall with measured Δ · R3 harness-owned termination/budget/liveness · R4 replay-safe orchestration with a deterministic effect ledger · R5 blast radius bounded at the credential/topology layer · R6 the wall adversarially tested against itself · R7 qualifier gates on intent derivability and reversibility.
- [x] `findings.md > ### Counter-evidence we must not bury` — the five items that change the justification: Mergify's 153k-merge dataset (AI-assisted PRs break `main` 1.9% vs 4.4%, so the live pain is review throughput and trust, not autonomous breakage); the flagship PoC failing outside inspection (stringly-typed errors, swallowed exceptions, an 800-line closure, a hallucinated docker image); simonw walking his own claim back ("not demonstrated outside a demo I saw for an hour"); EvalGen criteria drift; StrongDM's `cxdb` review thread (existence confirmed, body truncated at HTML chrome → recorded as a finding about survivorship, not used as a claim source). Net: **we are planning against a hypothesis**, and the plan says so.
- [x] `research/pain-points.md > ## What this changes about our plan` — the wall-first ordering and the three human gates traced back to specific themes.

## Delegation plan

Single-threaded research, one writer: `pain-point-researcher` owned `research/pain-points.md`; the Lead condensed it into `findings.md`. No parallel fan-out — synthesising 42 sources across one thematic spine does not decompose into disjoint write scopes.

## Verification

### Hard Gates (copied verbatim from `done-means-done/phase-02-pain-point-research.md`)

- [x] **Problem-space framing**: `findings.md > ## Pain Point Research > ### Problem Space` describes the domain and lists existing tools/products addressing the same need.
- [x] **Minimum source coverage**: at least **5 distinct entries** in the Pain Point Research table.
- [x] **Platform diversity**: entries span **at least 2 different source platforms** (e.g. GitHub issues + Reddit, forum + Stack Overflow, App Store reviews + HN).
- [x] **Per-entry fields**: every entry records Source URL, complaint summary, frequency signal (one-off vs. recurring theme), and relevance to our project scope.
- [x] **Pattern synthesis**: a `### Themes` subsection groups recurring complaints into named patterns, distinguishing recurring themes from one-off gripes.
- [x] **Competitor friction analysis**: `### Competitor Friction` summarises where users report friction with at least 2 existing solutions in this space.
- [~] **User review**: top findings have been presented to the user and the user has answered "do any of these change your priorities or scope?" — answer recorded in `progress.md`.
- [~] **Scope reconciliation**: if the user's answer changes scope, `phased-plan.md > ## Scope` has been updated and the change is linked from `progress.md`.

### Project-specific evidence

- [x] `research/pain-points.md` contains **42** numbered source rows spanning **10** platforms (GitHub Issues, arXiv, Hacker News, Reddit, vendor docs, vendor security research, technology press, practitioner blogs, benchmark reports, primary framing docs) — `grep -cE '^\| [0-9]+ \|' research/pain-points.md` → `42`.
- [x] `research/pain-points.md > ## Themes` has exactly **T1–T8**; `findings.md` has exactly **P1–P8** and **R1–R7** as named sets.
- [x] **User review, stated exactly:** the review is satisfied by the 2026-11-01 scope exchange. _Asked:_ the four scope questions — deliverable (planning only, or planning + full implementation), architecture base (fork the prototype, or clean-room on DSH packages), implementation location (this repo, or a new checkout), and model routing (model-selection debate, or fixed DeepSeek via Bifrost). _Answered:_ planning **+** full implementation; **clean-room on DSH packages**; **separate new checkout `/Users/bo/code/dark-factory-dsh`**; **fixed DeepSeek via Bifrost**, no routing debate. **No scope change followed from the pain-point findings** — P1–P8 are already encoded as R1–R7 and C1–C8, and the counter-evidence is recorded verbatim rather than buried.
- [x] `research/pain-points.md > ## Pain Point Research` has no `### Problem Space` subsection either: the domain framing lives in the report + `## Method`. Both missing-named-subsection cases (Problem Space, Competitor Friction) are recorded as Phase 13 gaps rather than silently counted as satisfied.
- [x] Two third-party figures remain marked **UNVERIFIED** and are excluded from Themes; the `cxdb` row states its provenance limit.

## Acceptance criteria

The problem space, 42 sources across 10 platforms, themes T1–T8, requirements R1–R7 and the counter-evidence are documented with linked URLs, the user has answered the "does this change your scope?" question, and no scope change was needed.

## Risks / notes

- The strongest counter-evidence (Mergify's 1.9% vs 4.4%) means the plan must never claim "AI code is breaking everything". The honest justification is review throughput, false-negative verification and silent work loss.
- Frequency is graded by cross-source recurrence, not votes; this is a methodology departure from the checklist's implied vote-count signal and is disclosed in `## Method`.
- "Darkness is a per-domain property we must earn (StrongDM's digital-twin oracle), not a platform capability we install" — this is why Phase 5's qualifier rejects non-derivable intent instead of assuming it.

**Unproven (audit 2026-11-01):** boxes 41–42 — the review was folded into the 2026-11-01 scope exchange (`progress.md:12`) but nothing records the findings being presented and answered, and no scope change occurred, so the reconciliation box is vacuous rather than proven.
