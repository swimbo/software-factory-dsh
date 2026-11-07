/**
 * `scripts/provision-topology.sh` — the wrapper, spawned for real.
 *
 * The decision matrix is covered offline in `packages/store/src/topology.test.ts`. What this
 * spec covers is the thing a unit test cannot: that the shipped shell entry point runs, exits
 * with the documented code, prints the claim a reader will quote, and stays idempotent — in
 * report mode it touches nothing, on this host or on the Linux target it is asked to describe.
 *
 * The Linux branch is reached with `--platform linux --accounts none`, which exists for exactly
 * this reason: this host cannot be Linux, and the refusal path is the one that must never be a
 * matter of hope. `--apply` refuses to run under such an override (asserted here), so the
 * override can only produce a report, never a half-provisioned host.
 */
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { SINGLE_UID_CLAIM } from '../packages/store/src/topology.ts';

const HERE = dirname(fileURLToPath(import.meta.url));
const SCRIPT = resolve(HERE, 'provision-topology.sh');

interface Run {
  readonly status: number | null;
  readonly stdout: string;
  readonly stderr: string;
}

function run(args: readonly string[], env: Record<string, string> = {}): Run {
  const result = spawnSync('bash', [SCRIPT, ...args], {
    encoding: 'utf8',
    env: { ...process.env, ...env },
  });
  return { status: result.status, stdout: result.stdout, stderr: result.stderr };
}

let root = '';
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'provision-topology-'));
});
afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

describe('provision-topology.sh on a host without a second uid', () => {
  it('reports single-uid, prints the ratified claim, and exits 0', () => {
    const result = run(['--root', root], { FACTORY_HOME: root });
    expect(result.stderr).toBe('');
    expect(result.status).toBe(0);
    expect(result.stdout).toContain('topology  single-uid');
    expect(result.stdout).toContain('claim     single-uid: the wall is a separate process');
    expect(result.stdout).toContain('not a separate principal');
    expect(result.stdout).toContain(process.platform);
  });

  it('provisions nothing in report mode — no directory, no marker, nothing to clean up', () => {
    const before = readdirSync(root);
    const result = run(['--root', join(root, 'factory')], { FACTORY_HOME: join(root, 'factory') });
    expect(result.status).toBe(0);
    expect(readdirSync(root)).toEqual(before);
    expect(existsSync(join(root, 'factory'))).toBe(false);
  });

  it('is idempotent: the same report twice, byte for byte', () => {
    const first = run(['--root', root, '--json'], { FACTORY_HOME: root });
    const second = run(['--root', root, '--json'], { FACTORY_HOME: root });
    expect(first.status).toBe(0);
    expect(second.status).toBe(0);
    const strip = (text: string): string => text.replace(/"generatedAt": "[^"]*",?/g, '');
    expect(strip(second.stdout)).toBe(strip(first.stdout));
  });

  it('emits a machine-readable report whose claim is the same sentence', () => {
    const result = run(['--root', root, '--json'], { FACTORY_HOME: root });
    const report = JSON.parse(result.stdout) as {
      ok: boolean;
      topology: { kind: string; claim: string; source: string; modes: unknown[] };
      refusal: unknown;
      plan: unknown[];
    };
    expect(report.ok).toBe(true);
    expect(report.topology.kind).toBe('single-uid');
    expect(report.topology.source).toBe('platform');
    expect(report.topology.claim).toBe(SINGLE_UID_CLAIM);
    expect(report.topology.modes).toEqual([]);
    expect(report.refusal).toBeNull();
    expect(report.plan).toEqual([]);
  });
});

describe('provision-topology.sh on the Linux target it cannot be', () => {
  it('refuses when the two accounts are missing, names them, and exits 8', () => {
    const result = run(['--root', root, '--platform', 'linux', '--accounts', 'none'], {
      FACTORY_HOME: root,
    });
    expect(result.status).toBe(8);
    expect(result.stdout).toContain('TOPOLOGY_ACCOUNTS_MISSING');
    expect(result.stdout).toContain('group factory-wall');
    expect(result.stdout).toContain('user factory-worker');
    // The exact commands, so the operator can paste them and re-run this script.
    expect(result.stdout).toContain('groupadd --system factory-wall');
    expect(result.stdout).toContain(
      'useradd --system --gid factory-wall --home-dir /var/lib/factory/wall ' +
        '--no-create-home --shell /usr/sbin/nologin factory-wall',
    );
    expect(result.stdout).toContain('useradd --system --gid factory-worker');
    // It says out loud that it did not create them.
    expect(result.stdout).toContain('will not create system accounts implicitly');
  });

  it('still writes nothing when it refuses', () => {
    const before = readdirSync(root);
    run(['--root', join(root, 'factory'), '--platform', 'linux', '--accounts', 'none'], {
      FACTORY_HOME: join(root, 'factory'),
    });
    expect(readdirSync(root)).toEqual(before);
  });

  it('refuses to --apply a plan for a platform it is not running on', () => {
    const result = run(['--root', root, '--platform', 'linux', '--accounts', 'none', '--apply'], {
      FACTORY_HOME: root,
    });
    expect(result.status).toBe(2);
    expect(result.stderr).toContain('refusing to --apply');
  });

  it('accepts --accounts none only with a known value', () => {
    const result = run(['--root', root, '--accounts', 'maybe'], { FACTORY_HOME: root });
    expect(result.status).toBe(2);
    expect(result.stderr).toContain('--accounts must be probe, none or present');
  });

  it('rejects an unknown argument with a usage error instead of guessing', () => {
    const result = run(['--root', root, '--force'], { FACTORY_HOME: root });
    expect(result.status).toBe(2);
    expect(result.stderr).toContain('unknown argument: --force');
  });
});
