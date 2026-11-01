# Findings & Decisions — Dark Software Factory on DSH

> Research discoveries, external content, and technical decisions.
> External/untrusted content lives here, never in `phased-plan.md`.
> Supporting research files live in `research/`:
> [dsh-architecture.md](research/dsh-architecture.md) (621 lines) ·
> [existing-state.md](research/existing-state.md) (558 lines) ·
> [pain-points.md](research/pain-points.md) (214 lines) ·
> [kickoff-research.md](research/kickoff-research.md)

## Requirements (from the direct request, 2026-11-01)

1. Use the existing research and planning documents in `/Users/bo/code/software-factory-dsh` as reference material (→ `dark-software-factory-report.md`, `README.md`, `docs/planning/stapled-factory/`, `docs/verification/`).
2. Produce a `bo-planner` plan for a **dark software factory**.
3. The factory uses **DeepSeek Harness (DSH)** and the public **`dsh-superagent-prototype`** repository as the underlying architecture.

## Scope decisions (user-confirmed, 2026-11-01)

| Question                | Answer                                                             | Consequence                                                                                                              |
| ----------------------- | ------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------ |
| Deliverable             | **Planning artifacts + full implementation**                       | The 14-phase workflow runs end to end; implementation lands in this session                                              |
| Architecture base       | **Clean-room on DSH packages**                                     | Do not fork the prototype; borrow its _domain design_ and DSH's _runtime packages_. DSH coupling sits behind one adapter |
| Implementation location | **Separate new checkout/repo** → `/Users/bo/code/dark-factory-dsh` | This repo keeps the planning docs + historical evidence only                                                             |
| Model routing           | **Fixed: DeepSeek models only, via the existing Bifrost gateway**  | No model-selection debate; the volatile decision is closed. Gateway config is a constraint, not a choice                 |

## Pain Point Research (Phase 2 — complete)

Full table: 42 sources across 10 platforms in [research/pain-points.md](research/pain-points.md).
Frequency is graded by **cross-source recurrence** (GitHub/HN reaction counts are not rendered in retrieved pages) and that is stated in its Method section.

### Problem Space

A **dark software factory** is a delivery system where AI agents carry work from intent to production with no human authoring or reviewing the diff (Shapiro's level 5; BCG Platinion's definition: "humans define business intent and review outcomes rather than writing code"). The problem space has four layers, and existing products occupy only the first two well:

| Layer                                       | What it must do                              | Who ships it today                                                                                                           |
| ------------------------------------------- | -------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------- |
| Agent loop / harness                        | run the model, tools, context                | Claude Code, Codex CLI, Cursor, OpenHands, Aider, DeepSeek Harness (DSH), SWE-agent                                          |
| Durable orchestration                       | survive crashes, retries, leases             | Temporal, Restate, DBOS, Hatchet, Inngest                                                                                    |
| **The wall** (generator-blind verification) | decide "done" without the generator          | **nobody ships this**; StrongDM's factory and gethuman.sh describe it; SWE-bench/holdout benchmarks _measure_ it             |
| **Qualifier + gates**                       | decide what may run dark; bound blast radius | **nobody ships this**; BCG's report describes the concept; the prior repo's `gate.ts` implements a primitive with no callers |

The gap is the point: our plan is concentrated on layers 3–4, and treats layers 1–2 as purchased/inherited (DSH for 1; our own ledger for 2 rather than a cluster).

### Competitor Friction

Where users report friction with existing solutions, by competitor (all sourced in [research/pain-points.md](research/pain-points.md)):

- **OpenHands** — loops are detected but not recoverable (`issues #5480`, `#11431`); loop handling "destroys contexts completely" rather than rewinding. Friction: an unrecoverable agent that also cannot be messaged.
- **Cline** — repetitive file looping past ~50k tokens (`#11033`) and a cache-breakpoint regression that bills full input rate on every autonomous step (`#15307`, a ~20× cost multiplier). Friction: cost invisibility.
- **Claude Code** — background agents that "cannot be stopped once launched" (`#37218`, four zombies for 4+ hours) and an orphaned shell loop that burned ~2.88M tokens over two days undetected (`#9704`); rules in CLAUDE.md systematically ignored (`#44461`). Friction: no kill switch, no watchdog, prompt-level rules.
- **Codex** — post-compaction amnesia: "may confidently continue while missing critical nuance from the pre-compaction work" (`#29356`). Friction: the operator must keep supervising.
- **Devin** — presses forward on tasks it cannot do; 3/20 completion on the corpus cited in T1. Friction: confident failure.
- **StrongDM's published "software factory"** — reviewers found stringly-typed errors, swallowed exceptions, an 800-line closure and a hallucinated Docker image in the README within days of release. Friction: the flagship proof did not survive outside inspection.
- **Mergify / merge queues** — not a coding agent, but the measured reality of review: 32.7% first-pass acceptance, 48% of reviewers always check AI code. Friction: review is the bottleneck, and it was already degrading.

**What this tells us:** no competitor's friction is "the model isn't smart enough". It is liveness, cost, killability, context loss, and the absence of an independent verdict. That is exactly what this plan builds.

