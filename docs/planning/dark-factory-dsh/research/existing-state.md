# Existing state audit — what the stapled factory actually is

Audit date: 2026-11-01. Branch `codex/phase9d-qualification`, HEAD `b5fe329` ("fix: retain probe
identity before start and verify stopped recovery"). Working tree is dirty only inside
`docs/verification/harness-qualification-2026-11-01/` (one modified report, one modified
`source-binding.json`, seven untracked evidence JSONs) — i.e. the Nov 1 qualification follow-up is
mid-flight and uncommitted.

Purpose: ground a new DSH-based dark-factory architecture in the repository's real state, so the new
plan reuses what is proven, does not re-derive what is settled, and does not silently discard
invariants that cost real incident rounds to learn.

## How to read the status words

`README.md` states the governing rule itself (lines 44–46): _"Planning documents include earlier
experiments and proposed behavior… historical 'merged' demonstrations do not establish automatic
merging today."_ This audit therefore separates three claim classes:

| Class                   | Meaning                                                                                                      |
| ----------------------- | ------------------------------------------------------------------------------------------------------------ |
| **VERIFIED-LIVE**       | Exercised against the real NUC Restate → OpenHands → Bifrost path, with receipts under `docs/verification/`. |
| **VERIFIED-LOCAL**      | Executable evidence in-repo: tests, CI receipt, or offline probes. Not live.                                 |
| **IMPLEMENTED-UNWIRED** | Code exists, type-checks and is unit-tested, but no production path calls it.                                |
| **DOCUMENTED-ONLY**     | Stated in a planning doc; no implementing code found.                                                        |
| **SUPERSEDED**          | A doc claims it, but current code/README contradicts the claim.                                              |

Everything below was checked against source, not against the plan text. Where the task brief said a
component "is implemented", that is called out explicitly.

---

## What actually exists and is verified today

Path convention: `worker/`, `spine/`, `security/`, `wall/`, `operator/`, `deployment/` are shorthand
for `stapled-factory/<name>/`; all other paths are repository-relative.

| Component                                                                                                                   | Status                                                                                                                                                                                                                                  | Evidence file/path                                                                                                                                                                                                                                                  |
| --------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Holdout evaluator ("the wall"): per-scenario quorum + ≥90% aggregate + one-line failure + `UsageRecord`                     | VERIFIED-LOCAL. 5 plain-English HTTP scenarios; quorum `(runs//2)+1`, i.e. 2-of-3 at `--runs 3`; aggregate 0.90 default. **Not called by any workflow.**                                                                                | `stapled-factory/wall/evaluator/{gate.py,receipt.py,evaluate.py,config.py,cli.py}`; `wall/holdout/scenarios.json`; `wall/tests/` (6 files), `wall/isolation/test_no_holdout_reach.py`; acceptance audit `docs/planning/stapled-factory/phase-9-plan.md:52-57,68-87` |
| Wall holdout isolation as a _tested_ property                                                                               | VERIFIED-LIVE (container) + VERIFIED-LOCAL (simulated). Real worker container denied host holdout paths, private data, budget/anchor data and proxy socket; workspace positive control readable.                                        | `stapled-factory/worker/probes/verify_firewalled_provision.py`; `wall/isolation/test_no_holdout_reach.py`; `phase-9-plan.md:73-79`                                                                                                                                  |
| Effect-based destructive-op firewall (allow / approve / block, deny-by-default)                                             | VERIFIED-LOCAL. **Does not mediate OpenHands' own terminal operations** — `guard.py` wraps factory-issued calls only.                                                                                                                   | `stapled-factory/security/firewall.py`; `stapled-factory/worker/guard.py`; README `:34`                                                                                                                                                                             |
| Scoped credential broker (short-lived task-scoped tokens; agent never sees master key)                                      | VERIFIED-LOCAL. Trust anchor `FACTORY_MASTER_KEY`, swappable for KMS.                                                                                                                                                                   | `stapled-factory/security/broker.py`; `architecture.md:186-188`                                                                                                                                                                                                     |
| Deterministic scan pipeline (Semgrep / Gitleaks / OSV / Cosign + regex fallback, security-relevance classifier)             | VERIFIED-LOCAL. Engines optional; report says which ran. Gitleaks verified live, Semgrep ran live once (Oct 17), **Cosign never wired**.                                                                                                | `stapled-factory/security/pipeline.py` (`classify_security_relevance` at `:238-242`), `security/pipeline_cli.py`; README `:245-247`; `next-steps.md:78-83`                                                                                                          |
| Restate spine: `WorkUnit` Virtual Object holding stage / claim / lease / attempts / build evidence / validation             | VERIFIED-LIVE. Single-writer keyed object; stage machine enforced in `transition()`; TS strict build + 25 Node tests.                                                                                                                   | `stapled-factory/spine/src/state.ts`, `types.ts` (`Stage` `:5-16`, `Receipt` `:40-44`, `Claim` `:46-49`); `spine/tests/`                                                                                                                                            |
| Orchestrate workflow: claim → build → `needs_validation`; ambiguous outcome → `needs_reconciliation` with **no redispatch** | VERIFIED-LIVE. Live NUC runs reached `needs_validation` with clean worker commits; duplicates returned 409 with unchanged state.                                                                                                        | `stapled-factory/spine/src/orchestrate.ts:45-104`, `:106-115`; `docs/verification/nuc-dispatch-2026-10-28/`, `nuc-complexity-routing-2026-10-28/`                                                                                                                   |
| Read-only reconciliation (`reconcileBuild`, `reconciliation.observe`) of an _original_ attempt identity                     | VERIFIED-LIVE. Only the persisted original attempt can be queried; input carries no evidence or paths.                                                                                                                                  | `orchestrate.ts:106-223`; `spine/tests/reconcile.test.mjs`                                                                                                                                                                                                          |
| Gate service (Restate awakeables) + durable approval record for 5 gate types                                                | IMPLEMENTED-UNWIRED. Registered in `main.ts`, **zero in-repo callers**; `gate.request` must be invoked externally over ingress.                                                                                                         | `spine/src/gate.ts`, `approval_store.ts`, `types.ts:72-91` (`GateType`); `spine/src/main.ts:24-27`                                                                                                                                                                  |
| Signed operator abandonment (RSA-signed envelope → guarded ledger fence)                                                    | VERIFIED-LOCAL + one live pilot. Retains evidence, never refunds spend, never declares success.                                                                                                                                         | `spine/src/abandonment.ts`, `state.ts:119-140`; `worker/abandon_attempt.py`; `docs/verification/operator-abandon-2026-10-29/`                                                                                                                                       |
| Signed validation acceptance binding verdict → unit → attempt → git revision                                                | VERIFIED-LIVE (Oct 28). HMAC over payload with owner-only key, strict field regexes, `scope: "disposable-candidate"` enforced.                                                                                                          | `spine/src/validation.ts`; `spine/VALIDATION_BINDING.md`; `docs/verification/nuc-validation.json`                                                                                                                                                                   |
| Guarded attempt ledger with independent monotonic watermark; quarantine on mismatch                                         | VERIFIED-LIVE. Separate absolute paths, separate parent dirs enforced, `PRAGMA synchronous=FULL`, `StoreQuarantined` fail-closed.                                                                                                       | `stapled-factory/worker/guarded_store.py` (`:18-35`, `:84-105`); `worker/BUDGET_WITNESS.md`                                                                                                                                                                         |
| Attempt store: reserved-once, never-redispatch, identity-conflict rejection                                                 | VERIFIED-LIVE. `reserve()` returns `new`, `unknown` or `completed` — never a second dispatch.                                                                                                                                           | `stapled-factory/worker/attempt_store.py`; `worker/worker.py:18-58`                                                                                                                                                                                                 |
| Budget authority: pre-authorized reservation server, immutable policies, microdollar ceiling                                | VERIFIED-LIVE. `MAX_CEILING = 2_000_000` (i.e. $2.00 in microdollars); clients may reserve, never raise a policy.                                                                                                                       | `stapled-factory/worker/budget_authority.py:20`; `worker/ROUTING.md`                                                                                                                                                                                                |
| OpenHands worker runtime: Docker provisioning, resource cgroups, workspace baseline, revision verification                  | VERIFIED-LIVE. 3 GiB / 2 CPU / 512 PIDs worker; 512 MiB proxy; swap disabled; read-only root; 512 MiB tmpfs, 64 MiB shm.                                                                                                                | `worker/provision_runtime.py`, `worker/openhands_adapter.py`, `worker/agent_entrypoint.py`, `worker/revision.py`; `docs/planning/stapled-factory/progress.md:433`                                                                                                   |
| Confined egress: netns firewall + proxy as sole gateway path, pinned gateway TLS                                            | VERIFIED-LIVE. Denies public 443, metadata 80, gateway :80, IPv6, DNS UDP 53; allows only gateway `100.92.236.42:443` with cert/hostname validation. 1 MiB body cap, 1024 output-token cap, pre-forward reservation.                    | `worker/egress_proxy.py` (`MAX_BODY` `:27`), `worker/netns_firewall.py`, `worker/pinned_https.py`, `worker/pricing_policy.py`; `deployment/nuc/prepare_dispatch.py:83,115`                                                                                          |
| Stall detection + one bounded diagnostic intervention (`stall-v1`, opt-in)                                                  | VERIFIED-LIVE (scoped canary) + VERIFIED-LOCAL (regressions). 3 equivalent completed failures spanning ≥4 s, or A/B oscillation; unchanged workspace alone is never a stall; one fsynced one-shot claim; containment on continued loop. | `worker/stall_detection.py`, `worker/stall_observation.py`, `worker/stall_runtime.py`, `worker/workspace_progress.py`; `worker/STALL_PROFILE.md`; `docs/verification/harness-stall-2026-10-31/report.md`                                                            |
| Bounded execution profile (`bounded-native-v1`) with external 300 s namespace deadline                                      | VERIFIED-LIVE. Native `TerminalTool` batching reused (49 → 12 terminal calls in the capability trial); external systemd namespace deadline contains escaped children; partial-effect replay counter.                                    | `worker/bounded_profile.py`, `worker/deadline_watchdog.py`; `docs/verification/harness-native-batching-2026-10-30/`, `harness-bounded-native-2026-10-31/`                                                                                                           |
| Harness telemetry (request/route/token/cache/termination receipts, payload-free)                                            | VERIFIED-LIVE. Wire ↔ gateway ↔ reservation parity asserted per trial.                                                                                                                                                                  | `worker/harness_telemetry.py`, `worker/harness_baseline.py`, `worker/evaluation_events.py`, `worker/evaluation_observation.py`; `worker/HARNESS_TELEMETRY.md`                                                                                                       |
| Paired evaluation harness with preregistration, repetitions, complete failed-consumption denominators                       | VERIFIED-LIVE (24 trials). `harness_evaluation.evaluate(preregistration, results)` rejects missing/duplicate/mismatched samples; promotion eligibility is evidence, never authority.                                                    | `worker/harness_evaluation.py`, `deployment/nuc/evaluation_trials.py`; `worker/EVALUATION.md`                                                                                                                                                                       |
| Operator CLI: `prepare / run / publish / status / abandon` (no merge, no deploy, no scheduler)                              | VERIFIED-LIVE. One clean pilot opened unmerged PR #3; abandoned-task path verified. Argparse choices confirm the closed command set.                                                                                                    | `stapled-factory/operator/cli.py:271`, `operator/nuc.py`; `operator/README.md`; `docs/verification/operator-workflow-2026-10-28/`                                                                                                                                   |
| NUC control-plane deployment (frozen release, loopback-only listeners, systemd user services)                               | VERIFIED-LIVE. `factory-restate` :19070/:18080, `factory-endpoint` :19080, `factory-ingress` :19081; 19080 signed, 19081 bearer. Raw ingress and admin isolated from untrusted clients.                                                 | `deployment/nuc/install.py`, `deployment/nuc/README.md`; `docs/planning/stapled-factory/nuc-target.md`; `progress.md:407`                                                                                                                                           |
| Signed immutable image approval + frozen release manifests                                                                  | VERIFIED-LIVE. RSA operator signature binds source/CI/audit/runtime/task/invocation inputs; private key stays on the Mac, public trust root provisioned to the NUC.                                                                     | `worker/image_approval.py`, `deployment/nuc/prepare_dispatch.py`, `deployment/nuc/build_candidate.py`; `docs/verification/nuc-dispatch-2026-10-28/image-approval.*`                                                                                                 |
| Off-host cold backup / exact joined restore                                                                                 | VERIFIED-LIVE. 121 authenticated files; restored WorkUnit, guarded ledger and Git HEAD match; **older backups are not an anti-rollback authority** (manual quarantine required).                                                        | `deployment/nuc/cold_backup.py`, `verify_recovery.py`; `deployment/nuc/BACKUP.md`; `progress.md:410`                                                                                                                                                                |
| Local CI (no GitHub runners) for the exact committed revision                                                               | VERIFIED-LOCAL at HEAD. `b5fe329` receipt: `passed: true` — Gitleaks, 685 Python tests, `npm ci`, high-severity `npm audit`, `tsc` build, 25/25 Node tests.                                                                             | `scripts/verify-local.py`, `.github/LOCAL_CI.md`, `.local-ci/b5fe329f…/receipt.json`; `.github/workflows/` is empty by design                                                                                                                                       |
| A real collected candidate artifact                                                                                         | VERIFIED-LIVE. `/version` task produced commit `d8bf750`, passed signed acceptance, then stopped with state retained.                                                                                                                   | `docs/examples/version-endpoint/`; `docs/verification/version-example-2026-10-28/result.md`                                                                                                                                                                         |
| Enterprise posture as an audited fact                                                                                       | VERIFIED (audit artifact). Grade **D, 50.7/100, BLOCKED**; ENT-03 and ENT-05 open for broader scope; valid only for trusted-operator single-operator scope.                                                                             | `docs/planning/stapled-factory/enterprise-assessment.md:3-7,36-48`                                                                                                                                                                                                  |

---

## What was planned but NOT implemented

| Planned item                                                                                            | Source claim                                                                                            | Actual state                                                                                                                                                                                                                                                                                                                                                          |
| ------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **The qualifier** (score issues; route dark-lane vs human-lane)                                         | `architecture.md:37,104`, `phased-plan.md` IN-scope, `findings.md:22-24`                                | **DOCUMENTED-ONLY.** No module, no service, no test. `grep` finds nothing outside `node_modules`/`.venv`. The only related artifact is a _path/content_ security-relevance classifier (`security/pipeline.py:238-242`) that feeds `ScanReport.security_relevant` → verdict `needs_review`. It never scores an issue and never selects a lane; a human picks the unit. |
| **Inception / cascade engine** (3 yr goal → OKRs → epics → work packages)                               | `architecture.md:81-94`, `spine` service `cascade` `:100-101`, `phased-plan.md:60` (Phase 9b "pending") | DOCUMENTED-ONLY. No `cascade` service exists in `spine/src/`. Phase 9b never started.                                                                                                                                                                                                                                                                                 |
| Restate services `qualify`, `evaluate`, `gate`(all types) from the architecture's API surface           | `architecture.md:100-107`                                                                               | Partial. `gate` and `approvalStore` exist and are registered; `qualify` and `evaluate` do not exist. `wall.ts` and `security_scan.ts` exist as modules but are **not registered in `main.ts`** — dead code.                                                                                                                                                           |
| Automatic wall evaluation inside the build workflow                                                     | `architecture.md:104`, report §4                                                                        | **Explicitly not done, by design.** `README.md:35` — builds "stop at `needs_validation`; no automatic wall evaluation". Operator dispatches with placeholder `target: 'http://127.0.0.1:1'`, `scenarios: 'operator-local-checks'` (`operator/nuc.py:244-245`). The wall CLI is run by hand.                                                                           |
| The other three human gates (`budget_raise`, `destructive_op`, `credential_issue`) exercised end-to-end | `next-steps.md:119-121`, `architecture.md:120-126`                                                      | DECLARED. Present in `GateType`; `guard.py` emits `destructive_op`; **no caller** invokes `gate.request`. Only `initial_prod_deploy` was ever exercised (Oct 16 demo, `next-steps.md:3`). `security_review` gate type exists but is never requested.                                                                                                                  |
| Merge / deploy / scheduling automation                                                                  | `phased-plan.md:64` (Phase 12 dogfood), report §8                                                       | NOT IMPLEMENTED. No merge command, no deploy command, no scheduler. `publish` stops at an open PR (`cli.py:244-247`, `merged: false, deployed: false`).                                                                                                                                                                                                               |
| Dashboard + Postgres `ApprovalGate`/`BudgetLedger` audit                                                | `architecture.md:134`, `next-steps.md:125`                                                              | NOT IMPLEMENTED. Approval audit is Restate-only. No Postgres in the repo. `ux-plan.md`/`ui-plan.md` are 3-line stubs.                                                                                                                                                                                                                                                 |
| Cosign / portable build provenance                                                                      | `next-steps.md:81` (⬜), `enterprise-assessment.md:42`                                                  | NOT IMPLEMENTED. Online publication evidence exists (upstream collector checks); portable publisher signatures are explicitly not claimed.                                                                                                                                                                                                                            |
| Phase 10 E2E generation, 11 testing, 12 dogfood, 13 gap audit, 14 gap fixes                             | `phased-plan.md:62-66`                                                                                  | NOT STARTED. Phase 9d was inserted and is the only live workstream.                                                                                                                                                                                                                                                                                                   |
| `AGENTS.md` + codified knowledge (report's "prerequisite, not optimization")                            | report §6.9, §10.4                                                                                      | NOT PRESENT. No `AGENTS.md` or `CLAUDE.md` at root. Component READMEs exist and are good, but there is no agent-facing codified-knowledge file.                                                                                                                                                                                                                       |
| Hard $2 actual-charge cap                                                                               | `architecture.md:145-153` (metered `max_cost`), report §6.5                                             | **SUPERSEDED by explicit user decision.** User dropped the hard ceiling; reservations are best-effort. `enterprise-assessment.md:57-58` (ENT-07), `README.md:40-42`.                                                                                                                                                                                                  |
| Railway deployment target                                                                               | `phased-plan.md`/earlier docs                                                                           | SUPERSEDED. Target corrected to the NUC on Oct 27; Railway compute stopped, `progress.md:406,416,455`; `railway-target.md` retained as history.                                                                                                                                                                                                                       |
| "Full loop demonstrated live once, unit-005 → `merged`"                                                 | `next-steps.md:3,75`                                                                                    | **SUPERSEDED.** Dated Oct 17 against the pre-split repository. Current stage machine has `merged` in the enum but `transition()` (`state.ts:166-178`) permits **no transition into `merged`** from any stage. It is unreachable dead state.                                                                                                                           |

Phased-plan status, verbatim (`phased-plan.md:50-66`): phases 1,3,4,5,6,7–8,9 "complete"; 9b, 10, 11,
12, 13, 14 "pending"; 9d "scoped implementation/evaluation complete; retain baseline, broader
promotion not qualified".

---

## DSH/harness qualification evidence

This is the most valuable non-obvious asset in the repo. Six experiments ran between Oct 30 and Nov 1
2026 against the real NUC path (Restate → OpenHands worker → confined proxy → Bifrost `auto` alias).
They form a ladder, each experiment correcting a defect the previous one exposed. All of them are
about **the harness**, not about the wall or the qualifier: they measure how often a coding agent
completes a task, how much context it burns, and how it fails.

### The frozen task suite (the experimental substrate)

Six development tasks, three repetitions each, fixed seed revision, fixed task bytes and allowed
paths. These are the task families the brief asks about:

| Task id         | Family                                             |
| --------------- | -------------------------------------------------- |
| `discovery`     | repository discovery / read-only investigation     |
| `small-edit`    | single small edit                                  |
| `multi-file`    | multi-file change                                  |
| `failing-tests` | diagnose failing tests                             |
| `noisy-output`  | filter noisy tool output                           |
| `stalled-run`   | deliberately stalled / unavailable-dependency loop |

Source: `docs/verification/harness-baseline-2026-10-30/summary.json` (`by_task[]`),
`harness-baseline-2026-10-30/report.md:16-24`.

The Oct 31 held-out cohort replaced these with six _fresh_ archive-service tasks (expiry boundaries,
quoted CSV, parcel rounding, configuration discovery, noisy-output filtering, unavailable dependency)
so the development suite could not be reused as a qualification set
(`harness-evaluation-2026-10-31/report.md:5-9`).

### What each experiment measured

| #   | Experiment                              | Design                                                                                                                          | Headline measurement                                                                                                                                                                                                                                                                                                                                                                                                                                                                        | Verdict                                                                         |
| --- | --------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------- |
| 1   | **Baseline** (Oct 30)                   | 18 live trials, frozen profile, existing router, 12-request admission, $2 reservation target                                    | **17/18** frozen; **18/18** after offline contract-corrected regrade (0 model reruns). 107 requests, 1,088,401 gateway prompt tokens, 79,889 wire input + 1,008,512 cache-read, **92.66 % reported cache-read share**, median workflow **44.45 s**, median agent event span **12.18 s**, reservations **$7.610171**, actual charges **null**. `stalled-run` was the only failure (2/3 → 3/3 corrected). 1/3 of trials had cold-start input spikes (25,049 vs ~2,000 tokens on `discovery`). | Baseline frozen as the reference                                                |
| 2   | **context-v1** (Oct 30)                 | Paired, same tasks/seed, prompt/tool/skill bundle                                                                               | 18/18; 103 requests; **605,900** prompt tokens (**−44.3 %**); median 44.433 s; cached-read share 92.66 % → 88.44 %                                                                                                                                                                                                                                                                                                                                                                          | Opt-in; no cache-rate claim                                                     |
| 3   | **Native batching capability** (Oct 30) | Operator-authored capability trial, **zero** inference calls                                                                    | Sequential vs batched: 12/12 independent checks, identical Git trees, **49 → 12** terminal calls                                                                                                                                                                                                                                                                                                                                                                                            | Reuse `TerminalTool`; no autonomous saving claimed                              |
| 4   | **bounded-native-v1** (Oct 31)          | Paired 18/18 + paid canary; external 300 s namespace deadline                                                                   | 18/18; 105 requests; 620,807 prompt tokens (**−43.0 %** vs corrected baseline, **+2.5 % worse** than context-v1); median 44.397 s; reservations $4.953947                                                                                                                                                                                                                                                                                                                                   | Opt-in; **no incremental gain from batching**                                   |
| 5   | **stall-v1** (Oct 31)                   | Offline regressions → two immutable canaries                                                                                    | Candidate `ad70b75` **failed**: one diagnostic stored, no verified continuation, 6 requests / $0.278221, original fenced. Corrected `3b1c3bb` passed: exactly one diagnostic, independent verified `canary.txt` edit + clean commit, 12 requests / $0.640921. Total **18 requests, $0.919142**                                                                                                                                                                                              | Adaptation demonstrated; **automatic escalation only proven offline**           |
| 6   | **Held-out evaluation** (Oct 31)        | 24 preregistered trials, 4 profiles × 6 fresh tasks, 1 repeat                                                                   | Frozen strict acceptance **4/6, 4/6, 4/6, 5/6**; contract-reconciled **5/6, 5/6, 5/6, 6/6**. 188 requests, **$10.7275** reservations, actual charges unknown. **Zero host diagnostic interventions in the suite.** CSV task timed out under context and bounded profiles. Matched-route stratum: 86,599.7 → 55,630.0 input tokens per accepted task (−35.8 %)                                                                                                                               | **Retain baseline.** Profiles stay opt-in                                       |
| 7   | **Qualification follow-up** (Nov 1)     | Unpaid SDK containment proof on pinned SDK 1.58.2 in `network:none`; scripted model; real guarded store + real systemd deadline | Exactly **1** diagnostic with `run=false`, **3** qualifying post-intervention failures, automatic stop of both original namespaces, **reservation retained + fence confirmed**, 1 allocation, **0** replacement, **1 creation / 1 diagnostic / 70 reads / 0 runs**, **28** checkpoint files, no transport on journal reopen, **0 paid requests**                                                                                                                                            | SDK/observer/lifecycle integration proven; **routed-model efficacy NOT proven** |

Primary sources: `harness-baseline-2026-10-30/{report.md,summary.json}`,
`harness-context-paired-2026-10-30/`, `harness-native-batching-2026-10-30/`,
`harness-bounded-native-2026-10-31/{report.md,comparison.json}`,
`harness-stall-2026-10-31/report.md`, `harness-evaluation-2026-10-31/{report.md,decision.json,coverage.json}`,
`harness-qualification-2026-11-01/{report.md,unpaid-escalation-v2.json,sdk-truncation-audit.json}`.

### The four measured pathologies (these are the design constraints for a new harness)

1. **Stall loops.** The real failure mode is not "the agent stops"; it is "the agent keeps doing
   equivalent failing work". Detection that works: three _equivalent completed_ failures with matching
   diagnostic evidence and matching workspace state spanning ≥4 s, or A/B workspace oscillation.
   Detection that produces false positives: workspace-hash-unchanged alone (read-only investigation
   legitimately changes nothing), and "latest error only" (productive diagnostics get hidden between
   polls — this was a **real false positive** found in review, `harness-stall-2026-10-31/report.md:21`).
   Containment is fence-and-reconcile, never restart. The Oct 31 canary `ad70b75` proved a message with
   `run=false` does **not** unconditionally pause a running loop; a message can reset FINISHED/STUCK to
   IDLE, so a running-state precondition is mandatory (`:32-34`). The Nov 1 probe closed the remaining
   gap by requiring a confirmed-running SDK loop before delivery.
2. **Truncation.** Not measurable from the pinned SDK's supported surface, and this **blocks
   promotion**. Supported `PostToolUse` sees observations only _after_ terminal/editor pre-event
   clipping; terminal LLM rendering can clip after `PostToolUse`; native tmux bounded history can evict
   before SDK capture with **no exact discarded-row counter**; the subprocess fallback uses a bounded
   deque with no eviction telemetry. Wrapping `maybe_truncate` or matching textual markers cannot
   establish complete coverage. Decision recorded: "Preserve truncations unknown. No promotion gate
   weakened." (`harness-qualification-2026-11-01/sdk-truncation-audit.json`, 8 file hashes bound to
   upstream `d0d9d81`).
3. **Escalation.** Two distinct things get conflated and must not be: _adaptation_ (one bounded
   diagnostic that the agent acts on — proven live) versus _automatic continued-loop escalation_
   (fence the original allocation when the loop persists — proven **offline only**, against the real
   guarded ledger/lifecycle). The first canary's eventual cleanup was **not** automatic escalation
   proof (`harness-stall-2026-10-31/report.md:52`).
4. **Budget.** The 12-request admission limit and the $2 reservation target are **admission estimates,
   not charge caps**. Live counter-example: the COMPLEX route reported cost `$0.03471204` against a
   `$0.014749` reservation and reported 8,740 output tokens despite `max_tokens: 128` —
   "`max_tokens` is a request-field limit, not a verified provider token/billing cap"
   (`progress.md:447`). Every experiment therefore reports `actual_charges_usd: null` and keeps failed
   or uncertain consumption in totals.

### Why the promotion gate failed (and what that tells a new plan)

`decision.json` records `"decision": "retain_baseline"` with five reasons:

1. The first collector canary treated an ordinary asynchronous `needs_reconciliation` as terminal and
   fenced an **active** conversation after 9.823 s; two wire responses were lost, so the full baseline
   primary metric is **unknown** — not zero, unknown.
2. Authoritative SDK truncation coverage is unavailable.
3. Combined-vs-baseline routed-model sets differ in 3 of 6 pairs (`ollama-flash-high` /
   `ollama-flash-low`, both serving DeepSeek V4.1 Flash), so route strata cannot be pooled.
4. The collector epoch changed mid-suite (24 trials span collector `52e64d6`, `7c5c506` and mixed host
   epochs `645cb59 → db96ddd → eea52b0 → 049e51a`), and one repeat over six tasks cannot estimate
   within-task variance.
5. The private grader was stricter than the visible task contract: it rejected permitted extra JSON
   fields, and a trailing status print made the shell exit 0, so it rejected all four genuine single
   imports.

Prespecified gate (`phase-9d-plan.md:58`): no acceptance decline **and** ≥10 % improvement in input
tokens per accepted task **and** median latency no more than 10 % worse **and** all safety/accounting
gates. The combined profile cleared every threshold it could measure — and still was not promoted,
because three gates were _unknown_. That posture (`unknown ≠ pass`) is the single most transferable
lesson in the repo.

### Two other measurement lessons

- **Cadence is not speed.** The evaluation profiles observe at 2 s in-call instead of the ordinary 30 s
  orchestration reconciliation poll, so part of the workflow-latency contrast is observation cadence,
  not inference acceleration (`harness-evaluation-2026-10-31/report.md:32`).
- **Latency is not model time.** Median workflow elapsed (44.45 s) includes provisioning and durable
  reconciliation polling; median agent event span was 12.18 s. Do not attribute workflow elapsed to
  inference (`harness-baseline-2026-10-30/report.md:28`).

---

## The four load-bearing concepts already implemented

The brief names four: the wall, the qualifier, the gates, receipts/claims/leases. Three of the four
are real. **The qualifier is not implemented at all** — see below.

### 1. The wall — implemented, verified, and deliberately unwired

Code: `stapled-factory/wall/evaluator/gate.py` (quorum + aggregate + one-line message),
`receipt.py` (`UsageRecord`), `evaluate.py` (HTTP runner), `config.py` (per-tier `pricing_mode` +
ceilings), `cli.py`; scenarios in `wall/holdout/scenarios.json` (5 scenarios, one `unit: "auth"`);
fixtures `wall/target/app.py` and `wall/target/broken_app.py`; isolation proofs
`wall/isolation/test_no_holdout_reach.py` and `worker/probes/verify_firewalled_provision.py`.

The load-bearing invariants, all still true:

- `gate()` returns a **one-line** failure and never the scenario text (`gate.py:48-50,61`).
- Per-scenario quorum is computed first and the aggregate only over scenarios that passed, so
  "aggregate-only" cannot mask a 1-of-3 scenario (`gate.py:44-58`).
- The wall is a **quality / non-determinism gate, not a security boundary** — stated in the module
  docstring, in `architecture.md:60-63`, and in `consensus-plan.md`.
- The wall is **not called** by `orchestrate`. `wall.ts` defines a `WallRequest`/`runWall` shape but is
  not registered in `main.ts`. Real acceptance in the operator path is the operator-owned
  `check_script` run against the collected candidate (`README.md:349-355`), plus the separately signed
  `validate.py` path for application candidates.

### 2. The qualifier — **NOT implemented** (this contradicts the brief's premise)

There is no qualifier module, service, test, or config anywhere in `stapled-factory/` outside vendored
dependencies. Specifically:

- The architecture's `qualify` service (`architecture.md:104`) does not exist in `spine/src/`.
- Phase 9b (Inception) and the qualifier were both listed as unbuilt in `next-steps.md:84` and
  `:115-117`, and `phased-plan.md:60` still marks 9b "pending".
- Lane selection today is a **human act**: the operator picks a unit, writes the task JSON with
  `allowed_paths` and an out-of-repo `check_script`, and runs `prepare`. Nothing scores risk.

Nearest existing primitives a new plan can build the qualifier on, without inventing anything:

| Primitive                                         | Path                                           | What it already decides                                                                                                                                      |
| ------------------------------------------------- | ---------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `classify_security_relevance(paths, diff_text)`   | `stapled-factory/security/pipeline.py:238-242` | Boolean security-relevance from path regex + content regex — deterministic, no LLM. Feeds `ScanReport.security_relevant`.                                    |
| `_verdict(findings, security_relevant)`           | `security/pipeline.py:249-254`                 | `fail` on critical/high; `needs_review` if security-relevant or medium; else `pass`. This _is_ a lane decision, just applied to a diff rather than an issue. |
| `GateType` incl. `security_review`                | `spine/src/types.ts:72-77`                     | The declared escalation target for a security-relevant change (tiered dark). Never requested.                                                                |
| `allowed_paths` + `check_script` in the task JSON | `README.md:334-355`, `operator/cli.py`         | The current de-facto blast-radius fence: exact repo-relative filenames only.                                                                                 |

So the honest architecture statement for a new plan: **the qualifier is a greenfield build that can
reuse a deterministic path/content classifier and an existing gate vocabulary, but the issue-scoring
and lane-routing logic does not exist.**

### 3. The gates — implemented as a durable primitive, unexercised as a workflow step

Code: `spine/src/gate.ts` (Restate awakeable; `request` blocks durably and survives restarts, `resolve`
resolves the awakeable), `spine/src/approval_store.ts` (durable `Approval` record: `gateType`,
`decision`, `approver`, `awakeableId`, `requestedAtMs`, `resolvedAtMs`), `spine/src/types.ts:72-91`.

Reality check, in order of importance:

- **No in-repo caller.** `grep` for `gate.request` / `objectClient(gate` in `spine/src` returns nothing.
  The service is registered (`main.ts:24-27`) so it is reachable over ingress, but no workflow step
  requests an approval. The Oct 16 "gate suspend → approve → merged" demo has been superseded; the
  stage machine can no longer reach `merged`.
- Only `initial_prod_deploy` was ever exercised (`next-steps.md:119-121`).
- `destructive_op` is _emitted_ by `security/firewall.py` (`approve` disposition) and described in
  `worker/guard.py:27-39` as "the spine should route to `gate.request(..., "destructive_op")`" — a
  comment, not a call.
- The de-facto gates in production today are **operator CLI actions**, not Restate awakeables:
  `prepare` (sign the task and capture the baseline), `run` (dispatch once), `publish` (run acceptance
  checks + exact-commit CI, open a PR), `abandon` (signed closure of a fenced attempt). Each is a
  human-in-the-loop step that cannot be skipped by the agent because the agent has no credentials for
  them.

For a new plan: the _gate semantics_ (durable, recorded, approver-attributed, unresolvable-twice) are
proven and reusable; the _gate wiring_ is not.

### 4. Receipts / claims / leases — implemented, but not as the architecture describes

Code: `spine/src/types.ts` (`Stage` `:5-16`, `UsageRecord` `:20-30`, `Verdict` `:32-37`,
`Receipt` `:39-44`, `Claim` `:46-49`, `WorkUnitState` `:59-69`), `spine/src/state.ts`
(claim/lease/stage/evidence handlers), `spine/src/build.ts` (build step + descendant revision
verification), `worker/attempt_store.py` (reserve-once), `worker/guarded_store.py` (ledger + watermark

- fence), `worker/budget_authority.py` (reservations).

Precisely what is and is not true:

| Concept              | Implemented?                     | Reality                                                                                                                                                                                                                                                                               |
| -------------------- | -------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Claim**            | Yes                              | `WorkUnit.claim(workerId)` returns false if a live lease is held by another worker (`state.ts:32-43`).                                                                                                                                                                                |
| **Lease**            | Yes, but wall-clock              | `CLAIM_LEASE_MS = 10 min`; expiry compares `Date.now()`, which is **non-deterministic under replay** — explicitly flagged in the file header (`state.ts:7-10`) and in `next-steps.md:94`. A new plan must not inherit this as "solved".                                               |
| **Stage**            | Yes, enforced                    | `transition()` whitelists exactly four edges (`state.ts:166-178`): claimed→building, building→needs_reconciliation (unknown/blocked with a conversation id), building→needs_validation (completed + 40-hex revision), building→failed. `gated`, `merged`, `deployed` are unreachable. |
| **Attempt identity** | Yes                              | Attempt id is `${unitId}:${attempt}`; conversation id is `uuid5(NAMESPACE_URL, "stapled-factory:" + attempt_id)` — deterministic, so reconciliation can address the original remote identity without a stored map (`worker/worker.py:18-25`, `spine/src/build.ts`).                   |
| **Receipt**          | Type only; recording **refused** | `state.ts:160-163`: `recordReceipt` throws `TerminalError("Receipt validation is not enabled")`. "Caller-supplied receipts cannot establish a trusted target binding." The receipt contract exists; no trusted producer is wired.                                                     |
| **Usage accounting** | Yes, best-effort                 | `UsageRecord` has `cost_estimate_usd` (float or null) and `ceiling_violation` (string); `None`/unknown is preserved rather than zeroed (`wall/evaluator/receipt.py`).                                                                                                                 |
| **Fencing**          | Yes                              | `guarded_store.py` requires a fence _intent_ then a fence _confirmation_; a fenced attempt cannot complete (`:132-166`).                                                                                                                                                              |

---

## Inventory of hard-won invariants & safety rules stated in README

These are the rules the README states explicitly. **Any new plan must preserve every one of them** or
state, in writing, which decision reversed it and why. Citations are to `README.md` unless noted.

### Identity and durability

1. **No automatic redispatch.** An ambiguous result is observed under its original identity rather
   than treated as permission to dispatch again. `README.md:85-88`, `:326` ("No automatic
   redispatch"), `:459-460`. Enforced in `orchestrate.ts:68-83` and `attempt_store.py`.
2. **Reconciliation is read-only.** Recovery may only _observe_ the persisted original attempt; the
   reconcile input contains no evidence or paths so a replay cannot select different work
   (`orchestrate.ts:106-107`).
3. **Do not change a live or uncertain run's host, state directory, ports, or signing identity**
   (`README.md:295`).
4. **An uncertain attempt is not a failed attempt.** Statuses `needs_reconciliation` /
   `NEEDS_INTERVENTION` mean "preserve and observe", never "retry with another unit" (`README.md:454`).
5. **Never reset a quarantined store.** "Store quarantined → preserve store and anchor; do not reset
   them or restore an older snapshot to resume" (`README.md:457`).
6. **Never delete active operator markers or reset budgets** (`README.md:459`).
7. **Abandonment retains evidence without refunding spend or declaring success** — only after the
   attempt is already safely fenced (`README.md:460-462`).
8. **Restate preserves workflow state; the guarded ledger controls reservation and recovery.** These
   are two authorities, not one (`README.md:85-86`).
9. **The ledger and its anchor must stay independent**, and "the local pair cannot detect a coordinated
   rollback of both files" (`README.md:440-441`).

### Budget and accounting

10. **The $2 figure is a best-effort estimated admission budget, not a cap on actual provider
    charges.** Failed or uncertain requests retain reservations (`README.md:40-42`).
11. **`max_tokens` / request counts are request-field limits, not billing caps** — proven by a live
    route that exceeded both (`progress.md:447`).
12. **Receipt estimates do not independently measure provider billing**, and missing fields are
    `unknown`, never `0` (`README.md:201`; `worker/EVALUATION.md`, `summary.json`
    `actual_charges_usd: null`).
13. **Missing provider/cache/cost telemetry propagates as unknown and cannot satisfy a promotion gate**
    (`phase-9d-plan.md:57-58`; `decision.json` reasons 1–2).

### Isolation, authority, publication

14. **The worker has no general network access and must not install dependencies to make tests run**
    (`README.md:370-371`).
15. **The proxy owns gateway credentials; the worker receives neither those credentials nor operator
    signing keys** (`README.md:87-88`).
16. **Missing trusted configuration blocks dispatch; production scope is denied** (`README.md:36`).
17. **`publish` runs candidate local CI on the operator machine and "is not a host execution
    sandbox"** (`README.md:373-375`).
18. **The CLI never merges or deploys** (`README.md:37`, `:381-384`).
19. **Real holdouts must live outside all worker checkouts and mounts** (`README.md:33`, `:203-205`).
20. **Loopback does not isolate other local processes**; request signing authenticates Restate to the
    endpoint and does not authorize Restate ingress callers (`README.md:432-435`).
21. **The CLI exit status of the wall is not a pass/fail gate** — read `verdict.passed` **and**
    `receipt.ceiling_violation` (`README.md:199-200`).

### Evidence honesty

22. **Planning documents contain historical and proposed behavior; the implementation and current
    runbooks govern** (`README.md:44-46`).
23. **Passing tests do not establish live isolation, publisher provenance, recovery, application
    acceptance, or a provider billing ceiling. Record which boundaries an experiment actually
    exercised** (`README.md:476-478`).
24. **Publishing a repository change and accepting an application candidate are separate outcomes; one
    does not imply the other** (`README.md:313-316`).
25. **A local CI receipt proves local checks only, and does not itself publish the GitHub status**
    (`README.md:263-265`).

Two invariants from `architecture.md` that the README does not restate but the code enforces:
**deterministic controls enforce, LLMs advise** (`architecture.md:84-90`) and **never replay an LLM
call** (`architecture.md:162-163`).

---

## Reuse / retrofit / retire table for a DSH-based dark factory

The strategic fork the new plan must answer: the repo's outer loop is Restate + OpenHands; DSH is a
different harness. The table separates the parts that are _harness-independent_ (safe to keep
regardless) from the parts that are _OpenHands- or Restate-specific_.

| Component                                                                                     | Reuse as-is        | Adapt                   | Retire               | Why                                                                                                                                                                                                                                                                                                                                                                                    |
| --------------------------------------------------------------------------------------------- | ------------------ | ----------------------- | -------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Wall evaluator (`wall/evaluator/*`, quorum/aggregate/one-line/`UsageRecord`)                  | **Yes**            |                         |                      | Pure Python, HTTP-level, harness-agnostic. It is the one component the report says no platform ships and it is already correct. Only the caller changes.                                                                                                                                                                                                                               |
| Holdout scenarios + `target/` fixtures                                                        | Yes (dev set only) |                         |                      | Public demo data; a real factory needs private holdouts in evaluator-owned storage (`README.md:203`). Keep as the regression set for the wall itself.                                                                                                                                                                                                                                  |
| Wall isolation proofs (`test_no_holdout_reach.py`, `verify_firewalled_provision.py`)          |                    | **Adapt**               |                      | The _assertion strategy_ (prove unreachability, don't trust config) transfers; the specific mount/Docker probes must be rewritten for DSH's workspace model.                                                                                                                                                                                                                           |
| Security firewall (`security/firewall.py`)                                                    | **Yes**            |                         |                      | Effect-based, deterministic, deny-by-default, model-independent. Its weakness is structural, not logical: it must be _hooked_ into the new harness's tool dispatch.                                                                                                                                                                                                                    |
| Credential broker (`security/broker.py`)                                                      |                    | **Adapt**               |                      | Token semantics and `FACTORY_MASTER_KEY` anchor transfer; issuer/hook plumbing is harness-specific.                                                                                                                                                                                                                                                                                    |
| Scan pipeline + `pipeline_cli.py`                                                             | **Yes**            |                         |                      | Diff-in/verdict-out CLI is already the right seam for any orchestrator. Cosign remains the one unwired engine.                                                                                                                                                                                                                                                                         |
| `classify_security_relevance` + `_verdict`                                                    | **Yes**            |                         |                      | Deterministic, ungamable; directly reusable as the qualifier's floor.                                                                                                                                                                                                                                                                                                                  |
| Restate `WorkUnit` VO + `orchestrate`/`reconcile` workflows                                   |                    | **Adapt**               |                      | The state model (stage/claim/lease/attempt/build-evidence/validation) is the hard-won part; it survives. The TypeScript/Restate binding does not, if DSH owns the loop. Decide explicitly: keep Restate as the durable outer loop (less work, keeps replay) or collapse into DSH state (simpler, loses the proven reconciliation surface).                                             |
| `state.ts` lease via `Date.now()`                                                             |                    |                         | **Retire**           | Known non-deterministic under replay. Any port must use a durable timer.                                                                                                                                                                                                                                                                                                               |
| `gate.ts` + `approval_store.ts` + `GateType`                                                  |                    | **Adapt**               |                      | Semantics (durable block, recorded approver, single resolution) are right; wiring is absent and must be rebuilt against whatever DSH exposes.                                                                                                                                                                                                                                          |
| `recordReceipt` (throws)                                                                      |                    | **Adapt**               |                      | The refusal is correct. Keep refusing caller-supplied receipts; build the trusted producer instead.                                                                                                                                                                                                                                                                                    |
| Attempt store (`reserve`-once) + guarded ledger + anchor + `fence`                            | **Yes**            |                         |                      | These are the at-most-once and anti-rollback machinery; nothing about them is OpenHands-specific. The ledger/anchor independence and quarantine rules must port verbatim.                                                                                                                                                                                                              |
| Budget authority (microdollar reservations, immutable policies)                               | **Yes**            |                         |                      | Harness-agnostic reservation server; keep `MAX_CEILING` semantics and the "clients reserve, never raise" rule.                                                                                                                                                                                                                                                                         |
| Egress proxy + netns firewall + `pinned_https`                                                |                    | **Adapt**               |                      | The _policy_ (gateway-only egress, pinned TLS, 1 MiB body, 1024 output) is the asset; the plumbing depends on how DSH's tools reach the network.                                                                                                                                                                                                                                       |
| Docker provisioning + cgroup limits + external namespace deadline                             |                    | **Adapt**               |                      | Limits and the "soft native timeout is not containment" finding transfer; the container/workspace contract follows DSH.                                                                                                                                                                                                                                                                |
| `stall_detection.py` / `workspace_progress.py` / one-shot intervention claim                  |                    | **Adapt**               |                      | The detection _rules_ and false-positive lessons are the most expensive knowledge in the repo. The SDK pairing/message-send transport is OpenHands-specific and must be reimplemented.                                                                                                                                                                                                 |
| `bounded_profile.py` / `deadline_watchdog.py`                                                 |                    | **Adapt**               |                      | Same reasoning: policy + deadline reasoning transfer; SDK capture cancellation does not.                                                                                                                                                                                                                                                                                               |
| Harness telemetry + `harness_evaluation.py` (preregistration, pairing, complete denominators) | **Yes**            |                         |                      | Pure measurement logic. Highest-leverage reuse in the repo: it encodes "unknown ≠ pass", route strata, and failed-consumption accounting.                                                                                                                                                                                                                                              |
| Baseline/held-out task suites + oracles                                                       | Yes (as fixtures)  |                         |                      | Already retired from qualification use; still useful as the new harness's regression suite. Do not reuse them as a _fresh_ qualification cohort.                                                                                                                                                                                                                                       |
| Evaluation tooling (`deployment/nuc/evaluation_trials.py`)                                    |                    | **Adapt**               |                      | Operator-only driver, good shape; the observation flags are SDK-specific.                                                                                                                                                                                                                                                                                                              |
| Operator CLI (`prepare/run/publish/status/abandon`)                                           |                    | **Adapt**               |                      | The command set and the "no merge/deploy/scheduler" boundary should be preserved almost verbatim; the internals call Restate and Docker.                                                                                                                                                                                                                                               |
| NUC deployment (`install.py`, `prepare_dispatch.py`, `validate.py`, cold backup)              |                    | **Adapt** (mostly keep) |                      | This is the infrastructure the new plan inherits, not a choice. Only the service list and runtime binding change.                                                                                                                                                                                                                                                                      |
| Signed image approval + signed validation binding                                             | **Yes**            |                         |                      | Both are crypto + policy over artifacts; harness-independent.                                                                                                                                                                                                                                                                                                                          |
| Local CI (`scripts/verify-local.py`)                                                          | **Yes**            |                         |                      | Extend the test matrix; do not replace the mechanism.                                                                                                                                                                                                                                                                                                                                  |
| `security_scan.ts`, `wall.ts`, `build.ts`                                                     |                    | **Adapt**               |                      | `build.ts` is a thin `ctx.run` shell-out to `worker/worker.py` and is worth keeping as the effect boundary shape; the real revision verification lives in `worker/revision.py:14-37` ("clean, changed descendant HEAD, or None for any uncertainty") and must port with it. `security_scan.ts` and `wall.ts` are dead code whose _shape_ is reusable and whose body must be rewritten. |
| "merged" stage + Phase 12 dogfood claim                                                       |                    |                         | **Retire the claim** | `merged` is unreachable in the current state machine; the Oct 17 "merged" demo predates the split and the current rules. Any new plan starts from `needs_validation`.                                                                                                                                                                                                                  |
| Railway deployment target                                                                     |                    |                         | **Retire**           | Superseded by the NUC on Oct 27.                                                                                                                                                                                                                                                                                                                                                       |

---

## Constraints the new plan inherits

These are not preferences. Each is either provisioned infrastructure the plan cannot conjure, or an
explicit user decision recorded in the repo.

### Infrastructure: NUC control plane

- Host `nuc-hermes`, SSH alias `hermes-control`, operator `bo` uid 1000, Linux amd64, Docker 29.8.0
  (`docs/planning/stapled-factory/nuc-target.md:11-14`).
- Three systemd user services: `factory-restate` (admin `19070`, raw ingress `18080`),
  `factory-endpoint` (`19080`, signed), `factory-ingress` (`19081`, bearer token). **All loopback-only.**
- Frozen release under `/home/bo/.local/share/stapled-factory-control/releases/<sha>`; release
  manifests are hash-verified (768–1,209 files in recorded runs).
- **Shared NUC workloads must not be restarted or pruned.** Only `factory-endpoint` /
  `factory-ingress` are restarted on deployment; shared Restate/Bifrost stay up
  (`harness-evaluation-2026-10-31/report.md:56`).
- Builds happen **locally on the operator Mac** and are transferred; no provider-side source builds, no
  GitHub runners (`.github/LOCAL_CI.md`).
- Local port baseline: `8080/9070/9080/9081` on the Mac, `18080/19070/19080/19081` on the NUC
  (`README.md:424-430`).

### Infrastructure: Bifrost gateway

- Accessed only through the confined proxy, only pinned TLS to `100.92.236.42:443`
  (`deployment/nuc/prepare_dispatch.py:83,115`).
- **Do not modify or duplicate the shared complexity router.** Use alias `auto`
  (`docs/planning/stapled-factory/decisions/2026-10-28-existing-complexity-router.md:3`).
- The proxy generates a stable per-attempt trusted session id; the gateway credential lives in an
  owner-only file referenced by `FACTORY_GATEWAY_KEY_FILE` and never enters the worker.
- Observed routes today: `ollama-flash-high` / `ollama-flash-low` → DeepSeek V4.1 Flash; COMPLEX →
  Pro. Classifier and fallback charges are **unknown**.
- Request limits at the proxy: 1 MiB body, 1024 output tokens, request-count cap (`12` in the harness
  experiments, `6` in the canary policy).

### Signing keys and trust roots

- Operator RSA key for image approval: private key on the Mac, public trust root installed
  independently on the NUC (`progress.md:435`, `worker/RUNTIME_IMAGES.md`).
- `FACTORY_VALIDATION_KEY_FILE`: HMAC key for signed validation evidence; owner-only, non-symlink,
  ≥32 bytes, `mode & 0o077 == 0` enforced (`spine/src/validation.ts:13-19`).
- `FACTORY_RESTATE_IDENTITY_KEYS`: comma-separated `publickeyv1_…`; **missing or malformed keys prevent
  endpoint startup** (`spine/src/main.ts:12-19`).
- `FACTORY_INGRESS_TOKEN_FILE`: owner-only regular file, ≥32 random bytes, base64url.
- Operator config must be an owner-only regular file (not a symlink) containing references, never key
  material; only the default `operator.local.json` path is auto-ignored (`README.md:286-295`).
- **No key or credential ever enters the worker, the repo, or an argument list.**

### Cost caps (as they actually are)

- `$2` best-effort **estimated admission** target per attempt — `MAX_CEILING = 2_000_000` microdollars
  (`worker/budget_authority.py:20`). Not a cap on charges.
- Reservation is taken **before** forwarding; failed and uncertain requests keep their reservation.
- Request-count admission limit (12 in the harness suite; 6 in the canary policy) and 1024 output
  tokens are request-field/at-most-N controls, not billing guarantees.
- Every receipt must carry `cost_estimate_usd: null` when actual charges are unknown; `actual_charges_usd`
  is `null` in every evidence file in the repo.
- Pricing policy is hour-bounded: `prepare_dispatch` embeds a one-hour pricing policy that requires
  fresh preparation if activation is delayed (`release-approval.md:98-99`).

### Single operator

- Exactly one human operator. Signing key, bearer token, and `gh` auth are all the same person.
- `main` requires `local-ci/verified` **and** one approving review of the latest push, including for
  admins; stale reviews dismissed; force-push and deletion disabled (`release-approval.md:61-63`).
- The sole collaborator is also the PR author, so **the required independent review cannot be
  obtained** — merges into `main` are structurally blocked, not merely avoided
  (`release-approval.md:64-69`).
- Enterprise posture is **D / 50.7 / BLOCKED**; ENT-03 (supply chain) and ENT-05 (separation of duties)
  remain open High for enterprise scope. Nothing here may be described as enterprise approval.
- Deployments proceed via a signed operator attestation to the dedicated NUC without merging to
  `main` (`release-approval.md:11-16,103-109`).

---

## Open questions for the human

Each question changes the shape of the new plan; none can be answered from the repo.

1. **Does DSH replace the harness, the orchestration, or both?** The repo has two replaceable layers
   with very different sunk cost: OpenHands (replaceable — the stall/telemetry code is
   OpenHands-specific) and Restate (costly to replace — the `WorkUnit` stage machine, reconciliation,
   and awakeable gates are proven). Keeping Restate and swapping the harness is far cheaper than the
   reverse.
2. **Is the qualifier in scope for this plan, or still deferred?** The brief assumed it exists; it does
   not. If it stays deferred, "dark lane vs human lane" remains a human choice and the "fully dark,
   non-security-relevant diffs" claim has no mechanism behind it.
3. **What is the promotion rule for the new harness?** The repo's rule is "retain baseline unless every
   gate passes, and unknown is not pass". Is that inherited verbatim, or does DSH start with a fresh
   qualification cohort of its own?
4. **How will truncation be resolved?** It is the one blocker that no amount of new runs fixes, because
   the pinned SDK exposes no authoritative counter. Options are (a) keep native execution and declare
   truncation unknown forever, holding promotion, or (b) extend terminal instrumentation and freeze a
   new measurement baseline. The repo recorded both and chose (a) pending a decision
   (`sdk-truncation-audit.json`).
5. **Is the wall ever going to be wired into the loop?** Today it is a standalone CLI. Wiring it means
   an ephemeral deployment per candidate and a trusted revision binding — real work with real
   isolation questions. Is that in this plan, or still "run it by hand"?
6. **Which gates must actually block, and who approves them?** With one operator who is also the PR
   author, an "independent human escalation" gate cannot be satisfied. Either the gate becomes
   operator-signed self-attestation (weaker, must be labeled) or the plan needs a second person.
7. **Is `merged` a real target again?** It is unreachable in the current state machine, and `main` is
   merge-blocked by policy. Does the new plan end at `needs_validation` + open PR, at signed
   `validated`, or at an actual merge (which requires resolving the review gate first)?
8. **Does the new plan inherit the ledger/anchor anti-rollback requirement?** If yes, where does the
   anchor live so it is genuinely in a different failure domain? The repo is explicit that a
   co-located or co-restored pair detects nothing.
9. **What happens to the ~1 TB-scale retained evidence and retained Docker resources?** The repo
   deliberately retains every original namespace, volume, and workspace. A new plan needs a stated
   retention window and a sanctioned disposal procedure, otherwise it inherits an unbounded cleanup
   debt.
10. **Is `AGENTS.md` / codified knowledge in scope?** The source report calls it a prerequisite, not an
    optimization, and it is the one item on that list the repo never produced. A DSH-based factory whose
    whole premise is an agent reading repo context is more exposed to this gap, not less.
11. **May paid trials run?** Every experiment since Oct 30 required explicit authorization, and the
    Nov 1 cohort is prepared but **not dispatched** (`cohort-preparation.json`:
    `dispatch_authorized_by_this_receipt: false`, `paid_requests: 0`). A new plan that needs
    qualification data needs this authorization up front.

---

## Surprises worth flagging

1. **The qualifier does not exist**, despite being one of the three components the architecture says
   the whole project is about building. Everything about lane routing today is a human decision.
2. **The gate service has no callers.** `gate.ts` is registered and correct, and nothing in the
   workflow ever requests an approval. Only `initial_prod_deploy` was ever exercised, and that demo
   predates the current state machine.
3. **The wall is not wired into the orchestrate workflow**, and the operator passes a placeholder
   target (`http://127.0.0.1:1`) precisely because it isn't. The "wall gate" that actually gates is the
   operator's own `check_script`.
4. **`merged`, `gated`, and `deployed` are unreachable states.** `transition()` cannot enter them, yet
   they remain in the `Stage` union and several planning docs describe merged runs.
5. **`recordReceipt` deliberately throws.** The receipt type is fully specified and no trusted producer
   is wired; caller-supplied receipts are refused by design.
6. **`Date.now()` lease expiry** is still in the code with a comment acknowledging it breaks replay
   determinism.
7. **The most valuable asset is the measurement discipline, not the factory.** "Unknown ≠ pass",
   complete failed-consumption denominators, route strata, collector epochs, grader reconciliation
   without rewriting frozen scores — this is what took seven experiment rounds to learn, and it is
   portable to any harness.
8. **The promotion gate failed on completeness, not performance.** The combined profile cleared every
   threshold it could measure and still was not promoted.
9. **Two documents in the repo are stale in a load-bearing way**: `next-steps.md` (Oct 17, pre-split
   paths, a "merged" claim, "SDK calls UNVERIFIED") and `phased-plan.md`'s phase table. Both are still
   linked from `README.md:494`.
