/**
 * The launch effect: claimed, performed, settled. One idempotency assert, no queue.
 *
 * ## Why this module exists
 *
 * `engine.runUnit` commits an intent to launch as an *outbox* row and deliberately does
 * not launch from inside the call, so that a crash after commit retries the launch
 * instead of losing it. That promise only holds if somebody settles the row. Until this
 * module, nobody did: `run` launched inline and never marked the effect applied, so
 * every run left a permanently `pending` row, `recover` had nothing to retry, and
 * `status` reported an outbox leak the CLI itself created.
 *
 * ## What is claimed here
 *
 * Not a queue. `run` knows exactly which effect it is about to perform — it just
 * received the row from `runUnit` — so `claimLaunchEffect` is an **idempotency assert**:
 * the row for this attempt's launch key must exist, must be the same row, and must
 * still be `pending`. If any of that is false the factory is about to do something
 * twice, and the right response is to stop rather than to launch.
 *
 * ## Settling: three outcomes, not two
 *
 * - `applied` — the worker process ran. Success, and also `ATTEMPT_AMBIGUOUS`: the turn
 *   ran and failed to end, which is a fact about a measurement, not about the launch.
 *   Marking that retryable would launch a second process to ask what the first one did.
 * - `retryable` — nothing started and the reason is environmental (no binary, no
 *   container, wrong DSH version, unusable mirror). The row stays pending so `recover`
 *   can retry it after the operator fixes the environment.
 * - `exhausted` — nothing started and retrying cannot help (budget, gate, lease,
 *   mandate, quarantine, integrity). The row becomes `failed` for good: it is the
 *   record of a launch that will never happen, and a person must decide what to do with
 *   the attempt.
 *
 * A refused effect that nobody can ever retry is just a differently-shaped leak, which
 * is why `exhausted` exists and why `recover` reports both states.
 */
import { FactoryError, type ErrorCode } from '@factory/contracts';
import type { EffectRow, Store } from '@factory/store';

/** How an attempted effect ended. The vocabulary the store already has. */
export type EffectSettlement = 'applied' | 'retryable' | 'exhausted';

/**
 * Which failures are worth retrying.
 *
 * The test is not "is this error class 8" but **did the worker start**:
 *
 * - `EXECUTOR_UNAVAILABLE` / `CONTAINER_UNAVAILABLE` / `CONFIGURATION_CONFLICT` — the launcher was
 *   missing or a setting was inconsistent, so no process exists. Fix it and `recover` may try again.
 * - `DSH_VERSION_MISMATCH` — the binary is there but the wrong one; the operator can pin
 *   the right version, so it is retryable for the same reason.
 * - everything else that can reach here (gate, budget, lease, mandate, quarantine,
 *   integrity, spec) is a decision, not an environment: retrying repeats the decision.
 *
 * `ATTEMPT_AMBIGUOUS` is listed as applied because the process demonstrably ran; see the
 * module comment.
 */
const SETTLEMENTS: Readonly<Partial<Record<ErrorCode, EffectSettlement>>> = {
  EXECUTOR_UNAVAILABLE: 'retryable',
  CONTAINER_UNAVAILABLE: 'retryable',
  // A setting the operator edits, not a fact about the work: nothing started, so once the
  // configuration is consistent `recover` may try the launch again.
  CONFIGURATION_CONFLICT: 'retryable',
  DSH_VERSION_MISMATCH: 'retryable',
  ATTEMPT_AMBIGUOUS: 'applied',
};

function settlementFor(code: ErrorCode): EffectSettlement {
  return SETTLEMENTS[code] ?? 'exhausted';
}

/** How many times a single launch effect may be attempted before a person must look. */
export const MAX_LAUNCH_ATTEMPTS = 2;

/**
 * The idempotency assert.
 *
 * `launchKey` is the attempt's own idempotency key, so a duplicate `run` cannot mint a
 * second effect — `enqueueEffect` returns the row the key already names. What this
 * checks is that the row we are about to settle is that row, and that nobody settled it
 * already.
 */
