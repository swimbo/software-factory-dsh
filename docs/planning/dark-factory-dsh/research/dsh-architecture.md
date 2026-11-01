# DSH Architecture — research for the dark software factory

Status: research note, 2026-11-01. Author: dsh-repo-researcher (teammate of `lead`).
Scope: (1) the public prototype repo `deepseek-ai/dsh-superagent-prototype`; (2) the DeepSeek Harness
runtime installed on this machine. Nothing in this document modifies the factory repo; every claim
carries a path or URL, and anything I could not verify is marked **UNVERIFIED**.

## Evidence conventions (read this first)

| Fact                                                                                                                                                                                                           | Verified how                                                                                                               |
| -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------- |
| `https://github.com/deepseek-ai/dsh-superagent-prototype` is **public**, branch `main`, MIT, TypeScript, created 2026-10-31, 5,524 stars, 236 tracked paths                                                    | `https://api.github.com/repos/deepseek-ai/dsh-superagent-prototype`, `.../git/trees/main?recursive=1` (`truncated: false`) |
| The prototype was read in full from a tarball of `main` (2026-10-31 push)                                                                                                                                      | `https://codeload.github.com/deepseek-ai/dsh-superagent-prototype/tar.gz/refs/heads/main`                                  |
| **The path in the task brief is not readable.** `/Applications/DeepSeek Harness.app/Contents/Resources/app.asar/dsh/` is a file inside an asar archive (`file` reports `data`; `ls` reports "Not a directory") | `ls -la "/Applications/DeepSeek Harness.app/Contents/Resources/app.asar"`                                                  |
| DSH source evidence below is the git checkout `/Users/bo/code/deepseek-harness/deepseek-harness` at tag `dsh-v0.2.1-alpha.4`                                                                                   | `git describe --tags` → `dsh-v0.2.1-alpha.4`                                                                               |
| The **installed** runtime is a different, older build: `0.2.1-rc.3`                                                                                                                                            | `/Applications/DeepSeek Harness.app/Contents/Resources/runtime/cli/bin/dsh --version` → `0.2.1-rc.3`                       |
| CLI behaviour was verified against the installed binary, not only the checkout                                                                                                                                 | `--profile headless --help`, `--profile acp --help`, and one real one-shot run (below)                                     |
| Local runtime state on this machine                                                                                                                                                                            | `$DSH_HOME=/Users/bo/.dsh`, profile `desktop`, session files under `~/.dsh/sessions/`                                      |

**Version skew is a first-class finding.** The checkout (`0.2.1-alpha.4`) and the installed app
(`0.2.1-rc.3`) are the same feature line but not the same build. Any factory work must pin one, and
the prototype's `package.json` demands yet a third thing: `"dsh": "^0.2.1-alpha.2"`.

---

## Verdict

- **Yes, DSH can serve as the worker/agent layer, and it is the only sane choice here** — it already
  ships a one-shot scriptable runner (`dsh --profile headless "<task>"`, exit 0/1, NDJSON `--json`),
  a stdio automation server (ACP: create/resume/list/cancel sessions, select model, auto-answer
  permission prompts), a JSON-RPC SDK, in-process plugin composition (Cordis), a durable append-only
  session log, and a file-effect sandbox. A factory does not need to invent an agent loop.
- **The public prototype is the reference architecture for the "superagent" layer, but it is not the
  factory and must not be mistaken for it.** It is a DSH _bundle_ (plugin) that runs **in-process**
  inside one DSH profile, one GitHub repo per install, with a SQLite domain store of
  Trigger/Thread/Eval/Decision/Ticket/Assignment/Report, a policy gate, a main "router" Session and
  one `worker-<ticket>` Session per ticket. It contributes the control-plane _patterns_
  (gated intake, per-ticket worker sessions, worker slots, handoff-to-human, reports), not a reusable
  control plane.
- **The hard factory requirements are NOT in DSH**: no durable/replayable workflow engine (Restate's
  job), no run-level cost or token budget cap, no container/VM boundary (sandbox is "same-world only":
  bwrap/Landlock, Seatbelt, Windows ACL), no multi-tenant auth on the HTTP surface, no queue with
  leases/at-most-once admission across processes, and no diff/review artifact contract. DSH produces
  a **workspace state + exit code + session log**, not a reviewable patch.
- **Isolation is the single biggest gap to a "dark" (unattended) factory.** Both shipped unattended
  modes run as the operator's OS user with `danger-full-access` available (the prototype's own docs
  say outright that its wrappers "establish defaults, not a security boundary"), and DSH's
  home-level patch layer is inherited by _every_ profile — verified: my headless run loaded the
  user's home MCP servers (`gmail-imap`, `calendar-ics`) and a third-party plugin.
- **Recommended seam: DSH-in-process bundle for the control plane's agent-facing tools + headless/ACP
  subprocess workers per unit of work, with the factory owning durability, budget, and the diff/gate
  contract.** The prototype's in-process `DshExecutor` approach is the richest but couples the factory
  to DSH internals and the app build; the ACP profile is the cleanest process boundary that still
  offers resume, model selection and automatic permission decisions.

---

## The prototype repository — inventory + purpose

Repository: `https://github.com/deepseek-ai/dsh-superagent-prototype` (public, `main`).
Self-description (`README.md`): _"a proactive coding agent for one GitHub repository, packaged as a
bundle for DeepSeek Harness … Research prototype for reference only, not an official DeepSeek
product."_ Its `package.json` summary is the sharpest one-liner: _"it listens to GitHub and optionally
Feishu, evaluates requests under a Policy, turns authorized ones into Tickets, and executes each in its
own DSH Session."_

Domain flow (`docs/001-domain.md`, `docs/007-architecture.md`): **Source → Trigger → Thread → Eval →
Decision → Ticket (with Mandate + Subscriptions) → Assignment → Executor Session → Report → Outbox
message**. It is an attention-economy design: `docs/000-philosophy.md` — _"Take as little human
attention as possible, and give as much value as possible."_

### Top level

| Path                                                    | What it is                                                                                                                                                    | Why a factory planner should care                                                                                   |
| ------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------- |
| `README.md`                                             | Bundle overview, doc index, `pnpm check`                                                                                                                      | Entry point; confirms "bundle for DSH", not a standalone product                                                    |
| `SETUP.md`                                              | Agent-driven setup procedure                                                                                                                                  | Shows the intended install UX: an agent walks a human through it                                                    |
| `package.json`                                          | Name `dsh-superagent`, `dsh.bundle.patch: ./cordis.patch.yml`, `dsh.client.inject` list, `engines.dsh: ^0.2.1-alpha.2`                                        | **This is the plugin-manifest shape** a factory bundle must copy                                                    |
| `cordis.patch.yml`                                      | Inserts 3 plugins (`dsh-superagent`, `…/github-watch`, `…/feishu-watch` disabled) **and two agent presets**: `dsh-superagent-worker`, `dsh-superagent-router` | The clearest worked example of DSH agent-preset composition: per-role tool allow-lists and shell/job wait overrides |
| `tsdown.config.ts`, `tsconfig.json`, `vitest.config.ts` | Build/test config (multi-entry build for the two watch plugins)                                                                                               | Confirms multi-entry bundle packaging                                                                               |
| `pnpm-lock.yaml` (172 KB)                               | Lockfile                                                                                                                                                      | —                                                                                                                   |
| `LICENSE`                                               | MIT                                                                                                                                                           | Reusable with attribution                                                                                           |

