# Phase 5 — Architecture (+ mandatory Mode A debate)

**Status:** in_progress
**Owner:** lead (+ 5-persona Mode A debate fan-out)
**Artifacts produced:** `docs/planning/dark-factory-dsh/architecture.md`, `consensus-plan.md`, `evidence-ledger.md`, `debate-transcript.md`; `findings.md > ## Phase 5 Kickoff` + `## NEEDS_HUMAN_DECISION`

## Objective

Design the system — four planes, ten components, two API surfaces, integrations, infrastructure, NFRs — and then stress-test it adversarially before Phase 6 picks a stack. The draft commits to six proposals (four planes; SQLite WAL + event ledger + outbox instead of Temporal/Restate; headless `dsh` subprocess as the worker seam; Docker as the isolation boundary; receipts as the only decision input; Δ-gated holdout wall), each of which the debate must be able to overturn.

## Prerequisites

- `data-map.md` (Phase 3) supplies entity ownership; `findings.md` supplies R1–R7, the inherited invariants and TD1–TD8.
- `research/dsh-architecture.md` (D1–D12) and `research/kickoff-research.md` (Phase 5 deltas) as evidence for the debate.
- `phased-plan.md > ## Architecture decisions pre-committed for the debate` — the six proposals and their alternatives in `architecture.md > ## 10. Alternatives considered and rejected`.

## Tasks

- [x] `architecture.md` draft (**done**): design premise + laws L1–L3, planes diagram, §2.1–§2.4 per-plane detail, C1–C10 responsibility/owned-data/interface table, API surface with auth + idempotency + error semantics, data ownership, integrations, infrastructure, NFRs, top-3 failure domains, alternatives, and a `## 11. Debate Outcomes` placeholder.
- [x] `research/kickoff-research.md > ## Phase 5 Kickoff Research` (done by `kickoff-researcher`): 20 queries / 56 sources on durable TS orchestration, macOS agent sandboxing, DSH release + ACP status; four deltas recorded in `findings.md > ## Phase 5 (Architecture) Kickoff`.
- [x] Run the **mandatory Mode A `/debate`** with the argument `<path to architecture.md>` as a 5-persona fan-out (durable-execution skeptic, security/isolation reviewer, verification-and-evaluation critic, operator-UX pragmatist, DSH-integration realist), each producing cited arguments against the six proposals and their named alternatives.
- [x] `consensus-plan.md` — resolved decisions, the reasoning that survived, and any proposal the debate overturned.
- [x] `evidence-ledger.md` — every factual claim used in the debate with its source (research file + line, or URL), so an unsourced argument cannot win.
- [x] `debate-transcript.md` — round-by-round record naming the persona, the claim, the rebuttal and the outcome, referencing the **current** `architecture.md`.
- [x] Fold the consensus back into `architecture.md`: replace the `## 11. Debate Outcomes` placeholder with what changed, what was rejected and why, and any new component/API edits.
- [ ] Log every unresolved disagreement as a `NEEDS_HUMAN_DECISION` row in `findings.md` (the section currently reads "none yet"), each with the decision needed and the default if unanswered.
- [ ] `phased-plan.md > ## Delegated work` — add the debate row with status and artifact links.

## Delegation plan

Five personas run in parallel and are **read-only**: each reads `architecture.md`, `data-model`/research evidence, and returns its arguments — no persona writes a shared file. The Lead is the single writer of `consensus-plan.md`, `evidence-ledger.md`, `debate-transcript.md` and `architecture.md`, which removes write-scope overlap entirely; fan-out buys independent critique, not concurrent editing.

## Verification

### Hard Gates (copied verbatim from `done-means-done/phase-05-architecture.md`)

- [x] **Kickoff research done**: `findings.md > ## Phase 5 Kickoff Research` captures 2–4 queries on current architectural patterns and reference architectures for this domain, with deltas vs. training-data assumptions.
- [x] **Component boundaries**: `architecture.md > ## Components` names every service/module with responsibility, owned data, and public interface.
- [x] **API surface**: `architecture.md > ## API Surface` lists routes/operations/tools with method, shape, auth requirement, idempotency, and error semantics.
- [x] **Data ownership**: every entity from `data-map.md` has exactly one owning component — no ambiguous ownership.
- [x] **Integration points**: `architecture.md > ## Integrations` lists external services, auth, rate limits, and failure-mode handling.
- [x] **Infrastructure**: `architecture.md > ## Infrastructure` states deployment topology, environments, persistence, and secrets strategy.
- [x] **Non-functional requirements**: performance, scalability, availability, and observability targets recorded.
- [x] **Adversarial debate invoked**: /debate (with the argument "<path to architecture.md>") has been run. Evidence: `consensus-plan.md` and `debate-transcript.md` exist and reference the current `architecture.md`.
- [x] **Consensus incorporated**: `architecture.md` has been updated to reflect resolved decisions from `consensus-plan.md`. A `## Debate Outcomes` section summarizes what changed.
- [ ] **Unresolved items escalated**: any disagreements the debate could not resolve are logged in `findings.md` tagged `NEEDS_HUMAN_DECISION`.
- [ ] **User resolution**: every `NEEDS_HUMAN_DECISION` item from this phase is resolved by the user before the phase is marked `complete`. Resolutions recorded in `progress.md`.

### Project-specific evidence

- [x] `consensus-plan.md`, `evidence-ledger.md` and `debate-transcript.md` all exist and quote `architecture.md` section headings that still exist in the current file (no stale reference to a renamed §).
- [~] `architecture.md > ## 11. Debate Outcomes` is no longer the placeholder sentence — it lists each of the six pre-committed proposals as _upheld_, _modified_ or _overturned_.
- [~] `evidence-ledger.md` has no unsourced claim: each row cites a `research/*.md` line range or a URL.
- [~] Every `NEEDS_HUMAN_DECISION` row in `findings.md` has a stated default and a phase that blocks on it.

## Acceptance criteria

Components, APIs, data ownership, integrations and infrastructure are chosen and written down, stress-tested by a completed Mode A debate whose consensus is folded back into `architecture.md`, with every unresolved item escalated to the human.

## Risks / notes

- **Blocking condition:** this phase can never be `complete` without a completed debate; a skip requires explicit user override and yields `complete_with_override`. It is `in_progress` here precisely because the debate fan-out is running.
- The debate is the only place the six pre-committed proposals are allowed to lose. If no proposal is seriously contested, the debate was theatre — that is itself a finding for `consensus-plan.md`.
- Alternatives must stay honest: Restate/Temporal's ops burden, ACP's richer seam and Apple Containerization's egress allowlist are real and are recorded as revisit triggers, not dismissed.

**Unproven (audit 2026-11-01):** 52 `architecture.md §11` records amendments A1… and 'consensus: not reached' rather than adjudicating the six proposals as upheld/modified/overturned; 53 the evidence ledger's per-row sourcing was spot-checked, never machine-checked; 54 vacuous — `findings.md:225` is still the 'none yet' placeholder, so the per-row default/blocking-phase check passes on an empty set.
