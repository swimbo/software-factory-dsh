/**
 * Dispatcher behaviour, proved against an in-memory store.
 *
 * Every test here is one of the five rules in `dispatcher.ts` made falsifiable.
 * The store is faked on purpose: these tests are about the *dispatcher's*
 * decisions, and a database in the loop would hide which component made them
 * (the seam test `dispatcher.integration.test.ts` covers the real store).
 */
import { describe, expect, it } from 'vitest';
import { createDispatcher } from './dispatcher.ts';
import { createFakeEffectStore, type FakeEffectStore } from './fake-effect-store.ts';
import { defineEffectHandler, type EffectContext, type EffectHandler } from './handlers.ts';

/** A frozen clock: `appliedAt` must be a fact the test can pin, not a race. */
const FIXED_NOW = new Date('2026-11-01T00:00:00.000Z');
const now = (): Date => FIXED_NOW;
const ISO = FIXED_NOW.toISOString();

const DEFAULT_KIND = 'launch-attempt';

interface SeedRow {
  readonly effectId: string;
  readonly key: string;
  readonly kind?: string;
  readonly createdAt?: string;
  readonly payload?: unknown;
}

/** Enqueue rows with distinct creation times unless a test says otherwise. */
function seed(store: FakeEffectStore, rows: readonly SeedRow[]): void {
  rows.forEach((row, index) => {
    store.enqueueEffect({
      effectId: row.effectId,
      idempotencyKey: row.key,
      kind: row.kind ?? DEFAULT_KIND,
      payload: row.payload ?? { unitId: 'unit-1' },
      createdAt: row.createdAt ?? `2026-11-01T00:00:0${index + 1}.000Z`,
    });
  });
}

/**
 * A handler that records each invocation as `<effectId>#<attempt>`.
 * `failOn` decides per invocation whether to throw, so one handler can serve the
 * "middle effect fails" and "everything fails" cases.
 */
function attemptLogger(
  calls: string[],
  failOn: ((ctx: EffectContext) => boolean) | undefined = undefined,
): EffectHandler {
  return defineEffectHandler({
    kind: DEFAULT_KIND,
    run: async (_payload: unknown, ctx: EffectContext): Promise<void> => {
      calls.push(`${ctx.effectId}#${ctx.attempt}`);
      if (failOn !== undefined && failOn(ctx)) {
        throw new Error(`handler refused ${ctx.effectId}`);
      }
    },
  });
}

