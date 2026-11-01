/**
 * The effect outbox dispatcher.
 *
 * The engine writes state changes and returns the effects those changes imply;
 * both are committed in one transaction. This component is what runs afterwards,
 * outside that transaction, and it is the only place the factory performs an
 * external side effect. Its job is to make that side effect happen **at most
 * once**, keyed by content, so that a crash at any point cannot duplicate work.
 *
 * Five rules, and the reasoning each one rests on:
 *
 * 1. **Content-addressed, never time-addressed.** An effect is identified by an
 *    idempotency key derived from its inputs (`idempotencyKey()` in
 *    `@factory/contracts`). Whether it already happened is a fact stored in the
 *    ledger, not a guess based on "when did we last run the drain". A `pending`
 *    row left over from three months ago is still pending; an `applied` row is
 *    still applied after a reboot, a restore, or a replay of the transcript.
 *
 * 2. **The store is the only memory.** The dispatcher keeps no in-process record
 *    of what it has done, so a second dispatcher (in this process, in another
 *    one, or after a restart) sees exactly the same world and makes exactly the
 *    same decisions. The one exception is local, documented, and discarded on
 *    return: the set of effect ids *attempted inside a single `drain()` call*.
 *    It cannot be removed — a retryable failure leaves its row `pending`, so
 *    without it the next claim page would return the same effect and retry it in
 *    a tight loop, which rule 3 forbids. That is iteration bookkeeping, not
 *    history.
 *
 * 3. **Failures are recorded, bounded, and never erased.** An unknown kind is a
 *    wiring bug and fails permanently. A throwing handler records the error,
 *    increments the attempt count, and is retried on the *next* drain, up to
 *    `maxAttempts`; past that it is `failed` for good. Nothing is deleted: a
 *    failed effect is evidence, and `effects` rows outlive the run that failed.
 *
 * 4. **One bad effect never stalls the queue.** Every effect in the page is
 *    attempted regardless of what the previous one did.
 *
 * 5. **This is a drainer, not a scheduler.** It knows nothing about units,
 *    dependencies, priorities, backoff, or per-unit serialisation. Ordering
 *    across claims is the store's (its `effects_state(state, created_at)` index
 *    makes "oldest pending first" the natural read); within a claim page the
 *    dispatcher sorts by `(createdAt, effectId)` so the order it reports is the
 *    order it used, even if a store hands rows back unordered. Two effects for
 *    the same unit are therefore applied in creation order and are never
 *    reordered here. Scheduling is a later concern and belongs in the engine.
 *
 * **The residual window, stated plainly.** The side effect happens before
 * `markEffectApplied` commits. A crash in between re-delivers the effect on the
 * next drain. That is why `EffectHandler.run` is idempotent *by contract*: the
 * ledger guarantees at-most-once *per recorded outcome*, and the handler absorbs
 * the re-delivery. Claiming "exactly once" would be a lie the code cannot back.
 *
 * **The single-dispatcher assumption (stated once, relied on everywhere).** The
 * guarantee above is scoped to **one dispatcher process at a time** — the v1
 * shape, one control plane and one writer. `claimPendingEffects` returns rows but
 * does not stamp a claim, and `effects` has no claim/lease column, so two
 * *concurrent* dispatchers over one database could each apply the same effect.
 * Sequential dispatchers — restart, recovery, a second process taking over after
 * the first exits, or a manual `applyKey` beside a drain — are covered and
 * tested: they read the same ledger and reach the same decision. Enforcing the
 * cross-process case would need a claim column and a lease, which v1 does not
 * have; inventing one here would be a guarantee the schema cannot keep.
 */
import { FactoryError } from '@factory/contracts';
import type { EffectRow, Store } from '../../store/src/types.ts';
import type { EffectContext, EffectHandler } from './handlers.ts';
import { indexHandlers } from './handlers.ts';

/**
 * The dispatcher's view of the store — four operations, no more.
 *
 * Narrow on purpose: the outbox dispatcher has no business reading units,
 * verdicts, or spend, and a store that satisfies this smaller interface can be
 * faked in a test without pretending to be a database. The two assertions below
 * are compile-time proof that this view and the real `Store` cannot drift apart:
 * if `packages/store` renames a parameter or changes a return type, this file
 * stops compiling instead of failing at run time.
 */
export interface EffectStore {
  getEffectByKey(idempotencyKey: string): EffectRow | null;
  claimPendingEffects(limit: number): EffectRow[];
  markEffectApplied(effectId: string, at: string): void;
  /**
   * Record a **retryable** failure: attempts + 1, `last_error`, row stays
   * `pending` so the next drain retries it.
   */
  recordEffectFailure(effectId: string, error: string): EffectRow;
  /**
   * Record a **terminal** failure: attempts + 1, `last_error`, row becomes
   * `failed` and is never claimed again.
   *
   * Separate from `recordEffectFailure` because "it failed once" and "it will
   * never succeed" are different facts; with one operation the dispatcher would
   * have to either lose retries or retry forever.
   */
  markEffectExhausted(effectId: string, error: string): void;
}

