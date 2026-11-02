/**
 * A local (non-container) `ScenarioRunner`.
 *
 * This exists because the wall had three runners and the missing one was the one that
 * blocked the loop: with no Docker on a laptop or a CI worker, `evaluate()` had nothing to
 * execute scenarios with, so the factory could not produce a verdict at all.
 *
 * **What it does.** One scenario command, in a private temp copy of the checkout, with a
 * wall-clock timeout, capturing the exit code and a hash of its output, plus the
 * machine-readable suite summary when the command emits one. On timeout it kills the
 * **process group**, not the process: a bare `kill` reaps the child and leaves its
 * grandchildren running, which on a test runner means a suite that is still holding the
 * port the next scenario wants.
 *
 * **What it does not do — and this is the load-bearing sentence in this file.** There is
 * no network isolation, no filesystem isolation beyond a temp directory, no uid
 * separation, no read-only root, no capability dropping, no memory or pid ceiling, and no
 * image digest. It measures *behaviour*; it does not provide *containment*. A scenario
 * written for a hostile candidate can read the operator's home directory, reach the
 * network, and fork until the host complains. It is a convenience runner for tests and for
 * an operator's own machine, which is why:
 *
 * - every verdict produced through it is labelled `+local` in `wallVersion`, so nobody
 *   mistakes it for a container verdict (see `runnerVersionSuffix` in `evaluate.ts`);
 * - it **refuses** to run a scenario that declares it needs container isolation
 *   (`requires: 'container'`) or an egress-free network (`network: 'none'`). A runner that
 *   silently ignores an isolation requirement is worse than no runner: it produces a
 *   measurement that looks the same as the one you asked for.
 *
 * Note on the clock: duration is measured with `performance.now()`, not `Date.now()`, for
 * the same reason as the container runner — a duration in a verdict must not jump when
 * the machine's clock is corrected.
 */
