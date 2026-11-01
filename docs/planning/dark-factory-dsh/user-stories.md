# User Stories — Dark Software Factory on DSH

**Status:** draft (Phase 4). Pairs with [`architecture.md`](architecture.md) (components C1–C10), [`data-map.md`](data-map.md) (entities, invariants I1–I16), [`phased-plan.md`](phased-plan.md) (scope fence, constraints C1–C8), [`findings.md`](findings.md) (R1–R7, P1–P8) and [`research/pain-points.md`](research/pain-points.md) (themes T1–T8).

**Conventions.** Every story has a `Pain-point link:` naming at least one of R1–R7 (from `findings.md`) and at least one of T1–T8 (from `research/pain-points.md`), plus the P-number it serves. Every acceptance criterion is a Given/When/Then whose _Then_ is checkable by an exit code, a stored row, a file, or an assertion — never by reading the diff. Component ids (`C1`–`C10`) are used exactly as defined in `architecture.md` §3.

---

## 1. Pain-point traceability

| Pain point                                             | Source                            | Stories                                                              |
| ------------------------------------------------------ | --------------------------------- | -------------------------------------------------------------------- |
| **P1** agent self-report is not evidence               | findings §Pain Point Research; T1 | US-E2-01, US-E2-02, US-E2-04, US-E3-01, US-E3-06, US-E6-01, US-E8-01 |
| **P2** optimising the visible suite; Δ grows with size | T2                                | US-E3-02, US-E3-03, US-E3-04, US-E3-07, US-E8-02                     |
| **P3** stopping/uncertainty is not promptable          | T3                                | US-E4-01, US-E4-02, US-E4-03, US-E1-04                               |
| **P4** orchestration silently loses work               | T4                                | US-E5-01, US-E5-02, US-E5-03, US-E5-04, US-E7-04, US-E2-03           |
| **P5** enforcement must live below the model           | T5                                | US-E4-05, US-E4-06, US-E1-03, US-E2-03, US-E3-08, US-E8-03           |
| **P6** human review already degrading                  | T6                                | US-E3-05, US-E3-09, US-E6-03, US-E7-01, US-E7-02                     |
| **P7** intent ambiguity upstream                       | T7                                | US-E1-01, US-E1-02, US-E1-04, US-E1-06                               |
| **P8** blast radius realised in normal operation       | T8                                | US-E1-04, US-E4-06, US-E4-05                                         |

| Theme                                      | Stories                                                    |
| ------------------------------------------ | ---------------------------------------------------------- |
| T1 self-report ≠ evidence                  | US-E2-01, US-E2-02, US-E2-04, US-E3-01, US-E3-06           |
| T2 visible-suite attractor / Δ             | US-E3-02, US-E3-03, US-E3-04, US-E3-07, US-E8-02           |
| T3 stopping is not promptable              | US-E4-01, US-E4-02, US-E4-03                               |
| T4 orchestration durability                | US-E5-01, US-E5-02, US-E5-03, US-E5-04, US-E5-05, US-E7-04 |
| T5 enforcement below the model             | US-E4-05, US-E4-06, US-E4-08, US-E4-09, US-E3-08, US-E8-03 |
| T6 human review degrading / criteria drift | US-E3-09, US-E6-03, US-E7-02                               |
| T7 intent ambiguity                        | US-E1-01, US-E1-02, US-E1-03, US-E1-04, US-E1-06           |
| T8 blast radius                            | US-E1-04, US-E4-05, US-E4-06, US-E4-09                     |

---

## 2. Personas

| Persona          | Kind                                     | Description                                                                                                                                                | What they need from the factory                                                                                                     |
| ---------------- | ---------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------- |
| **Operator**     | human, single                            | Writes unit specs, sets budget envelopes, holds the signing key, answers the three gates, runs the CLI. Does **not** read diffs — that is the whole point. | A truthful status view, an audit trail that answers "why did this get promoted", and the ability to stop everything in one command. |
| **Factory**      | system actor (C1–C3)                     | The control plane: engine, store, effects, scheduler, watchdog. Executes commands, owns all authoritative state.                                           | Deterministic command handlers, append-only events, idempotent effects, and recovery that never guesses.                            |
| **Worker Agent** | system actor, untrusted (C8 + DSH)       | One headless `dsh` run per attempt inside a container, on a throwaway worktree. Produces a receipt; its prose carries no authority.                        | A narrow, explicit contract: task text in, receipt out — and no credentials, no holdout access, no prod path.                       |
| **Wall**         | system actor, separate trust domain (C7) | Re-executes receipts, runs generator-blind holdout scenarios, computes Δ, signs verdicts. Its verdict is the only promotion input.                         | Its own `DSH_HOME`, its own key, a holdout store outside every worktree, and a self-test suite that tries to break it.              |
| **Auditor**      | human, future                            | Reconstructs any past decision months later — internal audit, post-incident review, or a "did the wall rot?" check.                                        | Append-only evidence, content-hashed receipts and verdicts, policy versions, and re-runnable scenario revisions.                    |

---

## 3. Epic E1 — Intake & Qualifier (C1, C4, C5 · phase 9d, storage 9a)

#### US-E1-01 — Non-derivable intent is rejected at intake

**As an** Operator **I want** `factory intent` to refuse any spec whose acceptance criteria cannot be evaluated by a command **so that** nothing unverifiable ever enters the dark lane.

- **AC1** — _Given_ a spec whose criterion `ac[2]` declares `checker_kind: prose`, _when_ `factory intent spec.yaml` runs, _then_ exit code is `2`, stderr matches `SPEC_NOT_MACHINE_CHECKABLE:ac\[2\]`, and `select count(*) from unit` is unchanged.
- **AC2** — _Given_ the same spec, _when_ it is submitted with `--force-lit`, _then_ the unit is created with `lane='lit'`, `runUnit` returns error code `LANE_NOT_DARK`, and no `attempt` row exists.
- **AC3** — _Given_ a valid spec, _when_ `factory intent` runs twice, _then_ both runs print the same `unitId` and `select count(*) from unit_spec` = 1.
- Priority: **P0** · Phase: **9d** · Pain-point link: **R7** (qualifier gates on intent derivability) · **T7** · **P7**

#### US-E1-02 — Restate-back must hash-match the spec

**As an** Operator **I want** the requester's restatement of intent stored and hash-compared before qualification **so that** assumption propagation is caught before any code exists.

- **AC1** — _Given_ a spec with `restate_back.text` describing a different outcome, _when_ `factory qualify <unit>` runs, _then_ the `lane_decision.reasons` contains code `RESTATE_BACK_MISMATCH` and `lane='lit'`.
- **AC2** — _Given_ `restate_back.hash` recomputed over `spec_canonical`, _when_ compared to the stored hash, _then_ a mismatch makes the unit `rejected` and the CLI exits `3`.
- Priority: **P0** · Phase: **9d** · Pain-point link: **R7** · **T7** · **P7**

#### US-E1-03 — Lane routing is deterministic and reproducible

**As the** Factory **I want** `qualifyUnit` to compute a lane from six recorded signals with no model in the decision path **so that** the same unit and policy always route the same way.

