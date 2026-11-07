# Handover

For whoever takes this repository next. Written on 2026-11-02 against the tree at `36e2ddd`
(committed 2026-11-01), not the plan set that imagined it: the audit
[`docs/planning/dark-factory-dsh/phase-13-audit.md`](planning/dark-factory-dsh/phase-13-audit.md)
is the source of truth for what is real, and where a plan promised something this tree does not have,
the audit says so and this document repeats it rather than smoothing it over. One caveat about the
audit: its §10 addendum predates `36e2ddd`, so it still records the worker container and E2E-45 as
`UNKNOWN`, while `e2e/cli/docker/08-worker-container.test.ts` and `09-recover-sweep.test.ts` now measure
them (ran here: 3 + 2 specs passed). The audit's earlier sections are history and are deliberately
not rewritten; where this document disagrees with §10, what follows was measured on this tree and the
command is named. One assertion that used to sit in that category is now a measurement: the worker
container cannot be combined with a live model here for a reason that is pinned by
`e2e/cli/docker/10-internal-bridge.test.ts` (docker's `--internal` gateway is VM-internal and
un-bindable from macOS; that network is `ENETUNREACH` towards every host address), not merely by a
comment in `apps/cli/src/context.ts`.

## What to run before touching anything

```bash
export PATH="$HOME/.nvm/versions/node/v$(cat .nvmrc)/bin:$PATH"   # 26.12.1, or preflight fails
pnpm install --frozen-lockfile
pnpm run preflight          # node version, package layout, the pinned dsh expectation
bash scripts/verify.sh      # preflight → typecheck → lint → format:check → test → build → panel → live-model
pnpm run factory version    # dsh expected/observed, policy hash, executor availability, home
```

`scripts/verify.sh` prints one row per stage, in merge order, and exits non-zero if any stage failed.
Measured on this tree: **7 passed, 1 skipped, 0 failed — OK**. The seven real stages are
`preflight`, `typecheck`, `lint`, `format:check`, `test`, `build` and `panel`; `live-model` is the
skip, with its reason (`BIFROST_API_KEY is not set`). The `test` stage is 95 files / 1372 tests passed
and 2 of those files / 7 of those tests skipped; it took 61.6 s here, with docker 29.8.2 running.

The `panel` stage is **not** absent and does **not** skip: it runs the 41 browser specs (10.6 s here)
and, if the chromium build `@playwright/test` pins is missing, it **fails** with the remedy
(`npx playwright install chromium`). A panel the README calls shipped and a gate that never opens it
is a claim nobody checked, so a missing browser is a red stage rather than a green omission. The
`live-model` stage is the opposite trade: it spends money, so it is opt-in with
`FACTORY_VERIFY_LIVE=1` and declared `SKIPPED` with its reason otherwise.

`bash scripts/verify.sh` writes `docs/verification/<run-id>/{verify.log,summary.json}`, and the
summary records the commit it measured and whether a model key was present — a green line is a
reproducible artifact, not a memory. The last committed offline run is
`docs/verification/2026-11-01T22-02-27Z/` (7 passed, 1 skipped, measured `e7ddde9`); the last committed
live run is `docs/verification/2026-11-01T21-58-16Z/` (8 passed, 0 skipped, measured `6a398cc`). The
run quoted above for `36e2ddd` was written to `/tmp` rather than committed, because a docs pass does
not own `docs/verification/`.

One more environment fact worth knowing before you read the isolation claims: on this macOS host
`bash scripts/provision-topology.sh` reports `topology single-uid (source: platform)` and
`claim single-uid: the wall is a separate process, not a separate principal`, exit 0.

If a stage is red before you have changed anything, it is not yours: check `git status` and whether
another agent is mid-edit in that package. Do not "fix" a red stage by weakening a test.

## The four never-regress controls, and where each is tested

These are the four properties the whole design rests on. If a change makes one of them false, the
change is wrong no matter how green the rest is. Each row names the spec that would catch the
regression, by the name it prints.

