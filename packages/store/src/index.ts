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

export type {
  AppendOptions,
  AttemptRow,
  EffectRow,
  MandateRow,
  ReceiptRow,
  Store,
  StoreRefusal,
  UnitRow,
  VerdictRow,
} from './types.ts';
