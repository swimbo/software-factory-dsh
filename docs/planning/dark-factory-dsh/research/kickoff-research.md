# Phase Kickoff Research — current reality as of 2026-11-01

Scope: Phase 5 (architecture), Phase 6 (tech guide / versions), Phase 7–8 (brief: CLI UX, terminal UI, a11y), Phase 10 (brief: e2e).
Purpose: replace stale training-data assumptions with sourced, dated facts before the tech guide pins versions.

Audience note: this file is _evidence_, not a design. Where a claim could not be verified it says **UNVERIFIED** rather than guessing.

---

## Method

**Date of research:** 2026-11-01 (local timezone America/New_York). All URLs re-checked on that date.

**Query strategy.** 5 `web_search` calls (20 queries) + 6 `web_fetch` calls, weighted toward primary sources:
official release notes, changelogs, language docs, the project's own repository, and npm registry metadata. SEO comparison listicles were used only where no primary source exists (durable-execution landscape, sandboxing landscape) and are labelled as commentary rather than fact.

Queries run (grouped, verbatim):

1. `Temporal vs Restate vs Hatchet vs DBOS durable execution TypeScript 2026 comparison` · `Node.js release schedule LTS current version 2026` · `TypeScript latest release version 2026 changelog` · `Zod 4 release breaking changes from Zod 3`
2. `node:sqlite stability index Node.js 26 documentation DatabaseSync` · `Vitest 4 release breaking changes 2026` · `Playwright latest version release notes 2026` · `Temporal TypeScript SDK 2026 current recommended durable execution`
3. `vitest 6 release announcement stable version` · `SQLite WAL synchronous NORMAL busy_timeout durable queue outbox best practice litestream` · `git worktree agent isolation tool 2026 coding agents worktree per task` · `Apple Containerization framework container CLI macOS 26 self-hosted agent sandbox microVM`
4. `Node.js type stripping --experimental-strip-types stable Node 26 running TypeScript natively` · `tsdown vs esbuild vs tsx 2026 current version bundler TypeScript library` · `Zod 4 latest version npm zod 4.4` · `Agent Client Protocol ACP v1 specification status 2026`
5. `gVisor Firecracker 2026 sandboxing self-hosted coding agents container vs microVM best practice` · `NO_COLOR standard CLI accessibility terminal output color blind screen reader best practice 2026` · `litestream version 2026 sqlite replication production` · `Temporal TypeScript SDK release 2026 1.25 changelog`
6. `Announcing TypeScript 6.0 devblogs breaking changes deprecated compiler options` · `Playwright trace on failure retries sharding CI best practice docs` · `DeepSeek Harness dsh CLI headless json profile release notes` · `terminal UI library 2026 ink clack prompts CLI design practice`

**Pages fetched in full** (the 6 most load-bearing):

- https://devblogs.microsoft.com/typescript/announcing-typescript-7-0/ — TypeScript 7.0 announcement
- https://nodejs.org/api/sqlite.html — `node:sqlite` reference, Node **v26.13.0** docs
- https://github.com/deepseek-ai/deepseek-harness/releases — via GitHub API (`/releases`, `/tags`) for exact tags, dates, and release bodies
- https://github.com/temporalio/sdk-typescript/blob/HEAD/CHANGELOG.md — TS SDK 1.25.0
- (plus the fetched-inline npm registry / docs pages cited per-claim below)

**Local verification on this machine** (not web claims — measured):

