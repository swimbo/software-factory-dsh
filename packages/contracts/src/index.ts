/**
 * `@factory/contracts` — the shapes every other package shares.
 *
 * This package has no dependencies on the rest of the factory and no I/O. It is
 * the one place where "what a unit is", "what a refusal is" and "what a verdict
 * may claim" are defined, so the CLI, the wall and the tests cannot drift apart.
 */
export { canonicalJson, contentHash, idempotencyKey, sha256Hex } from './canonical.ts';

export {
  ERROR_CODES,
  type ErrorCode,
  exitCodeFor,
  FactoryError,
  isFactoryError,
  type Tri,
  triFromBool,
  triIsPass,
  gateSatisfied,
} from './errors.ts';

export {
  OPERATION_CLASSES,
  type OperationClass,
  IRREVERSIBLE_OPERATION_CLASSES,
  ORACLE_KINDS,
  type OracleKind,
  AcceptanceCriterion,
  SizeBudget,
  UnitSpec,
  UNIT_STATES,
  type UnitState,
  TERMINAL_UNIT_STATES,
  isTerminal,
  canTransition,
  assertTransition,
  MAX_ATTEMPTS_PER_UNIT,
  ATTEMPT_STATES,
  type AttemptState,
} from './unit.ts';

export {
  COMMAND_SOURCES,
  CommandRecord,
  type CommandSource,
  type CommandRecord as CommandRecordType,
  SuiteResult,
  Ceilings,
  DiffRecord,
  ArtifactRecord,
  WorkerReceipt,
  type WorkerReceipt as WorkerReceiptType,
  type DecisionReceipt,
  toDecisionReceipt,
  receiptShaFor,
  Faithfulness,
} from './receipt.ts';

export {
  WALL_REASON_CODES,
  type WallReasonCode,
  ScenarioResult,
  Delta,
  Verdict,
  type Verdict as VerdictType,
  assertVerdictIsEarned,
  WALL_VERSION,
} from './verdict.ts';

export {
  LANES,
  type Lane,
  SIGNAL_NAMES,
  type SignalName,
  QUALIFIER_REASON_CODES,
  type QualifierReasonCode,
  Signal,
  LaneDecision,
  type LaneDecision as LaneDecisionType,
  assertLaneIsDerived,
} from './lane.ts';

export { EventPayload, type EventType, LedgerEvent, aggregateOf } from './events.ts';

export {
  HEALTH_STATES,
  type HealthState,
  MEASUREMENT_KINDS,
  FACTORY_STATUS_KINDS,
  WaitingOnPerson,
  UNIT_STATUS_STATES,
  type UnitStatusState,
  AttemptStatus,
  VerdictStatus,
  UnitStatus,
  HealthStatus,
  BudgetStatus,
  StatusV1,
  type StatusV1 as StatusV1Type,
  parseStatus,
} from './status.ts';
