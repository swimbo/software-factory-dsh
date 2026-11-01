# Verification evidence, by phase

The rule this index exists to enforce: **a claim with no test is `UNPROVEN`, never `met`.** Each row
names the artefact you can open and the command you can re-run. Where a phase has no separate evidence
file, the proof lives in the suites and in `phase-13-audit.md`'s verdict for that phase — that is
stated rather than implied.

The whole-tree gate at the time of writing: `bash scripts/verify.sh` → **6 passed, 1 skipped, 0 failed**
(preflight, typecheck, lint, format:check, test, build; `live-model` skipped without a key), test stage
**1117 passed | 6 skipped (1123)** across 78 files. Every run writes
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

## The four never-regress controls, and where each is proven

| Control                                                      | Proof                                                                                                 |
| ------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------- |
| A sabotage that passes its own visible suite is **rejected** | `e2e/cli/default/09-holdout-sabotage.test.ts` — measured Δ 1 → 0, no artifact under a valid signature |
| `unknown` never satisfies a gate                             | `e2e/cli/default/07-seams.test.ts` (signed unknown still exit 5) and `08-real-wall.test.ts`           |
| No auto-redispatch on recovery                               | `07-seams.test.ts` (real `SIGKILL` → `ambiguous`, one attempt) and `13-effect-outbox.test.ts`         |
| Nothing is promoted without a signature                      | `08-real-wall.test.ts` — unsigned refused, `artifacts/` absent                                        |

## What is **not** evidenced

- ~~The 2 `@live` specs~~ — **now measured** (2026-11-01): both pass against the operator's Bifrost
  program key, and the full gate with `FACTORY_VERIFY_LIVE=1` is `7 passed, 0 skipped, 0 failed`. See
  [`phase-9b-live-model-probe.md`](phase-9b-live-model-probe.md). Re-running it costs money, which is
  why the stage is opt-in rather than part of the default gate.
- **The DSH worker inside the wall container** (E2E-43/44/45/46 as originally worded) — the worker
  image and the credential proxy container are not part of this build. The isolation layer those ids
  depend on **is** measured (`e2e/cli/docker/07-isolation.test.ts`, 6 specs, 5 mutation checks).
- **The browser suite in the acceptance gate** — Playwright needs chromium revision 1248; this host's
  cache stops at 1243, so the stage would fail for a missing download rather than a red spec.
