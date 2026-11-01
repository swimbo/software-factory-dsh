# UI Plan — Read-Only Status Page

**Status:** draft, Phase 8.
**Surface:** `apps/panel` (C10) — `GET /` (HTML) and `GET /api/status` (JSON). Loopback + token, read-only.
**Companions:** [`architecture.md`](architecture.md) §3 C10 / §4 / §7 · [`phased-plan.md`](phased-plan.md) IN 24, OUT "no design system / rich web UI" · [`ux-plan.md`](ux-plan.md) (vocabulary, exit codes, error codes, dark-pattern findings A-1/A-2/A-3) · [`e2e-tests.md`](e2e-tests.md) (panel suite, `e2e/panel/*.spec.ts`)

**Research basis:** `research/ui-design.md` (visual hierarchy, 8-point grid, WCAG contrast tables, monospaced constraints, anti-pattern matrix) · `research/kickoff-research.md` §Phase 7/8 (`NO_COLOR`, terminal a11y) · `research/ux-design.md` (HAX, dark patterns).

---

## 1. Objective

One page that answers one question — **"does anything need me right now?"** — and, when the answer is yes, names the thing, the state it is in, and the one command that resolves it.

The page is the _second_ surface. The CLI (`ux-plan.md`) is the product; the page exists because a terminal is not always the thing in front of the operator, and because "what needs a person" deserves a place that is visible when the operator is not looking at a shell.

### 1.1 Scope: one route, read-only, no build step

| In                                             | Out (explicitly)                                  |
| ---------------------------------------------- | ------------------------------------------------- |
| `GET /` — one server-rendered HTML document    | Any SPA, client-side router, or hydration         |
| `GET /api/status` — one JSON object            | Any write endpoint, form, or button               |
| Server-rendered HTML + ~40 lines of inline CSS | A CSS framework, design system, or token pipeline |
| Loopback bind + bearer token                   | Accounts, sessions, login, roles                  |
| `prefers-color-scheme` light/dark              | A theme switcher, user preferences, persistence   |
| Meta-refresh at 10 s (or a manual reload)      | WebSockets, SSE, live dashboards                  |

**Why no SPA and no design system** (matching `phased-plan.md` OUT "A design system / rich web UI"):

1. **Nothing on this page is interactive.** Read-only scope (IN 24) means there is no state to manage client-side; a SPA would exist solely to re-render a document that changes every few seconds. `ui-design.md`'s own rule — Webviews/custom UI "where native components suffice" is an anti-pattern — applies a fortiori to a page with zero controls.
2. **A design system is a dependency with a maintenance contract, for one page.** The plan's OUT list forbids it; the honest alternative is ~40 lines of CSS with 9 colour tokens and one 4/8 spacing scale, _stated and tested_ (this document), not a framework whose contrast ratios we would have to trust rather than measure.
3. **The failure mode we are avoiding.** A rich status page becomes a dashboard, a dashboard invites charts, charts imply precision, and this factory's numbers are **estimates with `unknown` propagating** (invariant 2). A plain page that says `$6.41 estimated` cannot be mistaken for telemetry; a graph of the same number would be read as measurement. Plainness is the _truthfulness_ mechanism (finding A-2).
4. **Operability.** One process, one route, no bundler: it starts with the control plane, cannot get out of sync with it, and is testable with a single Playwright project on one browser. It also keeps the trust surface at zero — the page holds no key, opens no socket, and reads one SQLite file through the control plane it is already in.

### 1.2 What the page must show (and nothing else)

| #   | Content                                                                                                                                    | Why it must be on the page                                                                                | Source of truth        |
| --- | ------------------------------------------------------------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------- | ---------------------- |
| 1   | **What needs a person** — gates awaiting signature, lit units, ambiguous attempts, `unknown` verdicts, escape-rate samples awaiting review | The page's entire reason to exist                                                                         | `waitingOnPerson[]`    |
| 2   | **Unit states** — one row per non-terminal and recently-terminal unit                                                                      | "Is it working?" without a shell                                                                          | `units[]`              |
| 3   | **Health** — store, control plane, executor, wall, outbox, DSH version                                                                     | Distinguishes "quiet" from "dead". A silent page and a crashed page look identical unless health is shown | `health`               |
| 4   | **Budget** — limit, spend, reserved, every number tagged `estimated`/`measured`/`unknown`                                                  | The one number that can run away (architecture §9.3)                                                      | `budget`               |
| 5   | **Δ per task class** — visible−holdout gap, sample count, stability state                                                                  | The metric that says whether the wall is doing anything (T2). Per class, never aggregated into one number | `health.taskClasses[]` |
| 6   | Verdicts (recent)                                                                                                                          | "Did the last thing pass?" — with the _unknown_ distinction intact                                        | `units[].verdict`      |
| 7   | Version/identity footer                                                                                                                    | Reproducibility: factory version + pinned `dsh` version + policy/wall/holdout revisions                   | `factory`              |

**Not on the page:** diffs (never — `ux-plan.md` §0), the model's narrative (non-evidence), per-turn token curves (fabricated precision), any input control (read-only scope), any "acknowledge"/"dismiss" (dismissal is how a `needs you` item disappears without being resolved).

### 1.3 Traceability to stories

Canonical ids from [`user-stories.md`](user-stories.md) (`US-E<epic>-<nn>`); tests in `e2e-tests.md` §4.1.

