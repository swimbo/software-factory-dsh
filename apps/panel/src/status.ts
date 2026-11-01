/**
 * `status.v1` projection — the read-only page's only source of truth.
 *
 * Everything here is derived from the `Store` interface: the panel holds one
 * handle, runs no SQL of its own, and never asks the wall or the executor for
 * anything. Where a fact is not recorded, the value is `null` (never `0`, never a
 * guess) and the renderer prints the literal word `unknown` — the one thing a
 * status page must never do is turn "we did not measure" into "fine".
 *
 * The shapes live in `@factory/contracts` (`status.ts`) so `factory status --json`
 * and `GET /api/status` cannot drift; this module only *builds* them, and the
 * server validates every response with `parseStatus()` before sending it.
 */
import { PINNED_DSH_VERSION } from '@factory/dsh-adapter';
import { WALL_VERSION, isTerminal, sha256Hex } from '@factory/contracts';
import type {
  BudgetStatus,
  HealthStatus,
  StatusV1,
  UnitStatus,
  UnitStatusState,
  VerdictStatus,
  WaitingOnPerson,
} from '@factory/contracts';
import type { Store, UnitRow, VerdictRow } from '@factory/store';

/** The factory's own version. One constant: the panel reports the binary it is. */
export const FACTORY_VERSION = '0.1.0';
export const STATUS_SCHEMA_VERSION = 'status.v1' as const;
/** Where the estimate comes from. Named on the page so the number has an origin. */
export const PRICE_TABLE_VERSION = 'p3';
/** Policy defaults (`ux-plan.md` §7.1 #7, `architecture.md` §9.3) when no envelope row exists. */
export const DEFAULT_PER_UNIT_USD = 2;
export const DEFAULT_PER_DAY_USD = 20;
/** How many terminal units the page lists ("last 5 verdicts", `ui-plan.md` §2.2). */
export const RECENT_VERDICT_LIMIT = 5;
/** A launch nobody picked up within this window is evidence the executor is unwell. */
export const STALE_LAUNCH_SECONDS = 600;
/** Wall reason codes that mean "the wall could not certify", not "the work failed". */
const WALL_UNAVAILABLE_REASONS: readonly string[] = [
  'holdout_unavailable',
  'suite_unknown',
  'receipt_unavailable',
];
/**
 * The contract's verdict object has a non-nullable `receipt`, but a failed or
 * unknown verdict may cite none (`verdicts.receipt_id` is nullable, and only a
 * pass requires one). `R-none` is the recorded sentinel for "this verdict cites no
 * receipt"; the renderer prints it as words, never as an id.
 */
export const NO_RECEIPT_ID = 'R-none';

export interface BuildStatusContext {
  /** Injected clock: every timestamp on the page comes from here, never from `new Date()`. */
  readonly now: () => Date;
  /** When this process started — the control-plane uptime is this process's uptime. */
  readonly startedAt: Date;
  /**
   * The DSH version this process actually saw, probed once at startup and injected.
   * `null` means "the probe could not read it" — a fact the page reports as
   * `unavailable`, never as `ok`, because a version compared against itself is the
   * green that hides a skew.
   */
  readonly dshVersionObserved?: string | null;
}

// ------------------------------------------------------------------ small helpers

function secondsBetween(fromIso: string, toIso: string): number {
  const from = Date.parse(fromIso);
  const to = Date.parse(toIso);
  if (Number.isNaN(from) || Number.isNaN(to)) return 0;
  return Math.max(0, Math.floor((to - from) / 1000));
}

/** A stable, schema-valid gate id for a derived item (`G-` + 10 lowercase hex). */
function derivedGateId(kind: string, subject: string): string {
  return `G-${sha256Hex(`${kind}:${subject}`).slice(0, 10)}`;
}

function plural(count: number, one: string, many: string): string {
  return count === 1 ? one : many;
}

export function formatUsd(amount: number): string {
  return `$${amount.toFixed(2)}`;
}