| Control                                                            | Test that proves it (run these by name)                                                                                                                                                                                                                                                                                                             |
| ------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **A sabotage that passes its own visible suite is still rejected** | `e2e/cli/default/09-holdout-sabotage.test.ts` — `describe('E2E-29: a change that passes its own suite but fails the holdout is rejected')`, spec "measures the sabotage as fail:holdout_failed (exit 3), never a pass"                                                                                                                              |
| **`unknown` never satisfies a gate**                               | `e2e/cli/default/07-seams.test.ts` — `it('[@fake-wall] refuses a fake pass unsigned, and refuses it signed too')`; the browser half `e2e/panel/unknown-not-pass.spec.ts` — `E2E-37 — unknown is a value, never a pass`, including "has no green anywhere in the unknown card"                                                                       |
| **Nothing is silently re-dispatched**                              | `e2e/cli/default/06-recover.test.ts` — `it('[@default] an attempt with no terminal event becomes ambiguous, and is not retried')`; `e2e/cli/default/13-effect-outbox.test.ts` — `it('[@default] retries after the lease expires, exactly once')`; `07-seams.test.ts` — "leaves an ambiguous attempt that recover reconciles without re-dispatching" |
| **An unsigned promotion writes nothing and keeps exit 5**          | `e2e/cli/default/04-gates.test.ts` — `it('[@default] refuses an unsigned promotion, writes no artifact, and keeps exit 5')`; `e2e/cli/default/08-real-wall.test.ts` — "measures a pass with the local runner, then refuses an unsigned promotion and accepts a signed one"                                                                          |

Run them alone with vitest (measured here: 3, 8 and 12 specs passed, in 5.9 s, 6.0 s and 10.0 s):

```bash
pnpm exec vitest run e2e/cli/default/09-holdout-sabotage.test.ts
pnpm exec vitest run e2e/cli/default/06-recover.test.ts e2e/cli/default/13-effect-outbox.test.ts
pnpm exec vitest run e2e/cli/default/04-gates.test.ts
```

The browser half of the panel is Playwright: `pnpm run test:e2e:panel` — 41 specs across 6 files in
`e2e/panel/`, **41 passed in 10.7 s** on this host. It needs the chromium build `@playwright/test`
pins (revision 1248, in `~/Library/Caches/ms-playwright/`); `npx playwright install chromium` is the
remedy on a machine allowed to download. The panel is stage 7 of `scripts/verify.sh` (see above), so
this suite failing is a red gate, not a note.

## Decisions ND1–ND4, ratified — and what each does not buy

Decided and ratified by the operator on 2026-11-01:
[`findings.md` §DECIDED](planning/dark-factory-dsh/findings.md), with the implementation record in
`evidence/phase-13-nd-decisions.md`. The `§NEEDS_HUMAN_DECISION` table above them is history rather
than procedure, so its "default if unanswered" column is no longer the operating position. None of
the four may be reopened by an agent: they are claim-blockers, and each still says what it does
**not** buy.

| #   | Ratified decision                                                                                                                                                                         | What it still does not buy                                                                                                                                        |
| --- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| ND1 | Certify per **task class** at m = 20 attempts, k = 18 passes; publish α = 0.0755, never a global pass rate                                                                                | No β: the power to detect a regressing class needs a known-bad corpus nobody has, and the module header says so instead of publishing one                         |
| ND2 | Two-uid topology as the Linux default (`factory-wall` owns store/corpus/key, `factory-worker` runs the turn); single-uid on this macOS host with the claim narrowed to "separate process" | No protection against root on the host. The Linux topology has run in a `node:26-bookworm` container, **not** on the Linux target itself                          |
| ND3 | Gateway is the source of truth; the per-attempt proxy records observed usage and **enforces by revoking** the attempt token when spend crosses the ceiling                                | No invoice: reconciliation is best-effort and reports `unknown` (exit 6) when the gateway cannot be read; a response with no usage block is `unknown`, never zero |
| ND4 | Anchor the ledger head off-host once a day to `hermes-control`, and refuse a head with no anchor newer than 48 h                                                                          | No real-time tamper evidence (the window is up to a day, so "detectable within 48 h", not "prevented"), and no rotation of the anchor file                        |

