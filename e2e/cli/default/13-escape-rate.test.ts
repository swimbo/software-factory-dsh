/**
 * The escape-rate audit (E2E-23): "we are wrong about how wrong we are".
 *
 * The point of this command is not a number, it is that the sample is *complete and admitted
 * to be unverified*: every shipped unit is in the sample (or the sample size is printed
 * against the population), each row says what re-score it got, and each says `PENDING` because
 * no human has re-validated it yet. An audit that quietly showed only the units it had
 * answers for would be worse than no audit.
 *
 * Fixture size: the plan's example uses five shipped units; two are enough to prove the
 * property (the sample is the population, and nothing is omitted), and this spec says so
 * rather than pretending five. Every unit here is shipped the same way a real one is: a
 * measured pass, a signature from the operator key, then `promote --confirm`.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { jsonOf, runFactory } from '../../harness/factory.ts';
import { createWallFixture, type WallFixture } from '../../harness/wall-fixture.ts';

let fixture: WallFixture;

beforeEach(() => {
  fixture = createWallFixture();
});

afterEach(() => {
  fixture.cleanup();
});

function ship(revision: number, intent: string): string {
  const unitId = fixture.submit({ revision, intent });
  const run = fixture.run(unitId);
  expect(run.code, `run ${unitId}: ${run.stdout}${run.stderr}`).toBe(0);
  const signature = fixture.signPromotion(unitId);
  const promoted = runFactory(
    [
      'promote',
      unitId,
      '--signature',
      signature,
      '--confirm',
      `sign promotion ${unitId}`,
      '--json',
    ],
    { home: fixture.home },
  );
  expect(promoted.code, `promote ${unitId}: ${promoted.stdout}${promoted.stderr}`).toBe(0);
  return unitId;
}

describe('escape-rate audit (E2E-23)', () => {
  it('[@default] exits 5, lists every shipped unit, and marks each review PENDING', () => {
    const first = ship(
      1,
      'Add a slug-uniqueness check on the read path so duplicate slugs are rejected before insert.',
    );
    const second = ship(
      2,
      // A real second unit, not a copy: the spec hash must differ, and the restate-back
      // overlap with the intent must stay above the qualifier's floor (it rejects a
      // restatement that no longer matches the ask, which is the point of that signal).
      'Add a slug-uniqueness check on the read path so duplicate slug is rejected before insert.',
    );

    const run = runFactory(
      ['audit', '--escape-rate', '--since', '2020-01-01', '--sample', '5', '--json'],
      { home: fixture.home },
    );
    const json = jsonOf(run);

    // Exit 5: reviews are outstanding. Not an error — the command did its job, and the exit
    // code is what a cron job uses to page a human.
    expect(run.code, `${run.stdout}\n${run.stderr}`).toBe(5);
    expect(json['kind']).toBe('escape-rate');
    expect(Number(json['awaitingReview'])).toBeGreaterThan(0);

    const sample = json['sample'] as Record<string, unknown>[];
    // The sample is the population here: two shipped, two sampled, so nothing is omitted.
    expect(sample).toHaveLength(2);
    expect(sample.map((row) => row['unitId']).sort()).toEqual([first, second].sort());
    for (const row of sample) {
      // Every row carries the re-score outcome it actually got, and the review it still owes.
      expect(row['humanRevalidation']).toBe('PENDING');
      expect(row).toHaveProperty('wallRescore');
    }

    // The human renderer says the sample size against the population, so an operator can see
    // that five were asked for and two exist.
    expect(run.stderr).toMatch(/ESCAPE RATE AUDIT\s+sample 2 of 2 shipped units/u);
    expect(run.stderr).toMatch(/human re-validation: PENDING/u);
  });

  it('[@default] is read-only: the audit appends no event and changes no unit state', () => {
    const unitId = ship(
      1,
      'Add a slug-uniqueness check on the read path so duplicate slugs are rejected before insert.',
    );

    const before = jsonOf(runFactory(['status', '--json'], { home: fixture.home }));
    const run = runFactory(['audit', '--escape-rate', '--sample', '1'], { home: fixture.home });
    expect(run.code).toBe(5);
    const after = jsonOf(runFactory(['status', '--json'], { home: fixture.home }));

    // Same ledger head: an audit is a question, not a decision.
    expect((after['health'] as { store: Record<string, unknown> }).store['ledgerHead']).toBe(
      (before['health'] as { store: Record<string, unknown> }).store['ledgerHead'],
    );
    const unit = (after['units'] as Record<string, unknown>[]).find(
      (row) => row['unitId'] === unitId,
    );
    expect(unit?.['state']).toBe('promoted');
  });
});
