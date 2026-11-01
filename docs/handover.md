# Handover

For whoever takes this repository next. Written against the tree that exists, not the plan set that
imagined it: the audit [`docs/planning/dark-factory-dsh/phase-13-audit.md`](planning/dark-factory-dsh/phase-13-audit.md)
is the source of truth for what is real, and where a plan promised something this tree does not have,
the audit says so and this document repeats it rather than smoothing it over.

## What to run before touching anything

```bash
export PATH="$HOME/.nvm/versions/node/$(cat .nvmrc)/bin:$PATH"   # 26.12.1, or preflight fails
pnpm install
pnpm run preflight          # node version, package layout, the pinned dsh expectation
bash scripts/verify.sh      # preflight → typecheck → lint → format:check → test → build → panel
pnpm run factory version    # dsh expected/observed, policy hash, executor availability, home
```

The `panel` stage runs the 41 browser specs; if the chromium build `@playwright/test` pins is
missing it **fails** with the remedy (`npx playwright install chromium`) rather than skipping,
because a panel the README calls shipped and a gate that never opens it is a claim nobody checked.

`bash scripts/verify.sh` writes `docs/verification/<run-id>/{verify.log,summary.json}`, and the
summary records the commit it measured and whether a model key was present — a green line is a
reproducible artifact, not a memory. The most recent recorded run at the time of writing
(`docs/verification/2026-11-01T15-51-24Z/`) reports **6 passed, 1 skipped, 0 failed**, with
`BIFROST_API_KEY: false` and `dsh` present.

If a stage is red before you have changed anything, it is not yours: check `git status` and whether
another agent is mid-edit in that package. Do not "fix" a red stage by weakening a test.

## The four never-regress controls, and where each is tested

These are the four properties the whole design rests on. If a change makes one of them false, the
change is wrong no matter how green the rest is.

| Control                                                            | Test that proves it (run these by name)                                                                                                                                                                            |
| ------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| **A sabotage that passes its own visible suite is still rejected** | `e2e/cli/default/09-holdout-sabotage.test.ts` — `describe('E2E-29: a change that passes its own suite but fails the holdout is rejected')`                                                                         |
| **`unknown` never satisfies a gate**                               | `e2e/cli/default/07-seams.test.ts` — "refuses a fake pass unsigned, and refuses it signed too"; `e2e/panel/unknown-not-pass.spec.ts` (browser)                                                                     |
| **Nothing is silently re-dispatched**                              | `e2e/cli/default/06-recover.test.ts` — "an attempt with no terminal event becomes ambiguous, and is not retried"; `07-seams.test.ts`; `13-effect-outbox.test.ts` — "retries after the lease expires, exactly once" |
| **An unsigned promotion writes nothing and keeps exit 5**          | `e2e/cli/default/04-gates.test.ts` — "refuses an unsigned promotion, writes no artifact, and keeps exit 5"; `08-real-wall.test.ts`                                                                                 |

Run them alone with vitest:

```bash
pnpm exec vitest run e2e/cli/default/09-holdout-sabotage.test.ts
pnpm exec vitest run e2e/cli/default/06-recover.test.ts e2e/cli/default/13-effect-outbox.test.ts
pnpm exec vitest run e2e/cli/default/04-gates.test.ts
```

The browser half of the panel is Playwright (`pnpm run test:e2e:panel`, 41 specs across 6 files).
It needs Playwright's chromium **revision 1248** — `pnpm exec playwright install chromium` on a
machine that is allowed to download. Without it the suite cannot start, which is why the panel stage
is deliberately absent from `scripts/verify.sh` rather than green-by-omission.

## Known-open decisions (do not close these by accident)

From [`findings.md` §NEEDS_HUMAN_DECISION](planning/dark-factory-dsh/findings.md), argued in full in
`architecture.md` §11. Each is a **claim-blocker, not a ship-blocker**: the code is correct under
either answer; what changes is the sentence you are allowed to say. None of them may be closed by an
agent.

| #   | Open decision                                                                   | Default if unanswered                                                                       |
| --- | ------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------- |
| ND1 | Certification operating point (trial unit, m, k, per-scenario quorum, α and β)  | No pass-rate claim at all; the wall reports measured Δ and names the point as undecided     |
| ND2 | Verdict-store placement and whether a second OS uid ships in v1                 | One host, one uid, one store; "two failure domains" stays withdrawn                         |
| ND3 | Proxy metering semantics (what is counted, where the signed usage record lands) | Spend is an estimate with `unknown` propagated; ceilings **refuse** but do not **enforce**  |
| ND4 | Off-host anchor scope for v1.1                                                  | Nothing ships in v1; a local watermark cannot detect the coordinated rollback it exists for |

