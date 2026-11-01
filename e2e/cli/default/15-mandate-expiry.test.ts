/**
 * A mandate that stopped vouching for a unit stops it forever (E2E-52, re-scoped).
 *
 * The plan's version assumed named policy versions (`q-2026.11.1` → `q-2026.12.1`) that could
 * be bumped in the store. They do not exist: a policy is a `sha256:…` hash and the only
 * alternate policy this build can produce is the cold-start one, so "the store policy was
 * bumped" has no mechanism to test. What the id is *for* — a unit authorised by a mandate that
 * no longer holds must not run, and must never be resumed by a later command — is provable, and
 * is what this spec asserts.
 *
 * The first refusal is also covered by `07-seams` ("a stale mandate"); this spec adds the half
 * the plan actually cares about: **never resumes**. A retry after the refusal is a fresh
 * refusal, and `recover` — the verb that exists to pick up in-flight work — does not dispatch
 * anything on the unit's behalf.
 */
import { DatabaseSync } from 'node:sqlite';
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

/** Expire every mandate: the unit keeps its lane decision, but nothing authorises a launch. */
function expireMandates(): void {
  const db = new DatabaseSync(join(fixture.home, 'state', 'factory.db'));
  try {
    db.exec("UPDATE mandates SET expires_at = '2020-01-01T00:00:00.000Z'");
  } finally {
    db.close();
  }
}

describe('a mandate that no longer holds (E2E-52, re-scoped)', () => {
  it('[@default] refuses the run, refuses the retry, and recover dispatches nothing', () => {
    const unitId = fixture.submit();
    expireMandates();

    const first = fixture.run(unitId);
    expect(first.code, `${first.stdout}\n${first.stderr}`).toBe(3);
    const firstJson = jsonOf(first);
    // The refusal names a mandate problem, and it is a refusal — not a warning that carries on.
    expect(
      ['MANDATE_EXPIRED', 'MANDATE_REVOKED'].includes(String(firstJson['code'])),
      String(firstJson['code']),
    ).toBe(true);
    expect(existsSync(join(fixture.home, 'attempts', unitId))).toBe(false);

    // The retry is the same answer. A policy/mandate refusal is not a transient failure to be
    // retried until it works: retrying is exactly how a stopped unit gets resumed.
    const second = fixture.run(unitId);
    expect(second.code).toBe(3);
    expect(String(jsonOf(second)['code'])).toBe(String(firstJson['code']));

    // And `recover` — the verb that exists to finish in-flight work — finds nothing to finish.
    const recovered = runFactory(['recover', '--json'], { home: fixture.home });
    const recoveredJson = jsonOf(recovered);
    expect(recovered.code, recovered.stderr).toBe(0);
    expect((recoveredJson['attempts'] as unknown[] | undefined) ?? []).toHaveLength(0);

    const store = openStore({ dir: join(fixture.home, 'state') });
    try {
      expect(store.listAttemptsForUnit(unitId)).toHaveLength(0);
      expect(store.latestVerdictForUnit(unitId)).toBeNull();
      const unit = store.getUnit(unitId);
      // Never `verified`, and never silently returned to a dispatchable state.
      expect(unit?.state).not.toBe('verified');
    } finally {
      store.close();
    }
  });
});