/** The part of `Store` the dispatcher depends on. */
type StoreEffectOps = Pick<
  Store,
  | 'getEffectByKey'
  | 'claimPendingEffects'
  | 'markEffectApplied'
  | 'recordEffectFailure'
  | 'markEffectExhausted'
>;

type AssertAssignable<From, To> = From extends To ? true : never;
// Real store satisfies the narrow view, and the narrow view satisfies the real
// store's effect surface. Either direction breaking is a compile error.
type _StoreSatisfiesEffectStore = AssertAssignable<StoreEffectOps, EffectStore>;
type _EffectStoreSatisfiesStore = AssertAssignable<EffectStore, StoreEffectOps>;

export const DEFAULT_MAX_ATTEMPTS = 3;

/**
 * How many rows a single `claimPendingEffects` call asks for. Small enough that a
 * deep backlog is walked in stable, oldest-first pages rather than one giant
 * array; large enough that a normal drain is one query.
 */
export const CLAIM_PAGE_SIZE = 50;

const NOOP_LOG = (_line: string): void => {};

export interface DispatcherOptions {
  readonly store: EffectStore;
  readonly handlers: readonly EffectHandler[];
  readonly now: () => Date;
  /** Total attempts allowed per effect before it is `failed` for good. Default 3. */
  readonly maxAttempts?: number;
  readonly log?: (line: string) => void;
}

export interface DrainSummary {
  /** Effects this drain performed and recorded as applied. */
  applied: number;
  /** Effects this drain did not apply and recorded, or found permanently failed. */
  failed: number;
  /** Effects this drain deliberately did not invoke because they were already applied or already failed. */
  skipped: number;
}

export type ApplyKeyResult = 'applied' | 'failed' | 'missing';

/** What one pass over one effect concluded. Mapped to `DrainSummary` fields. */
type EffectOutcome = 'applied' | 'failed' | 'skipped';

export interface EffectDispatcher {
  /** Apply every pending effect, oldest first. Returns a per-effect result summary. */
  drain(): Promise<DrainSummary>;
  /** Apply exactly one effect by idempotency key; used by tests and by manual recovery. */
  applyKey(key: string): Promise<ApplyKeyResult>;
}

