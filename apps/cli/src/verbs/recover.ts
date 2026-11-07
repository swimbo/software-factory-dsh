/**
 * `factory recover` — reconcile after a crash, and refuse to be helpful.
 *
 * What it may do: perform a **launch effect that is still pending** (the process never
 * started, so there is nothing to duplicate), find attempts whose lease no longer
 * vouches for them and mark them `ambiguous`, release expired leases, sweep a leaked
 * worker container, and report. What it may **not** do: re-dispatch, retry a
 * *measurement*, delete or "fix" anything else (`ux-plan.md` §3.9). A duplicate side
 * effect is unrecoverable; a lost attempt is not.
 *
 * ## The one thing it removes: a leaked worker container
 *
 * A `SIGKILL`ed control plane executes none of its exit paths, so the `docker run` client
 * that would have reaped `factory-worker-<attemptId>` is orphaned and the container
 * outlives the attempt. `recover` therefore sweeps the containers of the attempts **this
 * invocation** reconciled to `ambiguous` — and only those. It reads that attempt's
 * `launch.json`, and only when the record says the worker ran in a container does it
 * remove containers labelled `org.factory.attempt=<attemptId>`, by that id and nothing
 * else (never by image, never by a bare label). A live lease, a host child, a missing or
 * malformed record, and a docker that cannot be reached are all reported as
 * `skipped`/`failed` with the reason: "swept 0" is only ever said when the daemon
 * answered. A failed sweep is visible in text and `--json` but never changes the exit
 * code, because it is not a fact about the attempt an operator is being asked to
 * observe. The argument lives in `recover-sweep.ts`.
 *
 * ## Why a pending launch is retried, and why the lease is the guard
 *
 * `engine.runUnit` commits the intent to launch and does not launch it, so a crash
 * between commit and launch is exactly the case the outbox exists for. The evidence that
 * nothing is running is the *lease*: while a lease is live, some process may own this
 * attempt and a second launch could double-perform it. So a retry requires
 *
 *   1. the effect is `pending` (never settled — the launch was not performed);
 *   2. the attempt has no receipt and is not terminal (nothing was observed);
 *   3. the unit is still `dispatched` (no later phase owns it);
 *   4. the lease has **expired** — the only guard the factory has against launching into
 *      a live attempt;
 *   5. the effect has been attempted fewer than `MAX_LAUNCH_ATTEMPTS` times.
 *
 * A successful retry acquires a fresh lease before the worker starts, so the next
 * `recover` sees a live lease and cannot launch a third time.
 *
 * Exit codes: `8` when the store is quarantined (nothing may be written), `4` when
 * reconciliation produced an ambiguous attempt — an ambiguous fact is a measurement gap
 * and the operator is being asked to observe (§3.4: "exit 4 for every invocation that
 * returns an ambiguous state") — otherwise `0`. A sweep that failed does not move these
 * codes: the ambiguity did, the leak check is reported beside it.
 */
import { FactoryError } from '@factory/contracts';

import { LEASE_TTL_MS } from '../context.ts';
import { MAX_LAUNCH_ATTEMPTS, pendingLaunches, settleApplied, settleFailure } from '../effects.ts';
import { cloneAttempt, launchAttempt } from '../launch.ts';
import {
  resolveSweepAdapter,
  sweepReconciledAttempts,
  type AttemptSweepReport,
  type ReconciledAttempt,
} from '../recover-sweep.ts';

import { field } from '../render/format.ts';
import { renderAmbiguity, buildStatus } from '../render/status.ts';
import type { VerbInput, VerbSpec } from './types.ts';
import { resolveMirror } from './run.ts';

interface RelaunchReport {
  readonly applied: string[];
  readonly refused: string[];
  readonly deferred: string[];
}

/**
 * The sweep, as lines an operator can read — including the case where it did not run.
 *
 * The `FAILED` branch is deliberately louder than the others: it is the one state where the
 * factory does not know whether a container is still out there, and the line carries the exact
 * `docker ps` command that answers the question. Nothing here is allowed to read as a clean
 * sweep; `swept` with no ids is the only clean sentence, and it is only reachable when docker
 * answered.
 */