- **AC1** — _Given_ a fixed `(unit, PolicyVersion, task-class history)`, _when_ `qualifyUnit` runs three times in a fresh store rebuilt from the recorded inputs, _then_ `lane`, `score` and `decision_hash` are byte-identical across runs.
- **AC2** — _Given_ the qualifier package, _when_ the module dependency test runs, _then_ `packages/qualifier` has no import of any LLM client or network module (assertion over the import graph).
- **AC3** — _Given_ a `lane_decision` row, _then_ `signals` contains all six keys and every value is `pass|fail|unknown` with a numeric measurement.
- Priority: **P0** · Phase: **9d** · Pain-point link: **R7** · **R5** (controls in code) · **T5** · **T7** · **P5**

#### US-E1-04 — Irreversible or unobservable effects force the lit lane

**As the** Operator **I want** the qualifier to route any unit with irreversible operations or no observable oracle to `lit` **so that** blast radius is bounded before dispatch, not after an incident.

- **AC1** — _Given_ `operation_classes` containing `schema_migration` or `force_push`, _when_ `qualifyUnit` runs, _then_ `lane='lit'` and `reasons` includes `IRREVERSIBLE_OPERATION`.
- **AC2** — _Given_ a spec with `oracle: null`, _then_ `lane='lit'` with reason `UNOBSERVABLE_OUTCOME`.
- **AC3** — _Given_ a `lit` decision, _when_ `runUnit` is invoked, _then_ it returns `LANE_NOT_DARK` and zero containers are started (asserted via the Docker event count in the test double).
- Priority: **P0** · Phase: **9d** · Pain-point link: **R7** · **R5** · **T8** · **T3** · **P8** · **P3**

#### US-E1-05 — Intake is idempotent

**As the** Operator **I want** the same spec submitted twice to resolve to the same unit **so that** a retried command never creates a second unit to pay for.

- **AC1** — _Given_ a spec already submitted, _when_ `submitUnit` replays, _then_ the returned `unitId` is identical and `unit_event` gains no `UnitSubmitted` row.
- **AC2** — _Given_ a spec whose `intent_hash` differs but whose canonical hash collides (simulated), _then_ the error is `DUPLICATE_UNIT` and no row is written.
- Priority: **P1** · Phase: **9a** · Pain-point link: **R4** · **T4** · **P4**

#### US-E1-06 — A mandate is revalidated, never silently continued

**As the** Operator **I want** a unit whose mandate no longer holds under the current policy to be stopped **so that** a policy change cannot be bypassed by an in-flight unit.

- **AC1** — _Given_ a `qualified` unit whose `Mandate.policy_version` is retired, _when_ `factory qualify --revalidate` runs, _then_ `mandate.revoked_at` is set, a `PolicyRevalidated` event is appended, and `runUnit` returns `MANDATE_EXPIRED`.
- **AC2** — _Given_ a running attempt under a revoked mandate, _then_ the watchdog enqueues `kill_attempt` and the attempt ends `terminated`, never `completed`.
- Priority: **P1** · Phase: **9d** · Pain-point link: **R7** · **R5** · **T7** · **T5** · **P7**

---

## 4. Epic E2 — Execution & Receipts (C8, C4 · phase 9b)

#### US-E2-01 — A receipt replaces the report

**As the** Wall **I want** every attempt to end in a content-hashed receipt of diff + commands + exit codes + full suite output **so that** no decision ever depends on the agent's prose.

- **AC1** — _Given_ any attempt that reaches exit, _when_ the adapter collects, _then_ exactly one `worker_receipt` row exists with non-null `diff_binary`, `exit_codes`, `suite_output`, `artifacts`, `session_tree_ref`, and a `content_hash` that recomputes correctly.
- **AC2** — _Given_ the receipt, _when_ the type-check test compiles a decision-path function that accepts `WorkerReceipt`, _then_ it fails to compile unless the parameter type is `Omit<WorkerReceipt,'narrative'>` (assertion via `tsd`/`expect-type`).
- **AC3** — _Given_ a receipt whose `narrative` claims "all tests pass" but whose `suite_output` contains `FAIL`, _then_ the stored receipt is accepted and the claim has no effect on any verdict (no code path reads `narrative` — asserted by import/grep test).
- Priority: **P0** · Phase: **9b** · Pain-point link: **R1** · **T1** · **P1**

#### US-E2-02 — The diff is captured on failure too

**As the** Operator **I want** `git diff --binary` captured on exit 0 **and** exit 1 **so that** a failed run's useful work is not thrown away and can be audited.

- **AC1** — _Given_ a worker that exits 1 after editing two files, _when_ the receipt is collected, _then_ `diff_binary` is non-empty and `diff_sha` matches `sha256` of the blob.
- **AC2** — _Given_ a worker that exits 1 without touching the tree, _then_ `diff_binary` is an empty blob (not NULL) and `git status --porcelain` output is recorded in the artifacts.
- Priority: **P0** · Phase: **9b** · Pain-point link: **R1** · **T1** · **P1**

#### US-E2-03 — Each attempt runs on a pristine worktree with its own DSH home

**As the** Factory **I want** one `git worktree` per attempt from a pristine clone, a per-run `--patch` overlay, and a dedicated `DSH_HOME` **so that** runs cannot contaminate each other or inherit the operator's environment.

- **AC1** — _Given_ a dispatch, _when_ the attempt starts, _then_ `attempt_identity.worktree_path` is under `~/.factory/work/<unitId>/<attemptNo>` and `git -C <worktree> rev-parse HEAD` equals `base_revision`.
- **AC2** — _Given_ the per-run patch file, _then_ it sets provider `bifrost`, the worker tier, permission preset `workspace-write`+`never`, an explicit tool allowlist, `compression: none`, and no MCP servers (schema assertion on the generated YAML).
- **AC3** — _Given_ a worker process, _then_ its `DSH_HOME` is `~/.factory/dsh-home/worker` and the operator's `~/.dsh` is not readable from inside the container (leak assertion).
- Priority: **P1** · Phase: **9b** · Pain-point link: **R5** · **T5** · **P5**

#### US-E2-04 — Outcome comes from exit code and `turn_end.reason`

**As the** Factory **I want** attempt outcome derived only from exit code + `turn_end.reason` + NDJSON status **so that** a confident-sounding final message cannot be mistaken for success.

- **AC1** — _Given_ an NDJSON stream containing `final` with prose "done" and `turn_end.reason: aborted`, _then_ the attempt terminates `failed` and `terminal_reason='exit_1'`.
- **AC2** — _Given_ a `--json` stream whose strings are truncated at 8 KiB, _then_ the parser reads only `status`/`turn_end` fields and never `final` text for any decision.
- Priority: **P1** · Phase: **9b** · Pain-point link: **R1** · **T1** · **P1**

#### US-E2-05 — A conflicting receipt is never overwritten

**As the** Auditor **I want** a second, different receipt for one attempt to be refused **so that** evidence cannot be replaced after the fact.

- **AC1** — _Given_ an attempt with a committed receipt, _when_ `recordReceipt` is called with a different `content_hash`, _then_ it returns `RECEIPT_CONFLICT`, the original row is unchanged, and no `ReceiptRecorded` event is appended.
- **AC2** — _Given_ the same receipt replayed byte-identically, _then_ the call is a no-op returning the original `receiptId`.
- Priority: **P1** · Phase: **9b** · Pain-point link: **R1** · **R4** · **T1** · **T4** · **P1** · **P4**

---

## 5. Epic E3 — The Wall (C7 · phase 9c)