### `docs/` — the design corpus (~180 KB of prose; read in order)

| File                               | Purpose                                                                                                                           |
| ---------------------------------- | --------------------------------------------------------------------------------------------------------------------------------- |
| `docs/000-philosophy.md`           | The attention principle and what it asks of an operator                                                                           |
| `docs/001-domain.md`               | Concepts + glossary (Source, Trigger, Thread, Eval, Decision, Ticket, Mandate, Assignment, Report, Input, Attention)              |
| `docs/002-authorization.md`        | The Policy gate: allowed people/conversations, inference, revalidation, hand-back                                                 |
| `docs/003-execution.md`            | Ticket stages, the Executor Session, worker slots, background work, prepare command, execution variables, merging, end conditions |
| `docs/004-prompts.md`              | Prompt composition from `prompts/`, revisions, overrides                                                                          |
| `docs/005-panel.md`                | Web panel surfaces                                                                                                                |
| `docs/006-deployment.md`           | Prerequisites, accounts, install, machine config, management API, setup checks, upgrades, troubleshooting                         |
| `docs/007-architecture.md` (70 KB) | Module-by-module implementation guide — **the most valuable single file**; includes a complete per-file responsibility table      |
| `docs/008-cookbook.md`             | Adding a new Source (the extension seam)                                                                                          |

### `prompts/` — role prompts as data (`docs/004-prompts.md`)

| File                                                                                            | Role                                                                                                                         |
| ----------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------- |
| `prompts/shared.md`, `prompts/work.md`, `prompts/cli.md`                                        | Shared rules, work rules, CLI usage rules                                                                                    |
| `prompts/orchestrator.md`, `prompts/worker.md`                                                  | Main-Session and Executor personas                                                                                           |
| `prompts/dispatch.md`, `prompts/admission.md`, `prompts/replies.md`, `prompts/subscriptions.md` | Routing, authorization assessment, reply drafting, thread subscription decisions                                             |
| `prompts/handoff*.md`                                                                           | Hand-back to a person / between roles                                                                                        |
| `prompts/team/scope.md`, `team/communication.md`, `team/delivery.md`                            | Team-level scope, communication and delivery requirements (incl. the auto-merge rules referenced by `docs/003-execution.md`) |

### `skills/` — bundled skills shipped with the bundle

| Path                                    | Purpose                                    |
| --------------------------------------- | ------------------------------------------ |
| `skills/dsh-superagent-github/SKILL.md` | How a worker uses `gh` (the agent account) |
| `skills/dsh-superagent-feishu/SKILL.md` | How a worker uses `lark-cli`               |

Loaded through `src/app/skill-files.ts` (`bundledSkills`, `promptFile`), i.e. **skills can ship inside
a plugin bundle** — a factory can version its procedural knowledge the same way.

### `scripts/`

| Path                             | Purpose                                                                            |
| -------------------------------- | ---------------------------------------------------------------------------------- |
| `scripts/dsh-superagent` (12 KB) | Operator CLI wrapper (start/stop/logs) around a dedicated `superagent` DSH profile |

### `src/` — modules (purpose text condensed from `docs/007-architecture.md`'s module table)

| Path                                                                                                                                                  | Responsibility                                                                                                                                                                                               | Factory relevance                                                |
| ----------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ---------------------------------------------------------------- |
| `src/index.ts`                                                                                                                                        | Plugin entry: read machine settings, start Runtime, expose restart for account changes                                                                                                                       | Bundle lifecycle pattern                                         |
| `src/deployment.ts`                                                                                                                                   | Plugin `Config`/`Machine`; resolves repo + accounts by probing CLIs the way worker shells run them                                                                                                           | Config-vs-settings split                                         |
| `src/setup.ts`, `src/admission.ts`, `src/limits.ts`                                                                                                   | Setup errors, the admission table shared with the panel, value limits                                                                                                                                        | Policy surface definitions                                       |
| `src/policy.ts` (19 KB)                                                                                                                               | Policy schema by block, policy version, **gate + Mandate revalidation**                                                                                                                                      | The authorization gate a factory must harden                     |
| `src/kv.ts`, `src/navigation.ts`                                                                                                                      | Typed KV record families; opening a DSH Session from the panel                                                                                                                                               | DSH session navigation                                           |
| `src/core/model.ts`                                                                                                                                   | Domain types and derived predicates (`liveTicket`, `latestReport`, `waitsForPerson`, …)                                                                                                                      | Domain vocabulary worth copying                                  |
| `src/core/ports.ts`                                                                                                                                   | Ports: `Repositories`, `Policy`, `SourceScope`, `Assessor`, `Executor`, `Outbox`                                                                                                                             | Clean seam set for a factory core                                |
| `src/core/engine.ts` (16 KB)                                                                                                                          | The Engine: the only writer of Triggers/Threads/Decisions/Tickets/Assignments; one transaction per command                                                                                                   | Transactional core pattern                                       |
| `src/core/intake.ts`, `evals.ts`, `tickets.ts`, `assignments.ts`, `replies.ts`                                                                        | The five Engine parts (one-directional dependencies)                                                                                                                                                         | Decomposition to copy                                            |
| `src/core/stage.ts`, `reasons.ts`, `errors.ts`, `ids.ts`, `memory.ts`, `index.ts`, `part.ts`                                                          | Ticket stages, reason codes, user errors, derived ids, in-memory repos for tests                                                                                                                             | Supporting primitives                                            |
| `src/app/runtime.ts` (17 KB)                                                                                                                          | Composition root: lock state dir, open Store, build parts, resume interrupted assignments, start passes/effects                                                                                              | Restart/resume pattern                                           |
| `src/app/sessions.ts` (24 KB)                                                                                                                         | **Creates and decorates DSH `Agent` sessions**: role models, prompt sections, tool allow-lists (`WORK_TOOLS`), runtime skills, preset enforcement (`WORKER_PRESET`/`ROUTER_PRESET`), `noWait` guard          | **The most instructive file for integration seam A**             |
| `src/app/delivery.ts`                                                                                                                                 | `AgentDelivery`: at-most-once message delivery to a DSH agent by request id                                                                                                                                  | Idempotent prompt delivery                                       |
| `src/app/effects.ts` (10 KB)                                                                                                                          | The durable effect queue (outbox pattern)                                                                                                                                                                    | Retry/backoff primitive                                          |
| `src/app/store.ts` (21 KB), `store-read.ts`, `migration.ts` (46 KB)                                                                                   | SQLite Store, read-only query surface, schema-11 migration                                                                                                                                                   | Persistence shape                                                |
| `src/app/settings*.ts`, `versions.ts`, `cache.ts`                                                                                                     | Settings blocks, revision history, numbered snapshots, bounded text cache                                                                                                                                    | Config versioning                                                |
| `src/app/prompts.ts` (19 KB), `context.ts`, `skill-files.ts`                                                                                          | Prompt composition, built-in parts, transcript context, packaged skill files                                                                                                                                 | Prompt-as-data                                                   |
| `src/app/assessment.ts` (21 KB)                                                                                                                       | `MasterAssessor`: bounded-context evaluation of proactive candidates                                                                                                                                         | LLM-as-gatekeeper pattern                                        |
| `src/app/role-models.ts`                                                                                                                              | Resolves **Eval vs Executor models separately** and seeds each new Session with its role's model                                                                                                             | **Per-role model routing**                                       |
| `src/app/tools/main.ts` (20 KB), `tools/executor.ts`, `tools/tool.ts`                                                                                 | Tool registration per role (14 main-Session tools, 6 executor tools)                                                                                                                                         | Tool allow-listing by role                                       |
| `src/app/http.ts` (16 KB), `api.ts`                                                                                                                   | `/orchestrator/api` routes with same-origin check and request limits                                                                                                                                         | Management API pattern                                           |
| `src/app/views/*.ts` (7 files)                                                                                                                        | Server-side view models for the panel                                                                                                                                                                        | —                                                                |
| `src/app/execution-environment.ts`                                                                                                                    | Execution variables, ticket directory root, prompt section lines                                                                                                                                             | Env contract for workers                                         |
| `src/app/notices.ts`, `outbox.ts`, `passes.ts`, `retry-health.ts`, `links.ts`, `cards.ts`, `resources.ts`, `source-context.ts`, `settings-history.ts` | Notices/relays, outbox receipts, the 2-second pass scheduler, model-budget health, links/cards, read resources, source contexts                                                                              | Scheduler + notification shapes                                  |
| `src/executor/dsh.ts` (47 KB)                                                                                                                         | **`DshExecutor`, `WorkerSlots`, `ticketExecution`, `inputMessage`, `mandateInstructions`** — one Session + directory per Ticket, launch/delivery effects, 3 retries on transient failures, resume on restart | **The closest thing to a factory worker pool that exists today** |
| `src/executor/background.ts`                                                                                                                          | A worker's background work: shell jobs (`ctx.jobs`) and subagents (`ctx.subagents`); `untilQuiet`, `killJobs`, `stopBackground`                                                                              | Background-work lifecycle                                        |
| `src/infra/commands.ts`, `environment.ts`, `paths.ts`, `text.ts`, `health.ts`                                                                         | CLI transport (`gh`, `lark-cli`, `git`), process env + command shims + git config, paths, text utils, health board                                                                                           | Credential-shim pattern (explicitly _not_ a boundary)            |
| `src/sources/kind.ts`, `registry.ts`, `host.ts`, `poll.ts`                                                                                            | Source protocol, registry, host/context, shared polling                                                                                                                                                      | Extension seam                                                   |
| `src/sources/github*.ts` (5 files)                                                                                                                    | GitHub Source: notification polling, PR/CI observation, triggers, channel, reads                                                                                                                             | GitHub intake                                                    |
| `src/sources/feishu*.ts` (6 files)                                                                                                                    | Feishu Source (optional): live events, history recovery, topics, channel, reads, images                                                                                                                      | Chat intake                                                      |
| `src/client/*.tsx                                                                                                                                     | ts                                                                                                                                                                                                           | css` (~30 files, ~350 KB)                                        | The web panel plugin (React, DSH client slots) | Client-plugin structure |
| `tests/*.spec.ts` (~60 files, ~1.1 MB)                                                                                                                | Contract/integration tests, incl. `core-engine.spec.ts` (107 KB), `runtime.spec.ts` (142 KB), `policy.spec.ts` (45 KB)                                                                                       | Test strategy reference                                          |

