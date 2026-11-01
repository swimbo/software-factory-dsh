# Phase 13 — Plan Gap Audit

**Audited:** `feat/dark-factory-dsh` @ `c363900` (plus 12 uncommitted files from parallel agents, called out where they matter)
**Auditor:** `existing-state-auditor`
**Rule applied throughout:** *a claim with no test is `UNPROVEN`, never `met`.* "Implemented" and "verified" are different words; §4 exists to keep them apart.
**Scope:** all 18 phase plans that exist (`phase-1..8`, `phase-9a..9e`, `phase-10..14` — the count the plan assumed was 13, see §8), plus the six supporting artifacts and the four never-regress controls.

---

## 0. How this was audited

Nothing here is inferred from a green suite. Every `PROVEN` cell names a file and a command whose output I read; every `EXISTS` cell names a path and line I opened. Where I could not run something, the row says `UNPROVEN` and why.

### 0.1 The tree was moving under me — and that matters for two rows

`git status` at audit time: **12 modified files** (`apps/cli/src/render/dispatch.ts`, `apps/cli/src/verbs/run.ts`, `apps/panel/test/fixtures.ts`, `packages/contracts/src/{index,receipt}.ts`, `packages/core/src/{engine,engine.test,fake-store}.ts`, `packages/store/src/{store,store.test,audit.test}.ts`) and **one untracked spec** (`e2e/cli/default/09-holdout-sabotage.test.ts`). The uncommitted work is a real change to what a receipt's hash covers (`contentHash(receipt)` → `receiptShaFor(receipt)` = hash over `toDecisionReceipt`), and it is mid-landing: `engine.test.ts` was edited during my first full-suite run, which is the only reason that run shows one red.

I did not stash, reset or otherwise disturb that work. Consequence for the two affected rows:

- **9c / control #1** — I audit the *committed* tree, where E2E-29 is absent and the untracked spec is the only implementation. Noted, not credited.
- **8 / 10 panel** — the browser suite currently fails at seeding because `e2e/panel/harness/seed.ts:203` still hashes the whole body while the working-tree engine hashes the projection. That is a missing call-site update in the in-flight change, not a committed-tree bug; I have marked it as such rather than as a product defect.

### 0.2 Commands run (verbatim, with results)

| Command | Result |
| --- | --- |
| `pnpm test` (whole tree) | 63 files; **1024 tests: 1013 passed, 1 failed, 10 skipped**; the one failure is the mid-landing race above |
| `npx vitest run packages/contracts packages/store packages/core` | **231 passed** (121 / 60 / 50) |
| `npx vitest run packages/wall` | **135 passed, 3 skipped** (`container.test.ts`, `@docker`) |
| `npx vitest run packages/qualifier packages/gates packages/effects` | **238 passed** (109 / 101 / 28) |
| `npx vitest run apps/cli` · `apps/panel` | **97 passed** · **117 passed** |
| `npx vitest run packages/dsh-adapter` | **142 passed, 1 skipped** (143) |
| `npx vitest run e2e/cli/default/0{1..8}-*.test.ts` | 8 files, **54 passed** |
| `npx playwright test` | 41 specs declared, **cannot run**: `chromium_headless_shell-1248` not installed → launch error on every browser spec |
| `pnpm run typecheck` | exit 0 |
| `pnpm run lint` | `discipline-lint: 7 checks passed` |
| `pnpm run format:check` | "All matched files use Prettier code style!" |
| `node packages/wall/src/cli.ts self-test` | exit 0, 9 corpus cases, 9/9 documented behaviour |
| `node apps/cli/src/main.ts --help` | 12 verbs, exit codes 0–9, names `dsh 0.2.1-rc.3` |
| `node apps/cli/src/main.ts audit U-x --verdict` | **exit 2**, `unknown option '--verdict'` (ux-plan documents it — see 7) |

### 0.3 What the evidence file claims vs. what the tree holds

