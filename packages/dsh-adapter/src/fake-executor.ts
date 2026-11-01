/**
 * The **fake executor**: a scripted worker, for tests only.
 *
 * `createDshExecutor` needs a pinned `dsh` binary, a docker daemon, a credential
 * proxy and a model key. That is the right shape for production and the wrong
 * shape for a test suite, which is why nothing could drive
 * `run → attempt → receipt → verdict → promotion` offline: every attempt died at
 * `EXECUTOR_UNAVAILABLE`. This module is the seam that fixes that, and it is
 * modelled on `FakeStore`: same `Executor` interface, driven by a declared
 * scenario, and impossible to reach by accident.
 *
 * ## What a scenario is
 *
 * ```jsonc
 * {
 *   "steps": [
 *     { "kind": "write", "path": "src/slug.js", "content": "module.exports = 1;\n" },
 *     { "kind": "emit", "events": [{ "type": "session", "sessionId": "s-fake" },
 *                                  { "type": "turn_end", "reason": { "kind": "completed" } }] },
 *     { "kind": "untracked", "paths": ["scratch.txt"] },
 *     { "kind": "exit", "code": 0 }
 *   ],
 *   "receipt": { "diff": { "filesChanged": 1, "insertions": 4, "deletions": 0 },
 *                "commands": [], "ceilings": { "turnsUsed": 1, "wallClockMs": 5, "hit": [] },
 *                "narrative": "wrote the check" }
 * }
 * ```
 *
 * Steps run in order: `write` (a file inside the attempt dir), `emit` (NDJSON lines
 * into `stdout.log`), `truncate` (a half-line at the tail, which the adapter's
 * splitter must report rather than swallow), `untracked` (files left behind, named
 * in `statusPaths`), `hang` (write the pid, then never resolve — so a test can
 * `SIGKILL` the process), `exit` (the worker's exit code), `replayReceipt` (return a
 * receipt read from disk verbatim, i.e. attempt to file another attempt's evidence).
 *
 * ## What it deliberately is not
 *
 * - **It does not measure.** The receipt's numeric fields are *declared* by the
 *   scenario and validated against `WorkerReceipt` before they leave — a scenario
 *   cannot produce a malformed receipt, and a caller cannot mistake this for
 *   evidence. Every attempt it produces is labelled: the receipt records
 *   `sessionId: 'fake-<attempt>'` and the CLI prints `executor: FAKE (no DSH
 *   process launched)`.
 * - **It does not run the worker.** Nothing is spawned; there is no `dsh`, no
 *   container and no network. That is what makes it a fake rather than a stub of
 *   the hard part.
 * - **It cannot be reached in production.** `probeExecutor` refuses
 *   `FACTORY_EXECUTOR=fake` when `NODE_ENV=production`, and the CLI banner fires on
 *   every command that touches it.
 *
 * The one behaviour it *does* model exactly is the refusal that matters: a worker
 * that stops without a `turn_end` has produced no evidence that a turn ever
 * finished, so the executor throws `ATTEMPT_AMBIGUOUS` rather than returning a
 * receipt that merely looks like success. `unknown` is not `failed`, and it is
 * certainly not `pass`.
 */
import {
  buildChildEnv,
  fingerprintEnv,
  forwardedCredentials,
  writeLaunchRecord,
} from './launch-record.ts';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

import { FactoryError, sha256Hex, WorkerReceipt } from '@factory/contracts';
import { broker, createMemoryRegistry, describeRefusal } from '../../proxy/src/broker.ts';
import type { z } from 'zod';

import {
  attemptRecordDir,
  type Executor,
  type LaunchContext,
  type LaunchPayload,
  type LogSink,
} from './executor.ts';

export type FakeStep =
  | { readonly kind: 'write'; readonly path: string; readonly content: string }
  /**
   * Run a command **for real** in the attempt directory and record its exit code and
   * output hash. The wall re-executes everything in `receipt.commands` and compares
   * both, so a receipt whose commands were never run is `receipt_unfaithful` — which is
   * the wall working correctly. This step is how a fake worker produces evidence that
   * survives that check without pretending to be a model.
   */
  | {
      readonly kind: 'command';
      readonly argv: readonly string[];
      readonly label?: string;
      readonly timeoutMs?: number;
    }
  | { readonly kind: 'emit'; readonly events: readonly unknown[] }
  | { readonly kind: 'truncate'; readonly line: string }
  | { readonly kind: 'untracked'; readonly paths: readonly string[] }
  | { readonly kind: 'hang'; readonly ms?: number }
  | { readonly kind: 'exit'; readonly code: number }
  | { readonly kind: 'replayReceipt'; readonly path: string };

