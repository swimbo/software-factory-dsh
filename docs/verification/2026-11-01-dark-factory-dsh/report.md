# Verification — dark software factory (DSH), Phases 11–12

**Plan:** `docs/planning/dark-factory-dsh/`
**Harness:** `scripts/verify.sh` (`pnpm run test:verify`)
**Run reported:** `2026-11-01T14-40-27Z` (09:40 local, America/New_York)
**Verdict:** **4 passed, 1 skipped, 2 failed — NOT OK.** Two stages cannot pass in this
repository as it stands, for reasons that are configuration, not code: there is no ESLint
config, and prettier has never been applied (and is pointed at a 353 MB vendored Python venv).
Everything that measures the code — preflight, typecheck, the 938-test suite, build — is green.

This file is the evidence report, not a summary of intentions. Every claim below is backed by a
log in `runs/`.

---

## 1. How to run it

```bash
export PATH="/Users/bo/.nvm/versions/node/v26.12.1/bin:$PATH"   # .nvmrc pins 26.12.1
pnpm run test:verify            # or: bash scripts/verify.sh
bash scripts/verify.sh --json   # machine-readable summary on stdout, nothing else
bash scripts/verify.sh --out-dir docs/verification/my-run
```

The harness is one command, fail-closed, and makes no network call. It runs six gates in merge
order — `preflight → typecheck → lint → format:check → test → build` — plus one informational
row (`live-model`). It prints a per-stage PASS/FAIL/SKIPPED table with the exact command and
exit code, writes `verify.log` (full output of every stage) and `summary.json` (machine
readable) to `docs/verification/<timestamp>/`, and exits non-zero if any stage failed.

`--json` prints the summary document on stdout and moves everything else to stderr; the
harness's human output goes to `verify.log` either way. Verified by parsing stdout as JSON
(`schema: verify/1`, 7 stage rows) with nothing else in the stream.

The ambient toolchain is used deliberately: run it under an older node and `preflight` fails,
which is the intended outcome (node 22 is an error here, never a fallback).

## 2. The table (final run `2026-11-01T14-40-27Z`)

| stage          | status   | exit | duration | command                     |
| -------------- | -------- | ---- | -------- | --------------------------- |
| `preflight`    | PASS     | 0    | 0.12 s   | `bash scripts/preflight.sh` |
| `typecheck`    | PASS     | 0    | 0.38 s   | `pnpm run typecheck`        |
| `lint`         | **FAIL** | 2    | 0.32 s   | `pnpm run lint`             |
| `format:check` | **FAIL** | 1    | 23.43 s  | `pnpm run format:check`     |
| `test`         | PASS     | 0    | 26.45 s  | `pnpm exec vitest run`      |
| `build`        | PASS     | 0    | 0.36 s   | `pnpm run build`            |
| `live-model`   | SKIPPED  | —    | —        | `pnpm run test:live`        |

Whole run ≈ 47 s of which 45 s is `prettier` walking the tree and `vitest` running the suite.
Evidence: [`runs/final/verify.log`](runs/final/verify.log),
[`runs/final/summary.json`](runs/final/summary.json). `summary.json` carries node/pnpm/git
identity, dsh version and path, model-key presence (never values), per-stage exit codes and
durations, and an `unknowns` array listing every skipped stage with its reason.

## 3. What each green stage actually proves

**`preflight` — PASS.** `preflight: node 26.12.1 ok` /
`preflight: dsh 0.2.1-rc.3 at /Applications/DeepSeek Harness.app/…/bin/dsh`. Proves the runtime
is inside the tested window (`>=24.9 <27`) and the pinned harness binary is present and
executable. It does not prove the harness _works_ — no model call is made here or anywhere in
this harness.

**`typecheck` — PASS.** `tsc -p tsconfig.json --noEmit`, no output. Proves the 2026-11-01 tree
typechecks under `strict` + `exactOptionalPropertyTypes` + `erasableSyntaxOnly`. Scope is
`packages/**`, `apps/**`, `e2e/**` — `stapled-factory/` and `worker/` are outside the project.

