# Tech Guide — Dark Software Factory on DSH

**Status:** draft pending Phase 6 adversarial debate (Mode A, runs **after** the architecture debate).
**Sources:** [`research/kickoff-research.md`](research/kickoff-research.md) (56 source URLs, versions resolved live from the npm registry on 2026-11-01) · [`architecture.md`](architecture.md) · [`findings.md`](findings.md)
**Verification basis:** every version below was confirmed with `npm view <pkg> version` and, for the toolchain, installed and executed locally in a scratch project (see `progress.md`).

## 1. Language & Runtime

| Item                      | Pin                                                                | Rationale                                                                                                                                                                                                              | Evidence                                            |
| ------------------------- | ------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------- |
| Node.js (project-local)   | **26.12.1** via nvm, pinned in `.nvmrc` (user decision 2026-11-01) | Active LTS; `node:sqlite` is a **Release Candidate** from ≥25.7 (`Database` class, `backup()`); satisfies DSH 0.2.2's `≥24.9` floor; `--experimental-transform-types` is gone in 26, so `erasableSyntaxOnly` guards us | nvm install + `node -v`; `node:sqlite` export probe |
| Node.js (declared engine) | `>=24.9.0 <27`                                                     | DSH 0.2.2's floor, `node:sqlite` RC, and Active-LTS support all agree on this window                                                                                                                                   | kickoff §Phase 6                                    |

| TypeScript | **7.0.2** | Current stable; native compiler. Known silent-default changes (TS 6 line): `types: []`, `rootDir` = tsconfig dir, `strict`/`module: esnext`/`target: es2025` now defaults | `npm view typescript version`; `npx tsc --version` → 7.0.2; kickoff §Phase 6 |
| TS execution (scripts, tests) | **tsx 4.23.15** | Runs TS directly on Node 22 without a build step; Node's own type stripping is stable only on ≥24.12 and `--experimental-transform-types` was removed in 26, so `tsx` is the portable choice | local run: `npx tsx a.ts` → ok |
| Build | **tsc 7.0.2 emit** (per package `tsconfig.json`) | No bundler needed: the factory is a set of local packages and CLIs, not a published library | design choice |
| Package manager | **pnpm 10.33.0** (workspaces) | Already installed; strict node_modules prevents phantom deps in a factory that must be auditable | `pnpm -v` |

