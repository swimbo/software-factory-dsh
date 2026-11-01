/**
 * The startup probe — the one fact the store cannot hold.
 *
 * These tests use real executables (temporary shell scripts) rather than a mocked
 * `spawnSync`, because the failure modes that matter are the operating system's:
 * a binary that does not exist, one that exits non-zero, one that hangs, and one
 * whose output is not a version. All four must come back as `null` and none of them
 * may throw — the panel's job is to report, not to refuse to start.
 */
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { parseDshVersion, probeDshVersion } from './dsh-version.ts';

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'factory-panel-dsh-'));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

/** Write an executable script and return its path. */
function fakeDsh(name: string, body: string): string {
  const path = join(dir, name);
  writeFileSync(path, `#!/bin/sh\n${body}\n`, 'utf8');
  chmodSync(path, 0o755);
  return path;
}

describe('parsing what --version printed', () => {
  it('reads the version out of the shapes dsh actually prints', () => {
    expect(parseDshVersion('dsh/0.2.1-rc.3\n')).toBe('0.2.1-rc.3');
    expect(parseDshVersion('dsh 0.2.1-rc.3\n')).toBe('0.2.1-rc.3');
    expect(parseDshVersion('0.2.1\n')).toBe('0.2.1');
    expect(parseDshVersion('v0.2.1+build.7\n')).toBe('0.2.1+build.7');
    expect(parseDshVersion('deepseek-harness 1.2.3 (darwin arm64)\n')).toBe('1.2.3');
  });

  it('returns null when there is no version to read', () => {
    expect(parseDshVersion('')).toBeNull();
    expect(parseDshVersion('dsh: command not found\n')).toBeNull();
    expect(parseDshVersion('version unknown\n')).toBeNull();
    expect(parseDshVersion('0.2\n')).toBeNull();
  });
});

describe('probing', () => {
  it('returns the observed version from a working binary', () => {
    const bin = fakeDsh('dsh-ok', 'echo "dsh/0.2.1-rc.3"');
    expect(probeDshVersion({ env: { FACTORY_DSH_BIN: bin } })).toBe('0.2.1-rc.3');
  });

  it('reads a version printed on stderr too', () => {
    const bin = fakeDsh('dsh-stderr', 'echo "dsh 0.2.0" >&2');
    expect(probeDshVersion({ env: { FACTORY_DSH_BIN: bin } })).toBe('0.2.0');
  });

  it('returns null for a binary that exits non-zero', () => {
    const bin = fakeDsh('dsh-fail', 'echo "0.2.1-rc.3"\nexit 3');
    expect(probeDshVersion({ env: { FACTORY_DSH_BIN: bin } })).toBeNull();
  });

  it('returns null for a binary that does not exist', () => {
    expect(probeDshVersion({ env: { FACTORY_DSH_BIN: join(dir, 'not-here') } })).toBeNull();
  });

  it('returns null for a binary that hangs, without waiting for it', () => {
    const bin = fakeDsh('dsh-hang', 'sleep 5');
    const started = Date.now();
    expect(probeDshVersion({ env: { FACTORY_DSH_BIN: bin }, timeoutMs: 100 })).toBeNull();
    // The timeout is enforced: a wedged binary must not delay startup.
    expect(Date.now() - started).toBeLessThan(3_000);
  });

  it('returns null for output that carries no version', () => {
    const bin = fakeDsh('dsh-garbage', 'echo "not a version"');
    expect(probeDshVersion({ env: { FACTORY_DSH_BIN: bin } })).toBeNull();
  });

  it('falls back to `dsh` on PATH rather than inventing a version', () => {
    // No FACTORY_DSH_BIN: whatever `dsh` is on this machine, the probe either reads
    // it or reports that it could not. It may never return a guess.
    const observed = probeDshVersion({ env: { PATH: process.env['PATH'] }, timeoutMs: 1_000 });
    expect(observed === null || /^\d+\.\d+\.\d+/.test(observed)).toBe(true);
  });
});