export function claimLaunchEffect(store: Store, launchKey: string, effectId: string): EffectRow {
  const effect = store.getEffectByKey(launchKey);
  if (effect === null) {
    throw new FactoryError(
      'INTERNAL',
      `the dispatch committed attempt launch key ${launchKey} but the outbox holds no effect for it; ` +
        'launching now would perform an effect the ledger does not record',
      { launchKey, effectId },
    );
  }
  if (effect.effectId !== effectId) {
    throw new FactoryError(
      'INTERNAL',
      `the outbox names effect ${effect.effectId} for launch key ${launchKey}, but the dispatch returned ` +
        `${effectId}; one of the two is wrong and launching either could double-perform the intent`,
      { launchKey, effectId, storedEffectId: effect.effectId },
    );
  }
  if (effect.kind !== 'launch') {
    throw new FactoryError(
      'INTERNAL',
      `effect ${effectId} is a '${effect.kind}', not a 'launch'; this path only performs launches`,
      { effectId, kind: effect.kind },
    );
  }
  if (effect.state === 'applied') {
    throw new FactoryError(
      'INTERNAL',
      `effect ${effectId} is already applied (at ${String(effect.appliedAt)}); launching again would ` +
        'start a second worker for work the ledger already recorded as performed',
      { effectId, appliedAt: effect.appliedAt },
    );
  }
  if (effect.state === 'failed') {
    throw new FactoryError(
      'EXECUTOR_UNAVAILABLE',
      `effect ${effectId} is exhausted after ${String(effect.attempts)} attempt(s): ${String(effect.lastError)}. ` +
        'Nothing will retry it; a person must fix the cause and resubmit a new revision.',
      { effectId, attempts: effect.attempts, lastError: effect.lastError },
    );
  }
  return effect;
}

/** The worker ran: record that the intent was performed, at the moment it was. */
export function settleApplied(store: Store, effectId: string, at: string): void {
  store.markEffectApplied(effectId, at);
}

/** Nothing started, and the environment can be fixed: stay `pending` for `recover`. */
function settleRetryable(store: Store, effectId: string, reason: string): void {
  store.recordEffectFailure(effectId, reason);
}

/** Nothing started and nothing will: `failed` for good, so the outbox has no lie in it. */
function settleExhausted(store: Store, effectId: string, reason: string): void {
  store.markEffectExhausted(effectId, reason);
}

/**
 * Settle by failure code, which is where the retryability table is applied.
 *
 * `detail` is stored verbatim on the row (`last_error`), so it must be something an
 * operator can act on later without the stderr of the run that produced it.
 */
export function settleFailure(
  store: Store,
  effectId: string,
  code: ErrorCode,
  detail: string,
  at: string,
): EffectSettlement {
  const settlement = settlementFor(code);
  if (settlement === 'applied') {
    // The process ran; the ambiguity is the *attempt's* fact, not the effect's.
    settleApplied(store, effectId, at);
    return settlement;
  }
  if (settlement === 'retryable') {
    settleRetryable(store, effectId, `${code}: ${detail}`);
    return settlement;
  }
  settleExhausted(store, effectId, `${code}: ${detail}`);
  return settlement;
}

/**
 * Pending launch effects, oldest first. A pure read; `recover` is the only consumer.
 *
 * The limit is a bound on work per invocation, not a queue semantic: a factory with
 * more than `limit` pending launches has a different problem, and `status` shows the
 * count so it is visible rather than silently truncated.
 */
export function pendingLaunches(store: Store, limit = 16): EffectRow[] {
  return store
    .claimPendingEffects(limit)
    .filter((effect) => effect.kind === 'launch' && effect.state === 'pending');
}

export interface OutboxCounts {
  readonly pending: number;
  readonly retrying: number;
  /**
   * `null`: the store exposes no read for `failed` effects.
   *
   * Deliberately not `0`. `claimPendingEffects` filters to `state = 'pending'`, and there
   * is no public read for the exhausted rows, so claiming zero would be a measurement
   * nobody took (L3). The detail string on the health line says exactly this.
   */
  readonly dead: number | null;
}

/**
 * Count what the outbox actually holds.
 *
 * `claimPendingEffects` is a plain `SELECT ... WHERE state = 'pending'` (no claim, no
 * write, no lock), which is why it is safe to call from a read-only command. Throws only
 * when the read genuinely fails, and the caller turns that into `unknown` — the one case
 * where "not observable" is true.
 */
export function outboxCounts(store: Store): OutboxCounts {
  const pendingRows = store.claimPendingEffects(1000);
  return {
    pending: pendingRows.length,
    retrying: pendingRows.filter((effect) => effect.attempts > 0).length,
    dead: null,
  };
}
