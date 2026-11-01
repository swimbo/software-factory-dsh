# Phase 9e — Implementation: End-to-End Dark Unit, Operator CLI & Status Page

**Status:** pending
**Owner:** lead
**Artifacts produced:** `apps/cli/**`, `apps/panel/**`, `fixtures/dogfood/**`, `README.md`, `AGENTS.md`, `docs/adr/**`

## Objective

Close the loop: one command takes a unit of intent from submission to a signed verdict and a merge-ready change, with the human seeing only what needs a person. This is the phase where the factory is judged as a _system_ — the dogfood run must show a full audit chain `unit → mandate → lane → attempt → receipt → verdict → promotion gate`, entirely offline.

## Prerequisites

- Phases 9a–9d complete; all suites green.
- `fixtures/dogfood/` — a tiny repo with a visible test suite and one holdout scenario class, used for both the fake and `@docker` paths.

## Tasks

- [ ] `.nvmrc` pinned to `26.12.1` + `engines.node` `>=24.9`; `scripts/preflight.sh` asserts the running Node satisfies it.
- [ ] `apps/cli`: verbs `intent`, `qualify`, `run`, `status`, `receipts`, `audit`, `promote`, `abort`, `recover`, `budget`, `wall`; global `--json`, `--config`, `--dsh-bin`; exit codes (`0` ok, `1` failed/refused, `2` usage, `3` unknown/ambiguous); data on stdout, progress on stderr; idempotent verbs safe to re-run.
- [ ] `apps/panel`: `node:http` server on loopback + token; `GET /` (single plain HTML page) and `GET /api/status` exactly matching `ui-plan.md`'s contract; no writes, no auth beyond the token, no external assets.
- [ ] Wire the full pipeline in one place (`pipeline.ts`): submit → qualify → (dark) dispatch → receipt → wall verify → verdict → promotion gate; `lit`/`reject` stop with reason codes surfaced to the operator.
- [ ] `fixtures/dogfood`: base app + visible suite + holdout scenarios + one sabotage variant + one unfaithful-receipt variant; `scripts/dogfood.sh` runs the whole loop with `FakeExecutor`.
- [ ] `factory audit <unit>`: prints the complete chain with ids and hashes, and asserts every decision has a provenance record; non-zero exit if any link is missing.
- [ ] `README.md`: what it is, the honest limitations (wall is not a security boundary; Δ can rot; DSH is pinned; no merge/deploy), quick start offline, and the three gates. `AGENTS.md`: codified knowledge for future agents (invariants, laws L1–L3, conventions, where the holdouts live and that they must never be read).
- [ ] `docs/adr/`: ADR-001 four planes, ADR-002 SQLite ledger vs durable workflow engine, ADR-003 headless worker seam, ADR-004 receipts-not-reports, ADR-005 Δ-gated wall, ADR-006 DeepSeek-via-Bifrost fixed routing.
- [ ] `progress.md`: the dogfood transcript, `factory audit` output, panel smoke output, and the `@docker` opt-in run result (or the explicit reason it is deferred).

## Delegation plan

Two parallel scopes:

- **Agent A (`cli-builder`)** — `apps/cli/**` + pipeline wiring + exit-code tests.
- **Agent B (`panel-builder`)** — `apps/panel/**` + status contract tests + the dogfood fixture repo.
  Docs (README/AGENTS/ADRs) written by the Lead after the code freezes.

## Verification

### Hard Gates (copied verbatim from `done-means-done/phase-09-implementation.md`)

- [ ] **Scope fidelity**: every IN-scope deliverable in `phased-plan.md` is represented by at least one merged/committed change. Nothing OUT-of-scope was implemented.
- [ ] **User-story coverage**: every P0 story from `user-stories.md` has a code path that fulfils its acceptance criteria. Evidence: story ID referenced in commit messages, code comments, or `progress.md`.
- [ ] **Architecture adherence**: implemented component boundaries match `architecture.md > ## Components`. Deviations were negotiated and recorded in `progress.md`.
- [ ] **Tech-guide adherence**: versions, conventions, and dev-env commands match `tech-guide.md`. Deviations recorded with rationale.
- [ ] **Subagent delegation used where required**: any phase with 2+ independent tasks dispatched parallel agents; delegation table in `phased-plan.md > ## Delegated Work` shows statuses and results.
- [ ] **Error log is clean**: `progress.md > ## Errors` has no open errors. Every entry is either `resolved` with resolution, or tagged `accepted_risk` with a user sign-off line.
- [ ] **3-strike protocol respected**: no task shows 3+ repeated identical failing attempts. Every failure has a mutation entry.
- [ ] **Mid-phase volatile decisions debated**: every decision made during Implementation that falls into a Volatile Decision Category (LLM/model, AI SDK, third-party API/service, datastore swap, framework version bump, dependency major, architectural pattern change, auth strategy, data contract, deploy/CI pattern, observability) has a Mode B decision brief in `docs/planning/decisions/`, a `/debate` outcome recorded in the brief, and an entry in `docs/planning/decisions/INDEX.md`. No silent adoption.
- [ ] **Secrets hygiene**: no secrets in code, commits, or planning files. `.env` present in `.gitignore` if used.
- [ ] **Build succeeds**: canonical build command from `tech-guide.md` runs to success locally. Output pasted or linked in `progress.md`.
- [ ] **Lint clean**: canonical lint command runs clean. Output linked.
- [ ] **Type-check clean** _(typed languages)_: type-check runs clean.

### Project-specific evidence

- [ ] `scripts/dogfood.sh` runs the full loop offline and exits 0; transcript in `progress.md` shows `unit → mandate → lane → attempt → receipt → verdict → promotion` with hashes.
- [ ] `factory audit <unit>` prints every link and fails loudly when one is removed (mutation check).
- [ ] `factory run` twice with the same unit creates exactly one attempt (idempotency at the CLI level).
- [ ] `factory status --json` validates against the `ui-plan.md` contract; the panel page renders `Needs you / Working / Recent verdicts / health` with no browser console errors.
- [ ] Kill -9 during the dogfood dispatch, restart with `factory recover` → attempt `ambiguous`, **no** second dispatch, audit chain intact.
- [ ] No secret appears in any receipt, log or `--json` output (grep proof).
- [ ] Every P0 story id appears in at least one test name or commit message.

## Acceptance criteria

An operator can submit intent, see a deterministic lane decision, watch a dark unit run to a signed verdict, and audit the whole chain — with the factory refusing to promote anything unverified, unsigned or unaffordable.

## Risks / notes

- The `@docker` and `@live` paths cannot be exercised without Docker credentials and a Bifrost key; they are opt-in and their absence must be reported as `unknown`, never as a pass (law L3 applies to our own test suite too).
- This phase is where "demo-ware" pressure is highest. The sabotage e2e test is the antidote: if it ever goes green for the wrong reason, the factory is theater.

### Phase 9e — completion evidence (2026-11-01)

`cli 95 · panel 116 — `--help`exit 0, exit codes 0–9,`status --json`validated by`parseStatus()`, token-gated read-only page`.

Full gate output, per-package suites and the four never-regress controls: [`evidence/phase-9-implementation.md`](evidence/phase-9-implementation.md). Whole-tree gate at close: `verify: 6 passed, 1 skipped, 0 failed` — `972 passed | 10 skipped (982)`.
