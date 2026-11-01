/**
 * The watchdog is the only thing that bounds a run the agent cannot bound
 * itself, so both ceilings and the kill are tested against real time and real
 * processes rather than with fake timers.
 */

import { spawn } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

import { createWatchdog, killProcessGroup } from '../src/watchdog.ts';
import { eventually, isDead, tempDir } from './helpers.ts';

/** Watchdogs created here are stopped even when an assertion throws. */
const live: { stop(): void }[] = [];
afterEach(() => {
  for (const watchdog of live.splice(0)) watchdog.stop();
});

function watchdog(options: { wallClockMs?: number; maxOutputBytes?: number } = {}) {
  const onTrip = vi.fn();
  const created = createWatchdog({
    wallClockMs: options.wallClockMs ?? 60_000,
    maxOutputBytes: options.maxOutputBytes ?? 1_000_000,
    onTrip,
  });
  live.push(created);
  return { watchdog: created, onTrip };
}

describe('createWatchdog', () => {
  it('trips the wall-clock ceiling and reports it once', async () => {
    const { watchdog: wd, onTrip } = watchdog({ wallClockMs: 60 });
    expect(wd.tripped).toBeNull();
    await eventually(() => wd.tripped !== null, 2000);
    expect(wd.tripped).toBe('wall-clock');
    expect(onTrip).toHaveBeenCalledTimes(1);
    expect(onTrip).toHaveBeenCalledWith('wall-clock');
  });

  it('trips the output-bytes ceiling the moment the cap is crossed', () => {
    const { watchdog: wd, onTrip } = watchdog({ maxOutputBytes: 100 });
    wd.feed(60);
    expect(wd.tripped).toBeNull();
    wd.feed(40);
    // Exactly at the cap is fine; the ceiling bounds growth, it does not forbid
    // the cap itself.
    expect(wd.tripped).toBeNull();
    wd.feed(1);
    expect(wd.tripped).toBe('output-bytes');
    expect(wd.bytes).toBe(101);
    expect(onTrip).toHaveBeenCalledTimes(1);
  });

  it('ignores output after a trip', () => {
    const { watchdog: wd, onTrip } = watchdog({ maxOutputBytes: 10 });
    wd.feed(11);
    expect(wd.tripped).toBe('output-bytes');
    wd.feed(1_000_000);
    expect(wd.tripped).toBe('output-bytes');
    expect(onTrip).toHaveBeenCalledTimes(1);
    expect(wd.bytes).toBe(11);
  });

  it('cannot trip after an explicit stop', async () => {
    const { watchdog: wd, onTrip } = watchdog({ wallClockMs: 40, maxOutputBytes: 10 });
    wd.stop();
    await new Promise((resolve) => setTimeout(resolve, 100));
    wd.feed(1000);
    expect(wd.tripped).toBeNull();
    expect(onTrip).not.toHaveBeenCalled();
  });

  it('measures elapsed time monotonically for the receipt', async () => {
    const { watchdog: wd } = watchdog({ wallClockMs: 60 });
    await eventually(() => wd.elapsedMs >= 40, 2000);
    expect(wd.elapsedMs).toBeGreaterThanOrEqual(40);
  });

  it('refuses a non-positive ceiling instead of silently never tripping', () => {
    // A zero ceiling would mean "always tripped" or "never tripped" depending on
    // the comparison, and either reading is a bug in the caller.
    expect(() => createWatchdog({ wallClockMs: 0, maxOutputBytes: 10, onTrip: vi.fn() })).toThrow(
      /wallClockMs/,
    );
    expect(() => createWatchdog({ wallClockMs: 10, maxOutputBytes: -1, onTrip: vi.fn() })).toThrow(
      /maxOutputBytes/,
    );
  });

  it('refuses a negative or fractional byte count', () => {
    const { watchdog: wd } = watchdog();
    expect(() => wd.feed(-1)).toThrow(/non-negative integer/);
    expect(() => wd.feed(1.5)).toThrow(/non-negative integer/);
  });
});

describe('killProcessGroup', () => {
  it('reaps a grandchild too, which a kill of the parent alone leaves running', async () => {
    // The shape of the prior incident: the parent dies, the orphan keeps working
    // and keeps spending. Only a process-group kill stops it.
    const dir = tempDir('kill');
    const pidFile = join(dir, 'grandchild.pid');
    const child = spawn('sh', ['-c', `sleep 300 & echo $! > ${pidFile}; wait`], {
      detached: process.platform !== 'win32',
      stdio: 'ignore',
    });
    const closed = new Promise<void>((resolve) => child.once('close', () => resolve()));

    const started = await eventually(() => {
      try {
        return readFileSync(pidFile, 'utf8').trim() !== '';
      } catch {
        return false;
      }
    });
    expect(started).toBe(true);
    const grandchild = Number(readFileSync(pidFile, 'utf8').trim());
    expect(Number.isInteger(grandchild)).toBe(true);
    expect(isDead(grandchild)).toBe(false);

    expect(child.pid).toBeDefined();
    killProcessGroup(child.pid ?? 0);
    await closed;

    expect(await eventually(() => isDead(grandchild), 5000)).toBe(true);
  });

  it('is a no-op when the group is already gone', () => {
    // Reaping an already-reaped group must not throw: the watchdog's whole job is
    // to be run late.
    const child = spawn('true', [], { detached: process.platform !== 'win32', stdio: 'ignore' });
    const pid = child.pid ?? 0;
    expect(() => killProcessGroup(pid)).not.toThrow();
  });

  it('refuses a nonsensical pid', () => {
    expect(() => killProcessGroup(0)).toThrow(/positive pid/);
    expect(() => killProcessGroup(-5)).toThrow(/positive pid/);
  });
});