/** The declared facts a scenario may state. Everything absent is filled with the honest absence. */
export interface FakeReceiptSpec {
  readonly filesChanged?: number;
  readonly insertions?: number;
  readonly deletions?: number;
  /** The patch body. Its hash is what the receipt reports; nothing re-applies it here. */
  readonly patch?: string;
  readonly commands?: readonly {
    readonly argv: readonly string[];
    readonly exitCode: number | null;
    readonly timedOut?: boolean;
    readonly output?: string;
    readonly durationMs?: number;
  }[];
  readonly ceilings?: {
    readonly turnsUsed?: number;
    readonly wallClockMs?: number;
    readonly hit?: readonly ('turns' | 'wall-clock' | 'tokens' | 'output-bytes')[];
  };
  readonly narrative?: string | null;
  /** Defaults to `null`, the contract's word for "not measured". */
  readonly sessionId?: string | null;
}

export interface FakeScenario {
  readonly steps: readonly FakeStep[];
  readonly receipt?: FakeReceiptSpec;
}

export interface FakeExecutorOptions {
  /**
   * Broker a `command` step's argv before spawning it.
   *
   * A scenario is a fixture *standing in for the worker*, so its `command` steps are worker
   * output: the factory is about to run an argv it did not write. With this `'on'` a
   * privileged (or unclassifiable) command fails the attempt with `GATE_REQUIRED` instead of
   * running — a scenario cannot launder a `sudo` through a green spec. Defaults to `'off'`,
   * because the fake is a test seam and the shipped qualifier policy defaults off; the CLI
   * passes the policy value (`FACTORY_PRIVILEGED_BROKERING=on`).
   */
  readonly privilegedBrokering?: 'off' | 'on';
  /** The operator's home, for `~` expansion in the broker's path rules. */
  readonly home?: string | null;
  /** Parsed scenario. `createFakeExecutorFromFile` reads one from disk. */
  readonly scenario: FakeScenario;
  /** Factory root; the attempt record is written under it, never inside the clone. */
  readonly factoryHome: string;
  /** Where the fake writes its pid before hanging, so a test can kill it precisely. */
  readonly pidFile?: string;
  log?: LogSink;
  /** Base commit the patch claims to apply to. Defaults to the payload's clone HEAD. */
  readonly baseRev?: string;
  /** Injectable clock, for deterministic receipts. */
  readonly now?: () => Date;
}

const DEFAULT_BASE_REV = '0'.repeat(40);

/** Validate a scenario before it can half-run: a typo in step 4 must not look like a worker failure. */
export function parseFakeScenario(raw: unknown): FakeScenario {
  const body = raw as Partial<FakeScenario> | null;
  if (body === null || typeof body !== 'object' || !Array.isArray(body.steps)) {
    throw new FactoryError(
      'INTERNAL',
      'fake executor: a scenario must be an object with a steps array',
    );
  }
  const steps: FakeStep[] = [];
  for (const [index, step] of body.steps.entries()) {
    const kind = (step as { kind?: unknown } | null)?.kind;
    switch (kind) {
      case 'write': {
        const { path, content } = step as { path: string; content: string };
        steps.push({ kind, path, content });
        break;
      }
      case 'command': {
        const { argv, label, timeoutMs } = step as {
          argv: readonly string[];
          label?: string;
          timeoutMs?: number;
        };
        if (!Array.isArray(argv) || argv.length === 0) {
          throw new FactoryError(
            'INTERNAL',
            `fake executor: step ${String(index)} has an empty command`,
          );
        }
        steps.push({
          kind,
          argv: [...argv],
          ...(label === undefined ? {} : { label }),
          ...(timeoutMs === undefined ? {} : { timeoutMs }),
        });
        break;
      }
      case 'emit': {
        const { events } = step as { events: unknown[] };
        steps.push({ kind, events: Array.isArray(events) ? events : [] });
        break;
      }
      case 'truncate': {
        steps.push({ kind, line: (step as { line: string }).line });
        break;
      }
      case 'untracked': {
        steps.push({ kind, paths: (step as { paths: string[] }).paths ?? [] });
        break;
      }
      case 'hang': {
        const ms = (step as { ms?: number }).ms;
        steps.push(ms === undefined ? { kind } : { kind, ms });
        break;
      }
      case 'exit': {
        steps.push({ kind, code: (step as { code: number }).code });
        break;
      }
      case 'replayReceipt': {
        steps.push({ kind, path: (step as { path: string }).path });
        break;
      }
      default:
        // Loudly, and with the index: a scenario is test input, not untrusted input,
        // and a silently skipped step would make a green spec meaningless.
        throw new FactoryError(
          'INTERNAL',
          `fake executor: step ${String(index)} has unknown kind ${JSON.stringify(kind)}`,
        );
    }
  }
  return { steps, ...(body.receipt === undefined ? {} : { receipt: body.receipt }) };
}

