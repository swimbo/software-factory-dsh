# Progress — Dark Software Factory on DSH

> Session log, decisions, test results, errors. One entry per working session.
> Errors are logged with the 3-strike protocol: diagnose → alternative → rethink → escalate.

## Session 1 — 2026-11-01

**Context:** fresh session in `/Users/bo/code/software-factory-dsh` (branch `codex/phase9d-qualification`). Prior repo state: Path-A factory (OpenHands + Restate + Bifrost) with an uncommitted Phase-9d qualification follow-up under `docs/verification/harness-qualification-2026-11-01/`.

### Scope decisions (user, 2026-11-01)

User confirmed scope on 2026-11-01. The four answers, verbatim in substance:

1. **Deliverable** — "Planning artifacts + full implementation".
2. **Architecture base** — "Clean-room on DSH packages" (not a fork of the prototype, not a Restate-spine retrofit).
3. **Implementation location** — "Separate new checkout/repo" → `/Users/bo/code/dark-factory-dsh`.
4. **Model routing** — "Fixed: DeepSeek models only via existing Bifrost".

No further scope change was requested after Phase 2 findings were summarised. Phase 2's user-review gate is therefore satisfied by the scope-negotiation exchange: the pain-point researcher's counter-evidence (Mergify 153k-merge dataset showing AI-assisted PRs break `main` _less_ often; simonw walking his claim back; EvalGen criteria drift) was raised and the user kept the deliverable unchanged, so the plan was re-justified on verification-surface grounds rather than on "AI code breaks things".

### Environment snapshot (captured before planning)

```
cwd                      /Users/bo/code/software-factory-dsh
branch                   codex/phase9d-qualification
git status               M docs/verification/harness-qualification-2026-11-01/{report.md,source-binding.json}
                         ?? 7 untracked evidence files (mid-flight qualification follow-up — NOT settled)
remote                   origin = github.com/swimbo/software-factory-stapled
node                     v22.23.3  (~/.local/opt/node/bin/node)
pnpm 10.33.0 · npm 11.21.0 · python3 3.11.6 · git 2.50.1
docker                   29.8.2 (OrbStack sockets present)
dsh                      0.2.1-rc.3 at /Applications/DeepSeek Harness.app/Contents/Resources/runtime/cli/bin/dsh (NOT on PATH)
checkout                  /Users/bo/code/deepseek-harness/deepseek-harness = 0.2.1-alpha.4
brew node                 25.8.1 installed; 26.12.1 stable
listening                 DeepSeek GUI :65107 · ollama :11434 · postgres :5432 · python :8787
credentials               BIFROST_API_KEY / DEEPSEEK_API_KEY absent → live model calls UNVERIFIED
target repo               /Users/bo/code/dark-factory-dsh does not exist yet
```

### Delegated work (Phase 1–6)

| Agent                    | Task                                                  | Result                                                                                                                                                        |
| ------------------------ | ----------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `dsh-repo-researcher`    | DSH runtime + `dsh-superagent-prototype` architecture | `research/dsh-architecture.md` (621 lines) — verdict: DSH is the worker layer, not the factory; ACP is the richest seam; isolation is the biggest gap         |
| `existing-state-auditor` | Prior repo/plan/verification audit                    | `research/existing-state.md` (558 lines) — corrected three premises (qualifier does not exist; gate service has no callers; `recordReceipt` throws by design) |
| `pain-point-researcher`  | Phase 2 pain-point research                           | `research/pain-points.md` (214 lines, 42 sources / 10 platforms, themes T1–T8, requirements R1–R7)                                                            |
| `kickoff-researcher`     | Phase 5/6/10 kickoff research                         | `research/kickoff-research.md` (395 lines, 56 source URLs, registry-verified pins)                                                                            |
| `spec-writer`            | `data-map.md` + `user-stories.md`                     | in progress                                                                                                                                                   |
| `experience-writer`      | `ux-plan.md` + `ui-plan.md` + `e2e-tests.md`          | in progress (steered mid-run: Playwright cannot drive a CLI)                                                                                                  |
| 5-persona workflow       | Architecture Mode A debate                            | in progress → `consensus-plan.md`, `evidence-ledger.md`, `debate-transcript.md`                                                                               |
| `phase-plan-author`      | `phase-1..8,10..14` plan files                        | in progress                                                                                                                                                   |

### Verification performed this session

**Toolchain actually installed and executed** (not assumed) in `/tmp/stacktest` on Node v22.23.3:

```
npm i -D typescript@7.0.2 vitest@5.0.5 tsx@4.23.15   → exit 0
npm i zod@4.6.7                                      → exit 0
npx tsc --version                                    → Version 7.0.2
npx vitest run                                       → 1 test passed (v5.0.5)
npx tsx a.ts                                         → "tsx ok 2"
node -e 'zod parse'                                  → ok
```

**`node:sqlite` smoke test** (Node 22.23.3):

```
PRAGMA journal_mode=WAL / synchronous=FULL / busy_timeout=5000  → ok
BEGIN IMMEDIATE + INSERT + COMMIT                               → ok (1 row)
select sqlite_version()                                         → 3.51.3
typeof db.backup                                                → undefined   (RC-only API)
ExperimentalWarning: SQLite is an experimental feature           (expected on Node 22)
```

**Registry pins re-verified by the Lead** (`npm view <pkg> version`, 2026-11-01): typescript 7.0.2 · vitest 5.0.5 · tsx 4.23.15 · zod 4.6.7 · commander 15.0.0 · pino 10.4.0 · @playwright/test 1.64.1 · esbuild 0.28.2 · tsdown 0.23.4 · better-sqlite3 13.0.3.

### Decisions taken

| #   | Decision                                                                                                                                          | Recorded in                                |
| --- | ------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------ |
| 1   | Clean-room factory in **TypeScript on Node 22.23.3**, engine window `>=22.12 <27`                                                                 | `tech-guide.md` §1                         |
| 2   | **`node:sqlite`** behind a `SqliteDriver` interface; `better-sqlite3` is the one-file fallback                                                    | `tech-guide.md` §2/§10                     |
| 3   | `synchronous=FULL` + `busy_timeout=5000` are mandatory (WAL `NORMAL` gives up commit durability; default busy timeout is 0)                       | `tech-guide.md` §10, `architecture.md` §7  |
| 4   | Worker seam = **headless `dsh` subprocess**; ACP is the documented upgrade path                                                                   | `architecture.md` §2.2, §10                |
| 5   | **Playwright is browser-only** → CLI/process e2e on vitest + `child_process`; Playwright covers only the status page                              | `findings.md` Phase 10, `tech-guide.md` §5 |
| 6   | `dsh` resolution order pinned to the app-bundle path                                                                                              | `tech-guide.md` §6                         |
| 7   | Isolation: Docker for v1, **egress allowlist via credential proxy** as the real control; Apple Containerization documented as the microVM upgrade | `architecture.md` §7                       |

### Errors

| #   | Error                                                                                          | Attempts | Resolution                                                                                                                                                                         |
| --- | ---------------------------------------------------------------------------------------------- | -------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| E1  | `spawn_teammate(phase-plan-writer)` rejected: "subagent limit reached (active child limit: 8)" | 1        | Waited for researchers to finish; respawned as `phase-plan-author`. Status: resolved                                                                                               |
| E2  | `npm view` loop reported FAIL for all packages under `timeout 25`                              | 1        | Diagnosed: `npm ping` OK, single `npm view typescript version` → `7.0.2`. The wrapper, not the registry, was at fault. Status: resolved                                            |
| E3  | `npx vitest run --reporter=basic` → "Failed to load custom Reporter from basic"                | 1        | Diagnosed: `--reporter=basic` was removed in Vitest 5. Re-ran without the flag → 1 test passed. Status: resolved (recorded in `tech-guide.md` §3 so implementers do not repeat it) |

### 3-strike log

No task reached three identical failing attempts. E1–E3 were each resolved on the first mutation.

