# Phase 14 — Fix All Gaps

**Status:** pending
**Owner:** lead (+ one fixer per severity bucket, disjoint file scopes)
**Artifacts produced:** `docs/planning/dark-factory-dsh/plan-gaps.md` (every row `fixed` or `wont_fix`, zero `open`), `progress.md > ## Phase 14` per-gap resolutions, `evidence/reaudit.md`

## Objective

Close `plan-gaps.md` in severity order, with a re-run test per fix and a full-suite re-run at the end. The phase is done when every non-`wont_fix` row is `fixed` with evidence — not "mostly fixed", and never with a blocker converted into `wont_fix` to reach green.

## Prerequisites

- `plan-gaps.md` from Phase 13 is complete, severity-confirmed by the user, and every row is `open`.
- Phase 11 evidence exists so a fix's re-run can be compared against the pre-fix baseline.
- `decisions/` + `INDEX.md` ready: any fix that swaps a library/service/model/pattern needs a Mode B brief **before** its row flips to `fixed`.

## Tasks

- [ ] Fix every `blocker` row, one at a time, each with a commit referencing the gap id (`fix(gap): GAP-004 …`) and the re-run test output attached to the row.
- [ ] Fix every `major` row the same way; for any that will end `wont_fix`, obtain explicit user sign-off first and record it in `progress.md`.
- [ ] Fix `minor` and `nit` rows; `nit` rows may be closed with a single line of rationale if the fix would churn the code.
- [ ] Per-fix re-run: the test(s) exercising the fixed item are re-run and pass — command + output linked from `progress.md`, not summarised.
- [ ] Full-suite re-run at the end: `pnpm test`, `pnpm test:docker` (or its recorded `unknown`), `pnpm test:e2e:panel`, `pnpm run typecheck`, `pnpm run lint`, `pnpm run build`, `pnpm run dogfood` — all re-run after the last fix, timestamped in `progress.md > ## Test Results`.
- [ ] `plan-gaps.md` — flip each row to `fixed` (with commit SHA + re-run evidence) or `wont_fix` (with durable rationale pointing at scope/cost/external dependency, never "ran out of time").
- [ ] Mode B briefs: for each fix that introduces a replacement library, service, model or architectural pattern, write `decisions/<decision>.md`, run the `/debate` on it, and add the row to `decisions/INDEX.md` **before** flipping that gap row to `fixed`.
- [ ] Artifact updates: where the right fix is to correct a planning artifact rather than the code (a "better than planned" deviation), edit the artifact and mark the row `fix type: artifact-update`.
- [ ] `evidence/reaudit.md` — a quick re-check of the most-affected artifacts confirming the fixes introduced no new drift; one summary line plus the spot-check list.
- [ ] `findings.md > ## Follow-ups` — copy every `wont_fix` that should become future work.
- [ ] Present the cleaned `plan-gaps.md` to the user and capture the final sign-off line in `progress.md`.

## Delegation plan

Fix work is parallelised **only across disjoint file scopes** and **never across severity buckets** (that would break the monotonic ordering evidence): `fixer-core` → `packages/{core,store,effects}/**`; `fixer-exec` → `packages/{dsh-adapter,gates,qualifier,wall}/**`; `fixer-surface` → `apps/{cli,panel}/**` + `e2e/**`. The Lead sequences the buckets, owns every artifact edit and the `plan-gaps.md` flips, and runs the final full-suite re-run itself.

## Verification

### Hard Gates (copied verbatim from `done-means-done/phase-14-fix-all-gaps.md`)

- [ ] **Severity order respected**: `blocker` rows closed before `major`, `major` before `minor`, `minor` before `nit`. Evidence: timestamps in `progress.md` show monotonic order by severity bucket.
- [ ] **Zero open blockers**: `plan-gaps.md` contains no `blocker` rows with status `open`, `in_progress`, or `wont_fix`. Blockers **cannot** be accepted as `wont_fix`; they must be fixed or scope must be renegotiated with the user.
- [ ] **Zero open majors**: every `major` row is `fixed` or `wont_fix` with explicit user sign-off in `progress.md`.
- [ ] **Minors & nits**: every row is `fixed` or `wont_fix` (user sign-off line optional for `nit` but recommended for `minor`).
- [ ] **Per-fix evidence**: every `fixed` row cites the resolving commit SHA / PR / diff and the re-run test result.
- [ ] **Re-run relevant tests per fix**: tests exercising each fixed item were re-run and pass. Evidence: test output linked from `progress.md`.
- [ ] **Full-suite re-run at end**: after the last fix, the full test suite (unit + integration + e2e, as applicable) has been re-run and passes. Evidence timestamped in `progress.md > ## Test Results`.
- [ ] **Artifact reconciliation**: where a gap was resolved by updating a planning artifact (rather than code), the artifact edit is committed and `plan-gaps.md` notes `fix type: artifact-update`.
- [ ] **Volatile replacements debated**: any fix that introduces a replacement library, service, model, or architectural pattern (i.e. falls into a Volatile Decision Category) has a Mode B debate brief in `docs/planning/decisions/` and an entry in `decisions/INDEX.md` **before** its gap row is flipped to `fixed`.
- [ ] **Re-audit**: a quick re-check of the most-affected artifacts confirms no new drift was introduced by the fixes. Summary line in `progress.md`.
- [ ] **User final sign-off**: the user has confirmed `plan-gaps.md` is clean and the project is deliverable. Evidence: timestamped `progress.md` entry.

### Project-specific evidence

- [ ] `grep -c '| open' plan-gaps.md` → `0`; no `blocker` row carries `wont_fix`.
- [ ] Per-row evidence column populated for every `fixed` row: commit SHA **and** the re-run command's output (at minimum `pnpm test` filtered to the affected suite).
- [ ] `progress.md` timestamps show the bucket order blocker → major → minor → nit (not interleaved).
- [ ] The 8 adversarial scenarios from `e2e-tests.md` are still green after the last fix — a fix that weakens the sabotage/kill-9/leak tests to pass is a regression, not a fix.
- [ ] `pnpm test` after the final fix exits 0 with `BIFROST_API_KEY` and `DEEPSEEK_API_KEY` unset (C5 still holds).
- [ ] `evidence/reaudit.md` exists; `decisions/INDEX.md` lists every volatile replacement introduced by a fix, each predating its row flip.

## Acceptance criteria

Plan and implementation match: every gap row is `fixed` with a commit and a re-run result, or `wont_fix` with user sign-off and a durable rationale; no blocker was ever accepted; the full suite is green after the last fix; and the user has confirmed closure.

## Risks / notes

- The failure mode to refuse is "green by deletion": dropping or loosening a safety test to close a row. Any diff that touches a safety test is reviewed by the Lead specifically for whether it weakens the assertion.
- `wont_fix` on a `major` requires user sign-off; on a `blocker` it is forbidden — the only exit is fixing it or renegotiating scope in `phased-plan.md`.
- Every fix that changes a pinned version, datastore, auth approach or deploy shape is a volatile decision and needs its Mode B brief first; "it was a small change" is exactly how silent volatility enters a factory that claims determinism.