import { broker, createMemoryRegistry, describeRefusal } from '../../proxy/src/broker.ts';
import type { BrokerRefusal } from '../../proxy/src/broker.ts';
import type { PrivilegedDecision } from '../../proxy/src/decision.ts';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { cpSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import type {
  ScenarioRunner,
  ScenarioRunInput,
  ScenarioRunResult,
  SuiteSummary,
} from './evaluate.ts';

/**
 * The prefix a runner prints to report its own counts.
 *
 * A line protocol rather than "parse the tool's pretty output": every test runner prints
 * something different, and a grep over human text is a spec that drifts silently. One
 * line, one JSON object, last occurrence wins:
 *
 *     FACTORY_SUMMARY {"passed":12,"failed":0,"unknown":0,"exitCode":0}
 */
export const SUMMARY_LINE_PREFIX = 'FACTORY_SUMMARY ';

export interface LocalRunnerOptions {
  /**
   * Broker the privileged operations the factory is about to re-execute.
   *
   * `'on'` means: a command the broker classifies as privileged (or cannot classify) is
   * **not spawned**. The runner throws {@link PrivilegedBrokerRefusal}, the wall turns the
   * resulting run into `unknown`, and `unknown` never satisfies the gate. `'off'` exists
   * only for callers that are not running worker-declared commands (and for tests that
   * assert the difference); the CLI's wall passes `'on'` and has no flag to turn it off.
   */
  readonly privilegedBrokering?: 'off' | 'on';
  /** The operator's home, for `~` expansion in the broker's path rules. */
  readonly home?: string | null;
  /** Injected clock for decision expiry; the runner never reads the system time itself. */
  readonly nowIso?: () => string;
  /** A decision the operator signed for one specific operation, or `null`. */
  readonly decision?: PrivilegedDecision | null;
  /** The phrase the operator supplied on this invocation's envelope, or `null`. */
  readonly operatorPhrase?: string | null;
  /** The operator keys the factory currently trusts, `keyId → publicKeyPem`. */
  readonly activeKeys?: ReadonlyMap<string, string>;

  /** The prepared checkout. Copied per run unless `copyCheckout` is false. */
  readonly cwd: string;
  /**
   * Which tree to run in for a given run, mirroring the container runner's `prepare`.
   * The wall does not know how patches are applied, so a real executor maps
   * `(baseRev, patchFile)` onto its own layout here.
   */
  readonly prepare?: (input: ScenarioRunInput) => string;
  /** Copy the tree into a temp directory before running (default true). */
  readonly copyCheckout?: boolean;
  /** Where to create the per-run temp directory. Defaults to the OS temp dir. */
  readonly tempRoot?: string;
  /** Environment for the child. Defaults to the host's, because a local runner is a convenience. */
  readonly env?: NodeJS.ProcessEnv;
  /**
   * Kill the process group on timeout (default true).
   *
   * Exposed only so a test can prove the difference; a caller has no reason to disable it.
   */
  readonly killGroupOnTimeout?: boolean;
}

/**
 * Thrown when a scenario requires isolation this runner cannot provide.
 *
 * A throw, not a result: the wall catches a throwing run and classifies it `unknown`, so a
 * refusal can never be read as a pass — but it is also not dressed up as a measurement.
 * The message names the requirement, because an operator reading the audit log needs to
 * know which isolation the wall could not deliver.
 */
/**
 * The broker refused an operation this runner was about to spawn.
 *
 * Typed separately from {@link LocalRunnerRefusal} so the wall can tell "this runner cannot
 * meet the isolation requirement" from "this command needed a person and had no decision":
 * they are both `unknown`, but only one of them is about the instrument.
 */
export class PrivilegedBrokerRefusal extends Error {
  readonly refusal: BrokerRefusal;

  constructor(refusal: BrokerRefusal) {
    super(describeRefusal(refusal));
    this.name = 'PrivilegedBrokerRefusal';
    this.refusal = refusal;
  }
}

export class LocalRunnerRefusal extends Error {
  readonly requirement: string;

  constructor(requirement: string) {
    super(
      `local runner cannot provide ${requirement}: it has no network isolation, no filesystem isolation, ` +
        'no uid separation and no read-only root — use the container runner for scenarios that need them',
    );
    this.name = 'LocalRunnerRefusal';
    this.requirement = requirement;
  }
}

/** The last valid `FACTORY_SUMMARY {...}` line, or `undefined` when the command printed none. */
export function parseSummary(output: string): SuiteSummary | undefined {
  const lines = output.split(/\r?\n/);
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    const line = lines[index];
    if (line === undefined) continue;
    const trimmed = line.trim();
    if (
      !trimmed.startsWith(SUMMARY_LINE_PREFIX.trim() + ' ') &&
      !trimmed.startsWith(SUMMARY_LINE_PREFIX)
    )
      continue;
    const payload = trimmed.slice(trimmed.indexOf(' ') + 1);
    try {
      const parsed: unknown = JSON.parse(payload);
      if (typeof parsed !== 'object' || parsed === null) continue;
      const record = parsed as Record<string, unknown>;
      const passed = record['passed'];
      const failed = record['failed'];
      const unknown = record['unknown'];
      const exitCode = record['exitCode'];
      const isCount = (value: unknown): value is number =>
        typeof value === 'number' && Number.isInteger(value) && value >= 0;
      if (!isCount(passed) || !isCount(failed) || !isCount(unknown)) continue;
      if (!(typeof exitCode === 'number' || exitCode === null)) continue;
      return { passed, failed, unknown, exitCode: exitCode as number | null };
    } catch {
      // A malformed summary line is "no summary", not a failure of the scenario: the
      // command may legitimately print the prefix in its own output.
      continue;
    }
  }
  return undefined;
}

function hashOf(chunks: readonly Buffer[]): string {
  const hash = createHash('sha256');
  for (const chunk of chunks) hash.update(chunk);
  return `sha256:${hash.digest('hex')}`;
}

const UNMEASURED = (started: number): ScenarioRunResult => ({
  exitCode: null,
  outputSha: hashOf([]),
  durationMs: Math.round(performance.now() - started),
  timedOut: false,
});

/**
 * Build the runner.
 *
 * Failures to *start* — no binary, a missing tree, a refused isolation requirement — are
 * `exitCode: null` (or a throw), never a non-zero exit code. A runner that reported
 * "could not run" as "failed" would be manufacturing evidence against the candidate.
 */
