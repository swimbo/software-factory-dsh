# Runbook: a launch effect that stays retryable, then exhausts

**Severity:** medium — nothing has been double-launched, but work the operator asked for is not
running, and the outbox is the only record that it was ever asked for.
**Exit codes you will see:** `8` (`EXECUTOR_UNAVAILABLE`, `CONTAINER_UNAVAILABLE`,
`DSH_VERSION_MISMATCH` — retryable), `6`/`3`/`7` (a decision-class refusal — exhausted), `0` from
`recover` in both cases.

## Symptom

A pending launch effect does **not** change the one-line health strip (`wall ok · store ok`): the
outbox is its own subsystem. You see it in three places.

1. **`factory recover` reports a deferral** — this is the usual way an operator meets it:

   ```
   launch            deferred: effect E-6d14829a0a6f stays pending — lease LS-9c9487b02946 is live, so
                     something may already own this attempt. Recovery will retry after the lease expires.
   RECONCILE  store ok (schema v1, 6 event(s) in the ledger)
     0 attempt(s) found without a terminal event, 0 redispatched
     launch effects: 0 performed, 1 deferred (lease live or environment unusable), 0 refused (now exhausted)
   RESULT            nothing was dispatched, nothing was retried. Safe to re-run: factory recover is idempotent.
   ```

2. **`factory status --json`** carries the count in `health.outbox`:

   ```json
   {
     "state": "degraded",
     "pending": 1,
     "retrying": 0,
     "dead": null,
     "detail": "1 launch effect(s) pending for work not yet performed, 0 awaiting a retry by factory recover; the count of exhausted effects is not readable through the store API"
   }
   ```

   `retrying` is the subset whose `attempts > 0`, i.e. a launch that was tried and refused — the ones
   `recover` will pick up. `dead: null` is not zero: exhausted effects have no read API.

3. **The panel's health card** shows the same projection, with the detail verbatim.

**How an effect gets here.** The row is committed in the same transaction as the lease, the attempt
and the reservation, _before_ the worker is launched (ADR-005). Three things leave it `pending`:

- **`factory run --no-wait`** — by design. The verb prints `launch deferred: effect E-… stays pending.
This build has no daemon; factory recover launches it once the lease expires.` Nothing is wrong;
  until `recover` runs, work you asked for is not running.
- **A crash between the commit and the launch** — `recover` is exactly the catch-up path.
- **A launch that failed environmentally** — `EXECUTOR_UNAVAILABLE`, `CONTAINER_UNAVAILABLE` or
  `DSH_VERSION_MISMATCH` settle as `retryable`, so the row stays `pending` with `attempts > 0`.

**A host with no `dsh` at all does not produce this state.** `factory run` refuses _before_ the
transaction ("Nothing was dispatched and no budget was reserved"), so no effect is written. If you see
`retrying > 0`, the environment was usable at commit time and broke at launch — usually a `dsh` that
is present but the wrong version, or a container runtime that stopped.

## What the factory will refuse to do

- **Launch twice for one unit.** A live lease refuses the second launch outright (`LEASE_HELD`,
  exit `7`) — enforced by the database index `leases_one_live_per_unit`, not by timing.
- **Claim the same effect twice.** `claimLaunchEffect` re-reads the committed row and is an
  idempotency assert; it is not a work queue (`apps/cli/src/effects.ts`).
- **Retry a decision-class failure.** Gate, budget, lease, mandate, quarantine and integrity
  refusals settle the row as `exhausted` → `failed`. Recovery will not re-run them; it reports
  `refused (now exhausted)` instead.
- **Silently forget a pending intent.** A pending effect keeps the outbox `degraded`; it never
  reports `ok` while work it was asked to do has not been performed.

## Commands, in this order

```bash
export PATH="$HOME/.nvm/versions/node/$(cat .nvmrc)/bin:$PATH"

# 1. See the unit and the gate that is open (read-only).
factory status --all

# 2. Retry what can be retried. Idempotent: safe to run repeatedly, never re-dispatches an attempt.
#    If it says "lease … is live", that is not an error: the lease must expire before a relaunch is
#    safe. Re-run recover after it does (the block prints the lease id and the attempt to watch).
factory recover

# 3. If the environment was the problem, fix it, then recover again:
#      - install the pinned dsh on PATH (or point DSH_BIN at it) and start a docker daemon;
#      - confirm with: factory version        # executor line must not say "unavailable"

# 4. If a receipt was recovered, judge it rather than re-running the work.
factory run <unitId> --verify-only

# 5. If the row is exhausted, a person decides. Nothing is rolled back either way.
factory abort <unitId> --reason "effect <effectId> exhausted: <the refusal>; resubmitting a new revision"
```

## What "fixed" looks like

- `factory status --json` reports `health.outbox.state: "ok"`, `pending: 0` — the detail says "no
  launch effect is pending; every intent to launch has been settled".
- `factory recover` reports `launch effects: 1 performed, 0 deferred, 0 refused` (or no launch-effects
  line at all when there was nothing to do), and `0 attempt(s) found without a terminal event`.
- The unit is no longer stuck in `dispatched`/`running`/`verifying`: it reached `verified`, or it is
  terminally `aborted`/`failed` with a reason, and `factory audit <unitId>` shows the settlement event
  (`effect.applied`, or `effect.failed` with the refusal code).

## If it does not work

- **The same effect stays `pending` across repeated `recover`s.** The launcher is still refusing
  environmentally. `factory recover` will not retry a lease that is live, and will not retry into a
  broken environment; fix the environment first, then recover. `factory version` is the quickest
  tell (`executor  unavailable …`).
- **`recover` says `refused (now exhausted)`.** That row will never be retried. Treat it as a
  decision: abort and resubmit a new revision, or open a defect if the refusal code is wrong for the
  cause. Do not hand-edit the effect's state — the settlement vocabulary (`applied` / `retryable` /
  `exhausted`) is the contract the rest of the system reasons about.
- **`factory status` cannot count exhausted effects.** The store has no public read for them
  (`dead: null` in the health projection, and the detail says so). Use `recover`'s refused line, or
  read `factory audit --last 50`.
- **The store itself reports `quarantined`.** Every write is refused, including recovery's. See
  [store-quarantine.md](store-quarantine.md).

**Known gap.** There is no `factory outbox` verb and no scheduler: `factory run` handles one unit
per invocation and there is no background loop to settle anything for you
([`phase-13-audit.md`](../planning/dark-factory-dsh/phase-13-audit.md): GAP-001 fixed the settlement;
GAP-004 records that the scheduler/worker-slot layer is not built).
