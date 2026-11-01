# Phase 6 — Tech Guide (+ mandatory Mode A debate)

**Status:** in_progress
**Owner:** lead (+ `kickoff-researcher`, Mode A debate fan-out)
**Artifacts produced:** `docs/planning/dark-factory-dsh/tech-guide.md` (drafted — not written in this pass), `consensus-plan.md` + `debate-transcript.md` (appended by the Phase 6 debate), `findings.md > ## Phase 6 (Tech Guide) Kickoff`

## Objective

Commit to a concrete, pinned stack that realises components C1–C10 with no orphans: TypeScript 7.0.2 on Node 22.23.3, `tsx` for execution, `node:sqlite` behind a driver interface, three runtime dependencies, a testing split that respects Playwright being browser-only, and the canonical commands every later phase cites verbatim. Then harden the pins with a Mode A debate that runs **after** the architecture debate.

## Prerequisites

- `architecture.md > ## 11. Debate Outcomes` populated — the tech guide cannot outrun the architecture consensus.
- `research/kickoff-research.md > ## Phase 6 Kickoff Research` (56 sources, registry-resolved versions) and the six deltas in `findings.md > ## Phase 6 (Tech Guide) Kickoff`.
- The `dsh` binary path verified (`/Applications/DeepSeek Harness.app/Contents/Resources/runtime/cli/bin/dsh`, `0.2.1-rc.3`) and confirmed absent from `PATH`.

## Tasks

