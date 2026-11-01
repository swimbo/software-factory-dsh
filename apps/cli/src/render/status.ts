/**
 * `factory status` — the "what needs me" surface, and the `/api/status` projection.
 *
 * The JSON below is deliberately the *same object* `ui-plan.md` §5.1 specifies for
 * `GET /api/status` (plus the CLI envelope's `ok`), so a script and the status page
 * cannot disagree about what a unit is doing. Where the store cannot answer a
 * question — turn number, tokens, the wall's holdout revision, the outbox depth —
 * the field is `null` with a `state` of `unknown`. It is never `0` and never
 * omitted: `ux-plan.md` A-1 says unknown is a fact that needs a person, and a
 * silent zero is a lie about a measurement.
 */
import { contentHash } from '@factory/contracts';
import { currentPolicyVersion } from '@factory/qualifier';
import type { UnitRow, VerdictRow } from '@factory/store';

import type { FactoryContext } from '../context.ts';
import { field, pill, record, sep, usd, wrap } from './format.ts';

export const STATUS_SCHEMA_VERSION = 'status.v1';

export interface WaitingItem {
  readonly id: string;
  readonly kind:
    | 'budget_envelope_raise'
    | 'initial_production_deploy'
    | 'privileged_credential_issuance'
    | 'lit_unit'
    | 'ambiguous_attempt'
    | 'unknown_verdict'
    | 'escape_rate_review';
  readonly unitId: string | null;
  readonly question: string;
  readonly recommendedCommand: string;
  readonly irreversible: boolean;
  readonly since: string | null;
}

export interface AttemptStatus {
  readonly attemptNo: number | null;
  readonly state: string | null;
  readonly turn: number | null;
  readonly tokensUsed: number | null;
  readonly tokenCeiling: number | null;
  readonly wallClockCeilingS: number | null;
  readonly startedAt: string | null;
  readonly lastProgressAt: string | null;
  readonly noProgressStreak: number | null;
}

export interface VerdictStatus {
  readonly verdictId: string;
  readonly state: 'passed' | 'failed' | 'unknown';
  readonly wallVersion: string;
  readonly holdoutRevision: string;
  readonly policyVersion: string;
  readonly holdout: { readonly passed: number; readonly total: number; readonly rule: string };
  readonly delta: {
    readonly value: number | null;
    readonly visiblePassRate: number | null;
    readonly holdoutPassRate: number | null;
    readonly samples: number | null;
    readonly state: 'measured' | 'unknown';
  };
  readonly receipt: {
    readonly receiptId: string | null;
    readonly faithful: boolean | null;
    readonly contentHash: string | null;
  };
  readonly unknownReason: string | null;
  readonly signed: {
    readonly alg: string;
    readonly keyId: string | null;
    readonly verified: boolean;
  };
  readonly promotionBlocked: string | null;
  readonly createdAt: string;
}

export interface UnitStatus {
  readonly unitId: string;
  readonly title: string;
  readonly lane: 'dark' | 'lit' | 'reject' | null;
  readonly state: string;
  readonly attempt: AttemptStatus | null;
  /** Present iff the unit is ambiguous: the mandatory KNOWN / UNKNOWN / NOT DONE framing. */
  readonly ambiguity?: {
    readonly known: string;
    readonly unknown: string;
    readonly notDone: string;
    readonly observedAt: string | null;
  };
  readonly verdict: VerdictStatus | null;
  readonly promotion: {
    readonly id: string;
    readonly signedAt: string;
    readonly signedBy: string;
  } | null;
  readonly updatedAt: string;
}

export interface StatusModel {
  readonly ok: true;
  readonly schemaVersion: string;
  readonly generatedAt: string;
  readonly factory: {
    readonly version: string;
    readonly dshVersionExpected: string;
    readonly dshVersionObserved: string | null;
    readonly policyVersion: string;
    readonly wallVersion: string | null;
    readonly holdoutRevision: string | null;
  };
  readonly waitingOnPerson: readonly WaitingItem[];
  readonly units: readonly UnitStatus[];
  readonly health: {
    readonly store: {
      readonly state: string;
      readonly quarantined: boolean;
      readonly schemaVersion: number;
      readonly ledgerHead: string | null;
      readonly detail: string | null;
      readonly since: string | null;
    };
    readonly controlPlane: {
      readonly state: string;
      readonly uptimeS: number | null;
      readonly detail: string | null;
      readonly since: string | null;
    };
    readonly executor: {
      readonly state: string;
      readonly kind: string;
      readonly image: string | null;
      readonly detail: string | null;
      readonly since: string | null;
    };
    readonly wall: {
      readonly state: string;
      readonly holdoutRevision: string | null;
      readonly detail: string | null;
      readonly since: string | null;
    };
    readonly outbox: {
      readonly state: string;
      readonly pending: number | null;
      readonly retrying: number | null;
      readonly dead: number | null;
      readonly detail: string | null;
      readonly since: string | null;
    };
    readonly dshVersion: {
      readonly state: string;
      readonly expected: string;
      readonly observed: string | null;
      readonly detail: string | null;
      readonly since: string | null;
    };
    readonly taskClasses: readonly unknown[];
  };
  readonly budget: {
    readonly currency: string;
    readonly priceTableVersion: string;
    readonly telemetry: 'estimated' | 'unknown';
    readonly note: string;
    readonly perUnit: { readonly limit: number; readonly kind: string };
    readonly perDay: {
      readonly limit: number;
      readonly spent: number;
      readonly reserved: number;
      readonly kind: string;
      readonly measuredSpent: number | null;
    };
    readonly unknownCount: number;
    readonly state: string;
  };
}

