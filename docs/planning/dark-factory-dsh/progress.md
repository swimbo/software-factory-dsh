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
