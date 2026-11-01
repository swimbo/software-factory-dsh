/**
 * The outbox: an intent to launch that is written, settled, and — when nothing started —
 * performed later by exactly one retry.
 *
 * `engine.runUnit` commits the intent as an `effects` row and deliberately does not launch
 * from inside the call. That design only holds if the row is settled, and the CLI was not
 * settling it: every run left a permanently `pending` row, `recover` had nothing to
 * retry, and `status` reported the leak the CLI itself created. These four specs are the
 * whole life of that row:
 *
 *   - **settled** — a successful `run` leaves `claimPendingEffects(1000)` empty (a pending
 *     effect after a run is a launch the ledger says never happened);
 *   - **retryable, once** — a refusal caused by the environment (here: a mirror that
 *     cannot check out the base revision) leaves the effect `pending` with `attempts = 1`,
 *     and `recover` performs it **exactly once** after the lease expires;
 *   - **not twice** — a successful `run` followed by `recover` performs no launch at all:
 *     the effect is `applied`, so there is nothing to retry;
 *   - **observable** — `status` counts the pending effect instead of claiming the store
 *     cannot count, and the count returns to zero once `recover` performs it.
 *
 * The lease is the guard throughout: while the attempt's lease is live, `recover` may not
 * launch (a process might own the attempt), and the specs assert that refusal explicitly
 * rather than assuming it.
 */
import { execFileSync } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { jsonOf, runFactory } from '../../harness/factory.ts';
import { openStore } from '../../../packages/store/src/index.ts';
import { createWallFixture, type WallFixture } from '../../harness/wall-fixture.ts';

let fixture: WallFixture;

beforeEach(() => {
  fixture = createWallFixture();
});

afterEach(() => {
  fixture.cleanup();
});

/** A valid git repository that does not contain the unit's base revision. */
function mirrorWithoutBase(): string {
  const path = mkdtempSync(join(tmpdir(), 'factory-empty-mirror-'));
  execFileSync('git', ['init', '--quiet', path], { stdio: 'ignore' });
  return path;
}

/** Age every lease, which is what "that process is gone" looks like to `recover`. */
function ageLeases(): void {
  const db = new DatabaseSync(join(fixture.home, 'state', 'factory.db'));
  try {
    db.exec("UPDATE leases SET expires_at = '2020-01-01T00:00:00.000Z'");
  } finally {
    db.close();
  }
}

function withStore<T>(read: (store: ReturnType<typeof openStore>) => T): T {
  const store = openStore({ dir: join(fixture.home, 'state') });
  try {
    return read(store);
  } finally {
    store.close();
  }
}

function recover(env: Record<string, string> = {}): ReturnType<typeof runFactory> {
  return runFactory(['recover', '--json'], {
    home: fixture.home,
    env: fixture.wallEnv({ FACTORY_SCENARIO: fixture.scenarioPath, ...env }),
    timeoutMs: 120_000,
  });
}

describe('a successful run settles its launch effect', () => {
  it('[@default] leaves nothing pending in the outbox', () => {
    const unitId = fixture.submit();
    const run = fixture.run(unitId);
    expect(run.code, `${run.stdout}\n${run.stderr}`).toBe(0);

    const attemptId = String(jsonOf(run)['attemptId']);
    withStore((store) => {
      // The assertion the audit asked for, literally: nothing is left for a drain.
      expect(store.claimPendingEffects(1000)).toEqual([]);
      // And the row is not missing — it is settled, with a time, which is what makes the
      // outbox a record rather than a queue that forgot.
      const attempt = store.getAttempt(attemptId);
      const effect = store.getEffectByKey(String(attempt?.launchKey));
      expect(effect?.state).toBe('applied');
      expect(effect?.appliedAt).not.toBeNull();
      expect(effect?.lastError).toBeNull();
    });
  });
});

