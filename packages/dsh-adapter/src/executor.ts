/**
 * The DSH launch effect: one attempt in, one `WorkerReceipt` out.
 *
 * The receipt is the whole point. It is assembled from **mechanical facts the
 * factory itself observed** — exit code, git revisions, diff hash, command
 * argv/exit/duration/output-hash, which ceiling tripped — and never from what
 * the model claimed it did (`receipt.ts` L1). The model's last message is kept
 * in `narrative`, which the type system strips before any verifier can see it.
 *
 * ## Layout (post-amendment A3 of `consensus-plan.md`)
 *
 * ```
 * <attemptDir>                        the CLONE. Bind-mounted at this same
 *   .git/                             absolute path inside the container, so git
 *   …checkout…                        works in both worlds and DSH's cwd-keyed
 *                                     session slug matches. Not one factory file
 *                                     is written here, or every patch would
 *                                     describe its own artefacts.
 *
 * <factoryHome>/attempts/<unit>/<attempt>/   the attempt record. Never mounted.
 *   task.md  dsh-overlay.yml  attempt.patch
 *   stdout.log  stderr.log  tool-calls.jsonl  launch.json  session/**
 *
 * <factoryHome>/dsh-home/<domain>/profiles/<profile>/   provisioned template, read-only
 * <factoryHome>/dsh-home/attempts/<attempt>/            this attempt's DSH_HOME, destroyed after
 * ```
 *
 * ## Two rules this file exists to enforce
 *
 * - **A receipt is mandatory.** A killed attempt, a crashed attempt and a failed
 *   attempt all produce one: `exitCode: null`, the tripped ceiling named, the
 *   patch captured anyway.
 * - **No credential ever enters the child.** The child environment is an
 *   allowlist; `BIFROST_API_KEY` is not in it. The credential proxy injects the
 *   real header, so the worker has nothing worth stealing.
 */

import { spawn } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { performance } from 'node:perf_hooks';

import {
  ArtifactRecord,
  Ceilings,
  CommandRecord,
  DiffRecord,
  FactoryError,
  sha256Hex,
  WorkerReceipt,
} from '@factory/contracts';
import type { z } from 'zod';

import { assertSelfContainedClone } from './clone.ts';
import { attemptHomePath, destroyAttemptHome, readOutSession, seedAttemptHome } from './home.ts';
import { createLineSplitter, parseHeadlessStream } from './ndjson.ts';
import {
  type CommandProvenance,
  buildChildEnv,
  effectiveProfile,
  FACTORY_VERIFICATION_PROVENANCE,
  WORKER_LAUNCH_PROVENANCE,
  fingerprintEnv,
  forwardedCredentials,
  hashOverlay,
  writeLaunchRecord,
} from './launch-record.ts';
import { buildOverlay } from './overlay.ts';

// Re-exported for callers that import it from the executor (the public API predates the
// launch-record module). The definition lives with the record now, because the allowlist and
// the record are the same decision seen twice: what the worker may see, and what we admit.
export { buildChildEnv, CREDENTIAL_NAME } from './launch-record.ts';
import { createWatchdog, killProcessGroup, type WatchdogCeiling } from './watchdog.ts';

type ArtifactValue = z.infer<typeof ArtifactRecord>;
type CeilingsValue = z.infer<typeof Ceilings>;
type CommandValue = z.infer<typeof CommandRecord>;
type DiffValue = z.infer<typeof DiffRecord>;

/** The prompt file the caller prepares in the attempt record directory. */
export const TASK_FILE = 'task.md';

/**
 * Default ceilings, used when the caller does not supply its own.
 *
 * 15 minutes is generous for one unit and still bounded; 8 MiB of projection
 * stream is far beyond a healthy run and small enough to hold in memory.
 */
export const DEFAULT_WALL_CLOCK_MS = 15 * 60 * 1000;
export const DEFAULT_MAX_OUTPUT_BYTES = 8 * 1024 * 1024;

/** `WorkerReceipt.narrative` is capped at 200k characters by the contract. */
const MAX_NARRATIVE_CHARS = 200_000;

