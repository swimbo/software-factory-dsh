/**
 * The engine: the command layer of the dark factory.
 *
 * Everything an operator can *do* to a unit is one method here, and every method
 * is the same shape: read the facts, ask a pure rule, then write one transactional
 * step. The engine holds no policy of its own — the rules live in `rules.ts`
 * (pure, re-derivable from the ledger) and the invariants live in
 * `@factory/contracts` (state machine, error codes, earned verdicts). What the
 * engine adds is *ordering*: it is the only place that knows that a mandate must
 * be minted before a lane is assigned, that a lease must exist before an attempt
 * can name it, and that a receipt must be stored before a unit may be called
 * `receipted`.
 *
 * Three laws shape the code:
 *
 *   L1 (an agent report is not evidence) — `toDecisionReceipt` strips the
 *      narrative before any branch reads the receipt, so the barrier is the type
 *      system rather than a convention. The receipt's hash still covers the whole
 *      body (that is what the store re-computes), but no decision path can reach
 *      the prose.
 *   L2 (deterministic controls enforce, LLMs advise) — the lane gate is
 *      `assertDispatchable`, not a model; a `lit` or `reject` unit can never be
 *      dispatched no matter what the qualifier's prose says.
 *   L3 (unknown is not pass) — a refusal is a refusal: the engine never converts
 *      "I could not measure" into "fine". `recover` makes ambiguity louder
 *      instead of guessing, and it never re-dispatches.
 *
 * The engine is synchronous, because the store is: one writer, one SQLite WAL,
 * one transaction per command. Async here would only hide the serialisation the
 * store already enforces.
 *
 * Interpretation (reported to the lead): the `Store` interface derives the unit
 * event from the rows it can see (`eventForUnitState`), so the engine never
 * appends `unit.*` events itself — doing both would double-write the ledger. The
 * one place the engine appends directly is `attempt.ambiguous`, which carries an
 * `observedAs` identity the store cannot know; see `recover`.
 */
import { dirname, join } from 'node:path';

import {
  FactoryError,
  UnitSpec,
  Verdict,
  WorkerReceipt,
  assertVerdictIsEarned,
  contentHash,
  idempotencyKey,
  isTerminal,
  toDecisionReceipt,
  type LaneDecision,
  type LaneDecisionType,
  type OperationClass,
  type UnitState,
} from '@factory/contracts';
import type {
  AppendOptions,
  AttemptRow,
  EffectRow,
  MandateRow,
  ReceiptRow,
  Store,
  UnitRow,
  VerdictRow,
} from '@factory/store';

import { assertDispatchable, ceilingsFor, nextAttemptNumber } from './rules.ts';

/** The launch lease is a dead-man switch: if the controlling process dies, the attempt is reclaimable. */
export const LEASE_TTL_MS = 45 * 60 * 1000;

/** A mandate is authorisation with an expiry, so a forgotten unit cannot spend tomorrow's budget. */
export const MANDATE_TTL_MS = 24 * 60 * 60 * 1000;

/** Who the ledger says performed a control-plane act. The wall and the worker proxy have their own actors. */
export const CONTROL_ACTOR = 'control';

/**
 * What the qualifier is given. `taskClassHistory` is deliberately `unknown`: the
 * engine has no store method that yields per-task-class history, and inventing it
 * (or reading it off the unit's own attempts, which is a different question)
 * would make the lane depend on a fact nobody measured. `null` means unknown, and
 * the qualifier's policy is expected to answer `TASK_CLASS_UNKNOWN` — never a
 * pass — which is exactly the L3 behaviour we want.
 */
export interface QualifyInput {
  readonly unitId: string;
  readonly spec: UnitSpec;
  readonly taskClassHistory: unknown;
  readonly envelopeUsd: number;
  readonly nowIso: string;
}

/** The container-level facts the adapter needs to build an attempt's overlay. */
export interface OverlayInput {
  readonly unitId: string;
  readonly attemptId: string;
  readonly spec: UnitSpec;
  readonly ceilings: {
    readonly maxTurns: number;
    readonly wallClockMs: number;
    readonly maxOutputBytes: number;
  };
}

export interface EngineDeps {
  readonly store: Store;
  readonly now: () => Date;
  /** Prefix-namespaced id factory (`U-`, `A-`, `M-`, `V-`, …). Ids are opaque; the prefix is for humans. */
  readonly newId: (prefix: string) => string;
  readonly qualify: (input: QualifyInput) => LaneDecision;
  /** The signed per-unit envelope, read at the moment of the command, never cached. */
  readonly envelopeUsd: () => number;
  readonly traceId: () => string;
  /**
   * The policy version the qualifier is currently running. Optional so a caller
   * can wire the engine with only the six fields above; when it is absent the
   * engine learns the version from the first decision it scores and remembers it
   * for the life of the process. Correctness never depends on the memory: the
   * stored decision is always consulted, so a restart at worst re-scores once
   * (deterministically) and then reuses.
   */
  readonly policyVersion?: () => string;
  /** Optional richer overlay descriptor; when absent the engine emits the minimal one below. */
  readonly overlay?: (input: OverlayInput) => unknown;
}

export interface SubmitResult {
  readonly unit: UnitRow;
  readonly specHash: string;
  /** `false` means "this exact intent was already a unit"; nothing was written and no event was appended. */
  readonly created: boolean;
}