/**
 * The store's unit state, as the contract's closed set.
 *
 * A recorded verdict overrides the state, because the verdict is the fact the
 * operator needs: a `receipted` unit whose verdict is `unknown` is *unknown*, not
 * "verifying" — that distinction is the whole point of the page.
 */
export function panelUnitState(unit: UnitRow, verdict: VerdictStatus | null): UnitStatusState {
  if (verdict !== null) {
    if (verdict.state === 'unknown') return 'unknown';
    if (verdict.state === 'failed') return 'failed';
  }
  switch (unit.state) {
    case 'submitted':
    case 'qualified':
      return 'queued';
    case 'lit_parked':
      return 'lit_parked';
    case 'dispatched':
      return 'dispatched';
    case 'receipted':
      return 'verifying';
    case 'verified':
      return 'verified';
    case 'promoted':
      return 'promoted';
    case 'rejected':
      return 'rejected';
    case 'aborted':
      return 'aborted';
    case 'ambiguous':
      return 'ambiguous';
  }
}

/** `unknownReason` for an unknown verdict: the wall's own codes, and what is missing. */
export function describeUnknown(verdict: VerdictRow): string {
  const codes = verdict.verdict.reasons;
  const named = codes.length > 0 ? codes.join(', ') : 'no reason code recorded';
  return `the wall did not certify this attempt (${named}); the store records no measurement for it`;
}

function buildVerdictStatus(store: Store, verdict: VerdictRow, promoted: boolean): VerdictStatus {
  const body = verdict.verdict;
  const receipt = verdict.receiptSha === null ? null : store.getReceiptBySha(verdict.receiptSha);
  const holdoutScenarios = body.scenarios.filter((scenario) => scenario.source === 'holdout');
  const holdoutPassed = holdoutScenarios.filter((scenario) => scenario.outcome === 'pass').length;
  // The visible pass rate is only honest when the visible suite measured every
  // case: a skipped or unknown outcome makes the denominator unmeasured.
  const suite = receipt?.receipt.suite ?? null;
  const visiblePassRate =
    suite !== null && suite.passed + suite.failed > 0 && suite.skipped === 0 && suite.unknown === 0
      ? suite.passed / (suite.passed + suite.failed)
      : null;
  const measured = body.delta.checked && body.delta.observed !== null;
  const state: VerdictStatus['state'] =
    body.outcome === 'pass' ? 'passed' : body.outcome === 'fail' ? 'failed' : 'unknown';
  return {
    verdictId: verdict.verdictId,
    state,
    wallVersion: verdict.wallVersion,
    holdoutRevision: verdict.holdoutRevision ?? body.holdoutRevision,
    policyVersion: verdict.policyVersion,
    holdout: {
      passed: holdoutPassed,
      total: holdoutScenarios.length,
      // The wall records no certification rate, so the page states the counting
      // rule it can actually stand behind rather than repeating a marketing number.
      rule: 'scenarios the verdict recorded as holdout; no certification rate is claimed',
    },
    delta: {
      value: body.delta.observed,
      visiblePassRate,
      holdoutPassRate: body.delta.candidateRate,
      samples: holdoutScenarios.length,
      state: measured ? 'measured' : 'unknown',
    },
    receipt: {
      receiptId: receipt?.receiptId ?? NO_RECEIPT_ID,
      // Faithfulness is the wall's own re-execution result and the store keeps no
      // column for it: `null` says "not recorded" instead of inventing `true`.
      faithful: null,
      contentHash: verdict.receiptSha ?? `sha256:${'0'.repeat(64)}`,
    },
    unknownReason: state === 'unknown' ? describeUnknown(verdict) : null,
    // Verdict signatures are a wall artifact this store does not hold.
    signed: null,
    // A gate is only a gate while it is unpassed: once the ledger holds the
    // signature there is nothing left to block, and saying otherwise would turn a
    // done thing into a standing chore.
    promotionBlocked: promoted
      ? null
      : state === 'passed'
        ? 'first promotion requires your signature'
        : state === 'unknown'
          ? 'an unknown verdict cannot be promoted'
          : 'a failed unit cannot be promoted',
    createdAt: verdict.evaluatedAt,
  };
}

