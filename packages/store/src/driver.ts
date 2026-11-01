/**
 * The SQLite driver.
 *
 * One interface, one implementation. `node:sqlite` is the default because it is
 * built in (no native build step, no supply-chain surface for a database
 * binding); `better-sqlite3` is a one-file swap if the experimental API churns,
 * which is why nothing outside this file imports `node:sqlite`.
 */
// `Database` is the runtime name on Node ≥25; `@types/node` 26 still declares the
// pre-rename `DatabaseSync`. They are the same class, so import the typed name.
import { DatabaseSync as Database } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { REQUIRED_PRAGMAS } from './schema.ts';

export type Row = Record<string, unknown>;

export interface SqliteStatement {
  run(...params: unknown[]): { changes: number | bigint; lastInsertRowid: number | bigint };
  get<T = Row>(...params: unknown[]): T | undefined;
  all<T = Row>(...params: unknown[]): T[];
}

export interface SqliteDriver {
  exec(sql: string): void;
  prepare(sql: string): SqliteStatement;
  /** BEGIN IMMEDIATE … COMMIT, rolling back on throw. Nested calls are a bug, not a feature. */
  transaction<T>(fn: () => T): T;
  close(): void;
  readonly pragmas: Readonly<Record<string, string>>;
}

export interface OpenOptions {
  readonly path: string;
  /** `true` only in tests that need a fresh store per case. */
  readonly readonly?: boolean;
}

export function openSqlite(options: OpenOptions): SqliteDriver {
  if (options.path !== ':memory:') {
    mkdirSync(dirname(options.path), { recursive: true });
  }
  const db = new Database(options.path, { readOnly: options.readonly ?? false });

  const applied: Record<string, string> = {};
  for (const [name, value] of REQUIRED_PRAGMAS) {
    // journal_mode is a query-style pragma: its result is the effective mode, and
    // asserting it is what catches "someone opened the file with a different mode".
    const stmt = db.prepare(`PRAGMA ${name} = ${value}`);
    const row = stmt.get() as Record<string, unknown> | undefined;
    const effective = row ? String(Object.values(row)[0]) : value;
    applied[name] = effective;
    if (name === 'journal_mode' && effective.toLowerCase() !== value.toLowerCase()) {
      throw new Error(
        `store: could not enable WAL (got ${effective}); refusing to run with degraded durability`,
      );
    }
  }
  // Verify the durability pragma actually stuck — this is the one setting whose
  // silent failure loses committed events.
  const sync = db.prepare('PRAGMA synchronous').get() as { synchronous?: number } | undefined;
  if (sync?.synchronous !== 2) {
    throw new Error(`store: synchronous is ${String(sync?.synchronous)} (expected 2 = FULL)`);
  }
  applied['synchronous'] = 'FULL';

  let depth = 0;
  return {
    exec: (sql) => {
      db.exec(sql);
    },
    prepare: (sql) => db.prepare(sql) as unknown as SqliteStatement,
    transaction<T>(fn: () => T): T {
      if (depth > 0) throw new Error('store: nested transaction is not supported');
      depth += 1;
      db.exec('BEGIN IMMEDIATE');
      try {
        const result = fn();
        db.exec('COMMIT');
        return result;
      } catch (error) {
        try {
          db.exec('ROLLBACK');
        } catch {
          // A rollback that fails means the connection is gone; the original
          // error is the one worth surfacing.
        }
        throw error;
      } finally {
        depth -= 1;
      }
    },
    close: () => {
      db.close();
    },
    pragmas: applied,
  };
}