export interface QualifyResult {
  readonly unit: UnitRow;
  readonly decision: LaneDecision;
  readonly decisionId: string;
}

export interface Reservation {
  /** What was reserved. `kind: 'unknown'` means "the rest of the envelope", not a precise estimate. */
  readonly amountUsd: number;
  readonly kind: 'estimate' | 'unknown';
}

export interface RunResult {
  readonly unit: UnitRow;
  readonly attempt: AttemptRow;
  readonly mandate: MandateRow;
  readonly effect: EffectRow;
  readonly reservation: Reservation;
}

export interface ObserveResult {
  readonly unit: UnitRow;
  readonly attempt: AttemptRow;
  readonly receipt: ReceiptRow;
}

export interface VerdictResult {
  readonly unit: UnitRow;
  readonly verdict: VerdictRow;
}

export interface AbortResult {
  readonly unit: UnitRow;
  /** `false` for the idempotent no-op on an already-terminal unit (no event, no state change). */
  readonly changed: boolean;
}

export interface RecoverResult {
  readonly recoveryRunId: string;
  /** Attempts reconciled to `ambiguous` because their lease no longer vouches for them. */
  readonly ambiguous: number;
  /** Active attempts that outlived their unit: marked `aborted`, nothing re-dispatched. */
  readonly orphaned: number;
}

export interface Engine {
  submitUnit(rawSpec: unknown): SubmitResult;
  qualifyUnit(unitId: string): QualifyResult;
  runUnit(unitId: string): RunResult;
  observeAttempt(attemptId: string, receiptRaw: unknown): ObserveResult;
  recordVerdict(attemptId: string, verdictRaw: unknown): VerdictResult;
  abortUnit(unitId: string, reason: string): AbortResult;
  recover(input: { leaseTtlMs: number }): RecoverResult;
}

// --------------------------------------------------------------------- helpers

const MISSING = Symbol('missing');

interface IssueLike {
  readonly path?: ReadonlyArray<PropertyKey>;
  readonly message?: string;
  readonly code?: string;
}

/** Zod's issues, without importing zod: the engine consumes the schema, not the library. */
function issuesOf(error: unknown): IssueLike[] {
  if (typeof error !== 'object' || error === null) return [];
  const issues = (error as { issues?: unknown }).issues;
  return Array.isArray(issues) ? (issues as IssueLike[]) : [];
}

/** `acceptance[1].oracle.kind` — the same syntax an operator would type, so the message is copy-pasteable. */
function formatPath(path: ReadonlyArray<PropertyKey>): string {
  let out = '';
  for (const segment of path) {
    if (typeof segment === 'number') {
      out += `[${segment}]`;
      continue;
    }
    out += out === '' ? String(segment) : `.${String(segment)}`;
  }
  return out === '' ? '<root>' : out;
}

function valueAtPath(root: unknown, path: ReadonlyArray<PropertyKey>): unknown {
  let current: unknown = root;
  for (const segment of path) {
    if (typeof segment === 'number') {
      if (!Array.isArray(current)) return MISSING;
      current = (current as readonly unknown[])[segment];
      if (current === undefined) return MISSING;
      continue;
    }
    if (typeof current !== 'object' || current === null) return MISSING;
    const record = current as Record<string, unknown>;
    const key = String(segment);
    if (!Object.prototype.hasOwnProperty.call(record, key)) return MISSING;
    current = record[key];
  }
  return current;
}

/** Short, printable form of the offending value — the operator needs to see what they wrote. */
function preview(value: unknown): string {
  let text: string;
  try {
    text = JSON.stringify(value) ?? String(value);
  } catch {
    text = String(value);
  }
  return text.length > 120 ? `${text.slice(0, 117)}...` : text;
}

/**
 * A schema refusal names the exact path and the value that broke it. "Invalid
 * spec" alone would send the operator hunting; the path is the whole point of the
 * message (the CLI prints it verbatim, exit code 3).
 */
function invalidAt(kind: string, raw: unknown, error: unknown): FactoryError {
  const issues = issuesOf(error);
  const first = issues[0];
  if (first === undefined) {
    return new FactoryError('SPEC_INVALID', `${kind} is invalid but no field could be named`, {
      kind,
    });
  }
  const path = formatPath(first.path ?? []);
  const received = valueAtPath(raw, first.path ?? []);
  const details: Record<string, unknown> = {
    path,
    code: first.code ?? 'unknown',
    paths: issues.map((issue) => formatPath(issue.path ?? [])),
  };
  if (received !== MISSING) details['received'] = received;
  const got = received === MISSING ? '' : ` (got ${preview(received)})`;
  return new FactoryError(
    'SPEC_INVALID',
    `${kind} is invalid at ${path}: ${first.message ?? 'no message'}${got}`,
    details,
  );
}

function addMs(iso: string, ms: number): string {
  return new Date(Date.parse(iso) + ms).toISOString();
}

/**
 * The wall's reason codes as one printable phrase. Coarse by design: an agent
 * must not learn which check it failed, and an operator must not have to read a
 * narrative to know that the tests failed.
 */
function describeCodes(reasons: readonly string[]): string {
  return reasons.length === 0 ? 'no reason code given' : reasons.join(',');
}