/**
 * The signature on a promotion, read from the ledger.
 *
 * The `Store` interface exposes `getPromotion(unitId, verdictSha) → {promotionId}`
 * and nothing else about the row, so `signedBy`/`signedAt` come from the
 * `unit.promoted` event — the same facts, recorded once. The `id` is a stable
 * reference derived from the signed promotion hash because the row's id is not
 * exposed either; the page shows the hash-bearing reference rather than inventing
 * an id that would not resolve.
 */
function promotionFromLedger(
  store: Store,
  unitId: string,
): { id: string; signedAt: string; signedBy: string } | null {
  const events = store.eventsSince(0);
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index];
    if (!event || event.type !== 'unit.promoted') continue;
    if (event.payload['unitId'] !== unitId) continue;
    const signedBy = event.payload['signedBy'];
    const promotionSha = event.payload['promotionSha'];
    const reference =
      typeof promotionSha === 'string' && promotionSha.length > 0 ? promotionSha : event.eventId;
    return {
      id: `P-${sha256Hex(`${unitId}:${reference}`).slice(0, 12)}`,
      signedAt: event.occurredAt,
      signedBy: typeof signedBy === 'string' && signedBy.length > 0 ? signedBy : 'unknown',
    };
  }
  return null;
}

function buildAttemptStatus(store: Store, unit: UnitRow): UnitStatus['attempt'] {
  const attempts = store.listAttemptsForUnit(unit.unitId);
  const latest = attempts[attempts.length - 1];
  if (!latest) return null;
  // The one telemetry figure the store really holds: once an attempt produced a
  // receipt, that receipt measured how many turns the run took. Before a receipt
  // there is no per-turn record anywhere, so the honest value is `null` — and the
  // contract refuses a measured `0` precisely to stop "no data" reading as "zero".
  const receipt = store.latestReceiptForUnit(unit.unitId);
  const measuredTurns =
    receipt !== null && receipt.attemptId === latest.attemptId
      ? receipt.receipt.ceilings.turnsUsed
      : null;
  return {
    attemptNo: attempts.length,
    state: latest.state,
    turn: measuredTurns,
    // Token accounting has no source at all: DSH reports no per-attempt token
    // count to this store, so both the usage and the ceiling stay unknown.
    tokensUsed: null,
    tokenCeiling: null,
    wallClockCeilingS: null,
    startedAt: latest.startedAt,
    lastProgressAt: null,
    noProgressStreak: null,
  };
}

function buildAmbiguity(store: Store, unit: UnitRow): UnitStatus['ambiguity'] {
  const attempts = store.listAttemptsForUnit(unit.unitId);
  const latest = attempts[attempts.length - 1];
  if (!latest) return null;
  return {
    known: `attempt ${latest.attemptId} started and did not report a terminal event`,
    unknown:
      'what the attempt did outside its worktree — the store records that it did not finish, not what ran',
    notDone:
      attempts.length === 1
        ? 'nothing was retried; no second attempt exists'
        : `nothing was retried automatically; ${attempts.length} attempts exist and the last is ambiguous`,
    observedAt: latest.endedAt ?? latest.startedAt,
  };
}

function buildUnitStatus(store: Store, unit: UnitRow): UnitStatus {
  const verdictRow = store.latestVerdictForUnit(unit.unitId);
  const verdict =
    verdictRow === null ? null : buildVerdictStatus(store, verdictRow, unit.state === 'promoted');
  const state = panelUnitState(unit, verdict);
  return {
    unitId: unit.unitId,
    // The title is the operator's own intent text from the spec — never the model's
    // narrative, which is non-evidence and is absent from this projection entirely.
    title: unit.spec.intent,
    // A unit with no lane decision has no lane to report, and such units are not
    // listed at all (see `buildStatus`), so this fallback is unreachable — it
    // exists only because the contract has no "undecided" lane value.
    lane: unit.lane ?? 'dark',
    state,
    attempt: buildAttemptStatus(store, unit),
    ambiguity: state === 'ambiguous' ? buildAmbiguity(store, unit) : null,
    verdict,
    promotion: unit.state === 'promoted' ? promotionFromLedger(store, unit.unitId) : null,
    updatedAt: unit.updatedAt,
  };
}

