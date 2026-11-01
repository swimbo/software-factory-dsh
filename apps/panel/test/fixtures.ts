/**
 * Test fixtures for the panel — real store, real rows, no mocks.
 *
 * The panel's whole job is to report what the store holds, so its tests hold a
 * genuine `@factory/store` over a temporary directory and drive it through the
 * same calls the control plane makes. A fake store would let the page pass while
 * the real projection broke.
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { WALL_VERSION, contentHash, parseStatus, receiptShaFor } from '@factory/contracts';
import type {
  BudgetStatus,
  HealthStatus,
  LaneDecisionType,
  StatusV1,
  UnitSpec,
  UnitStatus,
  VerdictStatus,
  WaitingOnPerson,
  VerdictType,
  WorkerReceiptType,
} from '@factory/contracts';
import { openStore } from '@factory/store';
import type { AppendOptions, Store, UnitRow } from '@factory/store';

import { buildStatus } from '../src/status.ts';

export const AT = '2026-11-01T12:00:00.000Z';
export const LATER = '2026-11-01T12:10:00.000Z';
export const REPO = 'acme/widgets';
export const BASE_REV = 'a'.repeat(40);
export const POLICY = 'policy/2026-11-01';
export const HOLDOUT = 'holdout/7';
export const SHA = `sha256:${'0'.repeat(64)}`;

export const options = (traceId = 'tr-panel'): AppendOptions => ({ actor: 'control', traceId });

export function makeSpec(overrides: Partial<UnitSpec> = {}): UnitSpec {
  return {
    slug: 'add-version-endpoint',
    revision: 1,
    repo: REPO,
    baseRev: BASE_REV,
    intent: 'Add a GET /version endpoint that returns the running build version as JSON.',
    restateBack: 'Expose GET /version returning 200 with a JSON body that names the build version.',
    acceptance: [
      {
        id: 'ac-version',
        text: 'GET /version returns 200 and a version field',
        oracle: {
          kind: 'http',
          target: 'http://127.0.0.1:3000/version',
          expect: '200 and {"version":"x"}',
        },
      },
    ],
    touchPaths: ['src/routes/version.ts'],
    operationClasses: ['code-change'],
    sizeBudget: { files: 3, lines: 120 },
    budgetEstimateUsd: 0.4,
    ...overrides,
  };
}

export function makeUnitRow(
  unitId = 'U-7f3a9c',
  unitSpec: UnitSpec = makeSpec(),
  state: UnitRow['state'] = 'submitted',
): UnitRow {
  return {
    unitId,
    slug: unitSpec.slug,
    revision: unitSpec.revision,
    repo: unitSpec.repo,
    baseRev: unitSpec.baseRev,
    specHash: contentHash(unitSpec),
    spec: unitSpec,
    state,
    lane: null,
    currentMandateId: null,
    attemptCount: 0,
    createdAt: AT,
    updatedAt: AT,
    terminalAt: null,
    terminalReason: null,
  };
}

function makeLaneDecision(
  unitId: string,
  lane: 'dark' | 'lit' | 'reject',
): LaneDecisionType & { decisionId: string } {
  return {
    decisionId: `LD-${unitId}`,
    unitId,
    lane,
    score: 91,
    policyVersion: POLICY,
    decidedAt: AT,
    mandateId: lane === 'dark' ? `M-${unitId}` : null,
    signals: [
      {
        name: 'intent_derivability',
        outcome: 'pass',
        observed: '1 of 1 criteria machine-checkable',
        reason: 'INTENT_DERIVABLE',
        weight: 30,
      },
      {
        name: 'reversibility',
        outcome: 'pass',
        observed: 'code-change only',
        reason: 'REVERSIBLE',
        weight: 20,
      },
      {
        name: 'observability',
        outcome: 'pass',
        observed: 'http oracle',
        reason: 'ORACLE_PRESENT',
        weight: 15,
      },
      {
        name: 'task_class_history',
        outcome: 'pass',
        observed: 'delta 0.05 over 20 samples',
        reason: 'TASK_CLASS_STABLE',
        weight: 15,
      },
      {
        name: 'size',
        outcome: 'pass',
        observed: '120 lines',
        reason: 'SIZE_WITHIN_BUDGET',
        weight: 10,
      },
      {
        name: 'budget',
        outcome: 'pass',
        observed: '0.4 of 2.0 USD',
        reason: 'BUDGET_WITHIN_ENVELOPE',
        weight: 10,
      },
    ],
  };
}

/** A receipt whose narrative is a distinctive string the page must never print. */
export function makeReceipt(unitId: string, attemptId: string): WorkerReceiptType {
  return {
    unitId,
    attemptId,
    sessionId: 'sess-1',
    startedAt: AT,
    endedAt: AT,
    exitCode: 0,
    diff: {
      patchFile: `/tmp/attempts/${attemptId}/change.patch`,
      sha: SHA,
      filesChanged: 1,
      insertions: 12,
      deletions: 0,
      baseRev: BASE_REV,
    },
    commands: [
      {
        argv: ['pnpm', 'test'],
        cwd: `/tmp/attempts/${attemptId}`,
        exitCode: 0,
        timedOut: false,
        outputSha: SHA,
        durationMs: 1200,
      },
    ],
    suite: { command: ['pnpm', 'test'], exitCode: 0, passed: 8, failed: 0, skipped: 0, unknown: 0 },
    ceilings: { turnsUsed: 6, wallClockMs: 90_000, hit: [] },
    artifacts: [],
    narrative: NARRATIVE,
  };
}

