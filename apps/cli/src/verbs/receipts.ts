/**
 * `factory receipts` — the mechanical facts, and a path.
 *
 * Never the diff (`ux-plan.md` §0): the diff is not the operator's input any
 * more, and printing it re-creates the failing review process the factory exists
 * to replace. Never the narrative either: it has zero evidentiary weight (L1) and
 * `toDecisionReceipt` strips it before anything above the adapter can see it.
 */
import { FactoryError } from '@factory/contracts';

import { field } from '../render/format.ts';
import { UsageError } from '../exit.ts';
import type { VerbInput, VerbSpec } from './types.ts';

export function runReceipts(input: VerbInput): number {
  const { ctx } = input;
  const unitId = input.args[0];
  if (unitId === undefined || unitId.trim().length === 0) {
    throw new UsageError('USAGE: factory receipts <unitId>');
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

  const attempts = ctx.store.listAttemptsForUnit(unitId);
  const latest = ctx.store.latestReceiptForUnit(unitId);
  const receipt = latest?.receipt ?? null;
  // The store exposes the latest receipt per unit, not a list, so "receipts" is
  // the latest one plus every attempt that did not produce one. Stated, not hidden.
  input.emit({
    unitId,
    receipts:
      latest === null
        ? []
        : [
            {
              receiptId: latest.receiptId,
              attemptId: latest.attemptId,
              receiptSha: latest.receiptSha,
              recordedAt: latest.recordedAt,
              exitCode: latest.exitCode,
              filesChanged: receipt?.diff.filesChanged ?? null,
              diffSha: receipt?.diff.sha ?? null,
              commands: receipt?.commands.length ?? null,
              suite: receipt?.suite === null || receipt?.suite === undefined ? null : receipt.suite,
            },
          ],
    attemptsWithoutReceipt: attempts
      .filter((attempt) => latest === null || attempt.attemptId !== latest.attemptId)
      .map((attempt) => ({ attemptId: attempt.attemptId, state: attempt.state })),
    note: 'the store exposes the latest receipt per unit; earlier receipts are addressed by sha',
    traceId: ctx.traceId,
  });

  if (latest === null || receipt === null) {
    ctx.ui.err(`RECEIPTS  ${unitId}  (none)`);
    ctx.ui.err(`  ${attempts.length} attempt(s), none of which produced a receipt`);
    if (unit.state === 'ambiguous') {
      ctx.ui.err(
        '  this is not a missing file: an ambiguous attempt produced no evidence, by definition',
      );
    }
    return unit.state === 'ambiguous' ? 4 : 0;
  }

  const exits = receipt.commands.map((command) => command.exitCode);
  ctx.ui.err(`RECEIPTS  ${unitId}`);
  ctx.ui.err(
    `  ${latest.receiptId}  ${latest.attemptId}  ${latest.receiptSha.slice(0, 15)}…  ` +
      `diff ${receipt.diff.filesChanged} file(s) +${receipt.diff.insertions}/-${receipt.diff.deletions}  ` +
      `commands ${receipt.commands.length}  exits [${exits.join(',')}]`,
  );
  // The receipt is a store row, not a file. This line used to print
  // `<home>/artifacts/<unit>/<attempt>/receipt.json`, a path nothing ever writes — verified on
  // 2026-11-07: `ls ~/.factory/artifacts` was ENOENT while the receipt row was right there in the
  // store. The attempt's *records* do live on disk (launch.json, task.md, stdout.log, the patch), so
  // both places are named and neither is invented.
  ctx.ui.err(field('  store', `${ctx.paths.state}/store.sqlite  (receipt ${latest.receiptId})`));
  ctx.ui.err(field('  records', `${ctx.paths.attempts}/${unitId}/${latest.attemptId}/`));
  ctx.ui.err(
    field(
      '  narrative',
      'withheld: it has no evidentiary weight and is not part of the decision receipt',
    ),
  );
  if (receipt.suite !== null) {
    ctx.ui.err(
      field(
        '  suite',
        `${receipt.suite.passed} passed, ${receipt.suite.failed} failed, ${receipt.suite.unknown} unknown`,
      ),
    );
  }
  ctx.ui.err(
    field(
      '  ceilings',
      receipt.ceilings.hit.length === 0 ? 'none tripped' : receipt.ceilings.hit.join(', '),
    ),
  );
  ctx.ui.err(field('  patch', receipt.diff.patchFile));
  return 0;
}

export const receiptsVerb: VerbSpec = {
  name: 'receipts',
  verb: 'receipts',
  summary: 'Print the mechanical facts of a unit receipt and its path (never the diff)',
  arguments: ['<unitId>'],
  configure: (command) =>
    command.option('--sha <sha256>', 'address an older receipt by its content hash'),
  action: runReceipts,
};