**`test` — PASS.** `pnpm exec vitest run`: **51 files, 934 passed, 4 skipped (938), 26 s.**
The 4 skips are docker-gated tests (`container.test.ts`) that report `unknown`, not pass — see
§4. This is the real gate: contracts, qualifier, gates, wall, store, effects, dsh-adapter, CLI,
panel.

**`build` — PASS.** `tsc -p tsconfig.build.json`, 259 files emitted to the gitignored `dist/`.
Proves the shippable subset compiles with declarations. It is **not** a second typecheck: see
finding F3.

## 4. Skipped stages — the `unknown` ledger

Phase 11's law is that a skipped test is `unknown`, never a pass. The harness keeps `skipped`
out of the pass count and lists it in `summary.json.unknowns`.

| row          | when                      | reason                                                                                                                                                                                                                                               |
| ------------ | ------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `live-model` | every run                 | `BIFROST_API_KEY` is not set; live model calls are excluded from this harness **by design** (no network). When the key _is_ set the row still does not run — it reports that live calls are out of scope and points at `pnpm run test:live` by hand. |
| `preflight`  | only when no `dsh` exists | preflight refuses to pass without the harness binary; the run classifies that as an environment gap, not a code failure (node still has to be in the tested window for this to apply). Demonstrated in §5.                                           |

Live DSH model calls are **UNVERIFIED on this machine**. Nothing in this report should be read
as evidence that a dark unit would complete against a real model.

## 5. The two environment-constraint checks

Both were run to completion with the same harness; the only failures in either are the two
configuration reds of §6, which are independent of the environment.

### 5a. Suite passes with no `BIFROST_API_KEY`

```bash
env -u BIFROST_API_KEY -u DEEPSEEK_API_KEY -u OPENAI_API_KEY -u ANTHROPIC_API_KEY \
  bash scripts/verify.sh --out-dir docs/verification/2026-11-01-dark-factory-dsh/runs/no-api-keys
```

| stage        | status   | exit | evidence                        |
| ------------ | -------- | ---- | ------------------------------- |
| preflight    | PASS     | 0    | node 26.12.1, dsh 0.2.1-rc.3    |
| typecheck    | PASS     | 0    | no diagnostics                  |
| lint         | FAIL     | 2    | no ESLint config (§6a)          |
| format:check | FAIL     | 1    | 1326 files (§6b)                |
| test         | **PASS** | 0    | **934 passed, 4 skipped (938)** |
| build        | PASS     | 0    | 259 files                       |
| live-model   | SKIPPED  | —    | `BIFROST_API_KEY` not set       |

`934 passed` is identical to the key-present run: no test in the suite reads the key.
Evidence: [`runs/no-api-keys/verify.log`](runs/no-api-keys/verify.log).

### 5b. Suite passes with no `dsh` on PATH

```bash
env -i HOME="$HOME" PATH="/usr/bin:/bin:/usr/sbin:/sbin:…node:…local/opt/node/bin" \
  FACTORY_DSH_BIN=/nonexistent/dsh \
  bash scripts/verify.sh --out-dir docs/verification/2026-11-01-dark-factory-dsh/runs/no-dsh
```

`command -v dsh` in that PATH prints nothing. `preflight` exits 8 with
`preflight: dsh binary not found or not executable: /nonexistent/dsh`.

| stage     | status   | exit | evidence                                                  |
| --------- | -------- | ---- | --------------------------------------------------------- |
| preflight | SKIPPED  | 8    | dsh absent; node in window → environment gap, not failure |
| typecheck | PASS     | 0    | no diagnostics                                            |
| test      | **PASS** | 0    | **925 passed, 13 skipped (938)** — 9 more skips than §5a  |
| build     | PASS     | 0    | 259 files                                                 |

