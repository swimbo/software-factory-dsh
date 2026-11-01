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
  readonly kind: 'headless';
  readonly binPath: string | null;
  readonly moduleAvailable: boolean;
  readonly detail: string;
  readonly runbook: string;
}

export interface WallProbe {
  readonly available: boolean;
  readonly detail: string;
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
  options: { readonly moduleAvailable?: boolean } = {},
): ExecutorProbe {
  const binPath = findOnPath('dsh', env);
  const moduleAvailable = options.moduleAvailable ?? moduleResolves('@factory/dsh-adapter');
  const missing: string[] = [];
  if (binPath === null) missing.push('no `dsh` binary on PATH (set DSH_BIN to override)');
  if (!moduleAvailable) missing.push('the @factory/dsh-adapter package could not be resolved');
  return {
    available: missing.length === 0,
    kind: 'headless',
    binPath,
    moduleAvailable,
    detail: missing.length === 0 ? `dsh at ${String(binPath)}` : missing.join('; '),
    runbook:
      'runbook: install the pinned dsh (0.2.1-rc.3) and make it reachable on PATH, then re-run: factory run <unitId>',
  };
}

export function probeWall(
  env: Readonly<Record<string, string | undefined>>,
  options: { readonly moduleAvailable?: boolean } = {},
): WallProbe {
  const moduleAvailable = options.moduleAvailable ?? moduleResolves('@factory/wall');
  const docker = findOnPath('docker', env);
  const missing: string[] = [];
  if (!moduleAvailable) missing.push('the @factory/wall package could not be resolved');
  if (docker === null) missing.push('no docker daemon reachable (docker not on PATH)');
  return {
    available: missing.length === 0,
    detail: missing.length === 0 ? 'wall available (docker on PATH)' : missing.join('; '),
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
  return enabled ? { ...DEFAULT_POLICY, allowColdStart: true } : { ...DEFAULT_POLICY };
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
    executor: overrides.executor ?? probeExecutor(env),
    wall: overrides.wall ?? probeWall(env),
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
