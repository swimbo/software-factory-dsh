/**
 * The composition root: the only place in the CLI that knows where state lives.
 *
 * Every verb receives a {@link FactoryContext}. No verb opens a store, reads a
 * clock or mints an id for itself — `ux-plan.md` §3's flows are only reproducible
 * because the seams are here: a test passes a temp `FACTORY_HOME` and a frozen
 * clock, and the same code path runs as in production.
 *
 * Two things are deliberately *not* wired in:
 *
 * - The executor and the wall are **probed**, not imported at module load. The
 *   CLI must work on a host with no `dsh`, no docker and no adapter installed
 *   (`run` then refuses with `EXECUTOR_UNAVAILABLE`, exit 8, and a runbook line —
 *   never a stack trace).
 * - Nothing here reads a secret from argv. Gate phrases come in as `--confirm`;
 *   keys are read from files under `FACTORY_HOME`.
 */
import { randomBytes } from 'node:crypto';
import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { delimiter, join } from 'node:path';
import { createRequire } from 'node:module';

import type { LaneDecision } from '@factory/contracts';
import { createEngine, type Engine, type QualifyInput } from '@factory/core';
import { newTraceIdForCli } from './exit.ts';
import {
  currentPolicyVersion,
  DEFAULT_POLICY,
  qualify,
  type QualifierPolicy,
  type TaskClassHistory,
} from '@factory/qualifier';
import { openStore, type Store } from '@factory/store';

/** `ux-plan.md` §3.6's starting ceiling. A raise is a gate; the default is not. */
export const DEFAULT_PER_UNIT_USD = 2;

/** `ux-plan.md` §3.6's daily ceiling. Raising it is a *second*, separate gate. */
export const DEFAULT_PER_DAY_USD = 20;

/** How long a launch lease stays valid; a crashed controller's attempt becomes reclaimable. */
export const LEASE_TTL_MS = 45 * 60 * 1000;

export interface UiOverrides {
  readonly json?: boolean;
  readonly plain?: boolean;
  readonly color?: boolean;
  readonly out?: (line: string) => void;
  readonly err?: (line: string) => void;
}

/**
 * Two streams, one rule: **human text goes to stderr, data to stdout**.
 * `--json` therefore prints exactly one object on stdout and nothing else.
 */
export interface CliUi {
  readonly json: boolean;
  /** Zero ANSI bytes of any kind (`--plain`, or `TERM=dumb`). Stronger than `NO_COLOR`. */
  readonly plain: boolean;
  /** Colour only; never the only channel for meaning (`ux-plan.md` §6.1). */
  readonly color: boolean;
  /** A human-facing line on stdout (tables, blocks, the one-line status). */
  readonly out: (line: string) => void;
  /** A human-facing line on stderr (progress, warnings, every error). */
  readonly err: (line: string) => void;
}

export function createUi(overrides: UiOverrides = {}): CliUi {
  const out = overrides.out ?? ((line: string) => void process.stdout.write(`${line}\n`));
  const err = overrides.err ?? ((line: string) => void process.stderr.write(`${line}\n`));
  const env = process.env;
  const plain = overrides.plain === true || env.TERM === 'dumb';
  // NO_COLOR (present and non-empty) removes colour but not bold/underline, so it
  // is only the first of the two switches (§6.1).
  const noColor = (env.NO_COLOR ?? '').length > 0;
  const tty = process.stdout.isTTY === true;
  return {
    json: overrides.json === true,
    plain,
    color: overrides.color ?? (!plain && !noColor && tty),
    out,
    err,
  };
}

/** Where the factory keeps its state. One directory, five well-known children. */
export interface FactoryPaths {
  readonly home: string;
  readonly state: string;
  readonly artifacts: string;
  readonly work: string;
  readonly attempts: string;
  readonly keys: string;
}

export function resolveHome(env: Readonly<Record<string, string | undefined>>): string {
  const configured = (env.FACTORY_HOME ?? '').trim();
  return configured.length > 0 ? configured : join(homedir(), '.factory');
}

export function factoryPaths(home: string): FactoryPaths {
  return {
    home,
    state: join(home, 'state'),
    artifacts: join(home, 'artifacts'),
    work: join(home, 'work'),
    attempts: join(home, 'attempts'),
    keys: join(home, 'keys'),
  };
}

