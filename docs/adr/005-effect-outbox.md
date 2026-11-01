# ADR-005 — The launch effect is committed before dispatch and settled after it

**Status:** accepted; the settlement half landed in `bf24f6a`
**Context:** [architecture.md](../planning/dark-factory-dsh/architecture.md) §5 (outbox), [phase-13-audit.md](../planning/dark-factory-dsh/phase-13-audit.md) GAP-001
**Proven by:** `packages/effects` (tests for `applied`/`retryable`/`exhausted`), `e2e/cli/default/13-effect-outbox.test.ts`, `packages/store/src/schema.ts` (`leases_one_live_per_unit`)

## Context

Dispatching a worker is the one irreversible act in this system. The factory writes an intent, then
a subprocess starts, and from that moment the outside world can be changed. A crash between the two
— or between the launch and the recording of its result — leaves a hole that no amount of
after-the-fact reasoning can close: did the tool call land or not?

Two naive designs both fail. **Launch first, record later**: a crash loses the fact that anything was
launched, so recovery happily launches again — the double-launch that executes a tool call twice.
**Record first, launch later, no settlement**: a crash after the record but before the launch leaves
an effect that looks performed forever, so the operator is told work is running that never started.
That second failure is what the audit found: the effect row was written and _never settled_ — the
"outbox that was written and never settled, and the flag that lied" (`bf24f6a`).

## Decision

Three commitments:

1. **Commit before launch.** `engine.runUnit` writes the lease, the attempt, the spend reservation
   and the launch effect in **one** `store.atomic` transaction, with the dispatch gate evaluated
   inside it. If that transaction does not commit, nothing was dispatched and nothing can be
   retried into a second launch.
2. **Settle after launch, with three outcomes** (`apps/cli/src/effects.ts`): `applied` (the worker
   ran and its receipt was recorded, including `ATTEMPT_AMBIGUOUS`); `retryable` (an environmental
   refusal — `EXECUTOR_UNAVAILABLE`, `CONTAINER_UNAVAILABLE`, `DSH_VERSION_MISMATCH` — the row
   stays `pending` and `factory recover` may relaunch it); `exhausted` (a decision-class refusal —
   gate, budget, lease, mandate, quarantine, integrity — the row becomes `failed` for good and only
   a person resolves it).
3. **The lease is the double-launch guard.** `leases_one_live_per_unit` is a partial unique index
   (`packages/store/src/schema.ts`), so a second launch for a unit with a live lease refuses with
   `LEASE_HELD` (exit `7`) instead of relying on timing. `claimLaunchEffect` is an **idempotency
   assert, not a queue**: it re-reads the committed row and refuses a second claimer; it never
   creates work.

## Alternatives rejected

- **A real work queue with a broker (or `SELECT … FOR UPDATE SKIP LOCKED` claiming).** Rejected as
  the wrong scope for v1: one host, one process, synchronous launch. A broker would add a second
  source of truth about what is running, and the store's ledger is supposed to be the only one.
  `phase-13-audit.md` GAP-004 notes the scheduler/worker-slot layer is _not built_ precisely so this
  decision can be revisited with a real requirement.
- **Launch-then-record without an outbox.** Rejected: recovery cannot distinguish "never launched"
  from "launched and crashed" — it is the hole the outbox exists to close.
- **Record-then-launch without settlement (what the first implementation did).** Rejected once it
  was measured: a pending row that nobody settles makes `status` report work in flight that is not,
  and `recover` report a clean reconciliation that never happened. The audit's GAP-001 is this
  exact fault.
- **A "fire and forget" daemon that settles effects out of band.** Rejected: v1 has no background
  worker (ND3/ND4 and GAP-004), so a settlement obligation with no owner is the same bug in a nicer
  hat. Settlement is synchronous in the same process that launched, and `recover` is the explicit
  catch-up path.

## Consequences

**Good.** There is no window in which the factory has dispatched but has no record of intending to
dispatch. A crash leaves a `pending` effect that is visible (`factory status` reads the outbox depth
honestly now — `pending`/`retrying`, with `dead` reported as unreadable rather than zero) and
actionable (`factory recover`). Double-launch is impossible even under a race, because the database
refuses the second lease rather than the code remembering not to.

**Bad.** The three-outcome classification is a judgement encoded in one function, and getting a
code in the wrong bucket is a real bug class: classifying an environmental failure as `exhausted`
kills a retryable run, and classifying a decision failure as `retryable` turns a refusal into a
retry loop. It is also not observable from the outside: `status` cannot count `failed` effects
(there is no read API), so "how many exhausted effects exist?" is answered by reading the ledger or
by `factory recover`'s "refused (now exhausted)" line.

**Not built.** No scheduler, no worker slots, no capacity ceiling — `phase-13-audit.md` GAP-004
records that there is no `dispatch` loop and `factory run` handles exactly one unit. `run --retry`
is documented as unavailable in v1 (a second attempt for the same unit is not a supported operation;
a person aborts and resubmits a new revision, see `docs/runbooks/ambiguous-attempt.md`).