function renderSweeps(sweeps: readonly AttemptSweepReport[]): string[] {
  if (sweeps.length === 0) return [];
  const lines: string[] = [
    '',
    '  container sweep (recovery-side; the reconciled attempt id is the only filter):',
  ];
  for (const sweep of sweeps) {
    switch (sweep.status) {
      case 'swept':
        if (sweep.removed.length === 0) {
          lines.push(
            `    ${sweep.attemptId}  clean: docker answered, and no container carries label ` +
              `org.factory.attempt=${sweep.attemptId}`,
          );
        } else {
          lines.push(
            `    ${sweep.attemptId}  swept: removed ${sweep.removed.join(', ')}` +
              `${sweep.image === null ? '' : ` (leaked from ${sweep.image})`}`,
          );
        }
        break;
      case 'skipped':
        lines.push(`    ${sweep.attemptId}  skipped: ${sweep.reason ?? 'nothing to sweep'}`);
        break;
      case 'failed':
        lines.push(`    ${sweep.attemptId}  FAILED: ${sweep.reason ?? 'the sweep did not finish'}`);
        if (sweep.checkCommand !== null) {
          lines.push(
            `            a container may still be running for this attempt; check with: ${sweep.checkCommand}`,
          );
        }
        break;
    }
  }
  return lines;
}

/**
 * Perform pending launch effects whose attempt nothing is running for.
 *
 * Async because a launch is: the worker process is awaited here, exactly as `run` awaits
 * it. Nothing about the ordering is subtle — retries happen *before* the ambiguity
 * reconciliation, because an attempt whose launch never happened is not ambiguous, it is
 * incomplete, and letting the reconciler mark it first would turn a launchable unit into
 * one a person has to reason about.
 */