/**
 * What `run` needs to exist before it may dispatch anything.
 *
 * `available: false` is a *fact*, not an error: it is rendered as
 * `EXECUTOR_UNAVAILABLE` (exit 8) with the runbook line, and no reservation is
 * made (`ux-plan.md` §5.2: "nothing dispatched, no reservation").
 */
export interface ExecutorProbe {
  readonly available: boolean;
  /** `headless` is the real `dsh`; `fake` is the scripted test double (`FACTORY_EXECUTOR=fake`). */
  readonly kind: 'headless' | 'fake';
  readonly binPath: string | null;
  readonly moduleAvailable: boolean;
  /** The JSON scenario a fake executor runs. `null` for the real one. */
  readonly scenarioPath: string | null;
  readonly detail: string;
  readonly runbook: string;
  /**
   * Where the turn will run, and what it will run inside.
   *
   * `mode: 'host'` is the default and means a child of this process. `mode: 'container'` carries
   * the plan the executor needs; it is `null` for a host launch, so a caller cannot accidentally
   * pass a container plan it did not probe. The refusal case is `available: false` with the
   * docker/image reason in `detail` — never a host launch.
   */
  readonly isolation: {
    readonly mode: 'host' | 'container' | 'refused';
    readonly reason: string;
    readonly container: import('@factory/dsh-adapter').WorkerContainerPlan | null;
  };
}

export interface WallProbe {
  readonly available: boolean;
  /** `container` is the real wall; `fake` replays a declared verdict (`FACTORY_WALL=fake`). */
  readonly kind: 'container' | 'fake';
  /** The verdict template a fake wall stamps onto the stored receipt. */
  readonly verdictPath: string | null;
  readonly detail: string;
}

/**
 * Test-only switches, refused in production.
 *
 * The fake executor and the fake wall exist so the plumbing between `run` and the
 * verdict can be exercised without a `dsh` binary, a container or a model key. They
 * are also the shortest possible path to a green nobody earned, so they are guarded
 * three ways: this refusal, a banner on every command that uses them, and a ledger
 * marker (`sessionId: fake-<attempt>`, `wallVersion: …-fake`) that survives into the
 * store. A test double that can be reached in production is not a test double, it
 * is a back door.
 */
function refuseInProduction(
  env: Readonly<Record<string, string | undefined>>,
  variable: string,
): string | null {
  if (env.NODE_ENV !== 'production') return null;
  return `${variable} is refused when NODE_ENV=production: a test double may not run a real factory`;
}

/** A PATH lookup that never spawns a process: `status` must be cheap and deterministic. */
export function findOnPath(
  bin: string,
  env: Readonly<Record<string, string | undefined>>,
): string | null {
  const override = (env.DSH_BIN ?? '').trim();
  if (override.length > 0 && existsSync(override)) return override;
  const path = env.PATH ?? '';
  for (const dir of path.split(delimiter)) {
    if (dir.length === 0) continue;
    const candidate = join(dir, bin);
    if (existsSync(candidate)) return candidate;
  }
  return null;
}

/**
 * The adapter, required lazily.
 *
 * `context.ts` is the composition root and must import on a host with no adapter installed
 * (`run` then refuses with a runbook line). A static import would turn that refusal into a stack
 * trace at module load, so the one package the probe needs is required here, inside a try/catch,
 * exactly like {@link moduleResolves}.
 */
function requireAdapter(): typeof import('@factory/dsh-adapter') | null {
  try {
    return createRequire(import.meta.url)(
      '@factory/dsh-adapter',
    ) as typeof import('@factory/dsh-adapter');
  } catch {
    return null;
  }
}

function moduleResolves(specifier: string): boolean {
  try {
    createRequire(import.meta.url).resolve(specifier);
    return true;
  } catch {
    return false;
  }
}

