/**
 * **Platform pin — not a product feature.** What docker's `--internal` network does, and where a
 * host process can sit relative to it, measured from inside the worker image.
 *
 * A reader who sees this file green must not conclude that
 * `FACTORY_WORKER_ISOLATION=container` + `FACTORY_LIVE_MODEL=1` works. It does not, and the
 * reason is the thing this file pins: on this host (macOS + OrbStack) the docker daemon runs
 * inside a Linux VM, so
 *
 *   - the `--internal` bridge gateway (e.g. `192.168.97.1`) is an address inside the VM, not an
 *     address on the macOS host — a host process cannot bind it (`EADDRNOTAVAIL`, measured), and
 *   - `--internal` installs no default route and also drops the one container→host path a
 *     desktop-VM runtime otherwise provides (`host.docker.internal`), so a host process is
 *     unreachable from the network (`ENETUNREACH`, measured), not merely "refused".
 *
 * Together those are why the transport the runbook describes — the proxy binds the bridge
 * gateway, the worker joins the `--internal` network — is **unsatisfiable on this host**, and why
 * the exit-8 refusal in `apps/cli/src/context.ts` stays true here. On a native-Linux daemon the
 * gateway is a real host interface and the same design is viable; that half is spec'd below as a
 * `skipIf` on non-Linux with the measured reason, because it cannot be run on this machine.
 *
 * The point of keeping these as real-docker specs rather than a paragraph in the runbook: if a
 * docker/OrbStack release ever changes the behaviour (routes the host on `--internal`, or exposes
 * the gateway to the host), this suite goes red instead of the runbook silently going stale.
 *
 * ## The measurements
 *
 *  1. an `--internal` network installs no default route and the internet is unreachable with
 *     `ENETUNREACH` — asserted as an error *kind*, so "no route" cannot be confused with "the
 *     proxy refused"; the controls are (a) a container→container connection on the *same*
 *     internal network succeeds, and (b) the same internet probe from a container on the default
 *     bridge succeeds — so the negative is not a broken probe or a broken network.
 *  2. (darwin) the real credential proxy, bound to its default loopback address, answers a
 *     scoped-token request from a container on a normal bridge network — so the proxy and the
 *     probe both work, and a scoped token is genuinely minted and consumed.
 *  3. (darwin) that *same* proxy is unreachable from the `--internal` network: `ENETUNREACH`,
 *     not a 401 and not `ECONNREFUSED` — routing is what stops the worker, not the proxy.
 *  4. (darwin) the internal network's gateway is not an address on this host: binding it fails
 *     `EADDRNOTAVAIL`, and it is absent from the host's interface list.
 *  5. (linux) the gateway *is* a host address there: binding it succeeds and an
 *     internal-network container connects — `skipIf` here with the measured reason. **UNPROVEN:**
 *     no Linux host has run this branch in this tree.
 *
 * Cleanup is by label (`org.factory.e2e=<run token>`): the containers and the network this file
 * creates are removed by the label it wrote, never by a name prefix (an earlier bug in this
 * suite killed another suite's container by matching a shared `factory-worker-*` prefix).
 */
import { spawn, spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { createServer } from 'node:http';
import { networkInterfaces } from 'node:os';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  DEFAULT_BIND_ADDRESS,
  startCredentialProxy,
  type CredentialProxy,
  type ScopedToken,
} from '../../../packages/credential-proxy/src/index.ts';

/** The worker image, so the measurements are taken in the image the worker actually runs in. */
const BASE_IMAGE = 'factory-env:rc5';
const BUILD_COMMAND = `docker build --tag ${BASE_IMAGE} docker/factory-env`;
const GATEWAY_KEY = 'sk-e2e-internal-bridge-do-not-leak';

function resolveDocker(): string {
  const explicit = (process.env['FACTORY_DOCKER_BIN'] ?? '').trim();
  if (explicit !== '') return explicit;
  const which = spawnSync('/usr/bin/which', ['docker'], { encoding: 'utf8' });
  const found = (which.stdout ?? '').trim();
  return (which.status ?? 1) === 0 && found !== '' ? found : 'docker';
}

const DOCKER = resolveDocker();