### Open items at the end of this session

- Architecture debate (Mode A) still running → `consensus-plan.md` not yet folded into `architecture.md`; `architecture.md > ## Debate Outcomes` is still a placeholder.
- Tech-guide debate (Mode A) must run **after** the architecture debate (skill sequencing rule).
- `data-map.md`, `user-stories.md`, `ux-plan.md`, `ui-plan.md`, `e2e-tests.md`, `phase-1..8,10..14` still being written.
- Human decisions outstanding: repo/remote name, `BIFROST_API_KEY` provisioning for `@live`, whether to upgrade Node to 24.9+/26.

### Deviations recorded (audit trail for the canonical hard gates)

| #    | Deviation                                                                                                  | Why                                                                                                                                                                                                                                                    | Where accepted             |
| ---- | ---------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | -------------------------- |
| DEV1 | All artifacts live under `docs/planning/dark-factory-dsh/` rather than `docs/planning/`                    | This repository already hosts a prior plan at `docs/planning/stapled-factory/`; a parallel plan needs its own directory, and `phased-plan.md` names both roots                                                                                         | `phased-plan.md` header    |
| DEV2 | Phase 3 kickoff research was **skipped**                                                                   | The datastore and durability model were already fixed by Phase 5 architecture + the report's prior art; running a search would have produced no decision change. The skip and its reason are recorded in `findings.md > ## Phase 3 (Data Map) Kickoff` | this line                  |
| DEV3 | The single canonical Phase 9 checklist is applied **five times** (9a–9e), not once                         | Implementation is deliberately split; every sub-phase file carries the full 12-gate list verbatim, so a gate is only satisfied when it is satisfied for the whole implementation                                                                       | `phase-9a..9e-plan.md`     |
| DEV4 | `phase-13-plan.md` enumerates **18** phase plans (13 + 9a–9e) rather than `phase-1 … phase-14`             | The plan was split; the audit must cover every file that exists                                                                                                                                                                                        | `phase-13-plan.md`         |
| DEV5 | Phase 7/8 cite `research/kickoff-research.md` instead of `research/ux-design.md` / `research/ui-design.md` | The bo-planner reference research files named by the skill are not present in this plugin installation; the kickoff research covers terminal UX, non-color redundancy and WCAG AA for the single page                                                  | `ux-plan.md`, `ui-plan.md` |

### Session 2026-11-01 (afternoon) — implementation 9a–9e

Environment resolved: implementation lives **in this repo** on `feat/dark-factory-dsh`, `origin` = `https://github.com/swimbo/software-factory-dsh`, old remote renamed `stapled`; project-local Node **26.12.1** via nvm (`.nvmrc`), `scripts/preflight.sh` verified (`preflight: node 26.12.1 ok` / `dsh 0.2.1-rc.3`).

Packages built, each with its own suite (all offline, no `BIFROST_API_KEY`, no `dsh` binary needed):

| Package                  | What it is                                                                                                                   | Tests               |
| ------------------------ | ---------------------------------------------------------------------------------------------------------------------------- | ------------------- |
| `packages/contracts`     | Canonicalization, error codes → exit codes, 16 ledger events, unit state machine, receipts, verdicts, lanes, **`status.v1`** | 121                 |
| `packages/store`         | SQLite store: append-only triggers, lease/cache/schema guards, `audit()` replay (never repairs)                              | 60                  |
| `packages/core`          | Engine: submit/qualify/run/observe/verdict/abort/recover, no auto-redispatch                                                 | 50                  |
| `packages/qualifier`     | Six signals, weighted score, lane derivation, **security lock (amendment A5)**                                               | 109                 |
| `packages/effects`       | Dispatcher: intent/outcome rows, in-drain dedupe, retryable vs exhausted                                                     | 28                  |
| `packages/wall`          | Holdout re-execution, Δ, faithfulness, signed verdicts, criteria log                                                         | in flight (slice 2) |
| `packages/gates`         | Promotion signing, budget phrases, credential broker, no bypass flags                                                        | in flight           |
| `packages/dsh-adapter`   | Five-entry overlay, NDJSON, watchdog, executor, container contract                                                           | in flight           |
| `apps/cli`, `apps/panel` | Operator CLI (ux-plan) and read-only status page (ui-plan)                                                                   | in flight           |

### Decisions taken this session (with the reasoning that must survive)

