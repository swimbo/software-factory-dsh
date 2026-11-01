/**
 * `factory budget` — human gate 2, and the only place a `-y` would be answered "no".
 *
 * A raise is a typed phrase that names the amount (`raise per-unit envelope to
 * 4.00`), compared by `@factory/gates`, so approving a number requires typing the
 * number. A mismatch refuses with `GATE_REQUIRED` (exit 5) and applies nothing —
 * §3.6 is explicit that a partial apply is not a thing that may happen.
 *
 * Lowering is *not* a gate (tightening a ceiling authorises nothing) but still
 * needs `--reason`, and is recorded forever.
 */
import { readFileSync } from 'node:fs';

import { FactoryError } from '@factory/contracts';
import type { UsageRow } from '@factory/store';
import {
  envelopeRaisePhrase,
  GATED_VERBS,
  signEnvelopeRaise,
  type EnvelopeScope,
} from '@factory/gates';

import { UsageError } from '../exit.ts';
import { field, usd } from '../render/format.ts';
import { renderBudgetGate } from '../render/gate.ts';
import { DEFAULT_PER_DAY_USD, DEFAULT_PER_UNIT_USD } from '../context.ts';
import { boolOption, numberOption, textOption, type VerbInput, type VerbSpec } from './types.ts';

void GATED_VERBS;

function scopeOf(raw: string | undefined): EnvelopeScope {
  const scope = (raw ?? 'unit').trim();
  if (scope === 'unit' || scope === 'day' || scope === 'class') return scope;
  throw new UsageError(`USAGE: --scope expects unit, day or class; got ${JSON.stringify(scope)}`);
}

function currentEnvelope(ctx: VerbInput['ctx'], scope: EnvelopeScope): number {
  if (scope === 'unit')
    return ctx.store.currentEnvelope('per-unit')?.amountUsd ?? DEFAULT_PER_UNIT_USD;
  if (scope === 'day') return ctx.store.currentEnvelope('daily')?.amountUsd ?? DEFAULT_PER_DAY_USD;
  // A class envelope is not stored separately in v1; the per-unit ceiling is the
  // only signed ceiling that exists, and pretending otherwise would invent a row.
  throw new UsageError(
    'USAGE: class envelopes are not stored in v1; --scope unit or --scope day are the only signed ceilings',
  );
}

export function runBudgetShow(input: VerbInput): number {
  const { ctx } = input;
  const units = ctx.store.listUnits();
  let spent = 0;
  let reserved = 0;
  let unknownRows = 0;
  for (const unit of units) {
    const spend = ctx.store.spendForUnit(unit.unitId);
    spent += spend.recordedUsd;
    reserved += spend.reservedUsd;
    unknownRows += spend.unknownRows;
  }
  const perUnit = currentEnvelope(ctx, 'unit');
  const perDay = currentEnvelope(ctx, 'day');
  input.emit({
    currency: 'USD',
    priceTableVersion: 'p3',
    telemetry: 'estimated',
    perUnit: { limit: perUnit, kind: 'estimated' },
    perDay: { limit: perDay, spent, reserved, kind: 'estimated', measuredSpent: null },
    unknownCount: unknownRows,
    state: unknownRows > 0 ? 'unknown' : 'ok',
    traceId: ctx.traceId,
  });
  ctx.ui.err(
    `BUDGET  ${'·'} per-unit ${usd(perUnit)} estimated ${'·'} today ${usd(spent)} of ${usd(perDay)} estimated`,
  );
  ctx.ui.err(`  reserved ${usd(reserved)} ${'·'} ${unknownRows} unit(s) recorded spend as unknown`);
  ctx.ui.err('  no billing-grade telemetry: every number here is an estimate, never a charge');
  return 0;
}

/**
 * `factory budget reconcile` — compare what the proxy recorded with what the gateway exported.
 *
 * ND3 is explicit that this is best-effort: the gateway is the source of truth, and the ledger
 * is the factory's *claim* about it. So the only honest outputs are `matched`, `mismatched` and
 * `unknown`. A missing export is **unknown**, never "0 mismatches" — the failure mode this
 * repository keeps finding is a check that cannot run reporting success.
 *
 * The export is the operator's job (a gateway-side CSV or JSON); this verb only reads it, from
 * a path or `-` for stdin, and never makes a network call. A reconcile that called the gateway
 * would need a credential, and a credential in the reconciler is a second place to leak it.
 */