| Region / content                                     | Story    | e2e                    |
| ---------------------------------------------------- | -------- | ---------------------- |
| Needs you (1/3), unit rows, "waiting on a person"    | US-E7-02 | E2E-35, E2E-42         |
| Read-only panel, loopback token, contrast            | US-E7-03 | E2E-11, E2E-40, E2E-41 |
| Health strip, budget provenance, "what it costs"     | US-E6-02 | E2E-36, E2E-38         |
| `unknown` never rendered as a pass                   | US-E3-06 | E2E-37                 |
| Δ per task class                                     | US-E3-04 | E2E-39                 |
| Budget envelope / reservation display                | US-E4-04 | E2E-38                 |
| Verdict cards (signed, versioned)                    | US-E3-09 | E2E-35                 |
| Footer versions (pinned DSH, wall/holdout revisions) | US-E8-04 | E2E-11                 |

---

## 2. Layout architecture

### 2.1 Three regions + a health strip, single column

Reading order is deliberately top-down, highest-consequence first. No sidebar, no cards-in-a-grid, no dashboard tiles: a grid implies parallel equal-weight items, and these items are strictly ranked.

```
┌──────────────────────────────────────────────────────────────────────────┐
│  factory status                        U-7f3a9c · dark · verifying  ...  │  ← 1 header (identity + the one-line answer)
├──────────────────────────────────────────────────────────────────────────┤
│  HEALTH  [!] WALL UNAVAILABLE — verdicts are unknown since 14:07Z        │  ← 2 health strip (only when not all-ok)
│          store ok · control plane ok · executor ok · outbox 3/1/0        │
├──────────────────────────────────────────────────────────────────────────┤
│                                                                          │
│  NEEDS YOU  2                                                           │  ← 3 region A
│                                                                          │
│  [■] BUDGET ENVELOPE      U-7f3a9c                                       │
│      Raise the per-unit envelope from $2.00 to $4.00?                    │
│      → factory budget raise --to 4.00 --reason "<why>"                   │
│                                                                          │
│  [■] ESCAPE-RATE REVIEW   3 units awaiting human re-validation           │
│      → factory audit --escape-rate --since 2026-10-01                    │
│                                                                          │
├──────────────────────────────────────────────────────────────────────────┤
│                                                                          │
│  WORKING  2                                                             │  ← 4 region B
│                                                                          │
│  U-b221  dark    [~] RUNNING    turn 7 · 88,540/250,000 tok · 4m12s      │
│          "rate limit the export endpoint"             no-progress: ok    │
│                                                                          │
│  U-c0d4  dark    [?] AMBIGUOUS  attempt A-01 · silent 5m29s              │
│          "fix the slug collision"      NOT retried. Observe, then decide.│
│                                                                          │
├──────────────────────────────────────────────────────────────────────────┤
│                                                                          │
│  RECENT VERDICTS  4                                                     │  ← 5 region C
│                                                                          │
│  [✓] PASSED    U-7f3a9c  "slug check"        Δ 0.00   wall-2026.11.1     │
│                9/9 holdout · receipt R-3d21 faithful · 14:11Z            │
│                                                                          │
│  [?] UNKNOWN   U-91c2   "dedupe slugs"       Δ unknown                   │
│                wall unavailable during verification · not a pass          │
│                                                                          │
├──────────────────────────────────────────────────────────────────────────┤
│  BUDGET   today $6.41 estimated / $20.00  ·  per-unit $2.00  ·  reserved  │  ← 6 budget block
│           $0.90 estimated  ·  0 units unmeasured  ·  price table p3      │
│           [████████▒▒▒▒▒▒▒▒▒▒▒▒░░░░░░░░]  32% est.  (▒ = estimated)      │
├──────────────────────────────────────────────────────────────────────────┤
│  Δ BY TASK CLASS                                                         │  ← 7 delta table
│   cli-text      Δ 0.04   n=13   stable           escape 0/8              │
│   db-migration  Δ unknown n=2   unstable (n<5)   escape 0/3              │
├──────────────────────────────────────────────────────────────────────────┤
│  factory 0.1.0 · dsh 0.2.1-rc.3 (pinned) · policy q-2026.11.1 ·          │  ← 8 footer
│  wall-2026.11.1 · holdout h-88f1 · generated 14:22:07Z · 10s refresh     │
└──────────────────────────────────────────────────────────────────────────┘
```

### 2.2 Container map

| Region                | Content                                                                            | Constraint                                                                                                                                                                                                    |
| --------------------- | ---------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **1 Header**          | `<h1>factory status</h1>` + one-line answer (`0 need you · 2 working · 1 unknown`) | One line, ≤ 100 chars, never wraps into the strip                                                                                                                                                             |
| **2 Health strip**    | 6 health items, 3-state                                                            | **Hidden entirely when all `ok`** — this is the page's silence rule (mirrors the CLI's one-liner). Appears the moment any item is `degraded`/`unavailable`, and pushes content down rather than overlaying it |
| **3 Needs you**       | Gate cards, lit units, ambiguous attempts, unknown verdicts, escape-rate items     | Empty state is a printed sentence, not a blank region: `nothing needs you`                                                                                                                                    |
| **4 Working**         | Unit rows for `dispatched`/`running`/`verifying`                                   | Collapses to one line per unit; no per-turn history                                                                                                                                                           |
| **5 Recent verdicts** | Last 5 terminal units                                                              | Verdict card per unit; `unknown` never sorted below `failed`                                                                                                                                                  |
| **6 Budget**          | Envelope, spend, reserved, unknown count, meter                                    | Always visible, always provenance-tagged                                                                                                                                                                      |
| **7 Δ by task class** | One row per class present in the ledger                                            | Never aggregated; `unknown` is a value                                                                                                                                                                        |
| **8 Footer**          | Versions, revisions, `generatedAt`, refresh interval                               | Monospace, muted, 12 px                                                                                                                                                                                       |