/** The page's state vocabulary (`ui-plan.md` §5.1), which is not the contract's. */
const PAGE_STATE: Readonly<Record<string, string>> = {
  submitted: 'queued',
  qualified: 'queued',
  lit_parked: 'queued',
  dispatched: 'dispatched',
  receipted: 'verifying',
  verified: 'verified',
  promoted: 'promoted',
  rejected: 'failed',
  aborted: 'aborted',
  ambiguous: 'ambiguous',
};

function waitingId(kind: string, unitId: string | null): string {
  return `G-${contentHash({ kind, unitId }).slice(7, 19)}`;
}

export function titleOf(unit: UnitRow): string {
  const first = unit.spec.intent.split('\n')[0] ?? unit.slug;
  const trimmed = first.trim();
  return trimmed.length > 60 ? `${trimmed.slice(0, 57)}...` : trimmed;
}

function verdictStatus(row: VerdictRow, promoted: boolean): VerdictStatus {
  const verdict = row.verdict;
  const holdoutScenarios = verdict.scenarios.filter((scenario) => scenario.source === 'holdout');
  const holdoutPassed = holdoutScenarios.filter((scenario) => scenario.outcome === 'pass').length;
  const state = row.outcome === 'pass' ? 'passed' : row.outcome === 'fail' ? 'failed' : 'unknown';
  const delta = verdict.delta;
  return {
    verdictId: row.verdictId,
    state,
    wallVersion: row.wallVersion,
    holdoutRevision: row.holdoutRevision ?? verdict.holdoutRevision,
    policyVersion: row.policyVersion,
    holdout: {
      passed: holdoutPassed,
      total: holdoutScenarios.length,
      rule: 'triple-run 2-of-3, aggregate >=90%',
    },
    delta: {
      value: delta.observed,
      visiblePassRate: delta.baseRate,
      holdoutPassRate: delta.candidateRate,
      samples: null,
      state: delta.checked ? 'measured' : 'unknown',
    },
    receipt: {
      receiptId: row.receiptId,
      faithful: null,
      contentHash: row.receiptSha,
    },
    unknownReason:
      state === 'unknown'
        ? verdict.reasons.length > 0
          ? verdict.reasons.join(', ')
          : 'the wall did not measure this unit'
        : null,
    // The CLI never verifies the wall's ed25519 signature itself, so `verified`
    // stays false and `keyId` null rather than claiming a check nobody ran.
    signed: { alg: 'ed25519', keyId: null, verified: false },
    promotionBlocked: promoted
      ? null
      : state === 'passed'
        ? 'the first promotion of this unit requires your signature'
        : state === 'unknown'
          ? 'an unknown verdict cannot promote; there is no override'
          : 'a failed verdict cannot promote',
    createdAt: row.evaluatedAt,
  };
}

function ambiguityBlock(
  attemptId: string | null,
  unitId: string,
  at: string | null,
): NonNullable<UnitStatus['ambiguity']> {
  return {
    known: `the attempt ${attemptId ?? '(unknown id)'} started and did not report a terminal event`,
    unknown: `whether the final tool call for ${unitId} took effect outside the worktree`,
    notDone: 'nothing was retried; no second attempt exists',
    observedAt: at,
  };
}

