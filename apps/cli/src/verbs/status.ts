/**
 * `factory status` — the surface that answers "what needs me" and nothing else.
 *
 * Silence is the default (§4.1): one aggregate line while healthy, and every
 * further line exists because it needs a person. Two invariants are enforced
 * here rather than left to the renderer:
 *
 * - `unknown` counts as needing a person (A-1). A unit whose verdict was never
 *   measured, or whose attempt is ambiguous, appears under NEEDS YOU and the
 *   command exits 5. It is never folded into an ok line.
 * - estimated spend is rendered with `~` and the word `estimated` (A-2), because
 *   a bare number would claim a measurement the factory does not have.
 */
import { FactoryError } from '@factory/contracts';

import { renderStatus, statusExitCode, buildStatus } from '../render/status.ts';
import { boolOption, type VerbInput, type VerbSpec } from './types.ts';

export function runStatus(input: VerbInput): number {
  const { ctx } = input;
  const unitId = input.args[0];
  const model =
    unitId === undefined || unitId.trim().length === 0
      ? buildStatus(ctx)
      : buildStatus(ctx, { unitId: unitId.trim() });

  if (unitId !== undefined && unitId.trim().length > 0 && model.units.length === 0) {
    throw new FactoryError(
      'UNIT_NOT_FOUND',
      `UNIT_NOT_FOUND: no unit ${unitId}. See: factory status --all`,
      {
        unitId,
      },
    );
  }

  // The wire payload is the frozen contract; `limitIsDefault` is a render-only hint
  // (the status contract has no field for "this number is a documented default"), so it
  // is stripped here rather than added to a schema another owner holds.
  const { limitIsDefault: _renderOnly, ...perDayWire } = model.budget.perDay;
  input.emit({
    ...model,
    budget: { ...model.budget, perDay: perDayWire },
  });
  const rendered = renderStatus(model, ctx.ui.plain);
  const wantsAll = boolOption(input.options, 'all');
  // Human text goes to stderr; only `--json` and documented data payloads touch
  // stdout (`ux-plan.md` §6): a script that captured stdout must never find a
  // sentence in it.
  for (const line of rendered.trimEnd().split('\n')) ctx.ui.err(line);
  if (wantsAll && model.units.length > 0) {
    ctx.ui.err('');
    ctx.ui.err('UNITS');
    for (const unit of model.units) {
      ctx.ui.err(`  ${unit.unitId}  ${unit.lane ?? 'pending'}  ${unit.state}  ${unit.title}`);
    }
  }
  return statusExitCode(model);
}

export const statusVerb: VerbSpec = {
  name: 'status',
  verb: 'status',
  summary: 'Show what needs a person; one line while healthy',
  arguments: ['[unitId]'],
  configure: (command) =>
    command
      .option('--all', 'list every unit, not just the ones with work in flight')
      .option('--attempt <attemptId>', 'scope the report to one attempt'),
  action: runStatus,
};
