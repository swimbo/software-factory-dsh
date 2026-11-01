# Phase 9 evidence — implementation 9a–9e

Every claim below is a command with its output. Nothing here is "it should work".

## The gate that covers all of Phase 9

```
$ export PATH="/Users/bo/.nvm/versions/node/v26.12.1/bin:$PATH"
$ bash scripts/verify.sh
preflight     PASS    0     0.12s     bash scripts/preflight.sh
typecheck     PASS    0     0.37s     pnpm run typecheck
lint          PASS    0     0.30s     pnpm run lint
format:check  PASS    0     2.83s     pnpm run format:check
test          PASS    0     24.20s    pnpm exec vitest run
build         PASS    0     0.37s     pnpm run build
live-model    SKIPPED 0     0.00s     pnpm run test:live   (BIFROST_API_KEY unset)

verify: 6 passed, 1 skipped, 0 failed — OK
verify: log docs/verification/2026-11-01T14-53-28Z/verify.log
```

```
$ npx vitest run
 Test Files  57 passed | 2 skipped (59)
      Tests  972 passed | 10 skipped (982)
```

## Per sub-phase

| Phase | Deliverable                                                                                                                                                                                                                                                               | Suite          | Evidence                                                                                                                                                                                                                        |
| ----- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 9a    | `packages/contracts` (canonical JSON, 23 error codes → exit codes, 16 events, state machine, receipts, verdicts, lanes, `status.v1`), `packages/store` (SQLite, append-only triggers, lease/cache guards, `audit()` replay), `packages/core` (engine, no auto-redispatch) | 121 + 60 + 50  | `npx vitest run packages/contracts packages/store packages/core` → all green; `audit().divergences === []` asserted after every flow                                                                                            |
| 9b    | `packages/dsh-adapter` — five-entry overlay, NDJSON, watchdog group-kill, self-contained clone at the identical absolute path, per-attempt `DSH_HOME`, `--internal` two-member network                                                                                    | 130            | `egress.test.ts`: six negatives blocked **and** the proxy reachable by name (the control that distinguishes a boundary from a dead network); `env -u BIFROST_API_KEY FACTORY_DSH_BIN=/nonexistent/dsh` → 124 passed / 6 skipped |
| 9c    | `packages/wall` — holdout re-execution, Δ from its own run, faithfulness, signed verdicts, criteria log, 9-case self-test                                                                                                                                                 | 125            | `node packages/wall/src/cli.ts self-test` → **9 of 9 expectations met**, exit 0; ten mutation checks each turned exactly one test red and were restored byte-identically                                                        |
| 9d    | `packages/qualifier` (six signals + security lock), `packages/effects`, `packages/gates` (signed promotion, budget phrase, credential broker)                                                                                                                             | 109 + 28 + 101 | security lock proven in both directions (a perfect score cannot rescue a security-relevant unit; a reject cannot be softened); unsigned promotion writes **no file** (`existsSync === false` and empty directory asserted)      |
| 9e    | `apps/cli` (12 verbs, exit codes 0–9, `--json`), `apps/panel` (read-only status page, `status.v1`)                                                                                                                                                                        | 95 + 116       | `node apps/cli/src/main.ts --help` exit 0 naming `dsh 0.2.1-rc.3`; `status --json` validated by `parseStatus()`; panel serves `/api/status` 200 with a token, 401 without, 405 on `POST`                                        |

## The four controls that must never regress

1. **Sabotage is rejected.** A change that passes its own visible tests but fails the holdout is `fail:holdout_failed` (corpus case a). Mutation-checked: removing the check turns exactly that test red.
2. **`unknown` never satisfies a gate.** `VERDICT_UNKNOWN` is raised _after_ the verdict row commits (so evidence is never rolled back); DB CHECK plus `assertVerdictIsEarned` plus `gateSatisfied` all refuse it; `status` exits 5 with the words "not a pass".
3. **No auto-redispatch.** `recover` marks expired attempts `ambiguous` and the code explains why a re-run cannot reach `assertDispatchable` — `aborted` and `ambiguous` are not `qualified`.
4. **Nothing is promoted without a signature.** An unsigned promotion writes no file, and a promotion whose verdict belongs to another unit is `RECEIPT_CONFLICT`.

## Deliberate reds at the close of Phase 9

Both were configuration, not code, and both are now green:

- `lint` — no `eslint.config.*` existed, and `typescript-eslint` cannot load under TypeScript 7.0. Resolved by replacing the stage with `scripts/discipline-lint.sh` (seven checks) and amending `tech-guide.md` §56 to say why.
- `format:check` — no `.prettierignore`, so prettier walked 17 k vendored venv files; with the ignore in place, 299 project files were reformatted in one pass.

## What Phase 9 does not prove

- The wall is **not** shown to be safe. It is independent, deterministic where possible, adversarially tested against itself, and human-audited on a schedule — that is the whole claim (`architecture.md` §11).
- No pass rate is certified. Three runs per scenario damp flakes; the α/β table in `packages/wall/README.md` is why.
- Spend is **not** enforced — the ceiling is best-effort until the credential proxy meters (`NEEDS_HUMAN_DECISION` ND3).