async function relaunchPendingEffects(ctx: VerbInput['ctx']): Promise<RelaunchReport> {
  const report: RelaunchReport = { applied: [], refused: [], deferred: [] };
  const expiredLeases = new Set(
    ctx.store.listExpiredLeases(ctx.nowIso()).map((lease) => lease.leaseId),
  );

  for (const effect of pendingLaunches(ctx.store)) {
    const payload = effect.payload as { attemptId?: unknown; unitId?: unknown } | null;
    const attemptId = typeof payload?.attemptId === 'string' ? payload.attemptId : null;
    const attempt = attemptId === null ? null : ctx.store.getAttempt(attemptId);
    if (attempt === null) {
      settleFailure(
        ctx.store,
        effect.effectId,
        'STORE_QUARANTINED',
        `launch effect names attempt ${String(attemptId)}, which the store does not hold; nothing can retry it`,
        ctx.nowIso(),
      );
      report.refused.push(effect.effectId);
      continue;
    }

    const unit = ctx.store.getUnit(attempt.unitId);
    if (unit === null) {
      settleFailure(
        ctx.store,
        effect.effectId,
        'STORE_QUARANTINED',
        `launch effect names unit ${attempt.unitId}, which the store does not hold`,
        ctx.nowIso(),
      );
      report.refused.push(effect.effectId);
      continue;
    }

    // A receipt proves the launch happened, whatever the row says. Repairing the row is
    // the honest response: the alternative is a pending effect that will be retried
    // against evidence that already exists, i.e. a second worker.
    const receipt = ctx.store.latestReceiptForUnit(unit.unitId);
    if (receipt !== null && receipt.attemptId === attempt.attemptId) {
      settleApplied(ctx.store, effect.effectId, ctx.nowIso());
      ctx.ui.err(
        field(
          'launch',
          `effect ${effect.effectId} is applied: attempt ${attempt.attemptId} already produced receipt ` +
            `${receipt.receiptId}; the row was pending, the work was done.`,
        ),
      );
      continue;
    }
    if (receipt !== null) {
      settleFailure(
        ctx.store,
        effect.effectId,
        'RECEIPT_CONFLICT',
        `unit ${unit.unitId} already has receipt ${receipt.receiptId} for attempt ${receipt.attemptId}; ` +
          `launching attempt ${attempt.attemptId} would file two receipts for one unit`,
        ctx.nowIso(),
      );
      report.refused.push(effect.effectId);
      continue;
    }

    // The one state `recover` may launch from: `launching` means `run` committed the
    // intent and never got as far as spawning a worker. `running` means a process may
    // exist, and a retry from there is exactly the double launch this guard exists to
    // prevent — the lease cannot help, because it is the *expired* lease that made the
    // attempt eligible in the first place.
    if (attempt.state === 'running' || attempt.state === 'produced-receipt') {
      report.deferred.push(effect.effectId);
      ctx.ui.err(
        field(
          'launch',
          `deferred: effect ${effect.effectId} stays pending — attempt ${attempt.attemptId} is ` +
            `'${attempt.state}', so a worker may already have run under it. A person decides; nothing is relaunched.`,
        ),
      );
      continue;
    }

    if (attempt.state === 'ambiguous' || unit.state !== 'dispatched') {
      settleFailure(
        ctx.store,
        effect.effectId,
        'UNIT_ALREADY_TERMINAL',
        `attempt ${attempt.attemptId} is '${attempt.state}' and unit is '${unit.state}'; a launch effect ` +
          'can only be performed for a dispatched, un-observed attempt',
        ctx.nowIso(),
      );
      report.refused.push(effect.effectId);
      continue;
    }

    if (!expiredLeases.has(attempt.leaseId)) {
      // Live lease: the process may be running. Retrying here is the double launch.
      report.deferred.push(effect.effectId);
      ctx.ui.err(
        field(
          'launch',
          `deferred: effect ${effect.effectId} stays pending — lease ${attempt.leaseId} is live, so something ` +
            'may already own this attempt. Recovery will retry after the lease expires.',
        ),
      );
      continue;
    }

    if (effect.attempts >= MAX_LAUNCH_ATTEMPTS) {
      settleFailure(
        ctx.store,
        effect.effectId,
        'EXECUTOR_UNAVAILABLE',
        `launched ${String(effect.attempts)} time(s) and refused again (${String(effect.lastError)}); ` +
          'recovery will not retry a launch that has never started',
        ctx.nowIso(),
      );
      report.refused.push(effect.effectId);
      ctx.ui.err(
        field(
          'launch',
          `exhausted: effect ${effect.effectId} failed ${String(effect.attempts)} time(s); a person must fix the ` +
            `cause. Last error: ${String(effect.lastError)}`,
        ),
      );
      continue;
    }

    const mirror = resolveMirror(ctx.env, unit.spec);
    if (!mirror.ok) {
      report.deferred.push(effect.effectId);
      ctx.ui.err(field('launch', `deferred: ${mirror.detail}`));
      continue;
    }

    const cloned = await cloneAttempt(ctx, effect.payload, mirror.pristineRepo, unit.spec.baseRev);
    if (!cloned.ok) {
      settleFailure(
        ctx.store,
        effect.effectId,
        'EXECUTOR_UNAVAILABLE',
        cloned.detail,
        ctx.nowIso(),
      );
      report.refused.push(effect.effectId);
      ctx.ui.err(field('launch', `refused: ${cloned.detail}`));
      continue;
    }

    // The expired lease is released *here* rather than left to the reconciler below: the
    // reconciler runs after the retries, and `acquireLease` refuses while any un-released
    // lease exists for the unit. Releasing it is also the truthful record — this lease no
    // longer vouches for anything, which is exactly why the launch is retryable.
    ctx.store.releaseLease(attempt.leaseId, ctx.nowIso());

    // A fresh lease before the worker starts: after this point the attempt is live again,
    // and the next `recover` will defer rather than launch a second process.
    ctx.store.acquireLease({
      leaseId: ctx.newId('LS-'),
      unitId: unit.unitId,
      owner: `recover:${ctx.traceId}`,
      acquiredAt: ctx.nowIso(),
      expiresAt: new Date(Date.parse(ctx.nowIso()) + LEASE_TTL_MS).toISOString(),
    });

    ctx.ui.err(
      field(
        'relaunch',
        `attempt ${attempt.attemptId} (effect ${effect.effectId}) — launching now; the effect was pending, ` +
          'so no worker had started',
      ),
    );
    const launched = await launchAttempt(
      ctx,
      effect.payload,
      effect.effectId,
      // Attempt numbers are 1-based for the executor's ledger context.
      ctx.store.listAttemptsForUnit(unit.unitId).length ?? 1,
      unit.spec.baseRev,
    );
    if (!launched.ok) {
      const settlement = settleFailure(
        ctx.store,
        effect.effectId,
        launched.code,
        launched.detail,
        ctx.nowIso(),
      );
      report.refused.push(effect.effectId);
      ctx.ui.err(field('launch', `refused (${settlement}): ${launched.detail}`));
      continue;
    }

    settleApplied(ctx.store, effect.effectId, ctx.nowIso());
    // Evidence is recovered here; the *verdict* stays an explicit act
    // (`factory run <unit> --verify-only`), because a judgement is a human-gate decision
    // and recovery only restores what was observed.
    ctx.engine.observeAttempt(attempt.attemptId, launched.receipt);
    report.applied.push(effect.effectId);
    ctx.ui.err(
      field(
        'recovered',
        `attempt ${attempt.attemptId} produced a receipt; the launch effect is applied. ` +
          `Next: factory run ${unit.unitId} --verify-only`,
      ),
    );
  }
  return report;
}