The 9 extra skips are the dsh-dependent tests (`packages/dsh-adapter/tests/profile.test.ts`
skips when the pinned binary is absent). So the suite runs and passes without the harness
installed; it just proves less, and says so. Evidence:
[`runs/no-dsh/verify.log`](runs/no-dsh/verify.log).

## 6. The two red stages — root cause and the exact fix

Neither is a code failure, and neither is papered over: I did not add config files to make the
table green, because both are policy decisions and one needs a dependency I cannot install
offline.

### 6a. `lint` cannot run — there is no ESLint config

```
$ pnpm run lint
> eslint .
Oops! Something went wrong! :(
ESLint: 10.14.0
ESLint couldn't find an eslint.config.* file.
```

`eslint` (10.14.0) is installed and `pnpm run lint` is the canonical command in
`tech-guide.md` §7, but no `eslint.config.*` exists anywhere in the repo — the command has never
been runnable. `tech-guide.md` §56 specifies `@typescript-eslint` + `eslint-plugin-import-x`;
`typescript-eslint` 8.72.1 is a declared devDependency, **`eslint-plugin-import-x` is not**, and
the harness may not use the network. Fix: add a flat config plus that one dependency (or amend
§56 to drop the import-ordering plugin), then this row turns green or starts reporting real
lint findings — either way it becomes informative.

### 6b. `format:check` has never passed — 1326 files, two causes

```
$ pnpm run format:check
[warn] … (1326 lines)
[warn] Code style issues found in 1326 files. Run Prettier with --write to fix.
```

1. **No `.prettierignore`.** `prettier --check .` walks `stapled-factory/worker/.venv`, a 353 MB
   vendored Python environment of 17,074 files that lives inside the tree and is not gitignored
   (`.gitignore` covers `node_modules/` and `dist/` only). 1012 of the 1326 warnings come from
   there, and the walk costs 23–56 s per run.
2. **The project's own files were never formatted.** With a correct ignore file, **281 files
   are still unformatted**: 185 under `docs/`, 71 under `packages/`, 21 under `apps/`, plus
   `README.md`, `pnpm-lock.yaml` and one stray root report. Prettier was declared in
   `devDependencies` and `format:check` declared in `scripts`, but the format pass was never
   run across the tree.

