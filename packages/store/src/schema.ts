/**
 * The schema, and the constraints that make dishonest states unrepresentable.
 *
 * These are not documentation — they are enforced by SQLite itself, so a bug in
 * a later phase cannot write a "passed" verdict without a receipt, cannot edit
 * the ledger, and cannot hold two leases on one unit. Appendix D of
 * `data-map.md` lists the invariants; the comments here name the ones that are
 * enforced at this layer rather than in code.
 */

export const SCHEMA_VERSION = 3;

/**
 * Declared migrations. A store one version behind is opened only when a migration here says how to
 * get from its version to this one — never by guessing, and never by rewriting a ledger.
 *
 * v1 → v2 is **additive**: ND3 added `usage_records` (and its two indexes) so spend could be recorded
 * as the gateway reported it. Nothing existing changed, which is why the migration is exactly the new
 * table's DDL. It is written out here rather than "just run SCHEMA_SQL", because a migration that runs
 * the current schema is a migration whose effect depends on what the current schema happens to be
 * today — the next person to add a table would silently change this one.
 *
 * A destructive change (dropping or reshaping a column) must never appear here: an operator's ledger
 * is evidence, and there is no `--force` in this CLI.
 */
export interface Migration {
  readonly from: number;
  readonly to: number;
  readonly note: string;
  readonly statements: readonly string[];
}

const USAGE_RECORDS_DDL = `CREATE TABLE IF NOT EXISTS usage_records (
  usage_id            TEXT PRIMARY KEY,
  unit_id             TEXT NOT NULL REFERENCES units(unit_id),
  attempt_id          TEXT NOT NULL REFERENCES attempts(attempt_id),
  tokens_in           INTEGER NOT NULL CHECK (tokens_in >= 0),
  tokens_out          INTEGER NOT NULL CHECK (tokens_out >= 0),
  cost_usd            REAL CHECK (cost_usd IS NULL OR cost_usd >= 0),
  gateway_request_id  TEXT,
  signed_at           TEXT NOT NULL,
  record_sha          TEXT NOT NULL,
  ceiling_crossed     INTEGER NOT NULL DEFAULT 0 CHECK (ceiling_crossed IN (0, 1))
);
CREATE INDEX IF NOT EXISTS usage_attempt ON usage_records(attempt_id);
CREATE INDEX IF NOT EXISTS usage_unit ON usage_records(unit_id);`;

/**
 * v2 → v3 (ND1 half two): `class_certificates`, the append-only projection of the wall's class
 * judgement. Additive: nothing existing changed, and the DDL is written out here rather than
 * re-running `SCHEMA_SQL` for the reason the header gives — a migration that executes "the current
 * schema" silently changes whenever someone adds a table.
 *
 * One row per verdict that carries a certificate. The primary key is derived from the verdict id, so
 * "one certificate per verdict" is a schema fact rather than a promise the insert path keeps.
 */
const CLASS_CERTIFICATES_DDL = `CREATE TABLE IF NOT EXISTS class_certificates (
  certificate_id      TEXT PRIMARY KEY,
  verdict_id          TEXT NOT NULL REFERENCES verdicts(verdict_id),
  unit_id             TEXT NOT NULL REFERENCES units(unit_id),
  task_class          TEXT NOT NULL,
  m                   INTEGER NOT NULL CHECK (m > 0),
  k                   INTEGER NOT NULL CHECK (k > 0 AND k <= m),
  p0                  REAL NOT NULL CHECK (p0 >= 0 AND p0 <= 1),
  alpha               REAL NOT NULL CHECK (alpha >= 0 AND alpha <= 1),
  samples             INTEGER NOT NULL CHECK (samples >= 0),
  passes              INTEGER NOT NULL CHECK (passes >= 0 AND passes <= samples),
  outcome             TEXT NOT NULL CHECK (outcome IN ('certified','not-certified','insufficient')),
  policy_version      TEXT NOT NULL,
  model_id            TEXT,
  recorded_at         TEXT NOT NULL,
  certificate_sha     TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS certificates_class ON class_certificates(task_class, recorded_at);
CREATE INDEX IF NOT EXISTS certificates_verdict ON class_certificates(verdict_id);`;

