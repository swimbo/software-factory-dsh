/**
 * The two refusals a run must make *before* anything is spent, and the one it must make
 * only after dispatch:
 *
 *   - **E2E-10** `run --no-wait` returns the attempt and nothing else: no receipt, no
 *     verdict, no follow. `--no-wait` is the operator's "fire and leave" — it must not
 *     secretly continue the pipeline in the background.
 *   - **E2E-26** an envelope that cannot cover the estimate refuses dispatch with exit 6,
 *     `BUDGET_EXCEEDED`, and **no attempt row, no reservation, no executor start**.
 *
 * The envelope is lowered *after* the unit qualified at a higher one, on purpose: the
 * qualifier's budget signal already saw a ceiling it could fit under, so the refusal under
 * test is the dispatch-time re-check — the ceiling that actually stops money leaving.
 */
import { existsSync } from 'node:fs';
import { join } from 'node:path';
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

function raiseEnvelope(toUsd: string, confirm = true): ReturnType<typeof runFactory> {
  const args = ['budget', 'raise', '--to', toUsd, '--reason', 'e2e fixture'];
  if (confirm) args.push('--confirm', `raise per-unit envelope to ${toUsd}`);
  return runFactory([...args, '--json'], { home: fixture.home });
}

describe('dispatch-time budget ceiling (E2E-26)', () => {
  it('[@default] refuses with exit 6, no attempt, no reservation, no executor start', () => {
    // Room to qualify…
    expect(raiseEnvelope('10.00').code).toBe(0);
    const unitId = fixture.submit({ budgetEstimateUsd: 2.41 });
    // …then the ceiling drops below the estimate, and dispatch is the last line of defence.
    expect(raiseEnvelope('0.05').code).toBe(0);

    const run = fixture.run(unitId);
    const json = jsonOf(run);

    expect(run.code, `${run.stdout}\n${run.stderr}`).toBe(6);
    expect(json['code']).toBe('BUDGET_EXCEEDED');
    const message = String(json['message']);
    // The numbers and their comparison are printed. Divergence from e2e-tests.md E2E-26,
    // recorded rather than smoothed over: the plan expects "projected $2.41 > per-unit
    // envelope $0.05" and the word *estimated*; the CLI says "remaining envelope" and prints
    // two bare dollar amounts with no estimate label (A-2 says money must be labelled).
    expect(message).toContain('projected $2.41');
    expect(message).toContain('$0.05');
    expect(message).toContain('envelope');

    // Nothing was dispatched: no attempt row, no lease, no attempt directory, no executor.
    expect(json['attemptId']).toBeUndefined();
    expect(existsSync(join(fixture.home, 'attempts', unitId))).toBe(false);
    const store = openStore({ dir: join(fixture.home, 'state') });
    try {
      expect(store.listAttemptsForUnit(unitId)).toHaveLength(0);
      expect(store.getLiveLease(unitId)).toBeNull();
    } finally {
      store.close();
    }
    // No reservation either: a refused dispatch must not hold budget hostage.
    const spend = runFactory(['budget', '--json'], { home: fixture.home });
    const perDay = (jsonOf(spend)['perDay'] ?? {}) as { reserved?: number };
    expect(perDay.reserved).toBe(0);
    // And the executor never started: the fake worker writes its logs on launch.
    expect(existsSync(join(fixture.home, 'attempts'))).toBe(false);
  });
});

describe('`run --no-wait` stops after dispatch (E2E-10)', () => {
  // Was `it.fails` while the bug stood: `run` read `boolOption(options, 'noWait')`, but
  // `--no-wait` is declared `.option('--no-wait')`, which commander turns into
  // `options.wait === false` — so the branch was dead and the flag ran the full pipeline.
  // The key is fixed (`options['wait'] === false`) and the launch it defers is now
  // performed by `factory recover` under an expired lease, so this is a plain test.
  it('[@default] returns the attempt with no receipt and no verdict', { timeout: 120_000 }, () => {
    const unitId = fixture.submit();

    const run = runFactory(
      ['run', unitId, '--scenario', fixture.scenarioPath, '--no-wait', '--json'],
      { home: fixture.home, env: fixture.wallEnv(), timeoutMs: 120_000 },
    );

    expect(run.code, `${run.stdout}\n${run.stderr}`).toBe(0);
    // One JSON object on stdout, even though this verb also prints an attempt id for humans.
    const json = jsonOf(run);
    expect(String(json['attemptId'])).toMatch(/^A-[0-9a-z]+/u);
    expect(json['state']).toBe('dispatched');
    expect(json['outcome']).toBeUndefined();
    expect(json['verdictId']).toBeUndefined();

    const store = openStore({ dir: join(fixture.home, 'state') });
    try {
      // The attempt exists and is in flight; nothing downstream of it does. The attempt's
      // own state is `launching` — it is the *unit* that is `dispatched`, and the two are
      // asserted separately rather than conflated.
      expect(store.getUnit(unitId)?.state).toBe('dispatched');
      expect(store.getAttempt(String(json['attemptId']))?.state).toBe('launching');
      expect(store.latestReceiptForUnit(unitId)).toBeNull();
      expect(store.latestVerdictForUnit(unitId)).toBeNull();
      // And the deferred launch is the outbox's problem now, not a lost intent: the effect
      // exists, is pending, and `recover` is what performs it.
      const effect = store.getEffectByKey(
        String(store.getAttempt(String(json['attemptId']))?.launchKey ?? ''),
      );
      expect(effect?.state).toBe('pending');
      expect(effect?.kind).toBe('launch');
    } finally {
      store.close();
    }
    // Both follow-ups are named: the attempt has to be observed, and the launch it
    // deferred has to be performed by recovery.
    expect(run.stderr).toMatch(/factory status/u);
    expect(run.stderr).toMatch(/factory recover/u);
  });
});
