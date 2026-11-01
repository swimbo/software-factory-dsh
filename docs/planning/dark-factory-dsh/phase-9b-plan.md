# Phase 9b — Implementation: DSH Worker Adapter & Isolation

**Status:** pending
**Owner:** lead
**Artifacts produced:** `packages/dsh-adapter/**`, `docker/factory-env/Dockerfile`, `scripts/provision-dsh-home.sh`, `fixtures/fake-dsh/**`

## Objective

Give the factory a way to run DeepSeek-Harness workers that is **crash-isolated, receipt-producing and killable**: one `git worktree` and one container per attempt, a per-run DSH profile overlay, NDJSON supervision, harness-owned ceilings, and a receipt captured from git — never from the model's prose.

## Prerequisites

- Phase 9a complete (store, engine, effects).
- DSH binary path resolved (see `phased-plan.md > ## Open questions` #2); version pinned in `packages/contracts/src/dsh-version.ts`.
- Docker 29.x available for `@docker`-tagged tests (not required for the offline suite).

## Tasks

- [~] `packages/dsh-adapter/src/port.ts`: the `Executor` interface exactly as `architecture.md §2.2` (`start`, `observe`, `terminate`, `collect`), plus `AttemptSpec`, `AttemptHandle`, `Progress`, `WorkerReceipt`.
- [x] `worktree.ts`: pristine-clone manager (`~/.factory/repos/<repoId>.git` bare mirror → `git worktree add --detach <attemptDir> <baseRevision>`); refuses to start if the source tree is dirty; `diff()` captures `git diff --binary <base>...HEAD` **on exit 0 and exit 1** plus `git status --porcelain` and the untracked-file list.
- [x] `profile.ts`: generates the per-attempt `--patch` overlay YAML — **five required entries** verified by probe (`evidence/phase-9b-dsh-integration-probe.md`): `sandbox-policy {mode: workspace-write, workspaceRoot: <attemptDir>}`, `approval {policy: never}`, `permission-presets {defaultPreset: factory-worker, presets: {factory-worker: {sandbox: workspace-write, approval: never}}}`, `llm-pi-ai {providers.bifrost: {apiKeyEnv: BIFROST_API_KEY, api: anthropic-messages, baseURL: <proxy>, models: [factory-worker-tier]}}`, `agent-default-model {provider: bifrost, model: factory-worker-tier}` — plus an explicit tool allowlist, `compression: 'none'` and no MCP servers. A **two-entry** approval+sandbox overlay is a known silent-degradation trap. Refuses to emit an overlay that embeds a secret value.
- [x] `headless.ts`: spawn `dsh --profile factory-worker --patch <overlay> --json "<task>"`; parse NDJSON (`session`, `status` phases, `tool_call`, `tool_result`, `final`, `error`); treat **exit code + `turn_end.reason`** as the outcome; record the session-id tree; assert the binary version equals the pin (`DSH_VERSION_MISMATCH` → refuse to start).
- [x] `ceiling.ts`: token ceiling (from the session log usage projection), turn ceiling, wall-clock ceiling, and a **no-progress detector** (identical NDJSON `status` fingerprint or an unchanged git tree hash across N steps); on breach, `terminate()` escalates: SIGTERM process group → SIGKILL → `docker kill` → orphan sweep by session id.
- [~] `container.ts`: `factory-env` image (Node 22 + `dsh` + git, no shell history, non-root user), run with `--network` restricted to the credential-proxy host, one bind mount (`attemptDir`), read-only root FS, no host `HOME`, no `DSH_HOME` of the operator, `no-new-privileges`, pids/memory caps. `docker/factory-env/Dockerfile` committed with the base image digest pinned.
- [x] `fake.ts`: `FakeExecutor` producing deterministic receipts from a fixture script (supports the sabotage, unfaithful-receipt and hang scenarios the wall/e2e tests need) — the whole suite runs with **zero model calls** (C5).
- [x] `fixtures/fake-dsh/`: a stub executable that emits a valid NDJSON sequence (including a hang case and an error case) so `HeadlessExecutor` is testable without DSH or credentials.
- [~] Tests: NDJSON parser against the fixture; ceiling detection for token/turn/wall-clock/no-progress; kill-switch reaches a child that spawned a grandchild; receipt captured for exit 0 **and** exit 1; overlay contains no secret; `@docker`: the container cannot read `~/.factory/holdout`, the operator home, or `BIFROST_API_KEY`; `@docker`: bind mount is the only writable path.
- [x] `scripts/provision-dsh-home.sh`: creates `~/.factory/dsh-home/{worker,evaluator}`, initialises the custom profile once with `dsh --profile factory-worker --from-default-profile headless` (composition order: bundles → profile patch → home patch → `--patch`), writes no home-layer MCP or third-party plugins, and prints the exact `DSH_HOME` values for the runbooks.
- [x] Activation assertion: the adapter fails the attempt if DSH prints `did not activate` (a degraded permission service must never be a warning in unattended mode).
- [~] `progress.md`: evidence for parser, ceilings, kill, receipt and the `@docker` leak tests.

## Delegation plan

Two parallel scopes:

- **Agent A (`adapter-runtime`)** — `headless.ts`, `ceiling.ts`, `fake.ts`, NDJSON + ceiling tests.
- **Agent B (`isolation-builder`)** — `worktree.ts`, `container.ts`, `Dockerfile`, provision script, `@docker` leak tests.
  Shared frozen surface: `port.ts` + `packages/contracts` (Lead-owned).

## Verification

### Hard Gates (copied verbatim from `done-means-done/phase-09-implementation.md`)

- [ ] **Scope fidelity**: every IN-scope deliverable in `phased-plan.md` is represented by at least one merged/committed change. Nothing OUT-of-scope was implemented.
- [~] **User-story coverage**: every P0 story from `user-stories.md` has a code path that fulfils its acceptance criteria. Evidence: story ID referenced in commit messages, code comments, or `progress.md`.
- [~] **Architecture adherence**: implemented component boundaries match `architecture.md > ## Components`. Deviations were negotiated and recorded in `progress.md`.
- [x] **Tech-guide adherence**: versions, conventions, and dev-env commands match `tech-guide.md`. Deviations recorded with rationale.
- [ ] **Subagent delegation used where required**: any phase with 2+ independent tasks dispatched parallel agents; delegation table in `phased-plan.md > ## Delegated Work` shows statuses and results.
- [ ] **Error log is clean**: `progress.md > ## Errors` has no open errors. Every entry is either `resolved` with resolution, or tagged `accepted_risk` with a user sign-off line.
- [~] **3-strike protocol respected**: no task shows 3+ repeated identical failing attempts. Every failure has a mutation entry.
- [~] **Mid-phase volatile decisions debated**: every decision made during Implementation that falls into a Volatile Decision Category (LLM/model, AI SDK, third-party API/service, datastore swap, framework version bump, dependency major, architectural pattern change, auth strategy, data contract, deploy/CI pattern, observability) has a Mode B decision brief in `docs/planning/decisions/`, a `/debate` outcome recorded in the brief, and an entry in `docs/planning/decisions/INDEX.md`. No silent adoption.
- [x] **Secrets hygiene**: no secrets in code, commits, or planning files. `.env` present in `.gitignore` if used.
- [x] **Build succeeds**: canonical build command from `tech-guide.md` runs to success locally. Output pasted or linked in `progress.md`.
- [x] **Lint clean**: canonical lint command runs clean. Output linked.
- [x] **Type-check clean** _(typed languages)_: type-check runs clean.

### Project-specific evidence

- [x] `pnpm --filter @factory/dsh-adapter test` exits 0 offline; the NDJSON fixture drives a full `start → observe → collect` cycle with no DSH and no credentials.
- [~] Kill-switch test: a fake worker that spawns a grandchild is fully reaped (`ps` shows nothing after `terminate()`), evidence pasted in `progress.md`.
- [x] Receipt test: exit-1 run still yields a diff + commands + full-suite output; the receipt's `narrative` field is absent from `DecisionInput` (typecheck demonstrates it).
- [~] `@docker` leak test: worker container cannot read `~/.factory/holdout/**`, `$HOME/.dsh`, or `BIFROST_API_KEY`; it can write only under `/work`.
- [x] Version assertion: pointing the adapter at a mismatched `dsh` yields `DSH_VERSION_MISMATCH` and no dispatch.

## Acceptance criteria

An attempt runs in an isolated worktree inside a container, is supervised by harness-owned ceilings, can be killed including its orphaned children, and yields a content-hashed receipt captured from git rather than from the agent's claims — all provable offline, with a Docker-gated leak test proving the boundaries.

## Risks / notes

- **DSH has no per-invocation model/sandbox/approval flags** (research D2). The overlay generator is therefore load-bearing: if a future DSH renames a config row, this phase breaks first. Keep `profile.ts` the single place that knows DSH YAML.
- Unattended `ask` mode fails closed (D3): the adapter must never depend on an approval being answered, and must not silently fall back to `danger-full-access`.
- The installed DSH (`0.2.1-rc.3`) and the checkout (`0.2.1-alpha.4`) may differ; the version assertion is deliberately strict so the failure is loud.

### Phase 9b — completion evidence (2026-11-01)

`dsh-adapter 130 — overlay/NDJSON/watchdog/clone/home, egress negatives blocked **and** proxy reachable by name; runs with no `dsh`and no`BIFROST_API_KEY``.

Full gate output, per-package suites and the four never-regress controls: [`evidence/phase-9-implementation.md`](evidence/phase-9-implementation.md). Whole-tree gate at close: `verify: 6 passed, 1 skipped, 0 failed` — `972 passed | 10 skipped (982)`.

**Unproven (audit 2026-11-01):** 19 there is no `port.ts` (the `Executor` types live in `executor.ts`); 24 the `factory-env` image was not built on this host, so the container's properties are unverified; 27/62 the `@docker` leak assertions are skipped without Docker; 30 the parser/ceiling/kill evidence is in the adapter's own suite, not a pasted transcript; 60 the grandchild-reap proof is a passing test, not a pasted `ps`.