export const MIGRATIONS: readonly Migration[] = [
  {
    from: 1,
    to: 2,
    note: 'ND3: append-only usage_records, so spend is recorded as the gateway reported it',
    statements: [USAGE_RECORDS_DDL],
  },
  {
    from: 2,
    to: 3,
    note: 'ND1 half two: append-only class_certificates, so a class judgement can be re-checked',
    statements: [CLASS_CERTIFICATES_DDL],
  },
];

/** A one-way path from `from` to `SCHEMA_VERSION`, or `null` when there is none. */
export function migrationPath(from: number): readonly Migration[] | null {
  if (from >= SCHEMA_VERSION) return from === SCHEMA_VERSION ? [] : null;
  const path: Migration[] = [];
  let version = from;
  for (;;) {
    const step = MIGRATIONS.find((candidate) => candidate.from === version);
    if (step === undefined) return null;
    path.push(step);
    version = step.to;
    if (version === SCHEMA_VERSION) return path;
    if (version > SCHEMA_VERSION) return null;
  }
}

/** Pragmas that are mandatory, not advisory (`tech-guide.md` §10). */
export const REQUIRED_PRAGMAS: ReadonlyArray<readonly [string, string]> = [
  // WAL: concurrent readers (status page) alongside the control plane.
  ['journal_mode', 'WAL'],
  // FULL: NORMAL gives up commit durability on power loss; the ledger is the product.
  ['synchronous', 'FULL'],
  // Default busy timeout is 0 → instant SQLITE_BUSY under any contention.
  ['busy_timeout', '5000'],
  ['foreign_keys', 'ON'],
  // Keep the temp store off disk-backed page cache surprises and bound WAL growth.
  ['wal_autocheckpoint', '1000'],
];