**What to reuse, in one line:** the _domain decomposition_ (`core/`, `ports.ts`, five-part engine),
`role-models.ts` (per-role model), `sessions.ts` (per-role tool allow-list + preset pinning),
`executor/dsh.ts` (worker slots, per-ticket session+dir, retries), and `cordis.patch.yml` (agent-preset
schema). **What not to reuse:** the SQLite schema and single-process assumption, the process-wide
`PATH`/git mutation, and the "no security boundary" account shims.

---

## DSH runtime capabilities

Evidence column: `P:` = path in `/Users/bo/code/deepseek-harness/deepseek-harness`; `C:` = command
verified on the installed `0.2.1-rc.3` binary.

| Capability                                                                                                                                                                                            | Evidence                                                                                                                                                         | How a factory would use it                                                                              |
| ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------- |
| **Everything-is-a-plugin composition (Cordis)**, profile = ordered patch layers over an empty root; bundles → profile patch → `$DSH_HOME/cordis.patch.yml` → `--patch` overlays                       | `P:apps/cli/README.md` (Profiles); `P:packages/boot/app-boot/src/profile.ts:179-195` (`PROFILE_TEMPLATES`); `P:packages/bundle/base/cordis.patch.yml` header     | Ship the factory as one bundle; keep environment config in the profile patch, not in code               |
| **Agent presets** (named plugin stacks, per-session, pinned in the session header)                                                                                                                    | `P:packages/bundle/web-app/presets/standard.patch.yml`; `P:packages/preset/agent-preset/README.md`; header field `agentPreset` in a live session log (see below) | Define `factory-worker`, `factory-reviewer`, `factory-planner` presets with different tools/models      |
| **Tool surface: fs (read/write/edit), fs-search (glob/grep), bash/pwsh + jobs, web (search/fetch), skills, todo, subagents, workflow, goal, schedule, ask-user, present, plugin manager/market, MCP** | `P:packages/bundle/web-app/presets/standard.patch.yml`; `P:docs/tool-catalog.md`; `P:packages/{fs,shell,web,skill,todo,subagent,workflow,goal,schedule,mcp}/`    | Pick a per-role subset; e.g. reviewer gets read+search+bash but `write:false`                           |
| **Subagents** (spawn / fork, in-process; also ACP, Claude-Code, Codex, dsh-sdk providers)                                                                                                             | `P:packages/subagent/README.md`; `P:docs/subsystems/subagent.md`                                                                                                 | Cheap fan-out inside one worker; inherits parent tools/permissions                                      |
| **Agent Teams** (`spawn_teammate`, `send_message`, `list_agents`, `wait_agent`, `interrupt_agent`, `team_task_*` on a shared DAG) — _experimental_                                                    | `P:packages/experimental/tool-agent-team/README.md`; `P:docs/subsystems/agent-team.md`                                                                           | The "superagent + teammates" pattern the factory prompt already uses; **no durability** (see gaps)      |
| **Workflow tool** — model-authored JS script fanning out subagents, `run_in_background` registers it as a job                                                                                         | `P:packages/workflow/tool-workflow/README.md`; `P:packages/workflow/tool-workflow/src` via `P:docs/subsystems/workflow.md`                                       | Per-unit-of-work orchestration (audit a repo, migrate N files) inside one worker session                |
| **Jobs** — background work owned by the session, completion delivered as a notice, `job_output/list/kill`                                                                                             | `P:packages/jobs/README.md`; `P:docs/subsystems/jobs.md`                                                                                                         | Long builds/tests without blocking the turn                                                             |
| **Goal** — one durable completion objective per session + optional automatic continuation rounds                                                                                                      | `P:packages/goal/README.md`; `P:docs/subsystems/goal.md`                                                                                                         | "Keep going until the objective is met" loops; complements, does not replace, a durable workflow engine |
| **Schedules** — cron/daily/weekly reminders that arrive as follow-up messages, survive restarts                                                                                                       | `P:packages/schedule/README.md`                                                                                                                                  | Periodic factory hygiene (rebase, dependency sweep) — per conversation, not a cluster-wide scheduler    |
| **Skills** — `SKILL.md` bundles discovered from project (`<repo>/.dsh/skills`), custom dir, `$DSH_HOME/skills`; also shipped inside plugins                                                           | `P:packages/skill/README.md`; `P:packages/skill/skill-filesystem/README.md` (root table, line ~50/71)                                                            | Versioned procedural knowledge per repo/team                                                            |
| **MCP** — client per configured server (stdio/HTTP), tools + instructions + resources                                                                                                                 | `P:packages/mcp/README.md`; live config shape in `~/.dsh/cordis.patch.yml`                                                                                       | Attach ticket trackers, browsers, internal APIs                                                         |
| **Web server + Typert API gateway** — loopback HTTP, browser-session token, `@Remote` unary/stream methods over `/api`                                                                                | `P:docs/api-gateway.md`; `P:docs/subsystems/web-server.md:80`                                                                                                    | Human review UI only — **not** a machine API (see gaps)                                                 |
| **Webhook runtime** — trusted rules turn verified external events into new Workspace Sessions (`workspacePath`, `title`, `prompt`, `agentPreset`, `permissionPreset`, optional `model`)               | `P:packages/experimental/webhook/README.md`; `P:packages/experimental/webhook-github/`                                                                           | The one existing "trigger → session" primitive; closest to a factory intake                             |
| **Plugin manager + custom plugin markets**                                                                                                                                                            | `P:apps/plugin-market-generator`; `P:packages/experimental/plugin-market-bundle/README.md`; `P:apps/cli` (`dsh plugin --profile <n> add`)                        | Distribute factory plugins internally                                                                   |
| **Hooks bridges (Claude Code / Codex hook JSON)**                                                                                                                                                     | `P:packages/experimental/hook-protocol/README.md`; `P:packages/experimental/hooks-{claude-code,codex}`                                                           | Reuse existing hook files; can block prompts/tools, add context, stop a run                             |
| **Token/context metering** (replay-based, deterministic, no model calls; `tokenUsage`, `contextPressure`, `contextBreakdown`)                                                                         | `P:packages/llm/token-meter/README.md`                                                                                                                           | Occupancy/compaction telemetry — **not** money                                                          |
| **Retry executor** with per-provider `retryPolicy` (normal N retries vs `always` unbounded)                                                                                                           | `P:packages/llm/llm-retry/README.md`                                                                                                                             | Provider resilience; note `always` = unbounded spend                                                    |
| **ACP automation server** (stdio)                                                                                                                                                                     | `P:packages/acp/acp/README.md`; `C: dsh --profile acp --help`                                                                                                    | The clean out-of-process worker protocol (see seam B)                                                   |
| **SDK JSON-RPC server + TS/Python clients**                                                                                                                                                           | `P:packages/sdk/README.md`; `P:apps/cli/README.md` (entry modes)                                                                                                 | Alternative to ACP when you want DSH's own protocol                                                     |