function requireUnit(store: Store, unitId: string): UnitRow {
  const unit = store.getUnit(unitId);
  if (unit === null) {
    throw new FactoryError('UNIT_NOT_FOUND', `unit ${unitId} does not exist in ${store.location}`, {
      unitId,
    });
  }
  return unit;
}

function requireAttempt(store: Store, attemptId: string): AttemptRow {
  const attempt = store.getAttempt(attemptId);
  if (attempt === null) {
    throw new FactoryError(
      'ATTEMPT_NOT_FOUND',
      `attempt ${attemptId} does not exist in ${store.location}`,
      {
        attemptId,
      },
    );
  }
  return attempt;
}

/**
 * The state-machine guard for *inbound* facts (a receipt, a verdict). `Store`'s
 * `setUnitState` already refuses illegal transitions, but by then the evidence
 * would be stored — and evidence filed against a unit that never dispatched is a
 * record of something that did not happen. So out-of-order input is refused
 * before it reaches the ledger.
 *
 * A terminal unit is refused with `UNIT_ALREADY_TERMINAL` (exit 3: the operator
 * can act on it); a non-terminal unit in the wrong phase is `INTERNAL` (exit 1:
 * something upstream is out of order, trace id attached, `recover` is the next
 * step).
 */
function requirePhase(unit: UnitRow, allowed: readonly UnitState[], what: string): void {
  if (allowed.includes(unit.state)) return;
  const detail = { unitId: unit.unitId, state: unit.state, allowed: [...allowed] };
  if (isTerminal(unit.state)) {
    throw new FactoryError(
      'UNIT_ALREADY_TERMINAL',
      `unit ${unit.unitId} is already terminal (${unit.state}); ${what} cannot be filed against it — ` +
        'submit a new revision instead',
      detail,
    );
  }
  throw new FactoryError(
    'INTERNAL',
    `unit ${unit.unitId} is ${unit.state}; ${what} requires ${allowed.join(' or ')} — an input that arrives out of ` +
      'phase is a record of something that did not happen',
    detail,
  );
}

function toLaneDecision(row: LaneDecisionType): LaneDecision {
  const { unitId, lane, score, signals, policyVersion, decidedAt, mandateId } = row;
  return { unitId, lane, score, signals, policyVersion, decidedAt, mandateId };
}

// ---------------------------------------------------------------------- engine