1. **Store refusal surface widened to `ErrorCode`** — the frozen union listed 9 codes while the store legitimately raises `SPEC_INVALID`, `GATE_REQUIRED`, `PROMOTION_UNSIGNED`, `VERDICT_FAILED`, `VERDICT_UNKNOWN`, `INTERNAL`. A narrower type would have pushed real refusals into `as` casts.
2. **`node:sqlite` shim deleted** — `driver.ts` now imports `DatabaseSync as Database`, so the `.d.ts` that declared the missing alias is unnecessary. Fewer files lying to the type checker.
3. **`insertVerdict` outcome→state coupling fixed** (fail → `rejected` with the wall's coarse codes in `terminal_reason`; unknown → row kept, state untouched, `VERDICT_UNKNOWN` raised _after_ the transaction commits so the evidence is not rolled back). Before the fix a measured fail was unrecordable and an unknown falsely verified.
4. **`insertPromotion` now refuses to force `promoted`** from an unverified unit — the same bug class, caught in review rather than by a test.
5. **Qualifier rulings**: missing observability oracle ⇒ `reject` (documented, not `unknown`); the restate check is a Szymkiewicz–Simpson overlap ≥ 0.5 rather than a hash match.
6. **Security lock (A5) implemented as a lane lock, not a seventh signal** — a weighted signal can be outvoted by six passing ones; a lock cannot. It can only demote, and that is tested in both directions.
7. **`consensus-plan.md` §A4.2 is wrong, not the code**: out-of-scope paths are `scope_violation`, so a verdict reader can distinguish "the receipt misrepresented reality" (`receipt_unfaithful`) from "the change went where it said it would not". Recorded in `findings.md > ## Post-debate rulings`.
8. **`promotionRequiresHumanSignature` is a flag, not a reason code** — a reason would flip a verifying verdict to `unknown`, which contradicts "the unit may still verify but its class is not certifiable".

### Known-red at the time of writing (owner mid-edit, not a regression)

`packages/wall/src/criteria-log.test.ts` (×3) and `packages/dsh-adapter/tests/*` (×1) fail while their owners implement amendments A3/A4/A6/A10/A13/A14. Repo-wide: **628 passed, 4 failed, 36 skipped**. The combined gate is re-run at merge; no suite is accepted on a red run.

### Human decisions outstanding (blocking implementation gates)

1. Repo path/remote for `/Users/bo/code/dark-factory-dsh` (local-only vs GitHub remote).
2. `BIFROST_API_KEY` provisioning for the opt-in `@live` smoke test — everything else runs offline.
3. Whether to upgrade Node to 24.9+/26 (plan currently assumes staying on 22.23.3).

### Close-out status (2026-11-01, end of implementation session)

**Green:** typecheck (repo-wide, strict), `test` — 51 files, **934 passed, 4 skipped**, `build` (259 files). Suites proven under both hard constraints: no `BIFROST_API_KEY` (nothing reads it) and no `dsh` on PATH (dsh-dependent tests skip themselves; 925 passed / 13 skipped).

**Red, and why (configuration, not code):**

1. `lint` — no `eslint.config.*` exists and `eslint-plugin-import-x` (named by `tech-guide.md` §56) was never installed and cannot be (no network). The gate was declared but never runnable; the config must be written against installed plugins only, or §56 amended.
2. `format:check` — no `.prettierignore`; 1326 files, dominated by `stapled-factory/worker/.venv` (353 MB, 17,074 vendored files). With a correct ignore, **281 project files** remain unformatted. A `--write` pass was deliberately not run while five agents were mid-edit.

**Phase 10:** `e2e/` landed — 44 specs (38 `@default`, 4 `@docker`, 2 `@live`) at the process boundary, no `dsh`, no key; 25 of the plan's 53 ids are asserted, the rest blocked by the missing executor seam and two exit-code divergences recorded in `e2e-test-findings`. The CLI, engine, store and wall it would drive are all green, so this is the next item of work, not a blocker on any of them.

**Findings worth carrying forward** (all in `docs/verification/2026-11-01-dark-factory-dsh/report.md`): `test:docker`/`test:live` are dead flags (nothing reads `FACTORY_TAGS`; docker tests gate on `dockerAvailable()`, so they run in the default suite); a green `build` is not a green typecheck (`tsconfig.build.json` excludes tests and `e2e/**`); and **the whole tree is uncommitted** — `HEAD` is the previous plan's tip, so no verification record can be reproduced until this is committed.

### Last fixes of the session (evidence)

- **`status.v1` reconciled with `status --json`** — the e2e suite found the CLI emitting a payload its own contract rejected (`factory.wallVersion: null`, `units[].lane: null`, absent `ambiguity`, `outbox.pending: null`, and a fourth health state `unknown`). Fixed on both sides: the schema now says `null` for an absent wall/lane/count, and the CLI uses the three-state health vocabulary (`unavailable` / `degraded`) instead of inventing `unknown` for a subsystem. The pinned `it.fails` was promoted to a **live assertion** and passes.
- **Whole-tree gate:** `typecheck` clean, `972 passed | 10 skipped (0 failed)` across 59 files including `e2e/`.

### Round 2 — the gate closed, the tree committed (2026-11-01)

`scripts/verify.sh` → **`verify: 6 passed, 1 skipped, 0 failed`** (preflight, typecheck, lint, format:check, test, build; `live-model` skipped without `BIFROST_API_KEY`). Suite: **`972 passed | 10 skipped (982)`** across 59 files. Committed as `501da5d` on `feat/dark-factory-dsh`, so the verification record now names a tree that can be reproduced (`git.head` in `summary.json` is finally meaningful — finding F4 closed).

**The two configuration reds are gone, and neither was hidden:**

- `lint` — no `eslint.config.*` existed, `eslint-plugin-import-x` was never installed, and the decisive fact: **`typescript-eslint@8.72.1` refuses to load under `typescript@7.0.2`** ("typescript-eslint does not support TS 7.0"), whose flat config also needs `jiti`, unavailable offline. A gate that exits 2 forever is not a gate, so `pnpm run lint` now runs `scripts/discipline-lint.sh`: seven deterministic checks — no unjustified `@ts-expect-error`, no `as any` outside tests, no `.only`/`.skip`, no `eslint-disable`, `Date.now()` only at allowlisted clock sites, `process.env` only at composition roots, no `@deepseek-ai/*` outside the adapter. Allowlists are reviewed paths, not mute buttons. `tech-guide.md` §56 amended with the reason and the revisit condition.
- `format:check` — `.prettierignore` added (vendored venv, `dist`, previous plan tree); 299 project files formatted in one pass; repo-wide check clean.

**Per-phase evidence attached:** `evidence/phase-9-implementation.md` (gate output, per-package suites, the four never-regress controls, and what Phase 9 does **not** prove), linked from the Verification section of every `phase-9x-plan.md`.

### Round 2, continued — the wall is callable now

`createLocalRunner` landed in `packages/wall` (135 passed / 3 skipped, self-test 9/9): a non-container `ScenarioRunner` that runs one scenario in a private temp copy with a wall-clock timeout, captures exit code and stream hashes, parses the `FACTORY_SUMMARY` line, and **kills the process group** on timeout. It refuses `requires: 'container'` and `network: 'none'` with a typed refusal that the wall classifies `unknown` — never a pass, never a fail against the candidate. Verdicts it produces self-label `+local` in `wallVersion`, derived from `runner.kind`, so a caller cannot forget.

**The bug it exposed is the important part:** `runForMajority` was _rebuilding_ the run input and forwarding only `baseRev/patchFile/argv/timeoutMs`, which silently dropped **`testRootFrom: 'base'`** — the field amendment A6 depends on for "the wall owns the oracle". The A6 code was correct and the instruction never arrived; the container tests could not see it because their fakes ignore the field. Fixed by forwarding the input, with the refusal test as the red-then-green. This is the second time a control was right in isolation and unreachable through its caller (the first was `run` never calling `evaluate()` at all), and it is the reason the end-to-end spec is being written to use the **real** wall, not the fake.

Whole-tree gate after the change: `982 passed | 10 skipped`, typecheck clean.

### Round 4 — the audit, and the outbox that lied (2026-11-01)

Phase 13's audit (`phase-13-audit.md`) is the first document that measures the repo against its own claims, phase plan by phase plan: **6 met, 9 partly met, 3 not met** at first pass. It then reconciled all **469** task boxes — 246 `[x]`, 111 `[~]`, 112 `[ ]` — where a box counts only with nameable proof, and every `[~]` names the proof it lacks on one `Unproven (audit 2026-11-01)` line at the end of its plan.

**The worst finding was not a missing feature.** `runUnit` commits a `launch` effect and launches nothing; `factory run` performed the launch inline and never settled the row. Every run left a permanent pending effect, the outbox grew forever, `recover` had nothing to retry, and the engine comment promised a crash-retry path that no code implemented. Fixed in `bf24f6a`: a settlement vocabulary keyed on _did the worker start_ (`applied` — including `ATTEMPT_AMBIGUOUS`, because retrying would ask a second process what the first did; `retryable`; `exhausted`), a claim before anything happens, `recover` performing a pending launch under five guards with the lease as the double-launch guard, and the attempt state required to be `launching` so an attempt that was already running is never relaunched — the property that keeps the kill-9 spec honest.

**Two more of the same class surfaced and closed:** `--no-wait` was dead (the code read `options.noWait`, commander sets `wait === false`), so a documented "dispatch and return" ran the full pipeline to a verdict — fixed at the key, its deferral promise now true, and the `it.fails` flipped to a plain test as the proof. And `render/status.ts` told the operator the store exposed no read-only outbox count, which was false; it now counts.

**Three failures in one run were contention, not bugs**, and that was proven rather than assumed: every failure was a timeout, the stage took 2.3× its uncontended duration, and `ps` showed a second vitest from another agent's turn. Two consecutive unopposed runs pass identically. **No timeout was raised to make it true** — the difference between fixing a gate and teaching people to re-run it.

Also this round: one receipt identity (`receiptShaFor`) so a narrative can no longer buy new evidence; E2E-29 committed (sabotage rejected through the real pipeline, Δ measured 1 → 0, anonymised holdout scenario); `NEEDS_HUMAN_DECISION` populated with ND1–ND4 and the claim each blocks; six dead citations to research files that never existed removed; README rewritten, including the six things this repo deliberately does not build.

### Round 5 — the ceiling, the launch record, and the fence (2026-11-01)

**IN #5 exists now, as a refusal rather than a scheduler.** `maxConcurrentAttempts` and `maxConcurrentWalls` (both 1 by default, operator-set at the composition root only, so a worker cannot move its own ceiling) make a second dispatch exit **7** `CONCURRENCY_LIMIT` _before_ `runUnit` — no attempt row, no lease, no reservation, no attempt directory. Two judgement calls carry their own specs: `ambiguous` is **excluded** from the in-flight count, because counting it would let one `kill -9` stop the factory forever; and a unit never counts itself toward the wall ceiling (the first version refused its own measurement). No queue, no fairness, no priorities — a queue is a promise about _when_ work happens and nothing here keeps it.

**E2E-33 closed at the source.** Every launch writes `launch/1` — argv, cwd, `mountedAt`, `dshHome`, the profile **read back** from the seeded home (two profiles ⇒ `null`, not the requested name), the overlay's actual byte hash, and the child's env **keys with hashed values** plus an explicit `dropped` list. Building the record found a real leak: `FACTORY_HOLDOUT_ROOT` and `FACTORY_PRISTINE_REPO` were riding into the worker's environment under the old "all `FACTORY_*` except credentials" rule. The allowlist now refuses credential- and path-shaped names **by category**, so that leak is closed by construction rather than by remembering.

**Recorded rather than smoothed:** IN #6's no-progress detector is not built — it needs step-level signals DSH owns — so its e2e id is withdrawn and `README.md` says so in the same list where it says what _is_ built.

Counts: `verify: 6 passed, 1 skipped, 0 failed`; `1117 passed | 6 skipped (1123)` across 78 files; e2e ids **45 closed of 53**, 8 open and each with a reason (`@docker` worker path, `@live` key, the proxy-token clauses). Pushed as `8711cbc`.

### Round 6 — the live layer, and the five defects a real run exposed (2026-11-01)

The operator provisioned a Bifrost program key (endpoint `https://hermes-control.tail…/openai/v1`,
header `x-bf-vk`, model `auto`, key held on `hermes-control` 0600). The claim that had been
`UNKNOWN` since Phase 11 — "DeepSeek via Bifrost" — is now **measured**: both `@live` specs pass, real
turns, real usage, and the full gate with the live stage is `7 passed, 0 skipped, 0 failed`
(`docs/verification/2026-11-01T18-23-07Z/`).

Getting there was not a wiring exercise. **Five defects, each invisible to the offline suite, each
found by a paid run:**

1. The wall replayed `receipt.commands[0]` — the worker launch itself. Replaying it starts another
   worker; on a live attempt that spends money.
2. The first fix replayed nothing (`0 of 8`), so every real attempt was `unknown`, and by L3 a real
   worker could never produce a promotable unit. A gate that can never open is not caution.
3. Two `git status` reads were claimed replayable while their output depends on untracked/ignored
   worktree contents — unreconstructable from a commit. Now unreplayable-with-reason: `replayed 5 of 8`.
4. The scope row printed `2 mismatched` while carrying `outcome: pass`.
5. The live spec's oracle finder matched the word "suite" **inside the prompt**, which is an argv
   element of the launch — so the assertion executed `dsh` a second time: a paid model call made by a
   test. It failed only because that second launch exited non-zero.

Plus two specs that were measuring the developer's shell rather than the code: `help.test.ts` asserted
`dshVersionObserved` was `null`, and `profile.test.ts` inherited `process.env` to prove a fresh
`DSH_HOME` fails closed — both went red the moment a real key and `DSH_BIN` were exported. Both now
control their own environment.

**Design decisions recorded rather than smoothed:** the wall decides the verification class (a receipt
must not be able to keep the gate shut by declaring itself unreplayable — L2); `FACTORY_LIVE_MODEL=1`
forwards exactly one credential **name** because v1 has no credential proxy (ADR-006 amendment); the
live gate stage is opt-in (`FACTORY_VERIFY_LIVE=1`) because each run spends.

**Measured, for the record:** the first genuine unit verified by this factory — `outcome: pass`,
`reasons: []`, `replayed 5 of 8`, `0 mismatched`, holdout discriminating, CLI exit 0, ~8.5–12.7k tokens
per run, `wall/0.1.0+local`, `fakeWall: false`.

### Round 7 — the container's orphan, and the repo's own account of itself (2026-11-02)

The previous session landed four commits after `v0.4.0` and then stopped: alerts (`59a18fc`), the ND3
spend ceiling through the real executor (`3c8e063`), the worker's container (`36e2ddd`), and anchor
read-failure exit codes (`f362900`). No release, no evidence file, and a runbook citing
`evidence/phase-15-round.md` — a document that did not exist. This round finished it.

**The gap the last commit named is closed.** `36e2ddd` ended by saying a `SIGKILL`ed control plane can
orphan its worker container "because the sweep runs in the launcher that died", and that closing it
needed a `recover`-side sweep. `recover` now sweeps exactly the attempts *it* reconciles to `ambiguous`:
it reads that attempt's `launch.json`, confirms it names the same attempt, and removes containers
labelled `org.factory.attempt=<attemptId>` — never by image, never by a bare label, never while the
lease is live, never for a `container: null` record. `swept` with `removed: []` is only reachable when
the daemon answered; everything else is `skipped`/`failed` with a reason and a `checkCommand`, in the
text and as `sweeps[]` in `--json`, and the exit code stays the ambiguity's. `e2e/cli/docker/09-…`
SIGKILLs a real control plane, asserts the orphan is **still listed** (positive control), then asserts
it is gone after `recover` exits 4; deleting the sweep call leaves the container behind and reddens it.

**A second honesty defect, found by reading rather than by running.** `E2E-46` was already the
cgroup-limits spec; the new spec had been filed under that id too. A follow-up commit re-labels it
E2E-45's **orphan-sweep clause**, which is where the plan's own acceptance column puts it ("orphan
sweep recorded"), and records the one deliberate difference: a container's identity is the attempt
label, not the plan's session id / process group.

**Two documents had stopped describing the tree, in opposite directions.** `README.md` claimed
`packages/proxy` does not exist and privileged work is merely refused — false since the broker landed,
and contradicted by the same file's ADR-007 paragraph three paragraphs later; it also listed seven
packages when there are eleven and carried counts two versions old. `docs/handover.md` described a
v0.4.0-1 tree: panel "deliberately absent" from the gate (it is stage 7 and **fails** without a browser),
`@docker` suites "always skipped" (they self-gate and run), no credential proxy, no anchor, no worker
container. Both are now written against the tree, sentence by sentence, with the command that settles
each. `docs/adr/006`'s stale statements are marked _superseded_ rather than rewritten — the 2026-11-01
belief survives verbatim, and a 2026-11-02 amendment states what is true — and `docs/adr/008`'s link to
an ADR that never existed is fixed.

**The gate was red twice before it was green, and both runs are kept.** The previous session's last run
(`2026-11-01T22-41-51Z`) was red in `test`, `build` and `panel`. This session's first run
(`2026-11-02T16-16-14Z`) was red **only** in `panel`, because every Playwright browser had been removed
from the host's cache; `npx playwright install chromium` restored `chromium-1248`. The released tree
(`edf3b1a`) is `7 passed, 1 skipped, 0 failed` (`2026-11-02T16-44-03Z`), test stage **1395 passed, 7
skipped (1402) across 99 files**, with the 11 `@docker` specs all running (0 skipped) once
`factory-env:rc5` was rebuilt. The soak was re-run for the record: 50 units, 6 incidents, all runbook
steps and invariants held, zero paid calls.

**Not re-run here, and labelled as such:** the paid `@live` layer (no key in this shell) — the last
recorded live gate is `8 passed, 0 skipped, 0 failed` at `6a398cc`. Full list of what is still not built
is in `evidence/phase-15-round.md` §8.

### Round 8 — the broker's dead end, and the two refusals that replaced a mystery (2026-11-02)

**R5's allow path exists, and a decision is single-use.** `factory gate request` is read-only and prints
the operation, its hash, the payload and a `decide` line with **both timestamps pinned** — they are
inside the signed content, so a payload signed at T and re-dated fails closed (measured: exit 5,
`…for payload sha256:643d235c…`). `factory gate decide` verifies the operator's signature against the
promote key lookup order and writes the `gates/<id>.json` artifact plus one `privileged.decided` event;
the tool never signs, and `--signed-by` is an echo checked against the key id because a name would be a
string the worker could assert (L1). Schema **v4** adds `privileged_decisions`: consumption is one
conditional `INSERT … ON CONFLICT DO NOTHING`, so two processes cannot both read "unused" — the
per-invocation memory registry that shipped before this round allowed exactly that replay.
`e2e/cli/default/19-gate-decisions.test.ts` proves the three runs (refused → authorised exactly once →
replay refused) and `docs/runbooks/brokered-operations.md` is the operator's transcript.

**What a decision does not buy is now written down.** The wall is not a consumer: it measures a
candidate with no decision in hand, so it refuses a privileged argv at replay and the verdict carries
`privileged_unbrokered`. That code names the replay, not the operation. It was not renamed:
`WALL_REASON_CODES` is a closed enum, so a rename would make every stored verdict carrying the old
string unparseable — breaking the evidence it describes. The doc comment, README and
`evidence/phase-16-round.md` §1 say which claim the code makes; threading decisions into the wall is a
design change with its own trust surface, listed as next round's item.

**Container isolation by default was withdrawn, then replaced by something better.** The proxy binds
`127.0.0.1` and the worker container runs `--network none`, so the two cannot be combined; defaulting
the container would have made the live layer unusable by default, and until this round the combination
failed *after* the worker started as an unexplained 401. The probe now refuses it before anything is
reserved: exit 8 **`CONFIGURATION_CONFLICT`**, distinct from `CONTAINER_UNAVAILABLE`, naming both levers
and both ways forward. Making the container the default now has a named precondition — a transport that
survives `--network none`.

**`factory alerts --notify` reaches a person, without changing an exit code.** One macOS notification
via `osascript` (text passed as argv, never interpolated), or exactly one bounded POST of the same
`alerts.v1` JSON when `FACTORY_ALERTS_WEBHOOK_URL` is set, redirects refused, the URL reported as
scheme+host only. Off by default; a delivery failure is visible and cannot change `0`/`8`/`9`. Nine
mutation checks in its suite each turned one named spec red.

**Two specs were killing each other's containers.** The round's first gate run was red in `test` for a
reason that had nothing to do with the product: E2E-45 found its container by
`--filter name=factory-worker-` and killed the first match, which under `maxWorkers: 4` was the egress
spec's. Discovery is now by the launcher's `org.factory.attempt` label with an ownership assertion
before the kill, and the proof is a deterministic decoy (old filter kills it; new filter leaves it
`Running`). Both red runs are kept: `2026-11-02T22-57-34Z` and the hand-cleaned green
`2026-11-02T23-06-42Z`.

**Released tree:** `7 passed, 1 skipped, 0 failed`, test stage **1472 passed | 7 skipped (1479)** across
99 files, every `@docker` spec run (`docs/verification/2026-11-02T23-20-42Z/`), and the two disclosures
that matter (the operator's store migrated v3 → v4 by opening the CLI; one runbook transcript
re-spliced from a single capture because the first version quoted values from more than one run) are in
`evidence/phase-16-round.md` §6.

### Round 9 — the bridge was measured, and it does not exist here (2026-11-02)

**The container + live-model refusal stopped being an opinion.** `e2e/cli/docker/10-internal-bridge.test.ts`
measures both directions of the transport that was supposed to fix the conflict — docker `--internal`
bridge with the credential proxy bound to the gateway — and on this host the answer is no: the daemon
runs in an OrbStack VM, so the gateway (`192.168.107.1`) is not an address macOS can bind
(`EADDRNOTAVAIL`, absent from `os.networkInterfaces()`), and the internal network has no default route,
so every host address is `ENETUNREACH` — asserted as an error *kind*, because "no route" and "the proxy
refused" are different defects. The controls are there to stop the negative being vacuous: the same
internet probe from the default bridge `CONNECTED`, container→container on the internal network
`CONNECTED`, and the loopback proxy answering a real scoped-token request from a normal bridge (`401`
without a token, `200` with one). The spec's header says plainly that green means docker still behaves
as the runbook says, not that the combination works.

**The seam shipped without the transport.** `packages/credential-proxy` can bind a chosen address
(`boundAddress` reports what the kernel bound; an address the host does not own is refused with
`EADDRNOTAVAIL` in the message), and nothing calls it with a non-default yet — because building the
caller would have meant either code whose spec skips on the only machine this tree runs on
(native-Linux bridge) or moving the gateway key into a sidecar container, which is a different
credential boundary from ADR-007. Both are documented with their prices in
`docs/runbooks/worker-container.md` instead of being half-built.

**Three smaller things, each with a mutation check.** `privileged_replay_refused` is added to the closed
reason enum (the old string stays forever so stored verdicts parse; a spec pins a *literal* stored
verdict so the compatibility claim cannot drift). `postAlerts` and the Discord attempt both stop at
64 KiB and cancel the stream, naming the truncation, in a job that runs unattended at 04:00. And the
gateway key can live at `$FACTORY_HOME/secrets/bifrost-key`, read through the same open-then-`fstat`
rule as the alert webhook.

**A disclosure worth keeping.** While checking whether a key was available for the certification
round I tested `launchctl getenv … && echo set` — which exits 0 with empty output when unset — believed
it, wrote a 0-byte key file, and told the operator no key existed. It never was missing: it is on
`hermes-control`, `0600`, 43 bytes, read per command over SSH, exactly as the phase-9b evidence says.
Verified afterwards (`models` → 200), the empty file deleted, and the lesson recorded in
`evidence/phase-17-round.md` §4 rather than smoothed over.

**Released tree:** 7 passed, 1 skipped, 0 failed; test stage **1522 passed | 8 skipped (1530)** across
102 files, every `@docker` spec run (`docs/verification/2026-11-03T02-47-40Z/`), and the hazard from the
previous round is now written into the index: the same command reports `0 failed` with the docker
specs *skipped* when the daemon is not running, so read the skip count.

### Round 10 — the first class certificate, and the four defects it exposed (2026-11-03)

**The class was certified, live.** `docs-typo-fix` reached `samples=20 passes=19 outcome=certified`
in the operator's store (`cert:V-c81459fcb68a`, policy `sha256:1f052e46…`, model `auto`). Twenty
attempts ran against a real git repository generated from this project's own markdown — 20 revisions,
each carrying the class's five defects — with a hidden five-rule holdout corpus the worker never sees.
Seventeen consecutive passes in one driver invocation, then two more units on base revisions the log
had not yet judged. The one non-pass is an `unknown` verdict from my own configuration error, kept as
a non-pass instead of rounded away. Details and the full progression table:
`evidence/phase-18-certification.md`.

**Three of the four defects made a certificate impossible, and the fourth made one untrustworthy.**

- The CLI built the wall without a `criteriaLog` port, so every verdict counted as the class's *first*
  sample: twenty paid passes would have produced twenty `samples=1 … insufficient` rows. The package
  tests passed because they construct the port directly — the seam the CLI never used was the only
  thing untested.
- `audit --certifications` asked each verdict's `certification` field whether it had been judged, a
  field `mapVerdict` strips on purpose, so every verified unit was listed forever and the verb exited
  9 after an honest certification. It now asks the projection that holds the answer.
- A dispatch ceiling was a field of `QualifierPolicy` and hashed into the policy identity, so a loop
  that raised the attempt ceiling minted its certificate under a digest the default environment could
  never reproduce — `CERT_STALE` every morning for a perfectly current certificate. Ceilings now live
  in `OperatorLimits` and are hashed into nothing; a bounded recognition bridge keeps the pre-split
  row `current` without recomputing it.
- The criteria log recorded no policy or model identity, so one attempt under a new policy could count
  twenty revisions measured under the old one and mint a `certified` row for a policy that had measured
  one attempt. Entries now carry both, both counters filter on them, and the 240 pre-identity lines in
  the live log are `legacyLines` — never counted, and not corrupt.

**The driver measured one unit out of twenty, twice, before it worked.** The loop's stdin is the units
file, and two children inherited it: the per-run `ssh` key read and the worker itself. Both live
invocations reported `units-exhausted` with eighteen lines still in the file — a stop reason that reads
like an exhausted plan and was an eaten one. Fixed with `</dev/null` and the reason in a comment; the
offline proof could not have caught it, because its stub key command and scripted executor read
nothing.

**Cost is a token count, not a price.** 23 attempts, 6,419,027 input and 155,692 output tokens; per
attempt 120k–453k input. `cost_usd` is `null` on every usage row — there is no billing-grade telemetry,
so "under the $10 cap I set" is not something this store can prove, and the round records the numbers
it has instead. The old ~12.7k-token-per-unit estimate came from a single short probe and is wrong by
more than an order of magnitude for real documentation work.

**Released tree:** 7 passed, 1 skipped, 0 failed; test stage **1559 passed | 8 skipped (1567)** across
110 files (`docs/verification/2026-11-03T04-40-19Z/`).

### Round 11 — the certificate's other side (2026-11-03)

**β stopped being a shrug.** With `m=20, k=18` a class whose true pass rate is `p` is certified iff
≥ 18 of 20 attempts pass, so β(p) = P(Bin(20,p) ≥ 18) — arithmetic, not a corpus.
`certificationRisk()` computes it exactly in rational arithmetic beside the α it already published;
the refused tail at `p0 = 0.95` reproduces the ratified α digit for digit (`0.07548367378849634297`),
and the runbook's six-row table is the function's own output. It says something uncomfortable: a class
that truly passes 90% of the time is still certified **0.677** of the time. The operating point is a
floor on class quality, not a filter against mediocre classes.

**The arithmetic corrected me twice.** I expected `k = m` to give α = 0; it gives
`1 − 0.95²⁰ = 0.6415…`, because a truly-95% class fails at least one of twenty attempts about two
times in three — a stricter gate refuses more, it is not a safer one. And the exact printer silently
rendered a probability below `1e-20` as `0.000…`; it now prints `<1e-20`, so a vanishing risk can never
read as an impossible one.

**Detection is a count, decomposed by layer.** Five planted single-rule regressions are all refused;
three of them keep a green visible check *and* a green wall suite and are caught only by the hidden
holdout — those are the detections the corpus can claim — while two are also caught by the visible
check, so counting them as holdout evidence would overstate the claim. A two-rule regression is refused
with two failing rows, and a clean repair still passes. Deleting a rule from the corpus makes that
rule's regression pass, measured: the count is not vacuous.

**Both doc gaps from the paid run closed.** `FACTORY_MODEL_API=openai-completions` now appears where a
live run is set up, with its failure mode (wrong wire shape → our own proxy answers `401
unknown-token` → `unknown` verdict → that revision is a permanent non-pass in `samples`; it cost two
units). Plus: `samples` counts distinct base revisions judged, and a failed launch leaves the unit
`dispatched` — `recover` finishes a launch that never started, a person aborts one whose worker died.

**Also corrected in the record:** running `alerts` from a shell without the plist's anchor variables
reported `ANCHOR_MISSING`, and I read that as the daily job's state. It was not — with the agent's own
environment the run is `{"anchor":{"state":"fresh","scope":"off-host",…},"alerts":[],…}`, exit 0. Run a
scheduled job's command with the scheduled job's environment before quoting it.

**Released tree:** 7 passed, 1 skipped, 0 failed; test stage **1575 passed | 8 skipped (1583)** across
111 files.

### Round 12 — the second class, and the class that bites back (2026-11-03)

**`test-repair` is certified live:** `samples=20 passes=19` at `m=20 k=18`, corpus
`h-test-repair-real-2026-11-03`. `audit --certifications` → `2 of 2 classes current`. The second class
was not chosen for its pass rate but because its cheap repairs are *green* — weaken the test, rewrite
the expectation data, special-case the visible inputs — so its certificate only means something if the
holdout refuses those, and if the class is hard enough that a failure can occur.

**One attempt was refused, and that is the certificate's best evidence.** Revision 17's `normalisePath`
repair popped `..` correctly but preserved a *leading* `..`; the visible test never covers that input.
The corpus refused it on a scenario the worker could not see (`holdout 2 of 3`), and outside the wall the
same candidate fails 12 of 12 — deterministic, not corpus flakiness. Nineteen of twenty were honest
repairs; one was a plausible wrong one, and it was caught.

**Cost:** 188,665 tokens for 20 attempts (median 8,896, max 14,100) against 6.4 M for the docs class —
because the work is small. `cost_usd` stays `null`: there is still no billing-grade telemetry, so the
honest figure is a token count.

**Two of my own mistakes, recorded:** the first planner run was refused `RESTATE_BACK_MISMATCH`
(`restateOverlap=0.357` < `0.5`) because my restatement was too generic — rewritten to name the work,
`0.714`, and the twenty specs renumbered 101–120 so identities stayed unique (one rejected-lane unit
lost, never a sample). And the driver stopped mid-loop at unit 17 on `credential-unavailable` (the
per-run `ssh … cat credential` exited 255); the unit was not dispatched, nothing was burnt, the key read
was verified by hand and the loop resumed on the remaining three.

**Also this round:** the dead `research/existing-state.md` citation (66 links, file deleted deliberately
in `e538fdf`) now resolves to a tombstone stating that the claims are `UNPROVEN` here rather than
restoring a description of a system this repository no longer contains. And the residual attack on this
class is specified rather than smoothed over: a wrong fix correct on all tested inputs still certifies;
closing it needs a differential rule against the repaired module with inputs generated at measurement
time — one rule, one file per revision, no model cost, not built.

**Released tree:** 7 passed, 1 skipped, 0 failed; test stage **1596 passed | 8 skipped (1604)** across
115 files.

### Round 13 — identities, not names (2026-11-04)

**A correction first.** Round 12 called the refused `test-repair` attempt "a plausible wrong repair
caught by a probe". Re-measured, it was the opposite: the candidate preserved a leading `..` (what POSIX
`path.normalize` does), the reference drops it, and no visible case told the two apart. The class refused
a defensible repair for disagreeing with an undiscoverable convention — twice, with the same patch. A
gate the worker cannot satisfy from visible evidence measures the author's taste, so the fixture now
refuses to build unless every edge the base revision already answers correctly is a visible case (61
were invisible); and it is narrow on purpose, because making all 118 edges visible let the `bytes`
lookup-table cheat certify.

**Three identity defects, all the same shape.** (1) The corpus id was a date, so a rebuild minted
different rules under the same name while recency compared names — a certificate could read `current`
while naming evidence it never measured. (2) The certificate itself named no corpus at all (schema v5
now writes it from the verdict, with a strict backfill from each certificate's own verdict and `NULL`
reading as stale, never as a wildcard). (3) The generator emitted specs its own qualifier refused
(`restateOverlap=0.357` vs a `0.500` floor).

**Re-measured: 20 of 20**, `samples=20 passes=20 certified` under
`h-test-repair-real-2026-11-04-ffa87379`, 186,787 tokens for the loop. Both classes `current`, `alerts`
empty, anchor fresh. The differential rule compares candidate against the shipped repaired module on
44–52 seeded inputs per revision and reports them, which is why the claim is "agrees with the reference
on N inputs" and not "correct".

**Recorded, not built:** the docs class's corpus id is still a label (fix condition written down);
`wall.class_certified` carries neither corpus nor `p0`; and the corpus comparison can only see a corpus
move once something measures under it.

### Round 14 — the ledger carries its own evidence (2026-11-04)

**Closed the gap v0.9.1 named.** `wall.class_certified` now carries `holdoutRevision` and `p0`, so a
reader who trusts only the event log can prove *which corpus* made a class certificate true, and
re-derive the risk from the counts rather than take `alpha` on faith. Both fields are optional and
nullable: every ledger written before schema v5 omits them, and an event that refuses to parse is worse
than one with a documented hole — a missing corpus must read as "unknown, predates attribution", never
as "the current corpus".

**Proven the only way that counts:** a spec that records a certified verdict and then reads *only* the
ledger (no call to the certificate table) recovers `holdout/7` and `p0 = 0.95`; plus a literal
old-shaped event that still parses with both fields absent rather than fabricated. Mutation: deleting
the two fields from the write site reddens both specs (2 failed | 60 passed), restored green.

**The limitation of the fix, stated plainly:** the live ledger holds 84 `wall.class_certified` events
written before the field existed, and all 84 still read `corpus=ABSENT, p0=ABSENT`. The ledger is
append-only, so they will stay that way — this change is forward-looking, not a backfill, and a reader
of *today's* ledger still cannot attribute those two certificates from events alone (the certificate
rows can, via the v5 column and its strict backfill). The next certificate written will carry both
fields.

