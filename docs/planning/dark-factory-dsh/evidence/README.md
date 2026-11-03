# Verification evidence, by phase

The rule this index exists to enforce: **a claim with no test is `UNPROVEN`, never `met`.** Each row
names the artefact you can open and the command you can re-run. Where a phase has no separate evidence
file, the proof lives in the suites and in `phase-13-audit.md`'s verdict for that phase — that is
stated rather than implied.

The whole-tree gate at the time of writing: `bash scripts/verify.sh` → **7 passed, 1 skipped, 0 failed**
(preflight, typecheck, lint, format:check, test, build, panel; `live-model` skipped without a key), test
stage **1522 passed | 8 skipped (1530)** across 102 passed files, measured at `8471435`
(`docs/verification/2026-11-03T02-47-40Z/`), with all `@docker` suites running — note that the
same command reports `0 failed` with those eleven specs *skipped* when the Docker daemon is stopped, so
read the skip count, not only the failure count. Every run writes
`docs/verification/<run-id>/{verify.log,summary.json}`, and the summary names the commit it measured.

| Phase | What it produced                                                                                           | Evidence                                                                                             | Re-run                                                            |
| ----- | ---------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------- |
| 1     | `phased-plan.md`, `findings.md`                                                                            | audit verdict `met`; findings sections per stage                                                     | —                                                                 |
| 2     | pain points, `research/pain-points.md`                                                                     | audit `met`                                                                                          | —                                                                 |
| 3     | `data-map.md`                                                                                              | audit `met`; §2.20 carries a reality check where the described table does not exist                  | `grep -rn gate_decision packages/store/src`                       |
| 4     | `user-stories.md`                                                                                          | audit `met`                                                                                          | `grep -c '\*\*As an\*\*' user-stories.md`                         |
| 5     | `architecture.md` + §11 debate outcomes, `consensus-plan.md`, `evidence-ledger.md`, `debate-transcript.md` | audit `met`; ND1–ND4 recorded with defaults in `findings.md`                                         | —                                                                 |
| 6     | `tech-guide.md` (§56 amended: lint replaced)                                                               | audit `met`                                                                                          | `bash scripts/discipline-lint.sh`                                 |
| 7     | `ux-plan.md` (six exit classes, silence by default)                                                        | audit `mostly met`; exit-code table is normative                                                     | `e2e/cli/default/05-status.test.ts`                               |
| 8     | `ui-plan.md` (read-only page, token/contrast pairs)                                                        | 41 browser specs + 117 panel unit tests                                                              | `pnpm run test:e2e:panel`                                         |
| 9a    | `packages/store`, `packages/core`                                                                          | [`phase-9-implementation.md`](phase-9-implementation.md)                                             | `npx vitest run packages/store packages/core`                     |
| 9b    | `packages/dsh-adapter`                                                                                     | [`phase-9b-dsh-integration-probe.md`](phase-9b-dsh-integration-probe.md)                             | `npx vitest run packages/dsh-adapter`                             |
| 9c    | `packages/wall` (holdout, Δ, three runners)                                                                | `packages/wall/src/*.test.ts`; `factory wall self-test` 9/9                                          | `npx vitest run packages/wall`                                    |
| 9d    | `packages/qualifier`, `packages/gates`, `packages/proxy`                                                   | suites; ADR-006 records what the proxy cannot see                                                    | `npx vitest run packages/qualifier packages/gates packages/proxy` |
| 9e    | `apps/cli`, `apps/panel`                                                                                   | `e2e/cli/default/*` (process) + `e2e/panel/*` (browser)                                              | `pnpm run test:e2e`                                               |
| 10    | `e2e-tests.md` + the suites                                                                                | [`phase-10-implementation.md`](phase-10-implementation.md) — including the two layers that never ran | `pnpm run test:e2e`                                               |
| 11    | the evidence run                                                                                           | [`phase-11-verification.md`](phase-11-verification.md) — per layer, with `UNKNOWN` named             | `bash scripts/verify.sh`                                          |
| 12    | `README.md`, `AGENTS.md`, `CHANGELOG.md`, `docs/adr/`, `docs/runbooks/`, `docs/handover.md`                | every runbook command executed; audit GAP-005 closed                                                 | walk `docs/handover.md`                                           |
| 13    | the audit itself                                                                                           | [`phase-13-audit.md`](../phase-13-audit.md) — 18 plans, 469 boxes reconciled                         | —                                                                 |
| 14    | the fixes                                                                                                  | `git log` from `b92f5cc` onward; gap table in `findings.md > Phase 14`                               | `bash scripts/verify.sh`                                          |
| 15    | alerts, the ND3 ceiling through the real executor, the worker's container, the recover-side orphan sweep, and the docs truth pass | [`phase-15-round.md`](phase-15-round.md) — gate id, the 11 docker specs, the mutation check, and what is still not built | `bash scripts/verify.sh`; `npx vitest run e2e/cli/docker`         |
| 16    | `factory gate` (mint/verify a decision, one-use across processes, schema v4), `alerts --notify`, `CONFIGURATION_CONFLICT`, and the docker specs' container-ownership fix | [`phase-16-round.md`](phase-16-round.md) — the gate table incl. the two red runs, the three-run proof, nine mutation checks, and the disclosures (store migration v4, re-spliced transcript) | `bash scripts/verify.sh`; `npx vitest run e2e/cli/default/19-gate-decisions.test.ts apps/cli/src/alerts.test.ts` |
| 17    | the `--internal` bridge measured (impossible on macOS/OrbStack, viable on native Linux), the additive `privileged_replay_refused`, bounded webhook bodies, and the key in a `0600` file | [`phase-17-round.md`](phase-17-round.md) — the both-directions measurement table, the three mutation checks, and the disclosure about the "no key" scare | `bash scripts/verify.sh`; `npx vitest run e2e/cli/docker packages/credential-proxy` |

