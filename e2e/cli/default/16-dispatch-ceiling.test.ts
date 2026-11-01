/**
 * The dispatch ceiling (IN #5, GAP-004): a refusal, not a queue.
 *
 * Every spec here is about a factory that looks free while it is busy, or looks busy while
 * it is free — the two ways a ceiling goes wrong. The dangerous direction is the second: a
 * ceiling that counts an `ambiguous` attempt stops the factory until a person reconciles, so
 * a single `kill -9` becomes a factory that never dispatches again. That is the failure mode
 * these specs exist to prevent, and it is asserted rather than reasoned about.
 *
 * The store is read directly after each refusal, because "refused" is a claim about what did
 * *not* happen: no attempt row for the unit, no lease, no reservation, no outbox effect.
 */
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { jsonOf, runFactory } from '../../harness/factory.ts';
import { openStore, type Store } from '../../../packages/store/src/index.ts';
import { createWallFixture, type WallFixture } from '../../harness/wall-fixture.ts';

let fixture: WallFixture;
let store: Store;
/**
 * Distinct units need distinct revisions: the fixture's base spec is `slug: TASK_CLASS,
 * revision: 1`, and a second identical spec is the *same* unit (the store deduplicates by
 * spec hash) — which would turn every "second run" in this file into a lease conflict on the
 * first unit instead of the ceiling refusal under test.
 */
let revision = 1;
function submitUnit(): string {
  revision += 1;
  return fixture.submit({ revision });
}

beforeEach(() => {
  fixture = createWallFixture();
  // `state/` is where the CLI puts the store for a given `FACTORY_HOME`; opening it by hand
  // lets a spec seed another controller's attempt without racing a real one into existence.
  store = openStore({ dir: join(fixture.home, 'state') });
});

afterEach(() => {
  store.close();
  fixture.cleanup();
});

/**
 * Seed an attempt in a chosen state, as another controller's dispatch would have left it.
 *
 * The attempt row has a foreign key on its lease, so the lease comes first — and it stays
 * *live* only for the states in which a controller may still be running. An `ambiguous`
 * attempt's lease has been released (`recover` does that when it reconciles), which is what
 * makes the crashed unit free; a `produced-receipt` attempt's lease is released too, because
 * the worker is done and only the wall is left.
 */
function seedAttempt(
  unitId: string,
  state: 'launching' | 'running' | 'produced-receipt' | 'ambiguous',
): string {
  const attemptId = `A-seeded-${unitId}`;
  const leaseId = `L-seeded-${unitId}`;
  store.acquireLease({
    leaseId,
    unitId,
    owner: 'other-controller',
    acquiredAt: '2026-11-01T12:00:00.000Z',
    expiresAt: '2026-11-01T12:45:00.000Z',
  });
  store.insertAttempt({
    attemptId,
    unitId,
    leaseId,
    state,
    launchKey: `launch-${attemptId}`,
    sessionId: null,
    attemptDir: join(fixture.home, 'attempts', attemptId),
    startedAt: '2026-11-01T12:00:00.000Z',
    endedAt: state === 'ambiguous' ? '2026-11-01T12:05:00.000Z' : null,
    exitCode: null,
  });
  if (state === 'ambiguous' || state === 'produced-receipt') {
    store.releaseLease(leaseId, '2026-11-01T12:06:00.000Z');
  }
  return attemptId;
}

/** An attempt that may still be running, with its lease still held: one occupied slot. */
function holdLease(unitId: string): void {
  seedAttempt(unitId, 'running');
}

function attemptsFor(unitId: string): number {
  return store.listAttemptsForUnit(unitId).length;
}

function pendingEffects(): number {
  return store.claimPendingEffects(100).length;
}

