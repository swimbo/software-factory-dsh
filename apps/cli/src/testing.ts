/** The `GateReason` code each signal emits when it passes; the contract's `reason` is an enum. */
const PASS_REASONS: Readonly<Record<string, string>> = {
  intent_derivability: 'INTENT_DERIVABLE',
  reversibility: 'REVERSIBLE',
  observability: 'ORACLE_PRESENT',
  task_class_history: 'TASK_CLASS_STABLE',
  size: 'SIZE_WITHIN_BUDGET',
  budget: 'BUDGET_WITHIN_ENVELOPE',
};

/**
 * Test fixtures for the CLI: a temp `FACTORY_HOME`, a spec that qualifies, and a
 * `spawnSync` runner for the real binary.
 *
 * Two deliberate choices:
 *
 * - every run points `FACTORY_HOME` at a fresh `mkdtemp` directory and a
 *   restricted `PATH` with **no `dsh`** on it, so "the machinery is missing" is
 *   the default condition rather than a special case;
 * - seeded state is written through the store's own API, never by hand-rolled
 *   SQL. A fixture that fabricates rows the store would refuse would be a test of
 *   the fixture, not of the CLI.
 */
/**
 * **Test-only module.** Nothing outside `*.test.ts` may import it.
 *
 * It lives in the CLI's source tree because its fixtures must use the same modules the
 * CLI uses (`context.ts`, `main.ts`) — a fixture that re-implemented them would test
 * itself. That is also why it needs the gate below: production source that can be
 * imported by the product is production surface, whatever the filename says.
 */
if (process.env.NODE_ENV === 'production') {
  throw new Error(
    'apps/cli/src/testing.ts is the CLI test harness and must never be loaded in production; ' +
      'import the verb or the context directly instead',
  );
}

import { spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { contentHash, LaneDecision, SIGNAL_NAMES, UnitSpec } from '@factory/contracts';
import { currentPolicyVersion, DEFAULT_POLICY } from '@factory/qualifier';
import { openStore } from '@factory/store';

export const MAIN = fileURLToPath(new URL('./main.ts', import.meta.url));

/** Fixed timestamps keep the fixtures deterministic; the CLI never reads the wall clock in these tests. */
export const FIXED_NOW = '2026-11-01T12:00:00.000Z';

export interface CliResult {
  readonly status: number;
  readonly stdout: string;
  readonly stderr: string;
}

export interface CliOptions {
  readonly home?: string;
  readonly env?: Readonly<Record<string, string | undefined>>;
}

export function tempHome(prefix = 'factory-cli-'): string {
  return mkdtempSync(join(tmpdir(), prefix));
}

/** A PATH with the usual tools and no `dsh`, which is the v1 default on this host. */
export const NO_DSH_PATH = '/usr/bin:/bin:/usr/sbin:/sbin';

export function runCli(args: readonly string[], options: CliOptions = {}): CliResult {
  const home = options.home ?? tempHome();
  const result = spawnSync(process.execPath, [MAIN, ...args], {
    encoding: 'utf8',
    timeout: 30_000,
    env: {
      ...process.env,
      PATH: NO_DSH_PATH,
      FACTORY_HOME: home,
      // Deterministic bytes: `--plain`/TERM=dumb remove ANSI, and NO_COLOR is the
      // weaker switch the spec also honours.
      TERM: 'dumb',
      NO_COLOR: '1',
      ...options.env,
    },
  });
  return {
    status: result.status ?? -1,
    stdout: result.stdout ?? '',
    stderr: result.stderr ?? '',
  };
}

/** The one JSON object `--json` promises, parsed. Fails loudly if stdout is not exactly one object. */
export function jsonOf(result: CliResult): Record<string, unknown> {
  const lines = result.stdout
    .trim()
    .split('\n')
    .filter((line) => line.length > 0);
  if (lines.length !== 1) {
    throw new Error(
      `--json printed ${String(lines.length)} lines on stdout:\n${result.stdout}\n${result.stderr}`,
    );
  }
  return JSON.parse(lines[0] ?? '{}') as Record<string, unknown>;
}

export interface SpecOverrides {
  readonly [key: string]: unknown;
}

/** A spec the qualifier scores without a structural refusal: machine-checkable, small, reversible. */
export function baseSpec(overrides: SpecOverrides = {}): Record<string, unknown> {
  return {
    slug: 'slug-check',
    revision: 1,
    repo: 'fixture',
    baseRev: 'a'.repeat(40),
    intent:
      'Add a slug-uniqueness check on the read path so duplicate slugs are rejected before insert.',
    restateBack:
      'You asked for: a slug uniqueness check on the read path, proven by a unit test. Not asking for: a schema migration.',
    acceptance: [
      {
        id: 'slugify',
        text: 'slugify(" A B ") === "a-b"',
        oracle: { kind: 'unit-test', target: 'cli/check.ts', expect: 'a-b' },
      },
      {
        id: 'suite-green',
        text: 'node --test tests/ exits 0',
        oracle: { kind: 'command', target: 'node --test tests/', expect: 'exit 0' },
      },
    ],
    touchPaths: ['cli/check.ts', 'tests/check.test.ts'],
    operationClasses: ['code-change'],
    sizeBudget: { files: 8, lines: 200 },
    budgetEstimateUsd: 0.71,
    ...overrides,
  };
}

export function writeSpec(home: string, overrides: SpecOverrides = {}, name = 'spec.json'): string {
  const path = join(home, name);
  writeFileSync(path, JSON.stringify(baseSpec(overrides), null, 2));
  return path;
}

/** The restate-back file must contain the same text as `spec.restateBack`; the hash is what binds. */
export function writeRestate(home: string, text: string, name = 'restate.md'): string {
  const path = join(home, name);
  writeFileSync(path, `${text}\n`);
  return path;
}

export interface SeedOptions {
  readonly unitId?: string;
  readonly spec?: SpecOverrides;
  readonly lane?: 'dark' | 'lit' | 'reject' | null;
  readonly state?: 'submitted' | 'qualified' | 'lit_parked' | 'rejected';
}

/**
 * Write one unit (and, optionally, its lane + mandate) through the store API.
 *
 * The lane is written directly rather than through `qualify` on purpose: with the
 * engine's `taskClassHistory: unknown`, the qualifier answers `TASK_CLASS_UNKNOWN`
 * and **no unit can reach `dark`** (reported to the Lead). A test of what `run`
 * does to a dark unit therefore has to start from a dark unit, and seeding it is
 * the only honest way to reach that branch.
 */
export function seedUnit(
  home: string,
  options: SeedOptions = {},
): { unitId: string; mandateId: string | null } {
  const store = openStore({ dir: join(home, 'state') });
  const spec = UnitSpec.parse(baseSpec(options.spec ?? {}));
  const unitId = options.unitId ?? `U-${contentHash(spec).slice(7, 15)}`;
  const optionsFor = { actor: 'control', traceId: 'T-seed', occurredAt: FIXED_NOW };
  /** The lane decision is a *record* here, not a claim about the qualifier's policy. */
  const laneDecision = (
    lane: 'dark' | 'lit' | 'reject',
    unit: string,
  ): Record<string, unknown> => ({
    decisionId: `q_${contentHash({ unit, lane }).slice(7, 23)}`,
    unitId: unit,
    lane,
    score: lane === 'dark' ? 95 : lane === 'lit' ? 85 : 20,
    policyVersion: currentPolicyVersion(),
    decidedAt: FIXED_NOW,
    signals: SIGNAL_NAMES.map((name) => {
      // `dark` requires every signal to pass; `lit` is what an unmeasured
      // dimension produces; `reject` needs a rejecting signal to have failed.
      const outcome =
        lane === 'dark'
          ? 'pass'
          : lane === 'lit'
            ? 'unknown'
            : name === 'intent_derivability'
              ? 'fail'
              : 'pass';
      const reason =
        outcome === 'unknown'
          ? 'TASK_CLASS_UNKNOWN'
          : outcome === 'fail'
            ? 'SPEC_NOT_MACHINE_CHECKABLE'
            : PASS_REASONS[name];
      return {
        name,
        outcome,
        reason,
        observed: 'seeded by the fixture',
        weight: DEFAULT_POLICY.weights[name],
      };
    }),
    mandateId: null,
  });
  try {
    store.insertUnit(
      {
        unitId,
        slug: spec.slug,
        revision: spec.revision,
        repo: spec.repo,
        baseRev: spec.baseRev,
        specHash: contentHash(spec),
        spec,
        state: 'submitted',
        lane: null,
        currentMandateId: null,
        attemptCount: 0,
        createdAt: FIXED_NOW,
        updatedAt: FIXED_NOW,
        terminalAt: null,
        terminalReason: null,
      },
      optionsFor,
    );
    const lane = options.lane ?? null;
    if (lane === null) return { unitId, mandateId: null };

    // `LaneDecision.parse` strips unknown keys, and `decisionId` is the store's
    // primary key rather than a contract field — so it is re-attached here.
    const decision = laneDecision(lane, unitId);
    const parsed = LaneDecision.parse(decision);
    store.insertLaneDecision({ ...parsed, decisionId: String(decision['decisionId']) });
    // Only a `dark` lane mints a mandate: a lit or rejected unit that carried one
    // would be a unit the ledger says is dispatchable but policy parked.
    const mandateId = lane === 'dark' ? `M-${contentHash({ unitId, lane }).slice(7, 15)}` : null;
    if (mandateId !== null) {
      store.insertMandate({
        mandateId,
        unitId,
        policyVersion: currentPolicyVersion(),
        lane: 'dark',
        budgetUsd: 2,
        issuedAt: FIXED_NOW,
        expiresAt: '2026-12-01T12:00:00.000Z',
        revokedAt: null,
      });
    }
    // `applyLane` moves the unit to qualified / lit_parked / rejected and appends
    // the event that names the decision, so the fixture never forges a state.
    store.setUnitLaneAndMandate(unitId, lane, mandateId, optionsFor);
    return { unitId, mandateId };
  } finally {
    store.close();
  }
}

/**
 * Seed an attempt whose lease is long gone, which is exactly the state `recover`
 * turns into `ambiguous` (started two hours before "now", no live lease).
 */
export function seedStaleAttempt(home: string, unitId: string, attemptId = 'A-0001'): string {
  const store = openStore({ dir: join(home, 'state') });
  try {
    // The lease row has to exist first (the attempt carries a foreign key to it),
    // and it has to already be expired: that is the state recovery reconciles.
    store.acquireLease({
      leaseId: `LS-${attemptId}`,
      unitId,
      owner: 'worker-that-died',
      acquiredAt: '2026-11-01T10:00:00.000Z',
      expiresAt: '2026-11-01T10:45:00.000Z',
    });
    store.insertAttempt({
      attemptId,
      unitId,
      leaseId: `LS-${attemptId}`,
      state: 'running',
      launchKey: `launch:${attemptId}`,
      sessionId: null,
      attemptDir: join(home, 'attempts', unitId, attemptId),
      startedAt: '2026-11-01T10:00:00.000Z',
      endedAt: null,
      exitCode: null,
    });
    return attemptId;
  } finally {
    store.close();
  }
}