export function probeExecutor(
  env: Readonly<Record<string, string | undefined>>,
  options: { readonly moduleAvailable?: boolean; readonly scenarioPath?: string | null } = {},
): ExecutorProbe {
  const binPath = findOnPath('dsh', env);
  if (env.FACTORY_EXECUTOR === 'fake') {
    const refusal = refuseInProduction(env, 'FACTORY_EXECUTOR=fake');
    const scenarioPath =
      options.scenarioPath ??
      ((env.FACTORY_SCENARIO ?? '').trim() === '' ? null : (env.FACTORY_SCENARIO ?? '').trim());
    if (refusal !== null) {
      return {
        available: false,
        kind: 'fake',
        binPath: null,
        moduleAvailable: true,
        scenarioPath,
        detail: refusal,
        runbook:
          'runbook: unset NODE_ENV or FACTORY_EXECUTOR=fake; the real executor needs the pinned dsh',
        isolation: {
          mode: 'host',
          reason: 'the scripted executor launches no process',
          container: null,
        },
      };
    }
    if (scenarioPath === null) {
      return {
        available: false,
        kind: 'fake',
        binPath: null,
        moduleAvailable: true,
        scenarioPath: null,
        detail: 'FACTORY_EXECUTOR=fake needs a scenario (--scenario <path> or FACTORY_SCENARIO)',
        runbook: 'runbook: pass --scenario <scenario.json> describing the worker the test needs',
        isolation: {
          mode: 'host',
          reason: 'the scripted executor launches no process',
          container: null,
        },
      };
    }
    return {
      available: true,
      kind: 'fake',
      binPath: null,
      moduleAvailable: true,
      scenarioPath,
      detail: `fake executor, scenario ${scenarioPath} - no dsh process will be launched`,
      runbook: '',
      isolation: {
        mode: 'host',
        reason: 'the scripted executor launches no process',
        container: null,
      },
    };
  }
  const moduleAvailable = options.moduleAvailable ?? moduleResolves('@factory/dsh-adapter');
  // Where the turn will run. Consulted even for a host request, because an unrecognised value is a
  // usage error and the operator has to learn about it before anything is reserved.
  const adapter = moduleAvailable ? requireAdapter() : null;
  const choice =
    adapter === null ? null : adapter.decideWorkerIsolation({ env, platform: process.platform });

  if (choice !== null && choice.mode === 'refuse') {
    // A refusal is never a fallback. If `container` was asked for and docker, the image, or a flag
    // is missing, the launch stops here with the reason and the command that fixes it — running a
    // host child instead would make the isolation claim in the README false while every test
    // stayed green.
    return {
      available: false,
      kind: 'headless',
      binPath,
      moduleAvailable,
      scenarioPath: null,
      // The reason *and* the fix, in the one field `run` renders (`verbs/run.ts` turns `detail`
      // into the refusal message and drops `runbook`, which is why the command is carried here
      // too — the same shape `resolveMirror` uses for its refusals).
      detail: `${choice.reason}. ${choice.runbook}`,
      runbook: choice.runbook,
      isolation: { mode: 'refused', reason: choice.reason, container: null },
    };
  }

  const wantsContainer = choice !== null && choice.mode === 'container';
  const missing: string[] = [];
  if (!moduleAvailable || adapter === null) {
    missing.push('the @factory/dsh-adapter package could not be resolved');
  }
  // In container mode the binary that runs is the image's; only a host launch needs the host one.
  if (!wantsContainer && binPath === null) {
    missing.push('no `dsh` binary on PATH (set DSH_BIN to override)');
  }
  const container =
    wantsContainer && choice !== null && choice.mode === 'container' ? choice.plan : null;
  const reason = choice === null ? 'the worker runs as a child of this process' : choice.reason;
  return {
    available: missing.length === 0,
    kind: 'headless',
    binPath,
    moduleAvailable,
    scenarioPath: null,
    detail:
      missing.length === 0
        ? container === null
          ? `dsh at ${String(binPath)}`
          : reason
        : missing.join('; '),
    runbook:
      'runbook: install the pinned dsh (0.2.1-rc.5) and make it reachable on PATH, then re-run: factory run <unitId>',
    isolation:
      container === null
        ? { mode: 'host', reason, container: null }
        : { mode: 'container', reason, container },
  };
}