### Top findings, condensed

| #   | Pain point                                                                                                                                                                                                     | Sources (from pain-points.md)       | Frequency                           | Relevance to our scope                                                    |
| --- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------- | ----------------------------------- | ------------------------------------------------------------------------- |
| P1  | The agent's self-report is not evidence; it fails **confidently**, not randomly ("All tests are passing" over a failing build; 19/45 false-positive fixes; 90% false success after a duplicated effect)        | 1, 13, 14, 16, 30, 31, 32           | Recurring, 4 independent lines      | Wall + receipt contract (R1)                                              |
| P2  | Optimising against the **visible** suite is the default attractor; the visible/holdout gap **grows ~28 pp per 10× code size**                                                                                  | 12, 13, 14, 15, 40                  | Recurring, benchmarked              | Holdout wall + Δ gate (R2)                                                |
| P3  | Stopping, uncertainty and "no" are not promptable capabilities (no model declined a refactor; CLAUDE.md rules read but not followed; guardrails routed around)                                                 | 9, 14, 19, 22, 34                   | Recurring across vendors            | Harness-owned termination/budget (R3)                                     |
| P4  | Orchestration is where "mostly works" becomes "silently loses work": unkillable loops, token burn, compaction dropping the current constraint, duplicate side effects on retry                                 | 2, 3, 4, 5, 6, 7, 8, 16, 24, 25, 26 | Recurring, most operator complaints | Durable effect ledger + liveness watchdog (R4)                            |
| P5  | Enforcement must live **below the model** — in code, credentials and topology ("Rules in prompts are requests. Hooks in code are laws")                                                                        | 10, 21, 22, 27, 28, 29, 34          | Recurring practitioner finding      | Gates as capabilities, not prompts (R5)                                   |
| P6  | Human review was **already** degrading (48% always check, 32.7% first-pass acceptance, 88% LLM-reviewer approval of a known CVE) — so the delta is "replacing the verification surface", not "removing review" | 17, 18, 20, 23, 35, 36              | Recurring                           | The wall must be adversarial _against itself_ (R6)                        |
| P7  | Intent ambiguity is upstream, cheap to fix, fatal downstream (200 lines for a 10-line need, all tests green)                                                                                                   | 17, 33, 38                          | Recurring                           | Qualifier rejects on **intent derivability** (R7)                         |
| P8  | Blast radius is realized **inside normal operating mode** (`--force` schema push, `git filter-repo --force`, DB delete under freeze, force-push via API)                                                       | 10, 11, 12, 27, 29, 31              | Recurring, 5 major incidents        | Reversibility as a **lane precondition**; no prod creds in worker (R5/R7) |

### The seven design requirements that fall out (this plan's spine)

