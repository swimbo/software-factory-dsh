# Phase 8 — UI Planning (status page)

**Status:** pending
**Owner:** lead (+ `ui-author` teammate)
**Artifacts produced:** `docs/planning/dark-factory-dsh/ui-plan.md` (written by the `ui-author` teammate — not the Lead); `findings.md > ## Phase 8 (UI Planning) Kickoff`

## Objective

Design the entire v1 visual surface: **one read-only local status page** whose only job is to answer "what needs a person right now?" — units waiting on a human gate, ambiguous attempts, budget envelope state, wall health. It is two routes on `node:http`, no SPA, no design system, no build step for the UI; its discipline is accessibility and honest state, not aesthetics.

## Prerequisites

- `ux-plan.md` flows (Phase 7) — the page composes those states, it does not invent new ones.
- `architecture.md > ## 3. Components` C10 (`apps/panel`: `GET /` HTML, `GET /api/status`) and `## 4. API surface` (`GET /api/status` → `{units, waitingOnPerson, health, budget}`, loopback token, 401 without token).
- `findings.md > ## Phase 8 (UI Planning) Kickoff` — one page, current CSS feature maturity sufficient without a component library.

## Tasks

- [ ] `ui-plan.md > ## Scope` — one page, two routes (`GET /`, `GET /api/status`), read-only (no POST, no JS-driven mutation), loopback-bound with `FACTORY_PANEL_TOKEN`; explicitly **no SPA, no client framework, no design-system dependency, no icon font**.
- [ ] `ui-plan.md > ## `/api/status` contract` — the response shape with every field typed and every "unknown" made representable: `{units: [{id, state, lane, attempt, delta}], waitingOnPerson: [{unitId, gate, since}], health: {controlPlane, wall, docker, dsh}, budget: {spentToday, envelope, estimatedAsOf}}` plus 401 semantics and `cache-control: no-store`.
- [ ] `ui-plan.md > ## Tokens` — semantic + raw colors, a four-step type scale, spacing scale, radii and one shadow; each fg/bg pair used for text annotated with its **measured WCAG AA contrast ratio** (≥4.5:1 body, ≥3:1 large) inline, not as a claim.
- [ ] `ui-plan.md > ## States without color` — every state (`pass` / `fail` / `unknown` / `waiting-on-person` / `ambiguous`) carries a text token, an icon-shape or a rule style in addition to color; `unknown` must never render as a green/check affordance.
- [ ] `ui-plan.md > ## Accessibility` — keyboard-only operability (the page is a document with one link target: the gate queue), logical focus order, labelled headings/table headers, `prefers-contrast` and `prefers-reduced-motion` honored, 200% zoom reflow, no information conveyed by motion.
- [ ] `ui-plan.md > ## Dark mode` — specify both schemes via `color-scheme` + `prefers-color-scheme` and state the contrast ratios for the dark palette as well, or mark dark mode out of scope with a reason.
- [ ] `ui-plan.md > ## Layout` — single column, max-width container, no card grid; tables used only where the data is tabular; monospace for ids, hashes, command strings and Δ values.
- [ ] `ui-plan.md > ## Anti-Pattern Audit` — confirm no gradient soup, no generic card grid, no decorative-only shadows, no hero section, no placeholder statistics, no chart that implies precision the data lacks.
- [ ] `ui-plan.md > ## Alignment with UX` — every `ux-plan.md` flow's status/empty/error state maps to an element on this page; orphan states listed if any exist.

## Delegation plan

Single writer: `ui-author` owns `ui-plan.md`. It can run in parallel with Phase 7 (disjoint files, `ux-plan.md` read-only input) and with Phase 5/6 artifacts. The Lead reviews contrast-ratio arithmetic and the `/api/status` contract against `architecture.md` C10 — read-only, no overlapping writes.

## Verification

### Hard Gates (copied verbatim from `done-means-done/phase-08-ui-planning.md`)

- [ ] **Kickoff research done**: current component-library state, CSS feature maturity, and design trends captured in `findings.md > ## Phase 8 Kickoff Research`.
- [ ] **Design tokens defined**: `ui-plan.md > ## Tokens` declares colors (semantic + raw), typography (family, scale, weights, line-heights), spacing scale, radii, shadows, motion durations/easings.
- [ ] **Color contrast verified**: every foreground/background pair used for text meets WCAG AA (4.5:1 body, 3:1 large). Contrast ratios listed or linked.
- [ ] **Dark mode stance**: dark-mode is either fully specified or explicitly marked out-of-scope with a note.
- [ ] **Typography applied**: monospaced typography adjustments made where relevant (code blocks, CLI output panels).
- [ ] **Component inventory**: `ui-plan.md > ## Components` lists every UI primitive the app needs (Button, Input, Card, Dialog, Table, …) with states (default/hover/active/focus/disabled/error/loading).
- [ ] **Layout system**: grid/flex primitives, breakpoints, container widths declared.
- [ ] **Iconography**: icon set chosen with rationale; sizes and usage conventions recorded.
- [ ] **Motion**: reduced-motion handling declared; transition durations within an accessibility-safe range.
- [ ] **Brand stance**: `ui-plan.md > ## Brand` states whether the product uses a distinct brand palette or a neutral one; Anthropic-brand palette referenced only if explicitly requested.
- [ ] **Alignment with UX**: every flow in `ux-plan.md` can be composed from components in this inventory. No orphan flows.
- [ ] **Anti-pattern audit**: `ui-plan.md > ## Anti-Pattern Audit` confirms we are not committing the visual AI-slop failure modes (gradient soup, generic card grids, inconsistent rhythm, decorative-only shadows).
- [ ] **Cross-reference to research**: `research/ui-design.md` cited where applicable.

### Project-specific evidence

- [ ] `ui-plan.md` declares **one page, two routes** and states "no SPA / no design system / no client framework"; any component inventory beyond a table, heading, badge, link and paragraph is justified by a specific status-page need.
- [ ] Every text fg/bg pair in `## Tokens` carries a numeric contrast ratio; recomputing one pair by hand matches the listed value (worked example attached).
- [ ] `## States without color` demonstrates the `unknown` render with `NO_COLOR`/greyscale semantics: text token plus shape, never a success affordance.
- [ ] The `/api/status` shape in `ui-plan.md` matches `architecture.md > ## 4. API surface` field-for-field (no invented fields, none dropped).
- [ ] `research/ui-design.md` does not exist — recorded as "not applicable; evidence in `research/kickoff-research.md` §Phase 8" rather than silently skipped.

## Acceptance criteria

There is a token set with measured WCAG AA contrast, a minimal component inventory, a `GET /api/status` contract that can express `unknown` honestly, a non-color state scheme, and an explicit rejection of SPA and design-system scope — such that Phase 9e can build the page from a fixed kit.

## Risks / notes

- `phased-plan.md` lists Phase 8 as `pending`; the artifact is a teammate deliverable in flight.
- The checklist pushes for a component library inventory; this product needs roughly five primitives. The plan must state that adaptation rather than importing a Button/Dialog/Input inventory the page never renders.
- The page is a **read-only** surface on loopback with a token: no auth flow, no session, no CSRF surface by construction. Do not let UI scope creep add write actions — the operator CLI is the write surface (Phase 7).
- Color contrast is the one place a plausible-looking plan can be wrong; ratios must be measured, not estimated.