## Skipped suites, and why (not by omission)

| Suite                                             | Skips when                            | Why it is not green                                                                  |
| ------------------------------------------------- | ------------------------------------- | ------------------------------------------------------------------------------------ |
| `packages/wall/src/container.test.ts` (`@docker`) | always in v1                          | no wall image ships; the container runner is the intended production path            |
| `e2e/cli/docker/07-isolation.test.ts` (`@docker`) | always in v1                          | wall image and credential proxy unshipped — placeholder body, `expect.unreachable()` |
| `e2e/cli/live/08-model.test.ts` (`@live`)         | `BIFROST_API_KEY` unset (i.e. always) | no live model call in tests: C5, and a paid call is not a repeatable measurement     |
| `packages/dsh-adapter/tests/profile.test.ts`      | no `dsh` on `PATH`                    | the DSH-facing half is proven by adapter tests plus one recorded probe               |
| `preflight` stage in `scripts/verify.sh`          | no `dsh` on `PATH`                    | recorded as **SKIPPED with a reason** in the summary, never silently passed          |
| `pnpm run test:e2e:panel`                         | browsers not installed (rev 1248)     | not part of `verify.sh`; see above                                                   |

## What is not built (so you do not look for it)

From the audit, in its own words — **GAP-003** and **GAP-004** are open; GAP-001 and GAP-002 were
closed by `bf24f6a` and `b92f5cc`.

- **No credential proxy** (`packages/proxy` does not exist) and no normalised destructive-command
  classifier; privileged operations are _refused_, not brokered. `factory credential`'s help text
  mentions an "opaque proxy token" — there is no proxy behind it in v1 (ADR-006).
- **No scheduler, no worker slots, no capacity ceiling.** One unit per `factory run`; nothing
  dispatches on a timer.
- **No budget enforcement** — ceilings refuse dispatch; nothing meters the gateway (ND3).
- **No wall image / container runner in CI**, **no live DSH turn in CI**, **no off-host anchor**.
- No `factory outbox`, no `factory unlock`, no `quarantine --clear`, no `intent --revision`, no
  `run --retry` (documented as unavailable in v1). `factory recover` has **no** `--observe` flag
  even though its LIMITS text mentions one — observe with `factory status <unit> --attempt <id>`.
- `recover`'s ambiguity hint prints `--attempt ambiguous` (the state) where the attempt id belongs;
  use the id from the `A-…` line.

## The three commands that prove the repo is healthy

```bash
bash scripts/verify.sh          # 6 stages + 1 explained skip; exit 0 only if the code is green
pnpm run factory version        # runtime, dsh expected vs observed, executor availability
pnpm exec vitest run e2e/cli/default   # 16 files, 77 tests: 01-intent … 13-effect-outbox
```

If those three pass and `git status` is clean, the tree is in the state this handover describes.
Anything beyond that — a live model turn, a container-isolated wall, a browser suite — is
environment you must supply, and the summaries say so.

## Where things are

| Path                                                               | What it is                                                                                                                               |
| ------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------- |
| `docs/adr/`                                                        | the six decisions the design rests on, with the alternatives rejected and why                                                            |
| `docs/runbooks/`                                                   | five 2am procedures (start with [`README.md`](runbooks/README.md))                                                                       |
| `docs/planning/dark-factory-dsh/`                                  | the plan set: findings, data map, stories, architecture, UX/UI, e2e plan, and the audit                                                  |
| `docs/verification/<run-id>/`                                      | recorded `verify.sh` runs, with the commit and environment they measured                                                                 |
| `packages/`, `apps/`                                               | 8 packages, 2 apps; `packages/dsh-adapter` is the only code that imports DSH                                                             |
| `e2e/cli/default/`                                                 | the operator suites, numbered by the e2e plan                                                                                            |
| `e2e/panel/`                                                       | the browser suites for the read-only status page                                                                                         |
| `stapled-factory/`, `docs/planning/stapled-factory/`, `.local-ci/` | **deleted 2026-11-01** — the previous system's code and plans. Nothing here depends on them; the surviving lessons are in `findings.md`. |

## If you only read one thing

Read the audit's §3 table (phases 1–14 and 9a–9e) before believing any "done" elsewhere. The rule it
applies is the one to keep applying: **a claim with no test is `UNPROVEN`, never `met`.**
