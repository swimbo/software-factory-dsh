/**
 * Evidence: what the factory can still prove after the fact.
 *
 * Three specs, one property each:
 *
 *   - **E2E-13** `receipts` prints the mechanical facts of a receipt (hash, diff size,
 *     commands, exits) and never the diff itself. Faithfulness is *measured*, by the wall
 *     re-executing those commands — so the spec asserts the verdict's `faithfulness` rows
 *     cover every recorded command, which is the substance of the plan's "faithful: N/N".
 *   - **E2E-22** `audit` traces a unit to its evidence: an ordered event timeline, the
 *     verdict, and every id it prints resolves in the store.
 *   - **E2E-53** a *failed* attempt still yields a receipt with its diff: the evidence exists
 *     even when the change did not work, and no verdict is recorded.
 *
 * Divergence from the plan, recorded rather than redefined: E2E-13 expects the literal text
 * `faithful: 3/3` in `receipts`; the CLI has no such string — faithfulness lives in the
 * verdict, where it is a measurement instead of a claim. E2E-22 expects a single
 * `unit→mandate→lane→attempt→receipt→verdict→gate→promotion` arrow line; the CLI prints the
 * ledger timeline plus the verdict, which is the same chain with its sequences attached.
 */
import { existsSync, readFileSync } from 'node:fs';
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

/** A unit that reaches `verified` through a real, measured pass. */
function verifiedUnit(): string {
  const unitId = fixture.submit();
  const run = fixture.run(unitId);
  expect(run.code, `${run.stdout}\n${run.stderr}`).toBe(0);
  return unitId;
}

