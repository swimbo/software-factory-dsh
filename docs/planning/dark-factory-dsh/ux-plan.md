# UX Plan — The Dark Software Factory on DSH

**Status:** draft, Phase 7. Pending Phase 5 debate outcomes for `architecture.md` §11.
**Surface:** `apps/cli` (C9) — the operator CLI. The status page is [`ui-plan.md`](ui-plan.md); its UX rules are inherited from §6 and §7 here.
**Companions:** [`architecture.md`](architecture.md) · [`phased-plan.md`](phased-plan.md) · [`findings.md`](findings.md) · [`research/pain-points.md`](research/pain-points.md) · [`ui-plan.md`](ui-plan.md) · [`e2e-tests.md`](e2e-tests.md) · [`user-stories.md`](user-stories.md) (Phase 4; the `US-…` ids referenced here are defined in the _Story registry_ at the end of this file)

**Research basis:** `research/ux-design.md` (Nielsen heuristics, Shneiderman's eight golden rules, the 14-category dark-pattern taxonomy, 12-factor CLI, Heroku CLI style guide, Microsoft HAX, terminal/screen-reader accessibility) · `research/kickoff-research.md` §Phase 7/8 (`NO_COLOR` semantics, FreeBSD a11y guidance) · `research/pain-points.md` T6/T7.

---

## 0. Design principle

> **Take as little human attention as possible, and give as much value as possible.**
> In this factory the human's scarce attention is spent on **intent, specs, scenarios and harness rules** — never on diffs.

This is the prior repo's operator philosophy (inherited, see `findings.md` "Invariants a new factory must inherit") sharpened by the two pieces of evidence that actually constrain the interface:

- **T6 — human review was already failing before the factory existed.** 48% of developers always check AI code; 64.9% of reviewers defer PRs whose intent they cannot read; AI PRs need ~3× more iterations to mergeable; 38% say AI code is _harder_ to review than human code. The design consequence is not "show the human a nicer diff". It is: **the diff is not the human's input any more**, and every surface that tempts the human to read one is a surface that re-creates the failing process.
- **T7 — intent ambiguity is upstream, cheap to fix, fatal if left downstream.** The `--dry-run` case (200 lines built for a 10-line need, tests green, unrecoverable) was an intent failure, not a code failure. The human's highest-leverage minute is **before dispatch**, confirming a restate-back — not after, reading a verdict.

So the attention budget is allocated deliberately:

| Where the human's attention goes                 | Budget per unit                           | Where it does **not** go                                        |
| ------------------------------------------------ | ----------------------------------------- | --------------------------------------------------------------- |
| Reading/confirming the restate-back at `intent`  | ~60 s, once, before work                  | Diffs (the CLI never prints one; `factory audit` prints a path) |
| Reading one reason line when a unit routes `lit` | ~20 s, only for units they must take over | Per-tool-call chatter, per-turn token tables                    |
| Answering a gate question                        | ~30 s, only at a gate (3 gates total)     | Progress bars, percentages, ETAs                                |
| Auditing a shipped unit (escape-rate sample)     | ~10 min per sampled unit, at a fixed rate | Anything during healthy operation                               |

**The silence rule follows from the budget.** A factory that narrates is a factory that spends the one resource the design exists to conserve. §4.1 makes this mechanical.

---

## 1. Actors

Personas live in `user-stories.md`; this table is the UX-relevant slice. **Single operator** is constraint C6 — there is no admin/user split, no tenancy, no roles, and no authorization model to design.

| Actor                                                        | Context                                                                                          | Primary goal                                             | Technical literacy       | Notes                                                                                                           |
| ------------------------------------------------------------ | ------------------------------------------------------------------------------------------------ | -------------------------------------------------------- | ------------------------ | --------------------------------------------------------------------------------------------------------------- |
| **Operator** (human, exactly one)                            | Terminal on the factory host; `factory` on `PATH`; occasionally the status page in a browser tab | Know _what needs me_ and spend nothing else              | High — writes code daily | The only signer of the 3 gates. The only reader of this document's output.                                      |
| **Requester** (human, same person in v1, role kept distinct) | Writes the unit spec + restate-back; may be an agent-driven editor session                       | Express intent so precisely that it is machine-derivable | High                     | **Distinct because their failure mode is different**: they author intent, the operator authorizes work          |
| **Worker agent** (non-actor)                                 | Untrusted container; sees a task prompt, a worktree, an allowlist                                | Do the work                                              | n/a                      | **Never reads the CLI, never sees these messages.** The one line of feedback it gets is opaque by design (§4.3) |

**Deliberately absent actors:** reviewer, approver, admin, team. A dark factory with a review role has re-imported the process it replaces.

---

## 2. Vocabulary the CLI uses

One word per concept, everywhere, including the status page and `--json` keys. No synonyms.

| Concept                               | Term                                         | Never say                  |
| ------------------------------------- | -------------------------------------------- | -------------------------- |
| Unit of intent                        | **unit** (`U-…`)                             | ticket, task, job, issue   |
| Immutable grant recorded per attempt  | **mandate** (`M-…`)                          | policy, permission         |
| Deterministic lane routing result     | **lane** = `dark` \| `lit` \| `reject`       | tier, mode, priority       |
| One dispatch of a unit                | **attempt** (`A-…`)                          | run, try, execution        |
| Content-hashed evidence from a worker | **receipt** (`R-…`)                          | report, result, summary    |
| Signed wall output                    | **verdict** (`V-…`)                          | score, grade, review       |
| Human authorization record            | **gate decision** (`G-…`)                    | approval, sign-off         |
| The signed promotion artifact         | **promotion** (`P-…`, file `promotion.yaml`) | release, deploy            |
| Visible-minus-holdout pass-rate gap   | **Δ** (spoken "delta")                       | gap, drift, spread         |
| Not measured / cannot be measured     | **`unknown`** (lowercase, monospace, always) | n/a, none, —, TBD, pending |

`unknown` is a _value_, not a blank. It is never rendered as an em dash, a zero, or an omission (`findings.md` invariant 2 / L3).

---

## 3. User flows

All flows below are literal: the command as typed, the output as printed, the exit code. Exit codes are defined once in §5.1 and used identically by the status page and the e2e suite. `$` = shell prompt; output shown here is **stderr** unless marked `stdout`.

Convention for every verb: **data on stdout, everything else on stderr, one exit code per outcome** (§8).

### 3.1 Flow 1 — Submit a unit (intent + acceptance criteria + restate-back)

The restate-back is the mechanism that makes T7 cheap. It is a paragraph, written by the requester, describing what they believe they asked for — including what they are **not** asking for. It is hashed into the mandate. The qualifier refuses any unit whose restate-back is missing or does not hash-match.

```
$ factory intent --file units/slug-check/spec.yaml --restate units/slug-check/restate-back.md
```

```
UNIT      U-7f3a9c
MANDATE   M-2b1e                 lane: unqualified   policy: q-2026.11.1
SPEC      sha256:9c1f0a7e…       (immutable; 1 file, 2 acceptance criteria)
RESTATE   sha256:4d2e77b3…       (bound to mandate)

ACCEPTANCE CRITERIA  (2 — both machine-checkable)
  1  cli/check.ts: slugify(" A B ") === "a-b"                  oracle=unit-test
  2  `node --test tests/` exits 0                              oracle=command

TOUCH-PATHS  cli/check.ts · tests/check.test.ts · (budget 200 lines / 8 files)
BLAST RADIUS none declared — no schema migration, no delete, no force-push, no
             credential use, no network egress  → reversibility signal OK
ORACLE       observable via unit-test + command  → observability signal OK

Lane: not yet qualified.
Next:  factory qualify U-7f3a9c        (expected: dark)
```

**stdout** (no `--json`): nothing. Submission produces no data payload the shell needs; the ids above go to stderr as human output and to the ledger as events. With `--json`, stdout gets exactly one object (§3.2 shows the shape once and it is not repeated).

- Happy path: exit `0`. If `--restate` is omitted the command still succeeds (the spec is valid) but prints one warning line on stderr and the unit **will** be rejected at qualify: `WARN restate-back absent — the qualifier will reject this unit (INTENT_NOT_DERIVABLE). Add one: factory intent --amend U-7f3a9c --restate <file>`. The warning is a _statement of consequence_, not a nudge (§7).
- Error path: `SPEC_INVALID` (exit 3) with the exact schema path — `units/slug-check/spec.yaml:12: acceptance[1].oracle: expected one of ["unit-test","command","http","data"], got "manual"`. A `manual` oracle is the single most common authoring mistake and gets a dedicated explanation (§5.2).
- Duplicate: submitting the identical spec twice returns the **same** `unitId` and `mandateId`, exit 0, and prints `UNIT U-7f3a9c (existing — spec hash unchanged, no new mandate)`. Same spec with a _different_ restate-back is `DUPLICATE_UNIT` (exit 3): the intent changed, so this is a new unit that collides with an old key — the operator must bump `spec.revision`.
- Recovery: none needed; nothing was dispatched.

### 3.2 Flow 2 — See _why_ a unit was routed `lit` instead of `dark`

This is the single highest-value read in the CLI after a verdict, because it is the moment the operator learns something about their own spec. It must be answerable in one command, with no second lookup, and it must answer with **measured signals, not a score**.

```
$ factory qualify U-91c2
```

```
LANE   lit          score 0.41        policy q-2026.11.1
WHY NOT dark — 2 blocking reason(s), 3 signals passing

  ✗ REVERSIBLE      declared touch-path db/migrations/0007_add_slug_unique.sql
                    is a schema migration (operation class: irreversible)
                    → a dark unit may not carry an irreversible operation
  ✗ OBSERVABLE      acceptance criterion 2 says "duplicate slugs stop appearing"
                    names no oracle (endpoint / command / data assertion)
                    → outcome not machine-observable

  ✓ INTENT_DERIVABLE  2/2 criteria machine-checkable; restate hash matches mandate
  ✓ SIZE_OK           projected 44 lines / 3 files (budget 200 / 8)
  ✓ BUDGET_OK         estimate $0.71 of $2.00 per-unit envelope (estimated)

WHAT THIS COSTS YOU: this unit is not dispatched. The factory has no verb that
runs a lit unit — that refusal is the design (throughput is capped by the wall,
not by the agent). Take the unit yourself, then:
    factory abort U-91c2 --reason "handled manually: schema migration reviewed by me"

TO MAKE IT DARK (your call, your edit — the CLI will not do it for you):
  1. split the migration out; keep the read-path change (reversible) in its own unit
  2. name an oracle for criterion 2, e.g. http GET /health → {"slug_ok": true}
  3. re-submit as a new revision: factory intent --file units/slug-check/spec.yaml
     (then: factory qualify <new unitId>)
```

- Happy path (`dark`): the same block with all `✓` and `Next: factory run U-7f3a9c`, exit 0.
- `reject` lane: exit 3, and the block leads with the one thing to fix, e.g. `✗ INTENT_DERIVABLE — 0/2 acceptance criteria machine-checkable; criterion 1 is prose ("looks right")`. A `reject` is _not_ an error the operator retries; it is a spec that must be rewritten (§5.3).
- **No score is ever shown without its reasons.** A bare `0.41` invites the operator to treat lane routing as a tunable dial and to ask for a threshold change — the qualifier is deterministic policy (L2), and the UI must not present it as a judgement call. The score is printed only for trend-watching, last, and dimmed.
- Re-qualification is keyed on `(unitId, policyVersion)`. Running the same `qualify` twice with the same policy prints the stored decision plus `(stored decision, policy q-2026.11.1 — not re-scored)`, exit 0. It re-scores only after a policy change, and says so: `RE-SCORED under policy q-2026.12.1 (was q-2026.11.1)`.

### 3.3 Flow 3 — Watch a dispatch

`factory run` blocks until the attempt reaches a terminal state (default), printing **one line per state transition** on stderr. That is the whole progress model.

```
$ factory run U-7f3a9c
```

```
dispatched   A-01  attempt 1/1  container factory-env@sha256:4e1c…  base a1b2c3d
running      turn 3    tokens 41,208 / 250,000   no-progress: ok
running      turn 7    tokens 88,540 / 250,000   no-progress: ok
receipt      R-3d21  diff 2 files +38/−4  commands 3  exits [0,0,0]
verifying    wall: re-executing commands in a clean checkout …
verifying    wall: 9 holdout scenarios × triple-run (2-of-3) …
verdict      V-4c8e  passed  Δ 0.00  holdout 9/9  wall wall-2026.11.1
promotion    withheld — first promotion of this unit requires your signature
             → factory promote U-7f3a9c
```

**What is shown:** state transitions; per-turn token count _only when the turn number changes_; the receipt summary line; wall phase transitions; the verdict line; the promotion state.

**What is silent, by rule:**

| Never shown                                           | Why                                                                                                                                                                     |
| ----------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Spinner / progress bar / percentage / ETA             | Cursor-addressing redraw loops are the one thing that reliably breaks screen readers (FreeBSD a11y guidance), and a percentage over a model loop is a fabricated number |
| Per-tool-call chatter ("reading file X")              | 8 MB of noise per attempt; the operator's attention budget is 60 s per unit, not 60 s per turn                                                                          |
| The model's prose / narrative                         | It has zero evidentiary weight (L1) — showing it invites the operator to form a judgement on non-evidence                                                               |
| The diff                                              | The entire point (§0). Path is available via `factory audit`, deliberately not printed                                                                                  |
| A countdown to "done"                                 | Unknown until the wall returns; predicting it is a lie the UI would have to retract                                                                                     |
| Anything at all while healthy and between transitions | Silence is the signal that nothing needs a person                                                                                                                       |

Flags: `--quiet` keeps only the final verdict/promotion lines; `--no-wait` returns after `dispatched` with exit 0 and the attempt id on stdout; `--json` streams the same transitions as NDJSON on stdout (one object per line, `{"event":…}`), which is what the e2e suite asserts on.

- Error path — ceilings hit: `killed A-01 wall-clock ceiling 3600 s exceeded; escalation container-kill → orphan sweep by session id → all children reaped. State: failed. Receipt captured from the diff at kill time.` Exit 0 **only** if the unit reached a verdict; a killed attempt that produced no verdict is exit 4 with `attempt failed (not ambiguous)` and the next command named.
- Error path — no progress: `killed A-01 no-progress: 5 consecutive status events with no tree-hash change (see ~/.factory/artifacts/U-7f3a9c/A-01/progress.jsonl)`.
- Error path — lane: `factory run U-91c2` → `LANE_NOT_DARK: U-91c2 is lane=lit. The factory does not dispatch lit units. See: factory qualify U-91c2`, exit 3.

### 3.4 Flow 4 — Handle `ambiguous` (observe, never retry)

The most important refusal in the product. It is the moment the interface must decline to be helpful.

```
$ factory run U-7f3a9c
```

```
AMBIGUOUS   A-01   attempt 1   unit U-7f3a9c
  dispatched   2026-11-01T14:02:11Z
  last seen    2026-11-01T14:07:40Z (5 min 29 s of silence)
  observed     process group 41233: gone · container: exited 137 ·
               git HEAD a1b2c3d: unchanged · session tree: 1 session, log truncated

  KNOWN    the attempt started and did not report a terminal event
  UNKNOWN  whether the final tool call took effect outside the worktree
  NOT DONE nothing was retried. No second attempt exists. This is deliberate:
           a duplicate side effect is unrecoverable, a lost attempt is not.

  Observe (read-only, safe, repeatable):
      factory status U-7f3a9c --attempt A-01
  Then choose — the CLI will not choose for you:
      factory abort U-7f3a9c --reason "<why>"     ends the unit, attempt stays ambiguous
      factory run U-7f3a9c --retry                creates attempt 2 (explicit opt-in)
```

- Exit code `4` for every `factory` invocation that returns an ambiguous state.
- The three-part framing (**KNOWN / UNKNOWN / NOT DONE**) is mandatory on every ambiguous surface, CLI and status page. It is the anti-dark-pattern that stops `ambiguous` degrading into "probably fine" (§7, finding A-1).
- `--retry` is the only path to a second attempt and it always requires `--reason` too: `factory run U-7f3a9c --retry --reason "container OOM, no git change observed"`. Retry is recorded as an operator decision in the ledger (`retry_authorized` event with the reason string).
- Crash-triggered reconciliation prints the same block with a different header: `RECONCILED — found at startup, not by you`. Same commands, same exit code.

### 3.5 Flow 5 — Read a verdict

```
$ factory audit U-7f3a9c --verdict
```

```
VERDICT  V-4c8e   passed   wall-2026.11.1   holdout rev h-88f1   policy q-2026.11.1
  receipt   R-3d21  sha256:7b02e1…   faithful: 3/3 commands re-executed, exit codes identical
  scenarios 9 × triple-run, 2-of-3 → 9/9 passed
  Δ         0.00   (visible 9/9 − holdout 9/9)   class cli-text   n=13 samples   stable
  signature ed25519:9f41… verified against ~/.factory/keys/evaluator.pub
  promoted  no  (needs your signature: factory promote U-7f3a9c)

WHAT THIS VERDICT DOES NOT CLAIM
  It is independent, deterministic where possible, adversarially tested and audited.
  It is not "safe". It does not judge taste. Nothing in this system can.
  A wall approving a bad change is the accepted residual risk (architecture.md §9.1).
```

- The `WHAT THIS VERDICT DOES NOT CLAIM` block is **not optional and not collapsible**. It is the honest-claim discipline of `findings.md` invariant 5 rendered as UI — and it is the direct counter to the `scoring`-style dark pattern (§7).
- Failure verdict: `VERDICT V-… failed` + `Δ 0.31 (visible 9/9 − holdout 6/9)` + the opaque generator line if it was fed back, and `Next: factory abort U-7f3a9c --reason …  |  fix the unit and resubmit a new revision`. Exit 3 for a failed (i.e. _known_, non-passing) verdict — this is a policy outcome, not an unknown, so it gets the "correct and resubmit" class, not the "stop and observe" class.
- `unknown` verdict: see §5.5. Exit 4.

### 3.6 Flow 6 — Raise a budget envelope (human gate 2)

```
$ factory budget raise --to 4.00 --reason "U-7f3a9c needs a second verification pass"
```

```
GATE  budget-envelope-raise                    (human-only; C6)

  per-unit envelope   $2.00  →  $4.00           currency USD, values ESTIMATED
  applies to          every unit dispatched from now on, until lowered
  current spend today $6.41 estimated of $20.00 daily envelope
  what this does NOT do
    · it does not measure anything — the price table (p3) is outside DSH and
      our numbers are estimates, never charges (no billing-grade telemetry)
    · it does not raise the daily envelope; that is a second, separate gate

  Sign by typing exactly:
      raise per-unit envelope to 4.00
  > raise per-unit envelope to 4.00

GateDecision G-1c77 recorded · operator key ed25519:ab02… · per-unit envelope = $4.00
The ledger entry is append-only. An agent cannot write it.
```

- Confirmation is a **typed phrase**, not `[y/N]`. Rationale: a single keystroke is the wrong cost for an irreversible authorization; a typed phrase forces the operator to read the _number they are authorizing_ (§7, "bad defaults" and "misdirection" checks). Enter-through is impossible: any other input aborts with exit 5 and prints `gate not signed; envelope unchanged ($2.00)`.
- Non-interactive (no TTY): the same gate requires `--confirm "raise per-unit envelope to 4.00"` as an exact-match argument. A mismatch is `GATE_REQUIRED` (exit 5), never a partial apply. There is **no `-y` / `--force` shortcut on any gate**, and that absence is tested (E2E-14, E2E-15).
- Ceiling refusal shows the same numbers that the gate would change: `BUDGET_EXCEEDED: projected $2.41 > per-unit envelope $2.00. Dispatch refused before any token was spent. Raise it: factory budget raise --to <n> --reason "<why>"` (exit 6).

### 3.7 Flow 7 — Sign the **first** promotion (human gate 1)

```
$ factory promote U-7f3a9c
```

```
GATE  initial-production-deploy                 (human-only; always, first time)

  unit      U-7f3a9c  "slug check"   lane dark
  verdict   V-4c8e  passed  Δ 0.00  wall-2026.11.1  holdout h-88f1
  receipt   R-3d21  faithful
  artifact  ~/.factory/artifacts/U-7f3a9c/promotion.yaml           (not written yet)
  payload   ~/.factory/artifacts/U-7f3a9c/change.patch  +38/−4 in 2 files
  signing   ~/.factory/keys/operator.ed25519 (present)

  This is the FIRST promotion of U-7f3a9c in this repo. It can never run dark.
  Nothing is pushed and nothing is deployed: v1 emits a patch + a signed
  promotion record. Applying it is your action, outside this tool.

  Sign by typing exactly:
      sign promotion U-7f3a9c
  > sign promotion U-7f3a9c

PROMOTION P-9b02 signed · sha256:c40a9e… · wrote ~/.factory/artifacts/U-7f3a9c/promotion.yaml
  apply:   git apply ~/.factory/artifacts/U-7f3a9c/change.patch
  inspect: factory audit U-7f3a9c
```

- The gate fires on **`verdict.passed && human_signature`**; the CLI cannot produce the signature field. `factory promote` without a signature is exit 5 `PROMOTION_UNSIGNED` **and writes no `promotion.yaml` at all** (not even a draft) — a half-written artifact is how "unsigned" becomes "signed by accident".
- `--verdict <id>` is available for pinning, but a stale verdict (`VERDICT_STALE`) refuses: the wall's `holdoutRevision` or `policyVersion` changed after the verdict was produced. Message names both revisions and the exact re-verify command.
- Subsequent promotions of the _same_ unit are not gated (the first promotion is the gate). The CLI says so on every promotion: `gate: first-promotion-only (this unit was first signed 2026-11-01 by you)`.

### 3.8 Flow 8 — Audit a shipped unit

Two different audits, deliberately separate verbs/flags:

```
$ factory audit U-7f3a9c                 # traceability: every decision, one screen
```

```
TRACE  U-7f3a9c   (event → receipt → verdict → policy)
  2026-11-01T14:01:52Z  unit_submitted      spec sha256:9c1f0a7e…  restate sha256:4d2e77b3…
  2026-11-01T14:01:53Z  mandate_created     M-2b1e  policy q-2026.11.1  lane pending
  2026-11-01T14:01:55Z  lane_decided        dark  6 signals  reasons[…]
  2026-11-01T14:02:11Z  attempt_dispatched  A-01  container sha256:4e1c…  base a1b2c3d
  2026-11-01T14:09:03Z  receipt_recorded    R-3d21  sha256:7b02e1…  3 commands
  2026-11-01T14:11:40Z  verdict_recorded    V-4c8e  passed Δ 0.00  wall-2026.11.1 h-88f1
  2026-11-01T14:12:02Z  gate_decision       G-…     budget reservation settled $0.62 (estimated)
  2026-11-01T14:14:30Z  promotion_signed    P-9b02  operator ed25519:ab02…  sha256:c40a9e…
  ledger head 9f21c0…  ·  every row above is append-only
```

```
$ factory audit --escape-rate --since 2026-10-01 --sample 5
```

```
ESCAPE RATE AUDIT  sample 5 of 23 shipped units since 2026-10-01 (fixed rate 20%)
  U-7f3a9c  re-scored by wall: passed (9/9 holdout)   human re-validation: PENDING
  U-b221    re-scored by wall: passed (7/9 → 2 failures, under threshold)  PENDING
  ...
  ESCAPE RATE  0 / 3 re-validated so far  ·  2 awaiting your review
  This is the "we are wrong about how wrong we are" metric. It is not optional.
```

- Escape-rate audit exists because a wall validated once is a wall that silently rots (T2/T6, criteria drift). The UX makes it a _standing_ item on the status page, not a report the operator has to remember. Exit 0 when the sample is complete, 5 when human re-validation is outstanding (the operator is being asked for something).

### 3.9 Flow 9 — Recover after a crash

```
$ factory recover
```

```
RECONCILE  store ok (integrity_check passed, schema v4, ledger head 9f21c0…)
  2 attempts found without a terminal event, 0 redispatched
  A-01  U-7f3a9c  dispatched → AMBIGUOUS   container gone, git HEAD unchanged
        observe: factory status U-7f3a9c --attempt A-01
  A-02  U-b221    running    → running     container alive (pid 41902), supervision resumed
  outbox  3 pending · 1 retrying (verify U-b221, backoff 8s) · 0 dead
  wall    unavailable since 14:07:40Z (docker daemon unreachable) → verdicts will be unknown
RESULT nothing was dispatched, nothing was retried. Safe to re-run: factory recover is idempotent.
```

- Exit 0 when reconciliation completed (even with ambiguous attempts — that is a _fact_, not an error). Exit 8 if the store is quarantined (§5.4).
- Run at startup automatically; the manual verb exists because the operator must be able to _see_ what startup did, and because a runbook that says "it happens automatically" is unverifiable.

### 3.10 Flow 10 — Issue a privileged credential (human gate 3)

```
$ factory credential request --class privileged --repo fixture --ttl 15m --reason "promotion apply in fixture"
```

```
GATE  privileged-credential-issuance              (human-only)

  class    privileged   scope repo:fixture   ttl 15m   single-repo, task-scoped
  holder   the credential proxy only — the worker container gets an opaque
           proxy token; it never sees this value, and neither will this terminal
  revoke   automatic at ttl, or: factory credential revoke <id>

  Sign by typing exactly:
      issue privileged credential for fixture
  > issue privileged credential for fixture

IssuedToken T-7e01 · expires 2026-11-01T14:39:02Z · value not printed (by design)
```

- The secret value is never echoed, never logged, never in `--json`. The gate's _output_ is a token id and an expiry.
- Unscoped requests are refused structurally: `request must name --repo and --ttl ≤ 60m; unscoped privileged credentials do not exist in this system`, exit 3.

### 3.11 Flow 11 — Abort

```
$ factory abort U-7f3a9c --reason "wrong approach, intent changed"
```

```
ABORTED  U-7f3a9c  terminal   (was: verifying)   attempt A-01 stays ambiguous, untouched
  reason recorded in ledger, attributed to operator ed25519:ab02…
  nothing rolled back — the worktree at ~/.factory/work/U-7f3a9c/ is left in place for inspection
```

Idempotent by contract: a second abort exits 3 with `UNIT_ALREADY_TERMINAL`. `--reason` is required (an abort with no reason is an unauditable decision).

---

## 4. Interaction patterns

### 4.1 Silence by default

| Situation                               | CLI output                                          | Exit  |
| --------------------------------------- | --------------------------------------------------- | ----- |
| Nothing needs a person, nothing running | `factory status` prints exactly one line            | 0     |
| Units running, nothing needs a person   | one line per state transition, nothing between      | 0     |
| Something needs a person                | the item, the one question, the recommended command | 5     |
| Something is unknown                    | the KNOWN/UNKNOWN/NOT DONE block                    | 4     |
| Something failed                        | what failed, what state it left, the next command   | 3 / 8 |

The one-line healthy status is a hard requirement, not a nicety:

```
$ factory status
2 in flight · 0 need you · wall ok · store ok · today $6.41/$20.00 estimated
```

Everything after that first line appears **only** when it needs the operator. There is no `--verbose` that turns this into a dashboard by default; `--all` exists and is explicit.

An empty factory is louder than a silent one only because it must teach once:

```
$ factory status
no units. Start: factory intent --file <unit.yaml> --restate <restate.md>
```

### 4.2 Every question is one concrete question with a recommended answer

| Property       | Rule                                                                                                                |
| -------------- | ------------------------------------------------------------------------------------------------------------------- |
| Cardinality    | One question per gate invocation. Never two questions in one prompt.                                                |
| Form           | A question the operator can answer by reading one line — the question states _what will change_ and _what will not_ |
| Recommendation | Every question carries exactly one recommended command, printed as a copy-pasteable line, never as prose advice     |
| Default        | There is **no default**. Enter alone does not proceed on any gate. The `status` page never has a "do it" button.    |
| Deferral       | Every gate can be left unanswered indefinitely; the unit waits. Nothing expires into a decision.                    |

### 4.3 The asymmetry rule (opaque to the agent, complete to the human)

**Rule.** The _agent_ receives one line with no information it can optimize against; the _human_ receives the complete causal chain. Same event, two renderings, never the same text.

|                  | Generator (worker) sees                                 | Operator (human) sees                                                                                                             |
| ---------------- | ------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------- |
| Holdout failure  | `h-3 failed: 2 of 3 runs returned an unexpected status` | `scenario h-3 "slug uniqueness under concurrent insert" failed 2/3; expected 409, got 200, then 201; holdout rev h-88f1`          |
| Receipt mismatch | `receipt_unfaithful`                                    | `claimed exit 0 for "node --test tests/"; re-execution exited 1 (3 failing) in a clean checkout; commands[1] differs at byte 118` |
| Budget refusal   | `budget_ceiling`                                        | `projected $2.41 > envelope $2.00 (price table p3, estimated); reservation ledger row 8812`                                       |
| Lane refusal     | `lane_lit`                                              | the full reason-code block of §3.2                                                                                                |

**Why this asymmetry is not a dark pattern, and must be documented as such.** It looks like information withholding — the classic shape of a manipulative interface — so the justification has to be explicit and testable:

1. **The information asymmetry is the control, not the UX.** The wall's blindness is what makes it a wall (R2). If the generator could read the scenario, it would optimize against the holdout and Δ would collapse to zero — exactly the attractor documented in T2 (28 pp per 10× code size). Withholding is _why the mechanism works_, not a way to make the mechanism feel better.
2. **The withheld party is not a person.** No human is denied anything they need to make a decision; the human gets strictly more than the agent. An interface is manipulative when it disadvantages a _person_ who is trying to act in their own interest. Here the asymmetry is between a person and an untrusted program.
3. **It is disclosed.** Both this document and `factory audit --help` state the rule and its purpose, and the opaque line is _labelled_ opaque in the human's view (`returned to the worker: "<one line>"`) so the operator can see what the agent was told and audit for unintended leakage.
4. **It is tested.** Leak tests (E2E-24, E2E-29) assert that the holdout store, its scenario text and the Bifrost/signing keys are unreachable from the worktree, the container, the environment and the prompt. The rule is enforced structurally, not by wording discipline.

The failure mode this rule protects against — a "helpful" error message that leaks the scenario — is a **security regression that looks like a UX improvement**, so it is called out in the review checklist in §9.

### 4.4 Confirmation before any irreversible operator action

Exactly four operator actions are irreversible, and all four use the same mechanism (typed phrase, no `-y`, no default, no timeout):

| Action                        | Irreversible because                                  | Confirmation phrase                                                                                 |
| ----------------------------- | ----------------------------------------------------- | --------------------------------------------------------------------------------------------------- |
| Abort a unit                  | terminal state, cannot be reopened (only resubmitted) | `--reason` required; no phrase (recoverable by resubmitting, so this is reason-capture, not a gate) |
| Raise a budget envelope       | authorizes spend for all future units                 | `raise per-unit envelope to <n>` / `raise daily envelope to <n>`                                    |
| Sign a promotion              | authorizes the change to be applied                   | `sign promotion <unitId>`                                                                           |
| Issue a privileged credential | grants write capability                               | `issue privileged credential for <repo>`                                                            |
| Retry an ambiguous attempt    | creates a second side-effect-capable attempt          | `--retry --reason <text>` (two-part, no phrase)                                                     |

Note the ranking: only the **three human gates** are true gates (in the `phased-plan.md` sense — they cannot be automated, bypassed or defaulted). Abort/retry are _reasoned confirmations_ because they are recoverable and must remain fast for the operator.

### 4.5 Feedback: every action answers within 100 ms

| Action         | Immediate feedback (≤100 ms)                       | Completion signal                         |
| -------------- | -------------------------------------------------- | ----------------------------------------- |
| `intent`       | ids + criteria table                               | exit 0; unit in ledger                    |
| `qualify`      | stored-or-new decision line                        | lane + reasons block                      |
| `run`          | `dispatched A-01 …` before the first model token   | `verdict V-… ` / `AMBIGUOUS` / `killed …` |
| `promote`      | the gate block                                     | `PROMOTION … signed` + file path          |
| `budget raise` | current→proposed diff                              | `GateDecision … recorded`                 |
| `status`       | the one line (control-plane read < 50 ms p95, NFR) | n/a                                       |
| `recover`      | `RECONCILE …` header                               | per-attempt lines + RESULT                |

No command may print nothing and exit 0. An operator who types a command and sees silence must be able to conclude _"nothing needed doing"_ from a **printed sentence**, not from an absence of output.

---

## 5. Error handling strategy

### 5.1 Exit codes (normative — used identically by the CLI, the status page and `e2e-tests.md`)

| Code | Class                  | Meaning for the operator                                                                                                                                                                                                   | Do next                                                   |
| ---- | ---------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------- |
| `0`  | success                | the requested result was written; for `run`, the attempt reached a terminal state                                                                                                                                          | read the last line                                        |
| `1`  | internal               | unexpected error; the factory is in an unknown-to-it state                                                                                                                                                                 | `factory recover`, then report with the printed `traceId` |
| `2`  | usage                  | bad flag/verb/missing argument (`commander`'s own code)                                                                                                                                                                    | `factory <verb> --help`                                   |
| `3`  | policy refusal         | a _known_, correct refusal you can fix by editing or resubmitting (`SPEC_INVALID`, `DUPLICATE_UNIT`, `LANE_NOT_DARK`, `UNIT_NOT_FOUND`, `ATTEMPT_NOT_FOUND`, `MANDATE_EXPIRED`, `UNIT_ALREADY_TERMINAL`, verdict `failed`) | the printed next command                                  |
| `4`  | unknown / ambiguous    | a measurement is missing or an outcome is undetermined. **Never implies success, never implies failure** (`ATTEMPT_AMBIGUOUS`, `WALL_UNAVAILABLE`→`unknown`)                                                               | observe; decide; never auto-retry                         |
| `5`  | human gate             | a gate is closed and only you can open it (`GATE_REQUIRED`, `PROMOTION_UNSIGNED`, `VERDICT_MISSING`, `VERDICT_STALE`, verdict `unknown`)                                                                                   | answer the one question                                   |
| `6`  | budget                 | a spend ceiling refused the operation (`BUDGET_EXCEEDED`)                                                                                                                                                                  | answer the budget gate                                    |
| `7`  | concurrency / conflict | a lease or a content hash collided (`LEASE_HELD`, `RECEIPT_CONFLICT`)                                                                                                                                                      | wait, or investigate the conflict                         |
| `8`  | environment            | the machinery is unavailable (`EXECUTOR_UNAVAILABLE`, `DSH_VERSION_MISMATCH`)                                                                                                                                              | follow the printed runbook line                           |
| `9`  | integrity              | the store is quarantined (`STORE_QUARANTINED`)                                                                                                                                                                             | stop; read §5.4                                           |

Rules: codes are stable and documented; a code never means two different next-actions; `1` is never used as a catch-all for one of the classes above. Scripts may switch on the code alone — that is the contract.

### 5.2 Full error-code table (from `architecture.md` §4, plus the two gate codes and two integrity codes it names elsewhere)

Every message uses the same five parts, in this order, because that is what makes it diagnosable: **code · what happened · why · what state you are in now · the next command.**

| Code                    | Verb(s)                                  | Exit | Human message (shape, verbatim prefix)                                                                                                                    | State after                              |
| ----------------------- | ---------------------------------------- | ---- | --------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------- |
| `SPEC_INVALID`          | `intent`                                 | 3    | `SPEC_INVALID: <file>:<line>:<col> <json-path>: <expected>; got <actual>` + one-line why                                                                  | nothing created                          |
| `DUPLICATE_UNIT`        | `intent`                                 | 3    | `DUPLICATE_UNIT: spec hash matches U-… but intent hash differs; this is a new unit colliding with an old key` + `bump spec.revision`                      | nothing created                          |
| `UNIT_NOT_FOUND`        | qualify/run/promote/abort/status/audit   | 3    | `UNIT_NOT_FOUND: no unit <id>` + `factory status --all`                                                                                                   | unchanged                                |
| `MANDATE_EXPIRED`       | `qualify`, `run`                         | 3    | `MANDATE_EXPIRED: M-… expired 2026-10-30 (policy q-2026.11.1 superseded); re-submit under the current policy`                                             | unit stopped, not resumed (IN 8)         |
| `LANE_NOT_DARK`         | `run`                                    | 3    | `LANE_NOT_DARK: <id> is lane=lit. The factory does not dispatch lit units.` + `factory qualify <id>`                                                      | unchanged                                |
| `LEASE_HELD`            | `run`                                    | 7    | `LEASE_HELD: attempt A-… holds the unit lease (holder pid 41902, expires 14:39Z)` + `factory recover`                                                     | unchanged                                |
| `BUDGET_EXCEEDED`       | `run`                                    | 6    | `BUDGET_EXCEEDED: projected $2.41 > per-unit envelope $2.00 (estimated, price table p3). Dispatch refused before any token was spent.` + raise command    | reservation not made, nothing dispatched |
| `GATE_REQUIRED`         | `run`, `promote`, `budget`, `credential` | 5    | `GATE_REQUIRED: <gate-name>` + the gate block of §3.6/3.7/3.10                                                                                            | gate request recorded, waiting           |
| `ATTEMPT_NOT_FOUND`     | `observe`, `status`                      | 3    | `ATTEMPT_NOT_FOUND: no attempt <id> on <unitId>` + list of attempts                                                                                       | unchanged                                |
| `ATTEMPT_AMBIGUOUS`     | `recordReceipt` (adapter)                | 4    | `ATTEMPT_AMBIGUOUS: A-01 was reconciled as ambiguous at 14:12Z; a receipt cannot bind it`                                                                 | attempt stays ambiguous                  |
| `RECEIPT_CONFLICT`      | `recordReceipt`                          | 7    | `RECEIPT_CONFLICT: A-01 already has receipt R-… (sha256:a…); incoming sha256:b… differs. Receipts are never overwritten.`                                 | first receipt kept                       |
| `WALL_UNAVAILABLE`      | `verifyUnit`                             | 4    | `WALL_UNAVAILABLE: <detail>`. Verdict recorded as **`unknown`**, which cannot promote.                                                                    | verdict `unknown`                        |
| `VERDICT_MISSING`       | `promote`                                | 5    | `VERDICT_MISSING: U-… has no verdict. Run: factory run U-…`                                                                                               | gate closed                              |
| `VERDICT_STALE`         | `promote`                                | 5    | `VERDICT_STALE: verdict V-… was produced under holdout h-88f1; store is now h-90c2 (and/or policy q-2026.12.1). Re-verify: factory run U-… --verify-only` | gate closed                              |
| `PROMOTION_UNSIGNED`    | `promote`                                | 5    | `PROMOTION_UNSIGNED: promotion requires a human signature; none was provided and none can be synthesized`                                                 | **no artifact written**                  |
| `UNIT_ALREADY_TERMINAL` | `abort`                                  | 3    | `UNIT_ALREADY_TERMINAL: U-… is <state> since <ts>`                                                                                                        | unchanged                                |
| `STORE_QUARANTINED`     | all                                      | 9    | see §5.4                                                                                                                                                  | read-only, all writes refused            |
| `DSH_VERSION_MISMATCH`  | startup, `run`                           | 8    | `DSH_VERSION_MISMATCH: factory pins dsh 0.2.1-rc.3; found <version> at <path>. Refusing to start — a warning here would be a lie about reproducibility.`  | nothing dispatched                       |
| `EXECUTOR_UNAVAILABLE`  | `run`                                    | 8    | `EXECUTOR_UNAVAILABLE: docker daemon unreachable / image factory-env@sha256:… absent` + runbook line                                                      | nothing dispatched, no reservation       |
| `INTENT_NOT_DERIVABLE`  | `qualify` (reason, not error)            | 3    | part of the `reject` block (§3.2)                                                                                                                         | lane `reject`                            |

`intent`, `qualify`, `run`, `promote`, `abort`, `recover`, `status`, `receipts`, `audit`, `budget`, `credential` all share this vocabulary. A code that appears in the ledger is the _same string_ as the code on screen and in `--json`.

### 5.3 UX of `reject` vs `failed` vs `unknown` — three different sentences

The most consequential wording decision in the product. These three states all "did not pass", and collapsing them is how `unknown` becomes `pass`.

| Verdict state   | The truth                                      | Wording                                                         | Colour/pill    | Exit | Affordance offered                                                     |
| --------------- | ---------------------------------------------- | --------------------------------------------------------------- | -------------- | ---- | ---------------------------------------------------------------------- |
| `failed`        | we measured it; it did not pass                | `FAILED — the wall ran and the change did not pass`             | `[×] FAILED`   | 3    | "fix and resubmit a new revision"                                      |
| `reject` (lane) | we refuse to run it; the spec is not derivable | `REJECTED before dispatch — the spec is not machine-derivable`  | `[—] REJECTED` | 3    | "rewrite the spec"                                                     |
| `unknown`       | we do not know; a measurement is missing       | `UNKNOWN — not measured. This is not a pass and not a failure.` | `[?] UNKNOWN`  | 4    | "restore the missing dependency, then re-verify" — **never** "proceed" |

### 5.4 UX of `STORE_QUARANTINED`

The store quarantines itself when the ledger's integrity check fails or a tamper signal fires (`findings.md` invariant 3: _never reset a quarantined store, never delete active markers, never unfence_).

```
$ factory status
STORE_QUARANTINED — the factory is read-only.
  reason   ledger chain break at event 8812 (expected prev_hash sha256:5c…, found sha256:71…)
  since    2026-11-01T14:31:02Z (detected at startup)
  refused  every write: intent, qualify, run, promote, abort, budget, credential
  allowed  read-only: status, receipts, audit, and the status page

  DO NOT reset, delete, re-initialize or "repair" this store. A reset destroys the
  only evidence of what happened, and a coordinated rollback of the ledger and its
  anchor is explicitly undetectable afterwards.

  Read instead:
    ~/.factory/state/factory.db            (leave in place; copy it, do not modify)
    factory audit --last 50                (read-only, works while quarantined)
  Runbook: docs/runbooks/store-quarantine.md
```

Exit 9. There is deliberately **no `--force`, no `--reset`, no `--unfence`** in the CLI, and the absence is asserted by E2E-26: unknown flags are a usage error (exit 2), not an escape hatch.

### 5.5 UX of `WALL_UNAVAILABLE` and of `unknown` generally

```
$ factory status U-7f3a9c
UNIT U-7f3a9c  lane dark  state verified-with-unknown
  verdict V-4c8e  UNKNOWN — the wall was unavailable (docker daemon unreachable)
                  from 14:07:40Z to 14:19:02Z during verification
  receipt R-3d21  faithful ✓ (re-execution ran before the outage)
  Δ               unknown — holdout did not run
  promotion       BLOCKED. An unknown verdict cannot promote; there is no override.
  restore:  start the docker daemon, then: factory run U-7f3a9c --verify-only
```

- The word `unknown` is always lowercase-monospace in the reason text, always paired with the pill `[?] UNKNOWN`, and always accompanied by **what was not measured**. "Unknown" without a subject is a shrug; "Δ unknown — holdout did not run" is a diagnosis.
- `--verify-only` re-runs verification against the _existing_ receipt without a new attempt. It is the only verb that converts `unknown` into a measurement, and it cannot dispatch work (§6, "no implicit steps").

---

## 6. Accessibility

### 6.1 Terminal output rules (normative)

| Rule                                 | Implementation                                                                                                                                                                                             | Test                                                   |
| ------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------ |
| No meaning in colour alone           | Every state is a word: `PASSED`/`FAILED`/`UNKNOWN`/`AMBIGUOUS`/`RUNNING`/`NEEDS YOU`, uppercase, in the same column, before any colour                                                                     | E2E-24, E2E-36                                         |
| `NO_COLOR`                           | Present-and-non-empty ⇒ no ANSI **colour**; per no-color.org this does _not_ cover bold/underline/italic, so it is only the first of two switches                                                          | E2E-24                                                 |
| `--plain`                            | Our own stronger mode: **zero** ANSI bytes of any kind (no colour, no bold, no cursor control), no box-drawing characters, no glyphs, no spinners. `factory --plain status \| xxd` must contain no `0x1b`. | E2E-24                                                 |
| `TERM=dumb`                          | Implies `--plain`                                                                                                                                                                                          | E2E-24                                                 |
| No cursor-addressing animation       | No spinners, no redraw-in-place, no `\r` progress. Progress is _appended lines_ only                                                                                                                       | review + E2E-30 (kill -9 test asserts no partial line) |
| Screen-reader-safe tables            | Max 4 columns; no vertical box-drawing; one logical record per block; column headers repeat on every row when output is grep-parseable (`--table=rows`)                                                    | E2E-11                                                 |
| Blank line between records           | Every multi-line record separated by one blank line, so a screen reader pauses                                                                                                                             | review                                                 |
| Plain-text fallback for every status | `factory status --plain` renders the same _content_ as the page and the same content as `--json`; the three are tested for identical state strings                                                         | E2E-11, E2E-34                                         |
| 80 columns                           | Every line ≤ 80 chars at default settings (Heroku CLI guide); long paths are wrapped with a continuation indent, never truncated                                                                           | snapshot test in `e2e/cli/default/format.test.ts`      |
| Exit code is the a11y backstop       | A screen-reader user who hears nothing useful still gets the class of outcome from `$?`                                                                                                                    | every test                                             |

### 6.2 Keyboard-only operation

The CLI is keyboard-only by construction. The status page (see `ui-plan.md`) contains **zero interactive controls** — it is read-only by scope, and its "next command" strings are selectable text, not buttons. Consequences: no keyboard trap is possible, no focus order needs designing, and the page must be fully readable with JS disabled and with CSS disabled.

### 6.3 Status-page WCAG AA (detailed in `ui-plan.md`; the commitments here)

- Body text ≥ 4.5:1, large text ≥ 3:1, **measured and stated** for every token pair in `ui-plan.md` §3.3 (all implemented pairs land ≥ 6.6:1).
- State is icon + word + colour (three channels); the word alone is sufficient (the "text-only" test).
- `prefers-color-scheme` for light/dark; `prefers-reduced-motion` honoured (there is no motion to reduce — the page never polls faster than 10 s and never animates).
- 200% text zoom: single column, no fixed widths, no horizontal scroll.
- Landmarks (`<header>/<main>/<section aria-labelledby>`), one `<h1>`, real `<table>` semantics, `<time datetime>` for timestamps.

---

## 7. Dark-pattern audit (of our own design)

Audited against the 14-category taxonomy in `research/ux-design.md` ("Dark Pattern Classification"), plus the three factory-specific inversions that matter more than any generic category: **does the UI wording subvert "unknown is not pass"? does a green status hide an estimated-not-measured budget? does the CLI nudge the operator to skip a gate?**

### 7.1 Taxonomy sweep

| #   | Pattern                           | Present?                       | Evidence / disposition                                                                                                                                                                                                                                                  |
| --- | --------------------------------- | ------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | Trick questions                   | **No**                         | Gates ask one question with one exact answer; the typed phrase is the answer, not a double negative. `abort --reason` requires prose, never a yes/no inversion.                                                                                                         |
| 2   | Sneaking into carts               | **No**                         | No telemetry, no opt-ins, no remote calls from the CLI. `factory intent` creates exactly what the spec says; no implicit qualify, no implicit run (§8 "avoid implicit steps").                                                                                          |
| 3   | Roach motel                       | **No**                         | Every state has an exit: `abort` from any non-terminal state; every gate can be deferred forever; `lit` units can be taken out of band. No "contact your administrator".                                                                                                |
| 4   | Privacy zuckering                 | **N/A**                        | Single operator, local-only, no data collection. DSH session logs stay in the operator's own `DSH_HOME`.                                                                                                                                                                |
| 5   | Price comparison prevention       | **Mitigated, with a residual** | Budget is shown as _limit, spend, reserved, and `kind`_ on every surface, all flaggable `estimated`. Residual: we cannot compare against a bill we cannot read (D4: DSH has no cost accounting) — disclosed in the budget block instead of hidden. See finding **A-2**. |
| 6   | Misdirection via visual hierarchy | **No**                         | The gate block leads with _what changes_ and _what does not_; the confirmation phrase is on its own line, never styled as an afterthought. No red "continue" buttons anywhere.                                                                                          |
| 7   | Hidden costs                      | **No**                         | Token ceilings, wall-clock ceilings and envelopes are printed _before_ dispatch (`factory status` + the `run` header line). The default per-unit envelope ($2) is stated in `--help`.                                                                                   |
| 8   | Bait and switch                   | **No**                         | `--help` describes v1's actual limits, including what the factory does not do (no push, no deploy, no ACP): a `LIMITS` section in every `--help`.                                                                                                                       |
| 9   | Confirmshaming                    | **No**                         | Gate copy is neutral: "gate not signed; envelope unchanged" — no guilt, no "recommended for you", no "are you sure you want to be less safe?".                                                                                                                          |
| 10  | Disguised ads / upsells           | **N/A**                        | Nothing to sell.                                                                                                                                                                                                                                                        |
| 11  | Friend spam                       | **N/A**                        | No network identity, no contacts.                                                                                                                                                                                                                                       |
| 12  | Forced continuity                 | **No**                         | Envelope raises never expire into a new default; a raised envelope is visible on every `status` until lowered, and lowering is a normal command (not a gate — reducing spend is safe).                                                                                  |
| 13  | Scaremongering                    | **No**                         | The one alarming block (`STORE_QUARANTINED`) is a real condition with a real runbook, not a nudge. `unknown` produces a _quiet_ block, not a red alert — over-alarming `unknown` is what trains operators to click through it.                                          |
| 14  | Bad defaults                      | **No**                         | Defaults are the safe ones: nothing dispatches without `run`; no gate has a default answer; `lit` is the fallback lane when a signal is missing; `unknown` blocks promotion; retries are zero; `--plain` is implied by `TERM=dumb`.                                     |

### 7.2 Factory-specific inversions

#### Finding **A-1** (highest risk) — "unknown is not pass" is subverted by _quiet_ rendering, not by wording

- **The inversion:** we never _say_ "pass" for unknown — but a status line that reads `2 in flight · 0 need you · wall ok` while a verdict is `unknown` has already communicated "fine". The failure is **aggregation**: any summary line that counts `unknown` as "not needing a person" is a lie by omission. Same for the status page's health strip turning green while one unit's Δ could not be measured.
- **Why it is high risk:** it is invisible in review because no individual string is wrong, and it converts L3 into a decorative claim. It also compounds: an operator who sees one false-green learns to distrust _all_ green, which destroys the silence rule (§4.1) for good.
- **Fix (normative):**
  1. `unknown` **counts as needing a person**. The healthy one-liner becomes `2 in flight · 1 need you · 1 unknown · wall unavailable · …` and exit code 5 (not 0).
  2. Aggregates never say `0 need you` when `unknownCount > 0`; the phrase is `0 need you · 1 unknown (not a pass)`.
  3. The health strip is **three-state**: `ok` / `degraded` / `unavailable` — never a boolean. Any `unavailable` or `degraded` forces the strip out of "all green" and prints the affected capability by name.
  4. A unit whose Δ is `unknown` shows `Δ unknown` in the Δ column of the per-class table, with `state: "unstable"`; the class can never be certified `dark` while it holds (this is also the qualifier's rule, so the UI matches the engine).
- **Test:** E2E-25 (unknown never promotes), E2E-34 (page shows UNKNOWN + not-green), E2E-33 (summary line counts unknown as needing a person).

#### Finding **A-2** (high risk) — a green budget hides an _estimated_-not-measured number

- **The inversion:** `today $6.41/$20.00` renders identically whether $6.41 is measured or estimated. In this factory it is **always estimated** (D4: `token-meter` is not billing-grade; the prior repo proved a route reporting $0.0347 against a $0.0147 reservation). A clean green meter therefore communicates a precision we do not have — the exact pattern the taxonomy calls _price comparison prevention_, arrived at non-maliciously.
- **Fix (normative):**
  1. The budget number **always** carries its provenance: `$6.41 estimated / $20.00` — the word `estimated` is part of the value, not a footnote, and it is `unknown` (never `0`) when telemetry is missing.
  2. The meter renders `estimated` as a **hatched / dashed fill with a textual `~` prefix** and the label `estimated`, and never as a solid fill — the same visual grammar as `measured` at every zoom level and in greyscale (no colour-only meaning).
  3. When `budget.unknownCount > 0`, the meter shows a **gap** plus `2 units unmeasured — spend understated` and the block is `degraded`, not ok.
  4. The word "spend" is never used without `estimated`; the word "charges" is never used at all (we do not have charges).
- **Test:** E2E-34 (estimated flag present in DOM + textual), plus a greyscale snapshot in the panel suite.

#### Finding **A-3** (high risk) — the CLI nudges the operator to skip a gate

- **The inversion:** help text and "next command" lines are the natural place for a nudge. Three real temptations found in our own draft copy:
  1. `factory run` printed `promote with --yes to skip the gate` → a `--yes` escape hatch on a gate is a gate that is skipped by design pressure.
  2. `factory budget` printed `most operators raise this once and forget it` → social-proof nudge on a spend authorization.
  3. Gate copy grouped the three gates under one prompt ("sign all pending gates?") → one confirmation answers three irreversible authorizations.
- **Fix (normative):**
  1. **No gate has a bypass flag.** Not `--yes`, not `--force`, not `--skip-gate`, not `-y`. Usage errors, tested (E2E-14, E2E-27).
  2. Gate copy contains **no urgency, no social proof, no recommendation to proceed**. It may contain _one_ recommended command line, always the same command that _would_ answer the gate, never a shortcut.
  3. **One gate per invocation, always.** `factory gates` lists pending gates; it cannot sign anything. Signing requires naming the gate's own verb.
  4. Recommendation asymmetry is explicit: the CLI _may_ recommend the safe action (e.g. `restore the docker daemon`), and may _not_ recommend the permissive action (e.g. `raise the envelope`). "You could raise the budget" is a nudge; "the budget refused this dispatch" is a fact.
- **Test:** E2E-14, E2E-17, E2E-27 + a `--help` snapshot test asserting the absence of the forbidden flags in every verb's help.

### 7.3 Residual risks we accept

| Risk                                                                   | Why accepted                                  | Mitigation on the surface                                                                                              |
| ---------------------------------------------------------------------- | --------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------- |
| The `KNOWN/UNKNOWN/NOT DONE` block becomes wallpaper after 50 readings | Any repeated block does                       | It appears only in the (rare) ambiguous case; its first line is always state-bearing                                   |
| `factory status` one-liner still gets skimmed                          | It is one line by design                      | A `1 unknown` token cannot be skimmed away because it changes the exit code and forces a second line                   |
| Escape-rate audit asks for human time and will be deferred             | It is the only defence against criteria drift | It appears as a standing `needs you` item at a fixed rate; deferral is allowed but never silent (it stays on the list) |

---

## 8. CLI usability standards (12-factor CLI + Heroku style guide)

| Standard                   | Rule adopted                                                                                                                                                                                                                                                                                                                                                                                                    | Where enforced                                        |
| -------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------- |
| **Framework**              | `commander` 15.0.0; small explicit surface; the help shape matches DSH's own                                                                                                                                                                                                                                                                                                                                    | `apps/cli`                                            |
| **Help**                   | `factory help`, `--help`, `-h` all work identically, on every verb and sub-verb; help ends with `EXAMPLES` (most-referenced section) and `LIMITS`                                                                                                                                                                                                                                                               | `e2e/cli/default/help.test.ts`                        |
| **Naming**                 | Flat `<verb> [<noun>]` where every verb is an `architecture.md` name (`intent`, `qualify`, `run`, `status`, `receipts`, `audit`, `promote`, `abort`, `recover`) plus two gate verbs (`budget`, `credential`). Verb-first rather than `[noun][verb]` **because these are the architecture's operation names** — inventing `factory unit submit` for `submitUnit` would break the one-name-per-concept rule of §2 | review                                                |
| **Flags over positionals** | Max one positional (`<unitId>`). Everything else is a flag. Anything needing three positionals is refused at design time                                                                                                                                                                                                                                                                                        | review                                                |
| **Streams**                | **stdout = data only** (one JSON object with `--json`, nothing otherwise unless the verb's payload _is_ data); **stderr = everything a human reads** (progress, prompts, errors, tables)                                                                                                                                                                                                                        | every e2e test asserts `stdout` is empty or pure JSON |
| **Errors**                 | code + one-line what + why + state + next command; never a stack trace; never a bare HTTP/DB error                                                                                                                                                                                                                                                                                                              | §5.2                                                  |
| **Exit codes**             | the 10 classes of §5.1, stable, scriptable                                                                                                                                                                                                                                                                                                                                                                      | every test                                            |
| **Idempotency**            | `intent` (same spec ⇒ same unit), `qualify` (same policy ⇒ stored decision), `run` (hash key ⇒ one attempt), `recover`, `abort`, `promote` (same verdict ⇒ same promotion), `status`/`audit`/`receipts` (read-only). Only `budget raise` and `credential request` create new decisions per invocation, and both print the existing decision if an identical one is already open                                 | E2E-03, E2E-21, E2E-23                                |
| **Prompts**                | Never mandatory; every interactive prompt has a documented flag equivalent (`--confirm "<phrase>"`, `--restate <file>`); no prompt ever defaults to "yes"                                                                                                                                                                                                                                                       | §4.4                                                  |
| **No implicit steps**      | `intent` does not qualify; `qualify` does not run; `run` does not promote; `promote` does not apply the patch or push; `recover` does not dispatch. Each is a separate, explicit command                                                                                                                                                                                                                        | flow list §3                                          |
| **Progress**               | stderr, appended lines, no animation, no ETA (§3.3)                                                                                                                                                                                                                                                                                                                                                             | §6.1                                                  |
| **80 columns**             | all human output ≤ 80 chars, wrapped with continuation indent                                                                                                                                                                                                                                                                                                                                                   | snapshot test                                         |
| **Grep-parseable tables**  | every tabular output has `--table=rows` (context repeated on each row, no box drawing) and `--json` (the real interface)                                                                                                                                                                                                                                                                                        | `e2e/cli/default/format.test.ts`                      |
| **Performance**            | startup ≤ 500 ms (NFR: control-plane commands < 50 ms p95 excluding I/O); no lazy model calls from the CLI                                                                                                                                                                                                                                                                                                      | NFR §8, benchmark in unit tests                       |
| **Config**                 | `~/.factory/config.yaml` holds **paths only, no secrets**; secrets are file refs and env (`FACTORY_DSH_BIN`, `FACTORY_HOME`); no config is written by any read-only verb                                                                                                                                                                                                                                        | `e2e/cli/default/config.test.ts`                      |
| **No native deps**         | pure JS/TS dependencies; `node:sqlite` built-in; no optional native addons in the CLI path                                                                                                                                                                                                                                                                                                                      | tech guide                                            |
| **`--json` contract**      | exactly one JSON object on stdout, `{"ok":true,…}` or `{"ok":false,"code":"…","message":"…","exitCode":n}`; identical field names to the ledger and `/api/status`                                                                                                                                                                                                                                               | E2E-11, E2E-23                                        |
| **Version reporting**      | `factory --version` prints factory version **and** the pinned `dsh` version it expects, because the pair is what reproducibility means                                                                                                                                                                                                                                                                          | E2E-27                                                |

### 8.1 The `--json` error envelope (one shape, three surfaces)

```json
{
  "ok": false,
  "code": "BUDGET_EXCEEDED",
  "message": "projected $2.41 > per-unit envelope $2.00 (estimated, price table p3)",
  "exitCode": 6,
  "unitId": "U-7f3a9c",
  "nextCommand": "factory budget raise --to 4.00 --reason \"<why>\"",
  "traceId": "t-3f81"
}
```

The same `code`, `message` and `nextCommand` strings appear in the human rendering and, where applicable, in `/api/status`. There is one error vocabulary; the surfaces differ only in decoration.

---

## 9. Verification

- [x] All flows documented with happy + error paths and exact commands, exit codes, output shapes (§3.1–3.11).
- [x] Exit-code table normative and shared across CLI, status page and e2e (§5.1).
- [x] Full error-code table from `architecture.md` §4 plus gate/integrity codes (§5.2); `unknown` never reads as success (§5.3, §5.5, A-1).
- [x] Accessibility requirements defined and testable: no color-only meaning, `NO_COLOR`, `--plain`, screen-reader-safe tables, plain-text fallback, keyboard-only, WCAG AA on the page (§6).
- [x] Every action has defined immediate + completion feedback (§4.5); no command exits 0 silently.
- [x] Dark-pattern audit passes 14/14 categories with three factory-specific findings and normative fixes (§7).
- [x] Human-in-the-loop: exactly three gates, each with a typed confirmation that no flag can bypass (§4.4, §3.6/3.7/3.10).
- [x] 12-factor CLI + Heroku standards mapped to concrete rules (§8).
- [ ] Review gate: copy reviewed against the §7.2 forbidden-nudge list by someone other than the author (Phase 11).
- [ ] Copy is final only after the Phase 5 debate; `unknown` semantics and the three-gate list are the load-bearing parts and are not negotiable.

### Story registry — flows → canonical story ids

[`user-stories.md`](user-stories.md) is canonical (47 stories, ids `US-E<epic>-<nn>`). The flows in this document are the operator-visible slices of those stories; this table is the single reconciliation point, and `e2e-tests.md` §8 maps the same stories to tests. Flows that cut across several stories list all of them.

| Flow (this document)                                | Canonical story ids                    | Primary surface    |
| --------------------------------------------------- | -------------------------------------- | ------------------ |
| §3.1 Submit (intent + criteria + restate-back)      | US-E1-01, US-E1-05                     | CLI `intent`       |
| §3.1 Confirm the restate-back before work starts    | US-E1-02                               | CLI `intent`       |
| §3.2 Why `lit` rather than `dark`                   | US-E1-03, US-E1-04                     | CLI `qualify`      |
| §3.3 Watch a dispatch                               | US-E2-01, US-E2-04, US-E4-01, US-E4-02 | CLI `run`          |
| §3.4 Handle `ambiguous` (observe, never retry)      | US-E5-03, US-E5-04                     | CLI `run`/`status` |
| §3.5 Read a verdict                                 | US-E3-01, US-E3-06, US-E3-07, US-E3-09 | CLI `audit`        |
| §3.6 Raise a budget envelope (gate 2)               | US-E4-08, US-E4-04                     | CLI `budget`       |
| §3.7 Sign the first promotion (gate 1)              | US-E4-07                               | CLI `promote`      |
| §3.8 Audit a shipped unit / escape-rate sample      | US-E6-01, US-E6-03                     | CLI `audit`        |
| §3.9 Recover after a crash                          | US-E5-03, US-E5-06                     | CLI `recover`      |
| §4.1 / status page: what needs a person             | US-E7-02, US-E7-03                     | status page        |
| §5.5 / status page: health and budget provenance    | US-E6-02, US-E3-04, US-E4-04           | status page        |
| §3.10 Issue a privileged credential (gate 3)        | US-E4-09                               | CLI `credential`   |
| §3.11 Abort                                         | US-E7-04                               | CLI `abort`        |
| §8 Scriptable CLI (`--json`, exit codes, `--plain`) | US-E7-01, US-E8-01                     | CLI                |
| §4.3 Asymmetry rule (structural containment)        | US-E3-08, US-E4-05, US-E8-03           | CLI + adapter      |

---

## Status

**Status:** draft complete (Phase 7). Copy review and debate-dependent wording pending.
**Started:** 2026-11-01
**Completed:** —