// -------------------------------------------------------------------- needs you

function buildWaitingOnPerson(
  units: UnitStatus[],
  terminalUnitIds: ReadonlySet<string>,
  budget: BudgetStatus,
  nowIso: string,
): WaitingOnPerson[] {
  const items: WaitingOnPerson[] = [];
  for (const unit of units) {
    // Terminal units are recorded history, not chores — except a unit parked in the
    // lit lane, which is terminal *because* a person has to take it out of band.
    if (terminalUnitIds.has(unit.unitId) && unit.state !== 'lit_parked') continue;
    if (unit.state === 'unknown' && unit.verdict !== null) {
      items.push({
        id: derivedGateId('unknown_verdict', unit.unitId),
        kind: 'unknown_verdict',
        unitId: unit.unitId,
        question:
          `Unit ${unit.unitId} was not certified: ${unit.verdict.unknownReason ?? 'no reason recorded'}. ` +
          'It is not a pass. Decide whether to re-run it or abort it.',
        recommendedCommand: `factory status ${unit.unitId} --all`,
        irreversible: false,
        since: unit.verdict.createdAt,
      });
    }
    if (unit.state === 'ambiguous') {
      const attemptNo = unit.attempt?.attemptNo ?? 1;
      items.push({
        id: derivedGateId('ambiguous_attempt', unit.unitId),
        kind: 'ambiguous_attempt',
        unitId: unit.unitId,
        question:
          `Attempt ${attemptNo} for unit ${unit.unitId} did not reach a terminal event. ` +
          'Nothing was retried. Observe, then decide.',
        recommendedCommand: `factory status ${unit.unitId} --attempt ${attemptNo}`,
        irreversible: false,
        since: unit.attempt?.startedAt ?? unit.updatedAt,
      });
    }
    if (unit.state === 'lit_parked') {
      items.push({
        id: derivedGateId('lit_unit', unit.unitId),
        kind: 'lit_unit',
        unitId: unit.unitId,
        question:
          `Unit ${unit.unitId} was parked in the lit lane: a qualifier signal was not a pass. ` +
          'It will not run. Take it out of band or submit it again.',
        recommendedCommand: `factory status ${unit.unitId} --all`,
        irreversible: false,
        since: unit.updatedAt,
      });
    }
    // A verified unit that has not been promoted is not done: it is a signature
    // waiting to happen. The CLI has always said so; omitting it here would let the
    // page report `0 need you` while a passing unit sits unpromoted (`ux-plan.md` A-1).
    if (unit.state === 'verified' && unit.promotion === null) {
      items.push({
        id: derivedGateId('initial_production_deploy', unit.unitId),
        kind: 'initial_production_deploy',
        unitId: unit.unitId,
        question:
          `Unit ${unit.unitId} passed but the first promotion needs your signature. ` +
          'Nothing is pushed or deployed: it writes a signed record.',
        recommendedCommand: `factory promote ${unit.unitId}`,
        irreversible: true,
        since: unit.verdict?.createdAt ?? unit.updatedAt,
      });
    }
  }
  const committed = (budget.perDay.spent ?? 0) + (budget.perDay.reserved ?? 0);
  if (budget.perDay.limit > 0 && committed >= budget.perDay.limit) {
    const next = Math.max(budget.perDay.limit * 2, budget.perDay.limit + 1);
    items.push({
      id: derivedGateId('budget_envelope_raise', 'day'),
      kind: 'budget_envelope_raise',
      unitId: null,
      question:
        `The per-day envelope is exhausted: ~${formatUsd(committed)} committed of ` +
        `${formatUsd(budget.perDay.limit)}, estimated. Dispatch is refused until an operator raises it.`,
      recommendedCommand: `factory budget raise --to ${next.toFixed(2)} --reason "<why>"`,
      irreversible: true,
      // The condition is observed now; the spend rows the page reads are aggregates
      // and carry no "first crossed" timestamp to cite instead.
      since: nowIso,
    });
  }
  return items;
}

