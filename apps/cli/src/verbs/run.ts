/**
 * `factory run` — dispatch one unit, and stop being helpful at the right moment.
 *
 * Three guards stand between the operator and a dispatch, in this order, because
 * each one is cheaper than the next and none of them may be skipped:
 *
 * 1. the unit exists (`UNIT_NOT_FOUND`, exit 3);
 * 2. the lane is `dark` (`LANE_NOT_DARK`, exit 3) — the factory has no verb that
 *    runs a lit unit, and that absence is the design, not an oversight;
 * 3. the machinery is present (`EXECUTOR_UNAVAILABLE`, exit 8). This guard runs
 *    *before* `engine.runUnit` on purpose: §5.2 promises "nothing dispatched, no
 *    reservation" when the executor is missing, and a reservation would be a
 *    budget hole for work that never started.
 *
 * After that the engine commits the attempt, the lease, the reservation and the
 * `launch` effect in one transaction; this command then performs that effect
 * through the adapter. A verdict is *not* invented here: when the wall cannot
 * measure, the run ends in `unknown` (exit 4), which is a fact about a
 * measurement, not a soft failure.
 */
import { existsSync, readFileSync, statSync } from 'node:fs';

import {
  FactoryError,
  MAX_ATTEMPTS_PER_UNIT,
  toDecisionReceipt,
  type ErrorCode,
  type UnitSpec,
} from '@factory/contracts';

import { UsageError } from '../exit.ts';
import { dispatched, running, transitionLine, verifying } from '../render/dispatch.ts';
import { field } from '../render/format.ts';
import { join } from 'node:path';
import {
  assertAttemptCapacity,
  assertWallCapacity,
  ceilingIsDefault,
  readOccupancy,
} from '../dispatch-limit.ts';
import { claimLaunchEffect, settleApplied, settleFailure } from '../effects.ts';
import {
  cloneAttempt,
  launchAttempt,
  type LaunchOutcome,
  type LaunchPayloadLike,
} from '../launch.ts';
import { evaluateReceipt, wallPolicyFrom } from '../wall.ts';
import { boolOption, textOption, type VerbInput, type VerbSpec } from './types.ts';

/**
 * The pristine mirror the attempt clone is cut from.
 *
 * Two keys, both required, both named in the refusal:
 *
 *   - `FACTORY_PRISTINE_REPO` — a path to a mirror (bare or ordinary) of the target
 *     repository. Never the operator's working tree: a worker that edits the tree every
 *     later attempt is cut from would make the base revision unreproducible, and the
 *     damage would only show up as an unexplained diff on someone else's unit.
 *   - `FACTORY_REPO` — the repo identity the unit was submitted against, so a mirror
 *     pointing at the wrong repository is caught before anything is dispatched.
 *
 * There is deliberately no fallback. "Run in the mirror" would be one line shorter and
 * would silently destroy the base for every later attempt; "run in the current directory"
 * would make the factory's evidence depend on where the operator happened to stand.
 */
type MirrorResolution =
  | { readonly ok: true; readonly pristineRepo: string }
  | { readonly ok: false; readonly detail: string };

export function resolveMirror(
  env: Readonly<Record<string, string | undefined>>,
  spec: UnitSpec,
): MirrorResolution {
  const pristine = (env.FACTORY_PRISTINE_REPO ?? '').trim();
  const repoId = (env.FACTORY_REPO ?? '').trim();
  const runbook =
    'runbook: set FACTORY_PRISTINE_REPO to a mirror of the target repository ' +
    '(git clone --mirror <repo-url> <path>) and FACTORY_REPO to the repo id the unit was submitted against';

  if (repoId === '') {
    return {
      ok: false,
      detail: `FACTORY_REPO is not set, so there is no way to tell whether the mirror is the right repository. ${runbook}`,
    };
  }
  if (repoId !== spec.repo) {
    return {
      ok: false,
      detail:
        `FACTORY_REPO is "${repoId}" but this unit was submitted against "${spec.repo}"; ` +
        `an attempt cloned from another repository would produce a patch nobody can apply. ${runbook}`,
    };
  }
  if (pristine === '') {
    return {
      ok: false,
      detail: `FACTORY_PRISTINE_REPO is not set, so the ${String(spec.baseRev).slice(0, 7)} base cannot be checked out. ${runbook}`,
    };
  }
  if (!existsSync(pristine) || !statSync(pristine).isDirectory()) {
    return {
      ok: false,
      detail: `FACTORY_PRISTINE_REPO=${pristine} is not a directory. ${runbook}`,
    };
  }
  const gitDir = join(pristine, '.git');
  if (!existsSync(join(pristine, 'HEAD')) && !existsSync(gitDir)) {
    return {
      ok: false,
      detail:
        `FACTORY_PRISTINE_REPO=${pristine} is not a git repository (no HEAD, no .git); ` +
        `a clone from it would fail inside the adapter, after the attempt was committed. ${runbook}`,
    };
  }
  return { ok: true, pristineRepo: pristine };
}