export function createLocalRunner(options: LocalRunnerOptions): ScenarioRunner {
  const copyCheckout = options.copyCheckout ?? true;
  const killGroupOnTimeout = options.killGroupOnTimeout ?? true;
  const tempRoot = options.tempRoot ?? tmpdir();

  return {
    kind: 'local',

    async run(input: ScenarioRunInput): Promise<ScenarioRunResult> {
      // Refuse before touching the filesystem: an isolation requirement this runner cannot
      // meet must not produce a partial run that looks like a measurement.
      if (input.requires === 'container') throw new LocalRunnerRefusal("requires: 'container'");
      if (input.network === 'none') throw new LocalRunnerRefusal("network: 'none'");

      // The same discipline for authority: this argv came from a receipt, i.e. from the
      // worker. A privileged operation with no recorded decision is refused *here*, before
      // a temp copy is made, so no part of it runs.
      //
      // This site stays *unconditional*: `sink: null`, a fresh `createMemoryRegistry()` per call,
      // and whatever decision the caller handed in is only ever re-verified, never consumed for
      // real. It is the replay path — it re-executes a candidate in order to measure it, and a
      // measurement must not act on what it measures. Wiring the durable registry in here would
      // mean a dry-run replay could spend the one decision the real run needs, and the operator
      // would see "already used" for an operation that never ran. The brokered launch site is the
      // one that consumes (`apps/cli/src/launch.ts` → `storeDecisionPorts`).
      if ((options.privilegedBrokering ?? 'off') === 'on') {
        // The clock is the caller's, never this package's: `evaluate.test.ts` proves that
        // `src/` contains no wall-clock read, and a default `new Date()` would break that
        // promise for the one call site where expiry actually matters.
        if (options.nowIso === undefined) {
          throw new TypeError(
            "privileged brokering needs an injected clock (`nowIso`): a decision's expiry cannot be judged by this package's own reading of the wall clock",
          );
        }
        const brokered = broker(input.argv, {
          nowIso: options.nowIso(),
          home: options.home ?? null,
          operatorPhrase: options.operatorPhrase ?? null,
          decision: options.decision ?? null,
          sink: null,
          registry: createMemoryRegistry(),
          activeKeys: options.activeKeys ?? new Map<string, string>(),
        });
        if (brokered.kind === 'refuse') throw new PrivilegedBrokerRefusal(brokered);
      }

      const started = performance.now();
      if (!Array.isArray(input.argv) || input.argv.length === 0 || input.argv[0] === '') {
        return UNMEASURED(started);
      }

      const source = options.prepare === undefined ? options.cwd : options.prepare(input);
      let runDir = source;
      let tempDir: string | null = null;

      if (copyCheckout) {
        try {
          tempDir = mkdtempSync(join(tempRoot, 'factory-local-'));
          cpSync(resolve(source), tempDir, { recursive: true, dereference: false });
        } catch {
          if (tempDir !== null) rmSync(tempDir, { recursive: true, force: true });
          return UNMEASURED(started);
        }
        runDir = tempDir;
      }

      try {
        return await new Promise<ScenarioRunResult>((resolvePromise) => {
          const out: Buffer[] = [];
          const err: Buffer[] = [];
          let timedOut = false;
          let settled = false;
          // Declared before `finish` so the start-failure path can settle without touching
          // a timer that was never created.
          let timer: ReturnType<typeof setTimeout> | null = null;
          let child: ReturnType<typeof spawn> | null = null;

          const killGroup = (): void => {
            if (child === null) return;
            const pid = child.pid;
            if (killGroupOnTimeout && pid !== undefined) {
              try {
                // Negative pid = the whole process group. The child was spawned detached,
                // so it leads one; this is what reaps grandchildren a bare `kill` leaves.
                process.kill(-pid, 'SIGKILL');
                return;
              } catch {
                // Fall through to the single-process kill below.
              }
            }
            try {
              child.kill('SIGKILL');
            } catch {
              // Already gone.
            }
          };

          const finish = (exitCode: number | null): void => {
            if (settled) return;
            settled = true;
            if (timer !== null) clearTimeout(timer);

            const stdout = Buffer.concat(out).toString('utf8');
            const summary = parseSummary(`${stdout}\n${Buffer.concat(err).toString('utf8')}`);

            // Disagreement between what the command reported and what the machine observed
            // is not a verdict: the wall's rule is that a run whose own accounts conflict is
            // unmeasured. `exitCode: null` is exactly that encoding, so the wall's judges
            // turn it into `unknown` without a new code.
            const disagrees = summary !== undefined && summary.exitCode !== exitCode;

            resolvePromise({
              exitCode: disagrees ? null : exitCode,
              // Both streams, so a runner that prints its summary to stderr is not silently
              // unmeasured — and so the hash covers everything the command said.
              outputSha: hashOf([...out, ...err]),
              durationMs: Math.round(performance.now() - started),
              timedOut,
              ...(summary === undefined || disagrees ? {} : { summary }),
            });
          };

          try {
            child = spawn(input.argv[0] as string, input.argv.slice(1), {
              cwd: runDir,
              // A group of its own, so the timeout can reap the whole tree it spawned.
              detached: true,
              stdio: ['ignore', 'pipe', 'pipe'],
              env: options.env ?? process.env,
            });
          } catch {
            finish(null);
            return;
          }

          child.stdout?.on('data', (chunk: Buffer) => out.push(chunk));
          child.stderr?.on('data', (chunk: Buffer) => err.push(chunk));
          child.on('error', () => finish(null));
          child.on('close', (code) => finish(code));

          timer = setTimeout(
            () => {
              timedOut = true;
              killGroup();
            },
            Math.max(1, input.timeoutMs),
          );
        });
      } finally {
        if (tempDir !== null) rmSync(tempDir, { recursive: true, force: true });
      }
    },
  };
}