### Agent loop / turn structure (what "a step" is)

`P:docs/agent-lifecycle.md` (generated sequence diagram): `followup` → inbox splice/insert → driver wakes
→ `turn/start` → claim queued input + one prompt → `system-prompt/assemble` waterfall →
`agent/pre-step` waterfall (can reject) → `step/start` → `agent/request` waterfall →
`system/message` + `user/message` + `request/header`/`request/context` committed **to the log before
the call** → derive and freeze the request from the log → `llm/stream` → `assistant/attempt` /
`assistant/message` → classify tool calls → execute → next step. Key properties for a factory:

- Every step boundary is a **durable commit point**, and `session-checkpoint-policy` makes requests,
  top-level tool side effects and completed steps durable before the next action
  (`P:packages/session/README.md`).
- The model-visible request is a pure function of the session log (frozen; listeners cannot rewrite).
- Waterfalls (`agent/pre-step`, `agent/request`, `llm/stream`) are the plugin extension points — and
  therefore the places a factory can inject policy, redaction, or budget checks.

---

## Headless execution & the diff/exit-code contract

### Exact CLI surface (verified on the installed 0.2.1-rc.3 binary)

```
$ dsh --version
0.2.1-rc.3

$ dsh --help          # launcher
Usage: dsh [--profile] <name> [options] [app-args...]
       dsh plugin --profile <name> <pnpm-args...>
  -V, --version
  --profile <name>
  --from-default-profile <name>
  --patch <path>                     (repeatable overlay)
  --dump-config | --dump-config-schema | --dump-default-config

$ dsh --profile headless --help
Usage: dsh --profile headless [options] [task...]
  task               the task text; multiple words are joined by spaces, and `-` reads stdin
  --json             write newline-delimited run events to stdout instead of the final message
  --session-id <id>  adopt the persisted Session with this id; an unknown id is an error
  -h, --help
```

Sources: `C: dsh --help`, `C: dsh --profile headless --help`, `C: dsh --profile acp --help`;
`P:docs/cli-help.md` (§`dsh-headless`, §`dsh-acp`, generated by `scripts/gen-cli-help.ts`);
`P:apps/cli/src/args.ts:95` (`dsh headless "run the tests"` example);
`P:packages/boot/app-boot/src/profile.ts:186-188` (headless = `dsh-base` + `dsh-headless`).

**There is no `--print`, no `-p`, no `--output-format`, no `--permission-mode`, no `--sandbox`, no
`--model`, no `--max-turns`, and no `--resume` flag on headless.** `dsh <name>` ≡
`dsh --profile <name>`; `--resume` exists only for interactive profiles whose app parses it
(`apps/cli/src/args.ts` passes everything after launcher flags to the app). Model, sandbox mode and
approval policy are **composition/config**, not flags (see the two sections below).

### Exit codes and output contract

Documented in `P:packages/bundle/headless/README.md` (§Summary, §Exit mapping, §Machine-readable output):

| Channel              | Contract                                                                                                                                                                                          |
| -------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| stdout, default mode | the final assistant text, one line (empty line + exit 1 if no assistant message)                                                                                                                  |
| stdout, `--json`     | NDJSON events, opening `session`, closing `final`, plus `status`, `text`, `thinking`, `tool_call`, `tool_result`; `error` event when the runner fails outside a turn                              |
| stderr, default mode | provider reasoning deltas under `dsh: reasoning:`, then `dsh: <code>: <message>` on failure                                                                                                       |
| exit code            | `0` = a completed final `turn/end`; `1` = aborted, error, or no turn in the owned interval                                                                                                        |
| `--session-id`       | adopts a persisted Session **only** if cwd matches, the session is not a subagent/fork, its preset is composed by this profile, and no live process owns it; otherwise fails before the task runs |
| caps                 | every `--json` string (except terminal `final`) capped at 8 KiB with `truncated`; one event line ≤ 32 KiB; nesting cut at 64 levels                                                               |

