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
import { dispatched, transitionLine } from '../render/dispatch.ts';
import { field } from '../render/format.ts';
import { join } from 'node:path';
import { evaluateReceipt, wallPolicyFrom } from '../wall.ts';
import { boolOption, textOption, type VerbInput, type VerbSpec } from './types.ts';

interface LaunchPayloadLike {
  readonly attemptId: string;
  readonly unitId: string;
  readonly attemptDir: string;
}

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
  const noWait = boolOption(input.options, 'noWait');

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
    throw new FactoryError(
      'EXECUTOR_UNAVAILABLE',
      `EXECUTOR_UNAVAILABLE: ${ctx.executor.detail}. Nothing was dispatched and no budget was reserved.`,
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
    state: result.attempt.state,
    traceId: ctx.traceId,
  };

  if (noWait) {
    input.emit(dispatchPayload);
    // `--no-wait` is the one place a payload goes to stdout without `--json`: the
    // attempt id is what the caller needs to observe it later.
    ctx.ui.out(result.attempt.attemptId);
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
    throw new FactoryError(
      'EXECUTOR_UNAVAILABLE',
      `EXECUTOR_UNAVAILABLE: ${cloned.detail}. The attempt stays recorded and its lease will be reconciled by ` +
        'factory recover; nothing was launched.',
      { unitId, attemptId: result.attempt.attemptId },
    );
  }

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
    // code is passed through verbatim and the exit code follows from it.
    throw new FactoryError(
      launched.code,
      `${launched.code}: ${launched.detail}. The launch effect stays pending: nothing is retried here, ` +
        'and recovery reconciles the attempt from its lease.',
      { unitId, attemptId: result.attempt.attemptId, effectId: result.effect.effectId },
    );
  }

  ctx.engine.observeAttempt(result.attempt.attemptId, launched.receipt);
  const receipt = ctx.store.latestReceiptForUnit(unitId);
  ctx.ui.err(
    transitionLine({
      kind: 'receipt',
      at: ctx.nowIso(),
      detail: `${receipt?.receiptId ?? '<unknown>'}  ${receipt?.receiptSha ?? ''}`,
    }),
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

/** Cut the attempt clone from the mirror. The mirror is only ever read. */
async function cloneAttempt(
  ctx: VerbInput['ctx'],
  payload: unknown,
  pristineRepo: string,
  baseRev: string,
): Promise<{ readonly ok: true } | { readonly ok: false; readonly detail: string }> {
  const launch = payload as LaunchPayloadLike;
  const adapter = await import('@factory/dsh-adapter').catch(() => null);
  if (adapter === null) {
    return { ok: false, detail: 'the @factory/dsh-adapter package could not be imported' };
  }
  try {
    await adapter.createAttemptClone({ pristineRepo, baseRev, attemptDir: launch.attemptDir });
    return { ok: true };
  } catch (error) {
    return {
      ok: false,
      detail: `cannot check out ${baseRev.slice(0, 7)} from ${pristineRepo}: ${
        error instanceof Error ? error.message : String(error)
      }`,
    };
  }
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
  const outcome = await evaluateReceipt({
    spec: unit.spec,
    receipt: toDecisionReceipt(receiptRow.receipt),
    patchFile: receiptRow.receipt.diff.patchFile,
    pristineRepo,
    policy,
    nowIso: ctx.nowIso(),
    policyVersion: ctx.policyVersion,
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

type LaunchOutcome =
  | { readonly ok: true; readonly receipt: unknown }
  | { readonly ok: false; readonly code: ErrorCode; readonly detail: string };

/**
 * Perform the launch effect through `@factory/dsh-adapter`, resolved lazily: the
 * adapter is optional by construction, and a host without it must get a refusal
 * rather than an import-time crash.
 */
async function launchAttempt(
  ctx: VerbInput['ctx'],
  payload: unknown,
  effectId: string,
  attemptNo: number,
  baseRev: string,
): Promise<LaunchOutcome> {
  const launch = payload as LaunchPayloadLike;
  if (ctx.executor.kind === 'fake' && ctx.executor.scenarioPath !== null) {
    // Test-only, and bannered before it does anything (`--scenario` on `run`).
    ctx.ui.err('executor: FAKE (no DSH process launched)');
    const adapter = await import('@factory/dsh-adapter').catch(() => null);
    if (adapter === null)
      return {
        ok: false,
        code: 'EXECUTOR_UNAVAILABLE',
        detail: 'the @factory/dsh-adapter package could not be imported',
      };
    try {
      const pidFile = (ctx.env.FACTORY_SCENARIO_PID_FILE ?? '').trim();
      const executor = adapter.createFakeExecutorFromFile(ctx.executor.scenarioPath, {
        factoryHome: ctx.home,
        baseRev,
        ...(pidFile === '' ? {} : { pidFile }),
        log: {
          info: (fields: Record<string, unknown>, message?: string) =>
            ctx.ui.err(message ?? JSON.stringify(fields)),
          warn: (fields: Record<string, unknown>, message?: string) =>
            ctx.ui.err(`WARN ${message ?? JSON.stringify(fields)}`),
          error: (fields: Record<string, unknown>, message?: string) =>
            ctx.ui.err(`ERROR ${message ?? JSON.stringify(fields)}`),
        },
      });
      return {
        ok: true,
        receipt: await executor.run(launch, { effectId, attempt: attemptNo - 1 }),
      };
    } catch (error) {
      if (error instanceof FactoryError)
        return { ok: false, code: error.code, detail: error.message };
      return {
        ok: false,
        code: 'EXECUTOR_UNAVAILABLE',
        detail: error instanceof Error ? error.message : String(error),
      };
    }
  }
  const proxyBaseUrl = (ctx.env.FACTORY_PROXY_BASE_URL ?? '').trim();
  const modelId = (ctx.env.FACTORY_MODEL_ID ?? '').trim();
  if (proxyBaseUrl.length === 0 || modelId.length === 0) {
    return {
      ok: false,
      code: 'EXECUTOR_UNAVAILABLE',
      detail:
        'FACTORY_PROXY_BASE_URL and FACTORY_MODEL_ID must be set for a launch; no proxy means no worker',
    };
  }
  if (ctx.executor.binPath === null)
    return { ok: false, code: 'EXECUTOR_UNAVAILABLE', detail: 'no dsh binary' };

  const adapter = await import('@factory/dsh-adapter').catch(() => null);
  if (adapter === null)
    return {
      ok: false,
      code: 'EXECUTOR_UNAVAILABLE',
      detail: 'the @factory/dsh-adapter package could not be imported',
    };

  try {
    const executor = adapter.createDshExecutor({
      dshBin: ctx.executor.binPath,
      factoryHome: ctx.home,
      proxyBaseUrl,
      modelId,
      log: {
        info: (fields: Record<string, unknown>, message?: string) =>
          ctx.ui.err(message ?? JSON.stringify(fields)),
        warn: (fields: Record<string, unknown>, message?: string) =>
          ctx.ui.err(`WARN ${message ?? JSON.stringify(fields)}`),
        error: (fields: Record<string, unknown>, message?: string) =>
          ctx.ui.err(`ERROR ${message ?? JSON.stringify(fields)}`),
      },
    });
    const receipt = await executor.run(launch, { effectId, attempt: attemptNo - 1 });
    return { ok: true, receipt };
  } catch (error) {
    if (error instanceof FactoryError)
      return { ok: false, code: error.code, detail: error.message };
    return {
      ok: false,
      code: 'EXECUTOR_UNAVAILABLE',
      detail: error instanceof Error ? error.message : String(error),
    };
  }
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