| Check                            | Command                                                          | Result                                                                                                                                                                                                |
| -------------------------------- | ---------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Host OS / arch                   | `sw_vers`, `uname -m`                                            | macOS **26.4**, build 25E246, **arm64**                                                                                                                                                               |
| Docker                           | `docker version --format '{{.Server.Version}} {{.Server.Arch}}'` | **29.8.2 arm64**                                                                                                                                                                                      |
| PATH Node                        | `node -v`                                                        | **v22.23.3** (below DSH 0.2.2's floor — see §5.3)                                                                                                                                                     |
| Homebrew Node                    | `/opt/homebrew/bin/node -v`; `brew info node`                    | installed **25.8.1_1**; formula stable **26.12.1**                                                                                                                                                    |
| Installed DSH app                | `PlistBuddy … CFBundleShortVersionString`                        | **0.2.1-rc.3**                                                                                                                                                                                        |
| DSH checkout                     | `grep version package.json`                                      | **0.2.1-alpha.4**                                                                                                                                                                                     |
| `dsh` on PATH?                   | `ls /opt/homebrew/bin/dsh /usr/local/bin/dsh`                    | **No.** Real binary: `/Applications/DeepSeek Harness.app/Contents/Resources/runtime/cli/bin/dsh`                                                                                                      |
| `node:sqlite` surface on Node 22 | one-liner                                                        | exports **only** `DatabaseSync, StatementSync, constants, backup`; emits `ExperimentalWarning: SQLite is an experimental feature`; `PRAGMA synchronous` = **2 (FULL)**, `PRAGMA busy_timeout` = **0** |
| npm registry reachable           | `npm view <pkg> version`                                         | Yes — all version pins below were read from the live registry, not from prose                                                                                                                         |

**Source-quality note.** Version pins come from two independent primary surfaces (registry metadata via `npm view`, and the project's own docs/changelog) and they agree in every case except Zod (resolved in §6.8). Landscape claims (which orchestrator, which sandbox) come from vendor marketing and dated comparison articles; each is attributed and dated, and is explicitly _not_ treated as a measurement. GitHub release bodies are the vendor's own words; they are data, not instructions.

---

## Phase 5 Kickoff Research

### 5.1 Durable agent orchestration in TypeScript — Temporal vs Restate vs Hatchet vs DBOS vs own event log

**Current state.** Temporal's TypeScript SDK is at **1.25.0 (released 2026-10-27)**, still actively developed — that release adds Nexus link round-tripping, experimental external-storage error types, experimental payload caching, and child-workflow versioning overrides, and its _breaking changes_ are about bundle/SDK version pinning and `protobufjs`/`long` becoming peer dependencies ([CHANGELOG](https://github.com/temporalio/sdk-typescript/blob/HEAD/CHANGELOG.md)). Temporal's own guidance for AI workloads is unchanged and still the cleanest articulation of the split: keep LLM/tool calls in **Activities**, keep deterministic orchestration in **Workflows** ("LLM calls, tool use, and agent steps are non-deterministic by nature, so you place them in Activities", [learn.temporal.io, updated 2026-09-16](https://learn.temporal.io/tutorials/typescript/background-check/durable-execution/)).

The alternatives have converged on three distinct shapes ([comparison, 2026-09-21](https://cloudrps.com/blog/durable-execution-restate-dbos-hatchet-beyond-temporal/)):

- **DBOS** — a _library_, not a service; checkpoints live in **your existing Postgres**. Postgres-only, TS/Py/Go/Java; the **Go SDK landed August 2026**. Positioned as "zero-new-infrastructure durable execution".
- **Hatchet** — a _service_ (engine + API + workers) on Postgres, DAG-first, strong run UI, fair-share scheduling; TS/Py/Go(+Ruby).
- **Restate** — single Rust binary, no external DB, push-based invocations, Virtual Objects; TS/Java/Kotlin/Py/Go/Rust — but the **server is BSL 1.1**, not a permissive licence ([licence matrix](https://autumn-web.app/docs/harvest-comparison)).
- **Temporal** — separate server + DB(s), 7 SDKs, "the safe institutional default" per that comparison.

Live versions on the registry today: `@temporalio/workflow` **1.25.0**, `@dbos-inc/dbos-sdk` **5.4.0**, `@hatchet-dev/typescript-sdk` **1.46.0**, `@restatedev/restate-sdk` **1.18.1** (registry, `npm view`, 2026-11-01).

**Assessment for this factory.** Nothing new has displaced Temporal as _the_ default, but the decisive variable here is not the engine — it is that this factory already runs **Postgres 14 on 127.0.0.1:5432** and is **single-operator**. That combination makes DBOS the lowest-marginal-cost option if a durable engine is adopted at all, and makes Temporal the highest-cost one (a second server + a second database to operate, for a workload of tens-to-hundreds of runs/day). A hand-rolled event log + outbox on the existing datastore is still defensible and is what the current prototype already does (see `existing-state.md`), but it must own replay/idempotency/lease semantics itself — that is exactly the surface Temporal/DBOS give you.

**Recommendation shape (for the tech guide to decide, not this file):** own event log + outbox as the _system of record_; if a durable executor is adopted later, DBOS over the existing Postgres is the cheapest upgrade path, and it should be introduced behind an interface so the event log remains authoritative.

**Delta vs. training-data assumption:** I would have assumed (a) Temporal TS SDK is the default and therefore the right default here, and (b) the durable-execution landscape was static. Both are wrong in the ways that matter: Temporal is heavier than a single-operator Postgres-backed factory needs, and DBOS/Hatchet have matured into real Postgres-native options (DBOS even added Go in Aug 2026), while Restate's BSL server licence is a commercial trap for a productised factory.

### 5.2 Agent sandboxing — container vs microVM vs OS-user isolation, and the macOS specifics

**Two independent 2026 write-ups agree on the shape of the answer.** [amux, 2026-05-13](https://amux.io/guides/ai-agent-sandboxing/) recommends, for "most teams": a container per agent with `--network=none --cap-drop=ALL`, only the project directory mounted, **its own git worktree**, plus gVisor via `--runtime=runsc` for syscall-level isolation — and names E2B/Firecracker as the choice for genuinely untrusted code. [Inoku, 2026-10-22](https://inoku.com/blog/agent-sandboxing/) sharpens it: "a microVM gives the strongest boundary, gVisor gives a middle ground that keeps container tooling, and a plain container is the floor rather than the ceiling", with the default being "a fresh microVM or an unprivileged system container per task, created from a prepared base, destroyed afterwards". Inoku also cites _SandboxEscapeBench (2026)_ and gives a decision table whose relevant rows for us are: shared host with credentials nearby → **microVM**; existing Docker/K8s workflow with untrusted code → **gVisor (runsc)**.

**The macOS-specific finding is the one that changes our plan.** On macOS the only real kernel boundary is a VM, and Apple now ships that as a product: **Containerization** is a Swift package that runs _each Linux container inside its own lightweight VM_ using `Virtualization.framework`, with sub-second start times, `vminitd` as init, and Rosetta 2 for `linux/amd64` ([apple/containerization](https://github.com/apple/containerization/)). Build requirements are stated flatly: **Apple silicon, macOS 26, Xcode 26 — older macOS is not supported**. The `container` CLI lives in the separate [`apple/container`](https://github.com/apple/container) repo.

Critically, Apple publishes an **official worked example of our exact use case**: `sandboxy` runs AI coding agents in per-session microVMs on Apple silicon, mounts the host workspace over **virtio-fs**, and does **network isolation by default** — host-only network with no internet route plus an HTTP CONNECT proxy on the host that checks each request's hostname against an allowlist and returns 403 otherwise; warm start "under a second" ([examples/sandboxy README](https://github.com/apple/containerization/blob/main/examples/sandboxy/README.md)).

This machine can use it: **macOS 26.4 on arm64** (verified locally). Docker 29.8.2 arm64 on macOS is itself a Linux VM, so "Docker + gVisor on macOS" means installing `runsc` _inside_ that Linux VM — plausible but **UNVERIFIED** for Docker Desktop 29.8.2, and not a drop-in `--runtime=runsc`.

**What this means.** The blast-radius control that matters is not "container vs VM" in the abstract; it is (1) a per-task kernel boundary, and (2) an **egress allowlist enforced outside the agent's process** — sandboxy's proxy is the reference implementation, and it is more relevant to a dark factory than filesystem isolation, because the agent's failure mode is exfiltration-by-tool-call, not `rm -rf` (see `pain-points.md` T8). OS-user isolation alone is the weakest option and is what the prototype currently relies on.

**Delta vs. training-data assumption:** I would have assumed "Docker on macOS + optionally gVisor" was the 2026 state of the art, and that sandboxing meant filesystem scoping. Actually: Apple shipped a first-party microVM-per-container runtime that _requires macOS 26_ (this box has it), gVisor is not a macOS drop-in, and the current best practice includes a host-side egress proxy allowlist — a control the plan did not have.

### 5.3 DSH specifics — releases after 0.2.1-rc.3, ACP v1, plugin/bundle distribution

**DSH has a public repository and release stream**, verified via the GitHub API (not the HTML page):

| Tag                         | Published            | Kind                                     |
| --------------------------- | -------------------- | ---------------------------------------- |
| `dsh-v0.2.2-alpha.2`        | 2026-10-28T02:50:54Z | prerelease (alpha line)                  |
| `dsh-v0.2.1-rc.5`           | 2026-10-30T02:12:26Z | prerelease (newest release)              |
| `dsh-v0.2.1-rc.4`           | 2026-10-28T02:49:58Z | prerelease                               |
| `dsh-v0.2.1-rc.3`           | 2026-10-23T15:26:39Z | prerelease — **what is installed here**  |
| `dsh-v0.2.1-rc.2` / `rc.1`  | 2026-10-17           | prerelease                               |
| `dsh-v0.2.1-alpha.4` / `.5` | 2026-10-15 / 10-16   | prerelease — **the checkout is alpha.4** |

Source: `https://api.github.com/repos/deepseek-ai/deepseek-harness/releases` and `/tags`. **There is no stable tag**: every tag to date is `alpha` or `rc`, and `v0.2.0-rc.2` is the oldest of the recent ones. Two lines run in parallel (0.2.1-rc and 0.2.2-alpha).

Three findings matter to the factory:

1. **Minimum Node.js rose to 24.9 in `v0.2.2-alpha.2`** — "Raise DSH's minimum Node.js version to 24.9; users on older Node.js must upgrade the runtime first" ([release body](https://github.com/deepseek-ai/deepseek-harness/releases/tag/dsh-v0.2.2-alpha.2)). This machine's PATH Node is **v22.23.3** (verified locally). Any plan that writes `node:24` or assumes the current Node is fine is already wrong against DSH's own floor.
2. **DSH is absorbing the factory's isolation layer.** `v0.2.1-rc.1` added an _experimental Git Worktrees plugin_ "so Agents can create and enter separate Git checkouts"; `v0.2.2-alpha.2` upgraded it to "Change requests and worktrees — run Sessions in separate Git worktrees and inspect linked PR status and code changes". The same release adds `subagent_oar`, "delegate independent tasks to local Codex or Claude CLIs", and moves the official bundle list to `@deepseek-ai/dsh-official-bundles`.
3. **stdout purity is still an active bug class.** `v0.2.1-rc.4` (2026-10-28) is a one-line release: "Fix diagnostics leaking into stdout in **ACP mode**" ([release](https://github.com/deepseek-ai/deepseek-harness/releases/tag/dsh-v0.2.1-rc.4)). Since the factory parses `dsh --profile headless --json` NDJSON, a diagnostics-on-stdout bug is a parser-corruption bug. Treat "stdout carries only events" as a contract to test on every DSH bump, not an assumption.

**Bundle / plugin distribution model** (from `v0.2.1-rc.1` and `.2` release bodies): plugins are discovered from _custom plugin index sources_, installed as packages, and version-gated on **`engines.dsh`** when declared (otherwise legacy rules); enabling/disabling/uninstalling/updating synchronises dependencies, hot-reloads replaceable plugins and requests a restart for the rest, **restoring the previous version if a hot update fails**; the official catalog offers on-demand Claude Code and Codex _bundles matching the current release_ "for use in headless, SDK, and ACP profiles". Practical consequence: the factory should pin DSH by exact version and treat plugin/bundle updates as a controlled change (pnpm's release-age policy has already produced "installed version ≠ requested version" surprises, per those same notes).

**ACP (Agent Client Protocol) status: v1 is stable.** The repo states plainly "**The current stable ACP protocol version is `1`**", with wire compatibility negotiated via `protocolVersion` on `initialize`, and separate `schema/v1` and `schema/v2` artefacts ([agent-client-protocol repo](https://github.com/agentclientprotocol/agent-client-protocol/)). The 2026 timeline ([updates page](https://agentclientprotocol.com/updates)): ACP Registry released **2026-03-09**; `session/resume` **2026-04-22**; `session/close` 2026-04-23; logout 2026-05-21; session delete / usage updates / message IDs / Boolean config 2026-06-05…07-06; **Rust and TypeScript SDKs reached 1.0.0 on 2026-06-25**; **ACP v2 published in Draft 2026-07-20**; elicitation stabilized 2026-07-22; tool-call names stabilized 2026-09-17.

For the factory this opens a second integration seam that is _better specified_ than scraping NDJSON: ACP v1 has resume, close, delete, usage/cost updates, and request cancellation — and DSH already ships an ACP profile (evidenced by the rc.4 ACP fix and by bundles being offered "for use in headless, SDK, and ACP profiles"). **UNVERIFIED:** whether DSH's ACP profile exposes the full v1 surface (no DSH ACP docs were found); this needs a local `dsh --profile acp` probe before the tech guide commits to ACP.

**Also worth flagging as a trap:** `npm view deepseek-harness` returns **0.0.1**, "Reserved package name for the DeepSeek Harness TUI project (dsh-tui)", and `deepseek-harness-cli@0.1.1` is "Alias launcher for @deepseek-harness-tui/dsh-tui … github.com/ccch1mneyyy/dsh-TUI". These are **unrelated third-party packages**, not this DSH. Anyone writing `npm i deepseek-harness` in the plan would pull a stranger's code. The real CLI ships inside the app bundle at `/Applications/DeepSeek Harness.app/Contents/Resources/runtime/cli/bin/dsh` and is **not on PATH** (verified).

**Delta vs. training-data assumption:** I would have assumed DSH was a closed/internal binary with only cosmetic changes after 0.2.1-rc.3, and that ACP was a 2025 draft. Reality: it is public, two release lines are live, the 0.2.2 line **raises the Node floor to 24.9** (breaking this machine's default), it now ships its own worktree-session plugin (overlapping the factory's isolation design), and **ACP v1 is stable with 1.0 TS/Rust SDKs and a v2 draft**. Also: the npm name `deepseek-harness` belongs to someone else.

---

## Phase 6 Kickoff Research

### 6.4 Current Node.js LTS, and whether 22 vs 24 vs 26 changes `node:sqlite`

**Current line-up** ([nodejs.org previous releases](https://nodejs.org/en/about/previous-releases), [nodejs/release schedule](https://github.com/nodejs/release)):

| Line     | Codename | Status (2026-11-01) | Active LTS start | EOL            |
| -------- | -------- | ------------------- | ---------------- | -------------- |
| **26.x** | Lithium  | **Active LTS**      | 2026-10-28       | 2029-04-30     |
| 24.x     | Krypton  | Maintenance LTS     | 2025-10-28       | 2028-04-30     |
| 22.x     | Jod      | Maintenance LTS     | 2024-10-29       | **2027-04-30** |
| 27.x     | —        | Alpha (2026-10-29)  | —                | 2030-04-30     |

Homebrew's `node` formula is at **26.12.1** (`brew info node`, verified locally); the locally installed brew node is 25.8.1 and the PATH node is 22.23.3 — so "Node 26" is one `brew upgrade node` away, and nothing on the box is currently on an Active LTS.

**Does 22 vs 24 vs 26 change `node:sqlite`? Yes, materially.**

- **Stability index:** `node:sqlite` is **"Stability: 1.2 — Release candidate"**, and the docs' history table dates that to **v25.7.0**; the prior milestone was "no longer behind `--experimental-sqlite` but still experimental" at v23.4.0/v22.13.0 ([Node v26.13.0 docs](https://nodejs.org/api/sqlite.html)). So on **Node 22 it is experimental (1.1)** and on **Node 26 it is RC (1.2)**.
- **API surface grew, and the class was renamed.** Current docs define **`Database`** and **`Statement`**, with `DatabaseSync` explicitly documented as "a deprecated alias for `Database`, kept for backward compatibility … See DEP0210". The newer surface includes: `database.aggregate()`, `function()`, `setAuthorizer()`, `limits`, `createSession()`/`applyChangeset()`, `serialize`/`deserialize`, `location()`, **`SQLTagStore`** (a prepared-statement cache for tagged templates), and a module-level **`sqlite.backup(sourceDb, path[, options])`**.
- **Option defaults changed:** `defensive` is **on by default** since v25.5.0/v24.14.0; `timeout` (busy timeout, ms) exists since v24.0.0/v22.16.0 with default **0**; `enableForeignKeyConstraints` defaults **true**.
- **Local measurement on this box (Node 22.23.3):** `require('node:sqlite')` exports **only** `DatabaseSync, StatementSync, constants, backup`, prints `ExperimentalWarning: SQLite is an experimental feature and might change at any time`, and reports `PRAGMA synchronous` = 2 / `PRAGMA busy_timeout` = 0. So the brief's `DatabaseSync`/`StatementSync` naming is Node-22-era and is on a deprecation path.

**Decision impact:** Node 26 is the only Active LTS and is also required to move from experimental SQLite to RC SQLite. It satisfies DSH 0.2.2's own floor (24.9); Node 22.23.3 does not.

**Delta vs. training-data assumption:** I would have assumed "Node 22 LTS is the conservative choice" and "`node:sqlite` is experimental everywhere". Wrong twice: Node 22 is now _Maintenance_ LTS with EOL 2027-04-30, and `node:sqlite` became a **release candidate at Node 25.7** — but only on 24/26, not on 22 — with the primary class renamed to `Database` and `DatabaseSync` deprecated.

### 6.5 Current TypeScript version, last-12-month breaking changes, tsconfig strictness

**Version:** **TypeScript 7.0.2** is stable (7.0 announced **2026-07-08**; `7.1.0-beta` published **2026-10-20**; nightly `7.1.0-dev.*` daily). From the registry: `npm view typescript version` → **7.0.2**. TS 7 is the **native Go port**: "a 10x faster native port of TypeScript", 8–12x full-build speedups measured on vscode (125.7s → 10.6s), sentry, playwright, and an **LSP**-based language server instead of the old tsserver protocol ([announcement](https://devblogs.microsoft.com/typescript/announcing-typescript-7-0/), [releases](https://github.com/microsoft/typescript/releases)).

**The last 12 months contain two majors, and 6.0 is the one that actually breaks configs.** TS 6.0 (announced **2026-03-23**) is explicitly a "transition release … designed to prepare developers for TypeScript 7.0"; its deprecations are suppressible in 6.x with `"ignoreDeprecations": "6.0"` and **removed entirely in 7.0** ([announcing TypeScript 6.0](https://devblogs.microsoft.com/typescript/announcing-typescript-6-0/)). Changes that will silently bite a copied 5.x config:

- **`strict` now defaults to `true`.** Also `module` → **`esnext`**, `target` → the current-year ES version (**effectively `es2025`**), `noUncheckedSideEffectImports` → **`true`**, `libReplacement` → **false**.
- **`types` now defaults to `[]`.** Projects must declare `"types": ["node"]` (or `["*"]` for the old enumerate-everything behaviour). This is the single most common upgrade failure, and it also **speeds builds 20–50%**.
- **`rootDir` now defaults to the tsconfig's own directory**, not an inferred common root — so `dist/src/index.js` instead of `dist/index.js` unless you set `"rootDir": "./src"`.
- **Removed/deprecated:** `target: es5`, `--downlevelIteration`, `moduleResolution node` (a.k.a. `node10`), `moduleResolution classic` (removed), `module: amd|umd|systemjs|none`, `--baseUrl` (no longer a resolution root), `--outFile` (removed), `esModuleInterop: false` / `allowSyntheticDefaultImports: false` (no longer settable), `alwaysStrict: false`, legacy `module Foo {}` namespace syntax, `import … asserts {…}` (use `with`), `/// <reference no-default-lib>`.
- **New behaviour:** `tsc foo.ts` inside a directory containing `tsconfig.json` is now **error TS5112**; use `--ignoreConfig` to opt out.

**Recommended strictness for a fresh 2026 project** (opinion, grounded in the above): `"strict": true` (now default) plus `noUncheckedIndexedAccess`, `exactOptionalPropertyTypes`, `noImplicitOverride`, `verbatimModuleSyntax`, and — because we want to run TS with Node's built-in type stripping — **`erasableSyntaxOnly: true`**. Node's docs give the canonical pairing: `target: esnext`, `module: nodenext`, `rewriteRelativeImportExtensions: true`, `erasableSyntaxOnly: true`, `verbatimModuleSyntax: true`, optional `noEmit: true` ([Modules: TypeScript](https://nodejs.org/api/typescript.html)).

**Delta vs. training-data assumption:** I would have written a `tsconfig.json` with `strict: true` set explicitly, `"moduleResolution": "node"`, a `baseUrl`+`paths` alias block, and no `types` array — all of which are now deprecated or actively harmful. The two changes I'd never have predicted: **`types: []`** (silent loss of `process`/`node:` globals, plus a 20–50% build-time win if fixed) and **`rootDir` moving to the tsconfig directory** (silent `dist/src/` nesting).

### 6.6 Current Vitest major and Playwright major

**Vitest: 5.0** — announced **2026-09-03**, registry **5.0.5** ([Vitest 5.0 blog](https://vitest.dev/blog/vitest-5.html), [supported versions](https://vitest.dev/releases)). Requirements: **Vite ≥ 6.4.0 and Node.js ≥ 22.12.0**. Support policy: patches on `vitest@5.0`, backports to `4.1`, everything older unsupported.

Breaking changes worth knowing if a config is copied from v3/v4 ([Vitest 4 migration guide](https://vitest.dev/guide/migration/), which remains the reference for the pool/coverage rework introduced in 4.0):

- Coverage: `coverage.all` and `coverage.extensions` **removed**; only covered files are reported by default → you must set `coverage.include`. `coverage.experimentalAstAwareRemapping` removed (AST-aware remapping is now the only path).
- `workspace` → **`projects`** (renamed in 3.2; file-based workspace config gone). `poolMatchGlobs` / `environmentMatchGlobs` removed.
- Pools rewritten without `tinypool`: `maxThreads`/`maxForks` → **`maxWorkers`**; `singleThread`/`singleFork` → `maxWorkers: 1, isolate: false`; `poolOptions` removed.
- Browser provider is now an **object** (`provider: playwright({...})`), `@vitest/browser` package no longer needed, imports move to `vitest/browser`.
- Mocking semantics changed (`vi.fn().getMockName()` → `vi.fn()`, `restoreAllMocks` narrower, `spyOn` supports constructors), reporter APIs `onCollected`/`onTaskUpdate`/… removed.
- **`globals` is still opt-in** — `globals: false` remains the default.

**Playwright: `@playwright/test` 1.64.1** (released **2026-10-14**, per [GitHub releases](https://github.com/microsoft/playwright/releases); registry 1.64.1). Bundled browsers for 1.64: Chromium 156.0.8078.4, Firefox 157.0, WebKit 27.2; tested against stable Chrome/Edge 155. 1.64 added WebMCP, video `fps`/`style` options, `testProject.default`, **`--shuffle`** with a reproducible seed, **`test.describe.configure({ lock })`** test locks, `locator.within()`, `page.getByRef()`. Breaking in 1.64: `screen` is forwarded from device descriptors, JSX in test files follows `tsconfig.json`, `--update-snapshots=missing` now passes, elements inside hidden iframes count as hidden. 1.63 dropped Ubuntu 20.04 and stopped updating the experimental component-testing packages.

**Delta vs. training-data assumption:** I would have said "Vitest 3 or 4" and "Playwright ~1.4x". The material deltas are that **Vitest 5 requires Vite ≥6.4** (couples our bundler choice to our test runner), that coverage configs from v3 **silently under-report** unless `coverage.include` is set, and that Playwright now has **test locks + shuffled order with a seed** — which is precisely what a single-machine e2e suite needs to stop lying.

### 6.7 `node:sqlite` API surface and whether it is production-usable in 2026

**Surface (Node v26.13.0 docs, [nodejs.org/api/sqlite.html](https://nodejs.org/api/sqlite.html)):**

- `new Database(path[, options])` — synchronous by design ("All APIs exposed by this class execute synchronously"). Options: `open`, `readOnly`, `enableForeignKeyConstraints` (default true), `enableDoubleQuotedStringLiterals`, `allowExtension`, **`timeout`** (busy timeout in ms, **default 0**), `readBigInts`, `returnArrays`, `allowBareNamedParameters` (default true), `allowUnknownNamedParameters`, **`defensive`** (default **true** since 25.5.0/24.14.0), and `limits{length, sqlLength, column, exprDepth, compoundSelect, vdbeOp, functionArg, attach, likePatternLength, variableNumber, triggerDepth}`.
- `Database`: `prepare`, `exec`, `close`, `open`, `aggregate`, `function`, `setAuthorizer`, `location`, `serialize`/`deserialize`, `createTagStore`, `createModule`, `createSession`, `applyChangeset`, `isOpen`, `isTransaction`, `limits`, `[Symbol.dispose]`.
- `Statement`: `run`, `get`, `all`, `iterate`, `columns`, `sourceSQL`, `expandedSQL`, `setAllowBareNamedParameters`, `setAllowUnknownNamedParameters`, `setReturnArrays`, `setReadBigInts`, `stat`, `close`, `[Symbol.dispose]`.
- Plus `SQLTagStore` (statement cache for tagged templates), `Session` (changesets/patchsets), and **`sqlite.backup(sourceDb, path[, options])`**.

**WAL / pragma / transactions.** Pragmas are plain SQL through `exec()`/`prepare()` (`PRAGMA journal_mode=WAL`, `PRAGMA synchronous=NORMAL`, `PRAGMA busy_timeout=5000`) — there is no dedicated pragma API, and the local probe confirmed `db.prepare('PRAGMA synchronous').get()` works. Transactions are likewise raw SQL (`BEGIN IMMEDIATE` / `COMMIT` / `ROLLBACK`) or `exec()` of a script; the docs expose `database.isTransaction` to check state, and the API reference documents `sqlite.constants` for conflict-resolution and authorizer codes. Diagnostics are observable via `diagnostics_channel` (`'sqlite.db.query'`) — useful for instrumenting statement timing without wrapping everything.

**Production-usable?** Qualified **yes, with three caveats**.

- _For:_ stability is **1.2 RC** (not "experimental"), it ships everything we would otherwise add a dependency for (backup, statement cache, sessions, defensive mode, limits, busy timeout), and DSH itself ships a SQLite **session-storage** backend ("whole-unit JSON and SQLite storage … read older versions declared by the domain and write the new format", `v0.2.2-alpha.2` notes) — i.e. this runtime's own product treats it as load-bearing.
- _Caveat 1 — the class name moved._ Write `import { Database } from 'node:sqlite'`, not `DatabaseSync`; the latter still works but is DEP0210-deprecated. A thin adapter module keeps this to one file.
- _Caveat 2 — synchronous API blocks the event loop._ Every call is sync. In a control plane that also runs an HTTP/queue loop, either keep transactions tiny, or put SQLite behind a worker thread. This is a design constraint, not a bug.
- _Caveat 3 — busy timeout defaults to 0._ Verified locally on Node 22 (`PRAGMA busy_timeout` → 0) and documented as the `timeout` option default. Any second writer (a litestream checkpoint, a CLI, a second worker) turns into immediate `SQLITE_BUSY` unless you set `timeout: 5000`.

**Delta vs. training-data assumption:** I would have written `new DatabaseSync()` guarded behind an "experimental, don't ship it" note, and separately pulled in a statement-cache helper and a backup script. Reality: it is an RC with a **renamed primary class**, a built-in **`sqlite.backup()`**, a built-in tagged-template statement cache, defensive mode on by default, and a **busy timeout that defaults to zero** — the last one being the detail most likely to produce a mysterious first-day production incident.

### 6.8 Zod major and breaking changes vs v3

**Version: `zod` 4.6.7** — registry check returns 4.6.7; the npm package page shows "Version: 4.6.7, Updated 2026-10-12". (One source, the registry packument summary, still displayed `4.4.3 · Published May 4, 2026` with a `4.5.0-canary` line above it; I trust **4.6.7** because it is what `npm view zod version` resolves and what the package page's "Version" field states on 2026-11-01. Either way the pin should be `zod@^4.6`.)

**Breaking changes vs v3** ([Zod 4 migration guide](https://zod.dev/v4/changelog)) — the ones that will actually hit a copied v3 schema:

- **Error customisation unified on `error`.** `message` deprecated; **`invalid_type_error`, `required_error`, and `errorMap` are dropped/renamed**. `z.string({ error: (iss) => … })` is the new form.
- **Error formatting:** `.format()`, `.flatten()` deprecated → **`z.treeifyError()`**; `.errors` removed (use `.issues`); `ctx.path` dropped inside refinements.
- **String formats moved to top level:** `z.email()`, `z.uuid()`, `z.url()`, `z.base64url()`, `z.ipv4/6()`, `z.iso.datetime()`, … The method forms still work but are deprecated. `z.uuid()` is stricter (RFC 9562 variant bits); `z.guid()` is the permissive one. `.ip()`/`.cidr()` dropped in favour of v4/v6 splits.
- **`z.coerce.*` input type is now `unknown`**, and a missing key on an object with a `z.coerce` field now **errors** (v3 silently produced `false`) — use `.default()`.
- **`.default()` semantics changed** (short-circuits; default must match the _output_ type) — the old behaviour is `.prefault()`. Defaults now apply **inside optional fields**.
- **Object helpers:** `.strict()`/`.passthrough()` deprecated → `z.strictObject()`/`z.looseObject()`; `.deepPartial()`, `.nonstrict()`, `.merge()` (use `.extend()`) deprecated/removed.
- **`z.record()` requires two arguments.** `z.function()` is now a function _factory_ with `input`/`output` and `implement()`/`implementAsync()`. `z.nativeEnum()` deprecated (use `z.enum(enumObject)`).
- **Types:** `ZodType<Output, Input>` — the `Def` generic is **gone**; `Input` now defaults to `unknown`; `z.ZodTypeAny` no longer needed; internals moved to `z.core` / `zod/v4/core`. `z.unknown()`/`z.any()` keys are no longer marked optional (and since **4.4.0** they are required at parse time).
- Minor but real: `z.number().int()` rejects unsafe integers; `POSITIVE_INFINITY`/`NEGATIVE_INFINITY` are invalid for `z.number()`; `.nonempty()` now infers `string[]`.

**Delta vs. training-data assumption:** I would have described Zod 4 as "v3 with better perf" and reused `errorMap`, `.strict()`, `.flatten()`, and single-argument `z.record()`. All of those are dropped or deprecated, and the one that produces _silent_ runtime behaviour change rather than a type error is **`z.coerce` no longer filling in missing keys** plus **`.default()` semantics flipping to output-typed**.

### 6.9 SQLite durability settings for a queue/outbox, and backup practice

**The canonical settings**, from Litestream's operational guidance ([litestream.io/tips](https://litestream.io/tips/)):

```sql
PRAGMA busy_timeout = 5000;   -- wait 5s on a write lock instead of failing; Litestream checkpoints need short write locks
PRAGMA journal_mode = WAL;    -- required for Litestream, and the right default anyway (concurrent readers)
PRAGMA synchronous = NORMAL;  -- fsync only when the WAL checkpoints
```

**What `synchronous = NORMAL` actually buys and costs** — and this is the part that matters for a _queue_: in WAL mode, writers sync the WAL on every commit only if `synchronous = FULL`; with `NORMAL` the commit sync is omitted and **the checkpoint is the only operation issuing an I/O barrier**. SQLite's own docs are unusually direct about the trade: "The downside to this configuration is that **transactions are no longer durable** and might rollback following a power failure or hard reset" ([SQLite WAL docs](https://www.sqlite.org/wal.html)). Litestream adds its own loss window on top: it replicates asynchronously, ~1s by default, "a catastrophic crash on your server will result in the loss of data in that time window", and synchronous replication "is on the Litestream roadmap but has not yet been implemented".

**Recommendation for an at-least-once job ledger / outbox:**

| Concern             | Setting                                                                                                    | Why                                                                                             |
| ------------------- | ---------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------- |
| Journal             | `journal_mode=WAL`                                                                                         | Concurrent readers while one writer commits; required if any replication tool is added later    |
| Commit durability   | **`synchronous=FULL`** for the claim/outbox tables                                                         | A lost "job claimed" commit is a lost job or a double-run; NORMAL trades exactly that for speed |
| Lock waits          | `busy_timeout=5000` (node:sqlite: `new Database(path, { timeout: 5000 })`)                                 | Default is **0**; any second connection yields instant `SQLITE_BUSY`                            |
| Contention          | `BEGIN IMMEDIATE` for claim transactions                                                                   | Avoids deadlock-prone deferred→write upgrades under concurrency                                 |
| Single writer       | One process owns writes; others read                                                                       | SQLite is single-writer; a factory control plane should have exactly one writer process         |
| Checkpointing       | Leave `wal_autocheckpoint` default; monitor WAL size                                                       | Long-lived readers block checkpoints → WAL growth                                               |
| Backup              | `sqlite.backup(db, path)` (built into `node:sqlite`) on a schedule, plus a copy of the WAL-consistent file | Online backup without stopping the writer; no shelling out to `sqlite3 .backup`                 |
| Off-box replication | Litestream **v0.5.17** (2026-08-31) _if_ needed                                                            | Async (~1s loss window); v0.5 requires **exactly one replica per database**                     |

**Litestream v0.5 is a breaking change from v0.3/v0.4** worth knowing before it enters a plan ([releases](https://github.com/benbjohnson/litestream/releases), [migration](https://litestream.io/docs/migration/)): migrated from cgo `mattn/go-sqlite3` to pure-Go `modernc.org/sqlite` (so **PRAGMA syntax in DSNs changed** to `?_pragma=busy_timeout(5000)`), `litestream wal` renamed to `litestream ltx`, single `replica` field replaces the `replicas` array (two or more is now a startup error), plus MCP support and NATS/JetStream replication.

**Delta vs. training-data assumption:** I would have written "WAL + `synchronous=NORMAL` + `busy_timeout=5000`" as the universal SQLite-server incantation. For a **queue/outbox** that is the wrong default: NORMAL explicitly gives up commit durability (SQLite's docs say so), and if Litestream is layered on, the loss window compounds to ~1s. Also, the "busy_timeout=5000" line is not a nicety here — `node:sqlite`'s default is 0.

### 6.10 `git worktree`-based agent isolation tooling in 2026

Worktrees are no longer a DIY trick; they are a product feature in two agent runtimes, with a common shape emerging.

- **Claude Code** ships `--worktree`/`-w <name>`: creates the worktree under `.claude/worktrees/<repo>/<name>` on a new `worktree-<name>` branch, and — the important part — **enforces** it: while isolated, "Claude Code blocks the tool calls the checks below define", and the same enforcement "covers every subagent Claude spawns from the isolated session". Subagents can be declared `isolation: worktree` in frontmatter; a worktree with changes is preserved, a clean one is swept; `.worktreeinclude` controls what is copied in; `worktree.baseRef` chooses the base ([docs](https://code.claude.com/docs/en/worktrees)).
- **DSH** ships the same idea natively: an experimental **Git Worktrees plugin** from `v0.2.1-rc.1`, upgraded in `v0.2.2-alpha.2` to "Change requests and worktrees — run Sessions in separate Git worktrees and inspect linked PR status and code changes".
- **Third-party:** [WorktreePilot](https://github.com/WorktreePilot/worktree-pilot) (`wtp`, **v0.3.0 experimental**) models "one task / one worktree / one branch / one agent session", plus **assigned ports** for dev services, session metadata/logs, and lifecycle commands (`wtp finish --remove-worktree` refuses a dirty worktree without `--force`, refuses removal while live processes reference it). Honest self-assessment: WSL+Windows Terminal is the primary target, macOS/Linux use fallback commands, not on npm yet.

**The practice, distilled:** the worktree itself is trivial (`git worktree add`); what the 2026 tools add is what a factory actually needs — a **convention for where worktrees live and are named**, an **enforcement layer** that prevents the agent from escaping back to the main checkout (Claude Code blocks the tool calls; DSH's plugin binds the _Session_ to the checkout), a **cleanup policy that distinguishes "dirty, keep" from "clean, sweep"**, and **per-task port/service allocation** so parallel e2e runs don't collide. `git worktree` also shares the same `.git` directory, so any worker needing `git commit` inside a sandbox needs the git metadata granted explicitly — DSH already models this with `--add-dir … --permission-mode workspace-write /repo/.git` (see `docs/cli-help.md`).

**Delta vs. training-data assumption:** I would have treated worktrees as a manual convention with no enforcement, and considered "one worktree per task" sufficient. Reality: both major agent harnesses now treat worktree isolation as a first-class, _enforced_ session property, and the hard parts (dirty/clean cleanup policy, port allocation, `.git` metadata access under a sandbox) are exactly the parts a from-scratch implementation forgets.

### 6.11 Build/run toolchain: esbuild / tsdown / tsx / Node type stripping; CLI and logging libs

**Node's built-in TypeScript support is now Stable — this is the headline.**

From [Modules: TypeScript (Node v26.13.0)](https://nodejs.org/api/typescript.html): stability **2 — Stable**, with the history table saying **type stripping is stable in v25.2.0 and v24.12.0**; enabled by default since v23.6.0/v22.18.0; emits no experimental warning since v24.3.0/v22.18.0; and **`--experimental-transform-types` was removed in v26.0.0**. Mechanics and limits:

- Node **replaces types with whitespace**, performs **no type checking**, needs no source maps, and **ignores `tsconfig.json` entirely** — so `paths`, downlevelling, and anything config-driven are intentionally unsupported.
- The parser requires **WebAssembly**; if unavailable it throws `ERR_WEBASSEMBLY_NOT_SUPPORTED` (no fallback parser).
- The built-in path only handles **erasable syntax**. `enum`, `namespace`-with-values, parameter properties, and decorators that need codegen are _not_ available — use `tsx`/`tsdown` for those, or (better) set `erasableSyntaxOnly: true` so the compiler forbids them.
- Recommended tsconfig for this mode: `target: esnext`, `module: nodenext`, `rewriteRelativeImportExtensions: true`, `erasableSyntaxOnly: true`, `verbatimModuleSyntax: true`, TS ≥ 5.8.

**Bundlers / runners (registry, 2026-11-01):**

| Package   | Version                 | Note                                                                                                                                                                |
| --------- | ----------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `esbuild` | **0.28.2**              | still pre-1.0; fastest raw transpile, no type declarations                                                                                                          |
| `tsdown`  | **0.23.4** (2026-10-29) | Rolldown + Oxc; generates `.d.ts`; tsup-compatible options; peers `typescript ^5 \|\| ^6 \|\| ^7`, bundles `tsx`, `vitest ^5`, `@types/node ^26` in its own devDeps |
| `tsx`     | **4.23.15**             | full TS syntax incl. enums/decorators; `node --import=tsx` is the documented escape hatch when built-in stripping isn't enough                                      |

**CLI / logging:** `commander` **15.0.0**, `yargs` **18.2.0**, `pino` **10.4.0**. (Recommendation, not a version claim: `commander` for a small, explicitly-specified CLI surface — it produces the help shape DSH itself uses — and `pino` for JSON logs on **stderr** so stdout stays a clean event stream.)

**Verdict on "no build step".** For a control plane that is _run_ rather than _published_, yes: `node src/main.ts` works today on Node 26 with default type stripping, no flag, no watcher, no bundler — at the cost of (a) no type checking at runtime (run `tsc --noEmit` in CI), and (b) the erasable-syntax rule (`erasableSyntaxOnly` enforces it at compile time). For a _published library_ you still want `tsdown` (declarations + dual format). For the factory's own binary/CLI, type stripping + `tsc --noEmit` is the simplest defensible setup; `tsx` remains the fallback if a dependency or a stray `enum` needs transform semantics.

**Delta vs. training-data assumption:** I would have written `node --experimental-strip-types` (or "not production-ready on 22") and assumed a bundler was mandatory. Reality: it is **Stable**, **on by default**, and the _flag_ that disappeared is `--experimental-transform-types` — so the risk inverted: you no longer opt in to stripping, you opt out of the syntax it cannot handle, and `erasableSyntaxOnly: true` is the guard that makes that safe.

---

## Phase 7/8 Kickoff Research (brief: CLI UX, terminal UI, terminal accessibility)

**Colour and output conventions.** The `NO_COLOR` standard is still the reference, last updated **2026-10-12**: check for a `NO_COLOR` env var that is _present and non-empty_, regardless of value, and suppress added ANSI colour; user config and explicit CLI flags **override** `NO_COLOR`; and — the detail that is usually missed — **`NO_COLOR` does not cover bold, underline, or italic** ([no-color.org](https://no-color.org/)). So a "plain mode" that only honours `NO_COLOR` still emits escape codes for emphasis, which is precisely what a log pipeline or screen reader chokes on. If you need a stronger mode, define one yourself (e.g. `--plain` ⇒ no ANSI at all) rather than overloading `NO_COLOR`.

**Terminal accessibility (Phase 8).** The FreeBSD accessibility handbook's developer chapter is the most concrete public guidance found: "**Avoid using color as the sole means of conveying information**"; if colour is used, provide a well-documented way to configure it, and support `NO_COLOR` where possible; contrast checkers (e.g. `kontrast`) exist for the colour choices you do make. It also notes the CLI is "generally considered accessible by a screen reader" _provided_ the developer avoids the usual mistakes — i.e. no cursor-addressing animation, no redraw-in-place for content that matters, no meaning encoded only in position or colour ([FreeBSD docs](https://docs.freebsd.org/en/books/accessibility/development/)). For this factory the practical rule is: **every human-facing state must be expressible in text** (job id, state name, exit code, reason) — colour and glyphs are decoration; the NDJSON stream is the real interface.

**Terminal UI libraries (2026).** `ink` **8.0.0** (React for CLIs) and `@clack/prompts` **1.8.1** (2026-09-13; `@clack/core` underneath) are the two current defaults; a curated 42-rule TUI practice guide exists covering both ([dot-skills/terminal-ui](https://github.com/pproenca/dot-skills/tree/master/skills/.curated/terminal-ui)). `@clack/prompts` gives `text/password/confirm/date/select/autocomplete/multiselect/path/spinner` plus `isCancel` handling for Ctrl-C ([npm](https://www.npmjs.com/package/@clack/prompts)).

**Phase 7 design implication.** Two surfaces, one schema: `--json` NDJSON (machine, stable, versioned) and a human TTY view that is a _renderer_ over the same events, not a second code path. Non-interactive contexts must be detected (`!process.stdout.isTTY`, `CI`, `TERM=dumb`) and must never block on a prompt — DSH's own `--approval-policy never` is the analogue. A TUI library is optional; a stable event schema is not.

**Delta vs. training-data assumption:** I would have said "respect `NO_COLOR` and you're accessible". `NO_COLOR` explicitly does **not** disable bold/underline/italic, so accessibility/log-cleanliness needs a stronger mode than the standard; and the highest-value accessibility property of a factory CLI is that every state is text-encodable in the JSON stream, not that the spinners look right.

---

## Phase 10 Kickoff Research (brief: Playwright for a CLI-driven system)

**What Playwright itself recommends** ([best practices](https://playwright.dev/docs/best-practices), [trace viewer](https://playwright.dev/docs/trace-viewer)):

- **Traces, not videos/screenshots, are the CI debugging artifact.** Configure `trace: 'on-first-retry'` with `retries: 1` in CI; do **not** use `trace: 'on'` (performance-heavy). Alternatives: `'on-all-retries'`, `'retain-on-failure'` (useful when you have no retries but still want failure traces). Open traces locally or at trace.playwright.dev.
- **Parallelism and sharding:** tests run in parallel by default; one file runs in order in one worker; `test.describe.configure({ mode: 'parallel' })` parallelises within a file; `--shard=1/3` splits a suite across machines; run CI on Linux for cost.
- **New in 1.64 and directly useful here:** `test.describe.configure({ lock: 'name' })` / `test('…', { lock }, …)` — tests sharing a lock name **never run concurrently across files, workers, and projects** (ideal for "one SQLite writer" or "one shared DB" e2e); `--shuffle [seed]` randomises order and prints a reproducible seed (flaky cross-test dependencies surface immediately); `testProject.default: false` keeps browser projects configured but out of the default run.

**What this means for a factory whose workers are `dsh --profile headless --json` subprocesses.** Playwright is a **browser** harness: it cannot test a CLI. The e2e split should be:

- **CLI/subprocess e2e → vitest** (+ `node:child_process`/`execa`), asserting on the NDJSON event stream, exit codes, and the produced git diff. This is the test that actually protects the factory.
- **Playwright → only the surfaces that are HTML** (the DSH Web GUI at `http://127.0.0.1:65107`, HTML reports/dashboards), with `trace: 'on-first-retry'`, `--shard` in CI, `--shuffle` locally, and **test locks for any spec that touches the shared datastore**.
- Keep `trace.zip` + the NDJSON transcript as the two artifacts per failed run — together they are a reproducible receipt.

**Note on "Playwright CLI":** if the plan means `npx playwright test`, the above applies. 1.64 also documents a separate **`playwright-cli`** binary for agent-driven browser automation (`playwright-cli webmcp-list`, `webmcp-call …`), which is a _different tool_ from the test runner; **UNVERIFIED** which one the plan intends, and it should be disambiguated before Phase 10 is written.

**Delta vs. training-data assumption:** I would have assumed Playwright is the default e2e tool for everything and that "trace on failure" needed `'on'`. In fact Playwright **cannot exercise a CLI at all**, `'on-first-retry'` is the recommended trace setting, and the 2026 features that matter for a single-machine factory are **test locks** and **seeded shuffling** — neither of which existed in the mental model.

---

## Pinned version table (Phase 6 — the tech guide's inputs)

All versions read from the live registry (`npm view <pkg> version`, 2026-11-01) unless noted.

| package                       | version                                                                                    | source URL                                                                                                                                 | note                                                                                                                                                       |
| ----------------------------- | ------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `node`                        | **26.12.1** (brew formula stable); docs at v26.13.0                                        | [nodejs.org previous-releases](https://nodejs.org/en/about/previous-releases) · [nodejs/release](https://github.com/nodejs/release)        | **Active LTS** since 2026-10-28. Only line that is both Active LTS and satisfies DSH 0.2.2's ≥24.9 floor. Local brew node is 25.8.1; PATH node is 22.23.3. |
| `typescript`                  | **7.0.2**                                                                                  | [npm](https://www.npmjs.com/package/typescript) · [7.0 announcement](https://devblogs.microsoft.com/typescript/announcing-typescript-7-0/) | Native (Go) compiler, LSP. `7.1.0-beta` out 2026-10-20 — do not pin beta.                                                                                  |
| `vitest`                      | **5.0.5**                                                                                  | [vitest.dev/releases](https://vitest.dev/releases) · [5.0 blog](https://vitest.dev/blog/vitest-5.html)                                     | Requires **Vite ≥6.4.0**, Node ≥22.12.0. Set `coverage.include` explicitly.                                                                                |
| `@playwright/test`            | **1.64.1**                                                                                 | [GitHub releases](https://github.com/microsoft/playwright/releases)                                                                        | Chromium 156 / Firefox 157 / WebKit 27.2. Use `trace: 'on-first-retry'`, `lock`, `--shuffle`.                                                              |
| `zod`                         | **4.6.7**                                                                                  | [npm](https://www.npmjs.com/package/zod) · [v4 migration](https://zod.dev/v4/changelog)                                                    | Package pin `^4.6`. v3 idioms (`errorMap`, `.strict()`, `.flatten()`) are deprecated/removed.                                                              |
| `tsx`                         | **4.23.15**                                                                                | [registry](https://registry.npmjs.org/tsx)                                                                                                 | Fallback runner when erasable-only stripping isn't enough.                                                                                                 |
| `tsdown`                      | **0.23.4**                                                                                 | [npm](https://www.npmjs.com/package/tsdown)                                                                                                | Rolldown/Oxc; `.d.ts` emit. Only needed if we publish a library.                                                                                           |
| `esbuild`                     | **0.28.2**                                                                                 | [registry](https://registry.npmjs.org/esbuild)                                                                                             | Still 0.x. Not needed if we run TS directly.                                                                                                               |
| `commander`                   | **15.0.0**                                                                                 | [registry](https://registry.npmjs.org/commander)                                                                                           | Preferred CLI parser (small explicit surface).                                                                                                             |
| `yargs`                       | **18.2.0**                                                                                 | [registry](https://registry.npmjs.org/yargs)                                                                                               | Alternative; not preferred here.                                                                                                                           |
| `pino`                        | **10.4.0**                                                                                 | [registry](https://registry.npmjs.org/pino)                                                                                                | Log to **stderr**; stdout stays NDJSON.                                                                                                                    |
| `node:sqlite`                 | built-in, **Stability 1.2 RC**                                                             | [Node sqlite docs](https://nodejs.org/api/sqlite.html)                                                                                     | No package. Use `Database` (not `DatabaseSync`); set `timeout: 5000`.                                                                                      |
| `better-sqlite3`              | **13.0.3**                                                                                 | [registry](https://registry.npmjs.org/better-sqlite3)                                                                                      | Fallback only; native build on Node 26 **UNVERIFIED** (prebuilds).                                                                                         |
| `litestream`                  | **0.5.17** (2026-08-31)                                                                    | [releases](https://github.com/benbjohnson/litestream/releases)                                                                             | Optional off-box replication. v0.5 = one replica per DB, `?_pragma=` DSN syntax.                                                                           |
| `@clack/prompts`              | **1.8.1**                                                                                  | [npm](https://www.npmjs.com/package/@clack/prompts)                                                                                        | Optional TUI prompts for the operator CLI.                                                                                                                 |
| `ink`                         | **8.0.0**                                                                                  | [registry](https://registry.npmjs.org/ink)                                                                                                 | Optional; only if a live TUI is wanted.                                                                                                                    |
| `dsh`                         | installed **0.2.1-rc.3**; newest **0.2.1-rc.5** (2026-10-30); newest tag **0.2.2-alpha.2** | [releases](https://github.com/deepseek-ai/deepseek-harness/releases) · [tags](https://github.com/deepseek-ai/deepseek-harness/tags)        | No stable tag exists. Pin exact. Binary at `/Applications/DeepSeek Harness.app/Contents/Resources/runtime/cli/bin/dsh` (not on PATH).                      |
| `@temporalio/workflow`        | 1.25.0                                                                                     | [CHANGELOG](https://github.com/temporalio/sdk-typescript/blob/HEAD/CHANGELOG.md)                                                           | Orchestration candidate #1 (heaviest).                                                                                                                     |
| `@dbos-inc/dbos-sdk`          | 5.4.0                                                                                      | [registry](https://registry.npmjs.org/@dbos-inc/dbos-sdk)                                                                                  | Orchestration candidate #2 — reuses our existing Postgres 14.                                                                                              |
| `@hatchet-dev/typescript-sdk` | 1.46.0                                                                                     | [registry](https://registry.npmjs.org/@hatchet-dev/typescript-sdk)                                                                         | Orchestration candidate #3 (needs a service).                                                                                                              |
| `@restatedev/restate-sdk`     | 1.18.1                                                                                     | [registry](https://registry.npmjs.org/@restatedev/restate-sdk)                                                                             | Server is **BSL 1.1** — licence risk for a productised factory.                                                                                            |

---

## Recommended pins (the set the tech guide should use)

| Decision           | Pin                                                                                                                                                                                                   | Confidence  | Rationale                                                                                                                                         |
| ------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------- | ------------------------------------------------------------------------------------------------------------------------------------------------- |
| Runtime            | **Node 26.12.x (Active LTS)**                                                                                                                                                                         | High        | Only Active LTS; required for `node:sqlite` 1.2 RC and DSH 0.2.2's ≥24.9 floor. Upgrade from PATH 22.23.3 is mandatory work, not optional.        |
| Language           | **TypeScript 7.0.2**, `tsc --noEmit` in CI                                                                                                                                                            | High        | Stable native compiler. Avoid 7.1 beta.                                                                                                           |
| TS execution       | **Built-in type stripping** (`node src/main.ts`), `erasableSyntaxOnly: true`; `tsx 4.23.15` as escape hatch                                                                                           | High        | Node docs: stripping is Stable, default-on, ignores tsconfig.                                                                                     |
| tsconfig           | `strict`, `noUncheckedIndexedAccess`, `exactOptionalPropertyTypes`, `verbatimModuleSyntax`, `erasableSyntaxOnly`, `module: nodenext`, `target: esnext`, **`types: ["node"]`**, **`rootDir: "./src"`** | High        | TS 6 changed all the relevant defaults; the last two are the silent-failure guards.                                                               |
| Tests              | **Vitest 5.0.5** (Vite ≥6.4)                                                                                                                                                                          | High        | Current major; explicit `coverage.include` required.                                                                                              |
| E2E (browser only) | **@playwright/test 1.64.1**                                                                                                                                                                           | High        | Do not use it for CLI e2e.                                                                                                                        |
| Validation         | **zod ^4.6.7**                                                                                                                                                                                        | High        | v4 only; do not port v3 schemas uncritically.                                                                                                     |
| Datastore          | **SQLite via `node:sqlite`** (Node 26, `Database`), with `better-sqlite3 13.0.3` as the documented fallback                                                                                           | Medium-High | Zero-dependency, RC-stable, single-writer, built-in `backup()`. Postgres stays available for DBOS if orchestration needs it.                      |
| SQLite pragmas     | `journal_mode=WAL`, **`synchronous=FULL`** for claim/outbox, `busy_timeout=5000` via `{ timeout: 5000 }`, `BEGIN IMMEDIATE`                                                                           | High        | NORMAL gives up commit durability; default busy timeout is **0**.                                                                                 |
| Backup             | `sqlite.backup()` on a schedule; Litestream **only if** off-box replication is required                                                                                                               | Medium      | Built-in beats a shell script; Litestream adds ~1s loss window and v0.5 config constraints.                                                       |
| Logging            | **pino 10.4.0** to stderr                                                                                                                                                                             | High        | Keeps stdout a pure NDJSON event stream (see DSH rc.4 bug).                                                                                       |
| CLI                | **commander 15.0.0**                                                                                                                                                                                  | Medium-High | Small explicit surface; `yargs 18.2.0` is the alternative.                                                                                        |
| Orchestration      | **Own event log + outbox** now; interface-shaped so **DBOS 5.4.0 over existing Postgres** is the upgrade path. Temporal only if polyglot/cloud requirements appear.                                   | Medium      | Matches single-operator + Postgres-already-running; avoids operating a second server.                                                             |
| Isolation          | **Per-task git worktree + per-task sandbox**; on this machine evaluate Apple **Containerization/`container`** (needs macOS 26 — we have 26.4) with an **egress allowlist proxy**                      | Medium      | Containerization is the only first-party microVM boundary on macOS; sandboxy is the reference pattern. Docker+gVisor remains UNVERIFIED on macOS. |
| DSH                | Pin **exact** version; currently `0.2.1-rc.3` installed, `0.2.1-rc.5` newest release; treat 0.2.2-alpha as a separate track                                                                           | High        | No stable tag exists; 0.2.2 changes the Node floor and the isolation model.                                                                       |

**Three deltas that change decisions most:**

1. **Node floor.** DSH 0.2.2 requires Node ≥ 24.9 and this machine runs 22.23.3 on PATH (25.8.1 in brew). Node 26 is the only Active LTS. → a runtime upgrade is a Phase-1 prerequisite, and it is also what unlocks `node:sqlite` RC.
2. **`node:sqlite` is an RC with different names.** Write `Database`, set `timeout: 5000`, and rely on the built-in `backup()`/`SQLTagStore` instead of adding dependencies — but keep an adapter so `better-sqlite3` remains a one-file swap.
3. **Isolation moved up the stack.** Both Claude Code and **DSH itself** now ship enforced worktree-per-session isolation, and macOS has a first-party microVM runtime. Building our own worktree plumbing is largely re-implementing a shipped feature; the genuinely missing control is **egress** (allowlist proxy), not filesystem scope.

**Things that would change a datastore or runtime decision:**

- If DSH's own SQLite session storage must be read/joined by the factory, we inherit its schema-versioning constraints (`v0.2.2-alpha.2`: "read older versions declared by the domain and write the new format") — read-only joins are safe, writes are not.
- If `node:sqlite`'s synchronous API proves to block the control-plane loop under our write rate, the choice is worker-thread SQLite or Postgres — decide by measurement, not by preference.
- If any dependency forces non-erasable TS syntax (enums/decorators/parameter properties), type stripping stops being sufficient and `tsx`/`tsdown` becomes mandatory — `erasableSyntaxOnly: true` makes this fail in CI rather than at runtime.

---

## Open questions / could-not-verify

1. **gVisor (`runsc`) under Docker Desktop 29.8.2 on macOS 26.4 — UNVERIFIED.** gVisor requires a Linux host kernel; whether a `runsc` runtime can be registered inside Docker Desktop's Linux VM (and whether it is supported) was not confirmed by any source read. Do not put "Docker + gVisor" in the plan without a local spike.
2. **Apple `container` CLI version / GA status — UNVERIFIED.** Only the **Containerization** framework's requirements (Apple silicon, macOS 26, Xcode 26) and the separate `apple/container` repo were confirmed. No version number, release cadence, or stability claim was read.
3. **Exact Node.js minor that renamed `DatabaseSync` → `Database`** (DEP0210) — **UNVERIFIED**. The v26.13.0 docs state the alias is deprecated and reference DEP0210, but the deprecations page was not fetched. Consequence is low (both work on 26) but the pin advice is "use `Database`".
4. **Whether `dsh --profile acp` exposes ACP v1 features** (resume/close/delete/usage) — **UNVERIFIED**. DSH ships an ACP profile (inferred from the rc.4 "diagnostics leaking into stdout in ACP mode" fix and from bundles being offered "for use in … ACP profiles"), but no DSH ACP documentation was found. Requires a local probe before the tech guide prefers ACP over NDJSON.
5. **DSH 0.2.1-rc.3 on Node 26 — UNVERIFIED.** DSH 0.2.2 states a 24.9 floor; whether the currently installed rc.3 build runs correctly on Node 26.12 is untested here. Sequence the upgrade as: install Node 26 → run the existing headless smoke task → only then build on it.
6. **`better-sqlite3` 13.0.3 prebuilt binaries for Node 26 (ABI) — UNVERIFIED.** It is only a fallback; if it is needed, verify install time on this machine before committing.
7. **Zod version discrepancy — resolved but noted.** The registry packument summary displayed `4.4.3 · Published May 4, 2026` with a `4.5.0-canary` line, while `npm view zod version` and the npm package page both say **4.6.7**. I trust 4.6.7 (registry resolution + package page, 2026-11-01); pin `^4.6` so the discrepancy cannot matter.
8. **Whether the plan's "Playwright CLI" means `npx playwright test` or the separate `playwright-cli` agent binary — UNVERIFIED / needs disambiguation.** 1.64 documents both; they serve different purposes.
9. **Temporal server version coupling:** SDK 1.25 notes gate child-workflow versioning overrides on "Temporal Server 1.32.0 or later". Irrelevant unless Temporal is adopted, but it means "pin the SDK" is not sufficient for Temporal — the server must be pinned too.
10. **No stable DSH release exists** (all tags are alpha/rc as of 2026-11-01). Any plan that assumes a stable channel, semver guarantees, or a public deprecation policy for DSH is assuming something that is not yet true.
11. **Litestream tips page is not dated per-section.** The recommended pragmas (`busy_timeout=5000`, WAL, `synchronous=NORMAL`) come from [litestream.io/tips](https://litestream.io/tips/), whose content may predate v0.5; the _rationale_ is corroborated by SQLite's own WAL documentation, but treat the exact numbers as convention rather than measurement.