#### US-E3-01 — An unfaithful receipt is rejected by re-execution

**As the** Wall **I want** to replay the receipt's commands on a clean checkout and compare exit codes and suite output **so that** a claimed-but-unrun test cannot pass.

- **AC1** — _Given_ a receipt whose `suite_output` shows all tests passing, _when_ re-execution produces exit code 1, _then_ `verdict='fail'`, `reexecution.state='fail'`, `reexecution.exit_code_drift` is non-empty, and the opaque reason is `receipt_unfaithful`.
- **AC2** — _Given_ a faithful receipt, _then_ re-execution compares the full suite output hash and records `reexecution.state='pass'`.
- **AC3** — _Given_ a re-execution container, _then_ it is started from the receipt's `base_revision` plus `diff_binary` and has no access to the original attempt's worktree.
- Priority: **P0** · Phase: **9c** · Pain-point link: **R1** · **T1** · **P1**

#### US-E3-02 — The holdout store is generator-blind

**As the** Wall **I want** scenario bodies to live outside every worktree, container mount and worker prompt **so that** the generator cannot read or rewrite the test it is judged by.

- **AC1** — _Given_ a worker container, _when_ it runs `find / -path '*holdout*'` and `cat ~/.factory/holdout/scenarios/*`, _then_ both find nothing / fail with `ENOENT`, and the attempt's receipt still records `exit_code=0`.
- **AC2** — _Given_ any `holdout_scenario` row, _then_ `visible_to_generator = 0` and the only scenario content in the DB is `body_sha`/`expected_sha` (schema assertion).
- **AC3** — _Given_ the worker's task text, _then_ it contains no scenario id, expected value, or holdout path (string assertion over the generated task payload).
- Priority: **P0** · Phase: **9c** · Pain-point link: **R2** · **T2** · **P2**

#### US-E3-03 — Triple-run, 2-of-3, 90 % aggregate

**As the** Wall **I want** each scenario run three times and accepted only at 2-of-3, with a ≥ 90 % aggregate gate **so that** a single flaky run cannot certify a unit and a lucky run cannot rescue it.

- **AC1** — _Given_ a scenario passing 2 of 3 runs, _then_ it counts as passed and three `scenario_result` rows exist with `run_no` 1..3.
- **AC2** — _Given_ a scenario passing 1 of 3, _then_ it counts as failed and `holdout_pass_rate` excludes it.
- **AC3** — _Given_ `holdout_pass_rate = 0.89`, _then_ `verdict='fail'` with reason `holdout_below_threshold`; at `0.90` the aggregate gate passes.
- Priority: **P0** · Phase: **9c** · Pain-point link: **R2** · **T2** · **P2**

#### US-E3-04 — Δ is a first-class gate per task class

**As the** Operator **I want** `Δ = visible_pass_rate − holdout_pass_rate` recorded per verdict and tracked per task class with an instability gate **so that** I can see when the wall has stopped discriminating for a class.

- **AC1** — _Given_ a verdict with both rates known, _then_ exactly one `delta_sample` row is appended with the correct `delta`, `class_key`, and `unstable` flag.
- **AC2** — _Given_ the last 20 samples of a class with `σ(Δ) > sigma_max` from `PolicyVersion`, _then_ `unstable=1` and no unit of that class can be certified `dark` (qualifier reason `DELTA_UNSTABLE`).
- **AC3** — _Given_ `Δ > delta_threshold` for a class, _then_ `factory status` shows the class as `not-certifiable` and the qualifier routes new units of that class to `lit`.
- Priority: **P0** · Phase: **9c** · Pain-point link: **R2** · **T2** · **P2**

#### US-E3-05 — The sabotage corpus proves the wall rejects a passing-but-bad change

**As the** Auditor **I want** a self-test suite where a deliberate sabotage change passes its visible tests and is still rejected **so that** the wall is demonstrably doing something rather than being theater.

- **AC1** — _Given_ the sabotage corpus entry `assert-true-swap` — a change that makes the visible suite green while `assert true` replaces a real assertion — _when_ the wall self-test runs, _then_ the verdict is `fail` and the test reports pass-because-rejected.
- **AC2** — _Given_ the self-test run on a deliberately weakened wall (`holdout_threshold` forced to 0), _then_ the same test **fails**, proving the test has teeth (the fail-then-pass requirement from `phased-plan.md` §"The wall-first rule").
- **AC3** — _Given_ the corpus contains ≥ 5 sabotage class types (assertion neutering, evaluator rewrite, test deletion, output hard-coding, silent skip), _then_ every entry is rejected and each rejection is attributable to a named reason.
- Priority: **P0** · Phase: **9c** · Pain-point link: **R6** · **T2** · **T6** · **P2** · **P6**

#### US-E3-06 — Unknown never passes

**As the** Factory **I want** any unavailable measurement to become `verdict='unknown'` and block promotion **so that** a broken wall is never recorded as a passing wall.

- **AC1** — _Given_ the wall process is stopped, _when_ `verifyUnit` runs, _then_ `verdict='unknown'`, `visible_pass_rate` and `holdout_pass_rate` are NULL, the unit is `ambiguous`, and `promoteUnit` returns `VERDICT_MISSING`.
- **AC2** — _Given_ any schema, _when_ the schema lint runs, _then_ no table has a nullable `passed` boolean and `verdict.verdict` has exactly three values (schema assertion, invariant I5).
- **AC3** — _Given_ a verdict whose signature does not verify, _then_ the promotion path treats it as `unknown` and refuses.
- Priority: **P0** · Phase: **9c** · Pain-point link: **R2** · **R1** · **T1** · **T2** · **P1**

#### US-E3-07 — Feedback to the generator is opaque

**As the** Worker Agent **I want** exactly one line of failure feedback with no scenario text or expected values **so that** I cannot iteratively fit the holdout.

- **AC1** — _Given_ a failed scenario, _then_ the feedback string matches `^<scenario_id> failed: <symptom>$`, contains no `expected`, no value from `expected_sha`'s payload, and is ≤ 200 characters.
- **AC2** — _Given_ 10 consecutive failures on the same scenario, _then_ all 10 feedback strings are identical in shape and leak no additional detail (assertion over the concatenation).
- Priority: **P1** · Phase: **9c** · Pain-point link: **R2** · **T2** · **P2**

#### US-E3-08 — The wall cannot be reached from the worker

**As the** Auditor **I want** a containment test proving a worktree cannot read the holdout store, the evaluator key, or the gateway key **so that** the wall's separation is verified, not assumed.

- **AC1** — _Given_ the container, _then_ reading `~/.factory/holdout/`, `~/.factory/state/factory.db`, `$BIFROST_API_KEY` and the signing key each fails; the test asserts four distinct failures.
- **AC2** — _Given_ the egress allowlist, _then_ a request to any host other than the credential proxy is refused (asserted by a connection error, not a timeout).
- Priority: **P1** · Phase: **9c** · Pain-point link: **R5** · **R6** · **T5** · **P5**

#### US-E3-09 — Verdicts are signed, versioned and revalidated on a schedule

**As the** Auditor **I want** each verdict signed and bound to a `WallRevision`, with a human revalidation date **so that** criteria drift is detected rather than discovered later.