/**
 * The `dsh` build every fact in this package was established against.
 *
 * The overlay schema, the `--json` event shapes and the `turn_end` reason kinds
 * are all version-specific: 0.2.1-alpha.4 and 0.2.1-rc.3 already disagree about
 * how a turn end is delivered, and the registry carries newer builds. Running an
 * unpinned harness would mean producing receipts from a contract nobody verified.
 *
 * The pin lives here until `packages/contracts/src/dsh-version.ts` exists; the
 * `expectedVersion` option is the seam for wiring that in without touching callers.
 */
export const PINNED_DSH_VERSION = '0.2.1-rc.3';

/**
 * The custom profile every attempt boots.
 *
 * Not the shipped `headless` profile: `scripts/provision-dsh-home.sh` freezes a
 * copy of it at provisioning time, so upgrading DSH cannot silently change how a
 * worker runs. Provisioning is a hard prerequisite, and its absence must fail
 * with something an operator can act on — DSH's own failure is a node stack trace
 * recommending `dsh plugin --profile … add <package>`, which is the wrong remedy.
 */
export const DSH_PROFILE = 'factory-worker';

/** Ids become path segments in the attempt record, so they must be inert. */
const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

/** Minimal structural logger, so a pino logger satisfies it without importing pino. */
export interface LogSink {
  info(fields: Record<string, unknown>, message?: string): void;
  warn(fields: Record<string, unknown>, message?: string): void;
  error(fields: Record<string, unknown>, message?: string): void;
}

export interface LaunchPayload {
  attemptId: string;
  unitId: string;
  /** The clone. Created by `createAttemptClone`; must be self-contained. */
  attemptDir: string;
}

export interface LaunchContext {
  /** The effect id this launch belongs to, for tracing into the ledger. */
  effectId: string;
  /** Zero-based attempt ordinal for the unit. */
  attempt: number;
}

/**
 * The launch effect handler.
 *
 * Amendment A3.1 replaces this with `start`/`adopt`/`observe`/`terminate`/
 * `collect` so an attempt can be re-acquired after a control-plane restart. That
 * is a port change with callers above this package, so it is not made here: this
 * is the one-shot launch form, and `attemptRecordDir` + `attemptHomePath` already
 * derive every fact `adopt()` would need from an `AttemptIdentity`.
 */
export interface Executor {
  readonly kind: 'launch';
  run(payload: LaunchPayload, ctx: LaunchContext): Promise<WorkerReceipt>;
}

export interface DshExecutorOptions {
  /** Absolute path to the pinned `dsh` binary. */
  dshBin: string;
  /** Factory root: the record, template home and per-attempt home all live here. */
  factoryHome: string;
  /** The credential proxy's Anthropic-compatible base URL. */
  proxyBaseUrl: string;
  /** The per-role model id the proxy routes on. */
  modelId: string;
  log: LogSink;
  /** Overrides {@link DEFAULT_WALL_CLOCK_MS}. */
  wallClockMs?: number;
  /** Overrides {@link DEFAULT_MAX_OUTPUT_BYTES}. */
  maxOutputBytes?: number;
  /** Parent environment to allowlist from. Defaults to `process.env`; injectable for tests. */
  parentEnv?: NodeJS.ProcessEnv;
  /** The exact `dsh --version` this adapter may talk to. Defaults to {@link PINNED_DSH_VERSION}. */
  expectedVersion?: string;
  /** The provisioned profile to boot. Defaults to {@link DSH_PROFILE}. */
  profile?: string;
  /** Provider API shape for the overlay. Defaults to `'anthropic-messages'`. */
  modelApi?: 'anthropic-messages' | 'openai-completions';
}

/** A command the factory itself ran, captured for the receipt. */
interface Captured {
  argv: string[];
  cwd: string;
  exitCode: number | null;
  outputSha: string;
  durationMs: number;
  stdout: string;
  stderr: string;
}

/**
 * The attempt record directory: everything the factory writes about an attempt.
 *
 * Outside the clone on purpose. With the attempt directory being the git checkout
 * and the only mount, a patch or log written inside it would appear as an
 * untracked change in the very patch being taken — a receipt that describes
 * itself. Ids are validated because they become path segments here.
 */
export function attemptRecordDir(root: string, unitId: string, attemptId: string): string {
  for (const [what, value] of [
    ['unitId', unitId],
    ['attemptId', attemptId],
  ] as const) {
    if (!SAFE_ID.test(value)) {
      throw new FactoryError(
        'INTERNAL',
        `unsafe ${what} for a path segment: ${JSON.stringify(value)}`,
      );
    }
  }
  return join(root, 'attempts', unitId, attemptId);
}

