# Phase 10 — E2E Test Generation

**Status:** pending
**Owner:** lead (+ `e2e-author` teammate)
**Artifacts produced:** `docs/planning/dark-factory-dsh/e2e-tests.md`, test sources under `/Users/bo/code/dark-factory-dsh/e2e/` (`*.e2e.test.ts`), `/Users/bo/code/dark-factory-dsh/e2e/panel/*.spec.ts`, `/Users/bo/code/dark-factory-dsh/playwright.config.ts`

## Objective

Turn the P0 stories and UX flows into executable, discoverable tests — including the **8 mandatory adversarial scenarios** that decide whether this factory is real. The verified correction drives the shape: **Playwright is browser-only**, so CLI/process e2e is vitest 5 + `node:child_process` (spawn `factory`, assert exit code and `--json` payload), and Playwright covers only the read-only status page.

## Prerequisites

- `user-stories.md` P0 set and `ux-plan.md > ## Flows` with stable story IDs.
- `tech-guide.md > ## 5. Testing stack` (vitest 5 + child_process for CLI; Playwright 1.64.1 for the panel only) and `## 7` canonical commands.
- Phase 9a–9e code exists with `FakeExecutor` and fixtures, so e2e needs **zero model calls**.

## Tasks

- [ ] `e2e-tests.md > ## Coverage Matrix` — every P0 story ID and every P1 story with observable UX mapped to a stable test id (`E2E-SAB-01`, `E2E-IDM-02`, `PANEL-STATE-01`, …) and a test file path.
- [ ] `e2e-tests.md > ## Mandatory adversarial scenarios` — the 8, each with the exact command, fixture, expected exit code and expected assertion: 1. **Sabotage rejected by the wall** — a patch that passes its own visible suite and breaks behaviour → verdict `fail`, feedback is one opaque line, promotion refused. 2. **Unfaithful receipt** — a receipt whose claimed `commands[]`/exit codes do not match re-execution → `receipt_unfaithful`, never `pass`. 3. **`kill -9` mid-attempt** → attempt becomes `ambiguous`, `factory recover` does **not** redispatch, a new attempt requires explicit `retry`. 4. **Double-run idempotency** — `factory run` twice with the same `(unitId, attemptNo, mandateHash)` yields one attempt and one effect. 5. **Holdout / key leak** — a worker-side probe cannot read `~/.factory/holdout/`, `FACTORY_SIGNING_KEY` or `BIFROST_API_KEY` (tagged `@docker` for the real container, plus a non-container unit-level probe). 6. **Budget refusal + unknown-never-passes** — an over-envelope unit is refused structurally; an `unknown` spend/wall result cannot promote (exit non-zero, verdict not `pass`). 7. **Qualifier → `lit` with reason codes** — a non-derivable-intent or irreversible unit routes to `lit` and records its reason codes; it never runs dark. 8. **Unsigned promotion refused** — `factory promote` without a human signature → `PROMOTION_UNSIGNED`; a stale verdict → `VERDICT_STALE`.
- [ ] `e2e/panel/status.spec.ts` + `playwright.config.ts` — `baseURL` `http://127.0.0.1:8787`, Chromium only, `trace: 'on-first-retry'`, `workers: 1`, `retries: 0` locally, **no retries on safety-critical tests**; asserts the page renders `unknown` as non-success and that `/api/status` returns 401 without the token.
- [ ] `e2e/helpers/` — fixture factories (unit spec, sabotage patch, fake receipt, envelope) and a `runFactory()` wrapper around `child_process.spawn` returning `{code, stdout, stderr, json}`.
- [ ] `e2e-tests.md > ## Selector Policy` — roles, labels and `data-testid` only; no CSS/XPath; test ids stable enough to be cited by `plan-gaps.md`.
- [ ] `e2e-tests.md > ## Waiting Strategy` — condition-based waits only; arbitrary sleeps forbidden except a documented, commented exception per case.
- [ ] `e2e-tests.md > ## Runner topology` — the split stated explicitly: vitest runs CLI e2e (`pnpm test`), Playwright runs the panel (`pnpm test:e2e:panel`), `@docker` tag runs isolation scenarios (`pnpm test:docker`).
- [ ] Test-discovery evidence: `pnpm exec vitest list` (or `pnpm test` collection output) enumerates every `e2e/**.e2e.test.ts` id, and `pnpm test:e2e:panel -- --list` enumerates the panel specs; both pasted into `progress.md`.

