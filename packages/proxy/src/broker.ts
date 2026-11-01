/**
 * The broker: one claim, kept.
 *
 * > A privileged operation is either brokered under a recorded human decision or refused —
 * > never silently performed.
 *
 * Everything else in this package (`classify.ts`, `decision.ts`) exists to make that
 * sentence checkable. The broker is deliberately small and *synchronous*: it classifies,
 * it checks the record, it returns an outcome. It does not spawn anything, retry anything,
 * or hold state across calls. The caller executes the returned operation and owns the
 * process — which keeps the broker auditable by reading one function.
 *
 * ## The four refusals
 *
 * | condition                              | code                | exit |
 * |----------------------------------------|---------------------|------|
 * | the operation cannot be classified     | `GATE_REQUIRED`     | 5    |
 * | privileged, and there is no decision   | `GATE_REQUIRED`     | 5    |
 * | the decision is for a different argv   | `MANDATE_EXPIRED`   | 3    |
 * | the decision has expired               | `MANDATE_EXPIRED`   | 3    |
 * | the decision was already used          | `GATE_REQUIRED`     | 5    |
 *
 * Two of those are exit 5 because a *person* has to decide (there is no decision, or the
 * one presented is not the operator's), and one because the authority they gave has run
 * out (expiry, or a different command). `GATE_REQUIRED` for the replay case is the same
 * judgement: one decision buys one operation, and a second use needs a second person.
 *
 * ## Ambiguity is a refusal, not a warning
 *
 * When the classifier cannot tell what will run (`$X rm`, `$(which sudo) ls`, an unknown
 * binary naming `/etc/hosts`), the broker does **not** guess in either direction. It
 * refuses with exit 5 and names the reason. That is L3 applied to a classifier: an
 * operation nobody can prove safe is one a person must look at.
 */
import type { ErrorCode } from '../../contracts/src/index.ts';

import { classify, operationSha, type Classification } from './classify.ts';
import { decisionFault, toEvent, type PrivilegedDecision } from './decision.ts';

/** Where the decision's record goes. The store owns the write; the proxy only asks. */
export interface DecisionSink {
  /** Append the `privileged.decided` ledger event. */
  readonly append: (event: ReturnType<typeof toEvent>) => void;
}

/** One decision, one operation. A second use of the same id is a replay. */
export interface DecisionRegistry {
  readonly isConsumed: (decisionId: string) => boolean;
  readonly consume: (decisionId: string, at: string) => void;
}

/** An in-memory registry: the test double, and the documented default for a single call. */
export function createMemoryRegistry(): DecisionRegistry {
  const consumed = new Set<string>();
  return {
    isConsumed: (decisionId) => consumed.has(decisionId),
    consume: (decisionId) => consumed.add(decisionId),
  };
}

export interface BrokerOptions {
  /** Injected clock: the broker has no access to the system time. */
  readonly nowIso: string;
  /** Home directory, for `~`/`$HOME` normalisation. `null` when unknown. */
  readonly home: string | null;
  /** The phrase the operator supplied on this invocation's envelope, or `null`. */
  readonly operatorPhrase: string | null;
  /** The decision presented for this operation, or `null`. */
  readonly decision: PrivilegedDecision | null;
  readonly sink: DecisionSink | null;
  readonly registry: DecisionRegistry;
}

export interface BrokerAllow {
  readonly kind: 'allow';
  readonly classification: Classification;
  /** `null` when the operation was never privileged, so nothing was brokered. */
  readonly decision: PrivilegedDecision | null;
  /** The normalised segments to execute — what was classified is what runs. */
  readonly operation: readonly (readonly string[])[];
  /** One sentence: what the broker concluded and why it was allowed. */
  readonly detail: string;
}

export interface BrokerRefusal {
  readonly kind: 'refuse';
  readonly code: ErrorCode;
  readonly exitCode: number;
  readonly detail: string;
  /** Stable rule id, quoted by the audit: `broker.no-decision`, `broker.expired`, … */
  readonly matchedRule: string;
  readonly classification: Classification;
}

export type BrokerOutcome = BrokerAllow | BrokerRefusal;

function refuse(
  classification: Classification,
  code: ErrorCode,
  exitCode: number,
  matchedRule: string,
  detail: string,
): BrokerRefusal {
  return { kind: 'refuse', code, exitCode, detail, matchedRule, classification };
}

/**
 * Broker one operation.
 *
 * The order is load-bearing: classify (what is this?), then ambiguity (can anyone prove
 * it?), then authorisation (was it decided?), then the record's own validity (is this
 * decision about this command, still live, and the operator's?), then replay (is it
 * still unused?). A decision is consumed only when the operation is allowed, so a refused
 * operation does not burn the operator's approval.
 */
export function broker(argv: readonly string[], options: BrokerOptions): BrokerOutcome {
  const classification = classify(argv, { home: options.home });

  if (classification.ambiguous) {
    return refuse(
      classification,
      'GATE_REQUIRED',
      5,
      classification.ruleId ?? 'broker.ambiguous',
      `${classification.detail}. Refusing rather than guessing: an operation the broker cannot classify is ` +
        'one a person must look at (L3).',
    );
  }

  if (!classification.privileged) {
    return {
      kind: 'allow',
      classification,
      decision: null,
      operation: classification.segments.map((segment) => segment.words),
      detail: classification.detail,
    };
  }

  const operation = classification.segments.map((segment) => segment.words);
  const sha = operationSha(classification);
  const presented = options.decision;

  if (presented === null) {
    return refuse(
      classification,
      'GATE_REQUIRED',
      5,
      'broker.no-decision',
      `${classification.detail}. A privileged operation needs a recorded human decision (GateDecision) for ` +
        `exactly this command; none was presented. Operation hash: ${sha}.`,
    );
  }

  const fault = decisionFault(presented, sha, options.nowIso, options.operatorPhrase);
  if (fault !== null) {
    return refuse(classification, fault.code, fault.exitCode, fault.matchedRule, fault.detail);
  }

  if (options.registry.isConsumed(presented.decisionId)) {
    return refuse(
      classification,
      'GATE_REQUIRED',
      5,
      'broker.replayed',
      `decision ${presented.decisionId} has already been used for one operation; a decision is not a ` +
        'session. A second privileged operation needs a second decision.',
    );
  }

  // Consumed only on the allow path, so a refusal does not silently spend the approval.
  options.registry.consume(presented.decisionId, options.nowIso);
  options.sink?.append(toEvent(presented));

  return {
    kind: 'allow',
    classification,
    decision: presented,
    operation,
    detail: `brokered under decision ${presented.decisionId} by ${presented.operator}: ${classification.detail}`,
  };
}

/** The one-line rendering of a refusal, shared by the CLI and the tests. */
export function describeRefusal(refusal: BrokerRefusal): string {
  return `${refusal.code}: ${refusal.detail} [${refusal.matchedRule}]`;
}
