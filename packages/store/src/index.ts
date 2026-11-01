/**
 * `@factory/store` — the durable control-plane state.
 *
 * Callers import the interface and `openStore`; nothing above this package sees
 * SQLite, and nothing outside `driver.ts` imports `node:sqlite`.
 */
export { openStore } from './store.ts';
export type { OpenStoreOptions } from './store.ts';

export { SCHEMA_SQL, SCHEMA_VERSION, REQUIRED_PRAGMAS, CODE_LEVEL_INVARIANTS } from './schema.ts';
export { openSqlite } from './driver.ts';
export type { SqliteDriver, SqliteStatement } from './driver.ts';

export {
  SINGLE_UID_CLAIM,
  TOPOLOGY_KINDS,
  TOPOLOGY_MARKER_FILE,
  TOPOLOGY_MARKER_VERSION,
  TWO_UID_CLAIM,
  WALL_GROUP,
  WALL_USER,
  WORKER_GROUP,
  WORKER_USER,
  accountCommands,
  applyTopologyPlan,
  currentUid,
  decideTopology,
  TOPOLOGY_MARKER_MODE,
  markerActions,
  markerPath,
  modeDigits,
  modeSatisfied,
  modesFor,
  octal,
  parseTopologyMarker,
  probeTopology,
  provisionTopology,
  readTopologyMarker,
  statOwnership,
  topologyClaim,
  verifyTopology,
  writeTopologyMarker,
} from './topology.ts';
export type {
  ApplyResult,
  MarkerReadResult,
  OwnershipStat,
  ProvisionAction,
  ProvisionInput,
  ProvisionPlan,
  RunResult,
  TopologyAccounts,
  TopologyDecision,
  TopologyKind,
  TopologyMarker,
  TopologyMode,
  TopologyPrincipal,
  TopologyRefusal,
  TopologySnapshot,
  TopologySource,
  TopologyTarget,
  TopologyVerification,
} from './topology.ts';

export type {
  AppendOptions,
  AttemptRow,
  EffectRow,
  MandateRow,
  ReceiptRow,
  Store,
  StoreRefusal,
  UnitRow,
  UsageRow,
  VerdictRow,
} from './types.ts';