export function createFakeExecutorFromFile(
  path: string,
  options: Omit<FakeExecutorOptions, 'scenario'>,
): Executor {
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(path, 'utf8'));
  } catch (error) {
    throw new FactoryError(
      'INTERNAL',
      `fake executor: scenario ${path} could not be read as JSON (${error instanceof Error ? error.message : String(error)})`,
    );
  }
  return createFakeExecutor({ ...options, scenario: parseFakeScenario(raw) });
}

/** True when the emitted NDJSON contains a completed turn end — the only thing that counts as success. */
export function scenarioTurnCompleted(scenario: FakeScenario): boolean {
  for (const step of scenario.steps) {
    if (step.kind !== 'emit') continue;
    for (const event of step.events) {
      const record = event as {
        type?: unknown;
        phase?: unknown;
        reason?: { kind?: unknown };
      } | null;
      const isTurnEnd =
        record?.type === 'turn_end' || (record?.type === 'status' && record.phase === 'turn_end');
      if (isTurnEnd && record?.reason?.kind === 'completed') return true;
    }
  }
  return false;
}

export function createFakeExecutor(options: FakeExecutorOptions): Executor {
  const now = options.now ?? ((): Date => new Date());
  const { scenario } = options;

  return {
    kind: 'launch',
    async run(payload: LaunchPayload, ctx: LaunchContext): Promise<z.infer<typeof WorkerReceipt>> {
      const startedAt = now().toISOString();
      const recordDir = attemptRecordDir(options.factoryHome, payload.unitId, payload.attemptId);
      mkdirSync(recordDir, { recursive: true });
      // The checkout is the caller's job (`createAttemptClone` in `run`). The fake
      // does not create it: a worker that invents its own tree is exactly the thing
      // the clone exists to prevent, and a scenario that silently made one would hide
      // a missing clone step behind a green test.
      if (!existsSync(payload.attemptDir)) {
        throw new FactoryError(
          'EXECUTOR_UNAVAILABLE',
          `fake executor: the attempt directory ${payload.attemptDir} does not exist; ` +
            'the caller must create the clone before launching',
          { attemptDir: payload.attemptDir },
        );
      }

      // The scripted worker stands in for a real one, so it gets the same allowlist a real
      // worker would: a scenario that could read `FACTORY_HOLDOUT_ROOT` would be a hole in
      // the harness rather than a property of the product.
      const dropped: string[] = [];
      const childEnv = buildChildEnv(
        join(options.factoryHome, 'dsh-home', 'attempts', payload.attemptId),
        process.env,
        (name) => dropped.push(name),
      );
      // The same record the real executor writes, with the fields it cannot have set to
      // `null`: no DSH home was seeded, no overlay was composed, and saying so is a fact.
      writeLaunchRecord(recordDir, {
        schema: 'launch/1',
        recordedAt: startedAt,
        effectId: ctx.effectId,
        attempt: ctx.attempt,
        unitId: payload.unitId,
        attemptId: payload.attemptId,
        argv: ['<fake-executor>', `scenario:${String(scenario.steps.length)} steps`],
        cwd: payload.attemptDir,
        mountedAt: payload.attemptDir,
        dshHome: null,
        profile: { requested: 'fake', effective: null },
        overlay: { path: null, sha256: null },
        // The marker the fake adds is recorded too: the worker must be able to tell it is
        // scripted, and the record must not describe an environment that never existed.
        env: fingerprintEnv({ ...childEnv, FACTORY_FAKE_WORKER: '1' }, dropped),
        // The scripted worker spends nothing, so it forwards nothing: the flag is a
        // permission, not an instruction, and recording it here would overstate the run.
        credentialsForwarded: forwardedCredentials(process.env),
      });

      const events: string[] = [];
      const ran: {
        argv: string[];
        cwd: string;
        exitCode: number | null;
        timedOut: boolean;
        output: string;
        durationMs: number;
      }[] = [];
      let exitCode: number | null = 0;
      let truncateLine: string | null = null;
      let untracked: string[] = [];
      let replayed: unknown = null;

      for (const step of scenario.steps) {
        switch (step.kind) {
          case 'write': {
            const target = join(payload.attemptDir, step.path);
            mkdirSync(dirname(target), { recursive: true });
            writeFileSync(target, step.content);
            break;
          }
          case 'command': {
            if ((options.privilegedBrokering ?? 'off') === 'on') {
              const brokered = broker(step.argv, {
                nowIso: (options.now?.() ?? new Date()).toISOString(),
                home: options.home ?? null,
                operatorPhrase: null,
                decision: null,
                sink: null,
                registry: createMemoryRegistry(),
                activeKeys: new Map<string, string>(),
              });
              if (brokered.kind === 'refuse') {
                // Fail the attempt rather than the step: a refused operation is not a command
                // that ran and exited 1, and the receipt must not claim it did.
                throw new FactoryError('GATE_REQUIRED', describeRefusal(brokered), {
                  argv: [...step.argv],
                  matchedRule: brokered.matchedRule,
                });
              }
            }
            const started = Date.now();
            const result = spawnSync(step.argv[0] as string, step.argv.slice(1), {
              cwd: payload.attemptDir,
              encoding: 'utf8',
              timeout: step.timeoutMs ?? 120_000,
              env: { ...childEnv, FACTORY_FAKE_WORKER: '1' },
            });
            ran.push({
              argv: [...step.argv],
              cwd: payload.attemptDir,
              exitCode: result.status,
              timedOut: result.signal !== null || result.error !== undefined,
              output: `${result.stdout ?? ''}${result.stderr ?? ''}`,
              durationMs: Date.now() - started,
            });
            break;
          }
          case 'emit': {
            for (const event of step.events) events.push(JSON.stringify(event));
            break;
          }
          case 'truncate': {
            truncateLine = step.line;
            break;
          }
          case 'untracked': {
            untracked = [...step.paths];
            for (const path of step.paths) {
              const target = join(payload.attemptDir, path);
              mkdirSync(dirname(target), { recursive: true });
              writeFileSync(target, 'left behind by the worker\n');
            }
            break;
          }
          case 'hang': {
            const pidPath = options.pidFile ?? join(recordDir, 'fake.pid');
            mkdirSync(dirname(pidPath), { recursive: true });
            writeFileSync(pidPath, `${String(process.pid)}\n`);
            options.log?.warn({ attemptId: payload.attemptId, pidPath }, 'fake executor hanging');
            await new Promise<void>((resolve) => {
              // A cap so an unattended run cannot hang forever; a test that wants
              // the kill does it well inside this window.
              setTimeout(resolve, step.ms ?? 60_000);
            });
            break;
          }
          case 'exit': {
            exitCode = step.code;
            break;
          }
          case 'replayReceipt': {
            replayed = JSON.parse(readFileSync(step.path, 'utf8'));
            break;
          }
        }
      }

      // ---- the receipt ------------------------------------------------------
      const stdoutText = `${events.join('\n')}${events.length === 0 ? '' : '\n'}`;
      const logText = truncateLine === null ? stdoutText : `${stdoutText}${truncateLine}`;
      writeFileSync(join(recordDir, 'stdout.log'), logText);
      writeFileSync(
        join(recordDir, 'stderr.log'),
        'this run was produced by the fake executor; no dsh process was launched\n',
      );

      if (replayed !== null) {
        // The point of the step: hand back someone else's evidence and let the
        // engine decide. No receipt is invented here.
        return replayed as z.infer<typeof WorkerReceipt>;
      }

      if (!scenarioTurnCompleted(scenario)) {
        // Exit 0 without a completed turn is the exact case that must never read as
        // success. It is ambiguous: the attempt ran, and nothing vouched for it.
        throw new FactoryError(
          'ATTEMPT_AMBIGUOUS',
          `attempt ${payload.attemptId} ended (exit ${String(exitCode)}) without a \`turn_end\` reason ` +
            '"completed"; the outcome was never observed, so it is ambiguous, not failed',
          {
            attemptId: payload.attemptId,
            unitId: payload.unitId,
            effectId: ctx.effectId,
            exitCode,
          },
        );
      }

      const declared = scenario.receipt ?? {};
      const baseRev = options.baseRev ?? DEFAULT_BASE_REV;

      // ---- the patch and the diff, measured from the tree when it is a checkout ----
      //
      // A declared patch would let a scenario describe a change the tree does not
      // contain, and the wall's `diffNonEmpty`/scope checks read exactly this. So when
      // the attempt directory is a git checkout the fake stages the worker's edits and
      // takes the real diff; only a non-git directory falls back to what was declared.
      let patch = declared.patch ?? '';
      let filesChanged = declared.filesChanged ?? 0;
      let insertions = declared.insertions ?? 0;
      let deletions = declared.deletions ?? 0;
      let statusPaths = untracked;
      if (existsSync(join(payload.attemptDir, '.git'))) {
        const git = (args: readonly string[]): string => {
          const result = spawnSync('git', [...args], {
            cwd: payload.attemptDir,
            encoding: 'utf8',
            env: process.env,
          });
          return result.status === 0 ? (result.stdout ?? '') : '';
        };
        git(['add', '-A']);
        const measuredPatch = git(['diff', '--cached', '--binary', baseRev]);
        if (measuredPatch.trim() !== '') {
          patch = measuredPatch;
          const stat = git(['diff', '--cached', '--numstat', baseRev]);
          let files = 0;
          let added = 0;
          let removed = 0;
          for (const line of stat.split('\n')) {
            const [a, d] = line.split('\t');
            if (a === undefined || d === undefined) continue;
            files += 1;
            added += a === '-' ? 0 : Number(a);
            removed += d === '-' ? 0 : Number(d);
          }
          filesChanged = files;
          insertions = added;
          deletions = removed;
        }
        // Anything `git status` still reports is work the *patch* does not describe.
        // The patch is what the wall replays, so a path it covers is not outstanding;
        // listing it again would tell the operator about a discrepancy that is not one.
        const patchPaths = new Set<string>();
        for (const line of git(['diff', '--cached', '--name-only', baseRev]).split('\n')) {
          const path = line.trim();
          if (path !== '') patchPaths.add(path);
        }
        const porcelain = git(['status', '--porcelain', '--untracked-files=all']);
        statusPaths = porcelain
          .split('\n')
          .map((line) => line.replace(/^..\s+/, '').trim())
          .filter((line) => line !== '' && !patchPaths.has(line));
      }

      const patchFile = join(recordDir, 'attempt.patch');
      writeFileSync(patchFile, patch);

      const commands = [
        ...ran.map((command) => ({
          argv: command.argv,
          cwd: command.cwd,
          exitCode: command.exitCode,
          timedOut: command.timedOut,
          outputSha: `sha256:${sha256Hex(command.output)}`,
          durationMs: command.durationMs,
        })),
        ...(declared.commands ?? []).map((command) => ({
          argv: [...command.argv],
          cwd: payload.attemptDir,
          exitCode: command.exitCode,
          timedOut: command.timedOut ?? false,
          outputSha: `sha256:${sha256Hex(command.output ?? '')}`,
          durationMs: command.durationMs ?? 0,
        })),
      ];

      const receipt = {
        unitId: payload.unitId,
        attemptId: payload.attemptId,
        // Named, not hidden: an operator reading the ledger sees which executor ran.
        sessionId: declared.sessionId ?? `fake-${payload.attemptId}`,
        startedAt,
        endedAt: now().toISOString(),
        exitCode,
        diff: {
          patchFile,
          sha: `sha256:${sha256Hex(patch)}`,
          filesChanged,
          insertions,
          deletions,
          baseRev,
          ...(statusPaths.length === 0 ? {} : { statusPaths }),
        },
        commands,
        // `null` is "not measured" and is the only honest answer here: the fake
        // does not run a test suite.
        suite: null,
        ceilings: {
          turnsUsed: declared.ceilings?.turnsUsed ?? 0,
          wallClockMs: declared.ceilings?.wallClockMs ?? 0,
          hit: [...(declared.ceilings?.hit ?? [])],
        },
        artifacts: [],
        narrative: declared.narrative ?? null,
      };

      const validated = WorkerReceipt.safeParse(receipt);
      if (!validated.success) {
        throw new FactoryError(
          'INTERNAL',
          'fake executor: declared receipt failed its own schema',
          {
            issues: validated.error.issues,
          },
        );
      }
      // Written beside the record as well as returned, so a scenario can name this
      // attempt's evidence and try to file it against another one (`replayReceipt`).
      writeFileSync(
        join(recordDir, 'receipt.json'),
        `${JSON.stringify(validated.data, null, 2)}\n`,
      );
      options.log?.info(
        {
          attemptId: payload.attemptId,
          effectId: ctx.effectId,
          filesChanged: receipt.diff.filesChanged,
        },
        'fake attempt finished',
      );
      return validated.data;
    },
  };
}
