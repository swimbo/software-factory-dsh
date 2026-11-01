/**
 * An in-memory `EffectStore` for tests.
 *
 * Exists so the dispatcher's unit tests do not depend on the SQLite store landing,
 * and — more usefully — so the store semantics the dispatcher assumes are written
 * down in executable form rather than in prose:
 *
 *  - `enqueueEffect` is idempotent on `idempotencyKey` and returns the existing
 *    row, so "enqueued twice" is one effect (the schema's `UNIQUE` constraint);
 *  - `recordEffectFailure` increments `attempts`, sets `last_error`, and leaves the
 *    row `pending` — a retry is the next drain's business;
 *  - `markEffectExhausted` increments `attempts`, sets `last_error`, and makes the
 *    row `failed` for good.
 *
 * It deliberately returns **copies**, like a real store returns freshly-read rows:
 * a dispatcher that mutated a returned row must not be able to mutate the store by
 * accident. `claimPendingEffects` also re-reports pending rows on every call — it
 * marks no claim, exactly like the real one — which is the worst case the
 * dispatcher's in-drain dedupe has to survive.
 *
 * Not exported from `src/index.ts`: this is a test seam, not part of the package's
 * public surface.
 */
import type { EffectRow } from '../../store/src/types.ts';
import type { EffectStore } from './dispatcher.ts';

export interface EnqueueEffectInput {
  readonly effectId: string;
  readonly idempotencyKey: string;
  readonly kind: string;
  readonly payload: unknown;
  readonly createdAt: string;
}

/** Forcing a row into a state a crashed drain could have left behind. */
export interface EffectRowPatch {
  readonly state?: EffectRow['state'];
  readonly attempts?: number;
  readonly appliedAt?: string | null;
  readonly lastError?: string | null;
}

export interface FakeEffectStore extends EffectStore {
  enqueueEffect(row: EnqueueEffectInput): EffectRow;
  /** The current row for a key, bypassing the pending projection. */
  peek(idempotencyKey: string): EffectRow | null;
  /** Test seam: rewrite fields directly, e.g. to simulate a crash mid-drain. */
  patch(idempotencyKey: string, patch: EffectRowPatch): void;
  /** Test seam: make `claimPendingEffects` return rows in this id order (an unordered store). */
  setClaimOrder(effectIds: readonly string[]): void;
  /**
   * Test seam: which states `claimPendingEffects` is willing to return. Defaults to
   * `['pending']`; widening it lets a test prove the dispatcher survives a store
   * that leaks terminal rows into a claim.
   */
  setClaimableStates(states: readonly EffectRow['state'][]): void;
  /** Every row, oldest first, for assertions. */
  rows(): EffectRow[];
}

export function createFakeEffectStore(): FakeEffectStore {
  const byId = new Map<string, EffectRow>();
  const keyToId = new Map<string, string>();
  let claimOrder: readonly string[] | null = null;
  let claimableStates: ReadonlySet<EffectRow['state']> = new Set<EffectRow['state']>(['pending']);

  const clone = (row: EffectRow): EffectRow => ({ ...row });

  function requireRow(effectId: string): EffectRow {
    const row = byId.get(effectId);
    if (row === undefined) {
      throw new Error(`fake store: no effect with id ${effectId}`);
    }
    return row;
  }

  function rewrite(effectId: string, next: EffectRow): EffectRow {
    byId.set(effectId, next);
    return clone(next);
  }

  function orderIndex(row: EffectRow): number {
    if (claimOrder === null) return 0;
    const index = claimOrder.indexOf(row.effectId);
    return index === -1 ? Number.MAX_SAFE_INTEGER : index;
  }

  return {
    enqueueEffect(input: EnqueueEffectInput): EffectRow {
      const existingId = keyToId.get(input.idempotencyKey);
      if (existingId !== undefined) {
        // The real store relies on `idempotency_key TEXT NOT NULL UNIQUE`; the
        // second enqueue is a read, not a second effect.
        return clone(requireRow(existingId));
      }
      const row: EffectRow = {
        effectId: input.effectId,
        idempotencyKey: input.idempotencyKey,
        kind: input.kind,
        payload: input.payload,
        state: 'pending',
        attempts: 0,
        createdAt: input.createdAt,
        appliedAt: null,
        lastError: null,
      };
      byId.set(row.effectId, row);
      keyToId.set(row.idempotencyKey, row.effectId);
      return clone(row);
    },

    getEffectByKey(idempotencyKey: string): EffectRow | null {
      const id = keyToId.get(idempotencyKey);
      const row = id === undefined ? undefined : byId.get(id);
      return row === undefined ? null : clone(row);
    },

    claimPendingEffects(limit: number): EffectRow[] {
      const pending = [...byId.values()].filter((row) => claimableStates.has(row.state));
      pending.sort((left, right) => {
        const byOrder = orderIndex(left) - orderIndex(right);
        if (byOrder !== 0) return byOrder;
        if (left.createdAt !== right.createdAt) return left.createdAt < right.createdAt ? -1 : 1;
        if (left.effectId === right.effectId) return 0;
        return left.effectId < right.effectId ? -1 : 1;
      });
      return pending.slice(0, Math.max(0, limit)).map(clone);
    },

    markEffectApplied(effectId: string, at: string): void {
      const row = requireRow(effectId);
      rewrite(effectId, { ...row, state: 'applied', appliedAt: at, lastError: null });
    },

    recordEffectFailure(effectId: string, error: string): EffectRow {
      const row = requireRow(effectId);
      return rewrite(effectId, { ...row, attempts: row.attempts + 1, lastError: error });
    },

    markEffectExhausted(effectId: string, error: string): void {
      const row = requireRow(effectId);
      rewrite(effectId, {
        ...row,
        attempts: row.attempts + 1,
        lastError: error,
        state: 'failed',
      });
    },

    peek(idempotencyKey: string): EffectRow | null {
      const id = keyToId.get(idempotencyKey);
      const row = id === undefined ? undefined : byId.get(id);
      return row === undefined ? null : clone(row);
    },

    patch(idempotencyKey: string, patch: EffectRowPatch): void {
      const id = keyToId.get(idempotencyKey);
      if (id === undefined) throw new Error(`fake store: no effect for key ${idempotencyKey}`);
      const row = requireRow(id);
      rewrite(id, {
        effectId: row.effectId,
        idempotencyKey: row.idempotencyKey,
        kind: row.kind,
        payload: row.payload,
        state: patch.state ?? row.state,
        attempts: patch.attempts ?? row.attempts,
        createdAt: row.createdAt,
        appliedAt: patch.appliedAt === undefined ? row.appliedAt : patch.appliedAt,
        lastError: patch.lastError === undefined ? row.lastError : patch.lastError,
      });
    },

    setClaimOrder(effectIds: readonly string[]): void {
      claimOrder = [...effectIds];
    },

    setClaimableStates(states: readonly EffectRow['state'][]): void {
      claimableStates = new Set(states);
    },

    rows(): EffectRow[] {
      return [...byId.values()]
        .sort((left, right) => {
          if (left.createdAt !== right.createdAt) return left.createdAt < right.createdAt ? -1 : 1;
          if (left.effectId === right.effectId) return 0;
          return left.effectId < right.effectId ? -1 : 1;
        })
        .map(clone);
    },
  };
}