Verified live (one real run, installed binary, no credentials configured):

```
$ cd /tmp/dshres/run && dsh --profile headless --json "reply with the word hello"
{"type":"session","sessionId":"session-17b7397a-…","cwd":"/private/tmp/dshres/run"}
{"type":"status","phase":"turn_start","turn":1}
{"type":"status","phase":"step_start","turn":1,"step":1}
{"type":"status","phase":"step_end","turn":1,"step":1}
{"type":"status","phase":"turn_end","turn":1,"reason":{"kind":"error","error":{"message":"llm-deepseek: no API key for provider route \"deepseek-official\"; …","code":"MISSING_CREDENTIAL"}}}
{"type":"final","text":""}
EXIT=1
stderr: … dsh: MISSING_CREDENTIAL: llm-deepseek: no API key for provider route "deepseek-official" …
```

Notes from that run that matter to the factory:

1. The observed event vocabulary includes a `status` phase sequence (`turn_start`, `step_start`,
   `step_end`, `turn_end`) — a supervisor can follow progress without parsing text.
2. **A failed turn still emits `final`** (empty) and no `error` event: _exit code + `turn_end.reason` is
   the failure signal_, exactly as the README says.
3. The one-shot run **inherited the user's home patch layer**: it started the `gmail-imap` and
   `calendar-ics` MCP servers and tried to load a third-party plugin (`bifrost-completion-guard`,
   which stayed `pending (waiting for service: credentials)` because headless disables the credential
   store). Any factory worker must therefore run under its own `DSH_HOME`.

### The diff/review contract — what DSH does **not** give you

There is **no built-in diff, patch, or artifact output**. A headless run's deliverables are:
(1) the mutated workspace on disk, (2) the exit code, (3) the final text, (4) the session log.
The tool-level diff is only a _rendering_ of an edit (`dsh-tool-fs` computes a diff for the UI; the
log records the tool call and result). A factory must therefore impose its own contract, e.g.:

- run each unit of work in a **fresh git worktree/branch**, and derive the review artifact with
  `git diff --binary <base>...<head>` after exit 0 or 1 (a failed run can still leave useful changes —
  so always capture the diff, not only on success);
- or use `dsh --profile headless --json` and reconstruct intent from `tool_call`/`tool_result` events
  (lossy: 8 KiB caps), never from the model's prose.

---

## Session/transcript storage and auditability

### On disk (verified on this machine)

```
$DSH_HOME=/Users/bo/.dsh
~/.dsh/sessions/<escaped-cwd>/<session-id>/session.v4.jsonl.zstd     # current generation
~/.dsh/sessions/<escaped-cwd>/<session-id>/session.lock              # single-writer lease
```

Concrete instance (this very session):

```
~/.dsh/sessions/--Users-bo-code-software-factory-dsh--/a4a98c67-…/session.v4.jsonl.zstd   196 KB
~/.dsh/sessions/--Users-bo-code-software-factory-dsh--/a4a98c67-…/session.lock            0 B
```

First two decoded rows (via `zstd -dc`):

```json
{"type":"session","version":4,"id":"a4a98c67-…","createdAt":1793539040582,
 "cwd":"/Users/bo/code/software-factory-dsh","parentSession":"session-9a546447-…",
 "isSeeded":false,"origin":"subagent","delegationDepth":1,"agentPreset":"standard"}
{"type":"subagent/descriptor","seq":0,"time":…,"data":{"version":3,"mode":"continuable",
 "provider":"spawn","label":"Research dsh-superagent-prototype + DSH runtime …",
 "agentProvider":"bifrost","agentModel":"ollama-cloud/deepseek-v4.1-flash:1017"}}
{"type":"sandbox/mode","seq":1,"time":…,"data":{"mode":"danger-full-access","source":"delegation"}}
```

That header is an audit goldmine: `agentPreset`, `origin`, `delegationDepth`, `parentSession`, cwd,
and per-session `agentProvider`/`agentModel` plus a durable `sandbox/mode` event.

### Format and guarantees

- Backend: `dsh-session-persistence-jsonl`, configured in `P:packages/bundle/base/cordis.patch.yml`
  as `root: dshHomePath('sessions')`; contract in `P:docs/subsystems/persistence.md`.
- Each session = its own directory under a readable (escaped) project directory; the **current
  canonical generation filename encodes the format version** (`session.v4.jsonl.zstd` here); older
  generations (`session.jsonl.zstd`, `…v1…`, `…v2…`, `…v3…`) stay byte-identical and are migrated
  forward on write (`P:packages/session/session-persistence-jsonl/README.md:57-73`).
- Encoding: concatenation of independent checksummed Zstandard frames — one header frame, then one
  frame per append batch; `compression: 'none'` writes plain newline-delimited text an external
  reader can consume (`…persistence-jsonl/README.md:111`, `:87`).
- Durability: append-only, never-rewritten events; torn physical tails are never returned; a
  single-writer `SessionHandle` with a cross-process `session.lock`; `SessionAlreadyOwnedError` on a
  second writer; checkpoint policy makes model requests / tool side effects / completed steps durable
  before the next action.
- Read side: `ctx.sessionQuery` (exact reads, filters, relationship tracing) and
  `dsh-session-query-sqlite` (derived SQLite FTS5 index, cursor pagination, live+persisted history)
  — `P:packages/session-query/README.md`, `P:docs/subsystems/session-query.md`.
- Resume: `--session-id` (headless, with the cwd/ownership/preset checks above), `session/resume`
  (ACP, `P:packages/acp/acp/README.md`), and interactive `--resume` in UI profiles.
- Export: `dsh-session-log-export` streams a session tree (session + sub-sessions + attachments) as a
  ZIP from the Web UI (`/export`), `P:packages/session-query/session-log-export/README.md`.
- Optional outbound telemetry: `dsh-session-telemetry` + `-otel`, and `dsh-session-log-deepseek`
  (uploads the incremental canonical log as DeepSeek request metadata; **disabled** in this profile —
  `P:docs/subsystems/session-telemetry.md`, and `~/.dsh/profiles/desktop/cordis.patch.yml` sets
  `session-log-deepseek: enabled: false`).

**Auditability verdict:** the log is a real audit trail (append-only, checksummed, per-event, with
approval and sandbox events as _log-only_ records that never enter the model transcript). Two caveats:
it is **per-session**, not per-factory-run (a run = N sessions; you must record the session-id tree),
and the `--json` projection is a lossy view, not the log — read the log (or `sessionQuery`) for audit.
For a factory, set `compression: 'none'` on a dedicated `DSH_HOME` so logs are plain-text and
greppable, or use `sessionQuery`/`session-log-export`.

---

## Model routing & provider configuration (concrete config file shapes)

### The three layers

1. **Base bundle default** (`P:packages/bundle/base/cordis.patch.yml:90-93`):
   ```yaml
   - id: agent-default-model
     name: '@deepseek-ai/dsh-agent-default-model'
     config: { provider: deepseek-official, model: deepseek-flash }
   ```