- **AC1** — _Given_ a verdict, _then_ its Ed25519 signature verifies against `~/.factory/holdout/evaluator.pub` and the row carries `wall_revision`, `holdout_revision_hash`, and `policy_version`.
- **AC2** — _Given_ a `WallRevision` past `revalidation_due_at` without `human_revalidated_at`, _then_ the qualifier adds reason `WALL_STALE` and routes new units of affected classes to `lit`.
- **AC3** — _Given_ a changed scenario set, _then_ a new `wall_revision` is frozen and old verdicts keep pointing at the old revision (no rewrite).
- Priority: **P1** · Phase: **9c** · Pain-point link: **R6** · **T6** · **P6**

---

## 6. Epic E4 — Gates & Budget (C1, C6, C8 · phases 9b/9d)

#### US-E4-01 — Ceilings are harness-owned

**As the** Operator **I want** token, turn and wall-clock ceilings enforced outside the model **so that** a run cannot spend past its envelope no matter what the agent decides.

- **AC1** — _Given_ `strength.ceilings = {tokens: 120000, turns: 40, wall_clock_s: 1800}`, _when_ usage projection crosses 120 000 tokens, _then_ the watchdog enqueues `kill_attempt`, `attempt.ceilings_hit` contains `token`, and the attempt ends `terminated`.
- **AC2** — _Given_ a run that tries to continue, _then_ the container is gone within 10 s of the breach (asserted by `docker inspect` returning not-found).
- **AC3** — _Given_ a breach, _then_ no `WorkerReceipt` marked complete exists and the unit cannot reach `verified`.
- Priority: **P0** · Phase: **9b** · Pain-point link: **R3** · **T3** · **P3**

#### US-E4-02 — No-progress is detected, not assumed

**As the** Factory **I want** a no-progress detector over NDJSON `status` events plus git tree-hash deltas **so that** a spinning agent is stopped before it burns the envelope.

- **AC1** — _Given_ 12 consecutive steps with no new tool call and an unchanged tree hash, _then_ `ceilings_hit` contains `no_progress` and the attempt is terminated with an opaque reason.
- **AC2** — _Given_ 12 steps that do change the tree hash, _then_ no termination occurs (the detector distinguishes working from repeating).
- Priority: **P0** · Phase: **9b** · Pain-point link: **R3** · **T3** · **P3**

#### US-E4-03 — The kill switch reaches descendants and orphans

**As the** Operator **I want** `factory abort` and the watchdog to kill the process group, the container, and any orphaned `dsh` run by session id **so that** nothing keeps running invisibly after I stop it.

- **AC1** — _Given_ a running attempt with two child processes, _when_ the kill fires, _then_ the process group is signalled, the container is removed, and `ps` shows no descendant with the attempt's session id within 10 s.
- **AC2** — _Given_ a `kill -9` of the control plane mid-attempt, _when_ the factory restarts and `recover()` runs, _then_ the orphan sweep terminates any surviving container by `attempt_identity.container_name` and records it in `RecoveryRun`.
- **AC3** — _Given_ a kill, _then_ a `KillIssued` event precedes the terminal event and the unit is `ambiguous` or `aborted` — never `verified`.
- Priority: **P0** · Phase: **9b** · Pain-point link: **R3** · **T3** · **T4** · **P3** · **P4**

#### US-E4-04 — Budget is reserved before dispatch and `unknown` blocks

**As the** Operator **I want** a spend reservation written before any container starts, settled with `actual` or `unknown` after, and both envelope and `unknown` enforced structurally **so that** spend cannot run away and missing telemetry cannot look like a pass.

- **AC1** — _Given_ an envelope of $2 with $1.90 spent, _when_ a projected $0.30 unit is dispatched, _then_ `BUDGET_EXCEEDED` is returned, no reservation exists, and zero containers start.
- **AC2** — _Given_ a completed attempt with no usage telemetry, _then_ a `spend_entry(kind='actual', amount_state='unknown', amount_usd=NULL)` row is written and the promotion path refuses with reason `SPEND_UNKNOWN`.
- **AC3** — _Given_ the day envelope is exceeded, _then_ `factory status` reports `budget.state='blocked'` and `runUnit` refuses for every unit until a human raises the envelope.
- Priority: **P0** · Phase: **9d** · Pain-point link: **R3** · **R4** · **T3** · **T4** · **P3** · **P4**

#### US-E4-05 — The worker never holds a production credential

**As the** Worker Agent **I want** only a short-lived, task-scoped, single-repo token injected by the proxy **so that** a compromised or confused run cannot reach a production path.

- **AC1** — _Given_ a dispatched attempt, _then_ the container env contains no `BIFROST_API_KEY`, no `DEEPSEEK_API_KEY`, no signing key, and no production credential (4 assertions over `docker inspect` env).
- **AC2** — _Given_ the broker, _then_ `issued_token` stores only `token_hash` (length 71), `expires_at − issued_at ≤ 2 h`, and `scope_repo` is exactly one repo.
- **AC3** — _Given_ a token past expiry, _when_ the proxy is called, _then_ it returns 401 and the attempt fails closed (no retry with a fresh token without a new gate decision).
- Priority: **P0** · Phase: **9d** · Pain-point link: **R5** · **T5** · **T8** · **P5** · **P8**

#### US-E4-06 — Destructive operations are classified on the normalised command

**As the** Factory **I want** policy to classify the post-expansion, wrapper-unwrapped argv at a boundary the agent cannot call **so that** `bash -c`, `eval` and quote tricks cannot route around the gate.

- **AC1** — _Given_ a command `bash -c 'g"it" push --force origin main'`, _then_ `command_record.normalised_command` is the unwrapped argv, `classification.classes` contains `destructive`, and the gate returns `deny` before execution.
- **AC2** — _Given_ `rm -rf` constructed via `xargs` from a file, _then_ the classification is still `destructive` (post-expansion, not string matching on the raw command).
- **AC3** — _Given_ a denial, _then_ `exit_code` is recorded as `126` with a gate id, the process is not started, and the receipt reflects the refusal.
- Priority: **P0** · Phase: **9d** · Pain-point link: **R5** · **T5** · **T8** · **P5** · **P8**

#### US-E4-07 — Human gate 1 — initial production deploy requires a signature

**As the** Operator **I want** `promote` to require a passing verdict **and** my signature, with the first promotion of any unit always signed **so that** nothing reaches production without a human having accepted it once.

- **AC1** — _Given_ a `verified` unit, _when_ `factory promote` runs without `--key`, _then_ exit code is `4`, error is `PROMOTION_UNSIGNED`, and no `promotion` row is written.
- **AC2** — _Given_ a valid signature, _then_ `promotion.state='signed'`, `human_signature` verifies, `is_first_promotion=1` for a unit's first promotion, and `promotion.yaml` is emitted.
- **AC3** — _Given_ a verdict older than `stale_after`, _then_ promotion fails with `VERDICT_STALE` even with a valid signature.
- Priority: **P0** · Phase: **9d** · Pain-point link: **R5** · **R6** · **T5** · **T6** · **P5** · **P6**

#### US-E4-08 — Human gate 2 — budget envelope raises are human-only

**As the** Operator **I want** an envelope raise to require my signature **so that** the agent can never widen its own budget.

