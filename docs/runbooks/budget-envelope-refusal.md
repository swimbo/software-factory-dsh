# Runbook: the budget envelope refuses dispatch (`exit 6`)

**Severity:** medium — nothing was spent and nothing was dispatched; the work is blocked, not broken.
**Exit codes you will see:** `6` (`BUDGET_EXCEEDED`), sometimes `BUDGET_UNKNOWN` (also `6`).

## Symptom

`factory run` refuses before anything starts:

```
{"ok":false,"code":"BUDGET_EXCEEDED",
 "message":"U-78047a05ac91: estimates the run as $2.41 > remaining envelope $0.05 (the run cost is an estimate, not a measurement)",
 "exitCode":6,"traceId":"T-e36435f653"}
```

`factory budget` shows the ceilings it is refusing under:

```
BUDGET  · per-unit $0.05 estimated · today $0.00 of $20.00 estimated
  reserved $0.00 · 0 unit(s) recorded spend as unknown
  no billing-grade telemetry: every number here is an estimate, never a charge
```

The refusal is made **inside** the dispatch transaction, before the lease, the attempt, the
reservation and the launch effect are written — so a refused run leaves no attempt row, no
reservation and no executor start. That is why the remedy is a ceiling change, not a cleanup.

## What the factory will refuse to do

- **Dispatch anyway.** There is no override flag; `-y`/`--yes`/`--force`/`-f`/`--assume-yes` are
  usage errors (exit `2`). A ceiling is a gate, and gates are typed phrases, not confirmations.
- **Call the estimate a measurement.** The message says "estimates the run as $2.41" and names the
  comparison ("remaining envelope"); `factory budget` says "estimated" twice. v1 has no
  billing-grade telemetry, so every amount is an estimate (ND3).
- **Guess when spend is unknown.** If a unit recorded spend as `unknown`, the gate refuses rather
  than assuming zero (`BUDGET_UNKNOWN`, exit `6`). Unmeasured spend is not free spend.
- **Raise two ceilings at once.** The per-unit and per-day envelopes are separate gates; raising one
  does not raise the other (the verb's own LIMITS text says so).

## Commands

```bash
export PATH="$HOME/.nvm/versions/node/v$(cat .nvmrc)/bin:$PATH"

# 1. See where the ceiling is.
factory budget

# 2. Raise the per-unit ceiling. The typed phrase must name the amount exactly, or nothing happens.
factory budget raise --to 10.00 \
  --reason "E2E-26 refusal: estimate 2.41 exceeds a 0.05 ceiling set during triage" \
  --confirm "raise per-unit envelope to 10.00"

# 3. If the *day* is the binding ceiling, raise that one separately — with its OWN phrase.
factory budget raise --scope day --for 2026-11-01 --to 40.00 \
  --reason "two units' estimates exceed today's 20.00" \
  --confirm "raise daily envelope to 40.00"
```

The phrase is `raise per-unit envelope to <amount>` for the default scope and
`raise daily envelope to <amount>` for `--scope day`. Typing the wrong one is refused with exit `5`
and leaves the envelope unchanged:

```
GATE  budget-envelope-raise                    (human-only)
  daily envelope  $20.00  ->  $40.00   (values ESTIMATED)
  applies to      2026-11-01
  Sign by typing exactly:
      raise daily envelope to 40.00
GATE_REQUIRED: budget-envelope-raise. The phrase did not match; the envelope is unchanged ($20.00).
```

A successful raise is a ledger entry, and it prints the id:

```
GateDecision gd_fff096905c953630c02e96d0 recorded · daily envelope = $40.00
The ledger entry is append-only. An agent cannot write it.
```

Then re-run the unit: `factory run <unitId>`. Use `--signed-by <identity>` if the ledger should
attribute the raise to a person other than the default `operator`.

Lowering a ceiling needs `--reason` but is not a gate — it is still recorded forever, which is why
the triage above leaves a paper trail.

## What "fixed" looks like

- `factory budget` shows the new ceiling and the raise's `GateDecision` is in `factory audit --last 20`
  with your reason and identity.
- The refused unit runs (or fails for a _different_, non-budget reason — which is the signal that
  the ceiling is no longer what is blocking it).
- The refusal message in the store's event log stays as it was: the refusal happened, and the raise
  does not erase it.

## If it does not work

- **The raise is rejected with exit `5` (`GATE_REQUIRED`).** The typed phrase did not match, and the
  refusal prints the exact phrase to type. Note the scope: a `--scope day` raise wants "raise daily
  envelope to <amount>", not the per-unit wording. `--reason` is required for every change, up or
  down; a missing option or an unknown flag is exit `2`.
- **`BUDGET_UNKNOWN` instead of `BUDGET_EXCEEDED`.** Some unit recorded spend as unknown, so the gate
  cannot compute a remaining ceiling. Raising the ceiling is a legitimate answer; so is finding out
  why the spend was recorded as unknown. Do not edit spend rows to make the number look measured.
- **The run still refuses at `6` after a per-unit raise.** The daily envelope is binding — check the
  `today $X of $Y` line and raise `--scope day`. If the daily ceiling is already at policy maximum,
  escalate: that is ND3 territory (whether ceilings enforce or merely refuse is an open human
  decision).
- **You raised the ceiling and want the money back.** There is no "spend" verb and no refund path in
  v1; spend rows are append-only estimates. A ceiling is a permission, not a reservation.

**Known blemish.** The `--scope day` gate block prints the line "it does not raise the daily
envelope; that is a second, separate gate" — the same sentence the per-unit block prints. It is a
copy-paste in the renderer, not a statement about the raise you just asked for: the `daily envelope
$20.00 -> $40.00` line above it is the accurate one.

**Known gap.** Budget **refuses** dispatch; it does not **enforce** spend (nothing meters the
gateway). `phase-13-audit.md` GAP-003 records that `packages/proxy` — the component that would meter
and enforce — does not exist; ND3 records that the metering semantics are an open decision.