## The four never-regress controls, and where each is proven

| Control                                                      | Proof                                                                                                 |
| ------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------- |
| A sabotage that passes its own visible suite is **rejected** | `e2e/cli/default/09-holdout-sabotage.test.ts` — measured Δ 1 → 0, no artifact under a valid signature |
| `unknown` never satisfies a gate                             | `e2e/cli/default/07-seams.test.ts` (signed unknown still exit 5) and `08-real-wall.test.ts`           |
| No auto-redispatch on recovery                               | `07-seams.test.ts` (real `SIGKILL` → `ambiguous`, one attempt) and `13-effect-outbox.test.ts`         |
| Nothing is promoted without a signature                      | `08-real-wall.test.ts` — unsigned refused, `artifacts/` absent                                        |

## What is **not** evidenced

- ~~The `@live` specs~~ — **measured** (2026-11-01): both pass against the operator's Bifrost program
  key, the full gate with `FACTORY_VERIFY_LIVE=1` is `8 passed, 0 skipped, 0 failed`, and the ND3
  spend ceiling is crossed on one real turn (`e2e/cli/live/09-ceiling.test.ts`). See
  [`phase-15-round.md`](phase-15-round.md) §4 and `docs/verification/2026-11-01T21-58-16Z/`. Re-running
  the live stage costs money, which is why it is opt-in rather than part of the default gate.
- ~~The worker's container~~ — **measured** since `36e2ddd`: `e2e/cli/docker/08-worker-container.test.ts`
  (3 specs) runs the turn inside `factory-env` and kills it mid-attempt (E2E-45), and
  `09-recover-sweep.test.ts` (2 specs) proves the orphan is swept by the next `recover`. Both need
  `factory-env:rc5` built (`docker build --tag factory-env:rc5 docker/factory-env`); without it they
  skip with the build command in the suite name, never pass.
- ~~The browser suite in the acceptance gate~~ — **resolved**: the `panel` stage is part of
  `verify.sh` and `chromium-1248` is installed; a missing browser **fails** the stage with the remedy.
  41 specs run (9.1 s in the run above).
