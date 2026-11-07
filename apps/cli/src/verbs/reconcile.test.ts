/**
 * `factory budget reconcile` — the honest three-way answer, with fixtures instead of a gateway.
 *
 * The comparison is pure (`reconcileUsage`) and the export parser is pure
 * (`parseGatewayExport`), so these specs need no store, no CLI and no network. That is the
 * point: reconcile is the verb whose whole job is to say "I cannot tell", and a spec that had
 * to stand up the factory to prove that would be testing the wrong thing.
 */
import { describe, expect, it } from 'vitest';
import type { UsageRow } from '@factory/store';
import { parseGatewayExport, reconcileUsage } from './budget.ts';

const row = (input: Partial<UsageRow> & { attemptId: string }): UsageRow => ({
  usageId: `usg-${input.attemptId}`,
  unitId: 'U-1',
  attemptId: input.attemptId,
  tokensIn: input.tokensIn ?? 0,
  tokensOut: input.tokensOut ?? 0,
  costUsd: input.costUsd ?? null,
  gatewayRequestId: input.gatewayRequestId ?? null,
  signedAt: '2026-11-01T12:00:00.000Z',
  recordSha: `sha256:${'a'.repeat(64)}`,
  ceilingCrossed: input.ceilingCrossed ?? false,
});

describe('the gateway export is parsed, not assumed', () => {
  it('reads a JSON array of usage rows', () => {
    const rows = parseGatewayExport(
      JSON.stringify([
        { attemptId: 'A-1', tokensIn: 100, tokensOut: 20, costUsd: 0.01, gatewayRequestId: 'r1' },
      ]),
    );
    expect(rows).toEqual([
      { attemptId: 'A-1', tokensIn: 100, tokensOut: 20, costUsd: 0.01, gatewayRequestId: 'r1' },
    ]);
  });

  it('reads a CSV whose header names the columns', () => {
    const rows = parseGatewayExport(
      'attemptId,tokensIn,tokensOut,costUsd,gatewayRequestId\nA-1,100,20,0.01,r1\nA-2,5,5,,r2\n',
    );
    expect(rows).toEqual([
      { attemptId: 'A-1', tokensIn: 100, tokensOut: 20, costUsd: 0.01, gatewayRequestId: 'r1' },
      // An empty cost cell is unknown, not zero.
      { attemptId: 'A-2', tokensIn: 5, tokensOut: 5, costUsd: null, gatewayRequestId: 'r2' },
    ]);
  });

  it('returns null for anything that is not an export, rather than an empty list', () => {
    // An empty list would mean "the gateway reported nothing", which is a *claim*. These are
    // refusals to claim: prose, a truncated CSV, a header without an attemptId column.
    expect(parseGatewayExport('')).toBeNull();
    expect(parseGatewayExport('the gateway was down')).toBeNull();
    expect(parseGatewayExport('tokensIn,costUsd\n1,2\n')).toBeNull();
    expect(parseGatewayExport('{"rows": [{"attemptId": "A-1"}]}')).toBeNull();
    expect(parseGatewayExport('[{"tokensIn": 1}]')).toBeNull();
  });
});

describe('reconcile says matched, mismatched or unknown — never a quiet zero', () => {
  it('reports a match when the ledger and the gateway agree', () => {
    const report = reconcileUsage(
      [
        row({
          attemptId: 'A-1',
          tokensIn: 100,
          tokensOut: 20,
          costUsd: 0.01,
          gatewayRequestId: 'r1',
        }),
      ],
      [{ attemptId: 'A-1', tokensIn: 100, tokensOut: 20, costUsd: 0.01, gatewayRequestId: 'r1' }],
      'export.csv',
    );
    expect(report.state).toBe('matched');
    expect(report.matched).toBe(1);
    expect(report.mismatched).toBe(0);
    expect(report.attempts[0]).toMatchObject({ state: 'matched', tokenDelta: 0 });
  });

  it('reports a mismatch with the delta, including a ledger row the gateway never billed', () => {
    const report = reconcileUsage(
      [
        row({ attemptId: 'A-1', tokensIn: 100, tokensOut: 20, costUsd: 0.01 }),
        row({ attemptId: 'A-2', tokensIn: 40, tokensOut: 10, costUsd: 0.02 }),
      ],
      [
        { attemptId: 'A-1', tokensIn: 110, tokensOut: 20, costUsd: 0.012, gatewayRequestId: 'r1' },
        { attemptId: 'A-3', tokensIn: 7, tokensOut: 3, costUsd: 0.001, gatewayRequestId: 'r3' },
      ],
      'export.csv',
    );
    expect(report.state).toBe('mismatched');
    expect(report.matched).toBe(0);
    expect(report.mismatched).toBe(3);
    expect(report.attempts.find((a) => a.attemptId === 'A-1')).toMatchObject({
      state: 'mismatched',
      tokenDelta: 10,
      costDeltaUsd: 0.002,
    });
    expect(report.attempts.find((a) => a.attemptId === 'A-2')?.state).toBe('missing-from-gateway');
    expect(report.missingFromLedger).toStrictEqual(['A-3']);
  });

  it('reports unknown, not matched, when there is no export at all', () => {
    const report = reconcileUsage([row({ attemptId: 'A-1', costUsd: 0.5 })], null, '');
    expect(report.state).toBe('unknown');
    expect(report.matched).toBe(0);
    // The ledger rows are still listed — "unknown" is about the comparison, not about the data.
    expect(report.recordedAttempts).toStrictEqual(['A-1']);
    expect(report.gatewayAttempts).toBeNull();
    expect(report.reason).toContain('no gateway export');
  });

  it('treats an unpriced ledger row as unknown agreement, not as a match on zero', () => {
    const report = reconcileUsage(
      // Tokens were reported, no price was: the ledger's cost is `null`.
      [row({ attemptId: 'A-1', tokensIn: 10, tokensOut: 2, costUsd: null })],
      [{ attemptId: 'A-1', tokensIn: 10, tokensOut: 2, costUsd: 0.003, gatewayRequestId: 'r1' }],
      'export.csv',
    );
    // The token counts agree, so this is a match on tokens with an unknown cost delta — and the
    // delta must be `null`, because a zero would say "the ledger priced it at $0.00".
    expect(report.state).toBe('matched');
    expect(report.attempts[0]?.costDeltaUsd).toBeNull();
  });

  it('does not call a comparison with no comparable numbers a match', () => {
    const report = reconcileUsage(
      [row({ attemptId: 'A-1', tokensIn: 10, costUsd: null })],
      [
        {
          attemptId: 'A-1',
          tokensIn: null,
          tokensOut: null,
          costUsd: null,
          gatewayRequestId: null,
        },
      ],
      'export.csv',
    );
    // Nothing on either side could be compared. Silence is not agreement.
    expect(report.state).toBe('mismatched');
  });
});