- **AC1** — _Given_ a blocked budget, _when_ `factory budget raise --unit <id> --usd 5` runs without a key, _then_ it is refused and the envelope is unchanged.
- **AC2** — _Given_ a signed raise, _then_ a new `budget_envelope` row supersedes the old one, the old row is unchanged, and a `BudgetEnvelopeRaised` event is appended.
- **AC3** — _Given_ the agent's tool allowlist, _then_ no tool can write `budget_envelope` (assertion over the permission preset and the schema trigger).
- Priority: **P1** · Phase: **9d** · Pain-point link: **R3** · **R5** · **T5** · **P3**

#### US-E4-09 — Human gate 3 — privileged credential classes need a human close

**As the** Operator **I want** a `require_human` gate for privileged credential classes that only my signature can close **so that** the highest-blast-radius capability is never granted automatically.

- **AC1** — _Given_ a unit whose `capability_set` includes `network_egress`, _when_ the broker is asked for a token, _then_ `gate_decision='require_human'` is written and no token is minted until a signed close row exists.
- **AC2** — _Given_ a closed gate, _then_ `issued_token.gate_decision_id` references the close, and the request row remains immutable.
- **AC3** — _Given_ no human action, _then_ the unit stays `qualified` and the panel lists it under "waiting on a person" (one of exactly three such categories).
- Priority: **P1** · Phase: **9d** · Pain-point link: **R5** · **T5** · **T8** · **P5** · **P8**

---

## 7. Epic E5 — Durability & Recovery (C1, C2, C3 · phase 9a)

#### US-E5-01 — Idempotency keys are hashes of operation inputs

**As the** Factory **I want** every effect key computed as `sha256(canonicalJson(inputs))` **so that** a retry after a crash is a no-op, not a duplicate side effect.

- **AC1** — _Given_ two calls to `enqueue('dispatch_attempt', …)` with identical inputs, _then_ exactly one `effect` row exists and the second call returns the first result.
- **AC2** — _Given_ a grep/lint over `packages/effects` and `packages/core`, _then_ no idempotency key is built from `Date.now()`, `randomUUID()` or a retry counter (AST assertion).
- **AC3** — _Given_ the same logical operation retried 5 minutes later, _then_ the key is identical and no second container starts.
- Priority: **P0** · Phase: **9a** · Pain-point link: **R4** · **T4** · **P4**

#### US-E5-02 — The effect ledger is append-only and ordered per kind

**As the** Auditor **I want** every committed effect recorded permanently, with per-kind per-unit ordering and bounded backoff **so that** "did this already happen" is always answerable.

- **AC1** — _Given_ an effect marked `done`, _then_ its `result` is stored, the row is never deleted, and re-enqueueing the same key returns the stored result without re-executing the handler.
- **AC2** — _Given_ two effects of the same kind for one unit, _then_ they execute in `created_seq` order (observed order assertion).
- **AC3** — _Given_ a transient handler failure, _then_ `attempts` increments with exponential backoff and a `health()` surface reports the backlog; after N attempts the state is `dead` and an operator notification is enqueued.
- Priority: **P0** · Phase: **9a** · Pain-point link: **R4** · **T4** · **P4**

#### US-E5-03 — Recovery reconciles without redispatching

**As the** Factory **I want** startup reconciliation to mark open attempts `ambiguous` and re-observe them under their original identity **so that** a crash never produces a second, duplicate run.

- **AC1** — _Given_ a store with one `running` attempt whose container is gone and no terminal event, _when_ `recover()` runs, _then_ the attempt becomes `ambiguous`, a `RecoveryRun` row with `redispatched=0` is appended, and the container-start counter is unchanged.
- **AC2** — _Given_ a container still alive, _then_ `recover()` only reads its state (`observeAttempt`) and appends `AttemptObserved`; the identity row is not recreated.
- **AC3** — _Given_ a residual diff on the attempt worktree, _then_ a partial receipt may be collected and the wall may return `unknown`, but the unit cannot reach `verified` without a faithful receipt.
- Priority: **P0** · Phase: **9a** · Pain-point link: **R4** · **T4** · **P4**

#### US-E5-04 — `kill -9` at any point loses nothing and duplicates nothing

**As the** Operator **I want** the factory to survive being killed at any instant **so that** an interrupted run is a known state, not a mystery.

- **AC1** — _Given_ a chaos test that kills the control plane at 200 random points across a unit lifecycle, _then_ on every restart `PRAGMA integrity_check` returns `ok`, `unit_event.seq` is strictly increasing, and the aggregate replay hash matches (invariant I7).
- **AC2** — _Given_ the whole chaos run, _then_ the number of container starts equals the number of committed `dispatch_attempt` effects — zero duplicates.
- **AC3** — _Given_ a kill during receipt commit, _then_ either the receipt and its event exist together or neither does (single-transaction assertion).
- Priority: **P1** · Phase: **9a** · Pain-point link: **R4** · **T4** · **P4**

#### US-E5-05 — Claims and leases fence the writer

**As the** Factory **I want** one open claim and one open lease per unit with a monotonic fencing token **so that** two control-plane instances cannot both dispatch the same unit.

- **AC1** — _Given_ two `runUnit` calls racing on one unit, _then_ exactly one dispatch occurs and the other returns `LEASE_HELD`.
- **AC2** — _Given_ a stale holder whose `fencing_token` is behind the open lease, _when_ it attempts a state transition, _then_ the write is rejected with `LEASE_FENCED` and no event is appended.
- **AC3** — _Given_ an expired lease, _then_ the attempt becomes `ambiguous` — never `failed`, never retried automatically.
- Priority: **P1** · Phase: **9a** · Pain-point link: **R4** · **T4** · **P4**

#### US-E5-06 — Append-only is enforced, and a quarantined store is never reset

**As the** Auditor **I want** the database itself to refuse updates/deletes on ledger tables and a corrupt store to be quarantined rather than repaired in place **so that** evidence cannot be silently rewritten.

- **AC1** — _Given_ any ledger table, _when_ an `UPDATE` or `DELETE` is attempted, _then_ SQLite raises `APPEND_ONLY_VIOLATION` (17 table assertions).
- **AC2** — _Given_ a store that fails `integrity_check` or the replay hash, _when_ the factory starts, _then_ it exits `EXIT_QUARANTINE`, copies the store to `~/.factory/quarantine/<utc-iso>/`, and never mutates the original.
- **AC3** — _Given_ a quarantined directory, _then_ no code path in the CLI can point the factory at it for writing (assertion: `Store.open()` requires a `--read-only` flag for quarantine paths).
- Priority: **P1** · Phase: **9a** · Pain-point link: **R4** · **R6** · **T4** · **P4**

---

## 8. Epic E6 — Observability & Audit (C1, C3 · phases 9e/11)

#### US-E6-01 — Every decision resolves to event + receipt + verdict + policy

**As the** Auditor **I want** `factory audit <unit>` to print the full chain **so that** any promotion can be reconstructed without trusting a summary.

- **AC1** — _Given_ a promoted unit, _when_ `factory audit <unit>` runs, _then_ the output contains, for every state transition, the `unit_event.seq`, the `receipt_id` + `content_hash`, the `verdict_id` + signature state, and the `policy_version` — machine-parseable with `--json`.
- **AC2** — _Given_ the audit output, _when_ every hash in it is recomputed, _then_ all match (no field in the chain is unverifiable).
- **AC3** — _Given_ an `ambiguous` unit, _then_ the audit names the open identity, the observation results, and the absence of a terminal event — with no invented cause.
- Priority: **P0** · Phase: **9e** · Pain-point link: **R1** · **R6** · **T1** · **T6** · **P1** · **P6**