`evidence/phase-9-implementation.md:32-36` claims per-package counts of `121+60+50`, `109+28+101`, `95+116`. I re-ran all of them: **every number reproduces** (cli is now 97, panel 117). The evidence file is honest about its numbers; it is *not* honest about scope, see §4.

---

## 1. Verdict at a glance

| Phase | Delivers | Verdict |
| --- | --- | --- |
| 1 Requirements & Discovery | scope fence, constraints, env snapshot | **met** |
| 2 Pain Point Research | 42 sources → R1–R7 | **met** |
| 3 Data Map | 28 entities, flows, invariants | **partly met** — 8 of 28 entities have no home |
| 4 User Stories | 57 stories, P0 set, traceability | **partly met** — no 27-deliverable coverage check |
| 5 Architecture + debate | 4 planes, C1–C10, consensus | **met** |
| 6 Tech Guide + debate | pins, conventions, commands | **met** (one doc drift) |
| 7 UX Planning | flows, message asymmetry, exit codes | **partly met** — a documented flag does not exist |
| 8 UI Planning | one page, tokens, `/api/status` | **partly met** — browser proof cannot run here |
| 9a Skeleton + store | contracts, store, core, effects | **partly met** — IN #5 scheduler absent; outbox unconsumed |
| 9b DSH adapter + isolation | adapter, Dockerfile, provisioner | **met** (divergences already reported and accepted) |
| 9c The wall | holdout, Δ, re-execution, self-test | **partly met** — the defining e2e test is not committed |
| 9d Qualifier + gates | qualifier, budget, credentials, promotion | **partly met** — destructive gate & proxy absent |
| 9e Dark unit + CLI | 12 verbs, panel, dogfood | **partly met** — repo docs unwritten |
| 10 E2E Generation | 53 specs, 8 adversarial | **partly met** — 12 spec ids unimplemented |
| 11 Testing & Verification | evidence files per stage | **not met** — 6 of 8 evidence artifacts absent |
| 12 Delivery | README, AGENTS, ADRs, runbooks | **not met** — none of the five exist |
| 13 Plan Gap Audit | this document | **in progress** (this file) |
| 14 Fix All Gaps | `plan-gaps.md` all-green | **not met** — not started |

---

## 2. Per-phase audit

### Phase 1 — Requirements & Discovery

| | |
| --- | --- |
| **CLAIMED** | "Capture the direct request of 2026-11-01 in the user's words, pin the four scope decisions… fence IN/OUT scope… and snapshot the actual machine" — `phase-1-plan.md:9`; "27 numbered deliverables" (`:22`), 9 OUT items (`:23`), "C1–C8 locked" (`:21`) |
| **EXISTS** | `phased-plan.md:11-27` (C1–C8), `:29-50` (IN, 27 numbered items), `:52-63` (OUT, 9 bullets), `:65+` (environment table); `findings.md:73-79` (R1–R7), `:62-69` (P1–P8); `research/pain-points.md` (222 lines), `research/existing-state.md` (559), `research/dsh-architecture.md` (622) |
| **PROVEN** | Documentary claim, so the test is structural and I ran it: `grep -c "^| C[0-9]" architecture.md` → 10; IN items counted = 27; OUT = 9; C1–C8 all present; 42 pain-source rows. Cross-checked against `decisions/INDEX.md:8-18`, which cites these sections as the settled record. Not machine-verifiable: "the user confirmed both" |
| **VERDICT** | **met.** Nothing to fix. |

### Phase 2 — Pain Point Research

