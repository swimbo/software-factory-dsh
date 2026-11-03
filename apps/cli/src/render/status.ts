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
import { dirname } from 'node:path';

import { contentHash } from '@factory/contracts';
import { currentPolicyVersion } from '@factory/qualifier';
import { probeTopology, type UnitRow, type VerdictRow } from '@factory/store';

import { DEFAULT_PER_DAY_USD, type FactoryContext } from '../context.ts';
import { outboxCounts } from '../effects.ts';
import { readOccupancy } from '../dispatch-limit.ts';
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
    /** Which topology this instance is running under (ND2) — a fact, not a health state. */
    readonly topology: {
      readonly kind: 'two-uid' | 'single-uid';
      readonly reason: string;
      readonly claim: string;
    };
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
    readonly taskClasses: readonly {
      readonly class: string;
      readonly delta: {
        readonly value: number | null;
        readonly samples: number;
        readonly state: string;
      };
      readonly escapeRate: {
        readonly value: number | null;
        readonly samples: number;
        readonly state: string;
      };
    }[];
  };
  readonly budget: {
    readonly currency: string;
    readonly priceTableVersion: string;
    readonly telemetry: 'estimated' | 'unknown';
    readonly note: string;
    readonly perUnit: { readonly limit: number; readonly kind: string };
    readonly perDay: {
      readonly limitIsDefault?: boolean;
      readonly limit: number;
      readonly spent: number;
      readonly reserved: number;
      readonly kind: string;
      readonly measuredSpent: number | null;
    };
    readonly unknownCount: number;
    readonly state: string;
  };
  /**
   * The dispatch ceilings and how full they are.
   *
   * Shaped like `budget` on purpose: a `limit` with `limitIsDefault` when the number is the
   * documented default rather than an envelope the operator set, and a `state` of `unknown`
   * — never `0` — when the occupancy could not be read. A floor plan that shows a busy
   * factory as empty is worse than one that shows nothing.
   */
  readonly concurrency: {
    readonly attempts: {
      readonly limit: number;
      readonly limitIsDefault: boolean;
      readonly inFlight: number | null;
      readonly state: string;
    };
    readonly walls: {
      readonly limit: number;
      readonly limitIsDefault: boolean;
      readonly inFlight: number | null;
      readonly state: string;
    };
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

/**
 * The topology this process is actually running under.
 *
 * Read from the marker beside the store rather than from a build flag: the claim "the wall is a
 * separate principal" is true only on a host that was provisioned and verified, and a status page
 * that printed it from a constant would be the exact failure ND2 exists to prevent. No subprocess
 * here — `probeTopology` stats one file and compares one uid.
 */
function topologyOf(ctx: FactoryContext): StatusModel['factory']['topology'] {
  const decision = probeTopology(dirname(ctx.store.location));
  return { kind: decision.kind, reason: decision.reason, claim: decision.claim };
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
  const unitEnvelope = ctx.store.currentEnvelope('per-unit');
  const dailyEnvelope = ctx.store.currentEnvelope('daily');
  const perUnit = unitEnvelope?.amountUsd ?? ctx.envelopeUsd();
  // `?? 0` here meant "no daily envelope has ever been recorded" rendered as
  // "$0 limit", which reads as an exhausted budget — the opposite of the truth. The
  // documented default is a *default*, so the note below says so and the line is marked.
  const perDay = dailyEnvelope?.amountUsd ?? DEFAULT_PER_DAY_USD;
  const perDayIsDefault = dailyEnvelope === null;

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
      topology: topologyOf(ctx),
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
      outbox: outboxHealth(ctx),
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
      // Δ per task class, aggregated from verdicts that actually measured one. An empty
      // array means no verdict carries a checked Δ — "nothing measured", never
      // "everything stable" — and the human renderer says which of the two it is.
      taskClasses: taskClassHealth(ctx),
    },
    budget: {
      currency: 'USD',
      priceTableVersion: 'p3',
      telemetry: 'estimated',
      note:
        'no billing-grade telemetry; usage-derived estimate' +
        (perDayIsDefault
          ? `; the daily limit is the documented default ($${String(DEFAULT_PER_DAY_USD)}/day), not an operator envelope`
          : ''),
      perUnit: { limit: perUnit, kind: 'estimated' },
      perDay: {
        limitIsDefault: perDayIsDefault,
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
    concurrency: concurrencyHealth(ctx),
  };
}

/**
 * Occupancy, as of this read.
 *
 * `inFlight: null` with `state: 'unknown'` when the store could not be counted: the page
 * must say "I do not know" rather than print a zero that reads as "nothing is running".
 */
function concurrencyHealth(ctx: FactoryContext): StatusModel['concurrency'] {
  // No unit is excluded here: `status` reports the factory, not one unit's measurement.
  const read = readOccupancy(ctx.store);
  const { limits, env } = ctx;
  const attemptsLimit = limits.maxConcurrentAttempts;
  const wallsLimit = limits.maxConcurrentWalls;
  const attemptsIsDefault = (env['FACTORY_MAX_CONCURRENT_ATTEMPTS'] ?? '').trim() === '';
  const wallsIsDefault = (env['FACTORY_MAX_CONCURRENT_WALLS'] ?? '').trim() === '';
  return {
    attempts: {
      limit: attemptsLimit,
      limitIsDefault: attemptsIsDefault,
      inFlight: read.ok ? read.occupancy.attempts : null,
      state: read.ok ? (read.occupancy.attempts >= attemptsLimit ? 'at-ceiling' : 'ok') : 'unknown',
    },
    walls: {
      limit: wallsLimit,
      limitIsDefault: wallsIsDefault,
      inFlight: read.ok ? read.occupancy.walls : null,
      state: read.ok ? (read.occupancy.walls >= wallsLimit ? 'at-ceiling' : 'ok') : 'unknown',
    },
  };
}

/**
 * The outbox, counted rather than assumed.
 *
 * `claimPendingEffects` is a plain `SELECT ... WHERE state = 'pending'` — no claim, no
 * write, no lock — so a read-only command may use it, and the earlier claim that "the
 * store exposes no read-only outbox count" was simply false. What *is* still unreadable
 * is the `failed` count: there is no public read for exhausted effects, so `dead` stays
 * `null` and the detail names exactly that gap instead of implying zero.
 *
 * A pending effect is not itself a fault — `--no-wait` and a crash between commit and
 * launch both leave one — but a pending effect with attempts > 0 is a launch that was
 * refused and is waiting for `recover`, which is why `retrying` is separated out.
 */
function outboxHealth(ctx: FactoryContext): StatusModel['health']['outbox'] {
  try {
    const counts = outboxCounts(ctx.store);
    const leaked = counts.pending - counts.retrying;
    return {
      // Any pending effect means an intent to launch that has not been performed, which is
      // never `ok` — work the operator asked for is not running. `retrying` sharpens the
      // detail, not the state.
      state: counts.pending === 0 ? 'ok' : 'degraded',
      pending: counts.pending,
      retrying: counts.retrying,
      dead: counts.dead,
      detail:
        counts.pending === 0
          ? 'no launch effect is pending; every intent to launch has been settled'
          : `${String(leaked)} launch effect(s) pending for work not yet performed, ` +
            `${String(counts.retrying)} awaiting a retry by factory recover; ` +
            'the count of exhausted effects is not readable through the store API',
      since: null,
    };
  } catch (error) {
    // The read itself failed: only here is "not observable" true.
    return {
      state: 'unavailable',
      pending: null,
      retrying: null,
      dead: null,
      detail: `the outbox could not be read: ${error instanceof Error ? error.message : String(error)}`,
      since: null,
    };
  }
}

/**
 * Δ per task class, from verdicts that measured one.
 *
 * The store carries no task-class column: the class a unit belongs to is the qualifier's
 * notion, and in v1 the unit's slug is the class an operator files it under (the same
 * default the wall wiring uses for the holdout corpus). So the aggregation is by slug,
 * and it counts only verdicts whose Δ was actually checked — a verdict with `checked:
 * false` contributes no sample rather than a zero.
 *
 * `escapeRate` stays `unknown`: the wall computes it from irreversible-scenario
 * outcomes, and no store column carries that yet. Claiming `0` would be the lie that
 * makes an escape look like something that never happened.
 */
function taskClassHealth(ctx: FactoryContext): StatusModel['health']['taskClasses'] {
  const byClass = new Map<string, number[]>();
  for (const unit of ctx.store.listUnits()) {
    const verdict = ctx.store.latestVerdictForUnit(unit.unitId);
    if (verdict === null) continue;
    const delta = verdict.verdict.delta;
    if (!delta.checked || delta.observed === null) continue;
    const bucket = byClass.get(unit.slug) ?? [];
    bucket.push(delta.observed);
    byClass.set(unit.slug, bucket);
  }
  const classes = [...byClass.entries()].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return classes.map(([classId, samples]) => {
    const mean = samples.reduce((sum, value) => sum + value, 0) / samples.length;
    return {
      class: classId,
      delta: { value: mean, samples: samples.length, state: 'measured' as const },
      escapeRate: { value: null, samples: 0, state: 'unknown' as const },
    };
  });
}

export const FACTORY_VERSION = '0.8.0';
export const PINNED_DSH_VERSION = '0.2.1-rc.5';
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
    // A fact, not a health state: which topology this instance is running under (ND2).
    `principals ${model.factory.topology.kind}`,
    `today ${usd(model.budget.perDay.spent)}/${usd(model.budget.perDay.limit)}` +
      `${model.budget.perDay.limitIsDefault === true ? ' default' : ''} estimated`,
    `dispatch ${occupancyLine(model.concurrency.attempts, model.concurrency.walls)}`,
  ];
  const line = parts.join(` ${sep()} `);
  void plain;
  return [line];
}

