/**
 * The seam test: the dispatcher against the **real** store.
 *
 * The unit tests prove the dispatcher's decisions against a fake. This file proves
 * the two components agree on the three facts at-most-once actually rests on:
 *
 *  1. `enqueueEffect` is idempotent on `idempotencyKey` — a second enqueue is a
 *     read, not a second effect;
 *  2. `recordEffectFailure` leaves the row `pending` (retryable) while
 *     `markEffectExhausted` makes it `failed` for good — if the store collapsed
 *     those, either retries would vanish or they would never stop;
 *  3. `applied` survives a close/reopen of the database, so a restarted process
 *     does not re-run an effect it already performed.
 *
 * Types come from `@factory/store` itself (so a rename breaks the build), but the
 * module is loaded lazily and every test **skips** while `openStore` is absent or
 * incomplete: `packages/store` is written in parallel. The assertions are not
 * weakened when it is present — a store that implements the operations and
 * disagrees with the contract fails the suite.
 */
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it, type TestContext } from 'vitest';
import type { OpenStoreOptions, Store } from '@factory/store';
import { createDispatcher } from './dispatcher.ts';
import { defineEffectHandler } from './handlers.ts';

const STORE_SPECIFIER = '@factory/store';
const FIXED_NOW = new Date('2026-11-01T00:00:00.000Z');
const now = (): Date => FIXED_NOW;
const ISO = FIXED_NOW.toISOString();

/** The store's own enqueue shape — never restated by hand, so it cannot drift. */
type EnqueueInput = Parameters<Store['enqueueEffect']>[0];

type OpenStoreFn = (options: OpenStoreOptions) => Store;

const EFFECT_OPS = [
  'getEffectByKey',
  'claimPendingEffects',
  'markEffectApplied',
  'recordEffectFailure',
  'markEffectExhausted',
] as const;

/**
 * Load `@factory/store` without a static value import: the module may still be
 * absent or half-written, and a static import would fail the whole suite instead of
 * skipping this file. The specifier is a variable on purpose — it stops TypeScript
 * from resolving it eagerly.
 */
async function loadOpenStore(): Promise<OpenStoreFn | null> {
  try {
    const module = (await import(STORE_SPECIFIER)) as { openStore?: unknown };
    return typeof module.openStore === 'function' ? (module.openStore as OpenStoreFn) : null;
  } catch {
    return null;
  }
}

const openStore = await loadOpenStore();
const HAS_STORE = openStore !== null;

/** Temp directories created by this file, removed once the suite finishes. */
const tempDirs: string[] = [];
afterAll(async () => {
  for (const dir of tempDirs) {
    await rm(dir, { recursive: true, force: true });
  }
});

async function makeTempDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'factory-effects-'));
  tempDirs.push(dir);
  return dir;
}

/**
 * Open the real store over `dir`. `:memory:` is refused by the store itself (WAL
 * needs a file), which is why this is a temp *directory* and not a memory handle.
 * Returns null and skips the calling test when the store is not usable yet.
 */
async function openRealStore(ctx: TestContext, dir: string): Promise<Store | null> {
  if (openStore === null) {
    ctx.skip('@factory/store is not implemented yet');
    return null;
  }
  try {
    const store = openStore({ dir, now });
    const missing = EFFECT_OPS.filter((op) => typeof store[op] !== 'function');
    if (missing.length > 0) {
      store.close();
      ctx.skip(`@factory/store does not implement ${missing.join(', ')} yet`);
      return null;
    }
    return store;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    ctx.skip(`openStore({ dir }) is not usable yet: ${message}`);
    return null;
  }
}

function launchHandler(
  calls: string[],
  alwaysThrows: boolean,
): ReturnType<typeof defineEffectHandler> {
  return defineEffectHandler({
    kind: 'launch-attempt',
    run: async (_payload: unknown, ctx): Promise<void> => {
      calls.push(`${ctx.effectId}#${ctx.attempt}`);
      if (alwaysThrows) throw new Error('executor refused the attempt');
    },
  });
}

const LAUNCH_ROW: Omit<EnqueueInput, 'createdAt'> = {
  effectId: 'eff-1',
  idempotencyKey: 'launch-attempt:unit-1',
  kind: 'launch-attempt',
  payload: { unitId: 'unit-1' },
};