### 2.3 Responsive behaviour

| Breakpoint | Width      | Behaviour                                                                                                                                     |
| ---------- | ---------- | --------------------------------------------------------------------------------------------------------------------------------------------- |
| Wide       | ≥ 900 px   | Single column, max content width **900 px**, centred; regions stack                                                                           |
| Narrow     | 480–900 px | Same column, full width, 16 px gutters                                                                                                        |
| Phone      | < 480 px   | Same column; unit rows wrap to two lines; **no horizontal scroll at 320 px**                                                                  |
| 200 % zoom | any        | No fixed heights, no `nowrap` on prose, no truncation — text wraps; the budget meter keeps its text label so the fill is not the only channel |

There is **no horizontal scroll anywhere** and no fixed-width table. Tables use `table-layout: auto` with wrapped cells.

---

## 3. Visual system

A minimal token set. Nine colours, one 4/8 spacing scale, five type sizes, two families. Everything below is the complete system — there is no tenth colour and no sixth size.

### 3.1 Colour tokens

Semantic roles only; no token is used for two meanings. Light and dark are separate value sets behind the same role names, selected by `prefers-color-scheme` (no JS, no switcher, no storage).

| Role        | Light     | Dark      | Used for                                                                                      |
| ----------- | --------- | --------- | --------------------------------------------------------------------------------------------- |
| `--bg`      | `#FFFFFF` | `#141413` | Page background                                                                               |
| `--surface` | `#F5F5F2` | `#1E1E1C` | Region blocks, card backgrounds                                                               |
| `--text`    | `#141413` | `#F4F3EE` | Body and headings                                                                             |
| `--muted`   | `#57574F` | `#A6A59C` | Meta lines, footer, timestamps, labels                                                        |
| `--border`  | `#C9C8C0` | `#3A3A34` | Hairlines, region separators, meter track                                                     |
| `--ok`      | `#14603A` | `#5FB57F` | `PASSED`, `ok`, `dark` lane, `stable`                                                         |
| `--warn`    | `#7A4A00` | `#D9A03C` | `degraded`, ceilings near limit, `lit` lane                                                   |
| `--danger`  | `#9E1B1B` | `#EE8A80` | `FAILED`, `unavailable`, `STORE_QUARANTINED`                                                  |
| `--unknown` | `#4B3A8C` | `#B3A1EF` | `UNKNOWN`, `AMBIGUOUS`, `not measured` — **its own hue, deliberately not grey and not green** |

`--info` (`#17568F` / `#7FB2E6`) exists only for links/commands; it is not a state colour. That is 10 values for 9 _roles_ (bg/surface/text/muted/border + 4 states + info), within the 5–7 base-colour guidance in `ui-design.md` once neutrals are counted as one family.

### 3.2 Spacing and type

**Spacing scale — 4 / 8 base, eight steps, no other values:**

`--s1: 4px · --s2: 8px · --s3: 12px · --s4: 16px · --s5: 24px · --s6: 32px · --s7: 48px · --s8: 64px`

Usage: intra-component 4–8, between lines of a record 8, between records 16, between regions 24, region padding 16 (narrow) / 24 (wide).

**Type scale — five sizes, two families:**

| Role | Size / line-height | Weight | Family                                      | Usage                                       |
| ---- | ------------------ | ------ | ------------------------------------------- | ------------------------------------------- |
| `h1` | 20 / 28            | 600    | UI sans                                     | Page title only                             |
| `h2` | 15 / 22            | 600    | UI sans, `letter-spacing: .01em`, uppercase | Region titles (`NEEDS YOU`, `WORKING`)      |
| body | 15 / 22            | 400    | UI sans                                     | Unit titles, gate questions                 |
| meta | 13 / 18            | 400    | UI sans                                     | Timestamps, reasons, secondary facts        |
| mono | 12 / 18            | 400    | UI mono                                     | Ids, commands, versions, numbers, `UNKNOWN` |

Families: `ui-sans` = `-apple-system, "Segoe UI", system-ui, sans-serif`; `ui-mono` = `ui-monospace, "SF Mono", Menlo, Consolas, monospace`. **No webfont is loaded** — zero network requests, no FOUT, no font licence, and the page renders identically offline. Per `ui-design.md`'s monospace rules: no monospaced headings, `letter-spacing` on the only large mono usage; never more than two families.

### 3.3 Contrast verification (calculated, not asserted)

WCAG 2.x relative-luminance ratios for every text/background pair actually used. Body text needs **4.5:1**; large text (≥ 18pt / 14pt bold) and UI boundaries need **3:1**.

