/**
 * Seeding a store for the panel specs — through the real CLI wherever the CLI can get
 * there, and through the control plane's engine for the one step it cannot.
 *
 * The rule this file follows is the point of the suite: the panel is a *reader*, so a
 * spec that fabricates rows would be testing the fixture rather than the two surfaces
 * agreeing. Everything an operator can do from the command line is therefore done by
 * spawning `node apps/cli/src/main.ts`:
 *
 *   - `intent`         → a submitted unit;
 *   - `qualify`        → `dark` (with `--cold-start`) or `lit`, which parks the unit;
 *   - `abort`          → a terminal unit with no verdict;
 *   - `budget raise`   → an envelope change (needs the typed phrase; not used here).
 *
 * What the CLI cannot do in v1 is record a **verdict**: `run` dispatches, collects the
 * receipt, prints `verdict unknown - the wall did not evaluate this attempt` and exits 4
 * because the wall's `evaluate()` port is not wired (`apps/cli/src/verbs/run.ts`). Its
 * `FACTORY_EXECUTOR=fake` / `FACTORY_WALL=fake` switches are declared in `context.ts`
 * but nothing consumes them, so no flag combination reaches a verdict either. Since the
 * panel's most important behaviour is how it renders `unknown`, the specs drive the same
 * `Engine` the CLI's `run` verb drives — `runUnit`, `observeAttempt`, `recordVerdict` —
 * with a synthetic `WorkerReceipt`. Every invariant still applies (attempt phase, receipt
 * identity, earned-ness of a pass, the verdict citing the stored receipt's hash); only
 * the worker is synthetic. Reported to the Lead as a plan gap in `e2e-tests.md` E2E-37.
 */
import { chmodSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

// The e2e tree sits outside every workspace package, so the root `node_modules`
// does not link them. Relative imports keep the harness runnable from a checkout
// whose install is scoped to `apps/*` — the same sources, resolved the same way.
import {
  FactoryError,
  WALL_VERSION,
  contentHash,
  receiptShaFor,
} from '../../../packages/contracts/src/index.ts';
import { currentPolicyVersion } from '../../../packages/qualifier/src/index.ts';
import { PINNED_DSH_VERSION } from '../../../packages/dsh-adapter/src/index.ts';

import { openStore } from '../../../packages/store/src/index.ts';
import { createContext, createUi } from '../../../apps/cli/src/context.ts';
import {
  newFactoryHome,
  runFactory,
  specFor,
  submitUnit,
  type FactoryRun,
} from '../../harness/factory.ts';
import { createFixtureRepo, type FixtureRepo } from '../../harness/fixture.ts';

/** Text that exists only in a receipt's `narrative`, which must never reach the page. */
export const NARRATIVE_MARKER =
  'NARRATIVE-9f3a: the agent explains itself in prose, and this sentence must never be rendered';

/** A fixed evaluation time: deterministic seeds, stable `since` values. */
export const EVALUATED_AT = '2026-11-01T12:05:00.000Z';

/** The DSH the factory is pinned to; the health strip compares against it. */
export const EXPECTED_DSH_VERSION = PINNED_DSH_VERSION;

export interface Seed {
  /** Temp `FACTORY_HOME`: the store, the artifacts and the spec files live here. */
  readonly home: string;
  /** A real git repository, so specs have a genuine 40-hex `baseRev` to point at. */
  readonly fixture: FixtureRepo;
  /**
   * A fresh spec revision per unit. `intent` is idempotent by spec hash, so two
   * identical specs are *one* unit — a spec that wants three units has to ask for
   * three different ones, which is a fact about the CLI worth keeping visible.
   */
  nextRevision(): number;
  cleanup(): void;
}

/** A fresh store plus a real fixture repository. */
export function newSeed(): Seed {
  const fixture = createFixtureRepo();
  const home = newFactoryHome('factory-panel-e2e-');
  let revision = 0;
  return {
    home,
    fixture,
    nextRevision: () => {
      revision += 1;
      return revision;
    },
    cleanup: () => {
      fixture.cleanup();
      // The temp home is a real store plus attempt artifacts; leave nothing behind.
      rmSync(home, { recursive: true, force: true });
    },
  };
}

/** Every CLI invocation in this file runs with the seeded home and no `dsh` on PATH. */
function cli(seed: Seed, args: readonly string[]): FactoryRun {
  return runFactory(args, { home: seed.home });
}

/**
 * Submit one unit through the CLI and, optionally, take it through `qualify`.
 *
 * `dark` requires `--cold-start` because the qualifier has no per-class history yet;
 * that refusal is policy (`TASK_CLASS_UNKNOWN` is not a pass), not a fixture trick.
 */
export function cliUnit(seed: Seed, options: { readonly lane?: 'dark' | 'lit' } = {}): string {
  const revision = seed.nextRevision();
  // The slug and revision are what make this spec a different unit from the last one;
  // the intent text stays identical so the qualifier scores every seeded unit the same.
  const spec = specFor({
    baseRev: seed.fixture.baseRev,
    slug: `slug-check-${String(revision)}`,
    revision,
  });
  const { unitId } = submitUnit(seed.home, { spec });
  const lane = options.lane;
  if (lane === undefined) return unitId;
  const args =
    lane === 'dark' ? ['qualify', unitId, '--cold-start', '--json'] : ['qualify', unitId, '--json'];
  const qualified = cli(seed, args);
  if (qualified.code !== 0) {
    throw new Error(`qualify (${lane}) failed: ${qualified.stderr}${qualified.stdout}`);
  }
  return unitId;
}

/** Abort a unit through the CLI: a terminal unit that carries no verdict. */
export function cliAbort(
  seed: Seed,
  unitId: string,
  reason = 'seeded abort for the panel suite',
): void {
  const aborted = cli(seed, ['abort', unitId, '--reason', reason, '--json']);
  if (aborted.code !== 0) {
    throw new Error(`abort failed: ${aborted.stderr}${aborted.stdout}`);
  }
}

export interface SeedVerdictOptions {
  readonly unitId: string;
  readonly outcome: 'pass' | 'unknown';
  /** Wall reason codes; required for a meaningful `unknown`, forbidden for a pass. */
  readonly reasons?: readonly string[];
}

/**
 * Produce one receipt and one verdict for a qualified dark unit, through the engine.
 *
 * The order is the engine's, not this file's: dispatch (attempt + lease + reservation),
 * then the receipt, then the verdict that cites that receipt's hash. A pass has to be
 * earned exactly as `assertVerdictIsEarned` demands — every scenario passing, Δ measured
 * and at or above threshold — because a fixture that could mint an unearned pass would
 * be the one lie this project exists to prevent.
 */
export function seedVerdict(
  seed: Seed,
  options: SeedVerdictOptions,
): { attemptId: string; verdictId: string } {
  const ctx = createContext(createUi({ out: () => {}, err: () => {} }), {
    home: seed.home,
    env: { ...process.env, FACTORY_HOME: seed.home },
  });
  try {
    const dispatched = ctx.engine.runUnit(options.unitId);
    const attemptId = dispatched.attempt.attemptId;
    const receipt = {
      unitId: options.unitId,
      attemptId,
      sessionId: 'sess-panel-e2e',
      startedAt: '2026-11-01T12:00:00.000Z',
      endedAt: '2026-11-01T12:01:30.000Z',
      exitCode: 0,
      diff: {
        patchFile: join(seed.home, 'attempts', attemptId, 'change.patch'),
        sha: contentHash({ unit: options.unitId, attempt: attemptId, kind: 'patch' }),
        filesChanged: 1,
        insertions: 12,
        deletions: 0,
        baseRev: seed.fixture.baseRev,
      },
      commands: [
        {
          argv: ['pnpm', 'test'],
          cwd: join(seed.home, 'attempts', attemptId),
          exitCode: 0,
          timedOut: false,
          outputSha: contentHash({ unit: options.unitId, kind: 'output' }),
          durationMs: 1_200,
        },
      ],
      suite: {
        command: ['pnpm', 'test'],
        exitCode: 0,
        passed: 8,
        failed: 0,
        skipped: 0,
        unknown: 0,
      },
      ceilings: { turnsUsed: 6, wallClockMs: 90_000, hit: [] },
      artifacts: [],
      narrative: NARRATIVE_MARKER,
    };
    ctx.engine.observeAttempt(attemptId, receipt);
    const verdict = {
      unitId: options.unitId,
      attemptId,
      // The store records `receiptShaFor(receipt)` — the decision projection, not the
      // narrative-bearing body — and refuses a verdict that cites evidence it does not hold.
      receiptSha: receiptShaFor(receipt),
      holdoutRevision: 'holdout/7',
      policyVersion: currentPolicyVersion(),
      wallVersion: WALL_VERSION,
      outcome: options.outcome,
      scenarios: [
        { id: 'ac-1', source: 'acceptance', outcome: 'pass', observed: 'exit 0' },
        {
          id: 'ho-1',
          source: 'holdout',
          outcome: options.outcome === 'pass' ? 'pass' : 'unknown',
          observed: 'holdout run',
        },
        {
          id: 'ho-2',
          source: 'holdout',
          outcome: options.outcome === 'pass' ? 'pass' : 'unknown',
          observed: 'holdout run',
        },
      ],
      delta: {
        checked: options.outcome === 'pass',
        baseRate: 0.8,
        candidateRate: 0.85,
        threshold: 0,
        observed: options.outcome === 'pass' ? 0.05 : null,
        holdoutRevision: 'holdout/7',
      },
      reasons: options.reasons ?? [],
      evaluatedAt: EVALUATED_AT,
    };
    try {
      const recorded = ctx.engine.recordVerdict(attemptId, verdict);
      return { attemptId, verdictId: recorded.verdict.verdictId };
    } catch (error) {
      // `unknown` is recorded and *then* refused: the engine commits the verdict (the
      // wall's work is evidence) and exits 5 so a human decides, leaving the unit where
      // it was. The seeding script wants the row, so this one error is success.
      if (
        options.outcome === 'unknown' &&
        error instanceof FactoryError &&
        error.code === 'VERDICT_UNKNOWN'
      ) {
        return { attemptId, verdictId: String(error.details['verdictId'] ?? '') };
      }
      throw error;
    }
  } finally {
    ctx.store.close();
  }
}

/**
 * Dispatch a unit and never observe the attempt.
 *
 * This is the state the panel reports as `OUTBOX degraded` (one effect pending) and as a
 * unit in flight, which is exactly the "the control plane is running but something is
 * stuck" case the health strip exists for. No receipt is written, so no verdict can be
 * claimed about it.
 */
export function seedDispatchedOnly(seed: Seed, unitId: string): { attemptId: string } {
  const ctx = createContext(createUi({ out: () => {}, err: () => {} }), {
    home: seed.home,
    env: { ...process.env, FACTORY_HOME: seed.home },
  });
  try {
    const dispatched = ctx.engine.runUnit(unitId);
    return { attemptId: dispatched.attempt.attemptId };
  } finally {
    ctx.store.close();
  }
}

/**
 * Record a spend row whose amount could not be measured.
 *
 * This is the row the wall writes when it cannot price an attempt (`kind: 'unknown'`,
 * `amountUsd: null`), and it is the only way to reach the panel's `unknownCount` branch:
 * v1 has no CLI verb that records spend — `run` would, through the executor, but the
 * executor needs a `dsh`. The row goes in through the store's public API, never SQL.
 * Reported to the Lead as a CLI gap alongside the missing verdict verb.
 */
export function seedUnknownSpend(seed: Seed, unitId: string): void {
  const store = openStore({ dir: join(seed.home, 'state') });
  try {
    store.recordSpend({
      spendId: `S-${contentHash({ unitId, kind: 'unknown-spend' }).slice(7, 19)}`,
      unitId,
      attemptId: null,
      kind: 'unknown',
      amountUsd: null,
      recordedAt: '2026-11-01T12:02:00.000Z',
    });
  } finally {
    store.close();
  }
}

/** The CLI's own view of the store, parsed — used to prove the two surfaces agree. */
export function cliStatusJson(seed: Seed): Record<string, unknown> {
  const run = cli(seed, ['status', '--json']);
  // `status --json` exits `5` when a human gate exists (an unknown verdict, a lit unit)
  // even though it still prints exactly one JSON object on stdout: the exit code reports
  // the gate class and the human rendering goes to stderr. So the parse accepts 0 and 5
  // and insists on the object — a machine-readable surface answering with prose would be
  // the bug this helper refuses to hide.
  const lines = run.stdout
    .trim()
    .split('\n')
    .filter((line) => line.startsWith('{'));
  const first = lines[0];
  if ((run.code !== 0 && run.code !== 5) || lines.length !== 1 || first === undefined) {
    throw new Error(
      `status --json printed ${String(lines.length)} JSON line(s) and exited ${String(run.code)}; ` +
        `expected one object and exit 0 or 5\nstdout:\n${run.stdout}\nstderr:\n${run.stderr}`,
    );
  }
  const parsed = JSON.parse(first) as Record<string, unknown>;
  if (parsed['schemaVersion'] !== 'status.v1') {
    throw new Error(`status --json reported schemaVersion ${String(parsed['schemaVersion'])}`);
  }
  return parsed;
}

/** Write an executable file, for stubs a spec wants the panel to probe. */
export function writeExecutable(dir: string, name: string, body: string): string {
  mkdirSync(dir, { recursive: true });
  const path = join(dir, name);
  writeFileSync(path, `#!/bin/sh\n${body}\n`, 'utf8');
  chmodSync(path, 0o755);
  return path;
}