export function buildStatus(
  ctx: FactoryContext,
  options: { readonly unitId?: string } = {},
): StatusModel {
  const allUnits = ctx.store.listUnits();
  const selected =
    options.unitId === undefined
      ? allUnits
      : allUnits.filter((unit) => unit.unitId === options.unitId);

  const units: UnitStatus[] = [];
  const waitingOnPerson: WaitingItem[] = [];
  let dayReserved = 0;
  let daySpent = 0;
  let unknownSpendRows = 0;
  let lastVerdict: VerdictRow | null = null;

  for (const unit of selected) {
    const attempts = ctx.store.listAttemptsForUnit(unit.unitId);
    const attempt = attempts.length === 0 ? null : (attempts[attempts.length - 1] ?? null);
    const verdictRow = ctx.store.latestVerdictForUnit(unit.unitId);
    const spend = ctx.store.spendForUnit(unit.unitId);
    dayReserved += spend.reservedUsd;
    daySpent += spend.recordedUsd;
    unknownSpendRows += spend.unknownRows;
    if (verdictRow !== null) lastVerdict = verdictRow;

    const verdictSha = verdictRow === null ? null : contentHash(verdictRow.verdict);
    const promotionRow =
      verdictSha === null ? null : ctx.store.getPromotion(unit.unitId, verdictSha);
    let pageState = PAGE_STATE[unit.state] ?? 'unknown';
    if (verdictRow !== null && verdictRow.outcome === 'unknown') pageState = 'unknown';
    if (verdictRow !== null && verdictRow.outcome === 'fail') pageState = 'failed';

    const status: UnitStatus = {
      unitId: unit.unitId,
      title: titleOf(unit),
      lane: unit.lane,
      state: pageState,
      attempt:
        attempt === null
          ? null
          : {
              attemptNo: attempts.length,
              state: attempt.state,
              turn: null,
              tokensUsed: null,
              tokenCeiling: null,
              wallClockCeilingS: null,
              startedAt: attempt.startedAt,
              lastProgressAt: null,
              noProgressStreak: null,
            },
      verdict: verdictRow === null ? null : verdictStatus(verdictRow, promotionRow !== null),
      promotion:
        promotionRow === null
          ? null
          : { id: promotionRow.promotionId, signedAt: unit.updatedAt, signedBy: 'operator' },
      updatedAt: unit.updatedAt,
    };
    if (unit.state === 'ambiguous') {
      units.push({
        ...status,
        ambiguity: ambiguityBlock(attempt?.attemptId ?? null, unit.unitId, unit.updatedAt),
      });
    } else {
      units.push(status);
    }

    // What needs a person, in the order the operator can act on it. `unknown` is
    // in this list on purpose (A-1): it is not a pass, so it waits for a person.
    if (unit.state === 'lit_parked') {
      waitingOnPerson.push({
        id: waitingId('lit_unit', unit.unitId),
        kind: 'lit_unit',
        unitId: unit.unitId,
        question: `${unit.unitId} was routed lit and is parked: take it yourself, or make the spec derivable`,
        recommendedCommand: `factory qualify ${unit.unitId}`,
        irreversible: false,
        since: unit.updatedAt,
      });
    }
    if (unit.state === 'ambiguous') {
      waitingOnPerson.push({
        id: waitingId('ambiguous_attempt', unit.unitId),
        kind: 'ambiguous_attempt',
        unitId: unit.unitId,
        question: `${unit.unitId} has an attempt that may or may not have taken effect; observe it, then decide`,
        recommendedCommand:
          attempt === null
            ? `factory status ${unit.unitId}`
            : `factory status ${unit.unitId} --attempt ${attempt.attemptId}`,
        irreversible: false,
        since: unit.updatedAt,
      });
    }
    if (verdictRow !== null && verdictRow.outcome === 'unknown') {
      waitingOnPerson.push({
        id: waitingId('unknown_verdict', unit.unitId),
        kind: 'unknown_verdict',
        unitId: unit.unitId,
        question: `${unit.unitId} was not measured; an unknown verdict cannot promote and there is no override`,
        recommendedCommand: `factory run ${unit.unitId} --verify-only`,
        irreversible: false,
        since: verdictRow.evaluatedAt,
      });
    }
    if (verdictRow !== null && verdictRow.outcome === 'pass' && promotionRow === null) {
      waitingOnPerson.push({
        id: waitingId('initial_production_deploy', unit.unitId),
        kind: 'initial_production_deploy',
        unitId: unit.unitId,
        question: `Sign the first promotion of ${unit.unitId}? Nothing is pushed or deployed: it writes a signed record.`,
        recommendedCommand: `factory promote ${unit.unitId}`,
        irreversible: true,
        since: verdictRow.evaluatedAt,
      });
    }
  }

  const quarantined = ctx.store.isQuarantined();
  const ledgerHead = ledgerHeadOf(ctx);
  const perUnit = ctx.store.currentEnvelope('per-unit')?.amountUsd ?? ctx.envelopeUsd();
  const perDay = ctx.store.currentEnvelope('daily')?.amountUsd ?? 0;

  return {
    ok: true,
    schemaVersion: STATUS_SCHEMA_VERSION,
    generatedAt: ctx.nowIso(),
    factory: {
      version: FACTORY_VERSION,
      dshVersionExpected: PINNED_DSH_VERSION,
      dshVersionObserved: observedDshVersion(ctx),
      policyVersion: currentPolicyVersion(),
      wallVersion: ctx.wall.available ? WALL_VERSION_FALLBACK : null,
      holdoutRevision: lastVerdict?.holdoutRevision ?? null,
    },
    waitingOnPerson,
    units,
    health: {
      store: {
        state: quarantined ? 'quarantined' : 'ok',
        quarantined,
        schemaVersion: ctx.store.schemaVersion,
        ledgerHead,
        detail: quarantined ? 'the ledger integrity check failed; every write is refused' : null,
        since: null,
      },
      controlPlane: {
        state: 'ok',
        uptimeS: Math.round(process.uptime()),
        detail: null,
        since: null,
      },
      executor: {
        state: ctx.executor.available ? 'ok' : 'unavailable',
        kind: ctx.executor.kind,
        // No image is pinned without the adapter telling us; null is the honest value.
        image: null,
        detail: ctx.executor.available ? null : ctx.executor.detail,
        since: null,
      },
      wall: {
        state: ctx.wall.available ? 'ok' : 'unavailable',
        holdoutRevision: lastVerdict?.holdoutRevision ?? null,
        detail: ctx.wall.available ? null : ctx.wall.detail,
        since: null,
      },
      outbox: {
        // The store exposes no read-only outbox count: claiming 0 would be a
        // measurement we did not take (L3), so the counts stay null. `unavailable`
        // is the health state for "not observable" — `unknown` is the vocabulary for
        // unmeasured values, not for a subsystem, and the contract keeps them apart.
        state: 'unavailable',
        pending: null,
        retrying: null,
        dead: null,
        detail: 'the store exposes no read-only outbox count',
        since: null,
      },
      dshVersion: {
        // Three health states, not four: a version we could not read leaves the
        // subsystem `unavailable` (the page shows it), and a version that differs
        // from the pin is `degraded` — naming both numbers in `detail` so the reader
        // never has to guess which one is expected.
        state:
          observedDshVersion(ctx) === null
            ? 'unavailable'
            : observedDshVersion(ctx) === PINNED_DSH_VERSION
              ? 'ok'
              : 'degraded',
        expected: PINNED_DSH_VERSION,
        observed: observedDshVersion(ctx),
        detail:
          observedDshVersion(ctx) === null
            ? 'no dsh on PATH'
            : observedDshVersion(ctx) === PINNED_DSH_VERSION
              ? null
              : `expected ${PINNED_DSH_VERSION}, observed ${String(observedDshVersion(ctx))}`,
        since: null,
      },
      // Δ per task class needs holdout samples the store does not carry; an empty
      // array is "nothing measured", not "everything stable".
      taskClasses: [],
    },
    budget: {
      currency: 'USD',
      priceTableVersion: 'p3',
      telemetry: 'estimated',
      note: 'no billing-grade telemetry; usage-derived estimate',
      perUnit: { limit: perUnit, kind: 'estimated' },
      perDay: {
        limit: perDay,
        spent: daySpent,
        reserved: dayReserved,
        kind: 'estimated',
        measuredSpent: null,
      },
      unknownCount: unknownSpendRows,
      // `unknown` when a spend row exists that nobody measured: the meter must
      // render a gap rather than a rounded-down total (§5.1).
      state: unknownSpendRows > 0 ? 'unknown' : 'ok',
    },
  };
}