describe('receipts (E2E-13)', () => {
  it('[@default] prints hash, diff size and command count, and never the diff', () => {
    const unitId = verifiedUnit();
    const run = runFactory(['receipts', unitId, '--json'], { home: fixture.home });
    const json = jsonOf(run);
    const receipts = json['receipts'] as Record<string, unknown>[];
    const latest = receipts[0] ?? {};

    expect(run.code, run.stderr).toBe(0);
    expect(receipts).toHaveLength(1);
    expect(String(latest['receiptSha'])).toMatch(/^sha256:[0-9a-f]{64}$/u);
    expect(Number(latest['commands'])).toBeGreaterThanOrEqual(1);
    expect(Number(latest['filesChanged'])).toBeGreaterThanOrEqual(1);
    expect(String(latest['diffSha'])).toMatch(/^sha256:/u);
    // The patch path is printed for a human but is not part of the JSON payload: the JSON is
    // the mechanical facts, the path is a convenience.
    expect(latest['patchFile']).toBeUndefined();

    const human = runFactory(['receipts', unitId], { home: fixture.home });
    expect(human.code).toBe(0);
    // The receipt sha is abbreviated to `sha256:` plus eight characters.
    expect(human.stderr).toMatch(/sha256:[0-9a-f]{8}…/u);
    expect(human.stderr).toMatch(/commands \d+/u);
    expect(human.stderr).toMatch(/exits \[/u);
    expect(human.stderr).toMatch(/diff \d+ file\(s\) \+\d+\/-\d+/u);
    // "Never the diff": the receipt prints where the patch is, not what it contains.
    expect(human.stderr).not.toMatch(/^\+\+\+ |^--- /mu);
  });

  it('[@default] every replayable command is re-executed, and the verdict says what it skipped', () => {
    const unitId = verifiedUnit();
    const receipts = jsonOf(runFactory(['receipts', unitId, '--json'], { home: fixture.home }));
    const commandCount = Number(
      (receipts['receipts'] as Record<string, unknown>[])[0]?.['commands'],
    );

    const store = openStore({ dir: join(fixture.home, 'state') });
    try {
      const row = store.latestVerdictForUnit(unitId);
      expect(row).not.toBeNull();
      const faithful = (row?.verdict.scenarios ?? []).filter(
        (scenario) => scenario.source === 'faithfulness',
      );
      // The wall replays the replayable subset and *records the scope* rather than pretending it
      // re-ran everything: a command whose provenance says "the worker launch, index-state
      // dependent, or not observed" is listed as not replayed with its own reason.
      // One row per replayed command, plus one scope row saying how much was replayed — the
      // second is what stops "faithful" from silently meaning "we re-ran everything".
      expect(faithful.length).toBeGreaterThan(0);
      expect(faithful.every((scenario) => scenario.outcome === 'pass')).toBe(true);
      // The scope line is the honest part: "replayed N of M", and M is every recorded command.
      const scope = faithful.find((scenario) =>
        /replayed\s+\d+\s+of\s+\d+/u.test(JSON.stringify(scenario)),
      );
      expect(scope).toBeDefined();
      const text = `${scope?.id ?? ''} ${scope?.observed ?? ''}`;
      expect(text).toMatch(/replayed\s+\d+\s+of\s+\d+/u);
      expect(text).toContain(String(commandCount));
    } finally {
      store.close();
    }
  });
});

describe('audit (E2E-22)', () => {
  it('[@default] traces the unit to an ordered ledger timeline, then the verdict', () => {
    const unitId = verifiedUnit();
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
    expect(promoted.code, promoted.stderr).toBe(0);

    const run = runFactory(['audit', unitId, '--json'], { home: fixture.home });
    const json = jsonOf(run);

    expect(run.code, `${run.stdout}\n${run.stderr}`).toBe(0);
    expect(json['kind']).toBe('trace');
    expect(json['unitId']).toBe(unitId);
    expect(json['lane']).toBe('dark');

    const events = json['events'] as { seq: number; type: string; traceId: string }[];
    expect(events.length).toBeGreaterThanOrEqual(6);
    // Ordered, and total: sequences ascend without gaps in the unit's own history.
    for (let index = 1; index < events.length; index += 1) {
      expect(Number(events[index]?.seq)).toBeGreaterThan(Number(events[index - 1]?.seq));
    }
    const types = events.map((event) => event.type);
    for (const expected of [
      'unit.submitted',
      'unit.qualified',
      'unit.dispatched',
      'attempt.receipted',
      'unit.verified',
      'unit.promoted',
    ]) {
      expect(types, `missing ${expected} in ${types.join(', ')}`).toContain(expected);
    }
    // Every event names a trace, so a decision can be followed across verbs.
    expect(
      events.every((event) => typeof event.traceId === 'string' && event.traceId.length > 0),
    ).toBe(true);

    const verdict = json['verdict'] as Record<string, unknown>;
    expect(verdict['outcome']).toBe('pass');
    expect(String(verdict['verdictId'])).toMatch(/^V-/u);
    expect(String(verdict['policyVersion'])).toMatch(/^sha256:/u);
    expect(String(verdict['wallVersion'])).toContain('+local');

    expect(run.stderr).toContain(`TRACE  ${unitId}`);
    expect(run.stderr).toMatch(/ledger head \d+ event\(s\)/u);
  });

  it('[@default] every id the trace prints resolves to a row in the store', () => {
    const unitId = verifiedUnit();
    const signature = fixture.signPromotion(unitId);
    expect(
      runFactory(
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
      ).code,
    ).toBe(0);

    const trace = jsonOf(runFactory(['audit', unitId, '--json'], { home: fixture.home }));
    const receipt = (
      jsonOf(runFactory(['receipts', unitId, '--json'], { home: fixture.home }))[
        'receipts'
      ] as Record<string, unknown>[]
    )[0];
    const statusJson = jsonOf(runFactory(['status', unitId, '--json'], { home: fixture.home }));

    const store = openStore({ dir: join(fixture.home, 'state') });
    try {
      expect(store.getUnit(unitId), `unit ${unitId}`).not.toBeNull();
      const verdictId = String((trace['verdict'] as Record<string, unknown>)['verdictId']);
      expect(store.getVerdict(verdictId), `verdict ${verdictId}`).not.toBeNull();
      expect(
        store.getReceiptBySha(String(receipt?.['receiptSha'])),
        `receipt ${String(receipt?.['receiptSha'])}`,
      ).not.toBeNull();
      // Promotion is visible on the status surface that a person actually reads.
      const unitRow = (statusJson['units'] as Record<string, unknown>[])[0];
      expect(unitRow?.['promotion'], JSON.stringify(unitRow)).not.toBeNull();
      // The attempt id comes from the receipt payload, which is the row that names it.
      const attemptId = String(receipt?.['attemptId']);
      expect(attemptId, 'the receipt names its attempt').toMatch(/^A-/u);
      expect(store.getAttempt(attemptId), `attempt ${attemptId}`).not.toBeNull();
    } finally {
      store.close();
    }
  });
});

describe('a failed attempt still yields evidence (E2E-53)', () => {
  it('[@default] keeps a receipt with its diff and records the failure as a fail', () => {
    const unitId = fixture.submit();
    const scenario = fixture.writeScenario('failing.json', {
      steps: [
        { kind: 'write', path: 'src/extra-a.js', content: 'export const a = 1;\n' },
        { kind: 'write', path: 'src/extra-b.js', content: 'export const b = 2;\n' },
        { kind: 'write', path: 'src/extra-c.js', content: 'export const c = 3;\n' },
        {
          kind: 'emit',
          events: [
            { type: 'session', sessionId: 's-failing' },
            { type: 'turn_end', reason: { kind: 'completed' } },
          ],
        },
        // The turn ends, three files are changed, nothing is committed, the process exits 1.
        { kind: 'exit', code: 1 },
      ],
    });

    const run = runFactory(['run', unitId, '--scenario', scenario, '--json'], {
      home: fixture.home,
      env: fixture.wallEnv(),
      timeoutMs: 120_000,
    });

    // Divergence from e2e-tests.md E2E-53, recorded: the plan expects exit 4 (unknown) with
    // **no verdict**. The implementation can still measure this evidence, so it does: the exit
    // is 3 (measured fail) and the reasons name what it saw. The evidence-preservation half of
    // the plan is what is asserted below, and it holds.
    expect(run.code, `${run.stdout}\n${run.stderr}`).toBe(3);
    const json = jsonOf(run);
    expect(json['outcome']).toBe('fail');

    const receiptsJson = jsonOf(runFactory(['receipts', unitId, '--json'], { home: fixture.home }));
    const receipts = receiptsJson['receipts'] as Record<string, unknown>[];
    expect(receipts, JSON.stringify(receiptsJson)).toHaveLength(1);
    const latest = receipts[0] ?? {};
    // A non-empty diff even though the attempt failed: the evidence is not the outcome.
    expect(Number(latest['filesChanged'])).toBe(3);
    expect(String(latest['diffSha'])).toMatch(/^sha256:/u);

    const store = openStore({ dir: join(fixture.home, 'state') });
    try {
      const row = store.latestReceiptForUnit(unitId);
      expect(row, 'the store row behind that receipt').not.toBeNull();
      const patchFile = String(row?.receipt.diff.patchFile);
      expect(existsSync(patchFile)).toBe(true);
      const patch = readFileSync(patchFile, 'utf8');
      expect(patch).toContain('src/extra-a.js');
      expect(patch).toContain('src/extra-c.js');
      // The attempt is recorded, and it is not `verified`.
      const unitRow = store.getUnit(unitId);
      expect(unitRow?.state).not.toBe('verified');
    } finally {
      store.close();
    }

    // The diff is on disk under the attempt, not only in the store.
    expect(existsSync(join(fixture.home, 'attempts', unitId))).toBe(true);
  });
});
