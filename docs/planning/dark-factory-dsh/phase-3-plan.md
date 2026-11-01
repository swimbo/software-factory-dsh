# Phase 3 — Data Map

**Status:** in_progress
**Owner:** lead (+ `data-mapper` teammate)
**Artifacts produced:** `docs/planning/dark-factory-dsh/data-map.md` (written by the `data-mapper` teammate — not the Lead)

## Objective

Map every first-class entity, relationship, flow, access pattern, storage characteristic and invariant of the factory's single SQLite datastore, so Phase 5's components and Phase 9a's `schema.sql` can be written against a fixed data shape instead of re-litigating it. The data model is already pinned by R1/R4 and the inherited invariants: one append-only `events` table plus derived aggregates, in one WAL database.

## Prerequisites

- `phased-plan.md > ## Constraints` C7 (DSH is never the source of truth) and C8 read as data-shape constraints, not just policy.
- `findings.md` inherited invariants 1–5 (no redispatch, unknown stays unknown, never unfence, deterministic controls enforce, evidence honesty).
- `architecture.md > ## 5. Data ownership` exists as the ownership source of truth to reconcile against.
- Kickoff research for this phase is **skipped**, with the reason already recorded in `findings.md > ## Phase 3 (Data Map) Kickoff` (no queries run; the durability model and datastore are already pinned by the report §7 prior art and TD2). Flagged to the Lead as a deviation from the checklist gate.

## Tasks

- [ ] `data-map.md > ## Entities` — every first-class entity with a one-line definition and its lifecycle events (create/update/archive, and for append-only rows: append-only enforced): `unit`, `mandate`, `lane_decision`, `claim`, `lease`, `attempt`, `unit_event`, `receipt`, `verdict`, `holdout_scenario`, `wall_revision`, `delta_sample`, `gate_decision`, `spend_entry`, `issued_token`, `promotion`, `effect`, `session_tree`, `policy_version`.
- [ ] `data-map.md > ## Relationships` — cardinality (1:1 / 1:N / N:M) **and** owning component for every related pair, as an adjacency list plus a diagram: unit 1:N attempts, unit 1:N claims, attempt 1:1 receipt, unit 1:1 open lease, verdict 1:N delta_sample, verdict 1:1 promotion, unit 1:N spend_entry.
- [ ] `data-map.md > ## Flows` — at least three end-to-end flows with read/write boundaries named: (a) dark unit `submit → qualify → claim → dispatch → receipt → verify → verdict → promote`; (b) ambiguous-attempt reconciliation on `recover()` (read-only re-observation, no dispatch); (c) budget `reserve → settle(actual | unknown)` including the refusal path.
- [ ] `data-map.md > ## Access Patterns` — every query the system must answer, each tagged **read-heavy / write-heavy / mixed**, with the access path that serves it (e.g. "next dispatchable unit for a class" → read-heavy, indexed on `units(lane, state)`; "append events for a unit" → write-heavy, append-only).
- [ ] `data-map.md > ## Storage` — per-entity volumes, growth rate, retention policy and privacy/PII classification (source code and model transcripts, not personal data beyond operator identities; holdout scenarios are the one asset that must never be replicated into a worktree).
- [ ] `data-map.md > ## Identifiers & uniqueness` — primary keys, natural keys and uniqueness constraints per entity: `idempotency_key` unique on `effects`, `content_hash` unique on `receipts`/`verdicts`, one-open-lease-per-unit as a partial unique index, `(unit_id, attempt_no)` unique on `attempts`.
- [ ] `data-map.md > ## Validation & invariants` — required fields, value ranges and cross-entity invariants, stated as schema-enforceable rules where possible: a `passed` verdict is impossible without `receipt_id` + `holdout_revision` (`unknown` cannot be stored as pass); `events`/`receipts`/`verdicts` reject `UPDATE`/`DELETE`; a terminal unit cannot take a new claim.
- [ ] `data-map.md > ## Open questions` mirrored into `findings.md` tagged `NEEDS_HUMAN_DECISION` for anything Phase 5 or 9a cannot decide alone (e.g. soft-delete vs hard-delete for aborted units).
- [ ] Lead cross-check (read-only): every table named in `phase-9a-plan.md`'s schema task appears in `data-map.md > ## Entities`, and every entity in `architecture.md > ## 5. Data ownership` has exactly one owner here.