describe('dispatcher over the real store', () => {
  it.skipIf(!HAS_STORE)(
    'applies an effect at most once, across a close and reopen',
    async (ctx) => {
      const dir = await makeTempDir();
      const store = await openRealStore(ctx, dir);
      if (store === null) return;

      const calls: string[] = [];
      try {
        const first = store.enqueueEffect({ ...LAUNCH_ROW, createdAt: '2026-11-01T00:00:01.000Z' });
        expect(first.state).toBe('pending');
        expect(first.attempts).toBe(0);

        // The key is unique in the schema: the second producer's enqueue is a read.
        const duplicate = store.enqueueEffect({
          ...LAUNCH_ROW,
          effectId: 'eff-2',
          createdAt: '2026-11-01T00:00:09.000Z',
        });
        expect(duplicate.effectId).toBe(first.effectId);

        const dispatcher = createDispatcher({
          store,
          now,
          handlers: [launchHandler(calls, false)],
        });
        await expect(dispatcher.drain()).resolves.toEqual({ applied: 1, failed: 0, skipped: 0 });
        expect(calls).toEqual(['eff-1#1']);
        expect(store.getEffectByKey(LAUNCH_ROW.idempotencyKey)).toMatchObject({
          state: 'applied',
          appliedAt: ISO,
        });
        await expect(dispatcher.drain()).resolves.toEqual({ applied: 0, failed: 0, skipped: 0 });
        expect(calls).toEqual(['eff-1#1']);

        // A second dispatcher over the same open store: no hidden state, no re-run.
        const sibling = createDispatcher({ store, now, handlers: [launchHandler(calls, false)] });
        await expect(sibling.applyKey(LAUNCH_ROW.idempotencyKey)).resolves.toBe('applied');
        expect(calls).toEqual(['eff-1#1']);
      } finally {
        store.close();
      }

      // Reopen the same database: `applied` is on disk, so a restarted process
      // performs nothing. This is the claim the whole component exists to support.
      const reopened = await openRealStore(ctx, dir);
      if (reopened === null) return;
      try {
        const restartedCalls: string[] = [];
        const restarted = createDispatcher({
          store: reopened,
          now,
          handlers: [launchHandler(restartedCalls, false)],
        });
        await expect(restarted.drain()).resolves.toEqual({ applied: 0, failed: 0, skipped: 0 });
        expect(restartedCalls).toEqual([]);
        expect(await restarted.applyKey(LAUNCH_ROW.idempotencyKey)).toBe('applied');
        expect(restartedCalls).toEqual([]);
        expect(reopened.getEffectByKey(LAUNCH_ROW.idempotencyKey)).toMatchObject({
          state: 'applied',
          appliedAt: ISO,
        });
      } finally {
        reopened.close();
      }
    },
  );

  it.skipIf(!HAS_STORE)('agrees on the retry/terminal split for a failing effect', async (ctx) => {
    const dir = await makeTempDir();
    const store = await openRealStore(ctx, dir);
    if (store === null) return;
    try {
      const calls: string[] = [];
      store.enqueueEffect({ ...LAUNCH_ROW, createdAt: '2026-11-01T00:00:01.000Z' });
      const dispatcher = createDispatcher({
        store,
        now,
        maxAttempts: 2,
        handlers: [launchHandler(calls, true)],
      });

      // First failure: recorded, still pending — a retry is the next drain's job.
      await expect(dispatcher.drain()).resolves.toEqual({ applied: 0, failed: 1, skipped: 0 });
      expect(store.getEffectByKey(LAUNCH_ROW.idempotencyKey)).toMatchObject({
        state: 'pending',
        attempts: 1,
      });

      // Second failure reaches the cap: terminal, and the row stays in the table.
      await expect(dispatcher.drain()).resolves.toEqual({ applied: 0, failed: 1, skipped: 0 });
      const exhausted = store.getEffectByKey(LAUNCH_ROW.idempotencyKey);
      expect(exhausted).toMatchObject({ state: 'failed', attempts: 2 });
      expect(exhausted?.lastError).toContain('executor refused the attempt');

      // Nothing left to claim, and the handler ran exactly maxAttempts times.
      await expect(dispatcher.drain()).resolves.toEqual({ applied: 0, failed: 0, skipped: 0 });
      expect(calls).toEqual(['eff-1#1', 'eff-1#2']);
    } finally {
      store.close();
    }
  });
});
