/**
 * Harness-owned ceilings and the kill switch.
 *
 * The agent cannot be trusted to stop, so the ceiling is measured on the host,
 * outside the process it constrains. Two ceilings are enforced here because they
 * are the two the host can observe *exactly*:
 *
 * - **wall clock** — a monotonic timer, immune to what the agent reports;
 * - **output bytes** — cumulative stdout, counted as it arrives.
 *
 * A token ceiling is deliberately *not* here. DSH reports usage per step and
 * omits the total entirely when any attempt in the step failed to report usage
 * (`packages/bundle/headless/src/json-stream.ts`, `step_end`), so a token trip
 * would either miss spend or fire on a partial sum that reads as an exact total.
 * An unmeasurable ceiling that fires anyway is worse than one that is honestly
 * absent — the factory's rule is that unknown stays unknown and never satisfies
 * a gate. Token accounting belongs to the credential proxy, which sees every
 * request.
 *
 * ## Why the kill is a process-group kill
 *
 * A coding agent spawns children: a test runner, a watch process, a shell. Killing
 * the parent leaves those children running, still holding the socket to the
 * credential proxy, still generating requests. A prior factory incident burned
 * roughly 2.88M tokens exactly this way — the parent was killed, the orphaned
 * grandchildren kept looping, and the spend only stopped when the proxy's own
 * reservation was exhausted. So every child this adapter spawns is a *process
 * group leader* (`detached: true`) and every kill targets `-pid`, never `pid`.
 */

import { performance } from 'node:perf_hooks';

/** The ceilings this watchdog can report. Matches the `Ceilings.hit` enum members it owns. */
export type WatchdogCeiling = 'wall-clock' | 'output-bytes';

export interface WatchdogOptions {
  /** Milliseconds from construction to trip. */
  wallClockMs: number;
  /** Cumulative stdout bytes before trip. */
  maxOutputBytes: number;
  /** Called exactly once, at the moment a ceiling trips. Must be idempotent. */
  onTrip: (ceiling: WatchdogCeiling) => void;
}

export interface Watchdog {
  /** The ceiling that tripped, or `null` while running and after a clean stop. */
  readonly tripped: WatchdogCeiling | null;
  /** Monotonic elapsed milliseconds, for `Ceilings.wallClockMs`. */
  readonly elapsedMs: number;
  /** Cumulative bytes fed so far. */
  readonly bytes: number;
  /** Account for `bytes` of observed output. Trips `output-bytes` when it exceeds the cap. */
  feed(bytes: number): void;
  /** Stop the timer and disarm. Safe to call more than once. */
  stop(): void;
}

function assertPositiveInt(value: number, name: string): void {
  if (!Number.isInteger(value) || value <= 0) {
    throw new TypeError(`${name} must be a positive integer, got ${String(value)}`);
  }
}

export function createWatchdog(options: WatchdogOptions): Watchdog {
  assertPositiveInt(options.wallClockMs, 'wallClockMs');
  assertPositiveInt(options.maxOutputBytes, 'maxOutputBytes');

  const started = performance.now();
  let tripped: WatchdogCeiling | null = null;
  let stopped = false;
  let bytes = 0;
  let timer: NodeJS.Timeout;

  const trip = (ceiling: WatchdogCeiling): void => {
    // Exactly once. A ceiling that trips twice would make `Ceilings.hit` lie
    // about the order things happened.
    if (tripped !== null || stopped) return;
    tripped = ceiling;
    clearTimeout(timer);
    options.onTrip(ceiling);
  };

  timer = setTimeout(() => {
    trip('wall-clock');
  }, options.wallClockMs);
  // Never keep the event loop alive on the watchdog's account: a process that
  // has finished its work must be able to exit.
  timer.unref?.();

  return {
    get tripped(): WatchdogCeiling | null {
      return tripped;
    },
    get elapsedMs(): number {
      return Math.max(0, Math.round(performance.now() - started));
    },
    get bytes(): number {
      return bytes;
    },
    feed(chunkBytes: number): void {
      if (stopped || tripped !== null) return;
      if (!Number.isInteger(chunkBytes) || chunkBytes < 0) {
        throw new TypeError(`feed() expects non-negative integer bytes, got ${String(chunkBytes)}`);
      }
      bytes += chunkBytes;
      if (bytes > options.maxOutputBytes) trip('output-bytes');
    },
    stop(): void {
      stopped = true;
      clearTimeout(timer);
    },
  };
}

/**
 * Kill a whole process group.
 *
 * `pid` must be a group leader, which is what `spawn(..., { detached: true })`
 * produces. Killing `pid` alone would reap the parent and orphan the
 * grandchildren — see the module comment.
 *
 * POSIX has real process groups; on Windows there is no equivalent for this
 * API, so the kill degrades to the single process (the container is the real
 * boundary there, not this call).
 */
export function killProcessGroup(pid: number, signal: NodeJS.Signals = 'SIGKILL'): void {
  if (!Number.isInteger(pid) || pid <= 0) {
    throw new TypeError(`killProcessGroup expects a positive pid, got ${String(pid)}`);
  }
  try {
    if (process.platform === 'win32') process.kill(pid, signal);
    else process.kill(-pid, signal);
  } catch (cause) {
    // ESRCH just means the group is already gone, which is the outcome we wanted.
    const code = (cause as NodeJS.ErrnoException).code;
    if (code !== 'ESRCH') throw cause;
  }
}