## Delegation plan

Single writer: the `data-mapper` teammate owns `data-map.md` exclusively. The Lead's scope on this phase is read-only review plus writing `NEEDS_HUMAN_DECISION` rows in `findings.md`, so the two write scopes (`data-map.md` vs `findings.md`) are disjoint and safe in parallel.

## Verification

### Hard Gates (copied verbatim from `done-means-done/phase-03-data-map.md`)

- [ ] **Kickoff research done**: `findings.md > ## Phase 3 Kickoff Research` lists 2–4 queries run, key deltas from training data, and link to primary sources. Time-boxed to 3–5 minutes.
- [ ] **Entity inventory**: `data-map.md > ## Entities` lists every first-class entity with a one-line definition and the lifecycle events (create/update/delete/archive).
- [ ] **Relationships**: `data-map.md > ## Relationships` describes cardinality (1:1, 1:N, N:M) and ownership for every entity pair with a relationship. Diagram or adjacency list present.
- [ ] **Flows**: `data-map.md > ## Flows` traces the end-to-end path of at least the top 3 user stories' data, naming read/write boundaries.
- [ ] **Access patterns**: `data-map.md > ## Access Patterns` enumerates the queries the system must answer (e.g. "list last 30 items for user X", "fetch item by slug"). Each is tagged read-heavy, write-heavy, or mixed.
- [ ] **Storage requirements**: `data-map.md > ## Storage` states estimated volumes, growth rate, retention policy, and privacy/PII classification per entity.
- [ ] **Identifiers & uniqueness**: primary keys, natural keys, and uniqueness constraints are declared per entity.
- [ ] **Validation & invariants**: required fields, value ranges, and cross-entity invariants are listed.
- [ ] **Open questions logged**: anything the user needs to decide (e.g. "soft delete vs. hard delete?") is tagged `NEEDS_HUMAN_DECISION` in `findings.md`.

### Project-specific evidence

- [ ] `docs/planning/dark-factory-dsh/data-map.md` exists, is non-empty, and contains all eight required sections.
- [ ] Cross-check output pasted into `progress.md`: every `architecture.md > ## 5. Data ownership` entity appears in `data-map.md > ## Entities` with exactly one owner; zero orphans in either direction.
- [ ] The three schema-enforcing invariants from Phase 9a (append-only triggers, `unknown`-cannot-pass `CHECK`, one-open-lease partial index) are represented in `data-map.md > ## Validation & invariants`, not invented later during implementation.
- [ ] `findings.md > ## Phase 3 (Data Map) Kickoff` states the skip reason explicitly, and the skipped-gate deviation is noted in `progress.md` for the Lead.

## Acceptance criteria

We know what data exists, how it connects (with cardinality and ownership), how at least three flows read and write it, what volumes/retention/PII it carries, and which invariants the schema must enforce — dense enough that Phase 9a commits to table shapes without re-interviewing anyone.

## Risks / notes

- **Checklist conflict:** the canonical Phase 3 gate requires a `## Phase 3 Kickoff Research` subsection with 2–4 queries. This phase skips kickoff research by design and records the reason in `findings.md`; the gate is copied verbatim and left unchecked. Lead to decide whether the recorded skip satisfies the gate (the bo-planning skill allows recorded skips; the done-means-done checklist has no skip condition).
- Do not let the data map drift into a workflow engine design: the durability claim rests on effect idempotency + reconciliation, not on re-executing deterministic workflow code.
- Holdout scenario rows are the highest-sensitivity data in the system (a leak voids R2); they are owned by the wall, stored outside every worktree, and referenced elsewhere only by id + hash.