export async function runRecover(input: VerbInput): Promise<number> {
  const { ctx } = input;

  if (ctx.store.isQuarantined()) {
    throw new FactoryError(
      'STORE_QUARANTINED',
      'STORE_QUARANTINED: the factory is read-only. The store quarantined itself and recovery may not write. ' +
        'Read instead: factory audit --last 50. Do not reset, delete or re-initialise the store.',
      { location: ctx.store.location },
    );
  }

  // Retries first: an attempt whose launch never happened is incomplete, not ambiguous,
  // and marking it ambiguous first would ask a person about work nobody started.
  const relaunch = await relaunchPendingEffects(ctx);

  // The engine reports counts, not ids, and the sweep must name the attempts *this* invocation
  // reconciled. Recovery is one synchronous transaction against a local store, so "active
  // before, ambiguous after" is exactly that set — and it deliberately excludes attempts that
  // were already ambiguous, whose containers a person may be inspecting.
  const activeBefore = ctx.store.listActiveAttempts();
  const result = ctx.engine.recover({ leaseTtlMs: LEASE_TTL_MS });
  const reconciled: ReconciledAttempt[] = [];
  for (const attempt of activeBefore) {
    const after = ctx.store.getAttempt(attempt.attemptId);
    if (after !== null && after.state === 'ambiguous') {
      reconciled.push({ attemptId: after.attemptId, unitId: after.unitId });
    }
  }
  // The adapter is resolved lazily, and only when there is something to sweep: `recover` must
  // work on a host where the harness package is absent, and the common recovery has no
  // container to look for at all.
  const sweeps = sweepReconciledAttempts({
    home: ctx.home,
    env: ctx.env,
    attempts: reconciled,
    liveLease: (unitId) => ctx.store.getLiveLease(unitId),
    adapter: reconciled.length === 0 ? null : await resolveSweepAdapter(),
  });

  const ambiguousAttempts = ctx.store
    .listUnits()
    .flatMap((unit) => ctx.store.listAttemptsForUnit(unit.unitId))
    .filter((attempt) => attempt.state === 'ambiguous');

  input.emit({
    recoveryRunId: result.recoveryRunId,
    relaunched: relaunch.applied,
    launchDeferred: relaunch.deferred,
    launchRefused: relaunch.refused,
    ambiguous: result.ambiguous,
    orphaned: result.orphaned,
    ambiguityBlock:
      result.ambiguous === 0
        ? null
        : {
            known: 'these attempts started and did not report a terminal event',
            unknown: 'whether a final tool call took effect outside the worktree',
            notDone: 'nothing was retried and no second attempt exists',
          },
    attempts: ambiguousAttempts.map((attempt) => ({
      attemptId: attempt.attemptId,
      unitId: attempt.unitId,
      state: attempt.state,
      startedAt: attempt.startedAt,
    })),
    // The sweep as a value, not a sentence: a caller can tell "nothing was there" from "the
    // daemon was not reached" without parsing English. A failed sweep never changes the exit
    // code — the ambiguity does — but it must be impossible to miss.
    sweeps: sweeps.map((sweep) => ({
      attemptId: sweep.attemptId,
      unitId: sweep.unitId,
      status: sweep.status,
      image: sweep.image,
      removed: [...sweep.removed],
      remaining: [...sweep.remaining],
      reason: sweep.reason,
      checkCommand: sweep.checkCommand,
    })),
    traceId: ctx.traceId,
  });

  const lines: string[] = [];
  lines.push(
    `RECONCILE  store ok (schema v${String(ctx.store.schemaVersion)}, ${ctx.store.eventCount()} event(s) in the ledger)`,
  );
  lines.push(
    `  ${String(result.ambiguous + result.orphaned)} attempt(s) found without a terminal event, 0 redispatched`,
  );
  if (relaunch.applied.length > 0 || relaunch.deferred.length > 0 || relaunch.refused.length > 0) {
    lines.push(
      `  launch effects: ${String(relaunch.applied.length)} performed, ` +
        `${String(relaunch.deferred.length)} deferred (lease live or environment unusable), ` +
        `${String(relaunch.refused.length)} refused (now exhausted)`,
    );
  }
  for (const attempt of ambiguousAttempts) {
    lines.push(`  ${attempt.attemptId}  ${attempt.unitId}  ${attempt.state}  -> AMBIGUOUS`);
    lines.push(`        observe: factory status ${attempt.unitId} --attempt ${attempt.attemptId}`);
  }
  lines.push(...renderSweeps(sweeps));
  if (result.ambiguous > 0) {
    const model = buildStatus(ctx);
    for (const unit of model.units.filter((candidate) => candidate.state === 'ambiguous')) {
      lines.push('', ...renderAmbiguity(unit));
    }
  }
  lines.push(
    field(
      'RESULT',
      result.ambiguous === 0 && result.orphaned === 0
        ? 'nothing was dispatched, nothing was retried. Safe to re-run: factory recover is idempotent.'
        : 'nothing was dispatched and nothing was retried. Recovery recorded only facts it observed.',
    ),
  );
  for (const line of lines) ctx.ui.err(line);

  if (result.ambiguous > 0) return 4;

  // Exit 0 means "this invocation reconciled nothing", which an operator can easily
  // misread as "nothing needs me". A unit that is *already* ambiguous is still
  // waiting for a person, so it is said out loud rather than implied by a later
  // `factory status`. (Exit 4 is reserved for "this run produced an ambiguity",
  // §3.4; making it also mean "one already existed" would make the code untestable.)
  const stillAmbiguous = ambiguousAttempts.length;
  if (stillAmbiguous > 0) {
    ctx.ui.err(
      field(
        'WAITING',
        `still ambiguous: ${String(stillAmbiguous)} attempt(s) whose outcome was never observed. ` +
          'Nothing needs re-running; a person needs to look. See: factory status',
      ),
    );
  }
  return 0;
}

export const recoverVerb: VerbSpec = {
  name: 'recover',
  verb: 'recover',
  summary: 'Reconcile attempts left behind by a crash (never re-dispatches)',
  configure: () => undefined,
  action: runRecover,
};