export async function runRun(input: VerbInput): Promise<number> {
  const { ctx } = input;
  const unitId = input.args[0];
  if (unitId === undefined || unitId.trim().length === 0) {
    throw new UsageError('USAGE: factory run <unitId> [--verify-only] [--json] [--no-wait]');
  }

  const verifyOnly = boolOption(input.options, 'verifyOnly');
  const retry = boolOption(input.options, 'retry');
  const reason = textOption(input.options, 'reason');
  // Declared as `.option('--no-wait')`, so commander sets `wait: false`. Reading
  // `options.noWait` (as this did) is always `undefined`: the flag was documented and
  // dead, and a documented flag that silently does the opposite is worse than a missing
  // one — it teaches the operator that the factory cannot be trusted about its own
  // surface.
  const noWait = input.options['wait'] === false;

  if (retry) {
    if (reason === undefined) {
      throw new UsageError(
        'USAGE: --retry requires --reason "<why>". A second attempt is an operator decision and is recorded as one.',
      );
    }
    throw new FactoryError(
      'UNIT_ALREADY_TERMINAL',
      'UNIT_ALREADY_TERMINAL: v1 has no retry path. A second attempt needs an engine command that does not exist yet, ' +
        'and faking one here would create exactly the duplicate side effect ambiguity exists to prevent. ' +
        `Nothing was dispatched; the reason "${reason}" was not recorded.`,
      { unitId, retry: true },
    );
  }

  const unit = ctx.store.getUnit(unitId);
  if (unit === null) {
    throw new FactoryError(
      'UNIT_NOT_FOUND',
      `UNIT_NOT_FOUND: no unit ${unitId}. See: factory status --all`,
      { unitId },
    );
  }

  if (verifyOnly) {
    // §5.5: `--verify-only` re-runs verification against the recorded receipt and can
    // never dispatch work. Without an instrument there is nothing to re-run, and saying
    // so is the whole point of the unknown class; with one, it re-measures — the same
    // `evaluate()` a full run uses, over evidence the store already holds.
    if (!ctx.wall.available) {
      throw new FactoryError(
        'WALL_UNAVAILABLE',
        `WALL_UNAVAILABLE: ${ctx.wall.detail}. Verdict stays unknown, which cannot promote.`,
        { unitId },
      );
    }
    if (ctx.wall.kind === 'fake') ctx.ui.err('wall: FAKE (no scenario executed)');

    const attempts = ctx.store.listAttemptsForUnit(unitId);
    const existing = attempts.length === 0 ? null : (attempts[attempts.length - 1] ?? null);
    // A verdict belongs to a unit in `receipted`/`ambiguous`; anything later has already
    // been decided, and re-deciding it would revise a judgement rather than re-measure
    // evidence. The engine says this with an INTERNAL (exit 1) phase error, which reads
    // like a bug report for an operator-visible condition.
    if (unit.state !== 'receipted' && unit.state !== 'ambiguous') {
      throw new FactoryError(
        'UNIT_ALREADY_TERMINAL',
        `UNIT_ALREADY_TERMINAL: ${unitId} is ${unit.state}; --verify-only re-measures a receipted or ambiguous ` +
          'attempt, and it never revises a verdict that already exists. Nothing was dispatched.',
        { unitId, state: unit.state },
      );
    }
    if (existing === null) {
      throw new FactoryError(
        'ATTEMPT_NOT_FOUND',
        `ATTEMPT_NOT_FOUND: ${unitId} has no attempt to re-verify. --verify-only re-measures recorded evidence; ` +
          'it never dispatches work. Nothing was dispatched and nothing was reserved.',
        { unitId },
      );
    }

    const mirror = resolveMirror(ctx.env, unit.spec);
    // Re-measurement is the same wall, over evidence the store already holds: the same
    // transition, so a re-verify reads like the run it replaces.
    ctx.ui.err(
      transitionLine(
        verifying(
          existing.attemptId,
          ctx.wall.kind === 'fake'
            ? 'wall FAKE - re-measuring the recorded receipt'
            : 'wall measuring: re-running the recorded receipt against the holdout',
        ),
      ),
    );
    const reVerdict =
      ctx.wall.kind === 'fake'
        ? evaluateWithWall(ctx, existing.attemptId)
        : await evaluateRealWall(
            ctx,
            unit,
            existing.attemptId,
            mirror.ok ? mirror.pristineRepo : '',
          );
    if (reVerdict === null) {
      throw new FactoryError(
        'WALL_UNAVAILABLE',
        'WALL_UNAVAILABLE: the wall could not re-measure this attempt (no receipt or no usable mirror); ' +
          'the verdict stays unknown. Nothing was dispatched and nothing was reserved.',
        { unitId, attemptId: existing.attemptId },
      );
    }
    const reRecorded = ctx.engine.recordVerdict(existing.attemptId, reVerdict);
    ctx.ui.err(
      transitionLine({
        kind: 'verdict',
        at: ctx.nowIso(),
        detail: `${reRecorded.verdict.outcome}  wall ${reRecorded.verdict.wallVersion}  re-verified, nothing dispatched`,
      }),
    );
    input.emit({
      unitId,
      attemptId: existing.attemptId,
      verdictId: reRecorded.verdict.verdictId,
      outcome: reRecorded.verdict.outcome,
      wallVersion: reRecorded.verdict.wallVersion,
      fakeWall: ctx.wall.kind === 'fake',
      dispatched: false,
      traceId: ctx.traceId,
    });
    return reRecorded.verdict.outcome === 'pass'
      ? 0
      : reRecorded.verdict.outcome === 'fail'
        ? 3
        : 4;
  }

  if (unit.lane !== 'dark') {
    throw new FactoryError(
      'LANE_NOT_DARK',
      `LANE_NOT_DARK: ${unitId} is lane=${String(unit.lane)}. The factory does not dispatch lit units. ` +
        `See: factory qualify ${unitId}`,
      { unitId, lane: unit.lane },
    );
  }
  if (!ctx.executor.available) {
    // Three environment faults, three codes, one exit: `EXECUTOR_UNAVAILABLE` means there is no way
    // to run a turn at all, `CONTAINER_UNAVAILABLE` means the turn could run but not where it was
    // asked to, and `CONFIGURATION_CONFLICT` means two settings are each valid and cannot both be
    // honoured. The difference is the operator's next action — install the runtime, build the image,
    // or unset one lever — so the code comes from the probe, which is the only thing that knows why.
    const code =
      ctx.executor.refusalCode ??
      (ctx.executor.isolation.mode === 'refused'
        ? 'CONTAINER_UNAVAILABLE'
        : 'EXECUTOR_UNAVAILABLE');
    throw new FactoryError(
      code,
      `${code}: ${ctx.executor.detail}. Nothing was dispatched and no budget was reserved.`,
      { unitId },
    );
  }

  // The clone needs a mirror, and a missing one is an environment fact, not a
  // dispatch failure: refuse before `runUnit`, so nothing is reserved and no attempt
  // exists for recovery to reconcile.
  const mirror = resolveMirror(ctx.env, unit.spec);
  if (!mirror.ok) {
    throw new FactoryError(
      'EXECUTOR_UNAVAILABLE',
      `EXECUTOR_UNAVAILABLE: ${mirror.detail}. Nothing was dispatched and no budget was reserved.`,
      { unitId, reason: 'pristine-repo-unusable' },
    );
  }

  // The ceiling is read *before* the transaction, for the same reason the budget gate is:
  // `runUnit` writes an attempt row, takes a lease and reserves budget, so a ceiling that
  // reserved first and refused afterwards would leave the operator with a busy factory and
  // an attempt that never ran. No attempt, no lease, no reservation — the spec asserts it.
  assertAttemptCapacity({
    read: readOccupancy(ctx.store, { excludeUnitId: unitId }),
    limit: ctx.limits.maxConcurrentAttempts,
    limitIsDefault: ceilingIsDefault(ctx.env, 'FACTORY_MAX_CONCURRENT_ATTEMPTS'),
    unitId,
  });

  const result = ctx.engine.runUnit(unitId);
  const attemptNo = unit.attemptCount + 1;
  ctx.ui.err(
    transitionLine(
      dispatched(
        result.attempt.attemptId,
        attemptNo,
        MAX_ATTEMPTS_PER_UNIT,
        `lease ${result.attempt.leaseId}  reservation ${result.reservation.kind}`,
      ),
    ),
  );

  const dispatchPayload = {
    unitId,
    attemptId: result.attempt.attemptId,
    attemptNo,
    leaseId: result.attempt.leaseId,
    launchKey: result.attempt.launchKey,
    reservation: { amountUsd: result.reservation.amountUsd, kind: result.reservation.kind },
    effectId: result.effect.effectId,
    // The *unit's* state: "dispatched" is the phase the operator cares about after a
    // dispatch. The attempt's own state (`launching`) is reported separately, because a
    // caller that wants to know whether a worker was started should not have to infer it
    // from a phase whose name it has to look up.
    state: result.unit.state,
    attemptState: result.attempt.state,
    traceId: ctx.traceId,
  };

  // The idempotency assert, before anything happens: the row `runUnit` committed is the
  // row this invocation is about to perform, and it must still be pending. A queue would
  // pop "some work"; this pops *this* work or refuses.
  const effect = claimLaunchEffect(ctx.store, result.attempt.launchKey, result.effect.effectId);

  if (noWait) {
    // `--no-wait` deliberately does not launch. The effect stays pending, and `recover`
    // is what performs it — once the lease has expired, because a live lease is the only
    // evidence the factory has that some process might already own this attempt.
    ctx.ui.err(
      field(
        'launch',
        `deferred: effect ${effect.effectId} stays pending. This build has no daemon; ` +
          `factory recover launches it once the lease expires.`,
      ),
    );
    input.emit(dispatchPayload);
    // The attempt id is the human-readable answer to "what do I observe?" — printed only
    // when nothing else already owns stdout, because `--json` promises exactly one object
    // and a second line would break every caller that parses it.
    if (!ctx.ui.json) ctx.ui.out(result.attempt.attemptId);
    ctx.ui.err(field('observe', `factory status ${unitId} --attempt ${result.attempt.attemptId}`));
    return 0;
  }

  const cloned = await cloneAttempt(
    ctx,
    result.effect.payload,
    mirror.pristineRepo,
    unit.spec.baseRev,
  );
  if (!cloned.ok) {
    // Nothing started, and the cause is the environment: leave the effect pending so
    // `recover` can perform it after the mirror is fixed. Exhausting it here would make
    // the outbox say "never" about a launch that is merely blocked.
    settleFailure(ctx.store, effect.effectId, 'EXECUTOR_UNAVAILABLE', cloned.detail, ctx.nowIso());
    throw new FactoryError(
      'EXECUTOR_UNAVAILABLE',
      `EXECUTOR_UNAVAILABLE: ${cloned.detail}. Attempt ${result.attempt.attemptId} stays recorded and launch ` +
        `effect ${effect.effectId} stays pending (retryable): factory recover performs it once the lease ` +
        'expires. Nothing was launched.',
      { unitId, attemptId: result.attempt.attemptId, effectId: effect.effectId, retryable: true },
    );
  }

  // The worker starts here. This line precedes the await on purpose: `running` is the
  // state an operator is *in* while the turn happens, and printing it afterwards would
  // report a history rather than a status.
  ctx.ui.err(transitionLine(running(result.attempt.attemptId, ctx.executor.kind)));

  // Record "a process may exist from this instant" *before* spawning it. This is the fact
  // `recover` reads to decide whether a pending launch may be performed: an attempt still
  // `launching` never started a worker, while a `running` one may have — and retrying the
  // latter is the double launch the lease alone cannot rule out once the lease expires.
  ctx.store.setAttemptState(result.attempt.attemptId, 'running', {});

  const launched = await launchAttempt(
    ctx,
    result.effect.payload,
    result.effect.effectId,
    attemptNo,
    unit.spec.baseRev,
  );
  if (!launched.ok) {
    // A refusal from the adapter is not one thing. `ATTEMPT_AMBIGUOUS` is a fact
    // about a measurement ("the turn never ended"), not about the environment, and
    // collapsing it into EXECUTOR_UNAVAILABLE (exit 8) would tell the operator to
    // install software when the truth is that a worker has to be looked at. The
    // code is passed through verbatim and the exit code follows from it; the effect is
    // settled by the same distinction (applied / retryable / exhausted).
    const settlement = settleFailure(
      ctx.store,
      effect.effectId,
      launched.code,
      launched.detail,
      ctx.nowIso(),
    );
    // The launcher refused before spawning anything, so the attempt is not running: put it
    // back to `launching` and a later `recover` may retry it. Leaving it `running` would
    // make the store claim a process that never existed.
    if (settlement === 'retryable') {
      ctx.store.setAttemptState(result.attempt.attemptId, 'launching', {});
    }
    throw new FactoryError(
      launched.code,
      `${launched.code}: ${launched.detail}. Launch effect ${effect.effectId} is ${settlement}`,
      {
        unitId,
        attemptId: result.attempt.attemptId,
        effectId: effect.effectId,
        effectSettlement: settlement,
        retryable: settlement === 'retryable',
      },
    );
  }

  // The worker ran. Settle before observing: a crash between these two lines must not
  // leave an applied launch marked pending, or `recover` would start a second worker to
  // ask what the first one did.
  settleApplied(ctx.store, effect.effectId, ctx.nowIso());
  ctx.engine.observeAttempt(result.attempt.attemptId, launched.receipt);
  const receipt = ctx.store.latestReceiptForUnit(unitId);
  ctx.ui.err(
    transitionLine({
      kind: 'receipt',
      at: ctx.nowIso(),
      detail: `${receipt?.receiptId ?? '<unknown>'}  ${receipt?.receiptSha ?? ''}`,
    }),
  );

  // The wall is about to measure. Between this line and the verdict line the worker is
  // done and the judgement is in progress — a different wait, with a different failure mode.
  ctx.ui.err(
    transitionLine(
      verifying(
        result.attempt.attemptId,
        ctx.wall.kind === 'fake'
          ? 'wall FAKE - no scenario executed'
          : 'wall measuring: holdout + pinned suite, receipt re-executed',
      ),
    ),
  );
  if (ctx.wall.kind === 'fake') ctx.ui.err('wall: FAKE (no scenario executed)');
  const verdict =
    ctx.wall.kind === 'fake'
      ? evaluateWithWall(ctx, result.attempt.attemptId)
      : await evaluateRealWall(ctx, unit, result.attempt.attemptId, mirror.pristineRepo);
  if (verdict === null) {
    // The wall is the only thing that may turn a receipt into a verdict, and the
    // real evaluate() port is not wired in this build. So the run ends in `unknown`:
    // exit 4, with the next command named. It is not a pass and not a failure.
    input.emit({
      ...dispatchPayload,
      outcome: 'unknown',
      verdictId: null,
      receiptSha: ctx.store.latestReceiptForUnit(unitId)?.receiptSha ?? null,
      fakeWall: ctx.wall.kind === 'fake',
    });
    ctx.ui.err(
      'verdict      unknown - the wall did not evaluate this attempt (no wall port wired in v1)',
    );
    ctx.ui.err(`Next:        restore the wall, then: factory run ${unitId} --verify-only`);
    return 4;
  }

  let recorded: ReturnType<typeof ctx.engine.recordVerdict>;
  try {
    recorded = ctx.engine.recordVerdict(result.attempt.attemptId, verdict);
  } catch (error) {
    // `unknown` is evidence, not a result: the engine records the verdict and then
    // refuses to move the unit, so the caller gets the human-gate refusal *and* the row
    // it is about. Re-emitting the dispatch payload alongside it is what lets a caller
    // see the outcome without scraping a message.
    if (error instanceof FactoryError && error.code === 'VERDICT_UNKNOWN') {
      const unknownVerdict = verdict as unknown as {
        readonly outcome?: string;
        readonly verdictId?: string;
        readonly wallVersion?: string;
        readonly reasons?: readonly string[];
        readonly receiptSha?: string;
      };
      input.emit({
        ...dispatchPayload,
        outcome: 'unknown',
        verdictId: unknownVerdict.verdictId ?? null,
        receiptSha:
          unknownVerdict.receiptSha ?? ctx.store.latestReceiptForUnit(unitId)?.receiptSha ?? null,
        wallVersion: unknownVerdict.wallVersion ?? null,
        reasons: [...(unknownVerdict.reasons ?? [])],
        fakeWall: ctx.wall.kind === 'fake',
        needsPerson: true,
      });
      ctx.ui.err(`unknown      ${error.message}`);
      ctx.ui.err(
        `Next:        factory status ${unitId}  (a person decides; the verdict is recorded)`,
      );
      // One JSON object per invocation: the payload above is it, so the refusal is
      // returned as an exit code rather than thrown into the error funnel as well.
      return 5;
    }
    throw error;
  }
  const decided = recorded.verdict;
  ctx.ui.err(
    transitionLine({
      kind: 'verdict',
      at: ctx.nowIso(),
      detail: `${decided.outcome}  wall ${decided.wallVersion}  ${decided.verdict.reasons.join(',') || 'no reasons'}`,
    }),
  );
  for (const scenario of decided.verdict.scenarios) {
    ctx.ui.err(
      field(
        scenario.id,
        `${scenario.outcome}${scenario.observed === null ? '' : `  ${scenario.observed}`}`,
      ),
    );
  }
  if (decided.verdict.promotionRequiresHumanSignature === true) {
    ctx.ui.err(
      'signature    promotion will need an operator ed25519 signature (task class not certifiable)',
    );
  }
  input.emit({
    ...dispatchPayload,
    state: ctx.store.getUnit(unitId)?.state ?? recorded.unit.state,
    outcome: decided.outcome,
    verdictId: decided.verdictId,
    receiptSha: decided.receiptSha,
    wallVersion: decided.wallVersion,
    reasons: [...decided.verdict.reasons],
    fakeWall: ctx.wall.kind === 'fake',
  });
  if (decided.outcome === 'pass') return 0;
  if (decided.outcome === 'fail') {
    ctx.ui.err(
      `Next:        factory abort ${unitId} --reason "<why>"   (a failed attempt is not retried in v1)`,
    );
    return 3;
  }
  ctx.ui.err(`Next:        factory status ${unitId}   (unknown is not pass: nothing may promote)`);
  return 4;
}