| Pairing (light)                     | Ratio       | AA   | AAA  |
| ----------------------------------- | ----------- | ---- | ---- |
| `--text` #141413 on `--bg` #FFFFFF  | **18.43:1** | pass | pass |
| `--text` on `--surface` #F5F5F2     | **16.88:1** | pass | pass |
| `--muted` #57574F on `--bg`         | **7.29:1**  | pass | pass |
| `--muted` on `--surface`            | **6.67:1**  | pass | pass |
| `--ok` #14603A on `--bg`            | **7.60:1**  | pass | pass |
| `--ok` on `--surface`               | **6.96:1**  | pass | pass |
| `--warn` #7A4A00 on `--bg`          | **7.48:1**  | pass | pass |
| `--warn` on `--surface`             | **6.85:1**  | pass | pass |
| `--danger` #9E1B1B on `--bg`        | **8.00:1**  | pass | pass |
| `--danger` on `--surface`           | **7.32:1**  | pass | pass |
| `--unknown` #4B3A8C on `--bg`       | **9.20:1**  | pass | pass |
| `--unknown` on `--surface`          | **8.42:1**  | pass | pass |
| white #FFFFFF on filled `--ok` pill | **7.60:1**  | pass | pass |
| white on filled `--warn` pill       | **7.48:1**  | pass | pass |
| white on filled `--danger` pill     | **8.00:1**  | pass | pass |
| white on filled `--unknown` pill    | **9.20:1**  | pass | pass |

| Pairing (dark)                                                        | Ratio                           | AA   | AAA  |
| --------------------------------------------------------------------- | ------------------------------- | ---- | ---- |
| `--text` #F4F3EE on `--bg` #141413                                    | **16.59:1**                     | pass | pass |
| `--text` on `--surface` #1E1E1C                                       | **15.03:1**                     | pass | pass |
| `--muted` #A6A59C on `--bg`                                           | **7.45:1**                      | pass | pass |
| `--muted` on `--surface`                                              | **6.75:1**                      | pass | pass |
| `--ok` #5FB57F on `--bg`                                              | **7.38:1**                      | pass | pass |
| `--ok` on `--surface`                                                 | **6.68:1**                      | pass | pass |
| `--warn` #D9A03C on `--bg`                                            | **7.94:1**                      | pass | pass |
| `--warn` on `--surface`                                               | **7.19:1**                      | pass | pass |
| `--danger` #EE8A80 on `--bg`                                          | **7.53:1**                      | pass | pass |
| `--danger` on `--surface`                                             | **6.82:1**                      | pass | pass |
| `--unknown` #B3A1EF on `--bg`                                         | **8.13:1**                      | pass | pass |
| `--unknown` on `--surface`                                            | **7.36:1**                      | pass | pass |
| `#141413` on filled dark `--ok`/`--warn`/`--danger`/`--unknown` pills | **7.38 / 7.94 / 7.53 / 8.13:1** | pass | pass |

**Every implemented pairing clears AAA (≥ 7:1) except the two muted-on-surface pairs, which clear AA comfortably (6.67:1 and 6.75:1).** The lowest ratio anywhere on the page for text is 6.67:1. Borders (`1.68:1` light / `1.61:1` dark) are decorative hairlines, carry no meaning, and are never the sole channel for a state.

Focus ring (the only interactive-ish element — links/commands, which are selectable text and anchors): `2px solid var(--text)` with `2px` offset = **18.43:1** against the page, `16.88:1` against surfaces, well over the 3:1 non-text requirement.

**Verification method:** ratios computed from the WCAG relative-luminance formula over the exact hex values above, for both themes, and asserted in `e2e/panel/contrast.spec.ts` by re-computing from the rendered `getComputedStyle` values — a token edit that breaks a ratio fails the build rather than shipping.

### 3.4 Mandatory non-colour redundancy

Three independent channels for every state. The rule: **delete the colour and the page still parses; delete the colour _and_ the glyph and it still parses from the word alone.**

| Channel | Implementation                                                                                                                                                                                                                                           |
| ------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Glyph   | `[✓]` passed/ok · `[×]` failed/unavailable · `[?]` unknown/ambiguous · `[~]` running · `[■]` needs you · `[—]` rejected/deferred. ASCII only — renders in every terminal, screen reader and font stack, and survives being copied into a plain-text note |
| Word    | `PASSED` · `FAILED` · `UNKNOWN` · `AMBIGUOUS` · `RUNNING` · `NEEDS YOU` — uppercase, present in the DOM as text, never in an `::before` pseudo-element or a background image                                                                             |
| Colour  | The token, applied to the glyph+word, never to a bare shape                                                                                                                                                                                              |

Additionally: `unknown` is never rendered with a green element anywhere (not even a green border on its card), and the budget's `estimated` state is carried by a text label + a `~` prefix + a dashed fill pattern, so it survives greyscale, colour-blindness, and a monochrome printer.

### 3.5 Light/dark

`@media (prefers-color-scheme: dark)` swaps the nine token values; nothing else changes. No `data-theme`, no JS, no localStorage, no toggle — a toggle would be the page's only control and would violate read-only scope in spirit. `prefers-reduced-motion` is honoured by having no motion: the page never animates, never transitions, and never re-renders incrementally.

---

## 4. Component inventory

Six components. Each is defined by its states, its content rules, and the anti-pattern it exists to avoid.

### 4.1 Status pill

```
[✓] PASSED      [×] FAILED      [?] UNKNOWN      [~] RUNNING
[■] NEEDS YOU   [—] REJECTED    [·] QUEUED       [?] AMBIGUOUS
```