| | |
| --- | --- |
| **CLAIMED** | "42 sources across 10 platforms … The output is not a complaint list but the seven design requirements (R1–R7)" — `phase-2-plan.md:9` |
| **EXISTS** | `research/pain-points.md` — Method/query table, the 42-row research table, T1–T8 themes; `findings.md:62-79` — P1–P8 with source ids and the R each produces |
| **PROVEN** | `grep -c "^| [0-9]\+ " research/pain-points.md` → **42**. R1–R7 each carry a P-source and a downstream consumer in the plan set (R1→`contracts/receipt.ts`, R2→`wall/evaluate.ts`, R3→`dsh-adapter/watchdog.ts`, R4→`store`+`effects`, R5→`gates/credentials.ts`, R6→`wall/selftest.ts`, R7→`qualifier/signals.ts`). No test applies to a research artifact |
| **VERDICT** | **met.** The counter-evidence sections (`findings.md` "where the justification is weaker than the pitch") are present, which is the part most audits would skip. |

### Phase 3 — Data Map

| | |
| --- | --- |
| **CLAIMED** | "Map every first-class entity, relationship, flow… so Phase 5's components and Phase 9a's `schema.sql` can be written against a fixed data shape" — `phase-3-plan.md:9`; entity list at `:20` includes `claim`, `session_tree`, `policy_version`, `wall_revision`, `delta_sample`, `gate_decision`, `spend_entry`, `issued_token` |
| **EXISTS** | `data-map.md:49-84` (28-entity summary), `:84-566` (per-entity), `:566-750` (relationships), `:751-831` (state machines), `:854-877` (§6 invariants); implemented in `packages/store/src/schema.ts` (16 `CREATE TABLE`, 5 append-only triggers at `:48,50,156,158,191,193`, CHECK constraints at `:180` and `:218`), `packages/contracts/src/*.ts` |
| **PROVEN** | `audit()` replay + schema-invariant tests: `packages/store/src/store.test.ts` (46) and `audit.test.ts` (14), both green in the 231-test run. **Entity-by-entity, 20 of 28 have a persistence home; 8 do not** — see §3.2 for the table |
| **VERDICT** | **partly met.** Smallest next action: either add `policy_versions` / `delta_samples` / `gate_decisions` / `escape_audits` rows (they are all append-only and cheap) or amend `data-map.md:49-84` to say these are computed/embedded rather than stored. The `claims` table and its `fencing_token` (data-map:187-195, "enforced by trigger I8") do not exist; at-most-once is instead provided by `leases_one_live_per_unit` (`schema.ts:121`) + `assertDispatchable` (`rules.ts:119-131`) — a real design substitution that no document records. |

### Phase 4 — User Stories

| | |
| --- | --- |
| **CLAIMED** | "Turn R1–R7 and the 27 IN-scope deliverables into a prioritized, testable backlog with stable story IDs" — `phase-4-plan.md:9`; "`user-stories.md > ## Coverage sanity check` — a table mapping all 27 IN-scope deliverables to at least one story ID" (`:23`) |
| **EXISTS** | `user-stories.md` (576 lines): 8 epics, **57 unique `US-` ids**, P0 coverage table at `:553-568` naming R1–R7, the three gates and "unknown never passes" |
| **PROVEN** | `grep -o "US-[A-Z0-9]*-[0-9]*" \| sort -u \| wc -l` → 57; the story ids are consumed by `e2e-tests.md`'s mapping table (`:529-534`) and by `02-qualify`/`04-gates` header comments. Each story carries ≥2 Given/When/Then criteria |
| **VERDICT** | **partly met.** The **`## Coverage sanity check` section does not exist** (`grep -n "Coverage sanity"` → no match), so the one artifact whose job is to make an uncovered deliverable visible before Phase 13 is missing — and it shows: the audit found IN #5 uncovered by any story *and* by any code (§5, GAP-001). Next action: add the 27-row table; four rows will immediately come up empty (IN #5, #14, #16, #25). |

### Phase 5 — Architecture (+ mandatory debate)