export interface GatewayUsageRow {
  readonly attemptId: string;
  readonly tokensIn: number | null;
  readonly tokensOut: number | null;
  readonly costUsd: number | null;
  readonly gatewayRequestId: string | null;
}

/** Parse the gateway export: JSON array or CSV with a header. Returns `null` when unreadable. */
export function parseGatewayExport(text: string): GatewayUsageRow[] | null {
  const trimmed = text.trim();
  if (trimmed === '') return null;
  if (trimmed.startsWith('[') || trimmed.startsWith('{')) {
    try {
      const parsed = JSON.parse(trimmed) as unknown;
      const rows = Array.isArray(parsed)
        ? parsed
        : (parsed as { usage?: unknown }).usage !== undefined
          ? (parsed as { usage: unknown[] }).usage
          : null;
      if (!Array.isArray(rows)) return null;
      const out: GatewayUsageRow[] = [];
      for (const row of rows) {
        const record = row as Record<string, unknown>;
        if (typeof record['attemptId'] !== 'string') return null;
        out.push({
          attemptId: record['attemptId'],
          tokensIn: numberOrNull(record['tokensIn'] ?? record['tokens_in']),
          tokensOut: numberOrNull(record['tokensOut'] ?? record['tokens_out']),
          costUsd: numberOrNull(record['costUsd'] ?? record['cost_usd']),
          gatewayRequestId: stringOrNull(
            record['gatewayRequestId'] ?? record['gateway_request_id'] ?? record['request_id'],
          ),
        });
      }
      return out;
    } catch {
      return null;
    }
  }
  // CSV: the header names the columns, so a gateway that renames one is a refusal rather than a
  // silent column shift that reconciles the wrong numbers against each other.
  const lines = trimmed.split(/\r?\n/u).filter((line) => line.trim() !== '');
  const header = lines[0]?.split(',').map((cell) => cell.trim().toLowerCase());
  if (header === undefined) return null;
  const column = (name: string): number => header.indexOf(name);
  const attemptColumn = column('attemptid');
  if (attemptColumn === -1) return null;
  const tokensInColumn = column('tokensin');
  const tokensOutColumn = column('tokensout');
  const costColumn = column('costusd');
  const idColumn = column('gatewayrequestid');
  const out: GatewayUsageRow[] = [];
  for (const line of lines.slice(1)) {
    const cells = line.split(',').map((cell) => cell.trim());
    const attemptId = cells[attemptColumn];
    if (attemptId === undefined || attemptId === '') return null;
    out.push({
      attemptId,
      tokensIn: tokensInColumn === -1 ? null : numberOrNull(cells[tokensInColumn]),
      tokensOut: tokensOutColumn === -1 ? null : numberOrNull(cells[tokensOutColumn]),
      costUsd: costColumn === -1 ? null : numberOrNull(cells[costColumn]),
      gatewayRequestId: idColumn === -1 ? null : stringOrNull(cells[idColumn]),
    });
  }
  return out;
}