export function createEngine(deps: EngineDeps): Engine {
  const { store } = deps;

  /**
   * Learned once from a real decision when `deps.policyVersion` is not wired. It
   * is a cache, not state: every read of the store is still authoritative.
   */
  let learnedPolicyVersion: string | null = null;

  const nowIso = (): string => deps.now().toISOString();

  const appendOptions = (traceId: string, at: string): AppendOptions => ({
    actor: CONTROL_ACTOR,
    traceId,
    occurredAt: at,
  });

  const currentPolicyVersion = (): string | null =>
    deps.policyVersion === undefined ? learnedPolicyVersion : deps.policyVersion();

  // ------------------------------------------------------------------ submit

  function submitUnit(rawSpec: unknown): SubmitResult {
    const parsed = UnitSpec.safeParse(rawSpec);
    if (!parsed.success) throw invalidAt('unit spec', rawSpec, parsed.error);
    const spec = parsed.data;

    // The identity of a unit is its content: same repo+slug+revision *and* same
    // hash is the same intent, so re-submitting it is a no-op with no event.
    const specHash = contentHash(spec);
    const existing = store.findUnitBySlug(spec.repo, spec.slug, spec.revision);
    if (existing !== null) {
      if (existing.specHash === specHash) {
        return { unit: existing, specHash, created: false };
      }
      throw new FactoryError(
        'DUPLICATE_UNIT',
        `unit ${spec.repo}/${spec.slug}@${spec.revision} already exists as ${existing.unitId} with a different spec ` +
          `hash (stored ${existing.specHash}, submitted ${specHash}); the intent changed, so bump spec.revision ` +
          'and resubmit — rewriting a revision would make two different units share one identity',
        {
          repo: spec.repo,
          slug: spec.slug,
          revision: spec.revision,
          existingUnitId: existing.unitId,
          existingSpecHash: existing.specHash,
          submittedSpecHash: specHash,
        },
      );
    }

    // The same content under another identity is the same intent: one unit, no new
    // row (the store refuses that second insert for exactly this reason, and the
    // engine's answer is the friendlier one — it returns the unit that exists).
    //
    // This branch cannot fire with today's `UnitSpec`, because `repo`, `slug` and
    // `revision` are all *inside* the hashed body: a bump to any of them changes the
    // hash and is genuinely a new unit (append-only history). It stays because the
    // day an identity field moves out of the hashed body, "same spec, two units"
    // must not silently become possible.
    const sameIntent = store.findUnitBySpecHash(spec.repo, specHash);
    if (sameIntent !== null) {
      return { unit: sameIntent, specHash, created: false };
    }

    const at = nowIso();
    const unit = store.insertUnit(
      {
        unitId: deps.newId('U-'),
        slug: spec.slug,
        revision: spec.revision,
        repo: spec.repo,
        baseRev: spec.baseRev,
        specHash,
        spec,
        state: 'submitted',
        lane: null,
        currentMandateId: null,
        attemptCount: 0,
        createdAt: at,
        updatedAt: at,
        terminalAt: null,
        terminalReason: null,
      },
      appendOptions(deps.traceId(), at),
    );
    // `insertUnit` writes the `unit.submitted` event in the same transaction; the
    // engine does not append a second one.
    return { unit, specHash, created: true };
  }

  // ----------------------------------------------------------------- qualify

  function qualifyUnit(unitId: string): QualifyResult {
    const unit = requireUnit(store, unitId);
    const at = nowIso();

    // A terminal unit's lane is settled. Re-scoring it would let a policy bump
    // re-open a decision an operator already acted on, and replaying the stored
    // rejection would report an old refusal as if it were new work — so a terminal
    // unit is refused, naming the state that ended it.
    if (isTerminal(unit.state)) {
      throw new FactoryError(
        'UNIT_ALREADY_TERMINAL',
        `unit ${unitId} is already terminal (${unit.state}); its lane is settled — submit a new revision ` +
          'instead of re-qualifying it',
        { unitId, state: unit.state },
      );
    }

    // Reuse before re-scoring. A lane decision is a function of the spec, the
    // policy version and the envelope, so the same policy version is the same
    // decision — re-running it would produce an identical row and a second event
    // for one fact.
    const known = currentPolicyVersion();
    if (known !== null) {
      const stored = store.getLaneDecision(unitId, known);
      if (stored !== null)
        return { unit, decision: toLaneDecision(stored), decisionId: stored.decisionId };
    }

    requirePhase(unit, ['submitted'], 'a lane decision');

    let decision: LaneDecision;
    try {
      decision = deps.qualify({
        unitId,
        spec: unit.spec,
        taskClassHistory: null,
        envelopeUsd: deps.envelopeUsd(),
        nowIso: at,
      });
    } catch (error) {
      // The qualifier raises its own classified errors; wrapping them would
      // relabel a policy refusal as an internal one.
      throw error;
    }

    if (decision.unitId !== unitId) {
      throw new FactoryError(
        'INTERNAL',
        `the qualifier scored unit ${decision.unitId} while qualifying ${unitId}; a lane decision that names ` +
          'another unit cannot be filed against this one',
        { unitId, decisionUnitId: decision.unitId },
      );
    }
    learnedPolicyVersion = decision.policyVersion;

    // Another process may have qualified this unit under the same policy while we
    // were scoring (they hold the lease, not us): the stored decision wins.
    const raced = store.getLaneDecision(unitId, decision.policyVersion);
    if (raced !== null) {
      return {
        unit: requireUnit(store, unitId),
        decision: toLaneDecision(raced),
        decisionId: raced.decisionId,
      };
    }

    if (decision.lane !== 'dark' && decision.mandateId !== null) {
      throw new FactoryError(
        'INTERNAL',
        `the qualifier returned lane=${decision.lane} with mandate ${decision.mandateId}; only the dark lane is ` +
          'authorised to dispatch, so a mandate on any other lane is a capability nobody granted',
        { unitId, lane: decision.lane, mandateId: decision.mandateId },
      );
    }

    const traceId = deps.traceId();
    const opts = appendOptions(traceId, at);
    const decisionId = deps.newId('D-');

    return store.atomic(() => {
      let mandateId: string | null = null;

      if (decision.lane === 'dark') {
        // The mandate is minted here, not by the qualifier: it needs the clock and
        // the signed envelope, and it is a control-plane act (L2). The decision is
        // then recorded *naming that mandate*, which is the whole reason the field
        // exists — so the ledger can re-derive why this unit may dispatch.
        mandateId = deps.newId('M-');
        store.insertMandate({
          mandateId,
          unitId,
          policyVersion: decision.policyVersion,
          lane: 'dark',
          budgetUsd: deps.envelopeUsd(),
          issuedAt: at,
          expiresAt: addMs(at, MANDATE_TTL_MS),
          revokedAt: null,
        });
      }

      store.insertLaneDecision({ ...decision, mandateId, decisionId });

      // `setUnitLaneAndMandate` is the one call that writes lane + mandate + state
      // + the routing event together (dark → `unit.qualified`, lit → `unit.lit_parked`
      // with no mandate, reject → `unit.rejected`). A second `setUnitState` here
      // would be a no-op at best and a second event at worst.
      const routed = store.setUnitLaneAndMandate(unitId, decision.lane, mandateId, opts);
      const expected: UnitState =
        decision.lane === 'dark'
          ? 'qualified'
          : decision.lane === 'lit'
            ? 'lit_parked'
            : 'rejected';
      if (routed.state !== expected) {
        throw new FactoryError(
          'INTERNAL',
          `unit ${unitId} was routed to lane=${decision.lane} but is ${routed.state}, not ${expected}; the lane ` +
            'and the state must agree or the CLI would print a lane nobody can dispatch',
          { unitId, lane: decision.lane, state: routed.state, expected },
        );
      }
      return {
        unit: routed,
        decision: toLaneDecision({ ...decision, mandateId, unitId }),
        decisionId,
      };
    });
  }

  // --------------------------------------------------------------------- run

  function runUnit(unitId: string): RunResult {
    const at = nowIso();
    const traceId = deps.traceId();
    const opts = appendOptions(traceId, at);

    // One transaction for the whole dispatch: a lease without an attempt, or an
    // attempt without a reservation, is a unit that can never be reconciled. The
    // gate is evaluated *inside* the transaction so the facts it read are the
    // facts it writes against.
    return store.atomic(() => {
      const unit = requireUnit(store, unitId);
      const liveLease = store.getLiveLease(unitId);
      const mandate =
        unit.currentMandateId === null ? null : store.getMandate(unit.currentMandateId);
      const spend = store.spendForUnit(unitId);

      const approval = assertDispatchable({
        unitId,
        state: unit.state,
        lane: unit.lane,
        attemptCount: unit.attemptCount,
        mandate:
          mandate === null
            ? null
            : {
                mandateId: mandate.mandateId,
                lane: mandate.lane,
                expiresAt: mandate.expiresAt,
                revokedAt: mandate.revokedAt,
                budgetUsd: mandate.budgetUsd,
              },
        liveLease:
          liveLease === null ? null : { leaseId: liveLease.leaseId, owner: liveLease.owner },
        nowIso: at,
        budget: {
          envelopeUsd: deps.envelopeUsd(),
          reservedUsd: spend.reservedUsd,
          spentUsd: spend.recordedUsd,
          estimateUsd: unit.spec.budgetEstimateUsd,
        },
      });
      if (mandate === null) {
        // Unreachable: `assertDispatchable` refuses a unit without a live mandate.
        throw new FactoryError(
          'MANDATE_EXPIRED',
          `unit ${unitId} has no mandate to dispatch under`,
          { unitId },
        );
      }
      if (approval.reserveUsd === null) {
        throw new FactoryError(
          'INTERNAL',
          `dispatch of ${unitId} was allowed with no reservation amount; a dispatch that reserves nothing is a ` +
            'budget hole, not an estimate',
          { unitId, kind: approval.budgetKind },
        );
      }

      // The lease comes before the attempt: the attempt row names its lease, and a
      // lease that is released by a crashed controller is what makes recovery
      // possible at all.
      const leaseId = deps.newId('LS-');
      store.acquireLease({
        leaseId,
        unitId,
        owner: CONTROL_ACTOR,
        acquiredAt: at,
        expiresAt: addMs(at, LEASE_TTL_MS),
      });

      const attemptNumber = nextAttemptNumber(unit.attemptCount);
      // The launch key is derived from facts that cannot change between two
      // attempts to dispatch the same work: the unit, the attempt slot, the
      // mandate that authorises it and the spec it implements.
      const launchKey = idempotencyKey('launch', {
        unitId,
        attemptNumber,
        mandateId: mandate.mandateId,
        specHash: unit.specHash,
      });
      const attemptId = deps.newId('A-');
      // The adapter creates this directory; the engine only fixes its name, so a
      // receipt's artifacts resolve to one place for every reader.
      const attemptDir = join(dirname(store.location), 'attempts', attemptId);
      const attempt = store.insertAttempt({
        attemptId,
        unitId,
        leaseId,
        state: 'launching',
        launchKey,
        sessionId: null,
        attemptDir,
        startedAt: at,
        endedAt: null,
        exitCode: null,
      });
      if (attempt.attemptId !== attemptId) {
        // The launch key already named an attempt: a dispatch is already recorded
        // for this slot. Reusing it silently would strand the lease we just took.
        throw new FactoryError(
          'INTERNAL',
          `unit ${unitId} already has a recorded attempt ${attempt.attemptId} for launch key ${launchKey}; the unit ` +
            'state says it was never dispatched, so the ledger and the aggregate disagree',
          {
            unitId,
            launchKey,
            recordedAttemptId: attempt.attemptId,
            requestedAttemptId: attemptId,
          },
        );
      }

      const ceilings = ceilingsFor({ budgetUsd: mandate.budgetUsd });
      const overlayInput: OverlayInput = { unitId, attemptId, spec: unit.spec, ceilings };
      const overlay: unknown =
        deps.overlay === undefined
          ? defaultOverlay(unit.spec, ceilings)
          : deps.overlay(overlayInput);

      store.reserveSpend({
        spendId: deps.newId('S-'),
        unitId,
        attemptId,
        amountUsd: approval.reserveUsd,
        recordedAt: at,
      });
      store.incrementAttemptCount(unitId, opts);
      const dispatched = store.setUnitState(unitId, 'dispatched', null, opts);

      // The effect is the outbox: the transaction commits the intent to launch,
      // and the adapter claims it. Nothing is launched from inside this call, so a
      // crash after commit retries the launch instead of losing it.
      const effect = store.enqueueEffect({
        effectId: deps.newId('E-'),
        idempotencyKey: launchKey,
        kind: 'launch',
        payload: { attemptId, unitId, attemptDir, overlay },
        createdAt: at,
      });

      return {
        unit: dispatched,
        attempt,
        mandate,
        effect,
        reservation: { amountUsd: approval.reserveUsd, kind: approval.budgetKind },
      };
    });
  }

  /**
   * The minimal overlay descriptor: what the adapter must confine the attempt to.
   * Paths and operation classes come from the spec (the blast radius the operator
   * declared), the ceilings from the mandate's budget, the base revision from the
   * spec (a patch is meaningless against a different commit).
   */
  function defaultOverlay(
    spec: UnitSpec,
    ceilings: {
      readonly maxTurns: number;
      readonly wallClockMs: number;
      readonly maxOutputBytes: number;
    },
  ): {
    readonly baseRev: string;
    readonly operationClasses: readonly OperationClass[];
    readonly touchPaths: readonly string[];
    readonly ceilings: { maxTurns: number; wallClockMs: number; maxOutputBytes: number };
  } {
    return {
      baseRev: spec.baseRev,
      operationClasses: spec.operationClasses,
      touchPaths: spec.touchPaths,
      ceilings,
    };
  }

  // ----------------------------------------------------------------- observe

  function observeAttempt(attemptId: string, receiptRaw: unknown): ObserveResult {
    const at = nowIso();

    return store.atomic(() => {
      const attempt = requireAttempt(store, attemptId);
      const unit = requireUnit(store, attempt.unitId);

      const parsed = WorkerReceipt.safeParse(receiptRaw);
      if (!parsed.success) {
        throw invalidAt('worker receipt', receiptRaw, parsed.error);
      }
      const receipt = parsed.data;

      // L1 is a *type* barrier, not a convention: `DecisionReceipt` has no
      // `narrative`, so no logic below can read the agent's prose even by accident.
      // The hash still covers the whole body, because that is what the store
      // re-computes — the narrative is part of what was written, not part of what
      // a decision may use.
      const evidence = toDecisionReceipt(receipt);
      const receiptSha = contentHash(receipt);

      if (receipt.attemptId !== attemptId) {
        throw new FactoryError(
          'RECEIPT_CONFLICT',
          `receipt for attempt ${receipt.attemptId} was filed against attempt ${attemptId}; a receipt names the ` +
            'attempt that produced it, and evidence cannot be moved between attempts',
          { attemptId, receiptAttemptId: receipt.attemptId },
        );
      }
      if (receipt.unitId !== attempt.unitId) {
        throw new FactoryError(
          'RECEIPT_CONFLICT',
          `receipt for unit ${receipt.unitId} was filed against attempt ${attemptId}, which belongs to unit ` +
            `${attempt.unitId}`,
          { attemptId, unitId: attempt.unitId, receiptUnitId: receipt.unitId },
        );
      }

      // One attempt produces one receipt. Append-only evidence means a second,
      // different receipt is a conflict to surface — never an overwrite.
      const duplicate = store.getReceiptBySha(receiptSha);
      if (duplicate !== null) {
        throw new FactoryError(
          'RECEIPT_CONFLICT',
          `receipt ${receiptSha} is already recorded as ${duplicate.receiptId} for attempt ` +
            `${duplicate.attemptId}; receipts are append-only, so a duplicate is a conflict`,
          {
            attemptId,
            receiptSha,
            existingReceiptId: duplicate.receiptId,
            existingAttemptId: duplicate.attemptId,
          },
        );
      }
      if (attempt.state === 'produced-receipt') {
        const latest = store.latestReceiptForUnit(attempt.unitId);
        const existingReceiptId =
          latest !== null && latest.attemptId === attemptId ? latest.receiptId : null;
        throw new FactoryError(
          'RECEIPT_CONFLICT',
          `attempt ${attemptId} already produced a receipt${existingReceiptId === null ? '' : ` (${existingReceiptId})`}` +
            '; a second receipt for one attempt would make "which evidence did the wall judge?" unanswerable',
          { attemptId, receiptSha, existingReceiptId },
        );
      }

      // Late evidence is welcome on a terminal unit (an abort does not un-happen
      // the work), but evidence for a unit that never dispatched is a record of
      // something that did not occur.
      if (!isTerminal(unit.state)) requirePhase(unit, ['dispatched', 'ambiguous'], 'a receipt');

      // `insertReceipt` writes the receipt, moves the unit to `receipted` and
      // appends `attempt.receipted` in one transaction; the engine must not repeat
      // either step.
      const stored = store.insertReceipt(
        {
          receiptId: deps.newId('R-'),
          unitId: attempt.unitId,
          attemptId,
          receiptSha,
          sessionId: evidence.sessionId,
          exitCode: evidence.exitCode,
          startedAt: evidence.startedAt,
          endedAt: evidence.endedAt,
          recordedAt: at,
          receipt,
        },
        appendOptions(deps.traceId(), at),
      );

      store.setAttemptState(attemptId, 'produced-receipt', {
        endedAt: evidence.endedAt,
        exitCode: evidence.exitCode,
        sessionId: evidence.sessionId,
      });
      // The lease existed to make a crashed attempt reclaimable; a receipt is the
      // observation, so the lease has done its job.
      store.releaseLease(attempt.leaseId, at);

      return {
        unit: requireUnit(store, attempt.unitId),
        attempt: requireAttempt(store, attemptId),
        receipt: stored,
      };
    });
  }

  // ----------------------------------------------------------------- verdict

  function recordVerdict(attemptId: string, verdictRaw: unknown): VerdictResult {
    const at = nowIso();

    const parsed = Verdict.safeParse(verdictRaw);
    if (!parsed.success) throw invalidAt('verdict', verdictRaw, parsed.error);
    const verdict = parsed.data;

    // L3 at the front door: a pass that is not earned by measurement must not
    // reach the store at all. The store re-checks it (defence in depth), but a
    // refusal here is what keeps the ledger clean of verdicts nobody earned.
    try {
      assertVerdictIsEarned(verdict);
    } catch (error) {
      throw new FactoryError(
        'INTERNAL',
        `verdict for attempt ${attemptId} is not earnable: ${error instanceof Error ? error.message : String(error)}`,
        { attemptId, outcome: verdict.outcome },
      );
    }

    const committed = store.atomic(() => {
      const attempt = requireAttempt(store, attemptId);
      const unit = requireUnit(store, attempt.unitId);
      const opts = appendOptions(deps.traceId(), at);

      if (verdict.attemptId !== attemptId) {
        throw new FactoryError(
          'RECEIPT_CONFLICT',
          `verdict for attempt ${verdict.attemptId} was filed against attempt ${attemptId}; a verdict is about the ` +
            'evidence of one attempt and cannot be re-filed on another',
          { attemptId, verdictAttemptId: verdict.attemptId },
        );
      }
      if (verdict.unitId !== unit.unitId) {
        throw new FactoryError(
          'RECEIPT_CONFLICT',
          `verdict for unit ${verdict.unitId} was filed against attempt ${attemptId}, which belongs to unit ` +
            `${unit.unitId}`,
          { attemptId, unitId: unit.unitId, verdictUnitId: verdict.unitId },
        );
      }

      // A verdict is only meaningful against the receipt the wall actually read.
      const storedReceipt = store.getReceiptBySha(verdict.receiptSha);
      if (storedReceipt === null) {
        throw new FactoryError(
          'RECEIPT_CONFLICT',
          `verdict for attempt ${attemptId} cites receipt ${verdict.receiptSha}, which is not recorded; the wall ` +
            'cannot judge evidence the factory does not hold',
          { attemptId, unitId: unit.unitId, receiptSha: verdict.receiptSha },
        );
      }
      if (storedReceipt.attemptId !== attemptId) {
        throw new FactoryError(
          'RECEIPT_CONFLICT',
          `verdict for attempt ${attemptId} cites receipt ${storedReceipt.receiptId}, which was recorded for ` +
            `attempt ${storedReceipt.attemptId}; a verdict cannot borrow another attempt's evidence`,
          {
            attemptId,
            unitId: unit.unitId,
            receiptSha: verdict.receiptSha,
            receiptAttemptId: storedReceipt.attemptId,
          },
        );
      }

      requirePhase(unit, ['receipted', 'ambiguous'], 'a verdict');

      // `insertVerdict` is evidence first and a state change second: it advances
      // `pass` to verified and `fail` to rejected (naming the wall's coarse reason
      // codes), and records `unknown` without moving the unit at all. The engine
      // does not repeat the state change — it asserts the outcome the store claims.
      const stored = store.insertVerdict(
        {
          verdictId: deps.newId('V-'),
          unitId: unit.unitId,
          attemptId,
          receiptId: storedReceipt.receiptId,
          receiptSha: verdict.receiptSha,
          holdoutRevision: verdict.holdoutRevision,
          policyVersion: verdict.policyVersion,
          wallVersion: verdict.wallVersion,
          outcome: verdict.outcome,
          // The factory's own record time, not the wall's clock: ordering must not
          // depend on a machine whose time we do not control. The verdict body
          // keeps the wall's own `evaluatedAt`, which is part of the evidence.
          evaluatedAt: at,
          verdict,
        },
        opts,
      );

      const after = requireUnit(store, attempt.unitId);
      const expected: UnitState =
        verdict.outcome === 'pass'
          ? 'verified'
          : verdict.outcome === 'fail'
            ? 'rejected'
            : unit.state;
      if (after.state !== expected) {
        throw new FactoryError(
          'INTERNAL',
          `unit ${unit.unitId} received a ${verdict.outcome} verdict but is ${after.state}, not ${expected}; the ` +
            'verdict and the state must agree, or the promotion gate would read a state nobody earned',
          {
            unitId: unit.unitId,
            attemptId,
            outcome: verdict.outcome,
            state: after.state,
            expected,
          },
        );
      }
      return { unit: after, verdict: stored };
    });

    // `unknown` is evidence, not a result. The verdict is recorded — the wall's work
    // is not thrown away, and the panel can show what was measured — but the unit
    // does not move: it stays in the phase it was in, so a human decides rather than
    // the factory guessing in either direction (exit 5, the human-gate class).
    if (verdict.outcome === 'unknown') {
      throw new FactoryError(
        'VERDICT_UNKNOWN',
        `verdict for attempt ${attemptId} is unknown (${describeCodes(verdict.reasons)}); an unmeasured outcome is ` +
          `neither a pass nor a fail, so unit ${committed.unit.unitId} stays ${committed.unit.state} and a human ` +
          'must decide',
        {
          attemptId,
          unitId: committed.unit.unitId,
          verdictId: committed.verdict.verdictId,
          unitState: committed.unit.state,
          reasons: verdict.reasons,
        },
      );
    }

    return { unit: committed.unit, verdict: committed.verdict };
  }

  // ------------------------------------------------------------------- abort

  function abortUnit(unitId: string, reason: string): AbortResult {
    const unit = requireUnit(store, unitId);

    // A terminal unit is already the operator's last word: aborting twice must not
    // append a second event or move a timestamp. Idempotence is a property, not a
    // courtesy — a retried `factory abort` in a shell loop must be harmless.
    if (isTerminal(unit.state)) return { unit, changed: false };

    const at = nowIso();
    const opts = appendOptions(deps.traceId(), at);

    return store.atomic(() => {
      const lease = store.getLiveLease(unitId);
      if (lease !== null) store.releaseLease(lease.leaseId, at);

      // The live attempt is marked `aborted`, never `produced-receipt`: an attempt
      // that was stopped did not produce evidence, and pretending otherwise is the
      // one thing ambiguity exists to prevent.
      for (const attempt of store.listAttemptsForUnit(unitId)) {
        if (
          attempt.state === 'planned' ||
          attempt.state === 'launching' ||
          attempt.state === 'running'
        ) {
          store.setAttemptState(attempt.attemptId, 'aborted', { endedAt: at });
        }
      }

      return { unit: store.setUnitState(unitId, 'aborted', reason, opts), changed: true };
    });
  }

  // ----------------------------------------------------------------- recover

  function recover(input: { leaseTtlMs: number }): RecoverResult {
    const at = nowIso();
    const nowMs = deps.now().getTime();
    const opts = appendOptions(deps.traceId(), at);
    const recoveryRunId = deps.newId('REC-');

    // Recovery is one transaction: a half-reconciled ledger is worse than an
    // unreconciled one, because it looks accounted for.
    return store.atomic(() => {
      store.insertRecoveryRun({ recoveryRunId, startedAt: at });
      const expiredUnits = new Set(store.listExpiredLeases(at).map((lease) => lease.unitId));

      let ambiguous = 0;
      let orphaned = 0;

      for (const attempt of store.listActiveAttempts()) {
        const unit = store.getUnit(attempt.unitId);
        if (unit === null) {
          throw new FactoryError(
            'INTERNAL',
            `recovery found attempt ${attempt.attemptId} without unit ${attempt.unitId}; an attempt that outlived ` +
              'its unit record cannot be reconciled',
            { attemptId: attempt.attemptId, unitId: attempt.unitId, recoveryRunId },
          );
        }
        const lease = store.getLiveLease(unit.unitId);
        const leaseExpired = lease !== null && expiredUnits.has(unit.unitId);
        // A worker that never wrote a lease row is still stale once it has outlived
        // the TTL — the absence of a dead-man switch is not evidence of life.
        const outlivedTtl =
          lease === null && nowMs - Date.parse(attempt.startedAt) >= input.leaseTtlMs;

        if (isTerminal(unit.state)) {
          // The unit ended while the attempt was live: the attempt is an orphan.
          // Nothing is re-dispatched — the unit is finished, and a finished unit's
          // work does not get a second life because a container kept running.
          if (lease !== null) store.releaseLease(lease.leaseId, at);
          store.setAttemptState(attempt.attemptId, 'aborted', { endedAt: at });
          orphaned += 1;
          continue;
        }

        if (!leaseExpired && !outlivedTtl) continue;

        const reason =
          lease !== null
            ? `recovery ${recoveryRunId}: lease ${lease.leaseId} expired at ${lease.expiresAt} while the attempt ` +
              'was live; the outcome was never observed, so it is ambiguous, not failed'
            : `recovery ${recoveryRunId}: attempt outlived the ${input.leaseTtlMs}ms lease TTL with no live lease; ` +
              'the outcome was never observed, so it is ambiguous, not failed';

        store.setAttemptState(attempt.attemptId, 'ambiguous', { endedAt: at });
        // `setUnitState('ambiguous')` is what moves the aggregate, and the store
        // appends an `attempt.ambiguous` derived from it — with `observedAs:
        // 'unobserved'`, because the store did not observe the attempt. The engine
        // did: it is reconciling *this* attempt under its original identity, so it
        // appends that fact itself. The pair is deliberate and idempotent to replay
        // (`stateAfter` is), and the last word on the attempt names its identity.
        store.setUnitState(unit.unitId, 'ambiguous', reason, opts);
        store.appendEvent(
          {
            type: 'attempt.ambiguous',
            unitId: unit.unitId,
            attemptId: attempt.attemptId,
            observedAs: attempt.attemptId,
            reason,
          },
          opts,
        );
        if (lease !== null) store.releaseLease(lease.leaseId, at);
        ambiguous += 1;
      }

      // No redispatch, on purpose. The unit is now `ambiguous`, and
      // `assertDispatchable` only dispatches a `qualified` unit — so the factory
      // cannot talk itself into re-running work it lost track of. Resolution is a
      // human act: a late receipt can still reconcile the attempt, or the operator
      // aborts and submits a new revision.
      store.completeRecoveryRun(recoveryRunId, at, { orphanedAttempts: orphaned, ambiguous });
      store.appendEvent(
        { type: 'recovery.completed', recoveryRunId, orphanedAttempts: orphaned, ambiguous },
        opts,
      );

      return { recoveryRunId, ambiguous, orphaned };
    });
  }

  return { submitUnit, qualifyUnit, runUnit, observeAttempt, recordVerdict, abortUnit, recover };
}
