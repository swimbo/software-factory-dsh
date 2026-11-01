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
import { FactoryError, MAX_ATTEMPTS_PER_UNIT } from '@factory/contracts';

import { UsageError } from '../exit.ts';
import { dispatched, transitionLine } from '../render/dispatch.ts';
import { field } from '../render/format.ts';
import { boolOption, textOption, type VerbInput, type VerbSpec } from './types.ts';

interface LaunchPayloadLike {
  readonly attemptId: string;
  readonly unitId: string;
  readonly attemptDir: string;
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

  if (verifyOnly) {
    // §5.5: `--verify-only` re-runs verification against the existing receipt and
    // cannot dispatch work. Without a wall there is nothing to re-run, and saying
    // so is the whole point of the unknown class.
    if (!ctx.wall.available) {
      throw new FactoryError(
        'WALL_UNAVAILABLE',
        `WALL_UNAVAILABLE: ${ctx.wall.detail}. Verdict stays unknown, which cannot promote.`,
        { unitId },
      );
    }
    throw new FactoryError(
      'WALL_UNAVAILABLE',
      'WALL_UNAVAILABLE: the wall is present but this build does not wire its evaluate() port. ' +
        'The verdict stays unknown; nothing was dispatched and nothing was reserved.',
      { unitId, reason: 'wall-port-not-wired' },
    );
  }

  const unit = ctx.store.getUnit(unitId);
  if (unit === null) {
    throw new FactoryError(
      'UNIT_NOT_FOUND',
      `UNIT_NOT_FOUND: no unit ${unitId}. See: factory status --all`,
      {
        unitId,
      },
    );
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

  input.emit({
    unitId,
    attemptId: result.attempt.attemptId,
    attemptNo,
    leaseId: result.attempt.leaseId,
    launchKey: result.attempt.launchKey,
    reservation: { amountUsd: result.reservation.amountUsd, kind: result.reservation.kind },
    effectId: result.effect.effectId,
    state: result.attempt.state,
    traceId: ctx.traceId,
  });

  if (noWait) {
    // `--no-wait` is the one place a payload goes to stdout without `--json`: the
    // attempt id is what the caller needs to observe it later.
    ctx.ui.out(result.attempt.attemptId);
    ctx.ui.err(field('observe', `factory status ${unitId} --attempt ${result.attempt.attemptId}`));
    return 0;
  }

  const launched = await launchAttempt(
    ctx,
    result.effect.payload,
    result.effect.effectId,
    attemptNo,
  );
  if (!launched.ok) {
    throw new FactoryError(
      'EXECUTOR_UNAVAILABLE',
      `EXECUTOR_UNAVAILABLE: ${launched.detail}. The launch effect stays pending: nothing is retried here, ` +
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

  // The wall is the only thing that may turn a receipt into a verdict, and this
  // build does not wire its evaluate() port. So the run ends in `unknown`: exit 4,
  // with the next command named. It is not a pass and it is not a failure.
  ctx.ui.err(
    'verdict      unknown - the wall did not evaluate this attempt (no wall port wired in v1)',
  );
  ctx.ui.err(`Next:        restore the wall, then: factory run ${unitId} --verify-only`);
  return 4;
}

type LaunchOutcome =
  | { readonly ok: true; readonly receipt: unknown }
  | { readonly ok: false; readonly detail: string };

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
): Promise<LaunchOutcome> {
  const launch = payload as LaunchPayloadLike;
  const proxyBaseUrl = (ctx.env.FACTORY_PROXY_BASE_URL ?? '').trim();
  const modelId = (ctx.env.FACTORY_MODEL_ID ?? '').trim();
  if (proxyBaseUrl.length === 0 || modelId.length === 0) {
    return {
      ok: false,
      detail:
        'FACTORY_PROXY_BASE_URL and FACTORY_MODEL_ID must be set for a launch; no proxy means no worker',
    };
  }
  if (ctx.executor.binPath === null) return { ok: false, detail: 'no dsh binary' };

  const adapter = await import('@factory/dsh-adapter').catch(() => null);
  if (adapter === null)
    return { ok: false, detail: 'the @factory/dsh-adapter package could not be imported' };

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
    const detail = error instanceof Error ? error.message : String(error);
    return { ok: false, detail };
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
      .option('--reason <text>', 'why a retry is justified (recorded in the ledger)'),
  action: runRun,
};
