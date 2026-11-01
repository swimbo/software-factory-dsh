/**
 * Two audiences, two sentences.
 *
 * The operator needs enough to act: which coarse check failed, how many scenarios
 * failed, and what Δ did. The agent needs almost nothing — a single coarse refusal
 * with no indication of which check it failed. That asymmetry is not politeness,
 * it is the control: a worker that learns "the holdout rejected slot 3" can spend
 * the next attempt fitting slot 3, and a worker that learns "your Δ regressed"
 * learns the shape of the gate. So the operator line carries counts and reason
 * codes, and the worker line carries a verdict word and nothing else.
 *
 * Neither line may contain a scenario id, a scenario's argv, an expected value, an
 * acceptance criterion's text, or a changed path. `reasons.test.ts` and the
 * opacity test in `evaluate.test.ts` both hold these functions to that rule.
 */
import type { Verdict } from '@factory/contracts';

/** The only thing the agent is told about a refusal. Deliberately identical for fail and unknown. */
export const WORKER_FACING_REFUSAL = 'not accepted';

/** The only thing the agent is told about an approval. */
export const WORKER_FACING_ACCEPTANCE = 'accepted';

/**
 * Coarse, constant, and identical for every kind of refusal.
 *
 * `unknown` deliberately maps to the same string as `fail`: an agent must not be
 * able to distinguish "the wall measured you and you failed" from "the wall could
 * not measure", because that difference is an oracle it can steer towards.
 */
export function workerFacingReason(verdict: Verdict): string {
  return verdict.outcome === 'pass' ? WORKER_FACING_ACCEPTANCE : WORKER_FACING_REFUSAL;
}

const OUTCOME_LABEL: Record<Verdict['outcome'], string> = {
  pass: 'ACCEPTED',
  fail: 'REJECTED',
  unknown: 'UNVERIFIED',
};

function fixed(value: number): string {
  return value.toFixed(2);
}

/**
 * The operator's single line: `REJECTED: holdout_failed, delta_regression — 2 of 7
 * scenarios failed; Δ -0.14 < 0.00`.
 *
 * Assembled from counts and the verdict's own arithmetic. No identifiers, no paths
 * and no expectations appear here even though this line is operator-facing: the
 * verdict is a durable artefact, and a line that leaks scenario text leaks it to
 * every future attempt that can read the log.
 *
 * One exception in structure, not in content: when the holdout's own *quality* check
 * is unmeasured or refused, that check's `observed` sentence is promoted to the first
 * part. The operator has to be able to see the instrument — a line that says only
 * "1 of 5 checks unmeasured" makes the reader guess which control fired and with what
 * threshold.
 */
export function oneLineReason(verdict: Verdict): string {
  const label = OUTCOME_LABEL[verdict.outcome];
  const codes = verdict.reasons.length > 0 ? `: ${verdict.reasons.join(', ')}` : '';

  const holdoutScenarios = verdict.scenarios.filter((scenario) => scenario.source === 'holdout');
  const failedHoldout = holdoutScenarios.filter((scenario) => scenario.outcome === 'fail').length;
  const unknownChecks = verdict.scenarios.filter(
    (scenario) => scenario.outcome === 'unknown',
  ).length;
  const total = verdict.scenarios.length;

  const parts: string[] = [];

  // When the instrument itself is the reason, the operator gets the instrument's own
  // sentence first: "3 of 7 holdout scenarios pass on every base revision — the
  // holdout cannot distinguish this change from the base (threshold 2)". Counts and
  // the threshold only — a scenario id here would be one copy-paste from an id in a
  // log the next attempt can read.
  //
  // Promoted for the same reason in the other two places: an empty diff (the receipt
  // may not have recorded the working-tree status, and "I could not rule out untracked
  // work" is different from "there was nothing"), and the class-certification sentence.
  // `test-surface` and `scope` are promoted for the same reason (A5/A6): the operator has
  // to know which surface moved, and a changed path is something the agent wrote, so it
  // reveals nothing it does not already know. Scenario ids and holdout argv stay out.
  const promotedIds = ['holdout:quality', 'diff', 'test-surface', 'scope'];
  const promoted = verdict.scenarios.find(
    (scenario) => promotedIds.includes(scenario.id) && scenario.outcome !== 'pass',
  );
  if (promoted !== undefined && promoted.observed !== null) parts.push(promoted.observed);

  if (failedHoldout > 0) {
    parts.push(`${failedHoldout} of ${holdoutScenarios.length} scenarios failed`);
  }
  if (unknownChecks > 0) {
    parts.push(`${unknownChecks} of ${total} checks unmeasured`);
  }
  if (failedHoldout === 0 && unknownChecks === 0 && total > 0) {
    parts.push(`all ${total} checks passed`);
  }

  const delta = verdict.delta;
  if (delta.checked && delta.observed !== null) {
    const met = delta.observed >= delta.threshold;
    parts.push(`Δ ${fixed(delta.observed)} ${met ? '≥' : '<'} ${fixed(delta.threshold)}`);
  } else {
    parts.push('Δ unmeasured');
  }

  // A verifying verdict that cannot promote itself still has to say so, and say why: the
  // operator is the one who will be asked to sign.
  if (verdict.promotionRequiresHumanSignature === true) {
    const certification = verdict.scenarios.find(
      (scenario) => scenario.id === 'class-certification',
    );
    parts.push(
      certification?.observed === null || certification?.observed === undefined
        ? 'this task class is not certifiable — promotion requires a human signature'
        : `${certification.observed}`,
    );
  }

  if (parts.length === 0) parts.push('no checks recorded');

  return `${label}${codes} — ${parts.join('; ')}`;
}