/**
 * `0/1 attempt(s), 0/1 wall run(s)` — a count the reader can compare with the ceiling, with
 * `?` for a failed read and ` default` on a number the operator did not choose.
 */
function occupancyLine(
  attempts: StatusModel['concurrency']['attempts'],
  walls: StatusModel['concurrency']['walls'],
): string {
  const show = (node: { readonly inFlight: number | null; readonly limit: number }): string =>
    `${node.inFlight === null ? '?' : String(node.inFlight)}/${String(node.limit)}`;
  const label = (node: { readonly limitIsDefault: boolean }): string =>
    node.limitIsDefault ? ' default' : '';
  return (
    `${show(attempts)} attempt(s)${label(attempts)}, ` + `${show(walls)} wall run(s)${label(walls)}`
  );
}

/**
 * The one line the single-uid claim needs.
 *
 * On a two-uid host the aggregate's `principals two-uid` is the whole story and silence is right.
 * On a host with one uid the wall is only a separate *process*, and that scoping has to be visible
 * where the operator reads status — otherwise "independent wall" reads as if it held here. It is
 * printed with the reason, because "single-uid" without one invites the reader to assume a bug.
 */
function renderPrincipals(model: StatusModel): string[] {
  const { kind, claim, reason } = model.factory.topology;
  if (kind === 'two-uid') return [];
  return ['', ...wrap(`principals ${claim}`), ...wrap(`why: ${reason}`, 2)];
}