/**
 * The wall seam, in the order the design demands.
 *
 * `FACTORY_WALL=fake` replays a **declared** verdict template and stamps onto it the
 * three facts only the factory can know — the attempt, the unit and the receipt sha
 * it actually stored — plus a `wallVersion` ending in `-fake`. Everything else,
 * including the reasons, comes from the template, so a spec can produce a labelled
 * fake pass and the promotion gate can refuse it (see `promote.ts`).
 *
 * The real branch is deliberately absent rather than approximated: without
 * `evaluate()` + a scenario runner there is no measurement, and inventing one here
 * would be exactly the L1 violation the receipt exists to prevent.
 */
function evaluateWithWall(
  ctx: VerbInput['ctx'],
  attemptId: string,
): Record<string, unknown> | null {
  if (ctx.wall.kind !== 'fake' || ctx.wall.verdictPath === null) return null;
  const attempt = ctx.store.getAttempt(attemptId);
  const receipt = attempt === null ? null : ctx.store.latestReceiptForUnit(attempt.unitId);
  if (receipt === null || receipt === undefined) {
    throw new FactoryError(
      'RECEIPT_CONFLICT',
      `RECEIPT_CONFLICT: no stored receipt for attempt ${attemptId}`,
      {
        attemptId,
      },
    );
  }
  const template = JSON.parse(readFileSync(ctx.wall.verdictPath, 'utf8')) as Record<
    string,
    unknown
  >;
  return {
    ...template,
    unitId: attempt?.unitId ?? template['unitId'],
    attemptId,
    receiptSha: receipt.receiptSha,
    holdoutRevision: template['holdoutRevision'] ?? 'fake-holdout@0',
    policyVersion: template['policyVersion'] ?? ctx.policyVersion,
    // Named, always, whatever the template says: a verdict this wall produced must
    // never be mistakable for a measured one.
    wallVersion: `${String(template['wallVersion'] ?? 'wall/0.1.0')}-fake`,
    evaluatedAt: ctx.nowIso(),
  };
}