I did not run `prettier --write`: it would touch every package while other agents are mid-edit,
and it is a one-time-reformat decision, not a verification step. Fix is yours to choose:
ignore file + one reformat commit (blocks every teammate's diff briefly), or scope the gate to
changed files.

## 7. What this suite does **not** prove

The harness covers the six canonical gates. It does not cover these Phase 11 items, and their
absence is a gap, not a pass:

- **`@docker` isolation suite** (`pnpm test:docker`) — the script exists but is a **dead flag**:
  nothing in the tree reads `FACTORY_TAGS` (finding F1). Docker-gated tests instead gate on
  `dockerAvailable()` and therefore run in the _default_ suite on this machine. The isolation
  claims (egress allowlist, holdout leak, signing-key absence) are only as strong as those tests
  running, and they are not run in isolation from the rest of the suite.
- **Panel Playwright suite** (`pnpm test:e2e:panel`) — not run by this harness, and never run in
  this report. `unknown`-renders-as-non-success is unverified here.
- **`kill -9` chaos test** — not run. Ambiguity-never-redispatched, one-effect-per-idempotency-key:
  unverified by this report.
- **`factory audit` traceability** — not run. "Every promotion resolves to a signed verdict" is
  unverified here.
- **`pnpm run dogfood`** and the throughput NFR — not run under this harness, so no wall-clock
  timing exists in this report.
- **Live model calls** — UNVERIFIED (no key, no network).
- **P0 user-story walkthrough, dark-pattern audit, accessibility spot-check** — human work,
  untouched.
- **Coverage** — `vitest run` prints no coverage and none is configured; 938 tests is a count,
  not a measure. Nothing here says which behaviours are untested.

## 8. What running the harness revealed about the repo

**F1 — `test:docker` and `test:live` are dead flags.** `FACTORY_TAGS` appears only in those two
`package.json` lines; no test reads it. Docker-gated files gate on `dockerAvailable()`
(`spawnSync('docker', ['info'])`), so `egress.test.ts` runs in the default suite whenever docker
is up — docker 29.8.2 is installed here. Consequence: `pnpm test:docker` is a synonym for
`pnpm test`, and the "isolation suite" is not separable from the offline suite. This also made a
`@docker`-titled test fail a default-suite run at 14:26 (`expected 'blocked' to be 'reached'`,
proxy not up) — an environment-dependent test inside the default gate.

**F2 — `build` passing does not mean `typecheck` passing.** `tsconfig.build.json` excludes
`**/*.test.ts` and `e2e/**`. In the 14:26 run, `build` was PASS while `typecheck` reported 20
errors — one of them in `apps/panel/test/fixtures.ts`, invisible to `build`. A green build is
not evidence that the suite typechecks.

**F3 — 353 MB / 17,074 files of vendored Python (`stapled-factory/worker/.venv`) sit inside the
working tree, unignored.** It dominates every repo-wide glob (prettier, eslint, any `git add -A`)
and is the leading candidate for the fastest `.gitignore` win in the repository.

**F4 — the plan's own tree is entirely uncommitted.** `git rev-parse HEAD` is `b5fe329`, the
previous plan's tip; `docs/planning/dark-factory-dsh/` and this report are untracked, `apps/` and
`packages/` are untracked. So `summary.json`'s `git.head` **cannot reproduce the verified tree** —
the verified artefact is a working tree. Commit before the acceptance run, or the evidence is
pinned to a directory instead of a revision.

**F5 — the tree moves under a verification run.** Two runs 13 minutes apart gave different tables
(§9). Any single table is a snapshot, which is why every run writes its own log and summary, and
why the report cites the run id rather than "current state".

**F6 — `tsc` writes 259 files into `dist/` on every run** (gitignored, so harmless, but it means
`build` is not a pure predicate; it has side effects).

## 9. Re-run log

| run (UTC)   | pass/skip/fail | note                                                                                                                                                            |
| ----------- | -------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `14-26-43Z` | 2 / 1 / 4      | as found: `typecheck` 20 errors in `apps/cli` (untracked verbs mid-edit), `test` 3 failures (panel transform errors, `executor.test.ts`), `build` PASS (§F2)    |
| `14-31-00Z` | 2 / 1 / 4      | `typecheck` down to one `apps/cli/src/render/gate.ts` error                                                                                                     |
| `14-36-31Z` | 3 / 1 / 3      | `typecheck`/`build` green; one watchdog test red (`packages/dsh-adapter/tests/watchdog.test.ts > killProcessGroup > is a no-op when the group is already gone`) |
| `14-39-05Z` | **4 / 1 / 2**  | final: only the two configuration reds remain                                                                                                                   |

The as-found run's log is kept at [`runs/as-found/`](runs/as-found/) precisely because it records
failures that are now gone; a table with no history invites the reader to assume the repo was
always green.

## 10. Artefacts

```
docs/verification/2026-11-01-dark-factory-dsh/
├── report.md                      this file
└── runs/
    ├── as-found/{verify.log,summary.json}    14-26-43Z, before teammates converged
    ├── no-api-keys/{verify.log,summary.json} constraint 5a
    ├── no-dsh/{verify.log,summary.json}      constraint 5b
    └── final/{verify.log,summary.json}       14-40-27Z, the table in §2
```

The harness itself writes to `docs/verification/<timestamp>/` on every run and takes
`--out-dir` for a fixed location; `summary.json` follows `schema: verify/1` (stages, counts,
`unknowns`, environment, artifact paths).

**Reproduce:** checkout the tree, `export PATH=…26.12.1/bin:$PATH`, `pnpm run test:verify`.
Expect 4 pass / 1 skip / 2 fail until §6a and §6b are decided.
