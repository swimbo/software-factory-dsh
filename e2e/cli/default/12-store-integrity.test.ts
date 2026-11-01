/**
 * A quarantined store: read-only, with no escape hatch (E2E-27).
 *
 * The store quarantines itself when it can no longer trust its own ledger. From that moment
 * two things must be true, and they pull in opposite directions:
 *
 *   - **every write refuses** (exit 9) — including the writes an operator might reach for in
 *     a panic, because writing into a ledger that cannot be verified is how evidence is lost;
 *   - **the reads still work** — `status`, `audit` and `receipts` are how a person finds out
 *     what happened, so a quarantine that also blinded them would be a cover-up.
 *
 * The escape hatches (`--reset`, `--unfence`, `--force`) are deliberately *usage errors*
 * (exit 2) rather than policy refusals: they are not a thing this tool can do, at any
 * privilege level, and pretending otherwise would make the refusal look like a permission
 * problem. The quarantine is set here through the store's own API, which is how it happens in
 * production (the detection is in the store, not in the CLI).
 */
import { writeFileSync } from 'node:fs';
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

function writeJson(path: string, value: unknown): string {
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`);
  return path;
}

function writeText(path: string, text: string): void {
  writeFileSync(path, `${text}\n`);
}

/** Quarantine the store the way the store does it: through its own append-only API. */
function quarantine(): void {
  const store = openStore({ dir: `${fixture.home}/state` });
  try {
    store.quarantine(
      'ledger divergence: event 7 hashes to a different head than the projection',
      'e2e',
      'T-e2equarantine',
    );
  } finally {
    store.close();
  }
}

describe('quarantined store (E2E-27)', () => {
  it('[@default] is a known divergence: status reports it but does not refuse (plan: exit 9)', () => {
    // DIVERGENCE from e2e-tests.md E2E-27, recorded in the name: the plan expects `status` to
    // exit 9 with a quarantine block naming the event number and the runbook path. The
    // implementation keeps `status` a *read* — exit 0, with the fact stated in the health
    // block — and never prints the reason the store recorded.
    fixture.submit();
    quarantine();

    const run = runFactory(['status', '--json'], { home: fixture.home });
    const json = jsonOf(run);
    const health = json['health'] as { store: Record<string, unknown> };

    expect(run.code).toBe(0);
    expect(health.store['state']).toBe('quarantined');
    expect(health.store['quarantined']).toBe(true);
    expect(String(health.store['detail'])).toMatch(/write is refused/iu);
    // What is missing, asserted as missing: the recorded reason (and therefore the event
    // number) does not reach the surface, and there is no runbook line.
    expect(JSON.stringify(json)).not.toContain('event 7');
    expect(run.stderr).not.toMatch(/runbook/iu);
  });

  it('[@default] every write is refused with exit 9, and nothing is appended', () => {
    const unitId = fixture.submit();
    quarantine();

    // A *new* submission and not a re-submission: re-submitting an unchanged spec is an
    // idempotent read-and-return that legitimately writes nothing (asserted below).
    const specPath = writeJson(`${fixture.home}/spec-2.json`, {
      slug: 'slug-check',
      revision: 2,
      repo: 'fixture',
      baseRev: fixture.baseRev,
      intent:
        'Add a slug-uniqueness check on the read path so duplicate slugs are rejected before insert.',
      restateBack:
        'You asked for: a slug uniqueness check on the read path, proven by a unit test. Not asking for: a schema migration.',
      acceptance: [
        {
          id: 'suite-green',
          text: 'node tests/suite.js exits 0',
          oracle: { kind: 'command', target: 'node tests/suite.js', expect: 'exit 0' },
        },
      ],
      touchPaths: ['src/slug.js'],
      operationClasses: ['code-change'],
      sizeBudget: { files: 4, lines: 80 },
      budgetEstimateUsd: 0.42,
    });
    const restatePath = `${fixture.home}/restate-2.md`;
    writeText(
      restatePath,
      'You asked for: a slug uniqueness check on the read path, proven by a unit test. Not asking for: a schema migration.',
    );

    const writes: readonly (readonly string[])[] = [
      ['intent', '--file', specPath, '--restate', restatePath, '--json'],
      ['abort', unitId, '--reason', 'x', '--json'],
      ['recover', '--json'],
      [
        'budget',
        'raise',
        '--to',
        '4.00',
        '--reason',
        'x',
        '--confirm',
        'raise per-unit envelope to 4.00',
        '--json',
      ],
    ];

    for (const args of writes) {
      const run = runFactory(args, { home: fixture.home, env: fixture.wallEnv() });
      expect(run.code, `${args.join(' ')} → ${run.stdout}${run.stderr}`).toBe(9);
      expect(jsonOf(run)['code']).toBe('STORE_QUARANTINED');
    }

    // The idempotent re-submission writes nothing, so it is not a quarantine bypass.
    const again = runFactory(
      [
        'intent',
        '--file',
        `${fixture.home}/spec-1.json`,
        '--restate',
        `${fixture.home}/restate-1.md`,
        '--json',
      ],
      { home: fixture.home },
    );
    expect(again.code).toBe(0);
    expect(jsonOf(again)['created']).toBe(false);

    const store = openStore({ dir: `${fixture.home}/state` });
    try {
      // The unit count and the verdict count are unchanged: a refused write appended nothing.
      expect(store.listUnits()).toHaveLength(1);
      expect(store.latestVerdictForUnit(unitId)).toBeNull();
      expect(store.listAttemptsForUnit(unitId)).toHaveLength(0);
    } finally {
      store.close();
    }
  });

  it('[@default] the escape hatches are usage errors, not policy refusals', () => {
    fixture.submit();
    quarantine();

    for (const flag of ['--reset', '--unfence', '--force']) {
      const run = runFactory(['status', flag], { home: fixture.home });
      expect(run.code, `${flag} → ${run.stdout}${run.stderr}`).toBe(2);
      expect(run.stderr).not.toMatch(/STORE_QUARANTINED/u);
    }
  });

  it('[@default] reads still work: audit and receipts answer on a quarantined store', () => {
    const unitId = fixture.submit();
    quarantine();

    const audit = runFactory(['audit', unitId, '--json'], { home: fixture.home });
    expect(audit.code, audit.stderr).toBe(0);
    expect(jsonOf(audit)['kind']).toBe('trace');

    const receipts = runFactory(['receipts', unitId, '--json'], { home: fixture.home });
    // No attempt ever ran, so there is no receipt — but the answer is a *read* (exit 0 with an
    // empty list), not a quarantine refusal.
    expect(receipts.code, receipts.stderr).toBe(0);
    expect(jsonOf(receipts)['receipts']).toEqual([]);
  });
});