// ------------------------------------------------------------------------ health

function lastLedgerHead(store: Store): string | null {
  const count = store.eventCount();
  if (count === 0) return null;
  const events = store.eventsSince(count - 1, 1);
  const last = events[events.length - 1];
  return last ? last.eventId : null;
}

function newestVerdict(store: Store): VerdictRow | null {
  let newest: VerdictRow | null = null;
  for (const unit of store.listUnits()) {
    const verdict = store.latestVerdictForUnit(unit.unitId);
    if (verdict === null) continue;
    if (newest === null || verdict.evaluatedAt > newest.evaluatedAt) newest = verdict;
  }
  return newest;
}

function buildHealth(store: Store, ctx: BuildStatusContext, nowIso: string): HealthStatus {
  const quarantined = store.isQuarantined();
  const dshVersionObserved = ctx.dshVersionObserved ?? null;
  const uptimeS = Math.max(0, Math.floor((ctx.now().getTime() - ctx.startedAt.getTime()) / 1000));
  const allUnits = store.listUnits();

  // The executor is judged by evidence, not by optimism: a launch that has sat in
  // `planned`/`launching` past the stale window is a dispatch nobody picked up.
  //
  // Two pieces of evidence disprove a stuck launch, and both are checked: an
  // attempt that produced a receipt obviously ran (the receipt outranks a stale
  // attempt state — `insertReceipt` does not rewrite it), and a terminal unit is
  // not waiting on anything any more.
  const receiptedAttempts = new Set<string>();
  for (const unit of allUnits) {
    const receipt = store.latestReceiptForUnit(unit.unitId);
    if (receipt !== null) receiptedAttempts.add(receipt.attemptId);
  }
  let staleLaunch: { attemptId: string; startedAt: string } | null = null;
  for (const unit of allUnits) {
    if (isTerminal(unit.state)) continue;
    for (const attempt of store.listAttemptsForUnit(unit.unitId)) {
      const isLaunch = attempt.state === 'planned' || attempt.state === 'launching';
      if (!isLaunch || receiptedAttempts.has(attempt.attemptId)) continue;
      if (secondsBetween(attempt.startedAt, nowIso) > STALE_LAUNCH_SECONDS) {
        if (staleLaunch === null || attempt.startedAt < staleLaunch.startedAt) {
          staleLaunch = { attemptId: attempt.attemptId, startedAt: attempt.startedAt };
        }
      }
    }
  }

  const latest = newestVerdict(store);
  const wallUnavailable =
    latest !== null &&
    latest.outcome === 'unknown' &&
    latest.verdict.reasons.some((reason) => WALL_UNAVAILABLE_REASONS.includes(reason));
  const pending = store.claimPendingEffects(1000).length;

  return {
    store: {
      state: quarantined ? 'unavailable' : 'ok',
      quarantined,
      schemaVersion: store.schemaVersion,
      ledgerHead: lastLedgerHead(store),
      detail: quarantined ? 'the store is quarantined; every write is refused' : null,
      // `Store.isQuarantined()` returns a boolean, not the recorded reason, so the
      // page names the condition and the runbook instead of paraphrasing a reason
      // it cannot read.
      since: null,
    },
    controlPlane: {
      state: quarantined ? 'degraded' : 'ok',
      uptimeS,
      detail: quarantined ? 'the control plane can read but not write' : null,
      since: null,
    },
    executor: {
      state: staleLaunch === null ? 'ok' : 'degraded',
      kind: 'unknown',
      image: null,
      detail:
        staleLaunch === null
          ? 'no launch is waiting on the executor'
          : `launch ${staleLaunch.attemptId} has not been picked up`,
      since: staleLaunch === null ? null : staleLaunch.startedAt,
    },
    wall: {
      state: wallUnavailable ? 'unavailable' : 'ok',
      holdoutRevision: latest === null ? null : latest.holdoutRevision,
      detail: wallUnavailable
        ? `verdict ${latest?.verdictId ?? ''} is unknown and names the wall`
        : 'the newest verdict is not an unavailability',
      since: wallUnavailable ? (latest?.evaluatedAt ?? null) : null,
    },
    outbox: {
      state: pending > 0 ? 'degraded' : 'ok',
      pending,
      // Retry and dead-letter counts are not exposed by the `Store` interface.
      retrying: null,
      dead: null,
      detail: pending > 0 ? `${pending} ${plural(pending, 'effect', 'effects')} pending` : null,
      since: null,
    },
    dshVersion: {
      // Three states, and all three are reachable: `ok` only when the probe really
      // read the pinned version, `degraded` when it read a different one, and
      // `unavailable` when it could not read one at all. The third case is the one
      // that shows the health strip — it is the truthful case, not the default one.
      state:
        dshVersionObserved === null
          ? 'unavailable'
          : dshVersionObserved === PINNED_DSH_VERSION
            ? 'ok'
            : 'degraded',
      expected: PINNED_DSH_VERSION,
      observed: dshVersionObserved,
      detail:
        dshVersionObserved === null
          ? 'no DSH version could be read at startup (dsh --version)'
          : dshVersionObserved === PINNED_DSH_VERSION
            ? null
            : `expected ${PINNED_DSH_VERSION}, observed ${dshVersionObserved}`,
      since: null,
    },
    taskClasses: buildTaskClasses(store),
  };
}

