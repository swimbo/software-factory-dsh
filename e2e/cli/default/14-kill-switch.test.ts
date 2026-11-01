/**
 * The kill switch reaps descendants, not just the leader (E2E-51, re-scoped).
 *
 * The plan's version needs a container and a FakeExecutor that spawns a grandchild, which
 * this build cannot do (`@docker` is unimplemented — see the evidence file). What is
 * provable *here*, and is the part the incident was actually about, is the mechanism: a
 * worker is spawned as a process-group leader, and the kill targets `-pid` so a grandchild
 * that a worker left behind cannot outlive it. The 2.88M-token burn in the design notes
 * happened because a kill hit the parent and orphaned the child.
 *
 * Two specs, and the second is the control that keeps the first honest: if killing the
 * leader alone could also reap the grandchild, the first spec would pass for the wrong
 * reason. The control asserts the orphan survives a single-process kill, which is what makes
 * the process-group kill a *decision* rather than an accident of the platform.
 */
import { execFileSync, spawn } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { killProcessGroup } from '../../../packages/dsh-adapter/src/watchdog.ts';

/**
 * A worker stand-in: writes its own pid, spawns a grandchild that writes its pid, then idles.
 * Both stay in the worker's process group, exactly as a worker's leftover child processes do.
 */
const WORKER_SCRIPT = `
const { spawn } = require('node:child_process');
const { writeFileSync } = require('node:fs');
writeFileSync(process.env.PID_FILE, String(process.pid));
const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1e9)'], {
  stdio: 'ignore',
});
writeFileSync(process.env.CHILD_PID_FILE, String(child.pid));
setInterval(() => {}, 1e9);
`;

interface RunningWorker {
  readonly pid: number;
  readonly grandchildPid: number;
  readonly stop: () => void;
}

let dir: string | null = null;
const spawned: number[] = [];

afterEach(() => {
  for (const pid of spawned) {
    try {
      process.kill(pid, 'SIGKILL');
    } catch {
      // already gone
    }
  }
  spawned.length = 0;
  if (dir !== null) rmSync(dir, { recursive: true, force: true });
  dir = null;
});

function waitForFile(path: string, timeoutMs = 10_000): number {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (existsSync(path)) {
      const pid = Number(readFileSync(path, 'utf8').trim());
      if (Number.isInteger(pid) && pid > 0) return pid;
    }
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 25);
  }
  throw new Error(`timed out waiting for ${path}`);
}

/**
 * Alive means *running*, not merely addressable: a killed child is a zombie until its parent
 * reaps it, and `kill(pid, 0)` happily answers for a zombie. `ps` state is the honest probe.
 */
function alive(pid: number): boolean {
  try {
    const stat = execFileSync('ps', ['-o', 'stat=', '-p', String(pid)], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
    return stat.length > 0 && !stat.startsWith('Z');
  } catch {
    return false;
  }
}

function waitUntilDead(pid: number, timeoutMs = 5_000): boolean {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (!alive(pid)) return true;
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 25);
  }
  return !alive(pid);
}

function spawnWorker(): RunningWorker {
  dir = mkdtempSync(join(tmpdir(), 'factory-kill-'));
  const script = join(dir, 'worker.cjs');
  const pidFile = join(dir, 'worker.pid');
  const childPidFile = join(dir, 'grandchild.pid');
  writeFileSync(script, WORKER_SCRIPT);
  const child = spawn(process.execPath, [script], {
    // The worker is its own process-group leader, which is what the adapter does and what
    // makes `kill(-pid)` reach the grandchild it spawns.
    detached: true,
    stdio: 'ignore',
    env: { ...process.env, PID_FILE: pidFile, CHILD_PID_FILE: childPidFile },
  });
  child.unref();
  const pid = waitForFile(pidFile);
  const grandchildPid = waitForFile(childPidFile);
  spawned.push(pid, grandchildPid);
  return { pid, grandchildPid, stop: () => child.kill('SIGKILL') };
}

describe('kill switch (E2E-51, re-scoped to the mechanism)', () => {
  it('[@default] killing the process group reaps the grandchild a worker left behind', () => {
    const worker = spawnWorker();
    expect(alive(worker.pid), 'worker is running').toBe(true);
    expect(alive(worker.grandchildPid), 'grandchild is running').toBe(true);

    killProcessGroup(worker.pid, 'SIGKILL');

    // Both are gone, and the assertion is on the *grandchild*: the leader dying alone is the
    // bug this exists to prevent.
    expect(waitUntilDead(worker.grandchildPid), 'grandchild was reaped with the group').toBe(true);
    expect(waitUntilDead(worker.pid), 'leader was reaped').toBe(true);
  });

  it('[@default] control: a single-process kill would have orphaned the grandchild', () => {
    const worker = spawnWorker();

    // Kill only the leader, the way a naive `kill(pid)` would. The grandchild survives —
    // which is why the adapter kills `-pid` and why the first spec means something.
    worker.stop();
    expect(waitUntilDead(worker.pid), 'leader is gone').toBe(true);
    expect(alive(worker.grandchildPid), 'grandchild outlived a leader-only kill').toBe(true);
  });
});