/** Run one command to completion and capture everything the receipt needs. */
async function captured(argv: string[], cwd: string, env?: NodeJS.ProcessEnv): Promise<Captured> {
  const started = performance.now();
  return await new Promise<Captured>((resolve, reject) => {
    const child = spawn(argv[0] ?? '', argv.slice(1), {
      cwd,
      ...(env === undefined ? {} : { env }),
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout?.on('data', (chunk: Buffer) => {
      stdout += chunk.toString('utf8');
    });
    child.stderr?.on('data', (chunk: Buffer) => {
      stderr += chunk.toString('utf8');
    });
    child.once('error', reject);
    child.once('close', (code) => {
      resolve({
        argv,
        cwd,
        exitCode: code,
        outputSha: `sha256:${sha256Hex(stdout + stderr)}`,
        durationMs: Math.max(0, Math.round(performance.now() - started)),
        stdout,
        stderr,
      });
    });
  });
}

function toCommandRecord(
  c: Captured,
  provenance: CommandProvenance,
): CommandValue & CommandProvenance {
  return {
    // `argv` must have at least one non-empty element; an empty argv is a bug, and
    // a placeholder is more useful in a receipt than a schema failure.
    argv: c.argv.length > 0 ? c.argv : ['(empty)'],
    cwd: c.cwd,
    exitCode: c.exitCode,
    timedOut: false,
    outputSha: c.outputSha,
    durationMs: c.durationMs,
    // Provenance is emitted even while the receipt contract is still being widened: the fields
    // are stripped by `WorkerReceipt.safeParse` until `CommandRecord` carries them, and the same
    // table is written into `launch.json` below so the wall can read it today.
    ...provenance,
  };
}

function writeArtifact(path: string, body: string, kind: ArtifactValue['kind']): ArtifactValue {
  writeFileSync(path, body, { mode: 0o600 });
  return {
    path,
    sha: `sha256:${sha256Hex(body)}`,
    bytes: Buffer.byteLength(body, 'utf8'),
    kind,
  };
}

export function createDshExecutor(options: DshExecutorOptions): Executor {
  const { dshBin, factoryHome, proxyBaseUrl, modelId, log } = options;
  const wallClockMs = options.wallClockMs ?? DEFAULT_WALL_CLOCK_MS;
  const maxOutputBytes = options.maxOutputBytes ?? DEFAULT_MAX_OUTPUT_BYTES;
  const parentEnv = options.parentEnv ?? process.env;
  const expectedVersion = options.expectedVersion ?? PINNED_DSH_VERSION;
  const profile = options.profile ?? DSH_PROFILE;
  // Probed once per executor: the binary cannot change underneath a running
  // control plane, and a probe per attempt would be a needless subprocess.
  let versionVerified = false;

  return {
    kind: 'launch',

    async run(payload: LaunchPayload, ctx: LaunchContext): Promise<WorkerReceipt> {
      if (!Number.isInteger(ctx.attempt) || ctx.attempt < 0) {
        throw new FactoryError('INTERNAL', 'attempt ordinal must be a non-negative integer');
      }
      const attemptDir = payload.attemptDir;
      // The clone must be usable from a single mount before anything else is spent
      // on the attempt. A `.git` file here would fail only inside the container, as
      // an unexplained git error mid-run.
      assertSelfContainedClone(attemptDir);

      const recordDir = attemptRecordDir(factoryHome, payload.unitId, payload.attemptId);
      mkdirSync(recordDir, { recursive: true });

      const taskPath = join(recordDir, TASK_FILE);
      let prompt: string;
      try {
        prompt = readFileSync(taskPath, 'utf8');
      } catch {
        throw new FactoryError(
          'EXECUTOR_UNAVAILABLE',
          `attempt record has no ${TASK_FILE}; the caller must prepare the prompt`,
          { recordDir },
        );
      }
      if (prompt.trim() === '') {
        throw new FactoryError('EXECUTOR_UNAVAILABLE', `${TASK_FILE} is empty`, { recordDir });
      }

      // A fresh home per attempt, seeded from the frozen template. This is the
      // volume A13 describes; destroying it is what stops attempt N from
      // configuring attempt N+1 through the home patch layer.
      const home = seedAttemptHome({ root: factoryHome, attemptId: payload.attemptId, profile });

      const dropped: string[] = [];
      const env = buildChildEnv(home, parentEnv, (name) => {
        dropped.push(name);
      });

      // Refuse to dispatch to an unverified harness, before the base revision is
      // read: a mismatched binary must leave no trace of an attempt.
      if (!versionVerified) {
        const probe = await captured([dshBin, '--version'], attemptDir, env);
        const actual = probe.stdout.trim();
        if (probe.exitCode !== 0) {
          throw new FactoryError(
            'EXECUTOR_UNAVAILABLE',
            `cannot read the dsh version from ${dshBin}`,
            { exitCode: probe.exitCode, stderr: probe.stderr.slice(0, 2000) },
          );
        }
        if (actual !== expectedVersion) {
          throw new FactoryError(
            'DSH_VERSION_MISMATCH',
            `dsh is ${actual || '(unreadable)'}, the adapter is pinned to ${expectedVersion}`,
            { dshBin, expected: expectedVersion, actual },
          );
        }
        versionVerified = true;
      }

      // The base revision is captured *before* the run, because it is the commit
      // the patch must apply to (`DiffRecord.baseRev`). Capturing it afterwards
      // would rebase the patch onto whatever the agent committed, and an agent
      // that commits everything would produce an empty diff.
      const baseRevCmd = await captured(['git', 'rev-parse', 'HEAD'], attemptDir);
      const baseRev = baseRevCmd.stdout.trim();
      if (baseRevCmd.exitCode !== 0 || !/^[0-9a-f]{40}$/.test(baseRev)) {
        throw new FactoryError(
          'EXECUTOR_UNAVAILABLE',
          'checkout HEAD is not a readable 40-hex commit; a patch would have no base',
          { attemptDir, stderr: baseRevCmd.stderr.slice(0, 2000) },
        );
      }

      const overlay = buildOverlay({
        attemptDir,
        proxyBaseUrl,
        modelId,
        ...(options.modelApi === undefined ? {} : { api: options.modelApi }),
      });
      const overlayPath = join(recordDir, 'dsh-overlay.yml');
      writeFileSync(overlayPath, overlay, { mode: 0o600 });

      const argv = [dshBin, '--profile', profile, '--patch', overlayPath, '--json', prompt];
      if (dropped.length > 0) {
        // Never the value, only the name: the log is not a place for secrets either.
        log.warn(
          { dropped: [...dropped], effectId: ctx.effectId },
          'dropped credential-shaped env vars from the worker environment',
        );
      }

      const startedAt = new Date().toISOString();
      // What the worker was given, written next to the receipt: the argv (prompt by size, not
      // content), the directory it ran in, the profile the home actually holds, the overlay
      // hash, and the child environment as keys plus value hashes. E2E-33 reads this file.
      const launchPath = writeLaunchRecord(recordDir, {
        schema: 'launch/1',
        recordedAt: startedAt,
        effectId: ctx.effectId,
        attempt: ctx.attempt,
        unitId: payload.unitId,
        attemptId: payload.attemptId,
        // The prompt itself is not evidence about the boundary, and it can be large: the
        // record keeps its size, which is what distinguishes "no prompt" from "a prompt".
        argv: [...argv.slice(0, -1), `<prompt ${String(Buffer.byteLength(prompt, 'utf8'))} bytes>`],
        cwd: attemptDir,
        // The clone path is recorded twice on purpose: it must equal the container mount
        // target, and that equality is what makes session adoption work after a restart.
        mountedAt: attemptDir,
        dshHome: home,
        profile: { requested: profile, effective: effectiveProfile(home) },
        overlay: { path: overlayPath, sha256: hashOverlay(overlay) },
        env: fingerprintEnv(env, dropped),
        credentialsForwarded: forwardedCredentials(parentEnv),
      });
      // Read back rather than re-serialise: the receipt's artifact hash must describe the
      // bytes on disk, and two independent serialisations could drift apart silently.
      const launchBody = readFileSync(launchPath, 'utf8');

      const splitter = createLineSplitter();
      const stdoutLines: string[] = [];
      let stderrText = '';
      let stderrTruncated = false;
      let killedBy: WatchdogCeiling | null = null;

      const started = performance.now();
      const child = spawn(argv[0] ?? '', argv.slice(1), {
        // The checkout itself: sandbox root, mount target and cwd are one path, so
        // paths in output do not shift between host and container.
        cwd: attemptDir,
        env,
        stdio: ['ignore', 'pipe', 'pipe'],
        // Group leader, so a kill reaches grandchildren. See watchdog.ts.
        detached: process.platform !== 'win32',
      });

      const watchdog = createWatchdog({
        wallClockMs,
        maxOutputBytes,
        onTrip: (ceiling) => {
          killedBy = ceiling;
          log.warn(
            { ceiling, effectId: ctx.effectId, attemptId: payload.attemptId, pid: child.pid },
            'ceiling tripped; killing the process group',
          );
          if (child.pid !== undefined) killProcessGroup(child.pid, 'SIGKILL');
        },
      });

      // Decode through a StringDecoder rather than calling `toString('utf8')` on
      // each chunk: chunk boundaries land wherever the kernel put them, and a
      // character split across two chunks decodes to U+FFFD on both sides.
      child.stdout?.setEncoding('utf8');
      child.stderr?.setEncoding('utf8');
      child.stdout?.on('data', (chunk: string) => {
        watchdog.feed(Buffer.byteLength(chunk, 'utf8'));
        for (const line of splitter.push(chunk)) stdoutLines.push(line);
      });
      child.stderr?.on('data', (chunk: string) => {
        // stderr is bounded by truncation, not by a kill: verbose diagnostics are
        // not the runaway this defends against, and losing them entirely would
        // make a failure unexplainable.
        if (stderrTruncated) return;
        stderrText += chunk;
        if (stderrText.length > maxOutputBytes) {
          stderrText = stderrText.slice(0, maxOutputBytes);
          stderrTruncated = true;
        }
      });

      const exit = await new Promise<{ code: number | null; signal: NodeJS.Signals | null }>(
        (resolve, reject) => {
          child.once('error', (cause) => {
            watchdog.stop();
            reject(
              new FactoryError('EXECUTOR_UNAVAILABLE', `cannot spawn ${dshBin}: ${cause.message}`, {
                attemptDir,
              }),
            );
          });
          child.once('close', (code, signal) => {
            resolve({ code, signal });
          });
        },
      );
      watchdog.stop();
      const wallClockUsedMs = Math.max(0, Math.round(performance.now() - started));
      for (const line of splitter.flush()) stdoutLines.push(line);

      const stdoutText = stdoutLines.length === 0 ? '' : `${stdoutLines.join('\n')}\n`;
      const parsed = parseHeadlessStream(stdoutLines);

      // A degraded permission service is a silent failure mode, so it fails the
      // attempt loudly instead. This is the `did not activate` guard from the
      // integration probe: a two-entry overlay composes a sandbox/approval pair
      // that matches no preset, and DSH reports it on stderr while still running.
      if (/did not activate/.test(stderrText)) {
        destroyAttemptHome(home);
        throw new FactoryError(
          'EXECUTOR_UNAVAILABLE',
          'the dsh overlay did not activate every entry; refusing to report a run from a degraded profile',
          { recordDir, stderr: stderrText.slice(0, 4000) },
        );
      }

      // ---- capture the diff, on every exit path -----------------------------
      const diff = await captureDiff(recordDir, attemptDir, baseRev, log);

      // ---- artefacts --------------------------------------------------------
      const artifacts: ArtifactValue[] = [
        writeArtifact(join(recordDir, 'stdout.log'), stdoutText, 'log'),
        writeArtifact(join(recordDir, 'stderr.log'), stderrText, 'log'),
        writeArtifact(join(recordDir, 'tool-calls.jsonl'), toolCallLog(stdoutLines), 'log'),
        writeArtifact(launchPath, launchBody, 'other'),
        {
          path: overlayPath,
          sha: `sha256:${sha256Hex(overlay)}`,
          bytes: Buffer.byteLength(overlay, 'utf8'),
          kind: 'other',
        },
      ];
      if (diff.ignoredPaths !== '') {
        // A write to a gitignored path is invisible to the diff and to the
        // untracked list (A3.5, verified: `git status --porcelain` hides `!!`).
        // The adapter records the fact; whether it is `receipt_unfaithful` or `lit`
        // is the verification plane's call, not this package's.
        artifacts.push(
          writeArtifact(join(recordDir, 'ignored-paths.txt'), diff.ignoredPaths, 'other'),
        );
      }

      // ---- read the session log out, then destroy the home (A13) ------------
      const readout = readOutSession(home, join(recordDir, 'session'));
      for (const file of readout) {
        artifacts.push({
          path: file.path,
          sha: `sha256:${sha256Hex(readFileSync(file.path))}`,
          bytes: file.bytes,
          kind: 'log',
        });
      }
      destroyAttemptHome(home);

      const hit: WatchdogCeiling[] = killedBy === null ? [] : [killedBy];
      const ceilings: CeilingsValue = {
        turnsUsed: parsed.turnsUsed,
        wallClockMs: wallClockUsedMs,
        hit,
      };

      // `commands[]` is FORENSIC ONLY. The wall owns the oracle and re-executes
      // its own commands (amendment A4.1); nothing here is an acceptance path.
      const commands: (CommandValue & CommandProvenance)[] = [
        toCommandRecord(
          {
            argv,
            cwd: attemptDir,
            exitCode: exit.code,
            outputSha: `sha256:${sha256Hex(stdoutText + stderrText)}`,
            durationMs: wallClockUsedMs,
            stdout: stdoutText,
            stderr: stderrText,
          },
          WORKER_LAUNCH_PROVENANCE,
        ),
        ...diff.commands,
      ];
      // `CommandRecord` now carries provenance, so these records reach the wall through the
      // receipt itself. The sidecar stays as a forensic copy for a reader without the ledger — the
      // wall does not read it, and nothing here depends on it existing.
      writeFileSync(
        join(recordDir, 'command-provenance.json'),
        `${JSON.stringify(
          commands.map((command, index) => ({
            index,
            source: command.source,
            replayable: command.replayable,
            ...(command.replaySkipReason === undefined
              ? {}
              : { replaySkipReason: command.replaySkipReason }),
          })),
          null,
          2,
        )}\n`,
        { mode: 0o600 },
      );

      const narrative =
        parsed.finalText === null ? null : parsed.finalText.slice(0, MAX_NARRATIVE_CHARS);

      const receipt: z.infer<typeof WorkerReceipt> = {
        unitId: payload.unitId,
        attemptId: payload.attemptId,
        // A run killed before the session event has no id. `'none'` is an honest
        // absence, not a fabricated identifier.
        sessionId: parsed.sessionId ?? 'none',
        startedAt,
        endedAt: new Date().toISOString(),
        // Verbatim. `null` means the process died to a signal, which is exactly
        // what a ceiling trip does.
        exitCode: exit.code,
        diff: diff.record,
        commands,
        // v1 does not parse test-runner output; the wall re-executes the patch in
        // 9c and derives the suite result there. `null` is the contract's word for
        // "not measured", and `unknown` never satisfies a gate.
        suite: null,
        ceilings,
        artifacts,
        narrative,
      };

      // Validate before returning: a receipt that does not parse is not a
      // receipt, and a caller must never be able to store an invalid one.
      const validated = WorkerReceipt.safeParse(receipt);
      if (!validated.success) {
        throw new FactoryError('INTERNAL', 'assembled receipt failed its own schema', {
          issues: validated.error.issues,
        });
      }
      log.info(
        {
          effectId: ctx.effectId,
          attemptId: payload.attemptId,
          exitCode: receipt.exitCode,
          ok: parsed.ok,
          truncated: parsed.truncated,
          malformed: parsed.malformed.length,
          hit,
          filesChanged: receipt.diff.filesChanged,
          sessionFiles: readout.length,
        },
        'dsh attempt finished',
      );
      return receipt;
    },
  };
}

/** `DiffRecord.statusPaths` is capped by the contract at this many entries. */
const MAX_STATUS_PATHS = 4096;

/**
 * Turn `git status --porcelain=v1` into the paths the patch does not contain.
 *
 * The wall uses this to tell "changed nothing" from "did work it never staged"
 * (`packages/wall/README.md` §4). Two rules matter:
 *
 * - a path the patch already describes is **not** listed — otherwise every
 *   successful capture would claim untracked work and the check would fire on
 *   every honest attempt;
 * - ignored paths are not listed either. They are not part of the tree the patch
 *   describes, and A3.5 records them separately in `ignored-paths.txt`.
 *
 * A rename is reported by git as `old -> new`; the patch's numstat spells it
 * `{old => new}` and so will not match. Since the wall only consults this list
 * when the diff is empty, a rename appearing here cannot change a verdict.
 */
export function statusPathsFrom(porcelain: string, patchPaths: ReadonlySet<string>): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const raw of porcelain.split('\n')) {
    // Two status columns, a space, then the path. Anything shorter is noise.
    if (raw.length < 4) continue;
    if (raw.slice(0, 2) === '!!') continue;
    let path = raw.slice(3);
    const arrow = path.indexOf(' -> ');
    if (arrow !== -1) path = path.slice(arrow + 4);
    // git C-quotes paths holding quotes or control characters; the quotes are
    // transport, not part of the name.
    if (path.length >= 2 && path.startsWith('"') && path.endsWith('"')) {
      path = path.slice(1, -1);
    }
    if (path === '' || patchPaths.has(path) || seen.has(path)) continue;
    seen.add(path);
    out.push(path);
    if (out.length >= MAX_STATUS_PATHS) break;
  }
  return out;
}