/**
 * Δ per task class, one row per class present in the ledger, never blended across
 * classes. The store records no task-class stability evaluator, so `samples` is
 * the number of measured verdicts in the class and `state` claims exactly what
 * that count can support (`n≥5` → stable, otherwise unstable; none → unknown).
 */
function buildTaskClasses(store: Store): HealthStatus['taskClasses'] {
  interface Accumulator {
    readonly className: string;
    newestMeasuredAt: string | null;
    newestValue: number | null;
    measured: number;
  }
  const byClass = new Map<string, Accumulator>();
  for (const unit of store.listUnits()) {
    const verdict = store.latestVerdictForUnit(unit.unitId);
    if (verdict === null) continue;
    const className = unit.spec.operationClasses[0] ?? 'unclassified';
    const accumulator: Accumulator = byClass.get(className) ?? {
      className,
      newestMeasuredAt: null,
      newestValue: null,
      measured: 0,
    };
    if (verdict.verdict.delta.checked && verdict.verdict.delta.observed !== null) {
      accumulator.measured += 1;
      if (
        accumulator.newestMeasuredAt === null ||
        verdict.evaluatedAt > accumulator.newestMeasuredAt
      ) {
        accumulator.newestMeasuredAt = verdict.evaluatedAt;
        accumulator.newestValue = verdict.verdict.delta.observed;
      }
    }
    byClass.set(className, accumulator);
  }
  return [...byClass.values()]
    .sort((a, b) => a.className.localeCompare(b.className))
    .map((accumulator) => ({
      class: accumulator.className,
      delta: {
        value: accumulator.newestValue,
        samples: accumulator.measured,
        state:
          accumulator.measured === 0
            ? ('unknown' as const)
            : accumulator.measured < 5
              ? ('unstable' as const)
              : ('stable' as const),
        ...(accumulator.newestMeasuredAt === null
          ? {}
          : { measuredAt: accumulator.newestMeasuredAt }),
      },
      escapeRate: {
        value: null,
        samples: 0,
        // Escape-rate samples are a human review artefact no store column holds.
        state: 'unknown' as const,
      },
    }));
}

// ------------------------------------------------------------------------ budget