export const SCHEMA_SQL = /* sql */ `
-- ---------------------------------------------------------------- migrations
CREATE TABLE IF NOT EXISTS schema_migration (
  version     INTEGER PRIMARY KEY,
  applied_at  TEXT NOT NULL,
  checksum    TEXT NOT NULL
);

-- --------------------------------------------------------------------- ledger
-- I1: append-only. The triggers below make UPDATE/DELETE fail even for the
-- process that owns the database, so "we did not modify history" is a fact.
CREATE TABLE IF NOT EXISTS events (
  seq          INTEGER PRIMARY KEY AUTOINCREMENT,
  event_id     TEXT NOT NULL UNIQUE,
  type         TEXT NOT NULL,
  occurred_at  TEXT NOT NULL,
  actor        TEXT NOT NULL,
  trace_id     TEXT NOT NULL,
  payload      TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS events_type_seq ON events(type, seq);
CREATE INDEX IF NOT EXISTS events_trace ON events(trace_id);
CREATE TRIGGER IF NOT EXISTS events_no_update BEFORE UPDATE ON events
BEGIN SELECT RAISE(ABORT, 'events is append-only'); END;
CREATE TRIGGER IF NOT EXISTS events_no_delete BEFORE DELETE ON events
BEGIN SELECT RAISE(ABORT, 'events is append-only'); END;

-- ---------------------------------------------------------------------- units
CREATE TABLE IF NOT EXISTS units (
  unit_id             TEXT PRIMARY KEY,
  slug                TEXT NOT NULL,
  revision            INTEGER NOT NULL,
  repo                TEXT NOT NULL,
  base_rev            TEXT NOT NULL,
  spec_hash           TEXT NOT NULL,
  spec_json           TEXT NOT NULL,
  state               TEXT NOT NULL CHECK (state IN (
                        'submitted','qualified','lit_parked','dispatched','receipted',
                        'verified','promoted','rejected','aborted','ambiguous')),
  lane                TEXT CHECK (lane IN ('dark','lit','reject')),
  current_mandate_id  TEXT,
  attempt_count       INTEGER NOT NULL DEFAULT 0 CHECK (attempt_count >= 0),
  created_at          TEXT NOT NULL,
  updated_at          TEXT NOT NULL,
  terminal_at         TEXT,
  terminal_reason     TEXT,
  -- I2: identity is (repo, slug, revision) — the same spec re-submitted is the
  -- same unit, a changed spec under the same revision is a duplicate refusal.
  UNIQUE (repo, slug, revision)
);
CREATE INDEX IF NOT EXISTS units_state ON units(state);
CREATE INDEX IF NOT EXISTS units_lane_state ON units(lane, state);
-- I3: a terminal unit never has a terminal_at-less row and vice versa.
CREATE TRIGGER IF NOT EXISTS units_terminal_consistent BEFORE UPDATE ON units
WHEN NEW.terminal_at IS NOT NULL AND NEW.state NOT IN ('promoted','rejected','aborted','lit_parked')
BEGIN SELECT RAISE(ABORT, 'terminal_at set on a non-terminal unit state'); END;

-- ------------------------------------------------------------------ mandates
CREATE TABLE IF NOT EXISTS mandates (
  mandate_id      TEXT PRIMARY KEY,
  unit_id         TEXT NOT NULL REFERENCES units(unit_id),
  policy_version  TEXT NOT NULL,
  lane            TEXT NOT NULL CHECK (lane IN ('dark','lit')),
  budget_usd      REAL NOT NULL CHECK (budget_usd >= 0),
  issued_at       TEXT NOT NULL,
  expires_at      TEXT NOT NULL,
  revoked_at      TEXT
);
CREATE INDEX IF NOT EXISTS mandates_unit ON mandates(unit_id);

-- ------------------------------------------------------------ lane decisions
CREATE TABLE IF NOT EXISTS lane_decisions (
  decision_id     TEXT PRIMARY KEY,
  unit_id         TEXT NOT NULL REFERENCES units(unit_id),
  lane            TEXT NOT NULL CHECK (lane IN ('dark','lit','reject')),
  score           REAL NOT NULL CHECK (score >= 0 AND score <= 100),
  policy_version  TEXT NOT NULL,
  signals_json    TEXT NOT NULL,
  reasons_json    TEXT NOT NULL,
  mandate_id      TEXT,
  decided_at      TEXT NOT NULL,
  -- I4: re-qualification under one policy is idempotent.
  UNIQUE (unit_id, policy_version)
);

-- --------------------------------------------------------------------- leases
-- I5: at most one live lease per unit. Partial unique index, not application logic.
CREATE TABLE IF NOT EXISTS leases (
  lease_id     TEXT PRIMARY KEY,
  unit_id      TEXT NOT NULL REFERENCES units(unit_id),
  owner        TEXT NOT NULL,
  acquired_at  TEXT NOT NULL,
  expires_at   TEXT NOT NULL,
  released_at  TEXT
);
CREATE UNIQUE INDEX IF NOT EXISTS leases_one_live_per_unit
  ON leases(unit_id) WHERE released_at IS NULL;

-- ------------------------------------------------------------------- attempts
CREATE TABLE IF NOT EXISTS attempts (
  attempt_id     TEXT PRIMARY KEY,
  unit_id        TEXT NOT NULL REFERENCES units(unit_id),
  lease_id       TEXT NOT NULL REFERENCES leases(lease_id),
  state          TEXT NOT NULL CHECK (state IN (
                   'planned','launching','running','produced-receipt','aborted','ambiguous')),
  launch_key     TEXT NOT NULL UNIQUE,
  session_id     TEXT,
  attempt_dir    TEXT NOT NULL,
  started_at     TEXT NOT NULL,
  ended_at       TEXT,
  exit_code      INTEGER
);
CREATE INDEX IF NOT EXISTS attempts_unit ON attempts(unit_id, started_at);
CREATE INDEX IF NOT EXISTS attempts_state ON attempts(state);

-- ------------------------------------------------------------------- receipts
-- I6: the receipt is a fact bundle, append-only, addressed by its content hash.
CREATE TABLE IF NOT EXISTS receipts (
  receipt_id    TEXT PRIMARY KEY,
  unit_id       TEXT NOT NULL REFERENCES units(unit_id),
  attempt_id    TEXT NOT NULL REFERENCES attempts(attempt_id),
  receipt_sha   TEXT NOT NULL UNIQUE,
  session_id    TEXT NOT NULL,
  exit_code     INTEGER,
  started_at    TEXT NOT NULL,
  ended_at      TEXT NOT NULL,
  receipt_json  TEXT NOT NULL,
  recorded_at   TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS receipts_unit ON receipts(unit_id);
CREATE TRIGGER IF NOT EXISTS receipts_no_update BEFORE UPDATE ON receipts
BEGIN SELECT RAISE(ABORT, 'receipts is append-only'); END;
CREATE TRIGGER IF NOT EXISTS receipts_no_delete BEFORE DELETE ON receipts
BEGIN SELECT RAISE(ABORT, 'receipts is append-only'); END;

-- ------------------------------------------------------------------- verdicts
-- I7: unknown cannot be stored as pass. A pass verdict needs a receipt, a
-- measured Δ and a holdout revision — enforced by CHECK, not by convention.
CREATE TABLE IF NOT EXISTS verdicts (
  verdict_id        TEXT PRIMARY KEY,
  unit_id           TEXT NOT NULL REFERENCES units(unit_id),
  attempt_id        TEXT NOT NULL REFERENCES attempts(attempt_id),
  receipt_id        TEXT REFERENCES receipts(receipt_id),
  receipt_sha       TEXT,
  holdout_revision  TEXT,
  policy_version    TEXT NOT NULL,
  wall_version      TEXT NOT NULL,
  outcome           TEXT NOT NULL CHECK (outcome IN ('pass','fail','unknown')),
  delta_checked     INTEGER NOT NULL CHECK (delta_checked IN (0,1)),
  delta_observed    REAL,
  reasons_json      TEXT NOT NULL,
  scenarios_json    TEXT NOT NULL,
  delta_json        TEXT NOT NULL,
  evaluated_at      TEXT NOT NULL,
  CHECK (
    outcome <> 'pass' OR (
      receipt_id IS NOT NULL
      AND receipt_sha IS NOT NULL
      AND holdout_revision IS NOT NULL
      AND delta_checked = 1
      AND delta_observed IS NOT NULL
    )
  )
);
CREATE INDEX IF NOT EXISTS verdicts_unit ON verdicts(unit_id, evaluated_at);
CREATE TRIGGER IF NOT EXISTS verdicts_no_update BEFORE UPDATE ON verdicts
BEGIN SELECT RAISE(ABORT, 'verdicts is append-only'); END;
CREATE TRIGGER IF NOT EXISTS verdicts_no_delete BEFORE DELETE ON verdicts
BEGIN SELECT RAISE(ABORT, 'verdicts is append-only'); END;

-- ------------------------------------------------------------------ promotions
CREATE TABLE IF NOT EXISTS promotions (
  promotion_id   TEXT PRIMARY KEY,
  unit_id        TEXT NOT NULL REFERENCES units(unit_id),
  verdict_id     TEXT NOT NULL REFERENCES verdicts(verdict_id),
  verdict_sha    TEXT NOT NULL,
  promotion_sha  TEXT NOT NULL,
  signed_by      TEXT NOT NULL,
  created_at     TEXT NOT NULL,
  -- I8: promoting the same verdict twice is the same promotion.
  UNIQUE (unit_id, verdict_sha)
);

-- ----------------------------------------------------------- spend / envelopes
CREATE TABLE IF NOT EXISTS spend_ledger (
  spend_id     TEXT PRIMARY KEY,
  unit_id      TEXT NOT NULL REFERENCES units(unit_id),
  attempt_id   TEXT REFERENCES attempts(attempt_id),
  kind         TEXT NOT NULL CHECK (kind IN ('reserved','estimate','measured','unknown')),
  amount_usd   REAL CHECK (amount_usd IS NULL OR amount_usd >= 0),
  recorded_at  TEXT NOT NULL,
  -- I9: a reservation is written before dispatch; amount may be null (= unknown).
  CHECK (kind <> 'reserved' OR amount_usd IS NOT NULL)
);
CREATE INDEX IF NOT EXISTS spend_unit ON spend_ledger(unit_id);

-- Metered usage, observed by the credential proxy from the gateway's own response.
-- Append-only like the ledger: a usage row is a fact about one upstream call, so a second row
-- for the same call would be a second call, never an update. A NULL cost_usd is 'unknown'
-- (tokens were reported, no price was), which is why the column is nullable and the check does
-- not default it to zero.
${USAGE_RECORDS_DDL}

-- --------------------------------------------------------- class certificates
-- ND1 half two: the wall's per-class judgement as an append-only projection. One row
-- per verdict that carried one; the digest lets a reader prove the row and the
-- wall.class_certified event are the same fact.
${CLASS_CERTIFICATES_DDL}

CREATE TABLE IF NOT EXISTS envelopes (
  envelope_id     TEXT PRIMARY KEY,
  scope           TEXT NOT NULL CHECK (scope IN ('per-unit','daily')),
  amount_usd      REAL NOT NULL CHECK (amount_usd >= 0),
  effective_from  TEXT NOT NULL,
  supersedes      TEXT REFERENCES envelopes(envelope_id),
  signed_by       TEXT NOT NULL,
  reason          TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS credentials (
  grant_id     TEXT PRIMARY KEY,
  repo         TEXT NOT NULL,
  ttl_seconds  INTEGER NOT NULL CHECK (ttl_seconds > 0 AND ttl_seconds <= 3600),
  issued_by    TEXT NOT NULL,
  issued_at    TEXT NOT NULL,
  expires_at   TEXT NOT NULL,
  revoked_at   TEXT
);

-- -------------------------------------------------------- effects (the outbox)
-- I10: an effect is applied at most once, keyed by content, never by timing.
CREATE TABLE IF NOT EXISTS effects (
  effect_id        TEXT PRIMARY KEY,
  idempotency_key  TEXT NOT NULL UNIQUE,
  kind             TEXT NOT NULL,
  payload_json     TEXT NOT NULL,
  state            TEXT NOT NULL CHECK (state IN ('pending','applied','failed')),
  attempts         INTEGER NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  created_at       TEXT NOT NULL,
  applied_at       TEXT,
  last_error       TEXT
);
CREATE INDEX IF NOT EXISTS effects_state ON effects(state, created_at);

-- -------------------------------------------------------------- store state
CREATE TABLE IF NOT EXISTS store_state (
  key    TEXT PRIMARY KEY,
  value  TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS recovery_runs (
  recovery_run_id    TEXT PRIMARY KEY,
  started_at         TEXT NOT NULL,
  completed_at       TEXT,
  orphaned_attempts  INTEGER NOT NULL DEFAULT 0,
  ambiguous          INTEGER NOT NULL DEFAULT 0
);
`;

/**
 * Invariants that are *tested* rather than declared in SQL, listed here so the
 * test file and the schema cannot silently diverge:
 *  - I11 replay: replaying the ledger reproduces every aggregate.
 *  - I12 seq contiguity: no gaps in `events.seq` within a trace.
 *  - I13 quarantine: once `store_state.quarantined` is set, every write path refuses.
 *  - I14 effect ordering: a `pending` effect older than the sweep interval is reported, never deleted.
 */
export const CODE_LEVEL_INVARIANTS = ['I11', 'I12', 'I13', 'I14'] as const;