export function createDispatcher(options: DispatcherOptions): EffectDispatcher {
  const { store } = options;
  const maxAttempts = options.maxAttempts ?? DEFAULT_MAX_ATTEMPTS;
  const log: (line: string) => void = options.log ?? NOOP_LOG;
  const nowIso = (): string => options.now().toISOString();

  if (!Number.isInteger(maxAttempts) || maxAttempts < 1) {
    throw new FactoryError(
      'INTERNAL',
      `effects: maxAttempts must be an integer >= 1 (got ${String(maxAttempts)})`,
    );
  }
  const byKind = indexHandlers(options.handlers);

  /**
   * Write a permanent failure.
   *
   * `markEffectExhausted` is the only operation that may end an effect's life, and
   * it is deliberately not the same call as `recordEffectFailure`: collapsing the
   * two is how a factory either loses retries or retries forever.
   */
  function terminalize(effectId: string, detail: string): void {
    store.markEffectExhausted(effectId, detail);
  }

  /** The whole state machine for one effect. Never throws for a handler failure. */
  async function applyPending(row: EffectRow): Promise<EffectOutcome> {
    // Rule 1. The row is the authority. `applied` means the side effect is on the
    // record as having happened — even if that record is months old and this
    // process has never seen it — so it is never run again.
    if (row.state === 'applied') {
      log(
        `effect ${row.effectId} (${row.kind}) already applied at ${row.appliedAt ?? 'an unrecorded time'}; not re-running`,
      );
      return 'skipped';
    }

    // A terminal row is terminal whatever `attempts` says. This matters: an effect
    // failed for an unknown kind is exhausted at attempts = 1, well below the cap,
    // so `attempts` alone would look like a retryable failure. A store that leaked
    // a `failed` row into a claim page must not be able to resurrect it.
    if (row.state === 'failed') {
      log(
        `effect ${row.effectId} (${row.kind}) is already permanently failed (${row.lastError ?? 'no error recorded'}); not re-running`,
      );
      return 'skipped';
    }

    // Cap already reached on the record. Reachable when `maxAttempts` is lowered
    // between deploys, when a store write partially applied, or when a hand-fixed
    // ledger is replayed — the row says the attempts are spent, so the verdict is
    // already decided: finish the bookkeeping, do not invoke. `markEffectExhausted`
    // records this terminal write (and increments attempts past the cap, which is
    // accurate: the attempt budget is gone).
    if (row.attempts >= maxAttempts) {
      const detail =
        row.lastError ??
        `attempts exhausted (${row.attempts}/${maxAttempts}) without a terminal write`;
      terminalize(row.effectId, detail);
      log(
        `effect ${row.effectId} (${row.kind}) was left pending at ${row.attempts}/${maxAttempts} attempts; recording permanent failure without re-running`,
      );
      return 'failed';
    }

    // Rule 3, unknown kind: a failure, never a silent skip, never a retry — no
    // future drain can conjure a handler that is not registered.
    const handler = byKind.get(row.kind);
    if (handler === undefined) {
      const detail = `no handler registered for kind "${row.kind}"`;
      terminalize(row.effectId, detail);
      log(`effect ${row.effectId} failed permanently: ${detail}`);
      return 'failed';
    }

    const attempt = row.attempts + 1;
    const ctx: EffectContext = { effectId: row.effectId, attempt };
    try {
      await handler.run(row.payload, ctx);
    } catch (error) {
      const detail = describeError(error);
      if (attempt >= maxAttempts) {
        terminalize(row.effectId, detail);
        log(
          `effect ${row.effectId} (${row.kind}) failed permanently after ${attempt}/${maxAttempts} attempt(s): ${detail}`,
        );
        return 'failed';
      }
      // Retryable: record the attempt and leave the row pending. The retry is the
      // *next* drain's business — no sleeping, no immediate re-invocation.
      store.recordEffectFailure(row.effectId, detail);
      log(
        `effect ${row.effectId} (${row.kind}) attempt ${attempt}/${maxAttempts} failed, will retry on the next drain: ${detail}`,
      );
      return 'failed';
    }

    store.markEffectApplied(row.effectId, nowIso());
    log(`effect ${row.effectId} (${row.kind}) applied on attempt ${attempt}`);
    return 'applied';
  }

  async function drain(): Promise<DrainSummary> {
    const summary: DrainSummary = { applied: 0, failed: 0, skipped: 0 };
    // Scoped to this call and dropped on return — see the header, rule 2.
    const attempted = new Set<string>();

    for (;;) {
      const page = store.claimPendingEffects(CLAIM_PAGE_SIZE);
      if (page.length === 0) break;

      let fresh = 0;
      for (const row of sortQueue(page)) {
        if (attempted.has(row.effectId)) continue;
        // Marked before the await: a handler that re-enters the dispatcher must
        // not cause this effect to be attempted twice in one drain.
        attempted.add(row.effectId);
        fresh += 1;
        const outcome = await applyPending(row);
        summary[outcome] += 1;
      }

      // A page made entirely of effects this drain already attempted means the
      // remaining queue is exactly the retryables waiting for the *next* drain.
      // Stop: re-claiming them would be the tight retry loop rule 3 forbids.
      // Termination is guaranteed — the pending set is finite and every iteration
      // that continues attempts at least one new effect.
      if (fresh === 0) break;
    }

    return summary;
  }

  async function applyKey(key: string): Promise<ApplyKeyResult> {
    const row = store.getEffectByKey(key);
    if (row === null) {
      log(`effect key ${key} is not in the outbox; nothing to apply`);
      return 'missing';
    }
    // A terminal failure answers `failed` forever. Manual recovery asking about a
    // dead effect must be told the truth, not handed the `applied` that every
    // "did not need to run" case would otherwise collapse into.
    if (row.state === 'failed') {
      log(
        `effect key ${key} is permanently failed (${row.lastError ?? 'no error recorded'}); not re-running`,
      );
      return 'failed';
    }
    const outcome = await applyPending(row);
    // `skipped` here means the row was already `applied`: from the caller's point of
    // view the effect is done, and it was not run twice. That is an `applied` answer.
    return outcome === 'failed' ? 'failed' : 'applied';
  }

  return { drain, applyKey };
}

/**
 * Oldest first, then `effectId` for stability.
 *
 * `createdAt` is an ISO-8601 UTC string (`now().toISOString()` writes it), so
 * lexicographic comparison is chronological. The tie-break uses byte order rather
 * than `localeCompare`, because ordering must not depend on the machine's locale:
 * a different order between two runs is a different replay.
 */
function sortQueue(rows: readonly EffectRow[]): EffectRow[] {
  return [...rows].sort((left, right) => {
    if (left.createdAt !== right.createdAt) return left.createdAt < right.createdAt ? -1 : 1;
    if (left.effectId === right.effectId) return 0;
    return left.effectId < right.effectId ? -1 : 1;
  });
}

/**
 * The one-line error record written to `last_error`.
 *
 * `Error.prototype.stack`'s first line is just `Name: message`, so the useful part
 * is the first *frame* — where it was thrown. Record `message` plus that frame:
 * enough to identify the failure months later without storing a whole stack in a
 * TEXT column.
 */
function describeError(error: unknown): string {
  if (error instanceof Error) {
    const frames = error.stack?.split('\n') ?? [];
    const frame = frames.find((line) => line.trim().startsWith('at '))?.trim();
    return frame === undefined
      ? `${error.name}: ${error.message}`
      : `${error.name}: ${error.message} (${frame})`;
  }
  if (typeof error === 'string') return error;
  return `non-Error thrown: ${safeStringify(error)}`;
}

function safeStringify(value: unknown): string {
  try {
    return JSON.stringify(value) ?? String(value);
  } catch {
    return Object.prototype.toString.call(value);
  }
}