/**
 * Capture the patch and everything needed to re-apply it.
 *
 * Untracked files are folded in through a **temporary index**, never by staging
 * into the real one: mutating the checkout's index would change the very tree
 * being measured, and `git diff` alone silently omits new files.
 */
async function captureDiff(
  recordDir: string,
  attemptDir: string,
  baseRev: string,
  log: LogSink,
): Promise<{
  record: DiffValue;
  commands: (CommandValue & CommandProvenance)[];
  ignoredPaths: string;
}> {
  const commands: (CommandValue & CommandProvenance)[] = [];
  const indexPath = join(recordDir, 'patch.index');
  const indexEnv: NodeJS.ProcessEnv = { ...process.env, GIT_INDEX_FILE: indexPath };

  const readTree = await captured(['git', 'read-tree', baseRev], attemptDir, indexEnv);
  commands.push(toCommandRecord(readTree, FACTORY_VERIFICATION_PROVENANCE));
  let diffText: string;
  let numstatText: string;
  if (readTree.exitCode === 0) {
    const add = await captured(['git', 'add', '--all', '--', '.'], attemptDir, indexEnv);
    commands.push(toCommandRecord(add, FACTORY_VERIFICATION_PROVENANCE));
    const diff = await captured(
      ['git', 'diff', '--binary', '--cached', '--no-color', baseRev],
      attemptDir,
      indexEnv,
    );
    commands.push(toCommandRecord(diff, FACTORY_VERIFICATION_PROVENANCE));
    const numstat = await captured(
      ['git', 'diff', '--numstat', '--cached', '--no-color', baseRev],
      attemptDir,
      indexEnv,
    );
    commands.push(toCommandRecord(numstat, FACTORY_VERIFICATION_PROVENANCE));
    diffText = diff.stdout;
    numstatText = numstat.stdout;
    if (add.exitCode !== 0 || diff.exitCode !== 0) {
      log.warn(
        { addExit: add.exitCode, diffExit: diff.exitCode },
        'temp-index diff incomplete; the patch may omit untracked files',
      );
    }
  } else {
    // The temp index could not be seeded. Fall back to a plain working-tree diff
    // and say so: never pretend the patch is complete when the mechanism that
    // makes it complete failed.
    log.warn(
      { stderr: readTree.stderr.slice(0, 500) },
      'temp index unavailable; falling back to a tracked-only diff',
    );
    const diff = await captured(['git', 'diff', '--binary', '--no-color', baseRev], attemptDir);
    commands.push(toCommandRecord(diff, FACTORY_VERIFICATION_PROVENANCE));
    const numstat = await captured(['git', 'diff', '--numstat', '--no-color', baseRev], attemptDir);
    commands.push(toCommandRecord(numstat, FACTORY_VERIFICATION_PROVENANCE));
    diffText = diff.stdout;
    numstatText = numstat.stdout;
  }

  // The plain status, with untracked files expanded to individual paths
  // (`-uall`): the wall compares these against the patch to tell "changed
  // nothing" from "did work it never staged".
  const statusPlain = await captured(
    ['git', 'status', '--porcelain=v1', '--untracked-files=all'],
    attemptDir,
  );
  commands.push(toCommandRecord(statusPlain, FACTORY_VERIFICATION_PROVENANCE));

  // A3.5: ignored paths are invisible to both the diff and `status --porcelain`.
  const status = await captured(
    ['git', 'status', '--porcelain=v1', '--ignored=matching'],
    attemptDir,
  );
  commands.push(toCommandRecord(status, FACTORY_VERIFICATION_PROVENANCE));
  const ignoredList = await captured(
    ['git', 'ls-files', '--others', '--ignored', '--exclude-standard'],
    attemptDir,
  );
  commands.push(toCommandRecord(ignoredList, FACTORY_VERIFICATION_PROVENANCE));
  const ignoredPaths = ignoredList.stdout
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line !== '')
    .join('\n');
  if (ignoredPaths !== '') {
    log.warn(
      { count: ignoredPaths.split('\n').length },
      'worker wrote to gitignored paths; the diff does not show them',
    );
  }

  const patchPath = join(recordDir, 'attempt.patch');
  writeFileSync(patchPath, diffText, { mode: 0o600 });

  let filesChanged = 0;
  let insertions = 0;
  let deletions = 0;
  for (const line of numstatText.split('\n')) {
    if (line.trim() === '') continue;
    const [added, removed] = line.split('\t');
    filesChanged += 1;
    // `-` appears for binary files, where a line count is meaningless. Treating
    // it as zero is honest; inventing a number is not.
    if (added !== undefined && /^\d+$/.test(added)) insertions += Number(added);
    if (removed !== undefined && /^\d+$/.test(removed)) deletions += Number(removed);
  }

  // Paths the working tree reports that the patch does not contain. In a healthy
  // capture this is empty — untracked files are folded in through the temp index —
  // and its being empty is the assertion that the patch is complete. In the
  // fallback path above it is the difference between "nothing to report" and "a
  // file the agent wrote that no one will ever see".
  const patchPaths = new Set(
    numstatText
      .split('\n')
      .filter((line) => line.trim() !== '')
      .map((line) => line.split('\t').slice(2).join('\t'))
      .filter((path) => path !== ''),
  );
  const statusPaths = statusPathsFrom(statusPlain.stdout, patchPaths);
  if (statusPaths.length === MAX_STATUS_PATHS) {
    log.warn(
      { count: statusPaths.length },
      'the working tree changed more paths than the receipt can record; the list is truncated',
    );
  }

  return {
    record: {
      // The attempt record, not the checkout: the checkout is the repo, and a
      // patch written inside the repo would describe itself.
      patchFile: patchPath,
      sha: `sha256:${sha256Hex(diffText)}`,
      filesChanged,
      insertions,
      deletions,
      baseRev,
      statusPaths,
    },
    commands,
    ignoredPaths,
  };
}

/**
 * A greppable log of the tool calls DSH reported, one JSON object per line.
 *
 * These are *agent-reported* actions, not factory-executed commands, so they are
 * an artefact and not `commands[]`: a `CommandRecord` promises it can be
 * re-executed, and nothing here can keep that promise. Keeping them out of
 * `commands[]` also satisfies A3.6's rule that a truncated command must never
 * enter the forensic record — a `tool_call` whose arguments DSH cut at 8 KiB is
 * recorded as what it is, a truncated event, not as a command.
 */
function toolCallLog(lines: readonly string[]): string {
  const out: string[] = [];
  for (const line of lines) {
    const trimmed = line.trim();
    if (trimmed === '') continue;
    let event: unknown;
    try {
      event = JSON.parse(trimmed);
    } catch {
      continue;
    }
    if (typeof event !== 'object' || event === null) continue;
    const type = (event as Record<string, unknown>)['type'];
    if (type !== 'tool_call' && type !== 'tool_result') continue;
    out.push(trimmed);
  }
  return out.length === 0 ? '' : `${out.join('\n')}\n`;
}

/** Re-export the per-attempt home path, because an `AttemptIdentity` needs it. */
export { attemptHomePath };