/** Deliberately distinctive: if it appears in the HTML, non-evidence leaked. */
export const NARRATIVE = 'NARRATIVE-MARKER-7f21: the model says everything is delightful and done';

export function makeVerdict(
  unitId: string,
  attemptId: string,
  receiptSha: string,
  outcome: 'pass' | 'fail' | 'unknown',
): VerdictType {
  const base: VerdictType = {
    unitId,
    attemptId,
    receiptSha,
    holdoutRevision: HOLDOUT,
    policyVersion: POLICY,
    wallVersion: WALL_VERSION,
    outcome,
    scenarios: [
      {
        id: 'ac-version',
        source: 'acceptance',
        outcome: 'pass',
        observed: '200 {"version":"1.2.3"}',
      },
      {
        id: 'ho-1',
        source: 'holdout',
        outcome: outcome === 'pass' ? 'pass' : 'fail',
        observed: 'holdout run',
      },
      {
        id: 'ho-2',
        source: 'holdout',
        outcome: outcome === 'pass' ? 'pass' : 'unknown',
        observed: 'holdout run',
      },
    ],
    delta: {
      checked: true,
      baseRate: 0.8,
      candidateRate: 0.85,
      threshold: 0,
      observed: 0.05,
      holdoutRevision: HOLDOUT,
    },
    reasons: [],
    evaluatedAt: LATER,
  };
  if (outcome === 'pass') return base;
  if (outcome === 'fail') return { ...base, reasons: ['suite_failed'] };
  // Unknown: the wall could not certify, and Δ was never measured.
  return {
    ...base,
    reasons: ['holdout_unavailable'],
    delta: { ...base.delta, checked: false, observed: null },
  };
}

export interface WalkOptions {
  readonly unitId?: string;
  readonly attemptId?: string;
  readonly verdictId?: string;
  readonly receiptId?: string;
  readonly outcome?: 'pass' | 'fail' | 'unknown';
  readonly operationClasses?: UnitSpec['operationClasses'];
}

/**
 * Walk one unit all the way to a recorded verdict, using the store's own calls:
 * submit → qualify (dark) → mandate → dispatch → receipt → verdict.
 */
