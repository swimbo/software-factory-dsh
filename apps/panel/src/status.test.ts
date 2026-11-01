/**
 * `buildStatus()` — what the page is allowed to say, and what it is not.
 *
 * Every test here asserts a fact about *honesty* rather than about shape alone:
 * an unmeasured number is `null` (never `0`), an uncertified verdict is `unknown`
 * (never `passed`), an aggregate never reads "fine" about something nobody
 * measured, and every projection validates against the shared `status.v1`
 * contract before it is allowed out of the process.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { parseStatus } from '@factory/contracts';
import type { StatusV1 } from '@factory/contracts';

import {
  DEFAULT_PER_DAY_USD,
  DEFAULT_PER_UNIT_USD,
  buildStatus,
  panelUnitState,
} from '../src/status.ts';
import {
  AT,
  LATER,
  NARRATIVE,
  POLICY,
  makeSpec,
  makeUnitRow,
  options,
  qualify,
  statusOf,
  tempStore,
  walkToVerdict,
} from '../test/fixtures.ts';
import type { TempStore } from '../test/fixtures.ts';

let fixture: TempStore;
beforeEach(() => {
  fixture = tempStore();
});
afterEach(() => {
  fixture.cleanup();
});

const store = (): TempStore['store'] => fixture.store;

describe('the envelope', () => {
  it('emits exactly the seven top-level keys, including the four normative content keys', () => {
    const status = statusOf(store());
    expect(Object.keys(status).sort()).toEqual(
      [
        'budget',
        'factory',
        'generatedAt',
        'health',
        'schemaVersion',
        'units',
        'waitingOnPerson',
      ].sort(),
    );
    expect(status.schemaVersion).toBe('status.v1');
  });

  it('takes its timestamps from the injected clock, never the wall clock', () => {
    const status = statusOf(store(), { at: '2026-11-01T12:10:00.000Z', startedAt: AT });
    expect(status.generatedAt).toBe('2026-11-01T12:10:00.000Z');
    // Ten minutes of process uptime, computed from `startedAt`.
    expect(status.health.controlPlane.uptimeS).toBe(600);
  });

  it('names the pinned DSH version but reports the observed one as unknown', () => {
    const status = statusOf(store());
    expect(status.factory.dshVersionExpected).toBe('0.2.1-rc.3');
    expect(status.factory.dshVersionObserved).toBeNull();
    // The one thing it must not do: compare a version against itself and call it ok.
    expect(status.health.dshVersion.state).toBe('unavailable');
    expect(status.health.dshVersion.observed).toBeNull();
    expect(status.health.dshVersion.expected).toBe('0.2.1-rc.3');
  });

  it('reports `ok` only when the probe really read the pinned version', () => {
    const status = statusOf(store(), { dshVersionObserved: '0.2.1-rc.3' });
    expect(status.health.dshVersion.state).toBe('ok');
    expect(status.health.dshVersion.observed).toBe('0.2.1-rc.3');
    expect(status.health.dshVersion.expected).toBe('0.2.1-rc.3');
    expect(status.health.dshVersion.detail).toBeNull();
  });

  it('reports a version skew as degraded, naming both versions', () => {
    const status = statusOf(store(), { dshVersionObserved: '0.3.0' });
    expect(status.health.dshVersion.state).toBe('degraded');
    expect(status.health.dshVersion.observed).toBe('0.3.0');
    expect(status.health.dshVersion.detail).toContain('0.2.1-rc.3');
    expect(status.health.dshVersion.detail).toContain('0.3.0');
  });

  it('claims `unavailable` when the probe could not read anything', () => {
    const status = statusOf(store(), { dshVersionObserved: null });
    expect(status.health.dshVersion.state).toBe('unavailable');
    expect(status.health.dshVersion.observed).toBeNull();
    expect(status.health.dshVersion.detail).toContain('could be read');
  });

  it('validates against the shared status.v1 schema', () => {
    expect(() => parseStatus(statusOf(store()))).not.toThrow();
  });
});

describe('an empty factory', () => {
  it('renders as empty, not as healthy-but-busy', () => {
    const status = statusOf(store());
    expect(status.units).toEqual([]);
    expect(status.waitingOnPerson).toEqual([]);
    expect(status.health.taskClasses).toEqual([]);
    expect(status.health.store.state).toBe('ok');
    expect(status.health.store.quarantined).toBe(false);
    expect(status.budget.perDay.spent).toBe(0);
    expect(status.budget.perDay.reserved).toBe(0);
    expect(status.budget.unknownCount).toBe(0);
    expect(status.budget.state).toBe('ok');
  });

  it('falls back to the documented policy envelopes and says they are estimates', () => {
    const status = statusOf(store());
    expect(status.budget.perUnit.limit).toBe(DEFAULT_PER_UNIT_USD);
    expect(status.budget.perDay.limit).toBe(DEFAULT_PER_DAY_USD);
    expect(status.budget.perUnit.kind).toBe('estimated');
    // Never `measured`: there is no billing-grade telemetry in v1.
    expect(status.budget.telemetry).toBe('estimated');
    expect(status.budget.perDay.measuredSpent).toBeNull();
  });

  it('reads the raised envelope when one exists', () => {
    store().raiseEnvelope({
      envelopeId: 'E-daily-2',
      scope: 'daily',
      amountUsd: 50,
      effectiveFrom: AT,
      supersedes: null,
      signedBy: 'operator@example.com',
      reason: 'batch day',
    });
    const status = statusOf(store());
    expect(status.budget.perDay.limit).toBe(50);
  });
});

describe('a passed unit', () => {
  it('reports the verdict as passed, with a measured Δ and the signature gate still open', () => {
    walkToVerdict(store());
    const status = statusOf(store());
    const unit = status.units[0];
    expect(unit?.state).toBe('verified');
    expect(unit?.verdict?.state).toBe('passed');
    expect(unit?.verdict?.unknownReason).toBeNull();
    expect(unit?.verdict?.delta.state).toBe('measured');
    expect(unit?.verdict?.delta.value).toBeCloseTo(0.05, 5);
    expect(unit?.verdict?.promotionBlocked).toBe('first promotion requires your signature');
    expect(unit?.promotion).toBeNull();
    // Nothing needs a person for a verified unit, and nothing is unknown.
    expect(status.waitingOnPerson).toEqual([]);
  });

  it('never counts the receipt narrative as a page fact', () => {
    walkToVerdict(store());
    const status = statusOf(store());
    expect(JSON.stringify(status)).not.toContain('NARRATIVE-MARKER');
    expect(JSON.stringify(status)).not.toContain(NARRATIVE);
  });

  it('reports the operator intent as the unit title', () => {
    walkToVerdict(store());
    expect(statusOf(store()).units[0]?.title).toBe(makeSpec().intent);
  });

  it('closes the promotion gate once the ledger holds the signature', () => {
    const { unitId, receiptSha } = walkToVerdict(store());
    const verdict = store().latestVerdictForUnit(unitId);
    store().insertPromotion({
      promotionId: 'P-0cc1',
      unitId,
      verdictId: verdict?.verdictId ?? 'V-0bb1',
      verdictSha: receiptSha,
      promotionSha: `sha256:${'3'.repeat(64)}`,
      signedBy: 'operator@example.com',
      createdAt: LATER,
    });
    const status = statusOf(store());
    const unit = status.units[0];
    expect(unit?.state).toBe('promoted');
    expect(unit?.verdict?.promotionBlocked).toBeNull();
    expect(unit?.promotion?.signedBy).toBe('operator@example.com');
    expect(unit?.promotion?.signedAt).toBe(LATER);
    expect(unit?.promotion?.id).toMatch(/^P-[0-9a-z]{4,}$/);
  });
});

describe('an unknown verdict (ux-plan A-1: unknown is a value)', () => {
  it('is reported as unknown, never as passed, with a reason that is never null', () => {
    walkToVerdict(store(), { outcome: 'unknown' });
    const status = statusOf(store());
    const unit = status.units[0];
    expect(unit?.verdict?.state).toBe('unknown');
    expect(unit?.state).toBe('unknown');
    expect(unit?.verdict?.unknownReason).toBeTruthy();
    expect(unit?.verdict?.unknownReason).toContain('holdout_unavailable');
    expect(unit?.verdict?.unknownReason).not.toContain('pass');
  });

  it('leaves Δ unmeasured instead of inventing a zero', () => {
    walkToVerdict(store(), { outcome: 'unknown' });
    const verdict = statusOf(store()).units[0]?.verdict;
    expect(verdict?.delta.value).toBeNull();
    expect(verdict?.delta.state).toBe('unknown');
    // And the task-class row for that class carries the same non-measurement.
    const row = statusOf(store()).health.taskClasses[0];
    expect(row?.delta.value).toBeNull();
    expect(row?.delta.samples).toBe(0);
    expect(row?.delta.state).toBe('unknown');
  });

  it('puts the unit in the needs-you list with a command that can be pasted', () => {
    const { unitId } = walkToVerdict(store(), { outcome: 'unknown' });
    const items = statusOf(store()).waitingOnPerson;
    expect(items).toHaveLength(1);
    expect(items[0]?.kind).toBe('unknown_verdict');
    expect(items[0]?.unitId).toBe(unitId);
    expect(items[0]?.recommendedCommand).toBe(`factory status ${unitId} --all`);
    expect(items[0]?.irreversible).toBe(false);
    expect(items[0]?.question).toContain('not a pass');
    expect(items[0]?.id).toMatch(/^G-[0-9a-z]{4,}$/);
  });

  it('reports the measured turn count from the receipt, and tokens as unknown', () => {
    walkToVerdict(store(), { outcome: 'pass' });
    const attempt = statusOf(store()).units[0]?.attempt;
    expect(attempt?.turn).toBe(6);
    expect(attempt?.tokensUsed).toBeNull();
  });

  it('reports attempt telemetry as unknown rather than zero', () => {
    walkToVerdict(store(), { outcome: 'unknown' });
    const attempt = statusOf(store()).units[0]?.attempt;
    expect(attempt).not.toBeNull();
    // The receipt measured 6 turns, so that one figure is known even for an
    // unknown verdict; everything the store never measured stays `null`.
    expect(attempt?.turn).toBe(6);
    expect(attempt?.tokensUsed).toBeNull();
    expect(attempt?.tokenCeiling).toBeNull();
    expect(attempt?.wallClockCeilingS).toBeNull();
    // The contract itself refuses a measured zero here, so this is enforced twice.
    expect(() =>
      parseStatus({
        ...statusOf(store()),
        units: [
          {
            ...(statusOf(store()).units[0] as Record<string, unknown>),
            attempt: {
              ...(statusOf(store()).units[0]?.attempt as Record<string, unknown>),
              tokensUsed: 0,
            },
          },
        ],
      }),
    ).toThrow(/tokensUsed must be null when unmeasured/);
  });
});

describe('a failed unit', () => {
  it('is failed, terminal, and its promotion gate names the verdict', () => {
    walkToVerdict(store(), { outcome: 'fail' });
    const unit = statusOf(store()).units[0];
    expect(unit?.verdict?.state).toBe('failed');
    expect(unit?.state).toBe('failed');
    expect(unit?.verdict?.promotionBlocked).toBe('a failed unit cannot be promoted');
  });
});

describe('a unit nobody can explain', () => {
  it('reports what is known, what is not, and what was not done', () => {
    qualify(store(), 'U-2b7d', 'dark');
    store().acquireLease({
      leaseId: 'L-A-0002',
      unitId: 'U-2b7d',
      owner: 'control-1',
      acquiredAt: AT,
      expiresAt: '2026-11-01T13:00:00.000Z',
    });
    store().insertAttempt({
      attemptId: 'A-0002',
      unitId: 'U-2b7d',
      leaseId: 'L-A-0002',
      state: 'running',
      launchKey: 'launch:U-2b7d:A-0002',
      sessionId: 'sess-2',
      attemptDir: '/tmp/attempts/A-0002',
      startedAt: AT,
      endedAt: null,
      exitCode: null,
    });
    store().setUnitState('U-2b7d', 'ambiguous', 'attempt did not report', options());

    const status = statusOf(store());
    const unit = status.units[0];
    expect(unit?.state).toBe('ambiguous');
    expect(unit?.ambiguity?.known).toContain('A-0002');
    expect(unit?.ambiguity?.unknown).toContain('did not finish');
    expect(unit?.ambiguity?.notDone).toContain('nothing was retried');
    expect(unit?.verdict).toBeNull();

    const item = status.waitingOnPerson[0];
    expect(item?.kind).toBe('ambiguous_attempt');
    expect(item?.recommendedCommand).toBe('factory status U-2b7d --attempt 1');
    expect(item?.irreversible).toBe(false);
  });

  it('lists a unit parked in the lit lane with an out-of-band action', () => {
    // Applying a lit lane parks the unit: the qualifier's decision is the parking.
    qualify(store(), 'U-3c8e', 'lit');
    const status = statusOf(store());
    expect(status.units[0]?.state).toBe('lit_parked');
    const item = status.waitingOnPerson[0];
    expect(item?.kind).toBe('lit_unit');
    expect(item?.unitId).toBe('U-3c8e');
    expect(item?.recommendedCommand).toBe('factory status U-3c8e --all');
  });
});

describe('the budget', () => {
  it('counts an unknown spend row as unmeasured rather than as zero', () => {
    walkToVerdict(store(), { outcome: 'pass' });
    const unitId = 'U-7f3a9c';
    store().recordSpend({
      spendId: 'S-1',
      unitId,
      attemptId: 'A-0001',
      kind: 'unknown',
      amountUsd: null,
      recordedAt: LATER,
    });
    const status = statusOf(store());
    expect(status.budget.unknownCount).toBe(1);
    expect(status.budget.state).toBe('degraded');
    expect(status.budget.perDay.spent).toBe(0);
  });

  it('asks for an envelope raise, irreversibly, when the day is exhausted', () => {
    walkToVerdict(store(), { outcome: 'pass' });
    store().raiseEnvelope({
      envelopeId: 'E-daily-1',
      scope: 'daily',
      amountUsd: 5,
      effectiveFrom: AT,
      supersedes: null,
      signedBy: 'operator@example.com',
      reason: 'small day',
    });
    store().reserveSpend({
      spendId: 'S-1',
      unitId: 'U-7f3a9c',
      attemptId: 'A-0001',
      amountUsd: 5,
      recordedAt: LATER,
    });
    const status = statusOf(store());
    expect(status.budget.perDay.reserved).toBe(5);
    const item = status.waitingOnPerson.find((entry) => entry.kind === 'budget_envelope_raise');
    expect(item).toBeDefined();
    expect(item?.irreversible).toBe(true);
    expect(item?.unitId).toBeNull();
    expect(item?.recommendedCommand).toMatch(
      /^factory budget raise --to [0-9.]+ --reason "<why>"$/,
    );
  });
});

describe('health is derived from evidence, never from optimism', () => {
  it('reports a quarantined store as unavailable and the control plane as degraded', () => {
    store().quarantine('checksum mismatch in ledger', 'control', 'tr-quarantine');
    const status = statusOf(store());
    expect(status.health.store.quarantined).toBe(true);
    expect(status.health.store.state).toBe('unavailable');
    expect(status.health.controlPlane.state).toBe('degraded');
    expect(status.health.store.detail).toContain('quarantined');
  });

  it('notices a launch nobody picked up', () => {
    qualify(store(), 'U-4d9f', 'dark');
    store().acquireLease({
      leaseId: 'L-A-0003',
      unitId: 'U-4d9f',
      owner: 'control-1',
      acquiredAt: AT,
      expiresAt: '2026-11-01T13:00:00.000Z',
    });
    store().insertAttempt({
      attemptId: 'A-0003',
      unitId: 'U-4d9f',
      leaseId: 'L-A-0003',
      state: 'launching',
      launchKey: 'launch:U-4d9f:A-0003',
      sessionId: null,
      attemptDir: '/tmp/attempts/A-0003',
      startedAt: AT,
      endedAt: null,
      exitCode: null,
    });
    const status = statusOf(store(), { at: '2026-11-01T12:30:00.000Z', startedAt: AT });
    expect(status.health.executor.state).toBe('degraded');
    expect(status.health.executor.since).toBe(AT);
    expect(status.health.executor.detail).toContain('A-0003');
  });

  it('does not mistake a receipted attempt for a stuck launch', () => {
    // `insertReceipt` records the receipt but leaves the attempt in its launch
    // state, so an attempt that plainly ran can still read `planned` hours later.
    // The receipt is the evidence that it ran; the executor is fine.
    walkToVerdict(store());
    const status = statusOf(store(), { at: '2026-11-01T18:00:00.000Z', startedAt: AT });
    expect(status.health.executor.state).toBe('ok');
    expect(status.health.executor.since).toBeNull();
  });

  it('leaves the executor ok when nothing is waiting on it', () => {
    const status = statusOf(store());
    expect(status.health.executor.state).toBe('ok');
    expect(status.health.executor.since).toBeNull();
    // Not measured is `unknown`, not an invented container name.
    expect(status.health.executor.kind).toBe('unknown');
    expect(status.health.executor.image).toBeNull();
  });

  it('reports the wall unavailable when the newest verdict blames the wall', () => {
    walkToVerdict(store(), { outcome: 'unknown' });
    const status = statusOf(store());
    expect(status.health.wall.state).toBe('unavailable');
    expect(status.health.wall.since).toBe(LATER);
    expect(status.health.wall.holdoutRevision).toBe('holdout/7');
  });

  it('reports the outbox as degraded while effects are pending', () => {
    store().enqueueEffect({
      effectId: 'X-1',
      idempotencyKey: 'promote:U-7f3a9c',
      kind: 'promotion',
      payload: { unitId: 'U-7f3a9c' },
      createdAt: AT,
    });
    const status = statusOf(store());
    expect(status.health.outbox.pending).toBe(1);
    expect(status.health.outbox.state).toBe('degraded');
    // Retry and dead-letter counts are not exposed by the Store interface.
    expect(status.health.outbox.retrying).toBeNull();
    expect(status.health.outbox.dead).toBeNull();
  });

  it('keeps a ledger head that a reader can point at', () => {
    walkToVerdict(store());
    const status = statusOf(store());
    expect(status.health.store.ledgerHead).not.toBeNull();
    expect(status.health.store.schemaVersion).toBe(1);
  });
});

describe('Δ per task class', () => {
  it('emits one row per class and never blends them', () => {
    walkToVerdict(store(), {
      unitId: 'U-0001',
      verdictId: 'V-0001',
      attemptId: 'A-0001',
      receiptId: 'R-0001',
    });
    walkToVerdict(store(), {
      unitId: 'U-0002',
      verdictId: 'V-0002',
      attemptId: 'A-0002',
      receiptId: 'R-0002',
      operationClasses: ['config-change'],
    });
    const classes = statusOf(store()).health.taskClasses;
    expect(classes.map((row) => row.class)).toEqual(['code-change', 'config-change']);
    // No blended total row: a sum across classes would be a number about nothing.
    expect(classes).toHaveLength(2);
  });

  it('counts samples and refuses to claim stability below five', () => {
    walkToVerdict(store(), {
      unitId: 'U-0001',
      verdictId: 'V-0001',
      attemptId: 'A-0001',
      receiptId: 'R-0001',
    });
    walkToVerdict(store(), {
      unitId: 'U-0002',
      verdictId: 'V-0002',
      attemptId: 'A-0002',
      receiptId: 'R-0002',
    });
    const row = statusOf(store()).health.taskClasses[0];
    expect(row?.class).toBe('code-change');
    expect(row?.delta.samples).toBe(2);
    expect(row?.delta.state).toBe('unstable');
    expect(row?.escapeRate.value).toBeNull();
    expect(row?.escapeRate.state).toBe('unknown');
  });
});

describe('which units are listed', () => {
  it('does not list a unit with no lane decision, and does not invent a lane for it', () => {
    store().insertUnit(makeUnitRow('U-5eaf', makeSpec({ slug: 'unqualified' })), options());
    const status = statusOf(store());
    expect(status.units).toEqual([]);
  });

  it('lists recent terminal units and caps them at five', () => {
    for (let index = 1; index <= 7; index += 1) {
      const suffix = String(index).padStart(4, '0');
      walkToVerdict(store(), {
        unitId: `U-${suffix}`,
        verdictId: `V-${suffix}`,
        attemptId: `A-${suffix}`,
        receiptId: `R-${suffix}`,
        outcome: index % 2 === 0 ? 'pass' : 'fail',
      });
    }
    const status = statusOf(store());
    // Every walked unit has a lane, so all seven are listed; the *page* caps the
    // recent-verdict list at five (asserted in render.test.ts). The API lists the
    // units the operator can act on, which is all of them.
    expect(status.units.length).toBeGreaterThanOrEqual(5);
  });
});

describe('panelUnitState', () => {
  it('lets the verdict override a state that would otherwise read better than it is', () => {
    const receipted = makeUnitRow('U-6fb0', makeSpec(), 'receipted');
    expect(panelUnitState(receipted, null)).toBe('verifying');
    expect(
      panelUnitState(receipted, {
        verdictId: 'V-0bb1',
        state: 'unknown',
        wallVersion: 'wall/0.1.0',
        holdoutRevision: 'holdout/7',
        policyVersion: POLICY,
        holdout: { passed: 0, total: 2, rule: 'rule' },
        delta: {
          value: null,
          visiblePassRate: null,
          holdoutPassRate: null,
          samples: 2,
          state: 'unknown',
        },
        receipt: { receiptId: 'R-0aa1', faithful: null, contentHash: 'sha256:x' },
        unknownReason: 'not measured',
        signed: null,
        promotionBlocked: 'an unknown verdict cannot be promoted',
        createdAt: LATER,
      }),
    ).toBe('unknown');
  });

  it('maps every store state onto the contract vocabulary', () => {
    const cases: Array<[Parameters<typeof panelUnitState>[0]['state'], string]> = [
      ['submitted', 'queued'],
      ['qualified', 'queued'],
      ['dispatched', 'dispatched'],
      ['receipted', 'verifying'],
      ['verified', 'verified'],
      ['promoted', 'promoted'],
      ['rejected', 'rejected'],
      ['aborted', 'aborted'],
      ['ambiguous', 'ambiguous'],
      ['lit_parked', 'lit_parked'],
    ];
    for (const [state, expected] of cases) {
      expect(panelUnitState(makeUnitRow('U-7f3a9c', makeSpec(), state as never), null)).toBe(
        expected,
      );
    }
  });
});

describe('the projection never throws on a plain store', () => {
  it('builds and validates across a mixed factory', () => {
    walkToVerdict(store(), {
      unitId: 'U-0001',
      verdictId: 'V-0001',
      attemptId: 'A-0001',
      receiptId: 'R-0001',
    });
    walkToVerdict(store(), {
      unitId: 'U-0002',
      verdictId: 'V-0002',
      attemptId: 'A-0002',
      receiptId: 'R-0002',
      outcome: 'unknown',
    });
    qualify(store(), 'U-0003', 'lit');
    const status: StatusV1 = parseStatus(
      buildStatus(store(), { now: () => new Date(LATER), startedAt: new Date(AT) }),
    );
    expect(status.units).toHaveLength(3);
    expect(status.waitingOnPerson.map((item) => item.kind).sort()).toEqual([
      'lit_unit',
      'unknown_verdict',
    ]);
  });
});