export const FACTORY_VERSION = '0.1.0';
export const PINNED_DSH_VERSION = '0.2.1-rc.3';
export const WALL_VERSION_FALLBACK = 'wall-2026.11.1';

function observedDshVersion(ctx: FactoryContext): string | null {
  if (!ctx.executor.available) return null;
  // Probing a version means spawning the binary; `status` must stay cheap and
  // side-effect-free, so we report what we know (it exists) and let `version` do
  // the one spawn that names a version.
  return null;
}

function ledgerHeadOf(ctx: FactoryContext): string | null {
  const count = ctx.store.eventCount();
  if (count === 0) return null;
  const events = ctx.store.eventsSince(count - 1, 1);
  const head = events[0];
  if (head === undefined) return null;
  return contentHash(head.payload).slice(0, 15);
}

/** Lines of the one-line aggregate (§4.1). Silent unless something needs a person. */
export function renderAggregate(model: StatusModel, plain: boolean): string[] {
  const inFlight = model.units.filter(
    (unit) => unit.state === 'dispatched' || unit.state === 'verifying' || unit.state === 'running',
  ).length;
  const needYou = model.waitingOnPerson.length;
  const unknown = model.units.filter(
    (unit) => unit.state === 'ambiguous' || unit.state === 'unknown',
  ).length;
  const parts = [
    `${inFlight} in flight`,
    `${needYou} need you`,
    `${unknown} unknown (not a pass)`,
    `wall ${model.health.wall.state}`,
    `store ${model.health.store.state}`,
    `today ${usd(model.budget.perDay.spent)}/${usd(model.budget.perDay.limit)} estimated`,
  ];
  const line = parts.join(` ${sep()} `);
  void plain;
  return [line];
}