**Deliberate decision:** Node is **project-local**, never global. `.nvmrc` = `26.12.1`, `engines.node` = `>=24.9 <27`, and `scripts/preflight.sh` fails closed when the running Node is outside the window (the operator's PATH still has 22.23.3 — running the factory on it is an error, not a fallback).

## 2. Frameworks

There is deliberately **no application framework**. The factory is a set of plain Node processes; every dependency below earns its place.

| Concern                               | Choice                                                                                         | Why not the alternative                                                                                                    |
| ------------------------------------- | ---------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------- |
| CLI parsing                           | **commander 15.0.0**                                                                           | yargs 18 is heavier and its middleware model obscures exit codes; commander gives predictable `--json`/exit-code behaviour |
| HTTP (status page + credential proxy) | **`node:http`** (built-in)                                                                     | Express/Fastify are unjustified for two routes and one forwarder; fewer deps = smaller audit surface                       |
| Schema validation                     | **zod 4.6.7**                                                                                  | Runtime validation at every trust boundary (unit spec in, receipt in, verdict out); v4 is current                          |
| Logging                               | **pino 10.4.0**                                                                                | Structured JSON logs, low overhead, redaction support for secret hygiene                                                   |
| Datastore                             | **`node:sqlite`** behind a `SqliteDriver` interface (experimental API on Node 22; RC on ≥25.7) | zero native deps; `better-sqlite3 13.0.3` is a **one-file swap** if the API churns                                         |
| Test runner                           | **vitest 5.0.5**                                                                               | Native TS, fast, single runner for unit + process-level e2e                                                                |
| Browser tests                         | **@playwright/test 1.64.1** — status page **only**                                             | Playwright is browser-only; it cannot drive a CLI (kickoff finding). CLI e2e uses vitest + `child_process`                 |
| Worker protocol                       | `dsh` headless subprocess (pinned)                                                             | ACP v1 is stable and is the documented upgrade path, but the DSH ACP surface is UNVERIFIED here                            |

## 3. Dependencies (pinned)

| Package                       | Version                   | Scope   | Notes                                                                                |
| ----------------------------- | ------------------------- | ------- | ------------------------------------------------------------------------------------ |
| `typescript`                  | 7.0.2                     | dev     | `tsc` build + `--noEmit` typecheck                                                   |
| `tsx`                         | 4.23.15                   | dev     | script/test execution                                                                |
| `vitest`                      | 5.0.5                     | dev     | note: `--reporter=basic` was **removed** in v5 — use default reporter                |
| `@playwright/test`            | 1.64.1                    | dev     | Chromium only                                                                        |
| `commander`                   | 15.0.0                    | runtime | CLI                                                                                  |
| `zod`                         | 4.6.7                     | runtime | contracts                                                                            |
| `pino`                        | 10.4.0                    | runtime | logs                                                                                 |
| `@types/node`                 | matching Node 22 LTS line | dev     | `types: ["node"]` must be set explicitly (TS 6+ default is `[]`)                     |
| _(optional)_ `better-sqlite3` | 13.0.3                    | runtime | only if `node:sqlite` proves unusable                                                |
| _(optional)_ `litestream`     | 0.5.17                    | ops     | continuous SQLite replication; **not** in v1 (adds a ~1 s loss window on top of WAL) |

Total runtime dependencies: **3** (commander, zod, pino) + built-ins. This is a deliberate constraint: a factory that audits other people's dependency trees should have a small one.

## 4. Conventions

- **Formatting:** `prettier` defaults (2-space, single quotes, trailing commas) — no custom config beyond `{ "printWidth": 100 }`.
- **Linting — amended 2026-11-01 during Phase 9.** The plan named `eslint` + `@typescript-eslint` + `eslint-plugin-import-x`. Two facts killed it: `eslint-plugin-import-x` is not installed and cannot be (offline), and **`typescript-eslint@8.72.1` refuses to load under `typescript@7.0.2`** ("typescript-eslint does not support TS 7.0"; its flat config also needs `jiti`, also unavailable). A gate that exits 2 forever is not a gate, so `pnpm run lint` now runs `scripts/discipline-lint.sh`: seven deterministic grep-level checks for the rules this codebase actually depends on — no unjustified `@ts-expect-error`, no `as any` outside tests, no `.only`/`.skip`, no `eslint-disable`, `Date.now()` only at allowlisted clock sites, `process.env` only at composition roots, and no `@deepseek-ai/*` import outside `packages/dsh-adapter`. Each allowlist entry is a reviewed path, not a mute button. The import-graph intent of `import-x` is covered by the per-package purity tests (which read their own sources) and by the type checker. Revisit when typescript-eslint supports TS 7.1+ and the registry is reachable.
- **Typing strictness:** `strict: true`, `noUncheckedIndexedAccess: true`, `exactOptionalPropertyTypes: true`, `erasableSyntaxOnly: true` (guards Node type-stripping), and **`types: ["node"]` explicitly set** (TS 6+ default is `[]` — a silent source of build failures).
- **Imports:** ESM only (`"type": "module"`), relative `./x.js` specifiers within a package, workspace name (`@factory/store`) across packages, no default exports.
- **Naming:** `packages/<domain>` → `@factory/<domain>`; commands in imperative present (`submitUnit`), events in past tense (`unit.qualified`), types `PascalCase`, files `kebab-case.ts`.
- **Error handling:** every thrown error is a `FactoryError` with a stable `code` from `packages/contracts/src/errors.ts`; unknown results are a **first-class value** (`'unknown'`), never an exception and never a pass.
- **Commits:** conventional commits; body references the story id (`US-E3-02`) and the phase plan task.

## 5. Testing stack

| Layer             | Tool                          | Scope                                                                                    | Runs without credentials                         |
| ----------------- | ----------------------------- | ---------------------------------------------------------------------------------------- | ------------------------------------------------ |
| Unit              | vitest 5.0.5                  | pure functions: store invariants, engine commands, qualifier scoring, classifier, Δ math | yes                                              |
| Integration       | vitest                        | engine + real SQLite in a temp dir; `FakeExecutor`; NDJSON fixture worker                | yes                                              |
| Process-level e2e | vitest + `node:child_process` | the `factory` CLI end-to-end: 8 mandatory adversarial scenarios                          | yes                                              |
| Browser e2e       | @playwright/test 1.64.1       | the read-only status page only                                                           | yes                                              |
| `@docker`         | vitest tag                    | container isolation, egress, holdout leak                                                | needs Docker, **not** a model key                |
| `@live`           | vitest tag                    | one real `dsh` run through Bifrost                                                       | needs `BIFROST_API_KEY`; **excluded by default** |

**Rule (law L3 applied to our own suite):** a skipped `@docker`/`@live` test is reported as `unknown` in the test summary — never silently counted as passing.

## 6. Dev environment

**Required:** Node **26.12.1** via nvm (`.nvmrc`; the operator's default `node` is 22.23.3 and is **not** supported), pnpm 10.x, git 2.32+, macOS arm64 (Seatbelt) or Linux.
**Optional:** Docker 29.x (`@docker` tests, container workers), a pinned `dsh` binary (`@live`), a Bifrost API key.

**`dsh` resolution (resolves `phased-plan.md` open question #2):** the binary is **not on `PATH`**. Canonical location:
`/Applications/DeepSeek Harness.app/Contents/Resources/runtime/cli/bin/dsh` (reports `0.2.1-rc.3`).
The adapter resolves it in this order: `--dsh-bin` → `FACTORY_DSH_BIN` → the canonical path → `PATH`. Version is asserted against `packages/contracts/src/dsh-version.ts`.

**Environment-variable contract** (`.env` gitignored; `.env.example` committed):

| Variable              | Required                  | Purpose                                                       |
| --------------------- | ------------------------- | ------------------------------------------------------------- |
| `FACTORY_STATE_DIR`   | no (default `~/.factory`) | root for state/work/holdout/dsh-home/artifacts                |
| `FACTORY_DSH_BIN`     | no                        | override the `dsh` path                                       |
| `FACTORY_PROXY_PORT`  | no (default `8788`)       | credential proxy listen port                                  |
| `BIFROST_API_KEY`     | **only for `@live`**      | held by the proxy process **only**, never exported to workers |
| `FACTORY_PANEL_TOKEN` | no                        | loopback token for the status page                            |
| `FACTORY_SIGNING_KEY` | for promotion             | path to the operator ed25519 key                              |

**Ports:** control plane/panel `8787`, credential proxy `8788`, wall's ephemeral candidate ports allocated per run.

## 7. Canonical commands (verbatim)

```sh
# setup
pnpm install
pnpm run preflight            # checks node/pnpm/git/dsh version pins; warns, never silently passes

# quality gates
pnpm run typecheck            # tsc -b --noEmit across packages
pnpm run lint                 # eslint .
pnpm run format:check         # prettier --check .

# tests
pnpm test                     # vitest run (unit + integration + process e2e, no credentials)
pnpm test:docker              # VITEST_TAGS=docker vitest run
pnpm test:live                # VITEST_TAGS=live vitest run   (requires BIFROST_API_KEY)
pnpm test:e2e:panel           # playwright test (status page only)

# build & run
pnpm run build                # tsc -b
pnpm run dogfood              # scripts/dogfood.sh — full offline loop on fixtures/dogfood
pnpm factory --help           # CLI (built) or: pnpm --filter @factory/cli exec tsx src/main.ts --help
pnpm run panel                # status page on 127.0.0.1:8787
```

## 8. CI shape

Local-first, mirroring the prior repo's policy (operator-run CI, exact-commit verification) because the factory's own trust story cannot depend on a hosted runner:

1. `preflight` (version pins; fails closed on mismatch)
2. `typecheck` → `lint` → `format:check`
3. `test` (offline unit + integration + process e2e)
4. `test:docker` (isolation + leak tests) — **required for release**, skippable locally
5. `build`
6. `dogfood` (offline full loop; produces `evidence/dogfood-<sha>.json`)
7. `test:e2e:panel`
8. Gate: the sabotage e2e must be present and green; a missing or skipped safety test fails the gate

`@live` runs are **never** part of CI — they are an operator action with a recorded receipt.

## 9. Alignment with `architecture.md > ## Components`

| Component                 | Stack realisation                                                                   | Status |
| ------------------------- | ----------------------------------------------------------------------------------- | ------ |
| C1 `packages/core`        | TS 7 + zod contracts, no framework                                                  | mapped |
| C2 `packages/store`       | `node:sqlite` behind `SqliteDriver`, WAL + `synchronous=FULL` + `busy_timeout=5000` | mapped |
| C3 `packages/effects`     | in-process outbox on the same SQLite file                                           | mapped |
| C4 `packages/contracts`   | zod 4.6.7 schemas + error codes + `canonicalJson`                                   | mapped |
| C5 `packages/qualifier`   | pure TS, no deps                                                                    | mapped |
| C6 `packages/gates`       | pure TS + `node:crypto` (ed25519)                                                   | mapped |
| C7 `packages/wall`        | TS + `node:child_process` (candidate spawn) + `node:crypto`                         | mapped |
| C8 `packages/dsh-adapter` | TS + `node:child_process` + docker CLI                                              | mapped |
| C9 `apps/cli`             | commander 15                                                                        | mapped |
| C10 `apps/panel`          | `node:http`                                                                         | mapped |

No orphans; no component needs a stack element not listed in §3.

## 10. Datastore settings (verified from primary docs)

```sql
PRAGMA journal_mode = WAL;        -- concurrent readers, single writer
PRAGMA synchronous = FULL;        -- REQUIRED: NORMAL gives up commit durability (WAL docs)
PRAGMA busy_timeout = 5000;      -- REQUIRED: default is 0 → instant SQLITE_BUSY on a 2nd connection
PRAGMA foreign_keys = ON;
```

Backup: nightly **`sqlite.backup()`** (available on Node 26) plus `PRAGMA integrity_check`, under an exclusive lock. Litestream is explicitly **not** in v1 (it adds another loss window).

## 11. Debate Outcomes

_(populated after the Phase 6 Mode A debate)_