| Property             | Rule                                                                                                                                                                                                  |
| -------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| States               | `queued`, `running`, `verifying`, `passed`, `failed`, `unknown`, `ambiguous`, `rejected`, `needs-you`, `aborted`                                                                                      |
| Structure            | `<span class="pill pill--unknown"><span aria-hidden="true">[?]</span> UNKNOWN</span>` — glyph is `aria-hidden` (the word carries it), word is real text                                               |
| Content rule         | The word is the state name from `ux-plan.md` §2, uppercased. Never a synonym (`DONE`, `ERROR`, `PENDING`, `N/A`)                                                                                      |
| Colour rule          | `unknown`/`ambiguous` → `--unknown`; `failed`/`aborted` → `--danger`; `passed` → `--ok`; `running`/`verifying` → `--muted` (a running thing is not "good", it is just moving); `needs-you` → `--warn` |
| Anti-pattern avoided | **Colour-only status** (the #1 accessibility failure) and **false green**: `RUNNING` is deliberately muted rather than green, so "in progress" can never be read as "fine" (finding A-1)              |

### 4.2 Unit row

```
U-b221  dark    [~] RUNNING    turn 7 · 88,540/250,000 tok · 4m12s
        "rate limit the export endpoint"                    no-progress: ok
```

| Property                      | Rule                                                                                                                                                                                                     |
| ----------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| States                        | One row per non-terminal unit; the pill carries the state                                                                                                                                                |
| Content (line 1, mono)        | `unitId` · lane (`dark`/`lit`) · pill · attempt facts: `turn N`, `tokens used/ceiling`, `elapsed`, and for terminal units the verdict id                                                                 |
| Content (line 2, body + meta) | The unit title (from the spec, quoted, never model-generated prose) · the progress signal (`no-progress: ok` / `no-progress: 3/5` / `silent 5m29s`)                                                      |
| Content rules                 | **Never** the diff, never the narrative, never a percentage, never an ETA. Tokens are shown as `used/ceiling` because the ceiling is the honest denominator; a lone token count invites "is that a lot?" |
| Ambiguous variant             | Adds the third line, mandatory: `NOT retried. Observe, then decide.` and links are text commands, not buttons                                                                                            |
| Anti-pattern avoided          | **Magic pushbutton / opaque background process** (`ui-design.md` Table 3) — the row states what the machine is doing and what it is _not_ doing (no redispatch)                                          |

### 4.3 Verdict card

```
[✓] PASSED    U-7f3a9c  "slug check"        Δ 0.00   wall-2026.11.1
              9/9 holdout · receipt R-3d21 faithful · 14:11Z
              not promoted — first promotion needs your signature
```

| Property             | Rule                                                                                                                                                                                                         |
| -------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| States               | `passed`, `failed`, `unknown` (and `unknown`-because-wall-unavailable, which is the one that matters)                                                                                                        |
| Content — passed     | Σ holdout (passed/total with the 2-of-3 rule stated in `title`), Δ with sample n, wall version, receipt id + `faithful`, timestamp, promotion state                                                          |
| Content — failed     | The same plus the Δ that separated visible from holdout (e.g. `visible 9/9 − holdout 6/9 = Δ 0.31`), and nothing about scenario content                                                                      |
| Content — unknown    | `Δ unknown`, `wall unavailable during verification`, the outage window, and the literal line **`not a pass`**                                                                                                |
| Content rule         | The delta is always printed as the subtraction, never as a score. A score invites optimisation; a subtraction is a measurement                                                                               |
| Anti-pattern avoided | **Scaremongering** on one side and **false reassurance** on the other: `unknown` is styled in `--unknown` (a distinctive violet), not red (which would imply failure) and not green (which would imply pass) |

### 4.4 Budget meter — with an unmistakable _estimated_ state

```
BUDGET  today  $6.41 estimated / $20.00        per-unit $2.00     reserved $0.90 estimated
        0 units unmeasured · price table p3 · no billing-grade telemetry
        [████████▒▒▒▒▒▒▒▒▒▒▒▒░░░░░░░░░░░░░░░░]   32% estimated
         └ measured  └ estimated  └ headroom
```

| Property                  | Rule                                                                                                                                                                                                                                                                                                                                                                              |
| ------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| States                    | `measured` (never occurs in v1 — there is no billing-grade telemetry), `estimated`, `unknown` (telemetry missing), `degraded` (some units unmeasured → spend understated)                                                                                                                                                                                                         |
| Structure                 | A single bar whose segments are `measured` (solid `--text`), `estimated` (dashed/hatched `--muted` fill), `headroom` (`--border`) — plus a **text line above the bar** carrying every number and its provenance                                                                                                                                                                   |
| Content rules             | (a) the word `estimated` is appended to every estimated figure, in the same line, not a footnote; (b) `unknown` replaces the number, never `0`; (c) `reserved` is shown separately from `spent` (the reservation is why a dispatch can be refused before any token is spent); (d) `price table p3` names the estimate's origin; (e) `no billing-grade telemetry` states the limit |
| Estimated is unmistakable | Dashed fill + `~` prefix on the figure + the literal word + a `title`/`<figcaption>`; **never** a solid fill. Asserted in a greyscale screenshot test                                                                                                                                                                                                                             |
| Degraded                  | When `budget.unknownCount > 0`: the bar shows a **gap** (not a fill), and the line reads `2 units unmeasured — spend understated`                                                                                                                                                                                                                                                 |
| Anti-pattern avoided      | **Price comparison prevention / hidden costs** (`ux-design.md` category 5): a green meter over an estimated number is the exact pattern A-2 describes. Also avoids **misdirection** — the number is text first, graphic second                                                                                                                                                    |

### 4.5 Health item

```
store ok · control plane ok · executor ok · wall UNAVAILABLE · outbox 3/1/0 · dsh 0.2.1-rc.3 ok
```

| Property             | Rule                                                                                                                                                                                                                                                                                                                      |
| -------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| States               | **Three, never a boolean:** `ok`, `degraded`, `unavailable` (plus `unknown` for "cannot be measured" — used when the store is quarantined and health itself is stale)                                                                                                                                                     |
| Content              | `<name> <state>` plus, when not `ok`, `<detail> since <time>`                                                                                                                                                                                                                                                             |
| Display rule         | The strip is **absent when every item is `ok`** (silence by default). When any item is not `ok`, the strip appears with the worst item first and the rest on a muted second line                                                                                                                                          |
| Per item             | store (integrity, schema, ledger head) · control plane (uptime) · executor (kind + image digest) · wall (up + holdout revision) · outbox (`pending/retrying/dead`) · dsh version (`expected vs observed`)                                                                                                                 |
| Anti-pattern avoided | **"Silent failure"** (`ui-design.md`: "actions result in zero visual change… users are left guessing") — a page that is quiet because the control plane died is indistinguishable from a page that is quiet because nothing needs doing. Also avoids boolean health, which cannot express "up but degraded" (finding A-1) |

### 4.6 Warning banner (for `unknown` / quarantined / `DSH_VERSION_MISMATCH`)

```
┌ ! ─────────────────────────────────────────────────────────────────────┐
│ STORE QUARANTINED — the factory is read-only.                          │
│ ledger chain break at event 8812 · detected 14:31:02Z                   │
│ Every write is refused (intent, run, promote, budget, credential).      │
│ Do not reset, delete or repair this store. Runbook:                    │
│ docs/runbooks/store-quarantine.md                                      │
└────────────────────────────────────────────────────────────────────────┘
```

| Property             | Rule                                                                                                                                                                                                                                                                   |
| -------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| States               | `quarantined` (danger, full width, above everything including the header), `unknown` (unknown-colour, inside `Needs you`), `version-mismatch` (danger, above `Working`), `wall-unavailable` (warn, inside the health strip)                                            |
| Content rules        | States the condition, the _evidence_ (event number, expected/observed version), the _consequence_ (`read-only`), the **prohibition** (`do not reset…`), and the runbook path. Never a dismiss/close control — a banner you can dismiss is a banner that gets dismissed |
| Anti-pattern avoided | **Scaremongering** (the copy contains no urgency, no "act now") and **roach motel** (every banner names its exit condition: what would make it go away)                                                                                                                |

---

## 5. Data contract

### 5.1 `GET /api/status`

One object, exactly mirroring `architecture.md` §4's `{units, waitingOnPerson, health, budget}` — the four top-level keys are normative and additional data is placed **inside** them rather than as new top-level keys, so the contract in §4 is the contract. Δ per task class lives in `health.taskClasses[]` because it _is_ a health metric (when Δ is unknown, the wall cannot certify), and `factory`/`generatedAt` are envelope fields shared with `/api/status`'s error shape.

```jsonc
{
  "schemaVersion": "status.v1",
  "generatedAt": "2026-11-01T14:22:07.412Z", // RFC3339, UTC, ms
  "factory": {
    "version": "0.1.0",
    "dshVersionExpected": "0.2.1-rc.3",
    "dshVersionObserved": "0.2.1-rc.3",
    "policyVersion": "q-2026.11.1",
    "wallVersion": "wall-2026.11.1",
    "holdoutRevision": "h-88f1",
  },

  "waitingOnPerson": [
    // THE page's reason to exist
    {
      "id": "G-1c77",
      "kind": "budget_envelope_raise", // budget_envelope_raise |
      // initial_production_deploy |
      // privileged_credential_issuance |
      // lit_unit | ambiguous_attempt |
      // unknown_verdict | escape_rate_review
      "unitId": "U-7f3a9c", // null when not unit-scoped
      "question": "Raise the per-unit envelope from $2.00 to $4.00?",
      "recommendedCommand": "factory budget raise --to 4.00 --reason \"<why>\"",
      "irreversible": true,
      "since": "2026-11-01T14:12:02Z",
    },
  ],

  "units": [
    {
      "unitId": "U-b221",
      "title": "rate limit the export endpoint", // from the spec, verbatim
      "lane": "dark", // dark | lit | reject
      "state": "running", // queued | dispatched | running |
      // verifying | verified | promoted |
      // failed | unknown | ambiguous | aborted
      "attempt": {
        "attemptNo": 1,
        "state": "running",
        "turn": 7,
        "tokensUsed": 88540,
        "tokenCeiling": 250000,
        "wallClockCeilingS": 3600,
        "startedAt": "2026-11-01T14:17:55Z",
        "lastProgressAt": "2026-11-01T14:21:58Z",
        "noProgressStreak": 0, // 0 = ok; ≥3 shown as a warning signal
      },
      "verdict": null, // or see §5.2
      "promotion": null, // or {"id","signedAt","signedBy"}
      "updatedAt": "2026-11-01T14:21:58Z",
    },
    {
      "unitId": "U-c0d4",
      "title": "fix the slug collision",
      "lane": "dark",
      "state": "ambiguous",
      "attempt": {
        "attemptNo": 1,
        "state": "ambiguous",
        "turn": 9,
        "tokensUsed": 121003,
        "tokenCeiling": 250000,
        "wallClockCeilingS": 3600,
        "startedAt": "2026-11-01T14:02:11Z",
        "lastProgressAt": "2026-11-01T14:07:40Z",
        "noProgressStreak": 0,
      },
      "ambiguity": {
        // present iff state == "ambiguous"
        "known": "the attempt started and did not report a terminal event",
        "unknown": "whether the final tool call took effect outside the worktree",
        "notDone": "nothing was retried; no second attempt exists",
        "observedAt": "2026-11-01T14:22:00Z",
      },
      "verdict": null,
      "promotion": null,
      "updatedAt": "2026-11-01T14:22:00Z",
    },
  ],

  "health": {
    "store": {
      "state": "ok",
      "quarantined": false,
      "schemaVersion": 4,
      "ledgerHead": "9f21c0d8…",
      "detail": null,
      "since": null,
    },
    "controlPlane": { "state": "ok", "uptimeS": 8123, "detail": null, "since": null },
    "executor": {
      "state": "ok",
      "kind": "headless",
      "image": "factory-env@sha256:4e1c…",
      "detail": null,
      "since": null,
    },
    "wall": {
      "state": "unavailable",
      "holdoutRevision": "h-88f1",
      "detail": "docker daemon unreachable",
      "since": "2026-11-01T14:07:40Z",
    },
    "outbox": {
      "state": "degraded",
      "pending": 3,
      "retrying": 1,
      "dead": 0,
      "detail": "verify U-b221 backoff 8s",
      "since": null,
    },
    "dshVersion": {
      "state": "ok",
      "expected": "0.2.1-rc.3",
      "observed": "0.2.1-rc.3",
      "detail": null,
      "since": null,
    },

    "taskClasses": [
      {
        "class": "cli-text",
        "delta": {
          "value": 0.04,
          "samples": 13,
          "state": "stable",
          "measuredAt": "2026-11-01T13:40:00Z",
        }, // value null + state "unknown"
        // when holdout did not run
        "escapeRate": { "value": 0.0, "samples": 8, "state": "measured" },
      },
      {
        "class": "db-migration",
        "delta": { "value": null, "samples": 2, "state": "unknown", "measuredAt": null },
        "escapeRate": { "value": 0.0, "samples": 3, "state": "measured" },
      },
    ],
  },

  "budget": {
    "currency": "USD",
    "priceTableVersion": "p3",
    "telemetry": "estimated", // estimated | unknown  (never "measured" in v1)
    "note": "no billing-grade telemetry; usage-derived estimate",
    "perUnit": { "limit": 2.0, "kind": "estimated" },
    "perDay": {
      "limit": 20.0,
      "spent": 6.41,
      "reserved": 0.9,
      "kind": "estimated",
      "measuredSpent": null,
    },
    "unknownCount": 0, // >0 ⇒ meter renders a gap + "spend understated"
    "state": "ok", // ok | degraded | unknown
  },
}
```

### 5.2 Verdict object (inside `units[]`)

```jsonc
{
  "verdictId": "V-4c8e",
  "state": "passed", // passed | failed | unknown
  "wallVersion": "wall-2026.11.1",
  "holdoutRevision": "h-88f1",
  "policyVersion": "q-2026.11.1",
  "holdout": { "passed": 9, "total": 9, "rule": "triple-run 2-of-3, aggregate ≥90%" },
  "delta": {
    "value": 0.0,
    "visiblePassRate": 1.0,
    "holdoutPassRate": 1.0,
    "samples": 13,
    "state": "stable",
  }, // value null + state "unknown" when unmeasured
  "receipt": { "receiptId": "R-3d21", "faithful": true, "contentHash": "sha256:7b02e1…" },
  "unknownReason": null, // REQUIRED non-null iff state == "unknown":
  // e.g. "docker daemon unreachable 14:07:40Z–14:19:02Z"
  "signed": { "alg": "ed25519", "keyId": "ed25519:9f41…", "verified": true },
  "promotionBlocked": "first promotion requires human signature", // or null
  "createdAt": "2026-11-01T14:11:40Z",
}
```

### 5.3 Contract rules

| Rule                                                                                                | Enforcement                                                                                                                                                                                                                |
| --------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `state` values are a closed set (`zod` enum in `packages/contracts`)                                | Schema validation on every response; unknown value ⇒ page refuses to render that component and shows a banner (fail closed, not best-effort)                                                                               |
| `value: null` + `state: "unknown"` is the **only** way to express "not measured"                    | Never `0`, never omitted, never `"N/A"`                                                                                                                                                                                    |
| `unknownReason` non-null iff verdict `state == "unknown"`                                           | Refined `zod` schema                                                                                                                                                                                                       |
| `budget.telemetry` is a string enum, not a boolean                                                  | A boolean `estimated: true/false` would let a UI show a bare number when false; the enum forces the provenance into the render path                                                                                        |
| Ids (`U-`, `A-`, `R-`, `V-`, `G-`, `P-`, `T-`, `M-`) are the same strings as the CLI and the ledger | Shared regex from `packages/contracts`                                                                                                                                                                                     |
| Auth                                                                                                | `Authorization: Bearer <token>`; token file `~/.factory/state/panel.token` (0600, generated at first start). `401` with `{"ok":false,"code":"UNAUTHORIZED"}` and **no** body detail; the HTML page shows the same 401 text |
| Bind                                                                                                | `127.0.0.1` only, port from config (default `7373`); refuses to start on a non-loopback bind                                                                                                                               |
| Caching                                                                                             | `Cache-Control: no-store` on both routes                                                                                                                                                                                   |
| Latency                                                                                             | `/api/status` reads aggregates only; p95 < 50 ms at 10 k units; the page does **not** query the wall                                                                                                                       |
| Freshness                                                                                           | `<meta http-equiv="refresh" content="10">`; `generatedAt` in the footer so a stale page is visibly stale                                                                                                                   |

---

## 6. Non-goals

1. **No writes.** No acknowledge, dismiss, sign, retry, raise, or "mark as read". Gates are signed in the CLI; the page only names the command. (`phased-plan.md` IN 24: read-only.)
2. **No diff rendering, ever.** Not a collapsed one, not a "view change" link. The diff is the artifact the design exists to remove from human attention (`ux-plan.md` §0).
3. **No charts, sparklines, gauges, or trend lines.** Every chart implies measurement precision we do not have (A-2), and a sparkline of an estimated number is decoration pretending to be evidence.
4. **No notifications** (desktop, email, webhook). The single operator looks at the page or the CLI; the plan has no notification channel in scope, and adding one would imply an on-call rotation that does not exist.
5. **No history browsing / search / filtering UI.** `factory audit` is the history interface. The page shows current state + last 5 verdicts.
6. **No authentication beyond the loopback token**, no users, no roles, no audit trail of page views.
7. **No client-side JS.** If a future requirement needs interactivity, it goes in the CLI, which is scriptable and testable.
8. **No i18n / theming / density settings.** One language (English), two colour schemes via `prefers-color-scheme`.
9. **No design-system dependency, no webfonts, no icon set, no build step.** ~40 lines of CSS in one `<style>` block.

---

## 7. Accessibility checklist

### Structure and semantics

- [x] `<html lang="en">`, one `<h1>`, regions as `<header>`, `<main>`, `<section aria-labelledby>` with `<h2>` per region.
- [x] Landmarks are unique and labelled; skipping regions via screen-reader landmark navigation lands on the right place.
- [x] Tabular data uses real `<table>`/`<th scope>` (`Δ BY TASK CLASS`); no `div` grids.
- [x] Timestamps in `<time datetime="…">`; ids in `<code>`; commands copyable as text.
- [x] The document is fully readable with **JS disabled** (no JS exists) and with **CSS disabled** (a linear text document; region headings still order it).
- [x] `title` attributes are never the only source of information.

### Colour and contrast

- [x] Every text/background pair meets WCAG AA, and in fact ≥ 6.67:1 for all text (AAA for all but two pairs) — measured in §3.3, asserted in `e2e/panel/contrast.spec.ts`.
- [x] No information is conveyed by colour alone: glyph + word + colour on every state (§3.4).
- [x] `unknown` has its own hue distinct from `ok` and `danger` under deuteranopia/protanopia simulation (violet vs green/red) and is never adjacent-dependent: the word is present.
- [x] The `estimated` budget state is distinguishable in greyscale (dashed fill + `~` + word).
- [x] Light and dark both verified; `prefers-color-scheme` respected; no state relies on a dark-only or light-only token.
- [x] Focus indicator ≥ 3:1 (18.43:1) and visible on both themes.

### Motion, zoom, reflow

- [x] No animation, no transitions, no auto-scrolling, no marquee; `prefers-reduced-motion` is a no-op because there is nothing to reduce.
- [x] 200 % text zoom: no clipping, no overlap, no horizontal scroll (single column, no fixed heights, no `nowrap` on prose).
- [x] Reflows to 320 px wide without horizontal scrolling (WCAG 1.4.10).
- [x] No text in images; no images at all.

### Keyboard

- [x] Everything is reachable and readable by keyboard alone: the page has **no controls**; the only focusable elements are anchors to docs/runbook paths.
- [x] No keyboard trap (nothing traps), no focus-order dependency, no `onKeyDown` handlers.
- [x] Visible focus on every focusable element.

### Content

- [x] Error/`unknown` copy is plain language with a next action; no raw stack traces, no bare codes without a sentence.
- [x] The single most important distinction (`unknown` ≠ pass) is stated in words on every surface it appears.
- [x] No dark patterns: no urgency, no social proof, no dismiss controls, no default-to-proceed; consistent with `ux-plan.md` §7.

### Testing

| Check                                                                     | Where                                           |
| ------------------------------------------------------------------------- | ----------------------------------------------- |
| Rendered contrast re-computed from computed styles                        | `e2e/panel/contrast.spec.ts`                    |
| State rendered as text (word present in DOM, `aria-hidden` on glyph only) | `e2e/panel/a11y.spec.ts`                        |
| `unknown` is not green; `estimated` present as text                       | `e2e/panel/unknown-not-green.spec.ts`           |
| 401 without token                                                         | `e2e/panel/auth.spec.ts`                        |
| Greyscale screenshot of the budget meter                                  | `e2e/panel/budget-estimated.spec.ts` (snapshot) |
| No-JS / no-CSS render order                                               | `e2e/panel/no-js.spec.ts`                       |

---

## Status

**Status:** draft complete (Phase 8). Wording/visual review pending; depends on `architecture.md` §11 debate outcomes only for the health-item list.
**Started:** 2026-11-01
**Completed:** —