export function walkToVerdict(
  store: Store,
  walk: WalkOptions = {},
): { unitId: string; receiptSha: string } {
  const unitId = walk.unitId ?? 'U-7f3a9c';
  const attemptId = walk.attemptId ?? 'A-0001';
  const spec = makeSpec({
    slug: `slug-${unitId.toLowerCase()}`,
    ...(walk.operationClasses === undefined
      ? {}
      : { operationClasses: [...walk.operationClasses] }),
  });
  store.insertUnit(makeUnitRow(unitId, spec), options());
  store.insertLaneDecision(makeLaneDecision(unitId, 'dark'));
  store.insertMandate({
    mandateId: `M-${unitId}`,
    unitId,
    policyVersion: POLICY,
    lane: 'dark',
    budgetUsd: 2,
    issuedAt: AT,
    expiresAt: '2027-01-01T00:00:00.000Z',
    revokedAt: null,
  });
  store.setUnitLaneAndMandate(unitId, 'dark', `M-${unitId}`, options());
  store.acquireLease({
    leaseId: `L-${attemptId}`,
    unitId,
    owner: 'control-1',
    acquiredAt: AT,
    expiresAt: '2026-11-01T13:00:00.000Z',
  });
  store.insertAttempt({
    attemptId,
    unitId,
    leaseId: `L-${attemptId}`,
    state: 'planned',
    launchKey: `launch:${unitId}:${attemptId}`,
    sessionId: null,
    attemptDir: `/tmp/attempts/${attemptId}`,
    startedAt: AT,
    endedAt: null,
    exitCode: null,
  });
  store.setUnitState(unitId, 'dispatched', null, options());

  const body = makeReceipt(unitId, attemptId);
  const receiptSha = receiptShaFor(body);
  store.insertReceipt(
    {
      receiptId: walk.receiptId ?? 'R-0aa1',
      unitId,
      attemptId,
      receiptSha,
      sessionId: 'sess-1',
      exitCode: 0,
      startedAt: AT,
      endedAt: LATER,
      recordedAt: LATER,
      receipt: body,
    },
    options(),
  );
  const verdict = makeVerdict(unitId, attemptId, receiptSha, walk.outcome ?? 'pass');
  store.insertVerdict(
    {
      verdictId: walk.verdictId ?? 'V-0bb1',
      unitId,
      attemptId,
      receiptId: walk.receiptId ?? 'R-0aa1',
      receiptSha,
      holdoutRevision: HOLDOUT,
      policyVersion: POLICY,
      wallVersion: WALL_VERSION,
      outcome: verdict.outcome,
      evaluatedAt: LATER,
      verdict,
    },
    options(),
  );
  return { unitId, receiptSha };
}

/** Submit + qualify a unit without dispatching it (used for lit/reject lanes). */
export function qualify(store: Store, unitId: string, lane: 'dark' | 'lit' | 'reject'): void {
  store.insertUnit(
    makeUnitRow(unitId, makeSpec({ slug: `slug-${unitId.toLowerCase()}` })),
    options(),
  );
  store.insertLaneDecision(makeLaneDecision(unitId, lane));
  if (lane === 'dark') {
    store.insertMandate({
      mandateId: `M-${unitId}`,
      unitId,
      policyVersion: POLICY,
      lane: 'dark',
      budgetUsd: 2,
      issuedAt: AT,
      expiresAt: '2027-01-01T00:00:00.000Z',
      revokedAt: null,
    });
    store.setUnitLaneAndMandate(unitId, 'dark', `M-${unitId}`, options());
    return;
  }
  // A `lit` or `reject` lane parks the unit as part of the decision itself.
  store.setUnitLaneAndMandate(unitId, lane, null, options());
}

export interface TempStore {
  readonly dir: string;
  readonly store: Store;
  readonly cleanup: () => void;
}

