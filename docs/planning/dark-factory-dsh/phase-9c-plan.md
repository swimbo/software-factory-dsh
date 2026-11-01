# Phase 9c — Implementation: The Wall (verification plane)

**Status:** pending
**Owner:** lead
**Artifacts produced:** `packages/wall/**`, `packages/wall/holdout/**` (scenario library), `packages/wall/selftest/**` (sabotage corpus), `scripts/wall-run.sh`

## Objective

Build the piece that makes the factory a factory: a **generator-blind verification plane** that (1) re-executes the worker's claimed commands in a clean environment, (2) runs holdout scenarios the generator never saw (triple-run, 2-of-3, ≥90% aggregate), (3) computes the visible-vs-holdout **Δ** per task class and refuses to certify classes where the wall is theatre, and (4) emits an opaque one-line failure the generator cannot game. The phase is done when a deliberately sabotaged change that passes its own visible tests **fails the wall** with an opaque reason — proven by a test that is red before the wall exists and green after.

## Prerequisites

- Phase 9a (store/engine — verdict persistence) **and** Phase 9b (`Executor` receipts).
- The sabotage-rejection proof is reached **before** 9b lands by using `FakeExecutor` synthetic receipts; it is re-run against a real headless receipt after 9b and the evidence file is **replaced, not appended** (contradiction X3).
- Holdout store location `~/.factory/holdout/` — must never appear in any worktree, container mount, DSH prompt or repo path (see leak tests).
- Evaluator signing key generated at `~/.factory/keys/evaluator.ed25519` (private key never mounted into a worker).

## Tasks

- [ ] `holdout/store.ts`: layout `~/.factory/holdout/<taskClass>/<scenarioId>.json`, a monotonic **holdout revision** (`sha256` over sorted scenario files), and file-mode checks that refuse to run if the store is readable by the worker's container user.
- [ ] `scenario.ts` + Zod schema: a scenario is `{id, taskClass, kind: 'http'|'cli'|'assert', steps[], expect[], severity}` — **derived from the spec, never from the implementation**; a scenario file carries no reference to the worker's diff.
- [ ] `reexecute.ts` (deterministic layer, runs FIRST): clean checkout of `base + receipt.diff` in a fresh container, replay `receipt.commands[]` verbatim, compare exit codes and full-suite output against the receipt. Mismatch → verdict `receipt_unfaithful`; never falls through to scenario scoring.
- [ ] `evaluate.ts`: triple-run each scenario against an ephemeral deployment, 2-of-3 per scenario, aggregate ≥90%, plus per-scenario severity weighting; a scenario that errors on infrastructure (not the candidate) is `unknown`, and **`unknown` fails the gate** (law L3).
- [ ] `delta.ts`: `Δ = visible_suite_pass_rate − holdout_pass_rate`, persisted per task class with a rolling sample; a class is `unstable` when Δ variance exceeds a configured bound or when the worker has ever been served that class's scenario text (leak check) → class cannot be certified `dark`.
- [ ] `feedback.ts`: the opaque failure line — `"<scenarioId> failed: <symptom>"`; asserts that the emitted line contains no scenario step text, no expected values, no path under `~/.factory/holdout`.
- [ ] `verdict.ts`: content-hashed (`sha256` over canonical verdict JSON) + ed25519-signed verdict receipt containing scenario ids/results, Δ, `holdoutRevision`, `policyVersion`, `receiptId`, `evaluatedAt`. The engine stores only ids + hashes.
- [ ] `selftest/`: **sabotage corpus** of ≥3 fixture changes that pass their own visible tests and must be rejected (hardcoded response, deleted assertion, test-only patch); a **leaky-wall** fixture proving a worktree cannot read the holdout store; a `wall self-test` command that runs the corpus as a regression gate.
- [ ] `criteria-log.ts`: append-only log of scenario versions + rationale, and a `wall revalidate` command producing a checklist for the scheduled human re-validation (R6).
- [ ] Tests: sabotage rejected (the mandatory red-then-green case); unfaithful receipt detected; Δ instability blocks certification; infrastructure error ⇒ `unknown` ⇒ gate fails; feedback line leaks nothing; verdict signature verifies and a tampered verdict fails; leak test (both path-based and container-based, `@docker`).
- [ ] `progress.md`: the red-then-green evidence for the sabotage test, verbatim command output.

## Delegation plan

Two parallel scopes:

- **Agent A (`wall-evaluator`)** — `evaluate.ts`, `delta.ts`, `feedback.ts`, `verdict.ts`, scoring tests.
- **Agent B (`wall-adversarial`)** — `reexecute.ts`, `selftest/**`, leak tests, `criteria-log.ts`, `wall self-test` command.
  Frozen surface: `scenario.ts` + verdict schema (Lead-owned) so both sides agree on the contract.

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

- [ ] **The wall-first proof**: `pnpm --filter @factory/wall test -- sabotage` fails before `evaluate.ts` exists and passes after — both runs pasted into `progress.md` (this is the phase's defining gate).
- [ ] `factory wall self-test` runs the full sabotage corpus and exits non-zero if any sabotage change is certified.
- [ ] A tampered verdict (edited scenario result) fails signature verification.
- [ ] Leak proofs: `rg -F "holdout" <worktree>` finds nothing; the `@docker` test shows `EACCES`/`ENOENT` reading the holdout store from inside the worker container.
- [ ] An infrastructure-error scenario produces `unknown` and the verdict is `not_passed` (never `passed`).
- [ ] Δ recorded for the fixture task class with a reproducible sample; an artificially unstable sample blocks certification.

## Acceptance criteria

A sabotage change that passes its own visible tests is rejected with an opaque one-line reason; an unfaithful receipt is caught before any scenario runs; `unknown` can never pass; and the wall's own blind spots are covered by a sabotage corpus and a leak test that run in CI.

## Risks / notes

- **The wall is the single point of failure** (pain-point counter-evidence #5). It is made of the same material as what it judges. The honest claim, recorded in the README, is: _independent + deterministic where possible + adversarially tested against itself + human-audited on a schedule_ — never "safe".
- Criteria drift (EvalGen) means scenarios rot. `criteria-log.ts` + `wall revalidate` exist so the rot is visible rather than assumed away.
- Scenario authoring is a human skill: v1's holdout library is deliberately small (one task class) and honest about it.

### Phase 9c — completion evidence (2026-11-01)

`wall 125 — 9-case self-test (9/9 met), ten mutation checks each turning exactly one test red, sabotage rejected`.

Full gate output, per-package suites and the four never-regress controls: [`evidence/phase-9-implementation.md`](evidence/phase-9-implementation.md). Whole-tree gate at close: `verify: 6 passed, 1 skipped, 0 failed` — `972 passed | 10 skipped (982)`.