export function probeWall(
  env: Readonly<Record<string, string | undefined>>,
  options: { readonly moduleAvailable?: boolean; readonly verdictPath?: string | null } = {},
): WallProbe {
  if (env.FACTORY_WALL === 'fake') {
    const refusal = refuseInProduction(env, 'FACTORY_WALL=fake');
    const verdictPath =
      options.verdictPath ??
      ((env.FACTORY_VERDICT ?? '').trim() === '' ? null : (env.FACTORY_VERDICT ?? '').trim());
    if (refusal !== null) {
      return { available: false, kind: 'fake', verdictPath, detail: refusal };
    }
    if (verdictPath === null) {
      return {
        available: false,
        kind: 'fake',
        verdictPath: null,
        detail: 'FACTORY_WALL=fake needs a verdict template (--verdict <path> or FACTORY_VERDICT)',
      };
    }
    return {
      available: true,
      kind: 'fake',
      verdictPath,
      detail: `fake wall, verdict template ${verdictPath} - no scenario will be executed`,
    };
  }
  const moduleAvailable = options.moduleAvailable ?? moduleResolves('@factory/wall');
  if (!moduleAvailable) {
    return {
      available: false,
      kind: 'container',
      verdictPath: null,
      detail: 'the @factory/wall package could not be resolved',
    };
  }
  // Docker is no longer the difference between "can verify" and "cannot": the wall
  // ships a local runner, so a host without a container runtime still measures —
  // with no containment, which every verdict it produces labels `+local`. What docker
  // changes is the *quality* of the instrument, not the availability of one.
  const docker = findOnPath('docker', env);
  return {
    available: true,
    kind: 'container',
    verdictPath: null,
    detail:
      docker === null
        ? 'wall available via the local runner (no docker: no container isolation)'
        : 'wall available (docker on PATH: container runner)',
  };
}

export interface ContextOverrides {
  readonly home?: string;
  readonly env?: Readonly<Record<string, string | undefined>>;
  readonly now?: () => Date;
  readonly newId?: (prefix: string) => string;
  readonly traceId?: string;
  readonly cwd?: string;
  /** Injected so a test can prove the `run` refusal without a dsh install. */
  readonly executor?: ExecutorProbe;
  readonly wall?: WallProbe;
  readonly envelopeUsd?: () => number;
  /**
   * Overrides `FACTORY_POLICY_ALLOW_COLD_START` for one invocation. `--cold-start`
   * is the only caller: the operator taking responsibility for routing a unit dark
   * on a factory that has measured nothing yet.
   */
  readonly allowColdStart?: boolean;
  /** `--scenario <path>`: the fake executor's script (test-only). */
  readonly scenarioPath?: string;
  /** `--verdict <path>`: the fake wall's verdict template (test-only). */
  readonly verdictPath?: string;
}

export interface FactoryContext {
  readonly ui: CliUi;
  readonly env: Readonly<Record<string, string | undefined>>;
  readonly home: string;
  readonly paths: FactoryPaths;
  readonly cwd: string;
  readonly store: Store;
  readonly engine: Engine;
  readonly now: () => Date;
  readonly nowIso: () => string;
  readonly newId: (prefix: string) => string;
  /** One id per invocation, so every refusal and every ledger row of this run share it. */
  readonly traceId: string;
  readonly envelopeUsd: () => number;
  /** The qualifier rule set this invocation is running under, including cold start. */
  readonly policy: QualifierPolicy;
  /** `contentHash(policy)` — changes when the policy does, which forces a re-score. */
  readonly policyVersion: string;
  readonly allowColdStart: boolean;
  readonly executor: ExecutorProbe;
  readonly wall: WallProbe;
  close(): void;
}

/**
 * One policy per invocation, built once and threaded everywhere.
 *
 * Cold start is a *policy* fact, not a measurement: `allowColdStart: true` makes the
 * qualifier report `task_class_history: pass` with `TASK_CLASS_COLD_START`, and
 * because the flag is part of the policy object it changes `currentPolicyVersion`.
 * A decision made under cold start therefore carries a different version from one
 * made under the shipped policy, and can never be mistaken for a measured pass.
 */
