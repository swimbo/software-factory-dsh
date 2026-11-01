/**
 * `factory recover` — reconcile after a crash, and refuse to be helpful.
 *
 * What it may do: find attempts whose lease no longer vouches for them and mark
 * them `ambiguous`, release expired leases, and report. What it may **not** do:
 * re-dispatch, retry, delete or "fix" anything (`ux-plan.md` §3.9). A duplicate
 * side effect is unrecoverable; a lost attempt is not.
 *
 * Exit codes: `8` when the store is quarantined (nothing may be written), `4`
 * when reconciliation produced an ambiguous attempt — an ambiguous fact is a
 * measurement gap and the operator is being asked to observe (§3.4: "exit 4 for
 * every invocation that returns an ambiguous state") — otherwise `0`.
 */
import { FactoryError } from '@factory/contracts';

import { LEASE_TTL_MS } from '../context.ts';
import { field } from '../render/format.ts';
import { renderAmbiguity, buildStatus } from '../render/status.ts';
import type { VerbInput, VerbSpec } from './types.ts';

export function runRecover(input: VerbInput): number {
  const { ctx } = input;

  if (ctx.store.isQuarantined()) {
    throw new FactoryError(
      'STORE_QUARANTINED',
      'STORE_QUARANTINED: the factory is read-only. The store quarantined itself and recovery may not write. ' +
        'Read instead: factory audit --last 50. Do not reset, delete or re-initialise the store.',
      { location: ctx.store.location },
    );
  }

  const result = ctx.engine.recover({ leaseTtlMs: LEASE_TTL_MS });
  const ambiguousAttempts = ctx.store
    .listUnits()
    .flatMap((unit) => ctx.store.listAttemptsForUnit(unit.unitId))
    .filter((attempt) => attempt.state === 'ambiguous');

  input.emit({
    recoveryRunId: result.recoveryRunId,
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
    traceId: ctx.traceId,
  });

  const lines: string[] = [];
  lines.push(
    `RECONCILE  store ok (schema v${String(ctx.store.schemaVersion)}, ${ctx.store.eventCount()} event(s) in the ledger)`,
  );
  lines.push(
    `  ${result.ambiguous + result.orphaned} attempt(s) found without a terminal event, 0 redispatched`,
  );
  for (const attempt of ambiguousAttempts) {
    lines.push(`  ${attempt.attemptId}  ${attempt.unitId}  ${attempt.state}  -> AMBIGUOUS`);
    lines.push(`        observe: factory status ${attempt.unitId} --attempt ${attempt.attemptId}`);
  }
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
  return 0;
}

export const recoverVerb: VerbSpec = {
  name: 'recover',
  verb: 'recover',
  summary: 'Reconcile attempts left behind by a crash (never re-dispatches)',
  configure: () => undefined,
  action: runRecover,
};