/** A real store in a fresh temporary directory. */
export function tempStore(): TempStore {
  const dir = mkdtempSync(join(tmpdir(), 'factory-panel-'));
  const store = openStore({ dir });
  return {
    dir,
    store,
    cleanup: () => {
      store.close();
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

/** Build and validate, exactly as the server does — an invalid projection throws. */
export function statusOf(
  store: Store,
  options: {
    readonly at?: string;
    readonly startedAt?: string;
    readonly dshVersionObserved?: string | null;
  } = {},
): StatusV1 {
  const parsedAt = options.at ?? LATER;
  const parsedStart = options.startedAt ?? AT;
  return parseStatus(
    buildStatus(store, {
      now: () => new Date(parsedAt),
      startedAt: new Date(parsedStart),
      dshVersionObserved: options.dshVersionObserved ?? null,
    }),
  );
}

// ------------------------------------------------------------------ sample status

export interface SampleOptions {
  readonly verdict?: 'passed' | 'unknown' | 'failed' | 'none';
  /** Every subsystem ok — the only case in which the page must stay silent. */
  readonly healthAllOk?: boolean;
  readonly quarantined?: boolean;
  readonly budgetUnknownCount?: number;
  readonly title?: string;
  /** Extra verified units, to exercise the five-row cap on recent verdicts. */
  readonly extraVerdictUnits?: number;
}

/**
 * A hand-built, already-valid `status.v1` object.
 *
 * The renderer's job is to draw a *validated* projection honestly, so its tests
 * feed it exact objects — including combinations the store can produce but which
 * are awkward to seed (an all-ok health strip, for instance).
 */
export function sampleStatus(sample: SampleOptions = {}): StatusV1 {
  const verdictState = sample.verdict ?? 'passed';
  const unitId = 'U-7f3a9c';
  const verdict: VerdictStatus | null =
    verdictState === 'none'
      ? null
      : {
          verdictId: 'V-0bb1',
          state: verdictState,
          wallVersion: WALL_VERSION,
          holdoutRevision: HOLDOUT,
          policyVersion: POLICY,
          holdout: {
            passed: verdictState === 'passed' ? 2 : 0,
            total: 2,
            rule: 'scenarios the verdict recorded as holdout; no certification rate is claimed',
          },
          delta: {
            value: verdictState === 'passed' ? 0.05 : verdictState === 'failed' ? 0.01 : null,
            visiblePassRate: verdictState === 'passed' ? 1 : verdictState === 'failed' ? 0.5 : null,
            holdoutPassRate: verdictState === 'passed' ? 0.85 : null,
            samples: 2,
            state: verdictState === 'passed' ? 'measured' : 'unknown',
          },
          receipt: { receiptId: 'R-0aa1', faithful: null, contentHash: SHA },
          unknownReason:
            verdictState === 'unknown'
              ? 'the wall did not certify this attempt (holdout_unavailable); the store records no measurement for it'
              : null,
          signed: null,
          promotionBlocked:
            verdictState === 'passed'
              ? 'first promotion requires your signature'
              : verdictState === 'unknown'
                ? 'an unknown verdict cannot be promoted'
                : verdictState === 'failed'
                  ? 'a failed unit cannot be promoted'
                  : null,
          createdAt: LATER,
        };

  const units: UnitStatus[] = [
    {
      unitId,
      title: sample.title ?? makeSpec().intent,
      lane: 'dark',
      state:
        verdict === null
          ? 'running'
          : verdict.state === 'passed'
            ? 'verified'
            : verdict.state === 'unknown'
              ? 'unknown'
              : 'failed',
      attempt: {
        attemptNo: 1,
        state: 'produced-receipt',
        // A receipt measured the turns; there is no measurement before one.
        turn: verdict === null ? null : 6,
        tokensUsed: null,
        tokenCeiling: null,
        wallClockCeilingS: null,
        startedAt: AT,
        lastProgressAt: null,
        noProgressStreak: null,
      },
      ambiguity: null,
      verdict,
      promotion: null,
      updatedAt: LATER,
    },
  ];
  for (let index = 1; index <= (sample.extraVerdictUnits ?? 0); index += 1) {
    const suffix = String(index).padStart(4, '0');
    units.push({
      ...(units[0] as UnitStatus),
      unitId: `U-${suffix}`,
      title: `extra unit ${suffix}`,
      state: 'verified',
      verdict:
        verdict === null
          ? null
          : {
              ...verdict,
              verdictId: `V-${suffix}`,
              createdAt: `2026-11-01T1${(index % 9) + 1}:00:00.000Z`,
            },
    });
  }

  const allOk = sample.healthAllOk === true;
  const quarantined = sample.quarantined === true;
  const health: HealthStatus = {
    store: {
      state: quarantined ? 'unavailable' : 'ok',
      quarantined,
      schemaVersion: 1,
      ledgerHead: 'evt-42',
      detail: quarantined ? 'the store is quarantined; every write is refused' : null,
      since: quarantined ? LATER : null,
    },
    controlPlane: {
      state: quarantined ? 'degraded' : 'ok',
      uptimeS: 600,
      detail: quarantined ? 'the control plane can read but not write' : null,
      since: null,
    },
    executor: {
      state: 'ok',
      kind: 'unknown',
      image: null,
      detail: 'no launch is waiting on the executor',
      since: null,
    },
    wall: {
      state: allOk ? 'ok' : 'unavailable',
      holdoutRevision: HOLDOUT,
      detail: allOk
        ? 'the newest verdict is not an unavailability'
        : 'verdict V-0bb1 is unknown and names the wall',
      since: allOk ? null : LATER,
    },
    outbox: { state: 'ok', pending: 0, retrying: null, dead: null, detail: null, since: null },
    dshVersion: {
      state: allOk ? 'ok' : 'unavailable',
      expected: '0.2.1-rc.5',
      observed: allOk ? '0.2.1-rc.5' : null,
      detail: allOk ? null : 'the panel cannot observe the worker DSH version from the store',
      since: null,
    },
    taskClasses: [
      {
        class: 'code-change',
        delta:
          verdictState === 'passed'
            ? { value: 0.05, samples: 1, state: 'unstable', measuredAt: LATER }
            : { value: null, samples: 0, state: 'unknown' },
        escapeRate: { value: null, samples: 0, state: 'unknown' },
      },
      {
        class: 'config-change',
        delta: { value: null, samples: 0, state: 'unknown' },
        escapeRate: { value: null, samples: 0, state: 'unknown' },
      },
    ],
  };

  const budget: BudgetStatus = {
    currency: 'USD',
    priceTableVersion: 'p3',
    telemetry: 'estimated',
    note: 'no billing-grade telemetry; usage-derived estimate',
    perUnit: { limit: 2, kind: 'estimated' },
    perDay: { limit: 20, spent: 6.41, reserved: 0.9, kind: 'estimated', measuredSpent: null },
    unknownCount: sample.budgetUnknownCount ?? 0,
    state: (sample.budgetUnknownCount ?? 0) > 0 ? 'degraded' : 'ok',
  };

  const waitingOnPerson: WaitingOnPerson[] =
    verdictState === 'unknown'
      ? [
          {
            id: 'G-0abc123456',
            kind: 'unknown_verdict',
            unitId,
            question:
              'Unit U-7f3a9c was not certified: the wall did not certify this attempt (holdout_unavailable); the store records no measurement for it. It is not a pass. Decide whether to re-run it or abort it.',
            recommendedCommand: 'factory status U-7f3a9c --all',
            irreversible: false,
            since: LATER,
          },
        ]
      : [];

  return parseStatus({
    schemaVersion: 'status.v1',
    generatedAt: LATER,
    factory: {
      version: '0.1.0',
      dshVersionExpected: '0.2.1-rc.5',
      dshVersionObserved: null,
      policyVersion: POLICY,
      wallVersion: WALL_VERSION,
      holdoutRevision: HOLDOUT,
    },
    waitingOnPerson,
    units,
    health,
    budget,
  });
}
