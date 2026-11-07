/**
 * `@factory/qualifier` — the deterministic gate that decides what may run dark.
 *
 * One entry point (`qualify`), one policy (`DEFAULT_POLICY`), one identity for the
 * rule set (`currentPolicyVersion`). Callers that want to explain a decision read
 * the signals; callers that want to change one edit the policy, which changes the
 * version, which forces a re-score.
 *
 * Purity is part of the public contract, not an implementation note: this package
 * performs no I/O, reads no clock, draws no random number, opens no socket and
 * consults no model (`findings.md > TD9`). The only import it is allowed is
 * `@factory/contracts`, and `purity.test.ts` reads these files to prove it.
 */
export {
  DEFAULT_POLICY,
  LEGACY_LIMIT_BOUND,
  assertPolicy,
  currentPolicyVersion,
  legacyPolicyVersions,
  type QualifierPolicy,
  type SignalWeights,
} from './policy.ts';

export {
  STOPWORDS,
  evaluateBudget,
  evaluateIntentDerivability,
  evaluateObservability,
  evaluateReversibility,
  evaluateSignals,
  evaluateSize,
  evaluateTaskClassHistory,
  isProseOnly,
  isUnboundedTouchPath,
  overlapCoefficient,
  restateOverlap,
  significantTokens,
  type SignalInputs,
  type TaskClassHistory,
} from './signals.ts';

export {
  classifySecurityRelevance,
  securityRelevanceLine,
  type SecurityRelevance,
} from './security.ts';

export { deriveLane, qualify, scoreSignals, type QualifyInput } from './qualify.ts';

export type { Lane, LaneDecisionType, Signal, SignalName } from '@factory/contracts';