- **R1 — Receipts, not reports.** Worker output is `{diff, commands[], exit_codes[], full_suite_output, artifacts[]}`; the wall re-derives every claim by re-execution in a clean environment. Model prose is audit-only, never a decision input.
- **R2 — Generator-blind holdout wall with a measured Δ.** Scenarios live outside the repo the worker can read, derive from the spec; triple-run 2-of-3; gate on `Δ = visible_pass − holdout_pass` per task class; wall criteria versioned and human-revalidated on a schedule. **Build this first.**
- **R3 — Harness-owned termination, budget, liveness.** Token/turn/wall-clock ceilings outside the model; no-progress detector; kill switch that provably reaches background + orphan processes; compaction that preserves the operational tail verbatim.
- **R4 — Replay-safe orchestration with a deterministic effect ledger.** Deterministic workflow code, all I/O in activities, idempotency keys hashed from operation inputs (never UUID/timestamp at retry), append-only committed-effects ledger, heartbeats on long activities.
- **R5 — Blast radius bounded at credential/topology layer.** No production write credentials in the worker; destructive verbs resolved by policy at a boundary the agent cannot call; per-attempt clean checkout; egress allowlist; command validation on the normalised post-expansion command.
- **R6 — The wall is adversarially tested against itself + human-audited on a schedule.** The honest claim is "independent + deterministic where possible + adversarially tested + audited", never "independent therefore safe".
- **R7 — Qualifier gates on intent derivability and reversibility**, and throughput is capped by wall capacity, not agent capacity (gethuman.sh's "restraint").

### Counter-evidence we must not bury (it changes the plan's justification)

1. **At current scale AI-assisted PRs break `main` _less_ often** — Mergify's 153k-merge dataset: 1.9% vs 4.4%; autonomous-agent-authored PRs are "a rounding error" (~few hundred of 153k). The live pain is **review throughput and trust**, not autonomous breakage. The plan is justified by P1/P4/P6, not by "AI code is breaking everything".
2. **The flagship PoC did not survive outside inspection** (HN found stringly-typed errors, swallowed exceptions, an 800-line closure, a hallucinated docker image in the README). The wall catches _behavioural_ failure; nothing in the published design catches _taste_.
3. **The framing's most credible advocate walked his own claim back** ("not ready to say it's demonstrated outside a demo I saw for an hour"). Two public attempts exist, neither with a longitudinal record. **We are planning against a hypothesis**; the plan says so.
4. **Documented successes were verifiable-by-construction** (StrongDM built against digital twins of Okta/Jira/Slack/Drive → cheap, complete oracle). Darkness is a **per-domain property we must earn**, not a platform capability we install.
5. **Criteria drift is the deepest objection**: EvalGen says criteria cannot be fully specified before human judging, and an LLM reviewer approved a known CVE 88% of the time when framed as a fix. Hence R6.

## Existing-state findings (what we inherit and must not break)

Full audit: [research/existing-state.md](research/existing-state.md). The prior factory (`stapled-factory/`, docs in `docs/planning/stapled-factory/`) is **Path A** (OpenHands + Restate + Bifrost) and is **not** the base for this plan — but its hard-won invariants are.

Corrected premises (the audit contradicted the brief):

| Assumption                          | Reality                                                                                                                                                                                                                             |
| ----------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| "The qualifier exists"              | **It does not exist.** No module, service, test or config. Lane routing today is a human choosing the unit. Closest reusable primitive: `security/pipeline.py:238-242` (`classify_security_relevance`)                              |
| "The gates are exercised"           | `spine/src/gate.ts` is correct and registered but has **zero in-repo callers**; only `initial_prod_deploy` was ever exercised                                                                                                       |
| "Receipts are trusted"              | `recordReceipt` **deliberately throws** — "caller-supplied receipts cannot establish a trusted target binding". Contract specified, no trusted producer wired                                                                       |
| "The wall is wired"                 | The wall is correct and tested but is a **standalone CLI**, never called by the workflow; the operator passes a placeholder target                                                                                                  |
| "The harness qualification settled" | Final decision was `retain_baseline` because 3 promotion gates were **unknown**, not failed; every paid run reports `actual_charges_usd: null`; `docs/verification/harness-qualification-2026-11-01/` is **uncommitted mid-flight** |

### Invariants a new factory must inherit

1. **No automatic redispatch; an ambiguous result is observed under its original identity.** (`worker/attempt_store.py`, `orchestrate.ts:68-83`, README:85-88, :326)
2. **Budget is a best-effort estimate, not a charge cap; unknown stays unknown.** Missing telemetry must propagate as `unknown` and can never satisfy a gate. (Proven live: a route reported $0.03471204 against a $0.014749 reservation.)
3. **Never reset a quarantined store, never delete active markers, never unfence.** Ledger + independent anchor stay in separate failure domains; a coordinated rollback of both is explicitly undetectable.
4. Deterministic controls enforce; LLMs advise. Never replay an LLM call. The wall is a quality gate, not a security boundary. The worker gets neither gateway credentials nor signing keys.
5. **Evidence honesty as a discipline**: "unknown ≠ pass", complete failed-consumption denominators, route strata reported separately, collector-epoch disclosure, grader reconciliation that appends rather than rewrites frozen scores.

The audit's own conclusion: the most valuable portable asset is that **measurement discipline**, not the OpenHands plumbing.

## DSH architecture findings (the base we build on)

Full evidence: [research/dsh-architecture.md](research/dsh-architecture.md). Claims below are verified against the installed binary (`dsh --version` = `0.2.1-rc.3`) and/or the checkout at `/Users/bo/code/deepseek-harness/deepseek-harness` (0.2.1-alpha.4).

### D3 correction — verified by the Lead, 2026-11-01

Research D3 said "unattended work must run in a container because headless has no approval answerer and `never` only arrives with `danger-full-access`". That is true only of the **shipped base patch's coupling**. The base patch (`packages/bundle/base/cordis.patch.yml:239-264`) sets `sandbox-policy.mode` from `DSH_PERMISSION_MODE` and separately sets `approval.policy` to `never` **only when** the mode is `danger-full-access`; in `workspace-write` it is `ask`, which fails closed in headless.

A `--patch` overlay applied last **can decouple them**. Verified composition with `--dump-config` in a throwaway `DSH_HOME`:

```yaml
# /tmp/factory-probe/overlay.yml
- id: sandbox-policy
  name: '@deepseek-ai/dsh-sandbox-policy'
  config: { mode: workspace-write, workspaceRoot: /tmp/factory-probe/work }
- id: approval
  name: '@deepseek-ai/dsh-user-approval'
  config: { policy: never }
```

`dsh --profile headless --patch … --dump-config` shows `mode: workspace-write` **with** `policy: never` — the worker never blocks on an approval while still being confined to its attempt directory.

**But decoupling alone is not enough (second probe).** A run with only those two entries printed `dsh: warning: 1 entry did not activate — permission (@deepseek-ai/dsh-permission-presets): composed sandbox and approval defaults match no preset; configure defaultPreset explicitly`. The permission-presets service validates that the composed pair matches a **named** preset. The working overlay therefore needs **three** entries — `sandbox-policy`, `approval`, **and** `permission-presets {defaultPreset: factory-worker, presets: {factory-worker: {sandbox: workspace-write, approval: never}}}`. A probe of the full overlay (plus provider `bifrost` → proxy `baseURL`, `apiKeyEnv: BIFROST_API_KEY`, per-worker model id) then failed only with `MISSING_CREDENTIAL` for route `bifrost`, proving the route override works without touching DSH.

**Consequence:** the per-attempt overlay is load-bearing and must emit all three permission entries; a two-entry overlay degrades the permission service **silently** (a warning, not a failure) — a named risk with a test in Phase 9b. The container remains necessary for _egress and OS-level_ isolation, not for approval liveness. Full transcript: [`evidence/phase-9b-dsh-integration-probe.md`](evidence/phase-9b-dsh-integration-probe.md).

### The composition order (verified, `apps/cli/README.md` §Profiles)

`bundles in dsh.profile.bundles order → profile cordis.patch.yml → $DSH_HOME/cordis.patch.yml → --patch overlays`. A custom profile is created once with `dsh --profile factory-worker --from-default-profile headless`; every attempt then layers a `--patch` overlay on top.

| #   | Finding                                                                                                                                                                                                                                                               | Consequence for the plan                                                                                                                                                           |
| --- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| D1  | `dsh --profile headless --json "<task>"` is a real one-shot runner: NDJSON `session` → `status` (`turn_start`/`step_start`/`step_end`/`turn_end`) → `final`; exit 0 = completed final turn, exit 1 = aborted/error/no turn; `--session-id` adopts a persisted session | Worker seam = headless subprocess. Liveness = NDJSON `status` events. Outcome = exit code + `turn_end.reason`, **never** the prose                                                 |
| D2  | **No** `--print`, `--model`, `--max-turns`, `--sandbox`, `--permission-mode`, `--resume` flags. Model/sandbox/approval are **composition config** (`agent-default-model`, `DSH_PERMISSION_MODE`, permission presets)                                                  | The factory **generates a `--patch` overlay per attempt**; it must not depend on flags that do not exist                                                                           |
| D3  | Headless has **no approval answerer**: default `ask` fails closed (`unavailable`); `never` only arrives with `danger-full-access`                                                                                                                                     | Unattended work must run in a _container/OS-user boundary_ (outside DSH) — the sandbox is explicitly "same-world only" (shares host kernel + filesystem)                           |
| D4  | **No monetary cap, no cost accounting** in `packages/llm/**`. `token-meter` is explicitly not billing-grade; `llm-retry` retries can repeat input-token billing; `always` retry mode is unbounded                                                                     | The factory owns a **price table + spend ledger** and must disable unbounded retry                                                                                                 |
| D5  | The one-shot run **inherits the home patch layer** (`$DSH_HOME/cordis.patch.yml` applies to every profile) — verified by a run that started the user's gmail/calendar MCP servers and a third-party plugin                                                            | Each trust domain needs its own `DSH_HOME` and credentials; a "profile" alone is not isolation                                                                                     |
| D6  | **No diff/artifact output.** A headless run yields mutated workspace + exit code + final text + session log                                                                                                                                                           | The factory owns `git worktree` per attempt and `git diff --binary` capture (capture the diff **even on exit 1** — a failed run leaves useful changes)                             |
| D7  | Session log: append-only, checksummed zstd frames, `session.v4.jsonl.zstd`, header carries `agentPreset`/`origin`/`delegationDepth`/`parentSession`/`agentProvider`/`agentModel` and a `sandbox/mode` event; single-writer `session.lock`                             | The log is a real audit trail **per session**, not per run — the factory records the session-id tree, and may set `compression: none` on a dedicated `DSH_HOME` for greppable logs |
| D8  | **`--json` is lossy** (every string capped at 8 KiB with `truncated`)                                                                                                                                                                                                 | Audit reads the log / `sessionQuery`, never the `--json` projection                                                                                                                |
| D9  | DSH's own `workflow` tool always disposes its run; team tasks/jobs are process-local with no owner release; no cross-process leases                                                                                                                                   | **Durability is the factory's job.** DSH is never the source of truth for "did this unit run"                                                                                      |
| D10 | ACP (`dsh --profile acp`, stdio JSON-RPC) is the only seam with per-session model selection **and** programmatic permission answers **and** resume                                                                                                                    | Headless is v1; ACP is the documented upgrade path behind the same adapter interface                                                                                               |
| D11 | DSH is a developer preview with breaking changes promised; installed app (rc.3) ≠ checkout (alpha.4) ≠ prototype's `engines.dsh` (`^0.2.1-alpha.2`)                                                                                                                   | **Pin one exact version**; all DSH coupling behind one adapter module                                                                                                              |
| D12 | Prototype is public, MIT, 216 files: a DSH _bundle_ implementing Source→Trigger→Thread→Eval→Decision→Ticket→Assignment→Report over SQLite, a router Session + one `worker-<ticket>` Session per ticket, per-role models, worker slots, handoff, stored-work retries   | This is the **reference design to borrow**: gated intake, per-role model seeding, worker slots, reports-not-states, stored work with backoff                                       |

### The prototype design we borrow (clean-room, not a fork)

| Prototype concept                                                                           | What we take                                                                              | What we change for a dark factory                                                                                       |
| ------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------- |
| `Source` → `Trigger` → `Thread` (idempotent intake, read position, bot-identity separation) | Intake with a stored read position and at-most-once Trigger acceptance                    | Intake from a ticket file/API, not GitHub/Feishu, in v1                                                                 |
| `Eval` = deterministic **Gate** + model **Assessment** → `Decision`                         | Two-layer gate: deterministic rules first, model judgement second and never authoritative | Our deterministic layer becomes the **qualifier** and must be able to _reject on intent derivability and reversibility_ |
| `Mandate` (immutable grant: policy version, scope, strength, basis)                         | Immutable, revalidated grant recorded with every attempt                                  | Strength now includes a **lane** (`dark`/`lit`) and a **budget envelope**                                               |
| `Ticket` / `Assignment` / `Report` (report ≠ ticket state)                                  | Report is evidence; the ticket owns its own lifecycle                                     | Report is replaced by a **receipt**; prose is audit-only                                                                |
| Stored work + `Effects` queue with backoff and ordering per kind                            | Outbox with deterministic idempotency keys and per-kind ordering                          | Same, but the ledger is **append-only and replayable** (R4)                                                             |
| `WorkerSlots` with a human-priority extra slot                                              | Concurrency limit owned by the control plane                                              | Plus **wall-capacity** as the throughput ceiling (R7 restraint)                                                         |
| Per-role model seeding + `role-models.ts`                                                   | Orchestrator model ≠ worker model, recorded in the session header                         | Model **family is fixed** (DeepSeek via Bifrost); only the tier varies                                                  |
| Its own docs' warning: wrappers are "defaults, not a security boundary"                     | —                                                                                         | We add a real boundary (container/OS user) and never claim the sandbox is one                                           |

## Phase 3 (Data Map) Kickoff

- Queries: none — data model is fully determined by R1/R4 plus the inherited invariants; skipping is recorded here per the skill's allowance.
- Findings: the store is a single SQLite database with an append-only `events` table and derived aggregates (unit, attempt, claim, lease, receipt, gate, budget entry). No privacy-regulation exposure: the factory handles source code and model transcripts, not personal data at rest beyond operator identities. **No kickoff search performed — reason: the datastore and durability model are already pinned by Phase 5 architecture and the "one Postgres box / SQLite + WAL" prior-art in the report §7.** Deltas from kickoff research for Phase 5/6 are recorded below.

## Phase 5 (Architecture) Kickoff

- Queries: 20 queries across 5 searches by `kickoff-researcher` — durable orchestration in TypeScript 2026, agent sandboxing/microVMs on macOS, DSH release/ACP status. Full detail + 56 sources: [research/kickoff-research.md](research/kickoff-research.md).
- Findings and deltas vs. training-data assumptions:
  1. **Isolation moved up the stack.** Both Claude Code and DSH itself (0.2.1-rc.1 Git-worktrees plugin → "Change requests and worktrees" in 0.2.2-alpha.2) now ship enforced per-session worktrees. macOS 26 + Apple silicon has a first-party microVM runtime (**Apple Containerization**, with the official `sandboxy` agent-sandboxing example: microVM per session, virtio-fs workspace, **host-side HTTP CONNECT egress allowlist**). **Delta:** the missing control is _egress_, not filesystem scope. Our plan keeps Docker for v1 and records Apple Containerization as the isolation upgrade path.
  2. **DSH is public and already past the installed version** — `0.2.1-rc.5` (2026-10-30) is the newest release, `0.2.2-alpha.2` the newest tag, and **no stable tag exists**; the 0.2.2 line raises the Node floor to **24.9**. **Delta:** "DSH 0.2.1 is current" is wrong, and pinning `0.2.1-rc.3` (installed) is a deliberate choice rather than a default.
  3. **ACP v1 is stable** (v2 in draft since 2026-07-20; TS/Rust SDKs 1.0 since 2026-06-25), and DSH ships an ACP profile (rc.4 fixed diagnostics leaking into stdout in ACP mode). **Delta:** ACP is a better-specified seam than NDJSON, though DSH's own ACP surface remains UNVERIFIED — it stays the documented upgrade path, not v1.
  4. **No durable-execution engine displaced Temporal as the institutional default**, but for a single operator with Postgres already on 5432, "own event log + DBOS as the upgrade path" beats operating a cluster; **Restate's server is BSL 1.1** (a licence trap the prior repo already depends on).

## Phase 6 (Tech Guide) Kickoff

- Queries: registry-resolved version checks (`npm view`) plus primary docs; full pinned table with 56 source URLs in [research/kickoff-research.md](research/kickoff-research.md). Lead independently re-verified `typescript@7.0.2`, `vitest@5.0.5`, `tsx@4.23.15`, `zod@4.6.7`, `commander@15.0.0`, `pino@10.4.0`, `@playwright/test@1.64.1` and installed/ran the toolchain in a scratch project (see `progress.md`).
- Findings and deltas:
  1. **Node**: this machine runs **22.23.3**; `node:sqlite` is an **RC only on ≥25.7** and still experimental on 22 (verified locally: `DatabaseSync` only, SQLite 3.51.3, no `backup()`); DSH 0.2.2 needs **≥24.9**. **Delta:** the plan declares an engine window and keeps the sqlite driver swappable instead of assuming the local Node is sufficient forever.
  2. **`node:sqlite` traps**: the class is being renamed `Database` (`DatabaseSync` = DEP0210) and **`busy_timeout` defaults to 0** → instant `SQLITE_BUSY` on a second connection. **Delta:** `busy_timeout=5000` and `synchronous=FULL` are now mandatory settings in the tech guide (WAL `synchronous=NORMAL` explicitly gives up commit durability).
  3. **TypeScript 6→7 defaults** are silent breakage, not errors: `types: []`, `rootDir` = tsconfig dir, `strict`/`module: esnext`/`target: es2025` default. **Delta:** `types: ["node"]` and `erasableSyntaxOnly: true` are explicitly set.
  4. **Node type stripping inverted**: it is stable and default-on in 24.12/25.2, and `--experimental-transform-types` was _removed_ in 26. **Delta:** we run TS via `tsx` on Node 22 rather than relying on native stripping.
  5. **Playwright is browser-only** — it cannot drive a CLI. **Delta:** CLI/process e2e runs on **vitest 5 + `child_process`**; Playwright covers only the read-only status page. The original plan's "Playwright for e2e" framing was wrong and is corrected in `e2e-tests.md` / `tech-guide.md`.
  6. **DSH binary is not on `PATH`**: the real binary is `/Applications/DeepSeek Harness.app/Contents/Resources/runtime/cli/bin/dsh` and reports `0.2.1-rc.3`. Also `npm i deepseek-harness` is an unrelated name squat. **Delta:** resolution order pinned in the tech guide (resolves open question #2).

## Phase 7 (UX Planning) Kickoff

- Findings: the surface is **CLI-first** (the prior factory's operator CLI is the reviewed precedent). Kickoff research covers terminal UX practice, `NO_COLOR`/non-color state redundancy, and the human-vs-agent message asymmetry (a failure line must be _opaque to the generator_ and _complete for the operator_). No WCAG-for-CLI standard exists; the plan applies WCAG 2.2 AA to the status page and the equivalent discipline (non-color meaning, screen-reader-safe tables, plain-text fallback) to terminal output.

## Phase 8 (UI Planning) Kickoff

- Findings: v1 UI is a **read-only local status page** (two routes, loopback + token) so that "what needs a person" is visible; no design-system dependency, no SPA. Current CSS feature maturity (container queries, `color-scheme`, `prefers-contrast`) is sufficient for one page without a component library.

## Phase 10 (E2E Test Generation) Kickoff

- Queries: Playwright current major + CLI-testing practice (see [research/kickoff-research.md](research/kickoff-research.md)).
- Findings: **`@playwright/test` 1.64.1 is current** and is **browser-only** — it cannot exercise a CLI. CLI/process-level e2e therefore runs on **vitest 5 + `node:child_process`** (spawn `factory`, assert exit codes and `--json` payloads); Playwright is used **only** for the status page. Current Playwright practice adopted: `trace: 'on-first-retry'`, `workers: 1` for the single-page suite, `retries: 0` locally, and **no retries for safety-critical tests** (a flaky safety test is a blocker, not a retry).

## Technical decisions log

| #   | Decision                        | Choice                                                                                                                                                                                                                                                             | Rationale                                                                                                          | Reversal cost                               |
| --- | ------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------ | ------------------------------------------- |
| TD1 | Language/runtime of the factory | TypeScript on Node 22 (LTS)                                                                                                                                                                                                                                        | DSH is TS; headless/ACP seams and NDJSON parsing are TS-native; single toolchain for control plane + wall + CLI    | High if wrong; low probability              |
| TD2 | Durable store                   | Single SQLite file, WAL, append-only `events` + aggregates, effect outbox with deterministic idempotency keys                                                                                                                                                      | R4; "one box is enough" (report §7/§9); avoids Temporal/Restate ops while satisfying replay-safety by construction | Medium — the ledger is portable to Postgres |
| TD3 | Worker seam                     | `dsh --profile factory-worker --json` subprocess per attempt, per-run `--patch` overlay, dedicated `DSH_HOME`                                                                                                                                                      | D1/D2/D5/D6/D10; gives crash isolation and clean env; ACP remains the upgrade path behind the adapter              | Low (adapter)                               |
| TD4 | Isolation boundary              | Docker container (available: 29.8.2) inside which DSH runs; git worktree per attempt; no prod credentials in the container                                                                                                                                         | D3/D5; DSH's sandbox is "same-world only" and must not be the boundary                                             | Low                                         |
| TD5 | Harness durability              | DSH is **not** the source of truth; the factory's ledger/claims/leases decide                                                                                                                                                                                      | D9                                                                                                                 | Low                                         |
| TD6 | Model routing                   | Fixed: DeepSeek models via existing Bifrost gateway; per-role tier only (router vs worker)                                                                                                                                                                         | User decision 2026-11-01; closes the most volatile decision category                                               | n/a                                         |
| TD7 | Wall placement                  | Separate process/package, own `DSH_HOME`, own holdout store outside every worktree, no worker-visible credentials                                                                                                                                                  | R2; D5                                                                                                             | Low                                         |
| TD9 | Model in the decision path      | **None in v1.** The qualifier is deterministic only; the optional "advisory assessment" is removed (it created a contradiction with L2 and with constraint C5, and no test could prove it harmless). Revisit only with a story + an off-by-default flag + a debate | R5/L2; C5                                                                                                          | Low                                         |
| TD8 | Receipts                        | `{diff, commands[], exit_codes[], full_suite_output, artifacts[]}` + session-id tree + verdict receipt, all content-hashed                                                                                                                                         | R1; inherited invariant "receipt binds result → claim → stage → git revision"                                      | Low                                         |

## NEEDS_HUMAN_DECISION

_(none yet — items surface from the Architecture and Tech Guide debates)_

## Contradiction log (resolved 2026-11-01)

Four inconsistencies were found between `architecture.md`, `phased-plan.md` and the Phase 3/4 artifacts. All are resolved; the resolution is recorded here so an auditor can see they were decided rather than drifted.

| #   | Contradiction                                                                                                                    | Resolution                                                                                                                                                                                                                                                                                            |
| --- | -------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| X1  | `packages/cli` (phased-plan 9e) vs `apps/cli` / `apps/panel` (architecture C9/C10)                                               | **`apps/cli` + `apps/panel`** win; `phased-plan.md` phase table patched                                                                                                                                                                                                                               |
| X2  | Goal says _exactly three_ human gates; architecture §2.4 marked four rows "human required"                                       | **Three human gates** (prod deploy, budget envelope, privileged credentials). The destructive-operation boundary is a **structural deny** whose escalation goes through the credential gate; the architecture table now says so, and `user-stories.md` US-E7-02 asserts exactly three gate categories |
| X3  | The "wall-first" rule omitted the 9b dependency (re-execution consumes a C8 receipt)                                             | 9c now explicitly depends on 9a **and** 9b; the sabotage proof runs first on `FakeExecutor` synthetic receipts and is **re-run and replaced** against a real receipt after 9b                                                                                                                         |
| X4  | Architecture §2.1 allowed an optional advisory model call in the qualifier while §2.4/L2/C5 forbade a model in the decision path | **Advisory call removed** (TD9). Qualifier has no LLM import; US-E1-03 asserts it                                                                                                                                                                                                                     |
| X5  | A `lit` unit had no sink (parks in `qualified` forever)                                                                          | **`lit_parked` is a real state**, and it lands in the Phase 9a schema (`data-map.md` flag F1 resolved)                                                                                                                                                                                                |

## Post-debate rulings (2026-11-01, Phase 9 implementation)

The Phase 5 debate returned while 9a–9e were being implemented. Each amendment that changed _shipped behaviour_ (rather than the document) is recorded here with what was built.

| #      | Ruling                                                                                                                            | Implemented as                                                                                                                                                                                                                                                                                                                 | Where               |
| ------ | --------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------- |
| A5     | Security-relevant changes never go dark                                                                                           | `classifySecurityRelevance` in `packages/qualifier/src/security.ts` + a **lane lock** applied after scoring: it can only demote `dark → lit`, never `reject → lit`, never raise a score. Implemented as a lock rather than a seventh weighted signal because a weight can be outvoted by six passing ones                      | qualifier + tests   |
| A14    | The aggregate "≥90 %" rule is retired as a certification authority                                                                | 2-of-3 per scenario is **flake damping only**; the wall and its README state "v1 certifies no pass rate", with the α/β table that shows why                                                                                                                                                                                    | wall                |
| A6     | The wall owns the oracle                                                                                                          | Acceptance/holdout run the wall's own pinned runner over the base test root; the receipt's `commands[]` is forensic and is used for _faithfulness_ only. The wall's own run is authoritative when the two disagree                                                                                                             | wall                |
| A10    | Δ provenance and uncertifiable classes                                                                                            | Δ comes only from the wall's re-executed run; an errored scenario yields `unknown` with **no** Δ sample; a class below `minDeltaSamples` yields a verifying verdict carrying `promotionRequiresHumanSignature` (a flag, **not** a reason code, so "verifies but needs a human" is expressible without lying about the outcome) | contracts + wall    |
| A3/A13 | Worker container contract                                                                                                         | Self-contained clone at the identical absolute path, per-attempt `DSH_HOME` volume, `--internal` network with exactly two members, blocking negative-egress test                                                                                                                                                               | 9b adapter          |
| A4     | Holdout-run container contract                                                                                                    | Pinned-image, non-root, read-only root, `--internal`, no `~/.factory` mount, driver outside the candidate holding the expectations, digest recorded in the wall revision                                                                                                                                                       | wall                |
| —      | **Plan error found and corrected in code, not docs:** `consensus-plan.md` §A4.2 says an out-of-scope path is `receipt_unfaithful` | Implemented as `scope_violation` (both ordinary and sensitive-undeclared), because "the receipt misrepresented reality" and "the change went where it said it would not" are different facts and a verdict reader must be able to tell them apart. **The document is wrong here**                                              | wall                |
| —      | New receipt fact needed for `no_change`                                                                                           | `DiffRecord.statusPaths?: string[]` (optional; the column is JSON so no migration) — without it, "changed nothing" and "did work it never staged" are indistinguishable, and `filesChanged: number` cannot express the second                                                                                                  | contracts + adapter |

## Phase 13 candidates

**`insertReceipt` advances the ledger but not the attempt row.** The receipt is written, `attempt.receipted` is appended, and a replay of the ledger therefore computes `produced-receipt` — but the `attempts` row itself keeps whatever launch state it had (`planned` or `launching`). Nothing in the shipped code depends on the row's post-receipt value _yet_; the read-only panel is the first reader to notice, and it had to treat "this attempt has a receipt" as the evidence that overrides the stale state, otherwise every completed unit's attempt looked like a launch nobody picked up and the executor read `degraded` forever. Found while building `apps/panel`; recorded, not fixed. Candidate fix: have `insertReceipt` move the attempt to `produced-receipt` in the same transaction, and add an audit assertion that the row and the replay agree.

**The `Store` interface exposes neither the promotion row nor the quarantine reason.** `getPromotion(unitId, verdictSha)` returns only `{promotionId}`, so `signedBy`/`signedAt` are read from the `unit.promoted` event and the panel's `promotion.id` is a stable reference (`P-<hash12>` over the signed promotion hash) rather than the row's own id. `isQuarantined()` returns a boolean and the recorded reason is not reachable, so `health.store.since` is permanently `null` and the page names the condition plus the runbook instead of the reason it cannot read. Both are honest workarounds, not bugs to live with. Candidate fix: `getPromotion()` returning the full row and `quarantine(): { reason, at } | null`.

## Findings from the e2e build (Phase 10)

The process-level and browser suites found five things unit tests could not. All are fixed or recorded; none were papered over.

| #   | Finding                                                                                                                                                                                                                               | Status                                                                                      |
| --- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------- |
| P1  | `run` never called `evaluate()`, so the factory could not produce a verdict at all — the wall was a well-tested package nothing called                                                                                                | fixed: `run` wires `evaluate()` + `recordVerdict`                                           |
| P2  | `runForMajority` rebuilt its input and silently dropped **`testRootFrom: 'base'`** — amendment A6's "the wall owns the oracle" was implemented correctly and never received its instruction                                           | fixed, with the refusal test as the red-then-green                                          |
| P3  | `run` never created the attempt clone and there was no configured pristine mirror, so the real executor would have failed `assertSelfContainedClone`                                                                                  | fixed: `FACTORY_PRISTINE_REPO` + `FACTORY_REPO`, fail closed with exit 8 and a runbook line |
| P4  | The panel omitted the `initial_production_deploy` gate the CLI emits for a verified unit — the page understated what the operator must do (ux A-1)                                                                                    | fixed, with a cross-surface **set-of-kinds** assertion so a later divergence is caught      |
| P5  | A labelled `pass` (a reason code on a passing verdict) is unrecordable by design: `assertVerdictIsEarned` treats "pass with caveats" as `unknown`. The fake wall therefore labels itself through `wallVersion`, not through `reasons` | kept as designed; contracts unchanged                                                       |

The pattern behind P1–P3 is worth naming: each was a correct control that its caller never invoked. Isolation tests cannot find that class of defect, because the control passes on its own. Only a run through the real composition root — which is what `e2e/cli` and `e2e/panel` are — exposes it. That is the argument for keeping the e2e suite in the acceptance gate rather than treating it as optional.

## Open contract decision: receipt identity vs evidence identity (2026-11-01)

`Verdict.receiptSha` and `receipts.receipt_sha` are two different hashes, and the store's join between them (`insertVerdict`) compares them directly. They diverge for **every receipt that carries a `narrative`**:

- the store hashes the whole stored `WorkerReceipt` (narrative included);
- the wall hashes `toDecisionReceipt(body)` — the projection without narrative, because L1 says the wall must never see the agent's prose.

So a real receipt with a narrative is unjoinable to its own verdict. `apps/cli` works around it by stamping the stored sha onto the verdict, which makes the gate pass but leaves the contract saying two incompatible things.

**Ruling (for the next round, not applied tonight):** the evidence identity must be the **decision projection** — the bytes the wall was given — and the store should keep the full body only as the record. That means `insertReceipt` and `insertVerdict` both hash `toDecisionReceipt(body)`, and `receipts.receipt_sha` becomes "sha of the evidence", not "sha of the stored bytes".

**Why it was not applied:** the change was made, then reverted. It ripples through every fixture that constructs a receipt (17 store tests plus the panel and e2e fixtures all hashed the full body), and doing that across five agents' files at the end of a session is exactly the kind of sweeping edit that breaks a control silently. The workaround in `apps/cli` is documented and correct; the contract fix is a single coordinated change with its own test-count budget.

Recorded here rather than left in a chat log because the symptom ("a promotion gate that only passes because the CLI rewrote the hash") is invisible in the code that would fail.