**Still open:** the docs class's corpus id is a label rather than an identity (fix condition recorded),
and nothing notices a corpus move until something measures under the new one.

### Round 15 — an alarm that means something (2026-11-05)

**Found in the log, not in a plan.** The 04:00 job on 2026-11-05 paged Discord with `anchor UNREACHABLE`
— `ssh: connect to host 100.92.236.42 port 22: Operation timed out` — and by 14:00 the same read was
fresh. One night in four. The alarm path worked perfectly on evidence that turned out to be nothing,
which is the failure mode that teaches people to ignore alarms.

**Two fixes, both in `commandTransport`.** Every off-host call is now bounded
(`ConnectTimeout=10`, `ServerAliveInterval=5`, `ServerAliveCountMax=2` — without them the job sat in
the kernel's TCP timeout for ~2 minutes), and a transport failure is retried up to 3 times before it is
reported. Only transport failures: a read that succeeds with unparseable content is a fact about the
file, so it refuses immediately. A persistent outage still pages at exit 8, and the message now says
`(retried 3 times)` so a flake and an outage are different lines in the log.

**Proven by three mutations:** no retry → both retry specs red; no `ConnectTimeout` → the timeout spec
red; retry everything → the garbled-anchor spec red (2/1/1 failed respectively), restored 33/33.

### Round 16 — the third class, and the honest answer (2026-11-06)

**Built `type-repair` and certified it 19 of 20.** Base revisions fail `tsc --noEmit` under strict while
behaving correctly; the cheap repair (cast/`any`/ignore/loosen) is green on the visible signal, which is
why the class looked like it could finally make the gate refuse a class. It did not: the model fixed
every measurable revision, at 10× the token cost (1,907,300 vs 186,787; median 59,046/unit vs 8,895).
The single non-pass was a 2 h 23 min worker hang, recorded `unknown` — infrastructure, not a wrong
answer.

**So the interesting number did not arrive.** Three classes certified, zero merit-based class refusals,
and `k = 18` still uncalibrated: β(0.9) = 0.6769 says a truly-90%-reliable class fails to certify about
a third of the time. Recorded in `evidence/phase-20-type-repair.md` rather than smoothed over.

**Three defects found by running it, not by reading it:** the generator's planner printed the loop
without submitting (so `units.txt` could not exist — fixed); `env.sh` carries the offline
`FACTORY_EXECUTOR=fake`, which a live loop must unset; and a missing worker profile leaves a live
45-minute lease on an attempt that never started, which `recover` will not touch and which stops a
re-run with `UNIT_ALREADY_TERMINAL`. Also: an `unknown` verdict from a transport failure cannot be
re-measured after the attempt directory is gone, and `samples` counts that unknown as a sample.

**One flake, recorded:** the first v0.10.0 gate run failed `apps/panel/src/dsh-version.test.ts` on two
specs that took exactly `PROBE_TIMEOUT_MS` (1,505 ms and 1,502 ms — the timeout, not a wrong answer):
the probe spawns a real `/bin/sh` script and under full-suite load on this machine it can miss a 1.5 s
budget. Re-run on an idle machine: 9/9 green, and the whole gate 7 passed / 1 skipped / 0 failed. The
flake is written down rather than smoothed: the probe cannot distinguish "timed out" from "no version"
and both are `null` by design, so a loaded machine makes two specs read as the wrong answer.

### Round 17 — the kill that did not end the attempt (2026-11-06)

**Diagnosed from the receipt, not from the symptom.** The `type-repair` loop lost one unit to a 2 h 23 min
attempt. The receipt settles it: `ceilings.wallClockMs = 8572243`, `ceilings.hit = ['wall-clock']` — the
15-minute ceiling fired and the group was killed, and then the adapter waited on a `close` event that
could never arrive, because a `setsid`-style grandchild had escaped the group and kept the pipes open.
Fixed with a bounded grace period that writes the receipt anyway and records `reapTimedOut: true`.

Also corrected a wrong claim I had written in `evidence/phase-20-type-repair.md`: I said the attempt
directory had gone missing (which would have made `--verify-only` useless); it had not — my `ls` was one
directory level off. The file now says what the receipt proves.

**Not built, and named:** a re-dispatch path for an `unknown` verdict, and a `worker_timeout` reason in
the wall so a timeout reads as one fact instead of five unknowns.

### Round 18 — the third class lands, and a number that was not what it looked like (2026-11-06)

**`type-repair` is the live store's third class.** Twenty units, twenty passes, `3 of 3 classes current`,
1.94 M tokens (median 95,775/unit, max 189,117). The earlier 19-of-20 in the dedicated store lost its one
sample to the 2 h 23 min hang, so the class has been measured twice and the wall has never refused a
class on merit.

**Then the arithmetic disagreed with the verdicts** — all twenty passed, the certificate says
`samples=20 passes=19` — and chasing that found the round's real defect: the criteria log was written
beside the corpus and shared by every store, so a certificate counted other stores' measurements. Here it
lost a pass; a store that ran ten units would have inherited ten more and certified on work it never did.
v0.11.0 scopes the log to the store (`<storeHome>/certification/audit/`) and adds the spec that would have
caught it.

**Still open:** `k = 18` uncalibrated (β(0.9) = 0.6769, no class has ever landed near the boundary), no
merit-based class refusal, a wall reason that names a worker timeout (does not exist), and the live
store's ~102 units that "need a person" — a backlog nobody has triaged since the docs class.

### Round 19 — the first real intent, and a verdict that outlived its unit (2026-11-07)

**The product claim ran against a repository for the first time.** One intent against this checkout
(`README.md:137`, the doubled word in the sentence that admits there is no progress-stall detector),
measured by a repo-scoped corpus, `V-c40f24ed88ac` → **pass**, 10,151 tokens. It took three submissions to
get there and the refusals were the interesting part: a pinned suite that printed prose is `unknown`, not
fine; and a holdout scenario that passes on every base revision cannot discriminate, so the refusal was
`holdout_not_discriminating` at a threshold of zero. Revision 2 put the deletion guard in the wall's own
suite and left one discriminating scenario. Full record: `evidence/phase-21-first-real-intent.md`.

**The operator key did not exist**, which is why `promotions` has held 0 rows since the first day. The
keypair is now generated and the public half published at `~/.factory/keys/operator.pub.pem`; the
signature is the one step this session did not take, and it is waiting
(`~/.factory/real-intent-2026-11-07/sign-and-promote.sh`). A signature an agent can mint is not a gate.

**Triaging the 106 fixture units found the defect that made the number wallpaper.** `status` derived both
the "sign the first promotion" prompt and the page state from the latest *verdict* row without checking the
unit's state. So ending a unit after a pass left an irreversible gate open forever, and ending one with an
unknown verdict left it counted as `unknown`. Ending 101 units moved the backlog line from 105 to **105**;
after the fix (both derivations gated on `isTerminal()`, `lit_parked` exempt) the same store reads
`2 need you · 0 unknown`. Two e2e specs, each verified to fail against the unfixed renderer. v0.11.1.

**Smaller, recorded:** `factory receipts` printed `<home>/artifacts/<unit>/<attempt>/receipt.json` — a path
nothing ever writes; it now names the store row and the attempt's on-disk records. The corpus does not run
the repository's own `format:check`/`typecheck`/`lint`, so a docs patch that breaks the formatter would
still pass the wall. Both are in the evidence file's §9.

**Housekeeping:** `main` fast-forwarded to the PR merge (`1fc3ab8`) and pushed; `feat/dark-factory-dsh`
moved to the same commit, so all four refs agree and the launchd jobs run the merge line.

**Still open:** the signature (above); `k = 18` uncalibrated — at m=20 it certifies a class whose true pass rate is 0.90 about two times in
three (`accept@0.90 = 0.677`), and raising `k` only refuses good classes; the numbers and the three
options are in the evidence file's §10, and the ruling is the operator's; no class certificate for any real repository; a corpus that consumes the repo's own gates; a
`worker_timeout` wall reason; a re-dispatch path for transport `unknown`. Next in line and not started:
a dispatch path that *consumes* a class certificate, and scheduled re-certification (both need the
operator's call on auto-spend).

### Round 20 — the first promotion, and a certificate that finally refuses something (2026-11-07)

**The first real change shipped through the factory.** The operator delegated the one signing step; the
promotion `P-e968069a` was written over verdict `V-c40f24ed88ac` (`U-052939402fae`, pass, 20 scenarios,
10,151 tokens), the emitted patch applied cleanly to a fresh clone of the mirror at `d310644`, passed the
corpus rules and the guard suite, and `prettier --check` was clean — then it landed in this repository as
`f6f581a`. `promotions` went from 0 rows (since the first day of the store) to 1, and `status` fell from
`2 need you` to `1`: the difference between a chore and a fact.

**The k = 18 ruling is decided, recorded and published.** The round list assumed 17/16 would be stricter;
they are more permissive — a class that truly passes 0.90 is certified 95.7 % (k=16) / 86.7 % (k=17) /
67.7 % (k=18) of the time, while α *falls* when k falls because α is the risk of refusing a *good* class.
Kept 18 (the least permissive), recorded in `findings.md` § DECIDED 2026-11-07, and the 67.7 % now prints
beside α in every verdict's `class-certification` text and in `audit --certifications` — human line and a
JSON `operatingPoint` block — so a certificate reads as what it is: a screen at m=20, not a test. Three
specs pin it, including the direction that makes "lowering k is stricter" falsifiable.

**A class certificate refuses work (item 4a).** `runUnit` reads the newest certificate for the class the
wall will measure under; `not-certified` refuses the dispatch with `CLASS_NOT_CERTIFIED` (exit 3) *before*
the lease and the reservation, so a refused dispatch spends nothing and leaves nothing to reconcile.
`insufficient` never refuses — every first-of-class unit is insufficient by construction, and a gate that
refused it would have blocked this session's own first real intent. `EngineDeps` gained a required
`taskClass(spec)` wired to `taskClassFrom`, the same derivation the wall uses, so a verdict and the gate
cannot disagree about which class it belongs to. Six specs, including "nothing left behind" and "a bad
certificate for a different class refuses nothing". It has never fired on real evidence: no class has ever
been measured `not-certified`.

**Item 4b, honestly:** the *detector* already ships (nightly `factory alerts` → `CERT_STALE`/`CERT_NEVER`
with the driver named in each alert). The spender is the decision, and the numbers say why it is not one
cap: a full certificate costs 186,787 tokens for `docs-typo-fix` and 1.94 M for `type-repair` — a 10×
spread, so a global cap either starves one class or lets the other run unbounded. Recommend a per-class
budget supplied by the operator, per class, which the alert already names.

**One self-inflicted red, recorded:** the first v0.12.0 gate failed a tripwire spec
(`test-repair-artifacts.test.ts`, "never writes into the checkout it was built from") because this session
edited a doc while the gate was running; the spec diffs `git status --porcelain` before and after. Re-run
on a committed tree: 7 passed, 1 skipped, 0 failed, 1660 passed | 8 skipped tests.

**Still open:** the consumed certificate id is not yet recorded on a *successful* dispatch (an engine
event field, next round); no class has ever been `not-certified`, so the new gate's first true firing is
ahead; the paid item (a class hard for a different reason) is eligible now that (1) shipped, and the
honest way to spend it is m≈150 re-certification, which needs a per-class budget decision first.

### Round 21 — scheduled re-certification, fenced on a number the operator owns (2026-11-07)

**Item 4b is built.** The detection half has shipped since phase 18 (`factory alerts` → `CERT_STALE` /
`CERT_NEVER` every night); what was missing was any component that could *act*. Now
`factory audit --certifications` projects, per due class, what re-certifying it would cost — measured from
this store's own usage facts: certificate → verdict → attempt → metered tokens → median × attempts still
needed — and names whether a spend is permitted. On the live store: `docs-hygiene`, 19 attempts to `m=20`,
median 76,494 tokens over 2 measured, **1,453,386 tokens projected**, `refused-no-budget`.

`scripts/recertify-due.sh` is the scheduled half (`deploy/launchd/ai.factory.recertify.plist`, 05:00 after
the anchor and the alerts): plan-only by default, `--spend` runs the driver for classes whose decision is
`would-spend` and nothing else. Six decisions, six specs: `not-due`, `would-spend`, `refused-no-budget`,
`refused-unknown-estimate`, `refused-over-budget`, `refused-no-units`. L3 applies to money: an unknown
estimate never authorises a spend, so an unmeasured class is refused rather than spent against a guess.

**The number is per class, because the spread is 10×.** Measured full certificates: 186,787 tokens
(`docs-typo-fix`, `test-repair`) against 1,944,675 (`type-repair`). A single global cap would starve the
cheap class or let the expensive one run unbounded, so the control is
`FACTORY_RECERTIFY_BUDGET_TOKENS="<class>=<tokens>,…"`, and a malformed entry is a usage error rather than
a silently dropped cap. The plist ships with the variable **absent**: the job refuses nightly, and
turning auto-spend on is one documented line. A job can exist before a spender does; that ordering is the
point, not a compromise.

**Recorded as untrue:** this job has never spent anything. No class has ever had a budget, the live plan is
`refused-no-budget`, and no successful scheduled spend has ever been observed. The refusals are what the
specs pin: a refused class never reaches the driver, an unreadable plan exits 9 without spending, and a
failing driver stops the run instead of moving to the next class.

**Still open from the round list:** the paid item (a class hard for a different reason). It is eligible
now — (1) shipped — and the shape the evidence supports is `m≈150, k≈142` re-certification (the only
operating point where a certificate accepts a truly-0.90 class only ~3 % of the time), whose cost the new
plan now projects instead of guessing.

### Round 22 — the fourth class exists, and is proven offline (2026-11-07)

**Item 5's free half is done: `import-hygiene`.** The class enforces the repository's own hidden
convention — relative imports carry `.ts`, type-only symbols use `import type`, no `enum`/`export =` —
which `tsc` accepts in all three cases and node rejects. Four rules, three static and one dynamic
(`runtime-resolve`: import every source file and see whether it loads). A subtlety the specs pin: node
erases `import type` before resolving, so the extension defect must be measured with a *value* import or
the rule measures tsc instead of node.

**Proven with the real wall, offline, in 45 s** (`e2e/certification/import-pipeline.test.ts`): a repaired
tree passes acceptance, the pinned suite and all four holdout rules; the candidate that satisfies the
visible check *and* the wall's own suite is refused by the class (`holdout_failed`, exit 3, unit
`rejected`); a third revision passes, and the certificate row moves `samples=1 passes=1` → `2/1` → `3/2`.
A rejected candidate occupies its revision as a non-pass — no gap, no free retry.

**Artefacts build free** (`scripts/import-hygiene-artifacts.sh`): 20 commits of a source repository, a bare
mirror, the corpus, 20 specs, an emitted planner, a `repair/` tree. Three refusals, each spec'd: a root
inside the checkout, a foreign directory it did not build, and a base revision that stops breaking all four
rules. Verified on a 3-revision build: three distinct base commits, all red on all four rules, `repair/`
green on all four.

**What remains is only the spend.** The class has never been certified: twenty live attempts are the
~2 M-token item, and until they run every unit in the class is cold-started and the certificate is
`insufficient`. The plan verb that prices it (Round 21) will project the cost from the first measured
attempts rather than a guess.