#### US-E6-02 — Status shows what needs a person, and what it costs

**As the** Operator **I want** one status surface with lane counts, budget rollup including `unknown`, Δ per class, outbox health and the three gate queues **so that** I can run the factory in under a minute a day.

- **AC1** — _Given_ a mixed store, _then_ `factory status --json` contains `units.byState`, `budget.estimatedUsd`, `budget.unknownCount`, `delta.byClass`, `effects.byState`, and `waitingOnPerson` with exactly the three gate categories.
- **AC2** — _Given_ `unknown` spend entries, _then_ `budget.unknownCount > 0` and the total is explicitly marked `estimated: true` (never silently summed as if known).
- **AC3** — _Given_ a dead effect, _then_ `effects.byState.dead > 0` and the status exits non-zero under `--check`.
- Priority: **P1** · Phase: **9e** · Pain-point link: **R3** · **R4** · **T4** · **P3** · **P4**

#### US-E6-03 — Shipped units are re-scored at a fixed rate

**As the** Auditor **I want** a fixed-rate sample of promoted units re-scored by the wall and reviewed by a human **so that** "we are wrong about how wrong we are" has a number.

- **AC1** — _Given_ 10 emitted promotions, _then_ exactly one `escape_audit` row exists with `rate_bucket='1-in-10'` and `human_review_state='pending'`.
- **AC2** — _Given_ a re-score that fails, _then_ `wall_rescore_verdict_id` is appended (the original verdict is unchanged) and `human_review_state='escaped'` with an `escape_class`.
- **AC3** — _Given_ any escape found, _then_ `factory status` reports the escape rate for the class and the qualifier adds reason `ESCAPE_RATE_HIGH` for that class.
- Priority: **P1** · Phase: **9e** · Pain-point link: **R6** · **T6** · **P6**

---

## 9. Epic E7 — Operator Surface (C9, C10 · phase 9e)

#### US-E7-01 — One CLI with named verbs and fail-closed errors

**As the** Operator **I want** `factory intent|qualify|run|status|receipts|audit|promote|abort|recover` to be the entire surface **so that** operating the factory needs no web UI and no prompt engineering.

- **AC1** — _Given_ each verb, _when_ run with `--help`, _then_ it exits 0 and prints usage; _when_ run with an invalid argument, _then_ it exits 2 with a stable error code from the C4 enum.
- **AC2** — _Given_ each verb's failure paths, _then_ every error code documented in `architecture.md` §4 is reachable by a test (`SPEC_INVALID`, `DUPLICATE_UNIT`, `UNIT_NOT_FOUND`, `MANDATE_EXPIRED`, `LANE_NOT_DARK`, `LEASE_HELD`, `BUDGET_EXCEEDED`, `GATE_REQUIRED`, `ATTEMPT_NOT_FOUND`, `RECEIPT_CONFLICT`, `ATTEMPT_AMBIGUOUS`, `WALL_UNAVAILABLE`, `VERDICT_MISSING`, `VERDICT_STALE`, `PROMOTION_UNSIGNED`, `UNIT_ALREADY_TERMINAL`).
- **AC3** — _Given_ any failure, _then_ exit code is non-zero and nothing is written except the corresponding `unit_event` (no partial state).
- Priority: **P0** · Phase: **9e** · Pain-point link: **R1** · **R5** · **T5** · **T6** · **P5** · **P6**

#### US-E7-02 — "Waiting on a person" is a first-class view

**As the** Operator **I want** the exact list of items blocked on me with the decision each needs **so that** the three human gates stay genuinely three and I never become the reviewer of diffs.

- **AC1** — _Given_ a store with 1 budget raise, 1 credential request and 1 promotion awaiting signature, _then_ `waitingOnPerson` lists exactly 3 items with `gate_kind` and the subject id.
- **AC2** — _Given_ the full test suite, _then_ the number of distinct human-gate categories the system can produce is asserted to be 3 (guard against gate creep).
- **AC3** — _Given_ a `require_human` item older than a configurable age, _then_ status marks it `stale` and exits non-zero under `--check`.
- Priority: **P1** · Phase: **9e** · Pain-point link: **R5** · **R3** · **T5** · **T6** · **P5** · **P6**

#### US-E7-03 — A read-only panel on loopback

**As the** Operator **I want** a plain read-only status page bound to loopback behind a token **so that** I can glance at the factory without a second write path.

- **AC1** — _Given_ the panel running, _then_ `GET /api/status` without the token returns 401 and with the token returns JSON identical to `factory status --json`.
- **AC2** — _Given_ the panel's route table, _then_ only `GET /` and `GET /api/status` exist; every mutating method returns 405 (route assertion).
- **AC3** — _Given_ the server binds, _then_ it listens on `127.0.0.1` only (assertion over the bound address).
- Priority: **P2** · Phase: **9e** · Pain-point link: **R3** · **T6** · **P6**

#### US-E7-04 — Abort is terminal, idempotent and complete

**As the** Operator **I want** `factory abort` to stop everything for a unit and stay idempotent **so that** the panic button is safe to press twice.

- **AC1** — _Given_ a live unit, _when_ `factory abort <unit> --reason "..."` runs, _then_ the attempt is terminated, the lease is released, the reservation is released, `UnitAborted` is appended, and a second abort returns exit 0 with no new event.
- **AC2** — _Given_ an aborted unit, _then_ `runUnit` returns `UNIT_ALREADY_TERMINAL` and no container starts.
- **AC3** — _Given_ an abort during `dispatched`, _then_ the `kill_attempt` effect is enqueued and its completion is required before the unit reaches `aborted` (or the unit stays `ambiguous`, honestly).
- Priority: **P2** · Phase: **9e** · Pain-point link: **R3** · **R4** · **T3** · **T4** · **P3** · **P4**

---

## 10. Epic E8 — Dogfood & Verification (C8, C7 · phases 9a/9b/9e/10/11)

#### US-E8-01 — The whole suite runs offline with zero model credentials

**As the** Operator **I want** `FakeExecutor` to produce deterministic receipts so the factory is testable without any paid call **so that** CI is free, fast and reproducible.

- **AC1** — _Given_ an environment with no `BIFROST_API_KEY` and no `DEEPSEEK_API_KEY`, _when_ `pnpm test` runs, _then_ the suite passes and no network request is made (asserted by a blocked-fetch stub being the only network implementation available).
- **AC2** — _Given_ `FakeExecutor`, _then_ two runs of the same fixture produce byte-identical receipts (content hash equality).
- **AC3** — _Given_ the suite, _then_ `grep -r "api.bifrost" src/` in test config returns nothing and `DSH_VERSION_MISMATCH` is exercised via a fake version string.
- Priority: **P0** · Phase: **9a/9b** · Pain-point link: **R1** · **R4** · **T1** · **T4** · **P1** · **P4**

#### US-E8-02 — One dark unit runs end to end in dogfood

**As the** Operator **I want** at least one unit taken from spec to signed verdict in a fixture repo with no human reading the diff **so that** darkness is demonstrated, not asserted.