function numberOrNull(value: unknown): number | null {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string' && value.trim() !== '') {
    const parsed = Number(value.trim());
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

function stringOrNull(value: unknown): string | null {
  return typeof value === 'string' && value.trim() !== '' ? value.trim() : null;
}

/** The comparison itself, pure so a spec can hand it fixtures without a store or a CLI. */
export interface ReconcileReport {
  readonly state: 'matched' | 'mismatched' | 'unknown';
  readonly reason: string | null;
  readonly recordedAttempts: readonly string[];
  readonly gatewayAttempts: readonly string[] | null;
  readonly matched: number;
  readonly mismatched: number;
  readonly missingFromGateway: readonly string[];
  readonly missingFromLedger: readonly string[];
  readonly attempts: readonly ReconcileAttempt[];
}

export interface ReconcileAttempt {
  readonly attemptId: string;
  readonly state: 'matched' | 'mismatched' | 'missing-from-gateway' | 'missing-from-ledger';
  readonly recordedTokensIn: number | null;
  readonly recordedTokensOut: number | null;
  readonly recordedCostUsd: number | null;
  readonly gatewayTokensIn: number | null;
  readonly gatewayTokensOut: number | null;
  readonly gatewayCostUsd: number | null;
  readonly tokenDelta: number | null;
  readonly costDeltaUsd: number | null;
  readonly gatewayRequestIds: readonly string[];
}

interface RecordedTotals {
  tokensIn: number;
  tokensOut: number;
  costUsd: number | null;
  unpriced: number;
  ids: string[];
}

export function reconcileUsage(
  local: readonly UsageRow[],
  gatewayRows: GatewayUsageRow[] | null,
  source: string,
): ReconcileReport {
  const byAttempt = new Map<string, RecordedTotals>();
  for (const row of local) {
    const existing = byAttempt.get(row.attemptId) ?? {
      tokensIn: 0,
      tokensOut: 0,
      costUsd: null as number | null,
      unpriced: 0,
      ids: [] as string[],
    };
    existing.tokensIn += row.tokensIn;
    existing.tokensOut += row.tokensOut;
    if (row.costUsd === null) existing.unpriced += 1;
    else existing.costUsd = (existing.costUsd ?? 0) + row.costUsd;
    if (row.gatewayRequestId !== null) existing.ids.push(row.gatewayRequestId);
    byAttempt.set(row.attemptId, existing);
  }

  if (gatewayRows === null) {
    const reason =
      source === ''
        ? 'no gateway export was given (--usage-file <path|->); spend cannot be reconciled'
        : source === '-'
          ? 'the gateway export on stdin could not be read'
          : `the gateway export at ${source} is unreadable or not a usage table (JSON array or CSV with an attemptId column)`;
    return {
      state: 'unknown',
      reason,
      recordedAttempts: [...byAttempt.keys()].sort(),
      gatewayAttempts: null,
      matched: 0,
      mismatched: 0,
      missingFromGateway: [...byAttempt.keys()].sort(),
      missingFromLedger: [],
      attempts: [],
    };
  }

  const gatewayByAttempt = new Map(gatewayRows.map((row) => [row.attemptId, row]));
  const attempts: ReconcileAttempt[] = [];
  let matched = 0;
  let mismatched = 0;

  for (const [attemptId, recorded] of [...byAttempt.entries()].sort(([a], [b]) =>
    a < b ? -1 : 1,
  )) {
    const gatewayRow = gatewayByAttempt.get(attemptId);
    if (gatewayRow === undefined) {
      attempts.push({
        attemptId,
        state: 'missing-from-gateway',
        recordedTokensIn: recorded.tokensIn,
        recordedTokensOut: recorded.tokensOut,
        recordedCostUsd: recorded.costUsd,
        gatewayTokensIn: null,
        gatewayTokensOut: null,
        gatewayCostUsd: null,
        tokenDelta: null,
        costDeltaUsd: null,
        gatewayRequestIds: recorded.ids,
      });
      mismatched += 1;
      continue;
    }
    gatewayByAttempt.delete(attemptId);
    // A delta that cannot be computed is `null`, never zero: a missing token count on either
    // side makes the comparison unknown, and "unknown" must not look like "agrees".
    const tokenDelta =
      gatewayRow.tokensIn !== null && gatewayRow.tokensOut !== null
        ? gatewayRow.tokensIn + gatewayRow.tokensOut - (recorded.tokensIn + recorded.tokensOut)
        : null;
    const costDeltaUsd =
      recorded.costUsd !== null && gatewayRow.costUsd !== null
        ? gatewayRow.costUsd - recorded.costUsd
        : null;
    const agrees =
      !(tokenDelta === null && costDeltaUsd === null) &&
      (tokenDelta === null || tokenDelta === 0) &&
      (costDeltaUsd === null || Math.abs(costDeltaUsd) < 0.000001);
    if (agrees) matched += 1;
    else mismatched += 1;
    attempts.push({
      attemptId,
      state: agrees ? 'matched' : 'mismatched',
      recordedTokensIn: recorded.tokensIn,
      recordedTokensOut: recorded.tokensOut,
      recordedCostUsd: recorded.costUsd,
      gatewayTokensIn: gatewayRow.tokensIn,
      gatewayTokensOut: gatewayRow.tokensOut,
      gatewayCostUsd: gatewayRow.costUsd,
      tokenDelta,
      costDeltaUsd,
      gatewayRequestIds: recorded.ids,
    });
  }

  const missingFromLedger = [...gatewayByAttempt.keys()].sort();
  for (const attemptId of missingFromLedger) {
    const gatewayRow = gatewayByAttempt.get(attemptId);
    mismatched += 1;
    attempts.push({
      attemptId,
      state: 'missing-from-ledger',
      recordedTokensIn: null,
      recordedTokensOut: null,
      recordedCostUsd: null,
      gatewayTokensIn: gatewayRow?.tokensIn ?? null,
      gatewayTokensOut: gatewayRow?.tokensOut ?? null,
      gatewayCostUsd: gatewayRow?.costUsd ?? null,
      tokenDelta: null,
      costDeltaUsd: null,
      gatewayRequestIds: [],
    });
  }

  return {
    state: mismatched === 0 ? 'matched' : 'mismatched',
    reason: null,
    recordedAttempts: [...byAttempt.keys()].sort(),
    gatewayAttempts: [...new Set(gatewayRows.map((row) => row.attemptId))].sort(),
    matched,
    mismatched,
    missingFromGateway: attempts
      .filter((attempt) => attempt.state === 'missing-from-gateway')
      .map((attempt) => attempt.attemptId),
    missingFromLedger,
    attempts,
  };
}

export function runBudgetReconcile(input: VerbInput): number {
  const { ctx } = input;
  const source = textOption(input.options, 'usage-file') ?? '';
  let exportText: string | null = null;
  if (source === '-') {
    try {
      exportText = readFileSync(0, 'utf8');
    } catch {
      exportText = null;
    }
  } else if (source !== '') {
    try {
      exportText = readFileSync(source, 'utf8');
    } catch {
      exportText = null;
    }
  }
  const gatewayRows = exportText === null ? null : parseGatewayExport(exportText);
  const report = reconcileUsage(ctx.store.listUsage(), gatewayRows, source);

  if (report.state === 'unknown') {
    input.emit({ ...report, traceId: ctx.traceId });
    ctx.ui.err(`RECONCILE  UNKNOWN — ${report.reason ?? 'unknown'}`);
    ctx.ui.err('  unknown is not a pass: nothing was compared, so nothing is claimed');
    throw new FactoryError('USAGE_UNRECONCILED', `USAGE_UNRECONCILED: ${report.reason ?? ''}`, {
      source,
    });
  }

  input.emit({ ...report, traceId: ctx.traceId });
  if (report.mismatched === 0) {
    ctx.ui.err(`RECONCILE  matched ${report.matched} attempt(s) against the gateway export`);
    return 0;
  }
  for (const attempt of report.attempts) {
    if (attempt.state === 'matched') continue;
    const delta =
      attempt.costDeltaUsd === null ? 'unknown' : `${attempt.costDeltaUsd.toFixed(4)} USD`;
    ctx.ui.err(`  ${attempt.state}: ${attempt.attemptId} (cost delta ${delta})`);
  }
  throw new FactoryError(
    'USAGE_UNRECONCILED',
    `USAGE_UNRECONCILED: ${String(report.mismatched)} attempt(s) do not agree with the gateway export; ` +
      `the ledger is the factory's claim, not the gateway's invoice`,
    { matched: report.matched, mismatched: report.mismatched },
  );
}

export function runBudgetRaise(input: VerbInput): number {
  const { ctx } = input;
  const scope = scopeOf(textOption(input.options, 'scope'));
  const toUsd = numberOption(
    input.options,
    'to',
    'Usage: factory budget raise --to <amount> --reason "<why>"',
  );
  const reason = textOption(input.options, 'reason');
  if (reason === undefined) {
    throw new UsageError(
      'USAGE: --reason is required. A ceiling change with no recorded reason is an unauditable decision.',
    );
  }

  const fromUsd = currentEnvelope(ctx, scope);
  const phrase = envelopeRaisePhrase(scope, toUsd);
  const raising = toUsd > fromUsd;
  const typed = textOption(input.options, 'confirm');

  // A raise prints the gate block before it refuses: the operator must see the
  // numbers the phrase is about, not just "phrase did not match".
  if (raising && typed !== phrase) {
    const gateBlock = renderBudgetGate({
      scope,
      scopeKey: textOption(input.options, 'for') ?? null,
      fromUsd,
      toUsd,
      phrase,
      reason,
      spentTodayUsd: spentToday(ctx),
      dailyLimitUsd: currentEnvelope(ctx, 'day'),
    });
    for (const line of gateBlock.trimEnd().split('\n')) ctx.ui.err(line);
    throw new FactoryError(
      'GATE_REQUIRED',
      `GATE_REQUIRED: budget-envelope-raise. ${typed === undefined ? 'No phrase was typed' : 'The phrase did not match'}; ` +
        `the envelope is unchanged (${usd(fromUsd)}). Sign by typing exactly: "${phrase}" ` +
        `(non-interactive: --confirm "${phrase}")`,
      { gate: 'budget-envelope-raise', scope, fromUsd, toUsd, expectedPhrase: phrase },
    );
  }

  const scopeKey = textOption(input.options, 'for');
  const decision = signEnvelopeRaise({
    scope,
    ...(scopeKey === undefined ? {} : { scopeKey }),
    fromUsd,
    toUsd,
    reason,
    typedPhrase: typed ?? '',
    expectedPhrase: phrase,
    nowIso: ctx.nowIso(),
  });

  ctx.store.raiseEnvelope({
    envelopeId: decision.envelopeId,
    scope: scope === 'unit' ? 'per-unit' : 'daily',
    amountUsd: decision.toUsd,
    effectiveFrom: decision.effectiveFrom,
    supersedes: null,
    signedBy: textOption(input.options, 'signedBy') ?? 'operator',
    reason: decision.reasonText,
  });

  input.emit({
    scope,
    scopeKey: decision.scopeKey,
    fromUsd: decision.fromUsd,
    toUsd: decision.toUsd,
    envelopeId: decision.envelopeId,
    gated: decision.gated,
    applied: decision.applied,
    effectiveFrom: decision.effectiveFrom,
    reason,
    gateDecisionId: decision.decision.gateDecisionId,
    traceId: ctx.traceId,
  });

  if (decision.applied) {
    const noun = scope === 'unit' ? 'per-unit envelope' : 'daily envelope';
    ctx.ui.err(
      `GateDecision ${decision.decision.gateDecisionId} recorded ${'·'} ${noun} = ${usd(decision.toUsd)}`,
    );
    ctx.ui.err('The ledger entry is append-only. An agent cannot write it.');
  } else {
    ctx.ui.err(`envelope unchanged at ${usd(decision.toUsd)}; nothing was applied`);
  }
  return 0;
}

function spentToday(ctx: VerbInput['ctx']): number {
  let spent = 0;
  for (const unit of ctx.store.listUnits())
    spent += ctx.store.spendForUnit(unit.unitId).recordedUsd;
  return spent;
}

export const budgetVerb: VerbSpec = {
  name: 'budget',
  verb: 'budget',
  summary: 'Show or raise a spend envelope, or reconcile metered usage',
  arguments: ['[action]'],
  configure: (command) =>
    command
      .option('--to <amount>', 'the new ceiling in USD, e.g. 4.00')
      .option('--reason <text>', 'why the ceiling changes (required)')
      .option(
        '--confirm <phrase>',
        'the typed phrase, exactly: raise per-unit envelope to <amount>',
      )
      .option('--scope <scope>', 'unit (default) or day', 'unit')
      .option('--for <key>', 'the unit id or date the ceiling applies to')
      .option('--signed-by <identity>', 'the human identity recorded in the ledger')
      .option('--usage-file <path>', "the gateway's usage export (JSON or CSV), or - for stdin"),
  action: (input) => {
    const action = (input.args[0] ?? 'show').trim();
    if (action === 'show' || action === 'status') return runBudgetShow(input);
    if (action === 'raise') return runBudgetRaise(input);
    if (action === 'lower') return runBudgetRaise(input);
    if (action === 'reconcile') return runBudgetReconcile(input);
    throw new UsageError(
      `USAGE: factory budget <show|raise|lower|reconcile>; got ${JSON.stringify(action)}`,
    );
  },
};

export { boolOption };