function docker(
  args: readonly string[],
  timeoutMs = 90_000,
): { ok: boolean; out: string; err: string } {
  const run = spawnSync(DOCKER, args, { encoding: 'utf8', timeout: timeoutMs });
  return {
    ok: (run.status ?? 1) === 0,
    out: (run.stdout ?? '').trim(),
    err: (run.stderr ?? '').trim(),
  };
}

/** Decided at collection time: a missing image is a skip with its build command, never a pass. */
const BASE_PRESENT = docker(['image', 'inspect', BASE_IMAGE, '--format', '{{.Id}}']).ok;
const SKIP_REASON = BASE_PRESENT
  ? null
  : `image ${BASE_IMAGE} is absent; build it with: ${BUILD_COMMAND}`;
const SUITE = `platform pin — the docker --internal network, measured from inside the worker image${
  SKIP_REASON === null ? '' : ` — SKIPPED: ${SKIP_REASON}`
}`;

const DARWIN_ONLY_REASON =
  'darwin only: this measures the desktop-VM runtime (OrbStack) — a native-Linux daemon behaves differently';
const LINUX_ONLY_REASON =
  'linux only: on this host (darwin/OrbStack) the docker daemon runs in a VM, so the gateway is VM-internal ' +
  'and not bindable on the host (EADDRNOTAVAIL, measured above); this branch needs a native-Linux daemon';

/** One label for every object this file creates, so cleanup touches only what it made. */
const RUN_TOKEN = `internal-bridge-${String(process.pid)}-${randomBytes(4).toString('hex')}`;
const LABEL = 'org.factory.e2e';
const NETWORK = `factory-e2e-internal-${RUN_TOKEN}`;
const SIDECAR = `factory-e2e-sidecar-${RUN_TOKEN}`;
const SIDECAR_PORT = 18090;

interface SeenRequest {
  readonly method: string;
  readonly path: string;
  readonly authorization: string | null;
}

// Shared across the tests in this file, filled by beforeAll.
let gatewayAddress: string | null = null;
let hostAddress: string | null = null; // what host.docker.internal resolves to from a bridge net
let gateway = {
  url: '',
  seen: [] as SeenRequest[],
  close: async (): Promise<void> => {},
};
let proxy: CredentialProxy | null = null;
let minted: ScopedToken | null = null;
let proxyPort = 0;

/** A gateway stand-in that records the header the proxy wrote and answers a fixed JSON body. */
async function startFakeGateway(): Promise<{
  url: string;
  seen: SeenRequest[];
  close(): Promise<void>;
}> {
  const seen: SeenRequest[] = [];
  const server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => chunks.push(chunk));
    req.on('end', () => {
      seen.push({
        method: req.method ?? '',
        path: req.url ?? '',
        authorization:
          typeof req.headers['authorization'] === 'string' ? req.headers['authorization'] : null,
      });
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ ok: true, path: req.url ?? '' }));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
  const address = server.address();
  if (address === null || typeof address === 'string') throw new Error('no gateway port');
  return {
    url: `http://127.0.0.1:${String(address.port)}/openai/v1`,
    seen,
    async close() {
      if (!server.listening) return;
      await new Promise<void>((resolve, reject) =>
        server.close((error) => (error === undefined ? resolve() : reject(error))),
      );
    },
  };
}

function nodeProbeArgv(network: string, script: string): readonly string[] {
  return [
    'run',
    '--rm',
    '--label',
    `${LABEL}=${RUN_TOKEN}`,
    '--network',
    network,
    '--entrypoint',
    'node',
    BASE_IMAGE,
    '-e',
    script,
  ];
}

/** A container on `network` runs `script` under node; throws with docker's reason on failure. */
function runNode(network: string, script: string): string {
  const run = docker(nodeProbeArgv(network, script));
  if (!run.ok) throw new Error(`node probe failed: ${run.err || run.out}`);
  return run.out;
}

/**
 * The async twin, and it is not a style choice: a probe whose *answer* is served by this process
 * (the credential proxy and its fake gateway are HTTP servers in the spec) deadlocks under
 * [`spawnSync`], which blocks the event loop that would have answered. A test timeout cannot
 * even fire while the worker is blocked in a synchronous spawn — measured: the first run sat for
 * five minutes on exactly this and had to be killed.
 */