- **AC1** — _Given_ the fixture repo and the `dogfood` environment, _when_ `factory intent && factory qualify && factory run && factory verify` run, _then_ the unit reaches `verified` with a signed verdict, and `factory audit` shows the full chain.
- **AC2** — _Given_ the dogfood run, _then_ the sabotage variant of the same fixture is **rejected** by the wall with an opaque reason (the wall-first proof, executed in the same harness).
- **AC3** — _Given_ the run timeline, _then_ total wall-clock and spend are recorded in evidence and the spend row is marked `estimated: true`.
- Priority: **P0** · Phase: **9e** · Pain-point link: **R2** · **R1** · **T2** · **T1** · **P2** · **P1**

#### US-E8-03 — No-secret-leak tests are part of the suite

**As the** Auditor **I want** automated leak tests for every credential class **so that** the blast-radius claim is verified on every commit rather than at review time.

- **AC1** — _Given_ the leak test, _then_ it asserts: worker env has no gateway/signing/prod key; `~/.factory/holdout` unreadable from the container; `issued_token` rows contain no plaintext; no `unit_event.payload` key matches `/(secret|token|key|password)/i` with a non-hash value.
- **AC2** — _Given_ `gitleaks` over the repo and `~/.factory/artifacts/`, _then_ zero findings; a deliberately planted key makes the test fail.
- **AC3** — _Given_ a worker attempting `printenv`, _then_ the receipt records the command and no secret appears in `suite_output` (redaction assertion).
- Priority: **P0** · Phase: **9b/9c** · Pain-point link: **R5** · **T5** · **P5**

#### US-E8-04 — A real-DSH smoke test is opt-in and pinned

**As the** Operator **I want** one opt-in end-to-end run against the real `dsh` binary with an asserted version **so that** the adapter is proven against reality without making CI depend on credentials.

- **AC1** — _Given_ `FACTORY_SMOKE=1` and a configured key, _when_ the smoke test runs, _then_ one real attempt produces a receipt with a non-empty diff and the run passes or fails on a real verdict.
- **AC2** — _Given_ a `dsh --version` that differs from the pinned constant, _then_ the adapter refuses to start with `DSH_VERSION_MISMATCH` and exits non-zero (assertion with a stub binary).
- **AC3** — _Given_ no `FACTORY_SMOKE`, _then_ the smoke test is skipped and the suite still passes (constraint C5).
- Priority: **P1** · Phase: **9b** · Pain-point link: **R1** · **R5** · **T1** · **T5** · **P1** · **P5**

#### US-E8-05 — Process-level E2E specs cover the recovery flows

**As the** Auditor **I want** black-box E2E specs for the paths that are hardest to unit test **so that** recovery and idempotency are proven at the process boundary.

- **AC0** — _Given_ the factory is a CLI, _then_ the specs run under **vitest + `node:child_process`** (a browser driver cannot invoke a binary); Playwright covers only the read-only status page.
- **AC1** — _Given_ the E2E suite, _then_ it covers: duplicate `intent`, racing `run`, `kill -9` + `recover`, conflicting receipt, promotion without signature — each asserting exit codes and DB state.
- **AC2** — _Given_ each phase 9x, _then_ `docs/planning/dark-factory-dsh/evidence/<phase>-*.md` contains the command, its output, and the artifact path — and `phase-#-plan.md` links them.
- **AC3** — _Given_ the full suite, _then_ `pnpm test` and the e2e suite pass from a clean checkout with no environment variables set (constraint C5), and the `@docker`/`@live` tags are skipped without reporting failure.
- Priority: **P2** · Phase: **10/11** · Pain-point link: **R4** · **R6** · **T4** · **T6** · **P4** · **P6**

---

## 11. Non-functional acceptance criteria

Each is a suite-level assertion, not a target to aspire to.

| #     | NFR                            | Machine-checkable criterion                                                                                                                                                                                                                                                                             | Where                   |
| ----- | ------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------- |
| NFR-1 | **Durability under `kill -9`** | Chaos test kills the control plane at 200 random points across a unit lifecycle. After every restart: `PRAGMA integrity_check = ok`, `unit_event.seq` strictly increasing, aggregate replay hash matches the recorded manifest, and `container_starts == committed dispatch effects` (zero duplicates). | US-E5-04                |
| NFR-2 | **Command latency**            | Benchmark over 10 000 in-process commands: p95 < 50 ms, p99 < 120 ms, excluding effect activities. Measured on the reference host (macOS arm64, Node 22) and recorded in evidence.                                                                                                                      | `architecture.md` §8    |
| NFR-3 | **No secret leaks**            | The 4 leak assertions of US-E8-03 pass, `gitleaks` reports zero findings on repo + artifacts, and a schema-column allowlist test proves no column is named `secret\|api_key\|password`. A planted secret makes the suite fail.                                                                          | US-E8-03                |
| NFR-4 | **Offline test suite**         | `env -u BIFROST_API_KEY -u DEEPSEEK_API_KEY pnpm test && pnpm e2e` passes from a clean checkout; a network-blocking stub is installed in every test entry point, so any outbound socket throws.                                                                                                         | US-E8-01, constraint C5 |
| NFR-5 | **Idempotency**                | Replaying any command and any effect yields the identical stored result; the same effect key never starts a second container (asserted across the chaos test).                                                                                                                                          | US-E5-01                |
| NFR-6 | **Fail-closed**                | Every error path in `architecture.md` §4 is exercised and asserts a non-zero exit **and** the absence of a state change beyond the recorded event.                                                                                                                                                      | US-E7-01                |
| NFR-7 | **Auditability**               | For any promoted unit, every hash in `factory audit --json` recomputes and matches; no decision field is unverifiable.                                                                                                                                                                                  | US-E6-01                |
| NFR-8 | **Recovery safety**            | `recovery_run.redispatched = 0` is a database CHECK; the recovery module cannot import the effects enqueue API (dependency test).                                                                                                                                                                       | US-E5-03                |

---

## 12. Out-of-scope stories

Mirrors `phased-plan.md` §"OUT of scope". Each would have been a story; each is excluded for the stated reason, and none may be quietly pulled into 9a–9e.

