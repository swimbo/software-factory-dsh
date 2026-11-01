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
import { FactoryError } from '@factory/contracts';
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
  summary: 'Show or raise a spend envelope (raising is a human gate)',
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
      .option('--signed-by <identity>', 'the human identity recorded in the ledger'),
  action: (input) => {
    const action = (input.args[0] ?? 'show').trim();
    if (action === 'show' || action === 'status') return runBudgetShow(input);
    if (action === 'raise') return runBudgetRaise(input);
    if (action === 'lower') return runBudgetRaise(input);
    throw new UsageError(`USAGE: factory budget <show|raise|lower>; got ${JSON.stringify(action)}`);
  },
};

export { boolOption };
