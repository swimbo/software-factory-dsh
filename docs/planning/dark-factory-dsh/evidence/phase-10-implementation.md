# Phase 10 — completion evidence (2026-11-01)

**Status:** complete for the offline layers; two layers are honestly `SKIPPED` and are counted as `unknown`, never as pass.

`scripts/verify.sh` at `docs/verification/2026-11-01T15-29-43Z/summary.json` names the tree it measured (`git.head`), which is the property that makes this evidence checkable rather than a claim.

## What the phase said it would produce, and where it is

| Artifact                                             | Path                                                     | State                                                |
| ---------------------------------------------------- | -------------------------------------------------------- | ---------------------------------------------------- |
| Test plan with the 8 mandatory adversarial scenarios | `e2e-tests.md` (632 lines, §5 is the eight)              | written                                              |
| CLI/process suite                                    | `e2e/cli/default/01…09-*.test.ts` (9 files)              | **57 passed, 6 skipped**                             |
| Browser suite                                        | `e2e/panel/*.spec.ts` (6 files) + `playwright.config.ts` | **41 passed**                                        |
| Docker isolation suite                               | `e2e/cli/default/04-gates` `@docker` tags                | **skipped** (no wall image on this host)             |
| Live-model suite                                     | `@live` tags                                             | **skipped** (`BIFROST_API_KEY` unset, constraint C5) |

The verified correction holds: **Playwright is browser-only**, so the CLI is exercised by vitest 5 + `node:child_process` (spawn the real binary, assert exit code and `--json`), and Playwright covers only the read-only page. No CLI test imports the panel's code and no browser test shells out to prove a CLI fact.

## The eight adversarial scenarios

| Id     | Scenario                                                 | State                              | Proof                                                                                                                                                                                          |
| ------ | -------------------------------------------------------- | ---------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| E2E-29 | sabotage passes its own suite → **rejected**             | closed                             | `09-holdout-sabotage.test.ts:1-3` — visible suite green, receipt faithful, holdout disagrees, `holdout_failed`, Δ 1 → 0, no artifact even with a signature                                     |
| E2E-30 | claimed commands do not reproduce → `receipt_unfaithful` | closed                             | `08-real-wall.test.ts` — worker claims exit 0 for a command that exits 1; the wall's re-execution disagrees                                                                                    |
| E2E-31 | kill -9 mid-attempt → `ambiguous`, no second attempt     | closed                             | `07-seams.test.ts` — spawn, `SIGKILL`, `recover` ⇒ ambiguous, one attempt row, second `recover` exits 0 with `still ambiguous: 1`                                                              |
| E2E-32 | re-running `run` does not create a second attempt        | closed, with a divergence recorded | `07-seams`/`04-gates`; `recover`'s idempotent exit 0 vs the unit staying ambiguous is asserted as observed, named in-code                                                                      |
| E2E-33 | leak test: holdout store, Bifrost key, signing key       | **partly**                         | `@default` half asserts the holdout id never reaches the verdict; the filesystem/network half is `@docker` and **skipped**                                                                     |
| E2E-26 | budget ceiling refuses dispatch                          | closed offline                     | `04-gates` with `FACTORY_EXECUTOR=fake`                                                                                                                                                        |
| E2E-25 | `unknown` never promotes                                 | closed, exit code amended          | `08-real-wall` (unknown → exit 5, a person decides) and `07-seams` (fake wall path → 4, nothing recorded); the doc's "exit 4" was wrong for the recorded case and `run` now distinguishes them |
| E2E-44 | credential proxy leak (`@docker`)                        | **skipped**                        | needs the proxy container; tagged, not faked                                                                                                                                                   |

## Totals at this commit

```
pnpm exec vitest run       64 files (62 passed, 2 skipped)   1017 passed, 10 skipped
pnpm run test:e2e          e2e/cli   57 passed, 6 skipped
pnpm run test:e2e:panel    e2e/panel 41 passed
verify: 6 passed, 1 skipped, 0 failed
```

## What this phase does **not** prove

- **The 4 `@docker` specs have never run on this host.** They are tagged, counted as skipped, and no claim depends on them; the isolation properties they would check are asserted in `packages/wall/README.md`'s limitations table as **not provided by the local runner**.
- **The 2 `@live` specs have never run.** No paid model call is part of any gate (C5), so the "DeepSeek via Bifrost" claim is proven by configuration and adapter tests, not by a live turn.
- **The browser suite is not in `verify.sh`.** Playwright 1.64.1 needs chromium revision 1248; this host's cache stops at 1243, so the stage would fail for a missing download rather than a red spec. The enable line is recorded in `progress.md`. A green result on another host is therefore _claimed_ here, not _reproduced_ by the acceptance script.
