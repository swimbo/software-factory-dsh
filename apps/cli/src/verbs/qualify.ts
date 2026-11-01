/**
 * `factory qualify` — why a unit is `lit` rather than `dark`, in one command.
 *
 * This is the single highest-value read after a verdict (`ux-plan.md` §3.2), and
 * the rule that makes it useful is: **no score is ever shown without its
 * reasons**. A bare `0.41` invites the operator to treat lane routing as a dial
 * and to ask for a threshold change; the lane is deterministic policy (L2), so
 * the block leads with the blocking signals and the score comes last.
 *
 * Exit: `dark` → 0, `lit` → 0 (a decision was made and stored; the cost is
 * printed, not raised), `reject` → 3, because a rejected spec is a spec that
 * must be rewritten (§5.3).
 */
import { FactoryError } from '@factory/contracts';
import { classifySecurityRelevance, securityRelevanceLine } from '@factory/qualifier';

import { UsageError } from '../exit.ts';
import { field, indent, mark, shortHash, wrap } from '../render/format.ts';
import type { VerbInput, VerbSpec } from './types.ts';

export function runQualify(input: VerbInput): number {
  const { ctx } = input;
  const unitId = input.args[0];
  if (unitId === undefined || unitId.trim().length === 0) {
    throw new UsageError('USAGE: factory qualify <unitId>');
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

  // Reading before the command is what lets the block say "stored decision, not
  // re-scored": the engine reuses a stored decision for the same policy version.
  const wasStored = ctx.store.getLaneDecision(unitId, ctx.policyVersion) !== null;

  // A unit past `submitted` already carries a decision it is acting on. The engine
  // says this with an INTERNAL (exit 1) phase error, which is a bug-report tone for
  // a plainly reachable operator mistake (`qualify` after `run`, or a replayed
  // command), and `--json` must still answer with a refusal an operator can act on.
  if (unit.state !== 'submitted' && unit.state !== 'qualified' && unit.state !== 'lit_parked') {
    throw new FactoryError(
      'UNIT_ALREADY_TERMINAL',
      `UNIT_ALREADY_TERMINAL: ${unitId} is ${unit.state}; a lane decision is made once, against a submitted ` +
        'revision. Re-qualifying would revise a decision this unit is already acting on. ' +
        `Submit a new revision instead. Nothing was changed.`,
      { unitId, state: unit.state },
    );
  }

  const result = ctx.engine.qualifyUnit(unitId);
  const decision = result.decision;
  // The qualifier owns the rule set; the CLI only renders its answer, so the two
  // can never describe the same unit differently.
  const security = classifySecurityRelevance({
    touchPaths: unit.spec.touchPaths,
    operationClasses: unit.spec.operationClasses,
  });
  const blocking = decision.signals.filter((signal) => signal.outcome !== 'pass');
  const passing = decision.signals.filter((signal) => signal.outcome === 'pass');

  input.emit({
    unitId: result.unit.unitId,
    lane: decision.lane,
    score: decision.score,
    policyVersion: decision.policyVersion,
    decisionId: result.decisionId,
    decidedAt: decision.decidedAt,
    stored: wasStored,
    signals: decision.signals.map((signal) => ({
      name: signal.name,
      outcome: signal.outcome,
      reason: signal.reason,
      observed: signal.observed,
      weight: signal.weight,
    })),
    security: { relevant: security.relevant, reasons: security.reasons },
    coldStart: ctx.allowColdStart,
    next: decision.lane === 'dark' ? `factory run ${result.unit.unitId}` : null,
    traceId: ctx.traceId,
  });

  const lines: string[] = [
    `LANE   ${decision.lane.padEnd(8)} score ${decision.score.toFixed(2).padStart(5)}`,
    // The full version on its own line: a sha256 identity plus a label does not
    // fit in 80 columns, and the rule is wrap, never truncate.
    ...wrap(`policy ${decision.policyVersion}`, 2),
  ];
  if (wasStored)
    lines.push(
      ...indent(
        wrap(`stored decision under policy ${decision.policyVersion} - not re-scored`, 0),
        2,
      ),
    );
  const coldStartDecision = decision.signals.some(
    (signal) => signal.reason === 'TASK_CLASS_COLD_START',
  );
  lines.push(
    ...wrap(
      decision.lane === 'dark'
        ? coldStartDecision
          ? 'WHY dark — five signals measured and passing; task-class history passed by policy (cold start)'
          : 'WHY dark — six signals measured, all passing'
        : `WHY NOT dark — ${blocking.length} blocking reason(s), ${passing.length} signal(s) passing`,
      0,
    ),
    '',
  );
  for (const signal of decision.signals) {
    const ok = signal.outcome === 'pass';
    lines.push(
      `  ${mark(ok, ctx.ui.plain)} ${signal.name.toUpperCase().padEnd(18)} ${String(signal.observed ?? '')}`,
    );
    lines.push(`    ${' '.repeat(18)}-> ${signal.reason} (${signal.outcome})`);
  }
  lines.push('', field('SECURITY', securityRelevanceLine(security)));
  if (ctx.allowColdStart) {
    // Labelled as a policy decision, not a measurement: this is the line that
    // keeps a cold-start routing from ever reading like a measured one.
    lines.push(
      field(
        'COLD START',
        `on (policy ${ctx.policyVersion}) - task_class_history reported pass by policy, not measured`,
      ),
    );
  }

  if (decision.lane === 'dark') {
    lines.push('', `Next: factory run ${result.unit.unitId}`);
  } else if (decision.lane === 'lit') {
    lines.push(
      '',
      ...wrap(
        'WHAT THIS COSTS YOU: this unit is not dispatched. The factory has no verb that runs a lit unit - ' +
          'that refusal is the design (throughput is capped by the wall, not by the agent).',
        0,
      ),
      '',
      'Take the unit yourself, then:',
      `    factory abort ${result.unit.unitId} --reason "handled manually"`,
      '',
      ...(blocking.length === 1 && blocking[0]?.reason === 'TASK_CLASS_UNKNOWN'
        ? [
            'OR route it on policy for this invocation, if you are willing to own that call:',
            `    factory qualify ${result.unit.unitId} --cold-start`,
            '  That reports task_class_history as a policy pass, changes the policy version, and is',
            '  printed on every decision it produced. It is not a measurement.',
            '',
          ]
        : []),
      'TO MAKE IT DARK (your call, your edit - the CLI will not do it for you):',
      '  1. remove the blocking reason(s) printed above from the spec',
      '  2. re-submit as a new revision: factory intent --file <spec.json>',
      '  3. then: factory qualify <new unitId>',
    );
  } else {
    lines.push(
      '',
      'REJECTED before dispatch — the spec is not machine-derivable. This is not an error to retry:',
      'rewrite the spec (the blocking reason above names what is missing), bump spec.revision, resubmit.',
    );
  }
  for (const line of lines) ctx.ui.err(line);
  return decision.lane === 'reject' ? 3 : 0;
}

export const qualifyVerb: VerbSpec = {
  name: 'qualify',
  verb: 'qualify',
  summary: 'Score a unit and print why it was routed dark, lit or reject',
  arguments: ['<unitId>'],
  configure: (command) =>
    command
      .option('--force-rescore', 're-score even when a decision is already stored')
      .option(
        '--cold-start',
        'route on policy, not measurement: an absent task-class history counts as passing (changes the policy version)',
      ),
  action: runQualify,
};