async function runNodeAsync(network: string, script: string): Promise<string> {
  return await new Promise<string>((resolve, reject) => {
    const child = spawn(DOCKER, [...nodeProbeArgv(network, script)], {
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk: string) => (stdout += chunk));
    child.stderr.on('data', (chunk: string) => (stderr += chunk));
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      reject(new Error(`node probe timed out; stdout: ${stdout.trim()} stderr: ${stderr.trim()}`));
    }, 60_000);
    child.once('error', (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.once('close', (code) => {
      clearTimeout(timer);
      if (code !== 0) {
        reject(new Error(`node probe exited ${String(code)}: ${stderr.trim() || stdout.trim()}`));
        return;
      }
      resolve(stdout.trim());
    });
  });
}

/** The `PROBE <json>` payload a container probe printed, parsed. */
function probeJson<T>(stdout: string): T {
  expect(stdout.startsWith('PROBE '), `probe did not report a result: ${stdout}`).toBe(true);
  return JSON.parse(stdout.slice('PROBE '.length)) as T;
}

const suite = describe.skipIf(SKIP_REASON !== null);

suite(SUITE, () => {
  beforeAll(async () => {
    const create = docker([
      'network',
      'create',
      '--internal',
      '--label',
      `${LABEL}=${RUN_TOKEN}`,
      NETWORK,
    ]);
    expect(create.ok, `docker network create failed: ${create.err}`).toBe(true);

    const inspect = docker(['network', 'inspect', NETWORK, '--format', '{{json .}}']);
    expect(inspect.ok, `docker network inspect failed: ${inspect.err}`).toBe(true);
    const parsed = JSON.parse(inspect.out) as {
      Internal?: boolean;
      IPAM?: { Config?: { Subnet?: string; Gateway?: string }[] };
    };
    expect(parsed.Internal, 'the network must be --internal').toBe(true);
    gatewayAddress = parsed.IPAM?.Config?.[0]?.Gateway ?? null;
    expect(gatewayAddress, 'the network has no gateway address to measure').not.toBeNull();

    // The proxy and its fake gateway are only needed by the darwin reachability measurements;
    // they are started unconditionally because they are cheap and harmless on linux, where those
    // tests skip. Binding loopback (the default) is the point: the door is exactly what a
    // host-side worker gets today.
    gateway = await startFakeGateway();
    const startedProxy = await startCredentialProxy({
      upstream: { baseUrl: gateway.url, apiKey: GATEWAY_KEY },
      now: () => '2026-11-02T12:00:00.000Z',
    });
    proxy = startedProxy;
    expect(startedProxy.boundAddress).toBe(DEFAULT_BIND_ADDRESS);
    proxyPort = startedProxy.port;
    minted = startedProxy.tokens.mint({
      attemptId: 'A-internal-bridge',
      issuedAt: '2026-11-02T11:55:00.000Z',
      expiresAt: '2026-11-02T12:40:00.000Z',
    });

    // The numeric host address a desktop-VM runtime hands out, used by the darwin "unreachable
    // from the internal network" measurement. A bridge-network container is where it resolves.
    if (process.platform === 'darwin') {
      const resolved = runNode(
        'bridge',
        `
          require('node:dns').lookup('host.docker.internal', (e, a) =>
            console.log('ADDR ' + (e ? 'ERR ' + e.code : a))
          );
        `,
      );
      const match = /ADDR (\d+\.\d+\.\d+\.\d+)/u.exec(resolved);
      if (match === null) {
        throw new Error(
          `could not resolve host.docker.internal from a bridge container (${resolved}); the platform pin needs updating`,
        );
      }
      hostAddress = match[1] ?? null;
    }
  });

  afterAll(async () => {
    await proxy?.close();
    await gateway.close();
    // Sweep by the label this file wrote — never by a name prefix.
    const containers = docker(['ps', '-aq', '--filter', `label=${LABEL}=${RUN_TOKEN}`]);
    for (const id of containers.out.split('\n').filter((line) => line !== '')) {
      docker(['rm', '-f', id]);
    }
    const networks = docker(['network', 'ls', '-q', '--filter', `label=${LABEL}=${RUN_TOKEN}`]);
    for (const id of networks.out.split('\n').filter((line) => line !== '')) {
      docker(['network', 'rm', id]);
    }
    const leftContainers = docker(['ps', '-aq', '--filter', `label=${LABEL}=${RUN_TOKEN}`]).out;
    const leftNetworks = docker([
      'network',
      'ls',
      '-q',
      '--filter',
      `label=${LABEL}=${RUN_TOKEN}`,
    ]).out;
    expect(leftContainers, 'a container this file created survived the sweep').toBe('');
    expect(leftNetworks, 'the internal network this file created survived the sweep').toBe('');
  });

  it('[@docker] an --internal network installs no default route, and the internet is ENETUNREACH', () => {
    // No default route: /proc/net/route has no row whose Destination is 00000000.
    const routes = docker([
      'run',
      '--rm',
      '--label',
      `${LABEL}=${RUN_TOKEN}`,
      '--network',
      NETWORK,
      '--entrypoint',
      'sh',
      BASE_IMAGE,
      '-c',
      'cat /proc/net/route',
    ]);
    expect(routes.ok, routes.err).toBe(true);
    const destinations = routes.out
      .split('\n')
      .slice(1)
      .map((line) => line.trim().split(/\s+/u)[1] ?? '')
      .filter((destination) => destination !== '');
    expect(destinations.length, 'the container reported no routes at all').toBeGreaterThan(0);
    expect(destinations, 'an --internal network must not install a default route').not.toContain(
      '00000000',
    );

    // The negative that matters: the error kind is ENETUNREACH ("no route"), not ECONNREFUSED or
    // ETIMEDOUT (something answered) and not an HTTP 401 (the proxy refused).
    const probe = runNode(
      NETWORK,
      `
        const net = require('node:net');
        const targets = [{ host: '1.1.1.1', port: 443 }, { host: '8.8.8.8', port: 53 }];
        const probe = (t) => new Promise((resolve) => {
          const sock = net.connect({ host: t.host, port: t.port, timeout: 5000 });
          sock.once('connect', () => { sock.destroy(); resolve({ target: t.host, result: 'CONNECTED' }); });
          sock.once('timeout', () => { sock.destroy(); resolve({ target: t.host, result: 'TIMEOUT' }); });
          sock.once('error', (e) => resolve({ target: t.host, result: 'ERROR', code: e.code }));
        });
        (async () => {
          const out = [];
          for (const t of targets) out.push(await probe(t));
          console.log('PROBE ' + JSON.stringify(out));
        })();
      `,
    );
    const results = probeJson<{ target: string; result: string; code?: string }[]>(probe);
    for (const result of results) {
      expect(result.result, `${result.target} must be unreachable`).toBe('ERROR');
      expect(result.code, `${result.target} must be "no route", not a refusal`).toBe('ENETUNREACH');
    }
  });

  it('[@docker] control: container→container works on the internal network, and the default bridge reaches the internet', () => {
    // Positive control one: the internal network is a working network — container→container
    // succeeds, so the internet negative is not "docker networking is broken".
    const started = docker([
      'run',
      '-d',
      '--rm',
      '--name',
      SIDECAR,
      '--label',
      `${LABEL}=${RUN_TOKEN}`,
      '--network',
      NETWORK,
      '--entrypoint',
      'node',
      BASE_IMAGE,
      '-e',
      `require('node:http').createServer((_q, r) => { r.writeHead(200); r.end('ok'); }).listen(${String(
        SIDECAR_PORT,
      )}, '0.0.0.0');`,
    ]);
    expect(started.ok, started.err).toBe(true);
    try {
      const probe = runNode(
        NETWORK,
        `
          const net = require('node:net');
          const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
          (async () => {
            for (let i = 0; i < 30; i++) {
              const result = await new Promise((resolve) => {
                const sock = net.connect({ host: '${SIDECAR}', port: ${String(
                  SIDECAR_PORT,
                )}, timeout: 1000 });
                sock.once('connect', () => { sock.destroy(); resolve('CONNECTED'); });
                sock.once('timeout', () => { sock.destroy(); resolve('TIMEOUT'); });
                sock.once('error', (e) => resolve('ERROR ' + e.code));
              });
              if (result === 'CONNECTED') { console.log('PROBE CONNECTED'); return; }
              await sleep(250);
            }
            console.log('PROBE NOT-CONNECTED');
          })();
        `,
      );
      expect(probe, 'two containers on the same internal network must reach each other').toBe(
        'PROBE CONNECTED',
      );
    } finally {
      docker(['rm', '-f', SIDECAR]);
    }

    // Positive control two: the probe program itself works — the same internet target connects
    // from the default bridge, where a default route and NAT exist.
    const probe = runNode(
      'bridge',
      `
        const net = require('node:net');
        const sock = net.connect({ host: '1.1.1.1', port: 443, timeout: 8000 });
        sock.once('connect', () => { console.log('PROBE CONNECTED'); sock.destroy(); });
        sock.once('timeout', () => { console.log('PROBE TIMEOUT'); sock.destroy(); });
        sock.once('error', (e) => console.log('PROBE ERROR ' + e.code));
      `,
    );
    expect(probe, 'the same probe must connect where a route exists').toBe('PROBE CONNECTED');
  });

  it.skipIf(process.platform !== 'darwin')(
    `[@docker] (darwin) the loopback-bound proxy answers a real scoped-token request from a bridge container — ${DARWIN_ONLY_REASON}`,
    async () => {
      expect(proxyPort).toBeGreaterThan(0);
      const token = minted?.token ?? '';
      expect(token).not.toBe('');
      const result = await runNodeAsync(
        'bridge',
        `
          const http = require('node:http');
          const req = (authorization) => new Promise((resolve, reject) => {
            const headers = { 'content-type': 'application/json' };
            if (authorization) headers['authorization'] = authorization;
            const r = http.request({
              host: 'host.docker.internal', port: ${String(proxyPort)},
              path: '/openai/v1/chat/completions', method: 'POST', headers,
            }, (res) => {
              let body = ''; res.setEncoding('utf8');
              res.on('data', (c) => (body += c));
              res.on('end', () => resolve({ status: res.statusCode, body }));
            });
            r.on('error', reject);
            r.write(JSON.stringify({ model: 'auto' })); r.end();
          });
          (async () => {
            const noToken = await req(null);
            const withToken = await req('Bearer ${token}');
            console.log('PROBE ' + JSON.stringify({ noToken, withToken }));
          })().catch((e) => { console.log('PROBE ERROR ' + e.message); process.exit(1); });
        `,
      );
      const parsed = probeJson<{
        noToken: { status: number; body: string };
        withToken: { status: number; body: string };
      }>(result);
      // The proxy is alive and refuses a tokenless request — this is the proxy refusing, which is
      // the exact outcome the internal-network negative must be distinguishable from.
      expect(parsed.noToken.status).toBe(401);
      expect(JSON.parse(parsed.noToken.body)).toMatchObject({ error: { reason: 'unknown-token' } });
      // A minted scoped token goes through, and the gateway saw the key, not the token.
      expect(parsed.withToken.status).toBe(200);
      expect(gateway.seen).toHaveLength(1);
      expect(gateway.seen[0]?.authorization).toBe(`Bearer ${GATEWAY_KEY}`);
      expect(gateway.seen[0]?.authorization).not.toContain(token);
      // A scoped token was genuinely minted and consumed: usage is recorded against it.
      expect(proxy?.usageFor(token)?.requests).toBe(1);
      if (minted !== null)
        expect(proxy?.describe(minted)).toEqual({
          token: 'scoped',
          expiresAt: '2026-11-02T12:40:00.000Z',
        });
    },
  );

  it.skipIf(process.platform !== 'darwin')(
    `[@docker] (darwin) that same proxy is ENETUNREACH from the --internal network — routing, not a refusal — ${DARWIN_ONLY_REASON}`,
    async () => {
      expect(hostAddress, 'the bridge-network host address must be known').not.toBeNull();
      expect(proxyPort).toBeGreaterThan(0);
      const probe = await runNodeAsync(
        NETWORK,
        `
          const net = require('node:net');
          const dns = require('node:dns');
          const connect = (host) => new Promise((resolve) => {
            const sock = net.connect({ host, port: ${String(proxyPort)}, timeout: 5000 });
            sock.once('connect', () => { sock.destroy(); resolve('CONNECTED'); });
            sock.once('timeout', () => { sock.destroy(); resolve('TIMEOUT'); });
            sock.once('error', (e) => resolve('ERROR ' + e.code));
          });
          (async () => {
            const byIp = await connect('${hostAddress ?? ''}');
            const dnsResult = await new Promise((resolve) =>
              dns.lookup('host.docker.internal', (e, a) => resolve(e ? 'ERROR ' + e.code : a))
            );
            console.log('PROBE ' + JSON.stringify({ byIp, dns: dnsResult }));
          })();
        `,
      );
      const parsed = probeJson<{ byIp: string; dns: string }>(probe);
      // The address that CONNECTED from the bridge (the previous test) is unreachable here, and
      // the failure is ENETUNREACH — "no route" — not ECONNREFUSED and not an HTTP refusal. An
      // ECONNREFUSED/401 here would mean routing worked and something answered, which is the
      // leak a happy-path-only test would miss.
      expect(parsed.byIp).toBe('ERROR ENETUNREACH');
      // The host name does not even resolve on the internal network: its DNS path is gone too.
      expect(parsed.dns.startsWith('ERROR ')).toBe(true);
    },
  );

  it.skipIf(process.platform !== 'darwin')(
    `[@docker] (darwin) the internal gateway is not an address on this host: binding it is EADDRNOTAVAIL — ${DARWIN_ONLY_REASON}`,
    async () => {
      expect(gatewayAddress, 'the network gateway address must be known').not.toBeNull();
      const bound = await new Promise<string | null>((resolve) => {
        const server = createServer();
        server.once('error', (error: NodeJS.ErrnoException) => resolve(error.code ?? null));
        server.listen(0, gatewayAddress ?? '', () => {
          server.close();
          resolve('LISTENING');
        });
      });
      expect(bound).toBe('EADDRNOTAVAIL');
      // Machine-checkable reason: the gateway is simply not among this host's interface addresses.
      const hostAddresses = new Set<string>();
      for (const infos of Object.values(networkInterfaces())) {
        for (const info of infos ?? []) hostAddresses.add(info.address);
      }
      expect(hostAddresses.has(gatewayAddress ?? '')).toBe(false);
    },
  );

  it.skipIf(process.platform !== 'linux')(
    `[@docker] (linux) the gateway is a host interface there: binding it works and an internal-network container connects — ${LINUX_ONLY_REASON}`,
    async () => {
      // On a native-Linux daemon the bridge gateway is a real interface, so the host proxy can sit
      // on it and the worker can reach it — the transport the runbook describes. This branch has never
      // been run in this tree (no Linux host), so it is UNPROVEN; the darwin EADDRNOTAVAIL
      // measurement above is what this host asserts instead.
      expect(gatewayAddress).not.toBeNull();
      const startedProxy = await startCredentialProxy({
        upstream: { baseUrl: gateway.url, apiKey: GATEWAY_KEY },
        now: () => '2026-11-02T12:00:00.000Z',
        bindAddress: gatewayAddress ?? '',
      });
      expect(startedProxy.boundAddress).toBe(gatewayAddress);
      try {
        const probe = runNode(
          NETWORK,
          `
            const net = require('node:net');
            const sock = net.connect({ host: '${gatewayAddress ?? ''}', port: ${String(
              startedProxy.port,
            )}, timeout: 5000 });
            sock.once('connect', () => { console.log('PROBE CONNECTED'); sock.destroy(); });
            sock.once('timeout', () => { console.log('PROBE TIMEOUT'); sock.destroy(); });
            sock.once('error', (e) => console.log('PROBE ERROR ' + e.code));
          `,
        );
        expect(probe).toBe('PROBE CONNECTED');
      } finally {
        await startedProxy.close();
      }
    },
  );
});
