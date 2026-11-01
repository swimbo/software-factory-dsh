/**
 * The egress boundary, proved by trying to leave (amendment A3.3).
 *
 * This is the hardest external fact in the whole design. Measured on this host by
 * the debate: a container on the **default bridge with no flags** reached
 * `host.docker.internal:5432`, `:11434`, **`:65107` (the operator's DSH GUI)**,
 * `1.1.1.1:443` and `example.com:443`. The plan said "no route except the
 * credential proxy" and the default bridge gave the worker the internet and the
 * operator's loopback.
 *
 * The enforceable shape is `docker network create --internal` with exactly two
 * members — the worker and the proxy, addressed by name. Everything here asserts
 * one half of that:
 *
 * - the enumerated destinations are **closed**;
 * - the proxy is **reachable by name** in the same process, so "everything was
 *   blocked" cannot be satisfied by a network that is merely broken;
 * - the worker has **no default route** and the proxy does, which is the
 *   structural reason the first two hold;
 * - nothing under the factory home is mounted, so the holdout is not reachable
 *   even by a worker that escapes its own sandbox.
 *
 * Without Docker these tests skip. They must not fail: a laptop without a daemon
 * is not evidence that egress is open, and a suite that turns red for the wrong
 * reason gets muted.
 */

import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { dockerAvailable } from './helpers.ts';

/** Present on this host and in CI; deliberately not the factory image. */
const IMAGE = 'node:22-alpine';

/** Skip, never fail, when there is no daemon. */
const skip = !dockerAvailable();

interface Run {
  status: number | null;
  stdout: string;
  stderr: string;
}

function docker(args: string[]): Run {
  const result = spawnSync('docker', args, { encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 });
  return { status: result.status, stdout: result.stdout ?? '', stderr: result.stderr ?? '' };
}

function must(args: string[]): string {
  const run = docker(args);
  if (run.status !== 0) {
    throw new Error(`docker ${args.join(' ')} failed (${String(run.status)}): ${run.stderr}`);
  }
  return run.stdout;
}

const SUFFIX = `${process.pid.toString(36)}${Date.now().toString(36).slice(-4)}`;
const NETWORK = `factory-egress-${SUFFIX}`;
const PROXY = `factory-proxy-${SUFFIX}`;
const WORKER = `factory-worker-${SUFFIX}`;
const PROXY_PORT = 8080;

/** The attempt directory the worker mount mirrors: same path inside and out. */
const attemptDir = join(mkdtempSync(join(tmpdir(), 'factory-egress-attempt-')), 'checkout');
/** A factory root with a holdout in it, which nothing may mount. */
const factoryHome = mkdtempSync(join(tmpdir(), 'factory-egress-home-'));

/**
 * The probe. One process per destination, on purpose.
 *
 * A single process dialling every destination looked simpler and was wrong: the
 * `host.docker.internal` lookup occupies a libuv threadpool thread while it hangs,
 * and every later hostname dial in that process then queues behind it and reads
 * as blocked. The boundary was fine — the measurement was not. One `docker exec`
 * per destination also means a destination that stalls cannot mask another one.
 *
 * A destination counts as blocked when the dial fails **or** does not complete
 * within 1.5 s. Treating a hang as "not blocked" would let a silently dropping
 * firewall read as a closed one, and treating it as "reached" is worse.
 *
 * The destination arrives as `process.argv[1]` JSON, so nothing here needs shell
 * quoting and the probe is the same code for the control and the negatives.
 */
const PROBE = `
const net = require('net');
const dns = require('dns');
const https = require('https');
const TIMEOUT = 1500;
const spec = JSON.parse(process.argv[1]);
const finish = (verdict) => { console.log(verdict); process.exit(0); };
const timer = setTimeout(() => finish('blocked'), TIMEOUT);
const ok = () => { clearTimeout(timer); finish('reached'); };
const bad = () => { clearTimeout(timer); finish('blocked'); };
if (spec.kind === 'dns') {
  dns.lookup(spec.host, (error) => (error ? bad() : ok()));
} else if (spec.kind === 'https') {
  const request = https.get({ host: spec.host, port: spec.port, path: '/', timeout: TIMEOUT }, () => {
    request.destroy();
    ok();
  });
  request.on('error', () => bad());
  request.on('timeout', () => { request.destroy(); bad(); });
} else {
  const socket = net.connect({ host: spec.host, port: spec.port });
  socket.setTimeout(TIMEOUT);
  socket.on('connect', () => { socket.destroy(); ok(); });
  socket.on('error', () => { socket.destroy(); bad(); });
  socket.on('timeout', () => { socket.destroy(); bad(); });
}
`;