function buildBudget(store: Store): BudgetStatus {
  const perUnit = store.currentEnvelope('per-unit');
  const perDay = store.currentEnvelope('daily');
  let spent = 0;
  let reserved = 0;
  let unknownCount = 0;
  for (const unit of store.listUnits()) {
    const unitSpend = store.spendForUnit(unit.unitId);
    spent += unitSpend.recordedUsd;
    reserved += unitSpend.reservedUsd;
    if (unitSpend.unknownRows > 0) unknownCount += 1;
  }
  return {
    currency: 'USD',
    priceTableVersion: PRICE_TABLE_VERSION,
    // Never `measured` in v1: DSH has no billing-grade telemetry, so every figure
    // is usage-derived and the page must say so next to the number.
    telemetry: 'estimated',
    note: 'no billing-grade telemetry; usage-derived estimate',
    perUnit: { limit: perUnit?.amountUsd ?? DEFAULT_PER_UNIT_USD, kind: 'estimated' },
    perDay: {
      limit: perDay?.amountUsd ?? DEFAULT_PER_DAY_USD,
      spent,
      reserved,
      kind: 'estimated',
      measuredSpent: null,
    },
    unknownCount,
    state: unknownCount > 0 ? 'degraded' : 'ok',
  };
}

// ------------------------------------------------------------------- buildStatus

/**
 * Build the whole `status.v1` object from the store.
 *
 * The caller validates with `parseStatus()` before sending: a status object that
 * fails the contract must not reach a renderer (ui-plan §5.3, fail closed).
 */
export function buildStatus(store: Store, ctx: BuildStatusContext): StatusV1 {
  const nowIso = ctx.now().toISOString();
  const allUnits = store.listUnits();
  const terminalUnitIds = new Set(
    allUnits.filter((unit) => isTerminal(unit.state)).map((unit) => unit.unitId),
  );

  // Recent verdicts: the last five terminal units that actually carry a verdict.
  const recentTerminal = allUnits
    .filter((unit) => terminalUnitIds.has(unit.unitId) && unit.state !== 'lit_parked')
    .filter((unit) => store.latestVerdictForUnit(unit.unitId) !== null)
    .sort((a, b) => (a.updatedAt < b.updatedAt ? 1 : a.updatedAt > b.updatedAt ? -1 : 0))
    .slice(0, RECENT_VERDICT_LIMIT)
    .sort((a, b) => (a.updatedAt < b.updatedAt ? -1 : a.updatedAt > b.updatedAt ? 1 : 0));

  // Listed: every unit that has a lane (everything past qualification) plus the
  // recent terminal units. A unit with no lane decision yet is deliberately not
  // listed — the contract has no "undecided" lane value, and inventing one would
  // be a false certainty about routing. Such units also fall outside the
  // wireframe's three regions (working / needs-you / recent verdicts).
  const listed: UnitRow[] = allUnits.filter((unit) => unit.lane !== null);
  const listedIds = new Set(listed.map((unit) => unit.unitId));
  for (const unit of recentTerminal) {
    if (!listedIds.has(unit.unitId)) {
      listed.push(unit);
      listedIds.add(unit.unitId);
    }
  }
  const units = listed.map((unit) => buildUnitStatus(store, unit));

  const budget = buildBudget(store);
  const newest = newestVerdict(store);

  return {
    schemaVersion: STATUS_SCHEMA_VERSION,
    generatedAt: nowIso,
    factory: {
      version: FACTORY_VERSION,
      dshVersionExpected: PINNED_DSH_VERSION,
      dshVersionObserved: null,
      // The policy that produced the newest verdict is the one the page can name;
      // lane decisions are only readable by (unit, policyVersion), so there is no
      // "current policy" to look up independently.
      policyVersion: newest === null ? 'unknown' : newest.policyVersion,
      wallVersion: WALL_VERSION,
      holdoutRevision: newest === null ? null : newest.holdoutRevision,
    },
    waitingOnPerson: buildWaitingOnPerson(units, terminalUnitIds, budget, nowIso),
    units,
    health: buildHealth(store, ctx, nowIso),
    budget,
  };
}
