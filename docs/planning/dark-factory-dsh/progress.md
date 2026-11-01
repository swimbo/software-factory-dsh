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