export function resolvePolicy(
  env: Readonly<Record<string, string | undefined>>,
  allowColdStart?: boolean,
): QualifierPolicy {
  const enabled = allowColdStart ?? env['FACTORY_POLICY_ALLOW_COLD_START'] === '1';
  // Read here, at the composition root, and nowhere else: the worker's process environment
  // must not be able to switch brokering off for the factory that brokers it.
  const brokering = env['FACTORY_PRIVILEGED_BROKERING'] === 'on' ? 'on' : 'off';
  // The ceilings are the operator's, read here and nowhere else. A value that is not a
  // positive integer is ignored rather than coerced: "MAX=0" must not become a silent
  // "no dispatch ever", and "" must not become NaN.
  const ceiling = (raw: string | undefined, fallback: number): number => {
    const text = (raw ?? '').trim();
    if (text === '') return fallback;
    const value = Number(text);
    return Number.isInteger(value) && value >= 1 ? value : fallback;
  };
  return {
    ...DEFAULT_POLICY,
    allowColdStart: enabled,
    privilegedBrokering: brokering,
    maxConcurrentAttempts: ceiling(
      env['FACTORY_MAX_CONCURRENT_ATTEMPTS'],
      DEFAULT_POLICY.maxConcurrentAttempts,
    ),
    maxConcurrentWalls: ceiling(
      env['FACTORY_MAX_CONCURRENT_WALLS'],
      DEFAULT_POLICY.maxConcurrentWalls,
    ),
  };
}

export function newId(prefix: string): string {
  return `${prefix}${randomBytes(6).toString('hex')}`;
}

export function newTraceId(): string {
  return newTraceIdForCli();
}

/** The overrides `main.ts` threads through; a named alias keeps its imports readable. */
export type CliContextOverrides = ContextOverrides;

export function createContext(ui: CliUi, overrides: ContextOverrides = {}): FactoryContext {
  const env = overrides.env ?? process.env;
  const home = overrides.home ?? resolveHome(env);
  const paths = factoryPaths(home);
  const clock = overrides.now ?? ((): Date => new Date());
  const nowIso = (): string => clock().toISOString();
  const makeId = overrides.newId ?? newId;
  const traceId = overrides.traceId ?? newTraceId();

  const policy = resolvePolicy(env, overrides.allowColdStart);
  const policyVersion = currentPolicyVersion(policy);
  const store = openStore({ dir: paths.state, now: clock });
  const envelopeUsd =
    overrides.envelopeUsd ??
    ((): number => store.currentEnvelope('per-unit')?.amountUsd ?? DEFAULT_PER_UNIT_USD);

  const engine = createEngine({
    store,
    now: clock,
    newId: makeId,
    // The qualifier is pure and policy-versioned; the engine only needs the
    // decision, and the store keeps it so a second `qualify` never re-scores.
    qualify: (input: QualifyInput): LaneDecision =>
      qualify(
        {
          unitId: input.unitId,
          spec: input.spec,
          // The engine deliberately passes `unknown` (it has no per-class history
          // source); the qualifier's policy answers `TASK_CLASS_UNKNOWN` for null,
          // which is the L3-correct answer rather than an invented history.
          taskClassHistory: input.taskClassHistory as TaskClassHistory | null,
          envelopeUsd: input.envelopeUsd,
          nowIso: input.nowIso,
        },
        policy,
      ),
    envelopeUsd,
    traceId: () => traceId,
    // The version identity travels with the decision: it is what makes a
    // cold-start routing distinguishable from a measured one forever after.
    policyVersion: () => policyVersion,
  });

  return {
    ui,
    env,
    home,
    paths,
    cwd: overrides.cwd ?? process.cwd(),
    store,
    engine,
    now: clock,
    nowIso,
    newId: makeId,
    traceId,
    envelopeUsd,
    policy,
    policyVersion,
    allowColdStart: policy.allowColdStart,
    executor:
      overrides.executor ?? probeExecutor(env, { scenarioPath: overrides.scenarioPath ?? null }),
    wall: overrides.wall ?? probeWall(env, { verdictPath: overrides.verdictPath ?? null }),
    close: () => store.close(),
  };
}

/**
 * Run `fn` with a context and always close the store — including on a refusal,
 * so a failing command cannot leave a WAL file locked for the next one.
 *
 * The async twin exists because `try/finally` around a returned promise closes
 * the store *before* the promise settles, which is the kind of bug that only
 * shows up under a crash.
 */
export async function withContextAsync<T>(
  ui: CliUi,
  overrides: ContextOverrides,
  fn: (ctx: FactoryContext) => Promise<T>,
): Promise<T> {
  const ctx = createContext(ui, overrides);
  try {
    return await fn(ctx);
  } finally {
    ctx.close();
  }
}

export function withContext<T>(
  ui: CliUi,
  overrides: ContextOverrides,
  fn: (ctx: FactoryContext) => T,
): T {
  const ctx = createContext(ui, overrides);
  try {
    return fn(ctx);
  } finally {
    ctx.close();
  }
}