| | |
| --- | --- |
| **CLAIMED** | "Design the system — four planes, ten components, two API surfaces … then stress-test it adversarially before Phase 6 picks a stack" — `phase-5-plan.md:9` |
| **EXISTS** | `architecture.md` (293 lines): laws, planes, C1–C10 table (10 component rows), API surface, ownership, NFRs, `§11 Debate Outcomes`; `consensus-plan.md` (489), `debate-transcript.md` (300), `evidence-ledger.md` |
| **PROVEN** | `grep -c "^| C[0-9]" architecture.md` → **10**, each C-mapped to a package: C1 `core`, C2 `store`, C3 `effects`, C4 contracts/CLI, C5 `qualifier`, C6 `gates`, C7 `wall`, C8 `dsh-adapter`, C9 `apps/cli`, C10 `apps/panel` — all ten directories exist. The debate artifact is the verification for this phase; its outcomes are cited as settled in `decisions/INDEX.md:8-12` |
| **VERDICT** | **met.** The one architectural substitution (worktree → self-contained clone) was ruled and implemented in Phase 9b and is recorded there. |

### Phase 6 — Tech Guide (+ mandatory debate)

| | |
| --- | --- |
| **CLAIMED** | "Commit to a concrete, pinned stack that realises components C1–C10 with no orphans: TypeScript 7.0.2 … `node:sqlite` behind a driver interface, three runtime dependencies" — `phase-6-plan.md:9`; "≤3 runtime dependencies" (`:22`), "`erasableSyntaxOnly: true`, `types: ["node"]` set explicitly" (`:23`) |
| **EXISTS** | `tech-guide.md:§3` pin table; `package.json:20-33`; `tsconfig.json:1-25`; `scripts/discipline-lint.sh`; `scripts/preflight.sh` |
| **PROVEN** | Field-by-field: typescript 7.0.2 ✓, tsx 4.23.15 ✓, vitest 5.0.5 ✓, @playwright/test 1.64.1 ✓, commander 15.0.0 ✓, zod 4.6.7 ✓, pino 10.4.0 ✓; **3 runtime deps ✓**; `types: ["node"]` ✓, `erasableSyntaxOnly` ✓, `strict`/`noUncheckedIndexedAccess`/`exactOptionalPropertyTypes` ✓ (all four at `tsconfig.json:6-9`). `pnpm run typecheck` exit 0, `pnpm run lint` 7/7, `pnpm run format:check` clean |
| **VERDICT** | **met**, with one drift: `tech-guide.md §1` still says Node **22.23.3** and engine `>=22.12 <27`, while `package.json:9` declares `>=24.9.0 <27` and `.nvmrc` pins `26.12.1` (`decisions/INDEX.md:11` also says 22.23.3). Nit, but an audit that lets the runtime line drift is not auditing. Next action: update the three places to the declared window. |

### Phase 7 — UX Planning

| | |
| --- | --- |
| **CLAIMED** | "Design the operator surface as a CLI-first experience … plus the one rule that makes a dark factory readable — the human/agent message asymmetry" — `phase-7-plan.md:9` |
| **EXISTS** | `ux-plan.md` (775 lines) — flows, asymmetry rule at `:20`, exit-code table, `LIMITS` sections rendered by `apps/cli/src/render/limits.ts`; implemented across `apps/cli/src/verbs/*` (12 verbs), `render/format.ts`, `render/status.ts:277` |
| **PROVEN** | `04-gates.test.ts` proves every gated verb refuses `-y/--yes/--force/-f/--assume-yes` with exit 2 (`:170`) and that the same flags are tolerated on ungated verbs (`:184`); `08-real-wall.test.ts:369-384` proves the asymmetry — the operator gets `receipt_unfaithful` and the worker-facing line never receives `all good`; `05-status.test.ts:95-122` proves `unknown` exits 5 and never reads as success |
| **VERDICT** | **partly met.** One documented affordance does not exist: `ux-plan.md:223` shows `factory audit U-7f3a9c --verdict` and `e2e-tests.md:157` uses it in the E2E-29 arrange step, but the verbose option set is `--escape-rate/--since/--sample/--last` (`audit.ts:213-221`) and the flag is an exit-2 usage error. Next action: drop `--verdict` from both documents or add the no-op flag. |

