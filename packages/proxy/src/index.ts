/**
 * `@factory/proxy` — the credential and topology broker (R5).
 *
 * The claim this package exists to make true:
 *
 * > a privileged operation is either brokered under a recorded human decision or refused,
 * > never silently performed.
 *
 * It was declared and not implemented: there was no `packages/proxy`, no post-expansion
 * classifier (only a post-hoc denylist in `packages/wall/src/evaluate.ts`, whose own
 * comment calls it partial), no `privileged` operation class and no decision record.
 *
 * What is here:
 *
 * - `classify.ts` — the post-expansion classifier: shell strings, `env`/`xargs`/`nice`/
 *   `timeout`/`command` unwrapping, path-qualified binaries, `~`/`$HOME` normalisation,
 *   and fail-closed ambiguity for dynamic command positions.
 * - `operations.ts` — the brokered-operation table (normalised argv shapes) and the
 *   privileged path prefixes.
 * - `decision.ts` — the `PrivilegedDecision` record: one operation, an expiry against an
 *   injected clock, a phrase from the operator's envelope, a content-derived id, and both
 *   persistable forms (ledger event + `FACTORY_HOME/gates/` artifact).
 * - `broker.ts` — the three gates and the typed refusal.
 *
 * What is deliberately *not* here: containment (the sandbox owns that), network egress,
 * and any rule that duplicates the wall's destructive-verb check. See `operations.ts` for
 * the omissions list and `docs/planning/dark-factory-dsh/phase-13-audit.md` for status.
 */
export {
  classify,
  operationSha,
  tokeniseShell,
  type Classification,
  type ClassifiedSegment,
} from './classify.ts';
export {
  BROKERED_CLASSES,
  CLASS_TO_OPERATION_CLASS,
  isPrivilegedPath,
  OPERATION_RULES,
  PATH_WRITER_BINARIES,
  PRIVILEGED_PATH_PREFIXES,
  ruleFor,
  type BrokeredClass,
  type OperationRule,
} from './operations.ts';
export {
  buildDecision,
  decisionIdOf,
  decisionPayload,
  signatureFault,
  decisionFault,
  gatePhraseOf,
  liveDecisionFor,
  DecisionError,
  parseDecision,
  toArtifact,
  toEvent,
  type DecisionContent,
  type DecisionFault,
  type DecisionInput,
  type PrivilegedDecision,
} from './decision.ts';
export {
  broker,
  createMemoryRegistry,
  describeRefusal,
  type BrokerAllow,
  type BrokerOptions,
  type BrokerOutcome,
  type BrokerRefusal,
  type DecisionRegistry,
  type DecisionSink,
} from './broker.ts';