The anchor and the alert jobs are installed on this host and were observed running:
`deploy/launchd/ai.factory.anchor.plist` at 03:00 (`~/.factory/anchor.log`: `anchored 4 events, seq 4`,
`scope off-host`) and `deploy/launchd/ai.factory.alerts.plist` at 04:00 (`~/.factory/alerts.log`).
`launchctl list` shows both labels loaded, `ai.factory.anchor` last exit 0 and `ai.factory.alerts`
last exit 9 — the 9 is the honest answer to "has any task class ever been certified in this store?",
which is `CERT_NEVER`, not a transport failure. Run by hand with the plist's environment,
`factory ledger verify` prints `outcome FRESH / age 8.4 h / scope off-host` and exits 0, and
`factory alerts` prints `anchor FRESH — anchored 8.4 h ago, off-host` plus the same `CERT_NEVER` row
and exits 9.

## Skipped suites, and why (not by omission)

A skip is `SKIPPED` with a reason, never a pass. At `36e2ddd` these are the only skips in the tree,
and the reason each one has:

| Suite                                                            | Skips when                                                                 | Why it is not green                                                                                                                                    |
| ---------------------------------------------------------------- | -------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `e2e/cli/live/08-model.test.ts`, `09-ceiling.test.ts` (`@live`)  | `BIFROST_API_KEY` **or** `DSH_BIN` unset (i.e. always in the offline gate) | no paid call in tests (C5), and each spec makes one real turn; 3 specs skipped here, named with both variables in the suite title                      |
| `packages/wall/src/container.test.ts` (`@docker`), 3 of 16 specs | `FACTORY_TEST_IMAGE` unset — the daemon alone is not enough                | the opt-in real-daemon round trip; the 13 specs that do not need a daemon always run (13 passed, 3 skipped here)                                       |
| `packages/dsh-adapter/tests/egress.test.ts`, 1 of 6 specs        | a daemon **is** available (the "without a daemon" branch)                  | the skipped spec is the one that proves the suite skips rather than fails without docker; 5 egress specs ran against `node:22-alpine` here             |
| `e2e/cli/docker/07-isolation.test.ts` (`@docker`)                | daemon unreachable, or `factory-env:e2e` absent and its build fails        | it is **not** always skipped: it builds `factory-env:e2e` when missing and skips with the build command if that fails; 6 specs ran here (E2E-43/44/46) |
| `e2e/cli/docker/08-worker-container.test.ts` (`@docker`)         | `factory-env:rc5` absent (skip names the `docker build` line)              | the worker's container (E2E-45); 3 specs ran here after `docker build --tag factory-env:rc5 docker/factory-env`                                        |
| `e2e/cli/docker/09-recover-sweep.test.ts` (`@docker`)            | same base image, plus a daemon that can run `docker kill`                  | E2E-45's orphan-sweep clause; 2 specs ran here (SIGKILL the control plane, assert the orphan, `recover` removes it)                                    |
| `packages/dsh-adapter/tests/profile.test.ts`                     | no `dsh` binary at the default app path                                    | the DSH-facing half is proven by adapter tests plus one recorded probe; it ran here (5 specs)                                                          |
| `preflight` stage in `scripts/verify.sh`                         | no `dsh` binary                                                            | recorded as **SKIPPED with a reason** in the summary, never silently passed; it passed here                                                            |
| `panel` stage in `scripts/verify.sh`                             | never — a missing chromium **fails** the stage                             | see above; not a skip                                                                                                                                  |

## What is not built (so you do not look for it)

- **No scheduler, no queue, no worker slots.** IN #5 is built as a refusal: `maxConcurrentAttempts`
  and `maxConcurrentWalls` (both default 1) make a second dispatch exit **7** with
  `CONCURRENCY_LIMIT` before anything is reserved (`packages/contracts/src/errors.ts`). There is no
  fairness, no priorities and no dispatch on a timer. GAP-004 stands.