2. **Adapters** — one route registry; both may coexist:
   - `llm-deepseek` = `@deepseek-ai/dsh-llm-deepseek-api-key` (native DeepSeek, route
     `deepseek-official`), plus a `-account` sibling (`…/base/cordis.patch.yml:515-522`).
   - `llm-pi-ai` = `@deepseek-ai/dsh-llm-pi-ai`, mounted **dormant with zero routes** until a settings
     document or patch supplies `providers` (`…/base/cordis.patch.yml:129-136`).
3. **Per-profile / per-role selection** — patch rows, and per-session selection at the entry point
   (`P:packages/core/agent-default-model/README.md`: "per-session selection remains owned by the entry
   point"; `saveSelection({provider, model, reasoningEffort})`).

### Real, working example (this machine, `~/.dsh/profiles/desktop/cordis.patch.yml`)

```yaml
- id: llm-pi-ai
  name: '@deepseek-ai/dsh-llm-pi-ai'
  config:
    providers:
      bifrost:
        displayName: Bifrost
        apiKeyEnv: BIFROST_API_KEY # credential *reference*, never the secret
        api: anthropic-messages # wire protocol for a hand-declared gateway
        baseURL: https://hermes-control.tail4296e6.ts.net/anthropic
        models:
          - id: deepseek-v4-pro:0813
            name: deepseek-v4-pro:0813
          - id: ollama-cloud/deepseek-v4.1-flash:1017
            name: DeepSeek Flash 1017
- id: agent-default-model
  name: '@deepseek-ai/dsh-agent-default-model'
  config:
    provider: bifrost
    model: ollama-cloud/deepseek-v4.1-flash:1017
```

Documented field table (`P:packages/llm/llm-pi-ai/README.md`): `apiKeyEnv`, `displayName`,
`api` (e.g. `openai-completions`, `anthropic-messages`; catalog default when omitted), `baseURL`,
`models[]` (replaces the route catalog; each entry may set `contextWindow`, `reasoningEfforts`),
`modelOverrides[]`, `compat` (e.g. `thinkingFormat: deepseek`), `defaultContextWindow` (262,144),
`defaultMaxTokens` (32,768), image budgets, `retryPolicy {mode, maxRetries}`. Credential resolution
order for **headless**: launch environment → `<invocation cwd>/.env` → `$DSH_HOME/.env` (the managed
store is disabled; `P:packages/bundle/headless/README.md` §Credentials).

ACP sets provider/model per **server** rather than per prompt
(`P:packages/acp/acp/README.md`: config `{provider, model}`, plus per-session
`session/set_config_option` for `model` / `reasoning_effort`). The webhook runtime can name a model in
the `WebhookSessionRequest` (`P:packages/experimental/webhook/README.md`). **No CLI flag selects a
model per invocation.**

### Per-role routing is a factory capability DSH already supports

- The prototype does it: `src/app/role-models.ts` "Resolves the Eval and Executor models, and seeds a
  new Session with its role's model" (`docs/007-architecture.md`), and the session header records the
  chosen `agentProvider`/`agentModel` (verified in the live log above).
- The subagent tool can expose model choice to the model itself:
  `P:packages/bundle/web-app/presets/standard.patch.yml` → `dsh-tool-subagent` with
  `modelSelection: true, modelDiscovery: true` (and the prototype's `cordis.patch.yml` does the same
  for worker subagents).

### Budget / cost controls — effectively absent

- There is **no monetary cost accounting or spend cap** anywhere I could find: no `cost`, `USD`,
  `budget` limit, or `maxCost` field in `packages/llm/**`. `token-meter` measures _tokens/context
  pressure_ deterministically from the log (`P:packages/llm/token-meter/README.md`) and is explicitly
  "not billing-grade".
- The only "budgets" are retry budgets (`llm-retry`: normal 5 retries vs `always` = unbounded, and
  "each retry … may repeat input-token billing", `P:packages/llm/llm-retry/README.md:118`) and
  output caps (`defaultMaxTokens`, `maxOutputTokens` on title generation).
- Consequence: **a factory must meter spend outside DSH** — per-run token deltas from the session log
  (`usage` chunks / `tokenUsage` projection) multiplied by its own price table, enforced by killing or
  refusing the next run. Approval-policy `never` + unbounded retries is a real cost hazard.

---

## Isolation & permissions model

### What exists

| Layer                           | Mechanism                                                                                                                                                                                                          | Evidence                                                                                  |
| ------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------- |
| **File effects (subprocess)**   | `SandboxMode = read-only \| workspace-write \| danger-full-access`; backends: Linux bwrap→Landlock, macOS **Seatbelt**, Windows ACL restricted token; enforcement reported as `full`/`partial`                     | `P:docs/subsystems/sandbox.md`; `P:packages/sandbox/README.md`                            |
| **File effects (model writes)** | `dsh-fs-sandbox` wraps `ctx.fs`: denies mutations outside workspace/temp in `workspace-write`, denies all in `read-only`; error `FS_SANDBOX_DENIED` → model sees `[sandbox: file access denied under <mode> mode]` | `P:packages/fs/fs-sandbox/README.md`                                                      |
| **Per-call policy**             | `ctx.sandboxPolicy.resolve({session, mode?})`; workspace root = session's immutable cwd; escalation is a **new call** with a wider mode                                                                            | `P:docs/subsystems/sandbox.md` (§Per-call policy)                                         |
| **Approvals**                   | `ctx.approval` with closed outcomes `allowed-once \| rejected \| cancelled \| unavailable` (fail-closed); per-session `ask` / `never`; audit events `approval/asked` + `approval/decided` are log-only             | `P:docs/subsystems/approval.md`                                                           |
| **Escalation**                  | A denied bash/fs call may be retried once in the same turn with `sandbox_permissions` + `justification`; that retry raises the approval                                                                            | `P:packages/shell/tool-bash/README.md:70`, `:105`                                         |
| **Permission presets**          | Named bundles of (sandbox, approval): shipped `read-only+ask`, `workspace-write+ask`, `danger-full-access+never`; `custom`/`auto` reserved                                                                         | `P:docs/subsystems/permission-presets.md`                                                 |
| **Defaults**                    | `DSH_PERMISSION_MODE` env (default `workspace-write`); approval default is `ask`, but **`never` when the mode is `danger-full-access`**                                                                            | `P:packages/bundle/base/cordis.patch.yml:239-276`                                         |
| **Credentials**                 | Credential _references_ (`apiKeyEnv`) resolved per request via `ctx.credentials`; managed store `$DSH_HOME/.credentials.yaml`; env/`.env` fallbacks; headless disables the store                                   | `P:packages/llm/llm-pi-ai/README.md`; `P:packages/bundle/headless/README.md` §Credentials |
| **Session ownership**           | Single-writer handle + `session.lock`; ACP/webhook own their agents; adoption checks cwd/preset/ownership                                                                                                          | `P:docs/subsystems/persistence.md`; `P:packages/bundle/headless/README.md`                |
| **Delegation depth**            | `depthLimit` capability on subagent backends (this session runs with max depth 1)                                                                                                                                  | `P:docs/subsystems/subagent.md`; runtime context                                          |

### What does **not** exist (this is the blast-radius conversation)

- **No container, microVM, or remote executor.** The sandbox group says it plainly: _"Confinement is
  same-world only: it shares the host kernel and filesystem, while containers, microVMs, and remote
  executors replace whole capabilities instead of registering here."_ (`P:packages/sandbox/README.md`).
  Consequently `danger-full-access` = full operator privileges, and even `workspace-write` leaves the
  whole filesystem **readable** (only writes are fenced; `fs-sandbox` "preserves the local
  filesystem's read behavior") and leaves **network and process visibility out of scope**
  (`P:docs/subsystems/sandbox.md`: "Network and process visibility are outside this vocabulary").
- **No per-tool or per-host network policy**, no egress allow-list, no seccomp/syscall policy in this
  layer.
- **No multi-tenant authentication on the machine surface.** The HTTP carrier "owns no authentication
  or Origin policy"; the Web bundle adds Host/Origin checks plus a browser-session token for a
  loopback UI (`P:docs/subsystems/web-server.md:80`). ACP is explicitly "automation-only … trusted
  programs" with `authenticate` = immediate success (`P:packages/acp/acp/README.md`). Do not put either
  on a shared network.
- **Home-layer inheritance.** `$DSH_HOME/cordis.patch.yml` applies to _every_ profile (verified: the
  headless run started the user's gmail/calendar MCP servers and a third-party guard plugin). Isolation
  requires a separate `DSH_HOME` (and separate credentials), not just a separate profile.
- **The prototype adds no boundary beyond DSH's**: "Both presets run with `danger-full-access` as the
  operator's OS user … A worker can execute programs by path and read the operator's home directory.
  For isolation, use a dedicated OS account containing only the agent's credentials."
  (`docs/006-deployment.md` §Permissions and isolation), and "These wrappers and directories establish
  defaults, not a security boundary." (`docs/003-execution.md`).
- **No approval answerer in headless.** Approval default `ask` + no composed answerer ⇒ `unavailable` ⇒
  fail closed. So an unattended run either stays in `workspace-write` and _cannot_ escalate, or is
  configured `danger-full-access` (approval `never`) and has no prompts at all. ACP is the exception:
  it bridges `session/request_permission` to the client, "your client can answer automatically"
  (`P:packages/acp/acp/README.md`).

---

## Gaps vs. dark-factory requirements

| Requirement                                                                                                | DSH today                                                                                                                                                                                                                                                                                                                                                                                                                                    | Work needed                                                                                                                                        |
| ---------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Durable, replayable multi-step workflow** (survive process death mid-run, resume at last completed step) | Session log is durable per _agent session_; steps/receipts are committed before the next action; `--session-id` / ACP `session/resume` resume a conversation. No workflow-level replay: the `workflow` tool "always disposes" its run; cancellation = error, never partial success (`P:packages/workflow/tool-workflow/README.md`). Team tasks have no automatic owner release (`P:packages/experimental/agent-team/README.md` §Limitations) | Keep Restate (or equivalent) as the **outer** durable orchestration; DSH runs are activities, session-id is the idempotency key                    |
| **Exactly-once / at-most-once work admission across processes**                                            | `AgentDelivery` gives at-most-once _message_ delivery within one process (`src/app/delivery.ts`); `session.lock` gives single-writer per session; jobs and team tasks are process-local and owner-fenced (`P:packages/jobs/README.md`)                                                                                                                                                                                                       | Factory-owned queue with leases/fencing tokens; DSH must never be the source of truth for "did this unit run"                                      |
| **Hard isolation / blast radius**                                                                          | Same-world sandbox (Seatbelt/bwrap/ACL); readable host; no network policy; `danger-full-access` widely used                                                                                                                                                                                                                                                                                                                                  | Container/VM/remote-executor wrapper **outside** DSH (dedicated OS user minimum, per the prototype's own advice), or a new sandbox backend package |
| **Unattended authorization without prompts**                                                               | Headless: approval `ask` with no answerer → fail closed; `never` only via `danger-full-access`. ACP can auto-answer permission requests                                                                                                                                                                                                                                                                                                      | Choose ACP (auto-answer policy in the client) or accept `danger-full-access` inside a container                                                    |
| **Cost/spend control**                                                                                     | Token metering + retry budgets only; no money accounting, no cap, `always` retry is unbounded                                                                                                                                                                                                                                                                                                                                                | Factory-side price table + budget enforcement; disable `always` retry; set `defaultMaxTokens`                                                      |
| **Reviewable diff / gate artifact**                                                                        | None. Workspace state + exit code + final text + log                                                                                                                                                                                                                                                                                                                                                                                         | Factory-owned `git worktree` per unit + `git diff` capture + gate evaluation                                                                       |
| **Deterministic model routing per role and per run**                                                       | Per-session model selection exists (entry points), per-role routing demonstrated by the prototype, subagent model selection exists                                                                                                                                                                                                                                                                                                           | No per-invocation flag: the factory must generate the profile/`--patch` overlay (or ACP `set_config_option`) per run                               |
| **Concurrency control / scheduling**                                                                       | Prototype has `WorkerSlots` + extra slot for humans; DSH has jobs and schedules but no cross-process admission control                                                                                                                                                                                                                                                                                                                       | Factory-side scheduler (this is exactly what the current repo's Restate/OpenHands plan should own)                                                 |
| **Machine API for a control plane**                                                                        | ACP (stdio JSON-RPC, trusted) and SDK (stdio JSON-RPC) exist; the HTTP surface is a browser UI with a process token; `webhook runtime` creates sessions from verified events                                                                                                                                                                                                                                                                 | Drive DSH over stdio from the control plane (one subprocess per worker), or embed as a bundle in-process                                           |
| **Audit / provenance**                                                                                     | Strong per-session event log (checksummed, append-only, sandbox + approval events, agent/model/preset in header)                                                                                                                                                                                                                                                                                                                             | Factory-side index over session-ids, run→session mapping, retention (log is immutable and only grows)                                              |
| **Multi-repo / multi-tenant**                                                                              | Prototype: exactly one GitHub repo per install (documented); DSH: workspace per session, no tenant model                                                                                                                                                                                                                                                                                                                                     | Factory owns tenancy; one DSH profile per tenant/`DSH_HOME` per trust domain                                                                       |
| **Stable interfaces**                                                                                      | DSH is "developer preview … THERE WILL BE COMPATIBILITY-BREAKING CHANGES" (`README.md`); teams/plugin-market pieces are `experimental` with no stability promise                                                                                                                                                                                                                                                                             | Pin an exact DSH version; keep the factory's DSH coupling behind one adapter module                                                                |

---

## Recommended integration seams

### Option A — In-process bundle (what the prototype does)

The factory ships as a DSH bundle (`dsh.bundle.patch`), mounted into a dedicated profile, and drives
agents through `ctx.agents`, `ctx.sessions`, `ctx.subagents`, `ctx.jobs`, agent presets and per-role
model seeding. Evidence: `src/app/sessions.ts`, `src/executor/dsh.ts`, `cordis.patch.yml`,
`packages/{bundle/headless,apps/cli}/README.md` (bundle manifest shape).

- **Pros:** richest control (tool allow-lists, prompt sections, skills, presets, model per role);
  zero IPC; direct access to `session/event` for live telemetry; the prototype is a working reference.
- **Cons:** couples the factory to DSH's internal service APIs and to the app's build; one process =
  one failure domain; process-wide side effects happen (the prototype mutates `PATH` and git config
  globally); upgrades break you; no isolation between tenants.
- **Use when:** the factory _is_ a DSH product (single-tenant, one repo/team), or for the human-facing
  control panel inside DSH.

### Option B — Headless subprocess per unit of work (recommended default)

Control plane spawns `dsh --profile factory-worker --session-id <id> --json "<task>"` in a fresh
worktree, with `DSH_HOME` per trust domain and `DSH_PERMISSION_MODE` set explicitly; parses NDJSON for
progress; treats exit code + `turn_end.reason` as the outcome; captures `git diff` itself.

- **Pros:** process boundary = crash isolation and clean env; per-run `--patch` overlays allow
  per-run model/tool/preset configuration without touching global state; NDJSON gives supervisor
  progress; `--session-id` gives resumable conversations; trivially maps to a container.
- **Cons:** one process per run (startup cost); **no per-invocation model/permission flags** (must
  generate patch overlays); 8 KiB event caps; no escalation possible in `ask` mode; final answer only
  on stdout, everything else on stderr (reasoning leaks to logs — the README warns about this);
  "one task per run", no interactive follow-up.
- **Use when:** the factory needs many independent, short-lived, resumable-but-disposable workers.

### Option C — ACP (or SDK) server as the worker protocol

Run `dsh --profile acp` (stdio JSON-RPC) as a long-lived worker server; the factory is an ACP client:
`session/new`, `session/prompt`, `session/update` (committed messages + tool lifecycle + context
usage), `session/request_permission` (auto-answer), `session/set_config_option` (model /
reasoning_effort), `session/cancel`, `session/resume`, `session/close`.

- **Pros:** the only seam that gives **model selection per session** _and_ **programmatic permission
  decisions** _and_ **resume/list** in one protocol; multi-session per connection; no DSH internals;
  protocol is standard ACP v1, so tooling and other harnesses exist; SDK JSON-RPC is the same shape if
  you want DSH-specific events.
- **Cons:** "automation-only … trusted clients", `authenticate` always succeeds (never expose the
  socket); no plans/terminals/elicitation/presentation; server-side config still supplies the provider
  routes; you own process lifetime and supervision.
- **Use when:** you want a long-lived worker pool with a real control plane (this is the best fit for a
  Restate-driven factory: Restate owns durability, ACP owns the agent conversation).

**Suggested combination:** C for the worker protocol, A only for the in-DSH operator panel/tools, and
never rely on DSH for durability, budgets, diffs, or tenancy. Whatever is chosen, put every DSH call
behind one adapter module (`factory/dsh_adapter.py`) so a DSH upgrade touches one file.

---

## Open questions / unverified assumptions

1. **Model spend and latency of a real headless run** — UNVERIFIED. The machine has no
   `DEEPSEEK_API_KEY`/`BIFROST_API_KEY` in the environment, no `.env`, and headless disables the stored
   credentials, so the run above failed at `MISSING_CREDENTIAL` before any model call. To verify the
   full 0→answer path, configure `DEEPSEEK_API_KEY` (or a `llm-pi-ai` provider row with `apiKeyEnv`)
   in a scratch `DSH_HOME` and re-run the one-shot command.
2. **Whether the installed `0.2.1-rc.3` and the checkout `0.2.1-alpha.4` differ in the headless/ACP
   contract** — UNVERIFIED beyond `--help` equality and the one run. The `--help` text and the observed
   NDJSON vocabulary match the checkout's docs; treat a mismatch as a real risk. Also note the
   prototype pins `^0.2.1-alpha.2`, which will not satisfy `0.2.1-rc.3` without the plugin manager's
   version-exemption machinery (`apps/cli/README.md` §Profiles).
3. **Does any composition ship a headless approval answerer?** — I found none; the base patch sets
   `ask`, and I could not find an answerer mounted by `dsh-headless`. Assumption: unattended `ask`
   always resolves `unavailable` (fail closed). Verify by composing an answerer and observing an
   escalation succeed.
4. **Cost/budget absence** — asserted from a search over `packages/llm/**` and docs; a
   third-party/experimental package I did not open could exist. Marked "not found", not "does not exist".
5. **Cross-process concurrency limits** — I did not find admission control/queueing in DSH core (jobs
   and team tasks are process-local). The prototype's `WorkerSlots` is the only scheduler I saw. Assumed
   absent at the runtime level.
6. **Windows/Linux parity** for Seatbelt-vs-bwrap-vs-ACL behaviour — read from docs only, not exercised.
   On this macOS host the backend is Seatbelt (`packages/sandbox/README.md`).
7. **The prototype's actual runtime behaviour under DSH `0.2.1-rc.3`** — UNVERIFIED: it was never
   built or installed here (`pnpm check` requires `@deepseek-ai/dsh-agent@0.2.1-alpha.2` workspace
   peers). All prototype claims above come from its source, docs, and manifest, not from execution.
8. **Whether `danger-full-access` in this session's `sandbox/mode` event reflects a delegation-time
   grant** — the event recorded `{"mode":"danger-full-access","source":"delegation"}`; I did not read
   `sandbox-policy`'s source to enumerate `source` values.
9. **Retention/GC** — session logs are immutable and nothing in the prototype deletes old records
   (`docs/007-architecture.md`: "Nothing deletes old records yet"). Assumed the same for DSH session
   logs; a factory needs its own retention policy.

---

### Appendix — one-line file map for the two artifacts

| Need                     | Prototype repo file                                      | DSH file                                                                          |
| ------------------------ | -------------------------------------------------------- | --------------------------------------------------------------------------------- |
| Bundle manifest          | `package.json` (`dsh.bundle.patch`)                      | `packages/bundle/*/package.json`, `cordis.patch.yml`                              |
| Role tool allow-list     | `cordis.patch.yml`, `src/app/sessions.ts` (`WORK_TOOLS`) | `packages/bundle/web-app/presets/standard.patch.yml`                              |
| Per-role model           | `src/app/role-models.ts`                                 | `packages/core/agent-default-model/README.md`, `packages/llm/llm-pi-ai/README.md` |
| Worker session lifecycle | `src/executor/dsh.ts` (`WorkerSlots`, `DshExecutor`)     | `packages/bundle/headless/src/index.ts`, `packages/acp/acp/`                      |
| Durability               | `src/app/store.ts`, `src/app/effects.ts`                 | `packages/session/session-persistence-jsonl/`, `docs/subsystems/persistence.md`   |
| Authorization gate       | `src/policy.ts`, `docs/002-authorization.md`             | `packages/interaction/user-approval/`, `docs/subsystems/approval.md`              |
| Sandbox                  | `docs/006-deployment.md` §Permissions                    | `packages/sandbox/`, `packages/fs/fs-sandbox/`, `docs/subsystems/sandbox.md`      |
| Automation entry point   | `scripts/dsh-superagent`                                 | `dsh --profile headless`, `dsh --profile acp`, `docs/cli-help.md`                 |