### Phase 8 — UI Planning (status page)

| | |
| --- | --- |
| **CLAIMED** | "one read-only local status page whose only job is to answer 'what needs a person right now?'" — `phase-8-plan.md:9`; two routes, no SPA, measured contrast ratios, `unknown` never rendered as success (`:19-27`) |
| **EXISTS** | `ui-plan.md` (639 lines); `apps/panel/src/server.ts:235-263` (two routes, 405 on writes), `status.ts:277` (`buildStatus`), `render.ts` (579), `tokens.ts` (413); `e2e/panel/*.spec.ts` (6 files, 41 specs) |
| **PROVEN** | Unit level: `apps/panel` **117 passed**, including `status.test.ts` (622 lines) asserting `parseStatus()` on `/api/status`, `tokens.test.ts` (contrast arithmetic), `render.test.ts` (`unknown` ≠ ok pill). Browser level: **UNPROVEN here** — `npx playwright test` fails to launch (`chromium_headless_shell-1248` missing), so the "measured as built" contrast and the 320 px reflow are asserted only by unit tests, not in a browser |
| **VERDICT** | **partly met.** Next action: run `npx playwright install chromium` once and record the 41-spec result in `evidence/panel-suite.log` (Phase 11 asks for exactly that file and it does not exist). |

### Phase 9a — Skeleton + durable store

| | |
| --- | --- |
| **CLAIMED** | "`packages/contracts` … `packages/store`: `schema.sql` v1 (tables per `data-map.md` …)" and "Schema invariants encoded in SQL (not just documented)" — `phase-9a-plan.md:19-24`; "`packages/effects`: `enqueue(kind, key, payload)` … `start()/drain()` … `health()` surface" (`:23`) |
| **EXISTS** | `packages/contracts/src/` (9 modules: 16 ledger events at `events.ts:18-127`, 23 error codes → exit codes at `errors.ts:10-73`, `Tri`/`gateSatisfied` at `:105-118`, unit state machine incl. `lit_parked` at `unit.ts:78-99`); `packages/store/src/{schema,store,driver,types}.ts` — 16 tables, 6 append-only triggers, `audit()` at `store.ts:878`, quarantine at `:2277` for effects; `packages/core/src/{engine,rules}.ts` — `createEngine` at `engine.ts:353`, 7 methods; `packages/effects/src/dispatcher.ts` — `createDispatcher` at `:156`, `drain()`/`applyKey()` |
| **PROVEN** | **231 passed**: contracts 121 (canonical JSON, 16 events, 23 codes, verdict earnedness), store 60 (`store.test.ts` 46: append-only triggers, one-live-lease index, quarantine, idempotency per command; `audit.test.ts` 14: replay reproduces every aggregate, `divergences === []`), core 50 (`engine.test.ts`: state machine, `L1` narrative strip, over-budget refusal before enqueue at `:625`, `MAX_ATTEMPTS` at `:678`, recover) |
| **VERDICT** | **partly met.** Two IN-scope items are not there: **IN #5** — no scheduler, no worker slots, no wall-capacity ceiling anywhere in `packages/` or `apps/` (GAP-001), and **IN #3**'s health surface — `createDispatcher` has `drain`/`applyKey` and no `health()`. And the outbox is **never drained by any production path** (GAP-002). |

### Phase 9b — DSH worker adapter & isolation