/** Dial one destination from the worker and return `reached` or `blocked`. */
function dial(spec: Record<string, unknown>): string {
  return must(['exec', WORKER, 'node', '-e', PROBE, JSON.stringify(spec)]).trim();
}

const LISTEN = `
require('net').createServer((socket) => socket.end()).listen(${String(PROXY_PORT)}, '0.0.0.0', () => {
  console.log('listening');
});
`;

const IDLE = 'setInterval(() => {}, 1000000);';

function cleanup(): void {
  for (const name of [WORKER, PROXY]) docker(['rm', '--force', '--volumes', name]);
  docker(['network', 'rm', NETWORK]);
}

describe.skipIf(skip)('@docker the worker egress boundary', { timeout: 240_000 }, () => {
  beforeAll(() => {
    mkdirSync(attemptDir, { recursive: true });
    writeFileSync(join(attemptDir, 'attempt.txt'), 'the checkout\n');
    mkdirSync(join(factoryHome, 'holdout'), { recursive: true });
    writeFileSync(join(factoryHome, 'holdout', 'answer.txt'), 'never mount this\n');

    // The internal network: two members, no route off the segment.
    must(['network', 'create', '--internal', NETWORK]);

    // The proxy is dual-homed — internal for the worker, bridge for the world —
    // and it is the only member that gets a route.
    must(['run', '--detach', '--name', PROXY, '--network', 'bridge', IMAGE, 'node', '-e', LISTEN]);
    must(['network', 'connect', NETWORK, PROXY]);
    // Wait for the listener, not for a sleep: the readiness signal is the log line.
    const deadline = Date.now() + 30_000;
    let ready = false;
    while (!ready && Date.now() < deadline) {
      ready = docker(['logs', PROXY]).stdout.includes('listening');
      if (!ready) spawnSync('sleep', ['0.2']);
    }
    if (!ready) throw new Error('the proxy never started listening');

    // The worker, started with the **documented** invocation's mounts and flags:
    // the attempt directory at its identical path, a per-attempt named volume for
    // DSH_HOME, and nothing from the factory home.
    must([
      'run',
      '--detach',
      '--name',
      WORKER,
      '--network',
      NETWORK,
      '--read-only',
      '--tmpfs',
      '/tmp:rw,noexec,nosuid,size=8m',
      '--mount',
      `type=volume,src=factory-home-unit-1-1,dst=/dsh-home`,
      '--mount',
      `type=bind,src=${attemptDir},dst=${attemptDir}`,
      '--workdir',
      attemptDir,
      '--cap-drop=ALL',
      '--security-opt=no-new-privileges',
      '--pids-limit=512',
      '--memory=1g',
      '-e',
      `PROXY_HOST=${PROXY}`,
      '-e',
      `PROXY_PORT=${String(PROXY_PORT)}`,
      IMAGE,
      'node',
      '-e',
      IDLE,
    ]);
  });

  afterAll(cleanup);

  it('is an internal network with exactly two members, addressed by name', () => {
    const inspect = JSON.parse(must(['network', 'inspect', NETWORK])) as Array<{
      Internal: boolean;
      Containers: Record<string, { Name: string }>;
      Driver: string;
    }>;
    const network = inspect[0];
    expect(network?.Internal).toBe(true);
    const members = Object.values(network?.Containers ?? {}).map((member) => member.Name);
    expect(members).toHaveLength(2);
    expect(members).toContain(WORKER);
    expect(members).toContain(PROXY);
  });

  it('gives the worker no default route and the proxy one', () => {
    // The structural fact the behavioural test rests on: without a default route
    // there is nowhere to send a packet that is not on the segment.
    const workerRoutes = must(['exec', WORKER, 'cat', '/proc/net/route']);
    const proxyRoutes = must(['exec', PROXY, 'cat', '/proc/net/route']);
    const hasDefault = (table: string): boolean =>
      table
        .split('\n')
        .slice(1)
        .some((line) => (line.split(/\s+/)[1] ?? '') === '00000000');
    expect(hasDefault(workerRoutes)).toBe(false);
    expect(hasDefault(proxyRoutes)).toBe(true);
  });

  it('closes every enumerated destination, and still reaches the proxy', () => {
    // Each of these is a distinct escape route, not a variation on one: DNS is
    // exfiltration without a literal, the literals are exfiltration without DNS,
    // the metadata endpoint is credentials, and host.docker.internal is the
    // operator's own loopback (verified open on the default bridge).
    const destinations: Array<[string, Record<string, unknown>]> = [
      ['public https on 443', { kind: 'https', host: 'example.com', port: 443 }],
      ['DNS resolution', { kind: 'dns', host: 'example.com' }],
      ['public IPv4 literal', { kind: 'tcp', host: '1.1.1.1', port: 443 }],
      ['public IPv6 literal', { kind: 'tcp', host: '2606:4700:4700::1111', port: 443 }],
      ['host.docker.internal', { kind: 'tcp', host: 'host.docker.internal', port: 5432 }],
      ['cloud metadata', { kind: 'tcp', host: '169.254.169.254', port: 80 }],
    ];
    for (const [label, spec] of destinations) {
      expect(dial(spec), `${label} is not closed`).toBe('blocked');
    }

    // The control. Every destination above being blocked is necessary but not
    // sufficient — a worker with no network at all satisfies that. Reaching the
    // proxy *by container name on the internal network* is what proves the
    // topology has two members and one route, rather than none.
    expect(
      dial({ kind: 'tcp', host: PROXY, port: PROXY_PORT }),
      'the worker cannot reach the proxy by name, so this is a dead network, not a boundary',
    ).toBe('reached');

    // And the same dial by the name a human would use, resolved by the network's
    // own DNS: the proxy is addressed by name, not by a pinned address.
    const resolved = must([
      'exec',
      WORKER,
      'node',
      '-e',
      'require("dns").lookup(process.argv[1], (e, a) => { console.log(e ? "unresolved" : a); })',
      PROXY,
    ]);
    expect(resolved.trim()).toMatch(/^\d+\.\d+\.\d+\.\d+$/);
  });

  it('mounts the attempt directory at one path and nothing from the factory home', () => {
    const inspect = JSON.parse(must(['inspect', WORKER])) as Array<{
      Mounts: Array<{ Type: string; Source: string; Destination: string }>;
      Config: { WorkingDir: string };
    }>;
    const container = inspect[0];
    const mounts = container?.Mounts ?? [];

    const bind = mounts.filter((mount) => mount.Type === 'bind');
    expect(bind).toHaveLength(1);
    // The identical path is the point: DSH keys its session log by cwd, so the
    // host and the container must agree on where the attempt lives.
    expect(bind[0]?.Source).toBe(bind[0]?.Destination);
    expect(bind[0]?.Destination).toBe(attemptDir);
    expect(container?.Config.WorkingDir).toBe(attemptDir);

    // DSH_HOME is a named volume, never a host path (A3.4).
    const volume = mounts.filter((mount) => mount.Type === 'volume');
    expect(volume).toHaveLength(1);
    expect(volume[0]?.Destination).toBe('/dsh-home');

    // Nothing from the factory home crosses. The holdout is not merely "not
    // mounted": no path under the factory root exists at all.
    for (const mount of mounts) {
      expect(mount.Source.startsWith(factoryHome)).toBe(false);
    }
    expect(existsSync(join(factoryHome, 'holdout', 'answer.txt'))).toBe(true);
    const hidden = docker(['exec', WORKER, 'test', '-e', join(factoryHome, 'holdout')]);
    expect(hidden.status).not.toBe(0);
    const reachable = docker(['exec', WORKER, 'cat', join(attemptDir, 'attempt.txt')]);
    expect(reachable.stdout.trim()).toBe('the checkout');
  });

  it('gives each attempt its own DSH_HOME, with no carry-over', () => {
    // The cross-attempt channel A3.4 closes: `$DSH_HOME/cordis.patch.yml` composes
    // into every profile, so a shared home lets attempt N configure N+1.
    must(['exec', WORKER, 'sh', '-c', 'echo "- id: from-attempt-1" > /dsh-home/cordis.patch.yml']);
    expect(must(['exec', WORKER, 'cat', '/dsh-home/cordis.patch.yml'])).toContain('from-attempt-1');

    const second = `factory-home-unit-1-2-${SUFFIX}`;
    try {
      // A fresh volume for the same unit: whatever attempt 1 wrote is not there.
      const output = must([
        'run',
        '--rm',
        '--mount',
        `type=volume,src=${second},dst=/dsh-home`,
        IMAGE,
        'sh',
        '-c',
        'cat /dsh-home/cordis.patch.yml 2>/dev/null || echo "(empty)"',
      ]);
      expect(output.trim()).toBe('(empty)');
    } finally {
      docker(['volume', 'rm', '--force', second]);
    }
  });
});

describe.skipIf(!skip)('@docker the egress boundary without a daemon', () => {
  it('skips rather than failing, because no daemon is not evidence', () => {
    expect(skip).toBe(true);
    expect(dockerAvailable()).toBe(false);
  });
});