- [ ] Verify every pin in `tech-guide.md > ## 3. Dependencies` against the live registry with `npm view <pkg> version` (typescript, tsx, vitest, `@playwright/test`, commander, zod, pino, `@types/node`, `better-sqlite3`, litestream) and paste the output into `progress.md`.
- [ ] `tech-guide.md > ## 1. Language & Runtime` — Node **22.23.3** on `PATH` at `~/.local/opt/node/bin/node`, declared engine `>=22.12.0 <27`, recommended upgrade **24.9+/26.12.1**, TypeScript **7.0.2**, `tsx` **4.23.15**, pnpm **10.33.0** workspaces; explicit note that the operator's Node is **not** upgraded in this project.
- [ ] `tech-guide.md > ## 2. Frameworks` — commander 15.0.0 (CLI), `node:http` (status page + credential proxy), zod 4.6.7 (trust-boundary validation), pino 10.4.0 (logs), `node:sqlite` behind `SqliteDriver`, vitest 5.0.5, `@playwright/test` 1.64.1 **status page only**, `dsh` headless subprocess.
- [ ] `tech-guide.md > ## 3. Dependencies` — **≤3 runtime dependencies** (commander, zod, pino) declared as a constraint, with `better-sqlite3 13.0.3` and `litestream 0.5.17` marked optional-and-not-in-v1.
- [ ] `tech-guide.md > ## 4. Conventions` — prettier defaults, eslint flat config, `strict` + `noUncheckedIndexedAccess` + `exactOptionalPropertyTypes`, **`erasableSyntaxOnly: true`**, **`types: ["node"]` set explicitly** (TS 6+ default is `[]`), ESM-only with `./x.js` specifiers, `FactoryError` codes, `unknown` as a first-class value.
- [ ] `tech-guide.md > ## 5. Testing stack` — the layer table with the **vitest vs Playwright split**: unit/integration/process-e2e on vitest + `node:child_process`; Playwright for the read-only status page only; `@docker` and `@live` tags; and the rule that a skipped `@docker`/`@live` test reports `unknown`, never pass.
- [ ] `tech-guide.md > ## 6. Dev environment` — required/optional tools, the env-var contract, ports (8787 panel, 8788 proxy), and the **`dsh` resolution order** `--dsh-bin` → `FACTORY_DSH_BIN` → `/Applications/DeepSeek Harness.app/Contents/Resources/runtime/cli/bin/dsh` → `PATH`, with a version assertion against `packages/contracts/src/dsh-version.ts`.
- [ ] `tech-guide.md > ## 7. Canonical commands` — verbatim: `pnpm install`, `pnpm run preflight`, `pnpm run typecheck`, `pnpm run lint`, `pnpm run format:check`, `pnpm test`, `pnpm test:docker`, `pnpm test:live`, `pnpm test:e2e:panel`, `pnpm run build`, `pnpm run dogfood`, `pnpm factory --help`, `pnpm run panel`.
- [ ] `tech-guide.md > ## 8. CI shape` — 8 local-first stages ending in "a missing or skipped safety test fails the gate"; `@live` never in CI.
- [ ] `tech-guide.md > ## 9. Alignment with architecture.md > ## Components` — a row per C1–C10, no orphans and no component needing a stack element not in §3.
- [ ] Run the **mandatory Mode A `/debate`** on `tech-guide.md` (after the architecture debate) and populate `## 11. Debate Outcomes`; append the round to `debate-transcript.md` and the resolutions to `consensus-plan.md`.
- [ ] Escalate unresolved pins to `findings.md` as `NEEDS_HUMAN_DECISION` (candidates: Node engine window vs DSH 0.2.2's ≥24.9 floor; whether `@live` is in scope before handover).

## Delegation plan

`kickoff-researcher` produced the registry-verified version table and the six deltas (one writer, `research/kickoff-research.md`). The Phase 6 debate personas run in parallel and read-only — including a "pin-skeptic" persona arguing the Node-22 choice is a time bomb and a "dependency-minimalist" arguing zod/pino are avoidable. The Lead is the single writer of `tech-guide.md` and the debate artifacts.

## Verification

### Hard Gates (copied verbatim from `done-means-done/phase-06-tech-guide.md`)

- [ ] **Kickoff research done — and substantive**: `findings.md > ## Phase 6 Kickoff Research` captures current stable versions, breaking changes since last-known version, and deprecations. This is the highest-priority research step — skimpy output blocks the phase.
- [ ] **Language & runtime**: `tech-guide.md > ## Language & Runtime` pins language versions (e.g. `Node 22.x`, `Rust 1.83+`, `Python 3.12+`).
- [ ] **Framework selection**: `tech-guide.md > ## Frameworks` lists chosen frameworks with explicit versions and a one-line rationale referencing research findings.
- [ ] **Dependency list**: `tech-guide.md > ## Dependencies` pins every non-trivial dependency to a version known-stable as of kickoff research.
- [ ] **Coding conventions**: `tech-guide.md > ## Conventions` states formatting tool, linter, typing strictness, import style, naming.
- [ ] **Testing stack**: unit, integration, and e2e tooling chosen with versions.
- [ ] **Dev environment**: `tech-guide.md > ## Dev Environment` documents required local services, setup commands, and env-var contract.
- [ ] **Build & run commands**: canonical `build`, `test`, `lint`, `dev`, `start` commands recorded verbatim.
- [ ] **CI shape**: a sketch of CI stages (even if CI is out of scope for v1, the shape is captured).
- [ ] **Alignment with Architecture**: every component in `architecture.md > ## Components` has a clearly-mapped stack choice here. No orphans, no mismatches.
- [ ] **Adversarial debate invoked**: `/debate` run on `tech-guide.md`. Evidence: debate artifacts exist referencing current `tech-guide.md`. Debate runs **after** Architecture debate.
- [ ] **Consensus incorporated**: `tech-guide.md` updated to reflect the debate consensus. `## Debate Outcomes` section summarizes what changed.
- [ ] **Unresolved items escalated**: open disagreements tagged `NEEDS_HUMAN_DECISION` in `findings.md` and resolved by the user before phase close.

### Project-specific evidence

- [ ] `npm view <pkg> version` output for all ten pinned packages pasted into `progress.md`, and each version in `tech-guide.md` matches it.
- [ ] `pnpm run typecheck`, `pnpm run lint`, `pnpm test` and `pnpm run build` all exit 0 in a scratch project using these exact pins (the Lead's pre-verified toolchain run) — evidence linked from `progress.md`.
- [ ] `tech-guide.md > ## 5. Testing stack` states in words that **Playwright is browser-only**, so CLI e2e is vitest + `child_process`; no phase may later assume Playwright drives a CLI.
- [ ] `debate-transcript.md` shows the tech-guide round timestamped **after** the architecture round.
- [ ] `tech-guide.md > ## 9` lists exactly C1–C10 with a stack row each; zero orphans in both directions.

## Acceptance criteria

The stack is chosen, pinned to registry-verified versions, conventionally documented, aligned one-to-one with C1–C10, and hardened by a Mode A debate that ran after the architecture debate.

## Risks / notes

- **`phased-plan.md` still lists Phase 6 `pending`** while this file records `in_progress`; the artifact and its debate are the work in flight. Flagged to the Lead for table reconciliation.
- Node 22.23.3 is below DSH 0.2.2's ≥24.9 floor: the engine range documents the window, `scripts/preflight.sh` warns, and the sqlite driver isolates the API so an upgrade never touches factory logic. Do not silently upgrade the operator's Node.
- `node:sqlite` is experimental on 22 (`DatabaseSync` only, `busy_timeout` default 0): `busy_timeout=5000` and `synchronous=FULL` are mandatory settings, not preferences.
