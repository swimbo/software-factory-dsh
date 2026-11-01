/**
 * `factory abort` — end a unit, leave everything else alone.
 *
 * Abort is a *reasoned confirmation*, not a gate (`ux-plan.md` §4.4): it is
 * recoverable by resubmitting, so it must stay fast — but `--reason` is required,
 * because an abort with no recorded reason is an unauditable decision.
 *
 * What it does not do: roll anything back. The worktree and the ambiguous attempt
 * stay exactly as they were found, and the printout says so — an operator who
 * believes an abort cleaned up is an operator who will run the next command with
 * a wrong picture of the state.
 */
import { FactoryError } from '@factory/contracts';

import { UsageError } from '../exit.ts';
import { field } from '../render/format.ts';
import { textOption, type VerbInput, type VerbSpec } from './types.ts';

export function runAbort(input: VerbInput): number {
  const { ctx } = input;
  const unitId = input.args[0];
  if (unitId === undefined || unitId.trim().length === 0) {
    throw new UsageError('USAGE: factory abort <unitId> --reason "<why>"');
  }
  const reason = textOption(input.options, 'reason');
  if (reason === undefined) {
    throw new UsageError(
      'USAGE: --reason is required. An abort with no recorded reason is an unauditable decision; ' +
        'the ledger keeps the string forever.',
    );
  }

  const before = ctx.store.getUnit(unitId);
  if (before === null) {
    throw new FactoryError(
      'UNIT_NOT_FOUND',
      `UNIT_NOT_FOUND: no unit ${unitId}. See: factory status --all`,
      {
        unitId,
      },
    );
  }

  const previousState = before.state;
  const result = ctx.engine.abortUnit(unitId, reason);

  if (!result.changed) {
    throw new FactoryError(
      'UNIT_ALREADY_TERMINAL',
      `UNIT_ALREADY_TERMINAL: ${unitId} is ${result.unit.state} since ${String(result.unit.terminalAt ?? result.unit.updatedAt)}. ` +
        'Nothing was written; resubmit a new revision instead.',
      { unitId, state: result.unit.state },
    );
  }

  input.emit({
    unitId,
    state: result.unit.state,
    previousState,
    reason,
    terminalAt: result.unit.terminalAt,
    traceId: ctx.traceId,
  });

  ctx.ui.err(
    `ABORTED  ${unitId}  terminal   (was: ${previousState})   attempt stays as found, untouched`,
  );
  ctx.ui.err(field('  reason', `recorded in the ledger, attributed to the operator: ${reason}`));
  ctx.ui.err(
    field(
      '  nothing',
      `rolled back - the worktree at ${ctx.paths.work}/${unitId}/ is left in place for inspection`,
    ),
  );
  return 0;
}

export const abortVerb: VerbSpec = {
  name: 'abort',
  verb: 'abort',
  summary: 'End a unit terminally, recording the reason (no rollback)',
  arguments: ['<unitId>'],
  configure: (command) =>
    command.option('--reason <text>', 'why the unit is being ended (required)'),
  action: runAbort,
};
