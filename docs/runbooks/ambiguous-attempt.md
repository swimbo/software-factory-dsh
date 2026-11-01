# Runbook: a stuck `ambiguous` attempt

**Severity:** high — work may have landed outside the factory's knowledge, and the unit cannot move.
**Exit codes you will see:** `4` (unknown/ambiguous) from `factory recover`, `5` from
`factory status` while the gate is open.

## Symptom

`factory status` says one of your units needs a person:

```
0 in flight · 1 need you · 1 unknown (not a pass) · wall ok · store ok · today $0.00/$20.00 default estimated

UNIT U-ea3e3e8672da  lane dark  state ambiguous

NEEDS YOU
  G-6a2592d223a5  ambiguous_attempt
    U-ea3e3e8672da has an attempt that may or may not have taken effect; observe
    it, then decide
    → factory status U-ea3e3e8672da --attempt A-0001
```

`factory recover` (exit `4`) prints the block that names what is known and what is not:

```
RECONCILE  store ok (schema v1, 6 event(s) in the ledger)
  1 attempt(s) found without a terminal event, 0 redispatched
  A-0001  U-ea3e3e8672da  ambiguous  -> AMBIGUOUS
        observe: factory status U-ea3e3e8672da --attempt A-0001

AMBIGUOUS  U-ea3e3e8672da  attempt ambiguous
KNOWN             the attempt A-0001 started and did not report a terminal event
UNKNOWN           whether the final tool call for U-ea3e3e8672da took effect outside the worktree
NOT DONE          nothing was retried; no second attempt exists
  observe (read-only, safe, repeatable):
      factory status U-ea3e3e8672da --attempt ambiguous        <-- the id, not the state; see below
  then choose — the CLI will not choose for you:
      factory abort U-ea3e3e8672da --reason "<why>"
```

The hint line above prints the attempt's **state** where the attempt id belongs. The id is on the
`A-…` line at the top of the same block (`A-0001` here) and in `factory status --all`.

An attempt becomes `ambiguous` when the process died between the launch and the receipt: the lease
expired and `factory recover` reconciled it rather than guessing.

## What the factory will refuse to do

- **Re-dispatch it.** `recover` records only what it observed: "nothing was dispatched and nothing
  was retried. Recovery recorded only facts it observed." There is no automatic second attempt, and
  `factory run` does not resume an ambiguous unit (`run --retry` is documented as _unavailable in
  v1_).
- **Roll it back.** `factory abort` is terminal and explicitly does **not** undo anything: "nothing
  rolled back — the worktree … is left in place for inspection".
- **Guess the outcome.** No `unknown` becomes `passed` by passage of time; the gate stays open until
  a person acts (ADR-003).

## Commands, in this order

```bash
export PATH="$HOME/.nvm/versions/node/$(cat .nvmrc)/bin:$PATH"   # node 26.12.1

# 1. Re-read the facts (read-only, safe to repeat).
factory status U-ea3e3e8672da --attempt A-0001

# 2. If a receipt was recorded before the crash, the evidence exists; let the wall judge it.
factory receipts U-ea3e3e8672da
factory run U-ea3e3e8672da --verify-only

# 3. If there is no receipt, the attempt is unknowable. Close it, then start a new revision.
factory abort U-ea3e3e8672da --reason "attempt A-0001 was never observed; no receipt exists"
```

`factory abort` prints what it did and what it left alone:

```
ABORTED  U-ea3e3e8672da  terminal   (was: ambiguous)   attempt stays as found, untouched
  reason          recorded in the ledger, attributed to the operator: …
  nothing         rolled back - the worktree at …/work/U-ea3e3e8672da/ is left in place for inspection
```

To continue after an abort, submit a **new revision** — there is no revision flag on any verb; edit
`spec.revision` in the spec JSON and re-run `factory intent --file <spec>.json --restate <notes>.txt`.
A unit is not "reopened"; a new revision is a new unit.

## What "fixed" looks like

- `factory status` shows `0 need you · 0 unknown (not a pass)` and the unit in a terminal state
  (`verified`, `aborted`, `failed`).
- `factory recover` reports `0 attempt(s) found without a terminal event` and prints no `AMBIGUOUS`
  block.
- The ledger holds one `attempt.ambiguous` event and one operator-attributed decision (abort or
  verdict) — `factory audit U-ea3e3e8672da` shows both, in order.

## If it does not work

- **`run --verify-only` says there is no receipt.** Then the attempt is genuinely unknowable; go to
  `abort` (step 3). Do not re-run the unit to "see if it works" — a second launch of the same
  attempt is the double-launch the lease exists to prevent (ADR-005).
- **`recover` exits `8` with `STORE_QUARANTINED`.** Stop here: the ledger refused the write for
  integrity reasons. See [store-quarantine.md](store-quarantine.md).
- **`recover` exits `7` (`LEASE_HELD`).** Another process legitimately holds the unit's live lease;
  wait for it to expire or check whether a second `factory run` is still alive before touching
  anything.
- **The reconciliation hint line reads `--attempt ambiguous`.** That is a rendering bug: the block
  prints the attempt's _state_ where the id belongs. Use the id from the `A-…` line above it (and
  from `factory status --all`).

**Do not** delete rows, edit the SQLite ledger, or reset `FACTORY_HOME` to clear an ambiguous unit.
The ambiguity is the record; removing it makes the same hole invisible the next time.