- **No stalled-progress detector.** The watchdog enforces wall-clock and output-byte ceilings and the kill
  switch; "the worker is doing nothing" needs step-level signals DSH owns.
- **The allow path exists only where the factory sees an argv.** `factory gate request|decide|list|show`
  mints a `PrivilegedDecision` from a signature **verified** against the operator's public key (the
  tool never holds a private key), and the fake executor's brokered `command` step presents the
  decision covering its classified operation; consumption is one conditional insert into
  `privileged_decisions`, so a decision is spent once across processes
  (`e2e/cli/default/19-gate-decisions.test.ts`: refused → authorised once → replay refused;
  runbook `docs/runbooks/brokered-operations.md`). What is still missing: the **wall** is not a
  consumer — it measures a candidate and does not act on what it measures, so it replays with no
  decision, refuses a privileged argv, and reports `privileged_replay_refused` even when the launch
  was authorised (the code names what happened at replay; the verdict stays `unknown` because a
  decision is not an oracle — verdicts stored before v0.7.0 carry the older `privileged_unbrokered`,
  which stays in the closed enum so that evidence still parses); a real `dsh` turn's own tool calls
  are an agent-reported artefact and never reach
  the broker (ADR-006); and there is no `gate revoke`, no key registry beyond the promote lookup
  order, and no rule for arbitrary destructive verbs beyond the wall's knowingly partial denylist.
- **`privileged_decisions` holds consumption markers, not the decisions.** A `GateDecision` is the
  `privileged.decided` ledger event written when it is minted plus the `FACTORY_HOME/gates/` artifact a
  person reads; the store table records _which_ decisions have been spent, which is why "consumed"
  survives restarts. Replay protection is the marker, never a re-read of the artifact.
- **No on-call rotation.** `factory alerts --notify` (the daily job runs it) raises one macOS
  notification on this machine, or makes exactly one bounded POST to the webhook in
  `$FACTORY_HOME/secrets/alerts-webhook` — installed on this host, that is the Discord `#dsh` channel,
  one embed per alert, `allowed_mentions: {parse: []}` so nothing can ping. The file must be `0600` or
  the verb refuses it. Nothing retries a lost notification and a host asleep at 04:00 stays quiet until
  it wakes; there is no rotation to escalate to.
- **No scheduled re-certification.** `factory audit --certifications` exits 9 on a stale or absent
  class certificate; a person decides to re-measure the class.
- **No anchor rotation and no automatic reconciliation** of a diverged anchor/ledger pair
  (`docs/runbooks/ledger-anchor.md`).
- **No retry path, no `factory outbox`, no `factory unlock`, no `quarantine --clear`, no
  `intent --revision`.** `factory run --retry --reason …` refuses with `UNIT_ALREADY_TERMINAL`
  (exit 3) — the flag is declared and the capability behind it does not exist. `factory recover`
  has **no** `--observe` flag: observe with `factory status <unit> --attempt <id>`.
- **No CI.** `.github/workflows/` is empty (`git ls-files .github` lists only the PR template), so a
  green `verify.sh` is a local artifact with a recorded commit, not a badge. The `@docker` and
  `@live` suites are therefore "measured on a machine that has docker / a key", never "measured in
  CI".
- **The two-uid topology has not run on the Linux target**, only in a `node:26-bookworm` container;
  the proof recorded in `evidence/phase-13-nd-decisions.md` covers the accounts, the modes, the marker
  and the worker's `EACCES` on store, corpus and key. It does not cover systemd, a real
  `/var/lib/factory`, or an operator key that already exists — and this macOS host is single-uid by
  construction.
- **No ACP worker.** The adapter drives `dsh --profile headless` one-shot turns and reads NDJSON; the
  agent-client-protocol path is not implemented, so "one-shot **or** ACP workers" is one-shot only.