| Would-be story                                                                             | Why it is out                                                                                                                                                                                                 |
| ------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **US-OOS-01** — Merge the promoted change and deploy it to production                      | The factory stops at a merge-ready patch + signed verdict; the deploy gate is tested with a fixture, never against a live system. Real merges need an approval surface this plan explicitly refuses to build. |
| **US-OOS-02** — Run the control plane on a remote host / NUC / Railway with a worker fleet | Single operator, single host, one box (C6). Multi-host raises the concurrency question that would force Postgres — deliberately deferred.                                                                     |
| **US-OOS-03** — Intake units from GitHub issues or Feishu threads                          | v1 intake is a spec file + CLI. Source adapters are a documented extension point with their own auth, rate-limit and bot-identity problems.                                                                   |
| **US-OOS-04** — Drive workers over ACP instead of headless subprocesses                    | Headless gives crash isolation for free and is implemented; ACP stays the upgrade path behind the same `Executor` interface when workers become long-lived.                                                   |
| **US-OOS-05** — Choose or route models, add a second provider                              | Closed by constraint C1: DeepSeek models only, via the existing Bifrost gateway; only the tier (router vs worker) varies.                                                                                     |
| **US-OOS-06** — Multi-tenant / multi-repo-per-install, Kubernetes, HA, distributed queues  | One repo per install, one tenant (the operator). The data model is portable, but tenancy changes ownership semantics in C1 and is not v1.                                                                     |
| **US-OOS-07** — Billing-grade cost accounting                                              | Pricing differs from Bifrost and `token-meter` is explicitly not billing-grade; every `spend_entry` is marked `estimated: true` and `unknown` propagates honestly (inherited invariant #2).                   |
| **US-OOS-08** — A design-system UI or a rich panel                                         | The panel is deliberately one plain read-only route on loopback; a rich UI would create a second write path and a second place to be wrong.                                                                   |
| **US-OOS-09** — Rewrite or retire `stapled-factory/`                                       | It stays as historical reference; this plan inherits its invariants (no redispatch, unknown≠pass, quarantine rules), not its OpenHands/Restate plumbing.                                                      |
| **US-OOS-10** — Human re-review of individual diffs as a safety net                        | That is the process the wall replaces (P6/T6). Adding a mandatory diff-read gate would make every unit `lit` and defeat the plan's premise.                                                                   |

---

## 13. Story map

**47 stories total — 27 P0 / 17 P1 / 3 P2.** Counts are verified by `grep -c '^#### US-E' user-stories.md` (47) and `grep -o 'Priority: \*\*P[0-9]\*\*' | sort | uniq -c` (27/17/3); if this table ever disagrees with the epic sections, the epic sections win and this table is a bug.

| Priority              | Count | Stories                                                                                                                                                                                                                                                                      |
| --------------------- | ----- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **P0 (must have)**    | 27    | US-E1-01, US-E1-02, US-E1-03, US-E1-04, US-E2-01, US-E2-02, US-E3-01, US-E3-02, US-E3-03, US-E3-04, US-E3-05, US-E3-06, US-E4-01, US-E4-02, US-E4-03, US-E4-04, US-E4-05, US-E4-06, US-E4-07, US-E5-01, US-E5-02, US-E5-03, US-E6-01, US-E7-01, US-E8-01, US-E8-02, US-E8-03 |
| **P1 (should have)**  | 17    | US-E1-05, US-E1-06, US-E2-03, US-E2-04, US-E2-05, US-E3-07, US-E3-08, US-E3-09, US-E4-08, US-E4-09, US-E5-04, US-E5-05, US-E5-06, US-E6-02, US-E6-03, US-E7-02, US-E8-04                                                                                                     |
| **P2 (nice to have)** | 3     | US-E7-03, US-E7-04, US-E8-05                                                                                                                                                                                                                                                 |
| P3 (future)           | 0     | — (nothing in v1 scope is P3; out-of-scope items are recorded in §12 instead)                                                                                                                                                                                                |

### Phase distribution

| Phase                                 | Stories                                                                                   |
| ------------------------------------- | ----------------------------------------------------------------------------------------- |
| 9a (store + durability)               | US-E1-05, US-E5-01, US-E5-02, US-E5-03, US-E5-04, US-E5-05, US-E5-06, US-E8-01            |
| 9b (adapter + isolation + liveness)   | US-E2-01, US-E2-02, US-E2-03, US-E2-04, US-E2-05, US-E4-01, US-E4-02, US-E4-03, US-E8-04  |
| 9c (wall)                             | US-E3-01 … US-E3-09, US-E8-03                                                             |
| 9d (qualifier + gates)                | US-E1-01 … US-E1-04, US-E1-06, US-E4-04, US-E4-05, US-E4-06, US-E4-07, US-E4-08, US-E4-09 |
| 9e (E2E dark unit + operator surface) | US-E6-01, US-E6-02, US-E6-03, US-E7-01, US-E7-02, US-E7-03, US-E7-04, US-E8-02            |
| 10 (E2E test generation)              | US-E8-05                                                                                  |
| 11 (testing & verification)           | US-E8-05, NFR-1 … NFR-8 evidence                                                          |

### P0 coverage of the mandated minimum

| Mandated P0 capability                                               | Story                        | Assertion that proves it                                                                    |
| -------------------------------------------------------------------- | ---------------------------- | ------------------------------------------------------------------------------------------- |
| Receipts, not reports (R1)                                           | US-E2-01, US-E2-02           | one content-hashed receipt per attempt; `Omit<WorkerReceipt,'narrative'>` compile assertion |
| Generator-blind holdout, triple-run, Δ gate (R2)                     | US-E3-02, US-E3-03, US-E3-04 | holdout unreadable from container; 2-of-3 + 0.90 boundary; `delta_sample` per class         |
| Harness-owned ceilings, no-progress, kill switch (R3)                | US-E4-01, US-E4-02, US-E4-03 | ceiling breach kills within 10 s; process group + container + orphan gone                   |
| Deterministic keys, effect ledger, reconcile-without-redispatch (R4) | US-E5-01, US-E5-02, US-E5-03 | AST assertion on key construction; `recovery_run.redispatched = 0` CHECK                    |
| No prod credentials, destructive boundary, normalised command (R5)   | US-E4-05, US-E4-06           | 4 env assertions; `bash -c` wrapped force-push classified destructive                       |
| Adversarial self-test rejects a sabotage change (R6)                 | US-E3-05                     | fail-then-pass under a weakened wall                                                        |
| Qualifier rejects non-derivable intent and irreversible effects (R7) | US-E1-01, US-E1-04           | exit 2 + `SPEC_NOT_MACHINE_CHECKABLE`; `IRREVERSIBLE_OPERATION` → lit                       |
| The three human gates                                                | US-E4-07, US-E4-08, US-E4-09 | unsigned promote refused; raise requires key; token waits on human close                    |
| Unknown never passes                                                 | US-E3-06                     | wall down → `unknown` → `VERDICT_MISSING`; no nullable `passed` column                      |

---

## 14. Flags — contradictions between `architecture.md` and `phased-plan.md`

Found while writing these stories. **Not fixed here**; surfaced for the Lead.

1. **Component path naming disagrees.** `phased-plan.md` phase 9e lists the output as **`packages/cli`**; `architecture.md` §3 defines **C9 = `apps/cli`** (and C10 = `apps/panel`). Same component, two paths — the stories above use `apps/cli`/`apps/panel` per `architecture.md`. One of the two documents should change before 9e starts.
2. **Human-gate count disagrees.** `phased-plan.md` §Goal says **exactly three** human gates (initial production deploy, budget envelope, privileged credentials). `architecture.md` §2.4 marks **four** rows "Human required? **Yes**" — it adds the _destructive operation_ gate. These stories implement the three-gate reading (destructive = structural deny, escalation handled by the privileged-credential gate, asserted by US-E7-02 AC2), but `architecture.md` should be corrected or the count restated.
3. **"Wall-first" omits its adapter dependency.** `phased-plan.md` §"The wall-first rule" says phase 9c precedes 9d/9e "in verification order even though the store (9a) must exist first". But the wall's core act — deterministic re-execution of a receipt — consumes a `WorkerReceipt` produced by C8 (phase **9b**), and the mandated sabotage-rejection proof needs a real receipt to reject. So 9b is also a prerequisite, or 9c must be proven against synthetic fixture receipts and re-proven after 9b lands. As written, the ordering statement is incomplete.
4. _(Adjacent, not a phased-plan contradiction)_ `architecture.md` §2.1 permits an optional qualifier model call ("except the qualifier's optional assessment step") while §2.4 says "no model in the decision path" and constraint **C5** forbids paid calls in the test suite. US-E1-03 AC2 asserts the qualifier has no LLM import at all; if the advisory step is kept, it needs its own story, off by default, and a zero-credential test path.