describe('effect outbox dispatcher', () => {
  // ---------------------------------------------------------------- rule 1
  it('invokes the handler once, records it applied, and never re-runs it', async () => {
    const store = createFakeEffectStore();
    const calls: string[] = [];
    seed(store, [{ effectId: 'eff-1', key: 'launch-attempt:unit-1' }]);
    const dispatcher = createDispatcher({ store, now, handlers: [attemptLogger(calls)] });

    await expect(dispatcher.drain()).resolves.toEqual({ applied: 1, failed: 0, skipped: 0 });

    expect(calls).toEqual(['eff-1#1']);
    expect(store.peek('launch-attempt:unit-1')).toMatchObject({
      state: 'applied',
      appliedAt: ISO,
      attempts: 0,
      lastError: null,
    });

    // Content-addressed: the ledger says applied, so a later drain is a no-op even
    // though the process is different and the clock has moved.
    await expect(dispatcher.drain()).resolves.toEqual({ applied: 0, failed: 0, skipped: 0 });
    expect(calls).toEqual(['eff-1#1']);
  });

  it('treats a second enqueue of the same idempotency key as one effect', async () => {
    const store = createFakeEffectStore();
    const calls: string[] = [];
    seed(store, [{ effectId: 'eff-1', key: 'launch-attempt:unit-1' }]);

    const duplicate = store.enqueueEffect({
      effectId: 'eff-2',
      idempotencyKey: 'launch-attempt:unit-1',
      kind: DEFAULT_KIND,
      payload: { unitId: 'unit-1' },
      createdAt: '2026-11-01T00:00:09.000Z',
    });

    expect(duplicate.effectId).toBe('eff-1');
    expect(store.rows()).toHaveLength(1);

    const dispatcher = createDispatcher({ store, now, handlers: [attemptLogger(calls)] });
    await expect(dispatcher.drain()).resolves.toEqual({ applied: 1, failed: 0, skipped: 0 });
    expect(calls).toEqual(['eff-1#1']);
  });

  // ---------------------------------------------------------- rules 2 and 3
  it('fails an unknown kind permanently, names it, and keeps the row', async () => {
    const store = createFakeEffectStore();
    const calls: string[] = [];
    seed(store, [{ effectId: 'eff-1', key: 'promote-change:unit-1', kind: 'promote-change' }]);
    const dispatcher = createDispatcher({ store, now, handlers: [attemptLogger(calls)] });

    await expect(dispatcher.drain()).resolves.toEqual({ applied: 0, failed: 1, skipped: 0 });

    expect(store.peek('promote-change:unit-1')).toMatchObject({ state: 'failed', attempts: 1 });
    expect(store.peek('promote-change:unit-1')?.lastError).toContain(
      'no handler registered for kind "promote-change"',
    );
    // Never dropped: the row is the evidence that a producer asked for something
    // no handler serves.
    expect(store.rows()).toHaveLength(1);
    expect(calls).toEqual([]);

    // Terminal — a wiring bug is not worth retrying, and re-reporting it every
    // drain would make the summary useless.
    await expect(dispatcher.drain()).resolves.toEqual({ applied: 0, failed: 0, skipped: 0 });
  });

  it('never re-runs or re-reports an effect already marked failed', async () => {
    const store = createFakeEffectStore();
    const calls: string[] = [];
    // An unknown kind is exhausted at attempts = 1, far below the cap, so `attempts`
    // alone would look retryable. Only `state` makes it terminal — and a store that
    // leaks terminal rows into a claim must not be able to resurrect it.
    store.setClaimableStates(['pending', 'failed']);
    seed(store, [{ effectId: 'eff-1', key: 'promote-change:unit-1', kind: 'promote-change' }]);
    const dispatcher = createDispatcher({ store, now, handlers: [attemptLogger(calls)] });

    await expect(dispatcher.drain()).resolves.toEqual({ applied: 0, failed: 1, skipped: 0 });
    await expect(dispatcher.drain()).resolves.toEqual({ applied: 0, failed: 0, skipped: 1 });

    expect(calls).toEqual([]);
    expect(store.peek('promote-change:unit-1')).toMatchObject({ state: 'failed', attempts: 1 });
  });

  it('continues past a throwing handler and records the attempt', async () => {
    const store = createFakeEffectStore();
    const calls: string[] = [];
    seed(store, [
      { effectId: 'eff-1', key: 'k1', createdAt: '2026-11-01T00:00:01.000Z' },
      { effectId: 'eff-2', key: 'k2', createdAt: '2026-11-01T00:00:02.000Z' },
      { effectId: 'eff-3', key: 'k3', createdAt: '2026-11-01T00:00:03.000Z' },
    ]);
    const dispatcher = createDispatcher({
      store,
      now,
      handlers: [attemptLogger(calls, (ctx) => ctx.effectId === 'eff-2')],
    });

    await expect(dispatcher.drain()).resolves.toEqual({ applied: 2, failed: 1, skipped: 0 });

    // One bad effect did not stall the queue, and order was preserved.
    expect(calls).toEqual(['eff-1#1', 'eff-2#1', 'eff-3#1']);
    expect(store.peek('k1')).toMatchObject({ state: 'applied' });
    expect(store.peek('k3')).toMatchObject({ state: 'applied' });

    const failed = store.peek('k2');
    expect(failed).toMatchObject({ state: 'pending', attempts: 1 });
    expect(failed?.lastError).toContain('handler refused eff-2');
    // The useful half of a stack: the first frame, not the boilerplate first line.
    expect(failed?.lastError).toContain('at ');
  });

  it('stops at exactly maxAttempts invocations and leaves a permanent failure', async () => {
    const store = createFakeEffectStore();
    const calls: string[] = [];
    const logLines: string[] = [];
    seed(store, [{ effectId: 'eff-1', key: 'k1' }]);
    const dispatcher = createDispatcher({
      store,
      now,
      maxAttempts: 3,
      log: (line) => logLines.push(line),
      handlers: [attemptLogger(calls, () => true)],
    });

    const summaries = [];
    for (let index = 0; index < 5; index += 1) {
      summaries.push(await dispatcher.drain());
    }

    // Exactly maxAttempts — the count an auditor checks. 1-based, one per drain.
    expect(calls).toEqual(['eff-1#1', 'eff-1#2', 'eff-1#3']);
    expect(summaries.map((summary) => summary.failed)).toEqual([1, 1, 1, 0, 0]);
    expect(summaries.map((summary) => summary.applied)).toEqual([0, 0, 0, 0, 0]);

    expect(store.peek('k1')).toMatchObject({ state: 'failed', attempts: 3 });
    expect(store.rows()).toHaveLength(1);
    expect(logLines.some((line) => line.includes('failed permanently after 3/3'))).toBe(true);
  });

  it('records a permanent failure for a row whose recorded attempts already meet the cap', async () => {
    const store = createFakeEffectStore();
    const calls: string[] = [];
    seed(store, [{ effectId: 'eff-1', key: 'k1' }]);
    // Reachable when maxAttempts is lowered between deploys (here 5 → 3), when a
    // store write partially applied, or when a hand-fixed ledger is replayed. The
    // row is still pending, but its attempt budget is already spent.
    store.patch('k1', {
      state: 'pending',
      attempts: 4,
      lastError: 'Error: handler refused eff-1 (at run)',
    });
    const dispatcher = createDispatcher({
      store,
      now,
      maxAttempts: 3,
      handlers: [attemptLogger(calls, () => true)],
    });

    await expect(dispatcher.drain()).resolves.toEqual({ applied: 0, failed: 1, skipped: 0 });

    // No fifth invocation: the cap is a cap, not a suggestion. `attempts` becomes 5
    // because the terminal write is itself recorded as an attempt.
    expect(calls).toEqual([]);
    expect(store.peek('k1')).toMatchObject({ state: 'failed', attempts: 5 });
    expect(store.rows()).toHaveLength(1);
  });

  // ---------------------------------------------------------------- rule 5
  it('keeps no hidden state: a second dispatcher over the same store does not re-run', async () => {
    const store = createFakeEffectStore();
    const firstCalls: string[] = [];
    const secondCalls: string[] = [];
    seed(store, [{ effectId: 'eff-1', key: 'k1' }]);

    const first = createDispatcher({ store, now, handlers: [attemptLogger(firstCalls)] });
    await expect(first.drain()).resolves.toEqual({ applied: 1, failed: 0, skipped: 0 });

    const second = createDispatcher({ store, now, handlers: [attemptLogger(secondCalls)] });
    await expect(second.drain()).resolves.toEqual({ applied: 0, failed: 0, skipped: 0 });
    // Rule 1 through the second entry point: already applied, so `applied` — and
    // the handler is not invoked.
    await expect(second.applyKey('k1')).resolves.toBe('applied');
    expect(secondCalls).toEqual([]);

    // And the second dispatcher is not a stale cache of "nothing to do": work that
    // arrives after it was created is applied normally.
    seed(store, [{ effectId: 'eff-2', key: 'k2', createdAt: '2026-11-01T00:00:20.000Z' }]);
    await expect(second.drain()).resolves.toEqual({ applied: 1, failed: 0, skipped: 0 });
    expect(secondCalls).toEqual(['eff-2#1']);
  });

  // ---------------------------------------------------------------- rule 6
  it('invokes effects oldest-first', async () => {
    const store = createFakeEffectStore();
    const calls: string[] = [];
    seed(store, [
      { effectId: 'eff-c', key: 'kc', createdAt: '2026-11-01T00:00:03.000Z' },
      { effectId: 'eff-a', key: 'ka', createdAt: '2026-11-01T00:00:01.000Z' },
      { effectId: 'eff-b', key: 'kb', createdAt: '2026-11-01T00:00:02.000Z' },
    ]);
    const dispatcher = createDispatcher({ store, now, handlers: [attemptLogger(calls)] });

    await dispatcher.drain();

    expect(calls).toEqual(['eff-a#1', 'eff-b#1', 'eff-c#1']);
  });

  it('breaks created_at ties by effectId, not by insertion order', async () => {
    const store = createFakeEffectStore();
    const calls: string[] = [];
    const sameInstant = '2026-11-01T00:00:01.000Z';
    seed(store, [
      { effectId: 'eff-zulu', key: 'kz', createdAt: sameInstant },
      { effectId: 'eff-alpha', key: 'ka', createdAt: sameInstant },
      { effectId: 'eff-mike', key: 'km', createdAt: sameInstant },
    ]);
    const dispatcher = createDispatcher({ store, now, handlers: [attemptLogger(calls)] });

    await dispatcher.drain();

    expect(calls).toEqual(['eff-alpha#1', 'eff-mike#1', 'eff-zulu#1']);
  });

  it('sorts a claim page the store returned out of order', async () => {
    const store = createFakeEffectStore();
    const calls: string[] = [];
    seed(store, [
      { effectId: 'eff-a', key: 'ka', createdAt: '2026-11-01T00:00:01.000Z' },
      { effectId: 'eff-b', key: 'kb', createdAt: '2026-11-01T00:00:02.000Z' },
      { effectId: 'eff-c', key: 'kc', createdAt: '2026-11-01T00:00:03.000Z' },
    ]);
    // A store that hands back newest-first must not be able to reorder the drain.
    store.setClaimOrder(['eff-c', 'eff-b', 'eff-a']);
    const dispatcher = createDispatcher({ store, now, handlers: [attemptLogger(calls)] });

    await dispatcher.drain();

    expect(calls).toEqual(['eff-a#1', 'eff-b#1', 'eff-c#1']);
  });

  // ------------------------------------------------------------- applyKey
  it('applyKey returns missing for an unknown key and throws nothing', async () => {
    const store = createFakeEffectStore();
    const calls: string[] = [];
    const dispatcher = createDispatcher({ store, now, handlers: [attemptLogger(calls)] });

    await expect(dispatcher.applyKey('launch-attempt:never-enqueued')).resolves.toBe('missing');
    expect(calls).toEqual([]);
  });

  it('applyKey applies one pending effect by idempotency key', async () => {
    const store = createFakeEffectStore();
    const calls: string[] = [];
    seed(store, [
      { effectId: 'eff-1', key: 'k1' },
      { effectId: 'eff-2', key: 'k2', createdAt: '2026-11-01T00:00:05.000Z' },
    ]);
    const dispatcher = createDispatcher({ store, now, handlers: [attemptLogger(calls)] });

    await expect(dispatcher.applyKey('k2')).resolves.toBe('applied');

    // Only the named effect ran; the other is still pending for the next drain.
    expect(calls).toEqual(['eff-2#1']);
    expect(store.peek('k1')).toMatchObject({ state: 'pending', attempts: 0 });
    expect(store.peek('k2')).toMatchObject({ state: 'applied', appliedAt: ISO });
  });

  it('applyKey reports a permanent failure as failed and leaves the row', async () => {
    const store = createFakeEffectStore();
    const calls: string[] = [];
    seed(store, [{ effectId: 'eff-1', key: 'k1' }]);
    const dispatcher = createDispatcher({
      store,
      now,
      maxAttempts: 1,
      handlers: [attemptLogger(calls, () => true)],
    });

    await expect(dispatcher.applyKey('k1')).resolves.toBe('failed');

    expect(calls).toEqual(['eff-1#1']);
    expect(store.peek('k1')).toMatchObject({ state: 'failed', attempts: 1 });
    expect(store.rows()).toHaveLength(1);
  });

  it('applyKey reports a permanently failed effect as failed, not applied', async () => {
    const store = createFakeEffectStore();
    const calls: string[] = [];
    seed(store, [{ effectId: 'eff-1', key: 'k1', kind: 'promote-change' }]);
    const dispatcher = createDispatcher({ store, now, handlers: [attemptLogger(calls)] });

    // Unknown kind → terminal on the first drain.
    await expect(dispatcher.drain()).resolves.toEqual({ applied: 0, failed: 1, skipped: 0 });
    expect(store.peek('k1')).toMatchObject({ state: 'failed' });

    // Manual recovery asking about a dead effect must be told the truth.
    await expect(dispatcher.applyKey('k1')).resolves.toBe('failed');
    expect(calls).toEqual([]);
  });

  // ------------------------------------------------------- construction guards
  it('refuses to start when two handlers claim one kind', () => {
    const store = createFakeEffectStore();
    expect(() =>
      createDispatcher({
        store,
        now,
        handlers: [
          attemptLogger([]),
          defineEffectHandler({ kind: DEFAULT_KIND, run: async () => {} }),
        ],
      }),
    ).toThrow(/duplicate handler for kind "launch-attempt"/);
  });

  it('refuses a maxAttempts below one', () => {
    const store = createFakeEffectStore();
    expect(() => createDispatcher({ store, now, maxAttempts: 0, handlers: [] })).toThrow(
      /maxAttempts must be an integer >= 1/,
    );
    expect(() => createDispatcher({ store, now, maxAttempts: 1.5, handlers: [] })).toThrow(
      /maxAttempts must be an integer >= 1/,
    );
  });

  it('defaults to three attempts', async () => {
    const store = createFakeEffectStore();
    const calls: string[] = [];
    seed(store, [{ effectId: 'eff-1', key: 'k1' }]);
    const dispatcher = createDispatcher({
      store,
      now,
      handlers: [attemptLogger(calls, () => true)],
    });

    for (let index = 0; index < 4; index += 1) {
      await dispatcher.drain();
    }

    expect(calls).toHaveLength(3);
    expect(store.peek('k1')).toMatchObject({ state: 'failed', attempts: 3 });
  });
});