- **No billing-grade accounting** (ND3): spend is what the gateway reported, recorded per attempt in
  `usage_records` with a digest that ties the row to the `usage.recorded` event — not a signature over
  a gateway claim, and not an invoice.
- **Known blemish, not a gap:** `apps/cli/src/render/status.ts:842` prints
  `--attempt ${unit.attempt?.state ?? '<attemptId>'}` — the _state_ where the attempt id belongs. Use
  the `A-…` id from the line above it.

## The three commands that prove the repo is healthy

```bash
bash scripts/verify.sh          # 7 stages + 1 explained skip; exit 0 only if the code is green
pnpm run factory version        # runtime, dsh expected vs observed, executor availability
pnpm exec vitest run e2e/cli/default   # 20 files, 93 tests: 01-intent … 18-suite-command
```

Measured here, in order: `verify: 7 passed, 1 skipped, 0 failed — OK`; `factory 0.4.0`, `dsh expected
0.2.1-rc.5 · observed 0.2.1-rc.5`, `policy sha256:6ce54b93…`, `executor available`, `home
/Users/bo/.factory` (the observed line and `executor available` need `DSH_BIN` set, as
`README.md § Running the live layer` does — without it the same command prints `observed unknown (no
dsh on PATH)` and `executor unavailable`, which is true of that shell and not of the host); and
`Test Files 20 passed (20)`, `Tests 93 passed (93)` in 39.2 s.

If those three pass and `git status` is clean, the tree is in the state this handover describes.
Anything beyond that — a live model turn, a container-isolated wall, the browser suite at a different
Playwright revision — is environment you must supply, and the summaries say so.

## Where things are

| Path                                                 | What it is                                                                                                                                                                                                                     |
| ---------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `docs/adr/`                                          | the eight decisions the design rests on (001–008), with the alternatives rejected and why                                                                                                                                      |
| `docs/runbooks/`                                     | nine 2am procedures (start with [`README.md`](runbooks/README.md))                                                                                                                                                             |
| `docs/planning/dark-factory-dsh/`                    | the plan set: findings, data map, stories, architecture, UX/UI, e2e plan, and the audit                                                                                                                                        |
| `docs/verification/<run-id>/`                        | recorded `verify.sh` runs, with the commit and environment they measured                                                                                                                                                       |
| `packages/`, `apps/`                                 | 11 packages, 2 apps; `packages/dsh-adapter` is the only code that imports DSH                                                                                                                                                  |
| `deploy/launchd/`                                    | the two daily jobs: `ai.factory.anchor.plist` (03:00) and `ai.factory.alerts.plist` (04:00)                                                                                                                                    |
| `docker/factory-env/`                                | the **worker's** image (`FACTORY_WORKER_ISOLATION=container`): node 26.12.1 pinned by digest, `dsh 0.2.1-rc.5`, uid 10001                                                                                                      |
| `packages/wall/docker/`                              | the **wall's** isolation image (`factory-env:e2e`, `node:26.12.1-alpine` by digest) — built by `e2e/cli/docker/07-isolation.test.ts` when absent                                                                               |
| `e2e/cli/default/`                                   | the operator suites, 20 files / 93 tests, numbered by the e2e plan                                                                                                                                                             |
| `e2e/cli/docker/`                                    | the three self-gating container suites (11 specs: E2E-43/44/46, E2E-45, and E2E-45's orphan-sweep clause)                                                                                                                      |
| `e2e/panel/`                                         | the browser suites for the read-only status page, 6 files / 41 specs                                                                                                                                                           |
| `stapled-factory/`, `docs/planning/stapled-factory/` | **deleted 2026-11-01** — the previous system's code and plans. Nothing here depends on them; the surviving lessons are in `findings.md`. A `.local-ci/` directory survives as an empty shell (a `.DS_Store` and nothing else). |

## If you only read one thing

Read the audit's §3 table (phases 1–14 and 9a–9e) before believing any "done" elsewhere, then read
its §9 and §10 addenda for what that table got wrong. The rule it applies is the one to keep
applying: **a claim with no test is `UNPROVEN`, never `met`.**