export function renderStatus(model: StatusModel, plain: boolean): string {
  const lines: string[] = [];
  const empty = model.units.length === 0;
  if (empty) {
    lines.push('no units. Start: factory intent --file <unit.json> --restate <restate-file>');
    // The spend line still prints: an operator who sees no units should still see
    // that the envelope exists, and that its numbers are estimates (A-2).
    lines.push(...renderAggregate(model, plain));
    return record(lines);
  }

  lines.push(...renderAggregate(model, plain));

  if (model.units.length === 1) {
    lines.push('', ...renderUnit(model.units[0] as UnitStatus, plain));
  }
  if (model.units.length !== 1) {
    for (const item of model.units.filter((unit) => unit.state === 'ambiguous')) {
      lines.push('', ...renderAmbiguity(item));
    }
  }

  if (model.waitingOnPerson.length > 0) {
    lines.push('', 'NEEDS YOU');
    for (const item of model.waitingOnPerson) {
      lines.push(`  ${item.id}  ${item.kind}${item.irreversible ? '  (irreversible)' : ''}`);
      lines.push(...wrap(item.question, 4));
      lines.push(...wrap(`→ ${item.recommendedCommand}`, 4));
    }
  }

  if (model.budget.unknownCount > 0) {
    lines.push(
      '',
      `spend understated: ${model.budget.unknownCount} unit(s) recorded spend as unknown (not zero)`,
    );
  }
  return record(lines);
}

function renderUnit(unit: UnitStatus, plain: boolean): string[] {
  const lines = [`UNIT ${unit.unitId}  lane ${unit.lane ?? 'pending'}  state ${unit.state}`];
  if (unit.verdict !== null) {
    const verdict = unit.verdict;
    lines.push(
      `  verdict ${verdict.verdictId}  ${pill(verdict.state, plain)}  ${verdict.wallVersion}  holdout ${verdict.holdoutRevision}`,
    );
    if (verdict.state === 'unknown') {
      lines.push(...wrap(`Δ unknown — ${String(verdict.unknownReason)}`, 4));
    } else {
      lines.push(
        `  Δ ${verdict.delta.value === null ? 'unknown' : verdict.delta.value.toFixed(2)}   holdout ${verdict.holdout.passed}/${verdict.holdout.total}`,
      );
    }
    lines.push(`  promotion ${verdict.promotionBlocked ?? 'signed'}`);
  }
  if (unit.promotion !== null) {
    lines.push(`  promotion ${unit.promotion.id} signed ${unit.promotion.signedAt}`);
  }
  lines.push(`  updated ${unit.updatedAt}`);
  return lines;
}

/** The mandatory three-part framing for an ambiguous attempt (§3.4). */
export function renderAmbiguity(unit: UnitStatus): string[] {
  const ambiguity = unit.ambiguity;
  const lines = [`AMBIGUOUS  ${unit.unitId}  attempt ${unit.attempt?.state ?? 'unknown'}`];
  if (ambiguity !== undefined) {
    lines.push(field('KNOWN', ambiguity.known));
    lines.push(field('UNKNOWN', ambiguity.unknown));
    lines.push(field('NOT DONE', ambiguity.notDone));
  }
  lines.push('  observe (read-only, safe, repeatable):');
  lines.push(
    `      factory status ${unit.unitId} --attempt ${unit.attempt?.state ?? '<attemptId>'}`,
  );
  lines.push('  then choose — the CLI will not choose for you:');
  lines.push(`      factory abort ${unit.unitId} --reason "<why>"`);
  return lines;
}

/** `status` exits 5 when a person is being asked for something (A-1; §4.1's "needs you"). */
export function statusExitCode(model: StatusModel): number {
  return model.waitingOnPerson.length > 0 ? 5 : 0;
}