describe('a launch refusal leaves the effect retryable, and recover performs it once', () => {
  it('[@default] retries after the lease expires, exactly once', () => {
    const unitId = fixture.submit();
    const broken = mirrorWithoutBase();

    const run = fixture.run(unitId, [], fixture.wallEnv({ FACTORY_PRISTINE_REPO: broken }));
    expect(run.code, `${run.stdout}\n${run.stderr}`).toBe(8);
    const json = jsonOf(run);
    expect(json['code']).toBe('EXECUTOR_UNAVAILABLE');
    // The refusal says it is retryable. The failure payload is the five-part §5.2 shape
    // (code, message, exitCode, traceId) with no free-form detail bag, so the settlement is
    // named in the message where an operator reads it; the store is the authority below.
    expect(String(json['message'])).toContain('retryable');
    expect(String(json['message'])).toContain('factory recover');

    // A refusal is a five-part failure payload, so the ids come from the store — which is
    // also the honest place to check them, since the store is what `recover` will read.
    const { attemptId, effectId } = withStore((store) => {
      const attempt = store.listAttemptsForUnit(unitId)[0];
      if (attempt === undefined) throw new Error('the refusal left no attempt row');
      const effect = store.getEffectByKey(attempt.launchKey);
      if (effect === null) throw new Error('the refusal left no effect row');
      return { attemptId: attempt.attemptId, effectId: effect.effectId };
    });
    expect(String(json['message'])).toContain(attemptId);
    expect(String(json['message'])).toContain(effectId);
    withStore((store) => {
      const effect = store.getEffectByKey(String(store.getAttempt(attemptId)?.launchKey));
      // Still pending — a `failed` effect would be a launch nobody can ever perform again.
      expect(effect?.state).toBe('pending');
      expect(effect?.attempts).toBe(1);
      expect(String(effect?.lastError)).toContain('EXECUTOR_UNAVAILABLE');
    });

    // A live lease is the double-launch guard: `recover` must not launch yet.
    const early = recover({ FACTORY_PRISTINE_REPO: fixture.mirror });
    expect(early.code, `${early.stdout}\n${early.stderr}`).toBe(0);
    expect(jsonOf(early)['relaunched']).toEqual([]);
    expect(jsonOf(early)['launchDeferred']).toEqual([effectId]);
    withStore((store) => {
      expect(store.latestReceiptForUnit(unitId)).toBeNull();
      expect(store.getEffectByKey(String(store.getAttempt(attemptId)?.launchKey))?.state).toBe(
        'pending',
      );
    });

    // The lease expires; now the launch is performable, and it happens once.
    ageLeases();
    const retried = recover({ FACTORY_PRISTINE_REPO: fixture.mirror });
    expect(retried.code, `${retried.stdout}\n${retried.stderr}`).toBe(0);
    expect(jsonOf(retried)['relaunched']).toEqual([effectId]);

    withStore((store) => {
      const effect = store.getEffectByKey(String(store.getAttempt(attemptId)?.launchKey));
      expect(effect?.state).toBe('applied');
      // One failure was recorded, and it is still on the row: the retry did not erase the
      // fact that the first attempt was refused.
      expect(effect?.attempts).toBe(1);
      expect(store.latestReceiptForUnit(unitId)).not.toBeNull();
      // One attempt, one receipt: the retry performed the *same* intent.
      expect(store.listAttemptsForUnit(unitId)).toHaveLength(1);
    });

    // And it is not retried a second time, ever: nothing is pending, so nothing is due.
    const again = recover({ FACTORY_PRISTINE_REPO: fixture.mirror });
    expect(again.code, `${again.stdout}\n${again.stderr}`).toBe(0);
    expect(jsonOf(again)['relaunched']).toEqual([]);
    withStore((store) => {
      expect(store.claimPendingEffects(1000)).toEqual([]);
      expect(store.listAttemptsForUnit(unitId)).toHaveLength(1);
      expect(store.latestReceiptForUnit(unitId)?.attemptId).toBe(attemptId);
    });
  });
});

describe('a successful run is not launched again by recover', () => {
  it('[@default] leaves recover with nothing to do', () => {
    const unitId = fixture.submit();
    const run = fixture.run(unitId);
    expect(run.code, `${run.stdout}\n${run.stderr}`).toBe(0);

    const before = withStore((store) => ({
      attempts: store.listAttemptsForUnit(unitId).length,
      receipt: store.latestReceiptForUnit(unitId)?.receiptId ?? null,
      appliedAt: store.getEffectByKey(
        String(store.getAttempt(String(jsonOf(run)['attemptId']))?.launchKey),
      )?.appliedAt,
    }));

    const recovery = recover();
    expect(recovery.code, `${recovery.stdout}\n${recovery.stderr}`).toBe(0);
    expect(jsonOf(recovery)['relaunched']).toEqual([]);

    const after = withStore((store) => ({
      attempts: store.listAttemptsForUnit(unitId).length,
      receipt: store.latestReceiptForUnit(unitId)?.receiptId ?? null,
      appliedAt: store.getEffectByKey(
        String(store.getAttempt(String(jsonOf(run)['attemptId']))?.launchKey),
      )?.appliedAt,
    }));
    expect(after).toEqual(before);
  });
});

describe('status reports the outbox instead of disclaiming it', () => {
  it('[@default] counts the pending effect left by an interrupted run, then counts zero', () => {
    const unitId = fixture.submit();
    // An interrupted run: dispatch committed, the launch deferred, nothing performed.
    const interrupted = fixture.run(unitId, ['--no-wait']);
    expect(interrupted.code, `${interrupted.stdout}\n${interrupted.stderr}`).toBe(0);
    const effectId = String(jsonOf(interrupted)['effectId']);

    const status = runFactory(['status', '--json'], {
      home: fixture.home,
      env: fixture.wallEnv({ FACTORY_SCENARIO: fixture.scenarioPath }),
    });
    const outbox = (jsonOf(status)['health'] ?? {}) as { outbox?: Record<string, unknown> };
    // The number, not a disclaimer: the store exposes a read-only pending count.
    expect(outbox.outbox?.['pending']).toBe(1);
    expect(outbox.outbox?.['retrying']).toBe(0);
    // `dead` is the one value that is genuinely unreadable: there is no public read for
    // exhausted effects, and 0 would be a measurement nobody took (L3).
    expect(outbox.outbox?.['dead']).toBeNull();
    expect(outbox.outbox?.['state']).toBe('degraded');

    ageLeases();
    const recovery = recover({ FACTORY_PRISTINE_REPO: fixture.mirror });
    expect(recovery.code, `${recovery.stdout}\n${recovery.stderr}`).toBe(0);
    expect(jsonOf(recovery)['relaunched']).toEqual([effectId]);

    const settled = runFactory(['status', '--json'], {
      home: fixture.home,
      env: fixture.wallEnv({ FACTORY_SCENARIO: fixture.scenarioPath }),
    });
    const settledOutbox = (jsonOf(settled)['health'] ?? {}) as {
      outbox?: Record<string, unknown>;
    };
    expect(settledOutbox.outbox?.['pending']).toBe(0);
    expect(settledOutbox.outbox?.['state']).toBe('ok');
  });
});