describe('the attempt ceiling refuses before the transaction', () => {
  it('[@default] refuses a second run with exit 7, names the ceiling, and touches nothing', () => {
    const busy = submitUnit();
    holdLease(busy);
    const second = submitUnit();

    const run = fixture.run(second);
    const json = jsonOf(run);

    expect(run.code, `${run.stdout}\n${run.stderr}`).toBe(7);
    expect(json['code']).toBe('CONCURRENCY_LIMIT');
    const message = String(json['message']);
    expect(message).toContain('1 attempt(s) in flight');
    expect(message).toContain('ceiling is 1');
    // A-2: the number an operator did not set is labelled as the default, not as an envelope.
    expect(message).toContain('documented default');
    expect(message).toContain('FACTORY_MAX_CONCURRENT_ATTEMPTS');

    // "Nothing was dispatched" is a claim about the store, so the store is what is read.
    expect(attemptsFor(second), 'no attempt row for the refused unit').toBe(0);
    expect(store.getLiveLease(second), 'no lease for the refused unit').toBeNull();
    expect(pendingEffects(), 'no outbox effect was enqueued').toBe(0);
    expect(existsSync(join(fixture.home, 'attempts', second)), 'no attempt directory').toBe(false);
  });

  it('counts a --no-wait attempt as in flight', () => {
    const deferred = submitUnit();
    const first = fixture.run(deferred, ['--no-wait']);
    expect(first.code, `${first.stdout}\n${first.stderr}`).toBe(0);
    // The deferred attempt exists and is in flight: `--no-wait` returns the attempt, it does
    // not release the slot.
    expect(attemptsFor(deferred)).toBe(1);
    const state = store.listAttemptsForUnit(deferred)[0]?.state;
    expect(['launching', 'running']).toContain(state);

    const second = submitUnit();
    const run = fixture.run(second);
    expect(run.code).toBe(7);
    expect(jsonOf(run)['code']).toBe('CONCURRENCY_LIMIT');
    expect(attemptsFor(second)).toBe(0);
  });

  it('does not let an ambiguous attempt block the factory forever', () => {
    // The failure mode that would make the ceiling dangerous: one crash, and nothing ever
    // dispatches again. `ambiguous` is the state a crashed attempt leaves, so it is not in
    // flight — reconciliation is `recover`'s job, not a counter's.
    const crashed = submitUnit();
    seedAttempt(crashed, 'ambiguous');
    const next = submitUnit();

    const run = fixture.run(next);
    expect(run.code, `${run.stdout}\n${run.stderr}`).not.toBe(7);
    expect(attemptsFor(next), 'the free slot was used').toBe(1);
  });

  it('lets the next run proceed when the operator raises the ceiling', () => {
    const busy = submitUnit();
    holdLease(busy);
    const second = submitUnit();

    const refused = fixture.run(second);
    expect(refused.code).toBe(7);

    const raised = fixture.run(second, [], {
      ...fixture.wallEnv(),
      FACTORY_MAX_CONCURRENT_ATTEMPTS: '2',
    });
    expect(raised.code, `${raised.stdout}\n${raised.stderr}`).not.toBe(7);
    expect(attemptsFor(second)).toBe(1);
  });

  it('drops the occupancy once a verdict is recorded', () => {
    const first = submitUnit();
    const run = fixture.run(first);
    expect(run.code, `${run.stdout}\n${run.stderr}`).toBe(0);

    const next = submitUnit();
    const second = fixture.run(next);
    expect(second.code, `${second.stdout}\n${second.stderr}`).not.toBe(7);
    expect(attemptsFor(next)).toBe(1);
  });
});

describe('the wall ceiling refuses rather than queues', () => {
  it('refuses a second wall run while one is measuring', () => {
    const measuring = submitUnit();
    seedAttempt(measuring, 'produced-receipt');
    const second = submitUnit();

    const run = fixture.run(second);
    const json = jsonOf(run);
    expect(run.code, `${run.stdout}\n${run.stderr}`).toBe(7);
    expect(json['code']).toBe('CONCURRENCY_LIMIT');
    const message = String(json['message']);
    expect(message).toContain('wall run(s) in flight');
    expect(message).toContain('FACTORY_MAX_CONCURRENT_WALLS');
    // The attempt ran and the receipt exists — the refusal is at the wall, which is where a
    // wall run would start, so there is no verdict to mistake for a measurement.
    expect(attemptsFor(second)).toBe(1);
    expect(store.latestVerdictForUnit(second)).toBeNull();
  });

  it('measures when the wall ceiling is raised', () => {
    const measuring = submitUnit();
    seedAttempt(measuring, 'produced-receipt');
    const second = submitUnit();

    const run = fixture.run(second, [], {
      ...fixture.wallEnv(),
      FACTORY_MAX_CONCURRENT_WALLS: '2',
    });
    expect(run.code, `${run.stdout}\n${run.stderr}`).not.toBe(7);
    expect(attemptsFor(second)).toBe(1);
  });
});

describe('status reports the ceilings and the occupancy', () => {
  it('[@default] publishes limit, inFlight and the default label', () => {
    const busy = submitUnit();
    holdLease(busy);

    const status = runFactory(['status', '--json'], { home: fixture.home, env: fixture.wallEnv() });
    expect(status.code, `${status.stdout}\n${status.stderr}`).toBe(0);
    const json = jsonOf(status);
    const concurrency = json['concurrency'] as Record<string, Record<string, unknown>>;
    expect(concurrency['attempts']?.['limit']).toBe(1);
    expect(concurrency['attempts']?.['inFlight']).toBe(1);
    expect(concurrency['attempts']?.['limitIsDefault']).toBe(true);
    expect(concurrency['attempts']?.['state']).toBe('at-ceiling');
    expect(concurrency['walls']?.['limit']).toBe(1);
    expect(concurrency['walls']?.['inFlight']).toBe(0);
  });
});