| | |
| --- | --- |
| **CLAIMED** | "one `git worktree` and one container per attempt … NDJSON supervision, harness-owned ceilings, and a receipt captured from git — never from the model's prose" — `phase-9b-plan.md:9` |
| **EXISTS** | `packages/dsh-adapter/src/` — `executor.ts` (835), `clone.ts` (147, replaces the worktree per the accepted A3.2 amendment), `home.ts` (163, per-attempt `DSH_HOME` volume), `overlay.ts` (219, six-entry overlay), `ndjson.ts` (255), `watchdog.ts` (138); `docker/factory-env/Dockerfile` (pinned digest, uid 10001, `--internal` network contract, two mounts); `scripts/provision-dsh-home.sh`; 11 `fake-dsh` fixtures |
| **PROVEN** | `npx vitest run packages/dsh-adapter` → **142 passed, 1 skipped**: `executor.test.ts` (42: receipt from git on exit 0 *and* 1, env allowlist drops every `*_API_KEY`, `DSH_VERSION_MISMATCH`, ambiguous on missing `turn_end`), `clone.test.ts` (10: `.git`-as-file refused, clone survives its source, `nlink` 1), `home.test.ts` (13: seed read-only, read-out then destroy, no `cordis.patch.yml` inheritance), `profile.test.ts` (5: real binary, skipped without dsh), `egress.test.ts` (6, 1 skipped: the six-destination negative egress test + proxy control) |
| **VERDICT** | **met**, within the divergences I reported when delivering it (overlay at `/dsh-home/factory-overlay.yml`; two mounts; image build unverified on this host; `statusPaths` empty by construction on a healthy capture). The plan's `worktree.ts`/`profile.ts`/`headless.ts`/`ceiling.ts`/`container.ts`/`fake.ts` split landed as `clone/overlay/ndjson+executor/watchdog/(Dockerfile)/fake-executor` — a naming divergence, not a capability one. |

### Phase 9c — The wall

| | |
| --- | --- |
| **CLAIMED** | "`evaluate.ts`: triple-run each scenario … 2-of-3 per scenario, aggregate ≥90% … a scenario that errors on infrastructure is `unknown`, and **`unknown` fails the gate**" — `phase-9c-plan.md:26`; "`selftest/`: **sabotage corpus** of ≥3 fixture changes that pass their own visible tests and must be rejected" (`:31`); "a `wall self-test` command" and "a `wall revalidate` command" (`:31-32`) |
| **EXISTS** | `packages/wall/src/` — `evaluate.ts` (1669, `evaluate()` at `:1564`, Δ assembly at `:1593`, verdict `receiptSha` at `:1647`), `reasons.ts` (20 reason codes incl. `delta_regression`, `holdout_not_discriminating`, `receipt_unfaithful`), `selftest.ts` (`runSelfTest`), `criteria-log.ts` (263), `local.ts` (non-container runner), `signing.ts`, `holdout.ts`; `packages/wall/tests/corpus/` (9 cases); `packages/wall/src/cli.ts` (`wall self-test`) |
| **PROVEN** | `npx vitest run packages/wall` → **135 passed, 3 skipped**; `node packages/wall/src/cli.ts self-test` → **exit 0, 9/9**. CLI path: `08-real-wall.test.ts:285` measures a real Δ (baseRate 0 → candidateRate 1, `delta.checked === true`), and `:369` catches a receipt whose claimed command does not reproduce. **The defining test — E2E-29, "sabotage that passes its visible suite is rejected" — is not in the committed tree**: `07-seams.test.ts:33` says so explicitly, `e2e-tests.md:467` names `e2e/cli/adversarial/wall-rejects-sabotage.test.ts` which does not exist, and the only implementation is the uncommitted `09-holdout-sabotage.test.ts` (GAP-004) |
| **VERDICT** | **partly met.** The wall rejects sabotage *when handed a constructed receipt* (corpus + `evaluate.test.ts`), and no committed spec shows it rejecting sabotage *through `factory run`*. `wall revalidate` does not exist at all (a comment at `criteria-log.ts:266` describes it; `cli.ts:59` accepts only `self-test`). |

### Phase 9d — Qualifier & gates

