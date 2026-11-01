# Runbook: the store quarantined itself (`exit 9`)

**Severity:** critical — the factory is read-only and cannot be made writable by any command.
**Exit codes you will see:** `9` (`STORE_QUARANTINED`) from every writing command, `factory recover`
included; `0` from the read-only surfaces (`status`, `audit`, `receipts`).

## Symptom

Any write is refused with exit `9` and a runbook line that points at this file:

```
STORE_QUARANTINED: store is quarantined (<the reason recorded when it happened>): refusing raiseEnvelope.
Reads still work; inspect with a read-only handle and never write to a quarantined store
runbook: docs/runbooks/store-quarantine.md — do not reset, delete or re-initialise the store; copy it and read
```

The message names the operation it refused (`raiseEnvelope`, `insertUnit`, `appendEvent`, …) and the
reason the quarantine was set, which is usually the fastest clue you have.

`factory status` shows the store's health, not a stack trace:

```
… · wall ok · store quarantined · today $0.00/$20.00 default estimated
```

with `health.store.detail`: **"the ledger integrity check failed; every write is refused"**.

`factory recover`, whose whole job is to write, refuses too (exit `9`) and says what to do instead:

```
STORE_QUARANTINED: the factory is read-only. The store quarantined itself and recovery may not write.
Read instead: factory audit --last 50. Do not reset, delete or re-initialise the store.
  runbook: docs/runbooks/store-quarantine.md — do not reset, delete or re-initialise the store; copy it and read
```

**What it means.** A quarantine is a state in `store_state`, set by `store.quarantine(reason, actor,
traceId)`, that makes every mutating call refuse. It exists so that a detected divergence in the
ledger cannot be papered over by more writes.

## What the factory will refuse to do

- **Write anything.** No verb, no flag, no `--force`, no environment variable bypasses a quarantine.
  `-y`/`--yes`/`--force` are usage errors (exit `2`) everywhere.
- **Recover or reconcile.** `factory recover` exits `9` with `STORE_QUARANTINED`: recovery's only
  job is to write, so a quarantine stops it before it starts.
- **Clear the quarantine.** **Not built.** There is no `unquarantine`, `clearQuarantine`,
  `store.clearQuarantine()` or `--unquarantine` flag anywhere in this tree — grep for it, there is
  no such API, by design (a quarantine that a command can lift is not a control). The only
  sanctioned actions are read-only.

## What you _can_ do (all read-only)

```bash
export PATH="$HOME/.nvm/versions/node/$(cat .nvmrc)/bin:$PATH"

factory status              # health.store.state = quarantined, detail, unit count
factory status --all        # units and any open gates; still exit 0 unless a gate is open
factory audit --last 50     # the ledger tail: the `store.quarantined` event names the reason and actor
factory audit --escape-rate # wall Δ per task class, from what the store holds
factory receipts <unitId>   # the evidence for one unit, including the narrative (never the diff)
```

## Preserve, then start clean

The point of a quarantine is that the evidence stays intact. So:

```bash
# 1. Copy the whole state directory somewhere durable. Do not move it, do not edit it.
cp -R "$FACTORY_HOME/state" "$HOME/quarantine-$(date -u +%Y%m%dT%H%M%SZ)-state"

# 2. Read it with the factory (read-only) to write your account of what diverged.
factory audit --last 200 > divergence-account.txt

# 3. Bring up a fresh factory next to the quarantined one — a new FACTORY_HOME, never a reset
#    of the old one.
export FACTORY_HOME="$HOME/.factory-fresh"
factory status              # store ok (a new, empty ledger)
```

`FACTORY_HOME` is the CLI's home; the store lives at `$FACTORY_HOME/state` (override the location
with `FACTORY_STATE_DIR`), and keys at `$FACTORY_HOME/keys`. Units are then re-driven from their
specs, which are files: `factory intent --file <spec>.json --restate <notes>.txt`, then
`factory qualify`, then `factory run`. Nothing can be "resumed" from the quarantined ledger, and
that is deliberate.

## What "fixed" looks like

- `factory status` on the new home says `store ok`, and writes succeed (a `factory budget` raise or
  a `factory intent` returns exit `0`).
- The quarantined store is preserved byte-for-byte in the copy, and nothing in it was edited.
- You can state, in one sentence, which ledger fact diverged. If you cannot, the investigation is not
  finished — and the old ledger is the only place the answer exists.

## If it does not work

- **Nothing you try makes the old store writable.** Correct. It will not become writable; there is no
  code path that lifts a quarantine in v1.
- **You need the evidence to be authoritative.** It is: `factory receipts` and `factory audit` read
  the quarantined store without writing to it. Copy the directory first if you plan to run anything
  that might try to open it for writing.
- **You are tempted to delete `factory.db` or run the store's migration script.** Don't. That
  destroys the divergence record and the receipts it covers. Start a fresh `FACTORY_HOME` instead.
- **You want to know what would have detected this automatically.** **Not built:** nothing in v1
  calls `store.quarantine()` on its own — the `store.audit()` divergence check exists, and the
  quarantine path is tested, but no scheduled check wires detection to quarantine. That gap is
  recorded in [`phase-13-audit.md`](../planning/dark-factory-dsh/phase-13-audit.md) (Phase 9e /
  E2E-27) and in [`../handover.md`](../handover.md) under the known gaps. Until it is built, treat a
  quarantine as an operator or test action, not a self-protection you can rely on.

## Why this file is named exactly this

`apps/cli/src/exit.ts` and `apps/panel/src/render.ts` print the literal path
`docs/runbooks/store-quarantine.md` in their refusals. Renaming this file breaks the runbook hint
an operator sees at 2am, so the name is part of the contract.