/**
 * The real wall: `evaluate()` in `@factory/wall`, driven by the local runner.
 *
 * `null` means "this build cannot measure", and the caller reports `unknown` (exit 4).
 * It is returned — rather than an invented verdict — for the same reason the receipt
 * exists: a judgement nobody measured is worse than no judgement.
 */
async function evaluateRealWall(
  ctx: VerbInput['ctx'],
  unit: { readonly unitId: string; readonly spec: UnitSpec },
  attemptId: string,
  pristineRepo: string,
): Promise<Record<string, unknown> | null> {
  const attempt = ctx.store.getAttempt(attemptId);
  if (attempt === null) return null;
  const receiptRow = ctx.store.latestReceiptForUnit(attempt.unitId);
  if (receiptRow === null) return null;
  const wallModule = await import('@factory/wall').catch(() => null);
  if (wallModule === null) return null;

  const policy = wallPolicyFrom(ctx.env, unit.spec);
  // Named on every run: this instrument measures behaviour and provides no containment.
  ctx.ui.err('wall: local runner (+local, no container isolation)');
  if (policy.pinnedSuite === null) {
    ctx.ui.err(
      'wall: no FACTORY_WALL_SUITE declared — the wall has no oracle of its own, so the verdict cannot pass',
    );
  }
  // Where the wall would start, and nowhere else: two units must not measure at once when
  // the operator capped walls at one. This is after the attempt (a wall measures a receipt),
  // so the refusal leaves an attempt with no verdict rather than a verdict nobody measured.
  assertWallCapacity({
    read: readOccupancy(ctx.store, { excludeUnitId: unit.unitId }),
    limit: ctx.limits.maxConcurrentWalls,
    limitIsDefault: ceilingIsDefault(ctx.env, 'FACTORY_MAX_CONCURRENT_WALLS'),
    unitId: unit.unitId,
  });

  const outcome = await evaluateReceipt({
    spec: unit.spec,
    receipt: toDecisionReceipt(receiptRow.receipt),
    patchFile: receiptRow.receipt.diff.patchFile,
    pristineRepo,
    policy,
    nowIso: ctx.nowIso(),
    policyVersion: ctx.policyVersion,
    home: ctx.env['HOME'] ?? null,
    // The certificate records the model the attempt actually ran under, so a later policy or model
    // change can be detected instead of inferred. Absent is `null`, which the audit treats as
    // "cannot prove current" rather than "unchanged".
    ...(() => {
      const configured = (ctx.env['FACTORY_MODEL_ID'] ?? '').trim();
      return configured === '' ? {} : { modelId: configured };
    })(),
  });
  if (!outcome.holdoutLoaded) {
    ctx.ui.err(
      `wall: no holdout corpus for task class "${policy.taskClass}" under ${
        policy.holdoutRoot ?? '~/.factory/holdout'
      }; Δ is unmeasured, so this cannot pass`,
    );
  }
  // `Verdict.receiptSha` names the receipt the factory holds. The wall hashes the
  // *decision* receipt it is given (L1: no narrative), while the store hashes the whole
  // worker receipt — so for any attempt that produced a narrative the two hashes differ
  // by construction. The stored sha is the one `recordVerdict` can resolve, and it is
  // the receipt this verdict actually judged, so it is stamped here rather than the
  // wall's own view of the same bytes. Reported as an integration gap: either the
  // contract should carry the store sha on the input, or the store should hash the
  // decision receipt.
  return { ...outcome.verdict, receiptSha: receiptRow.receiptSha } as unknown as Record<
    string,
    unknown
  >;
}

export const runVerb: VerbSpec = {
  name: 'run',
  verb: 'run',
  summary: 'Dispatch one dark unit and follow it until it reaches a terminal state',
  arguments: ['<unitId>'],
  configure: (command) =>
    command
      .option(
        '--verify-only',
        're-run verification against the existing receipt (never dispatches)',
      )
      .option('--no-wait', 'return after the attempt is recorded, printing the attempt id')
      .option('--retry', 'create a second attempt (requires --reason; unavailable in v1)')
      .option('--reason <text>', 'why a retry is justified (recorded in the ledger)')
      .option(
        '--scenario <path>',
        'TEST ONLY: run the fake executor with this JSON scenario (needs FACTORY_EXECUTOR=fake)',
      )
      .option(
        '--verdict <path>',
        'TEST ONLY: fake wall verdict template (needs FACTORY_WALL=fake)',
      ),
  action: runRun,
};