| | |
| --- | --- |
| **CLAIMED** | "`gates/destructive.ts`: classification of the **normalised, post-expansion** command … into `safe \| destructive \| privileged` … destructive class requires a recorded human approval" — `phase-9d-plan.md:21`; "`gates/credentials.ts` + `packages/proxy`: broker mints short-lived … the proxy is the only holder of `BIFROST_API_KEY`" (`:23`); "`unknown` is stored as unknown and **blocks promotion**" (`:20`) |
| **EXISTS** | `packages/qualifier/src/` — `qualify.ts:153`, `signals.ts` (6 signals, `evaluateSignals:587`), `policy.ts:175` (`currentPolicyVersion`), `security.ts` (security lock), `purity.test.ts` (no-LLM import rule); `packages/gates/src/` — `promotion.ts:235` (`buildPromotion`), `budget.ts:138` (`signEnvelopeRaise`), `credentials.ts:82` (`issueCredential`, 1 h TTL cap at `:29`), `decision.ts:81` (`makeGateDecision`, 4 gate kinds at `:19`), `signing.ts`; destructive detection exists **only** as `isDestructiveArgv` in `packages/wall/src/evaluate.ts:257` |
| **PROVEN** | **238 passed** (qualifier 109, gates 101, effects 28): table-driven lane cases with reason codes (`qualify.test.ts` 43), security lock both directions (`security.test.ts` 15), unsigned promotion refused and no file written (`promotion.test.ts` 25 + CLI: `04-gates.test.ts:49` and `08-real-wall.test.ts:325`), expired/over-scoped token refused (`credentials.test.ts` 14), `unknown` blocks promotion (`07-seams.test.ts:586` → `VERDICT_UNKNOWN` with a *correctly signed* promotion) |
| **VERDICT** | **partly met.** Three gaps: (a) **no `packages/proxy`** — `credentials.ts` mints a grant record but nothing holds `BIFROST_API_KEY` and nothing is the worker's only egress target, so the "proxy" half of IN #18 is declared and unimplemented; (b) **no normalised post-expansion classifier** — the wall denylists the *recorded* argv after the fact (`evaluate.ts:1347` admits "a denylist and therefore partial"), there is no `privileged` class, and no destructive command ever raises a human-approval gate; (c) **`gate_decisions` is not persisted** — `makeGateDecision` returns an object and no caller stores it, so "a recorded human approval" has no record. |

### Phase 9e — Dark unit + operator CLI

| | |
| --- | --- |
| **CLAIMED** | "`apps/cli`: verbs `intent`, `qualify`, `run`, `status`, `receipts`, `audit`, `promote`, `abort`, `recover`, `budget`, `wall` … exit codes (`0` ok, `1` failed/refused, `2` usage, `3` unknown/ambiguous)" — `phase-9e-plan.md:20`; "`README.md`: what it is, the honest limitations … `AGENTS.md` … `docs/adr/`: ADR-001 … ADR-006" (`:27-28`) |
| **EXISTS** | `apps/cli/src/main.ts:46-59` (`VERB_SPECS`, 12 verbs: the 10 above + `credential` + `version`), `exit.ts` (0–9), `context.ts`, `render/{format,status,gate,limits,dispatch}.ts`; `apps/panel/src/{server,status,render,tokens}.ts`; `fixtures/dogfood/`, `scripts/dogfood.sh` |
| **PROVEN** | `apps/cli` **97 passed** + `apps/panel` **117 passed**; `node apps/cli/src/main.ts --help` → exit 0, 12 verbs, exit-code table, `dsh 0.2.1-rc.3`; `01-intent.test.ts` (5), `05-status.test.ts` (7: `parseStatus()` validates the payload, `unknown` exits 5), `e2e/panel` unit coverage for the token gate (401) and 405-on-POST |
| **VERDICT** | **partly met.** `factory wall` **is not a verb** (the wall has its own executable, `packages/wall/src/cli.ts`), and the three repo-document deliverables — `README.md`, `AGENTS.md`, `docs/adr/` — **do not exist**: the README is still the previous project's ("Software Factory Stapled", OpenHands + Restate) and `docs/adr/`, `AGENTS.md`, `docs/runbooks/` are absent (GAP-005). |

<!-- PART2 -->