export function renderStatus(model: StatusModel, plain: boolean): string {
  const lines: string[] = [];
  const empty = model.units.length === 0;
  if (empty) {
    lines.push('no units. Start: factory intent --file <unit.json> --restate <restate-file>');
    // The spend line still prints: an operator who sees no units should still see
    // that the envelope exists, and that its numbers are estimates (A-2).
    lines.push(...renderAggregate(model, plain));
    lines.push(...renderPrincipals(model));
    lines.push(...renderTaskClasses(model));
    return record(lines);
  }

  lines.push(...renderAggregate(model, plain));
  lines.push(...renderPrincipals(model));
  lines.push(...renderTaskClasses(model));

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

/**
 * Δ per task class, as the factory knows it.
 *
 * The empty case is printed rather than omitted: an operator reading `task classes  none`
 * cannot tell "nothing has been measured yet" from "the factory cannot see the
 * measurement", and those call for different actions.
 */
function renderTaskClasses(model: StatusModel): string[] {
  if (model.health.taskClasses.length === 0) {
    return [
      '',
      'task classes  none measured — no verdict in the store carries a checked Δ ' +
        '(a class is certified only from measured holdout samples, never from a passing suite)',
    ];
  }
  const lines = ['', 'TASK CLASSES'];
  for (const item of model.health.taskClasses) {
    lines.push(
      `  ${item.class}  Δ ${item.delta.value === null ? 'unknown' : item.delta.value.toFixed(2)}  samples ${String(item.delta.samples)}`,
    );
  }
  return lines;
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