## Delegation plan

Two disjoint write scopes, safe in parallel: **Agent A (`e2e-cli-author`)** → `e2e/*.e2e.test.ts` + `e2e/helpers/**` (the 7 CLI-side adversarial scenarios); **Agent B (`e2e-panel-author`)** → `e2e/panel/**` + `playwright.config.ts` (status page only). The Lead owns `e2e-tests.md` and the coverage matrix, and runs the discovery command once both land, so no agent writes the shared document.

## Verification

### Hard Gates (copied verbatim from `done-means-done/phase-10-e2e-test-generation.md`)

- [ ] **Kickoff research done**: current Playwright API surface and best practices captured in `findings.md > ## Phase 10 Kickoff Research` (web-app projects) or current CLI-testing practice (CLI projects).
- [ ] **Story-to-test traceability**: `e2e-tests.md > ## Coverage Matrix` maps every P0 story — and every P1 story with observable UX — to at least one test file/test case with a stable ID.
- [ ] **Flow-to-test traceability**: every primary flow in `ux-plan.md` is exercised by at least one test.
- [ ] **Happy-path + error-path coverage**: for each mapped story, both a happy-path case and at least one error/edge case exist.
- [ ] **Test files committed**: test source files exist, conform to `tech-guide.md` conventions, and are discovered by the canonical test runner command.
- [ ] **Runner config**: `playwright.config.*` (or equivalent) committed with correct base URL, browsers, timeouts, and retries for CI vs. local.
- [ ] **Selectors policy**: tests use stable selectors (roles, labels, `data-testid`) — not brittle CSS/XPath. Policy stated in `e2e-tests.md > ## Selector Policy`.
- [ ] **Dry run**: the test runner can at minimum **collect/discover** all tests without errors. Evidence: command output pasted into `progress.md`.
- [ ] **Flakiness stance**: condition-based waits used instead of arbitrary sleeps. `e2e-tests.md > ## Waiting Strategy` explicitly forbids sleeps except where documented.

### Project-specific evidence

- [ ] All **8** mandatory adversarial scenarios exist as named tests with stable ids; `grep -c 'E2E-' e2e-tests.md` ≥ 8 and each id appears in a test file.
- [ ] `pnpm test` collects and runs the CLI e2e suite without network access (`BIFROST_API_KEY` and `DEEPSEEK_API_KEY` unset) — exit 0 with output in `progress.md`.
- [ ] `pnpm test:e2e:panel -- --list` lists the panel specs and `pnpm test:e2e:panel` exits 0 against `pnpm run panel`.
- [ ] The sabotage scenario is proven to **fail-then-pass**: with the wall's holdout check disabled the test goes red; restored, it goes green (both outputs attached).
- [ ] `e2e-tests.md` states in words that Playwright cannot drive a CLI, so CLI e2e is vitest + `child_process` — the correction from kickoff finding 5.

## Acceptance criteria

Tests exist, are discovered by the canonical commands, every P0 story and primary UX flow has at least one test, and all 8 adversarial scenarios are present as executable tests — including sabotage, unfaithful receipts, `kill -9` ambiguity, idempotent double-run, holdout/key leak, budget refusal with unknown-never-passes, qualifier `lit`, and unsigned promotion.

## Risks / notes

- A flaky safety test is a **blocker, not a retry**: `retries: 0` for safety-critical cases, and any observed flake is recorded as a Phase 13 gap rather than papered over.
- The leak probe must run twice conceptually — a unit-level probe for the test suite and the `@docker` container probe for the real boundary — because the in-process probe proves the path check, not the container's mount set (C8).
- `kill -9` assertions depend on `recover()` being read-only; if implementation redispatchs, the e2e goes red and Phase 9a's contract is violated. That is the intended failure.
