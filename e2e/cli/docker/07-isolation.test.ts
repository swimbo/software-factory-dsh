/**
 * The isolation suite: four properties of the wall's isolation layer, measured from inside
 * the container the runner actually launches.
 *
 * This file used to be four `expect(true).toBe(true)` bodies behind an env var, and the
 * audit was right to call that UNKNOWN: a placeholder that can go green on a host with
 * docker is worse than no spec, because it makes a missing layer look landed. The bodies
 * below launch containers through `createContainerRunner`, so what is asserted is the
 * *shipped* invocation — flags, image, uid, cgroup limits — not a `docker run` command
 * written a second time in the test.
 *
 * Every spec has a positive and a negative half:
 *
 * - the negative half is the property (the container cannot reach the network, cannot write
 *   outside its work dir, cannot see the host's factory home, is capped rather than
 *   unbounded);
 * - the positive half is the control that stops the negative half from passing because the
 *   probe itself is broken — the same probe on the host *can* reach the network, *can* write,
 *   *can* see the fake key. Without a control, deleting the probe would make the suite greener.
 *
 * Exit codes carry the results, because that is the runner's contract: it returns an exit
 * code and a hash, and the wall reads counts, not prose. A probe that exits 0 means "the
 * property holds", 1 means "it does not", 2 means "the probe could not be evaluated".
 *
 * If docker or the image is unavailable the suite is skipped **with the reason in its name**
 * and counted `UNKNOWN` in `e2e-tests.md` — never passed.
 */
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { join, resolve } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import {
  createContainerRunner,
  dockerIsAvailable,
  imageContentId,
} from '../../../packages/wall/src/container.ts';
import { NO_PATCH, type ScenarioRunInput } from '../../../packages/wall/src/evaluate.ts';

const WALL_IMAGE = process.env['FACTORY_WALL_IMAGE'] ?? 'factory-env:e2e';
const IMAGE_DIR = fileURLToPath(new URL('../../../packages/wall/docker/', import.meta.url));

// `sha256:` + 64 hex. A locally built image has no registry manifest and therefore no
// `name@sha256:…` reference (that resolves through a registry), so the content id is the
// only pin available offline — recorded here and re-checked below.
const IMAGE_ID_PATTERN = /^sha256:[0-9a-f]{64}$/;

function buildImage(): string | null {
  const build = spawnSync(
    'docker',
    ['build', '--platform', 'linux/amd64', '--quiet', '--tag', WALL_IMAGE, resolve(IMAGE_DIR)],
    { encoding: 'utf8', timeout: 180_000 },
  );
  if (build.status !== 0) {
    return `docker build failed for ${WALL_IMAGE}: ${(build.stderr ?? '').trim().split('\n').slice(-2).join(' ')}`;
  }
  return null;
}

/**
 * Readiness is decided once, at collection time, because `skipIf` needs it before any test
 * runs. Building here (not in `beforeAll`) keeps "the image exists" and "the suite can run"
 * the same fact.
 */
const dockerReady = await dockerIsAvailable();
let imageId: string | null = dockerReady ? imageContentId(WALL_IMAGE) : null;
let buildError: string | null = null;
if (dockerReady && imageId === null) {
  buildError = buildImage();
  imageId = buildError === null ? imageContentId(WALL_IMAGE) : null;
}

const SKIP_REASON = !dockerReady
  ? 'docker daemon unreachable'
  : imageId === null
    ? (buildError ?? `wall image ${WALL_IMAGE} absent and could not be built`)
    : null;

const suiteName =
  SKIP_REASON === null
    ? 'isolation [@docker] — four properties measured inside the wall image'
    : `isolation [@docker] — SKIPPED: ${SKIP_REASON}`;

/** A tree to mount. The runner copies it per run, so the source is never written through. */
const worktree = mkdtempSync(join(tmpdir(), 'factory-isolation-'));
writeFileSync(join(worktree, 'README.txt'), 'isolation suite worktree\n', 'utf8');

afterAll(() => {
  rmSync(worktree, { recursive: true, force: true });
});

const RUN_TOKEN = `isolation-${String(process.pid)}`;

function runner(over: { memoryLimit?: string; pidsLimit?: number } = {}) {
  return createContainerRunner({
    image: WALL_IMAGE,
    cwd: worktree,
    label: RUN_TOKEN,
    ...(over.memoryLimit === undefined ? {} : { memoryLimit: over.memoryLimit }),
    ...(over.pidsLimit === undefined ? {} : { pidsLimit: over.pidsLimit }),
  });
}

function runInput(argv: readonly string[], timeoutMs = 60_000): ScenarioRunInput {
  return { baseRev: 'a'.repeat(40), patchFile: NO_PATCH, argv, timeoutMs };
}

/**
 * A scenario whose exit code *is* the assertion.
 *
 * `scriptFile` is a path *inside the container* (`/workspace/…`), which is how a probe that
 * needs to carry a host path or a secret is written: as a file in the mounted worktree,
 * rather than as a one-liner with three levels of shell escaping waiting to be wrong.
 */
async function runProbe(
  script: string,
  over: {
    memoryLimit?: string;
    pidsLimit?: number;
    timeoutMs?: number;
    scriptFile?: string;
  } = {},
): Promise<{ exitCode: number | null; timedOut: boolean }> {
  const argv = over.scriptFile === undefined ? ['node', '-e', script] : ['node', over.scriptFile];
  const result = await runner(over).run(runInput(argv, over.timeoutMs ?? 60_000));
  return { exitCode: result.exitCode, timedOut: result.timedOut };
}

/** Containers still running for this suite's label. Should be empty after every spec. */
function leftovers(): string[] {
  const listed = spawnSync(
    'docker',
    ['ps', '--quiet', '--filter', `label=org.factory.run=${RUN_TOKEN}`],
    {
      encoding: 'utf8',
    },
  );
  return (listed.stdout ?? '')
    .trim()
    .split('\n')
    .filter((line) => line.length > 0);
}

const EGRESS_PROBE = `const net=require('net');const s=net.connect({host:'1.1.1.1',port:443});s.setTimeout(5000);
s.on('connect',()=>process.exit(0));s.on('error',()=>process.exit(1));s.on('timeout',()=>process.exit(2));`;

/** The host's own egress, used as the control for the network spec. */
function hostCanReachInternet(): boolean {
  return spawnSync(process.execPath, ['-e', EGRESS_PROBE], { timeout: 15_000 }).status === 0;
}

const HOST_EGRESS = dockerReady ? hostCanReachInternet() : false;

describe.skipIf(SKIP_REASON !== null)(suiteName, () => {
  it('[@docker] E2E-43: the container reaches no network, and the control proves the probe works', async () => {
    // Negative half: inside the container the connection must fail, and fail as *refused*
    // (ENETUNREACH), not as a timeout that could be a slow network.
    const inside = await runProbe(
      `const net=require('net');
const ifaces=Object.keys(require('os').networkInterfaces());
if (ifaces.length !== 1 || ifaces[0] !== 'lo') { console.log('IFACES:'+ifaces.join(',')); process.exit(2); }
const s=net.connect({host:'1.1.1.1',port:443});
s.setTimeout(3000);
s.on('connect',()=>process.exit(0));
s.on('error',(e)=>{ console.log('ERR:'+e.code); process.exit(e.code === 'ENETUNREACH' ? 1 : 2); });
s.on('timeout',()=>process.exit(2));`,
    );

    // 1 = refused with ENETUNREACH (property holds), 0 = connected (property broken),
    // 2 = probe could not be evaluated (indistinguishable from broken isolation).
    expect(inside.exitCode, 'container must not reach 1.1.1.1 (0=connected, 2=probe broken)').toBe(
      1,
    );

    // Positive control. If this host has no egress the control cannot exist, and that is
    // reported rather than asserted vacuously.
    if (!HOST_EGRESS) {
      console.warn('[@docker] E2E-43 control skipped: this host has no egress to 1.1.1.1');
    } else {
      const control = spawnSync(process.execPath, ['-e', EGRESS_PROBE], { timeout: 15_000 });
      expect(
        control.status,
        'the host control must reach 1.1.1.1, or the container refusal proves nothing',
      ).toBe(0);
    }
    expect(leftovers()).toEqual([]);
  }, 120_000);

  it('[@docker] E2E-44: the container cannot write outside its work dir, and can write inside', async () => {
    // Negative half: the root filesystem is read-only and /root is not ours. Positive half:
    // the mounted work dir and the tmpfs *are* writable, so a failure above is isolation and
    // not a container that cannot write anywhere at all.
    const result = await runProbe(
      `const fs=require('fs');
const out={uid:process.getuid(),cwd:process.cwd()};
const attempt=(p)=>{try{fs.writeFileSync(p,'x');return 'ok'}catch(e){return e.code}};
out.root=attempt('/pwned');
out.home=attempt('/root/pwned');
out.workspace=attempt('/workspace/probe.txt');
out.tmp=attempt('/tmp/probe.txt');
console.log(JSON.stringify(out));
process.exit(out.root === 'EROFS' && out.home === 'EACCES' && out.workspace === 'ok' && out.tmp === 'ok' && out.uid !== 0 ? 0 : 1);`,
    );

    expect(result.exitCode, 'read-only root, non-root uid, writable workspace and /tmp').toBe(0);
    expect(leftovers()).toEqual([]);
  }, 120_000);

  it('[@docker] E2E-45: the container sees neither the host factory home nor an operator key', async () => {
    // A real factory home on the host, with a key in it: the control proves the probe can
    // find such things, so "not found" inside the container means something.
    const fakeHome = mkdtempSync(join(tmpdir(), 'factory-home-'));
    const keyPath = join(fakeHome, 'keys', 'evaluator.key');
    mkdirSync(join(fakeHome, 'keys'), { recursive: true });
    mkdirSync(join(fakeHome, 'holdout', 'r0001'), { recursive: true });
    writeFileSync(keyPath, 'FAKE-PRIVATE-KEY-MATERIAL\n', 'utf8');
    writeFileSync(join(fakeHome, 'holdout', 'r0001', 'alpha.json'), '{"id":"alpha"}\n', 'utf8');

    try {
      const hostSeesKey = spawnSync(process.execPath, [
        '-e',
        `process.exit(require('fs').existsSync(${JSON.stringify(keyPath)})?0:1)`,
      ]);
      expect(hostSeesKey.status, 'the host control must see the fake key').toBe(0);

      // The probe is specific on purpose. A generic `find / -name '*.pem'` matches the
      // image's own CA bundle (`/etc/ssl/cert.pem`), which is a false positive — the first
      // version of this spec failed on exactly that, which is the useful direction for a
      // false positive to point: the probe, not the isolation.
      //
      // Written to a file rather than `node -e` because it has to carry the host path and
      // the key material: a quoted one-liner with three levels of escaping is a probe that
      // will eventually test itself instead of the container.
      const probePath = join(worktree, 'probe-45.js');
      writeFileSync(
        probePath,
        [
          "const fs = require('fs');",
          `const HOST_HOME = ${JSON.stringify(fakeHome)};`,
          `const KEY = ${JSON.stringify('FAKE-PRIVATE-KEY-MATERIAL')};`,
          'const leaks = Object.keys(process.env).filter((k) =>',
          '  /^(FACTORY_HOME|FACTORY_DSH|BIFROST_API_KEY|DEEPSEEK_API_KEY|OPENAI_API_KEY)$/.test(k));',
          '// 1. the host path itself must not be reachable from inside.',
          'const hostPathReachable = fs.existsSync(HOST_HOME);',
          '// 2. no directory named like the factory private state, and no operator key file.',
          'const hits = [];',
          'const walk = (dir, depth) => {',
          '  if (depth > 6) return;',
          '  let items = [];',
          '  try { items = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }',
          '  for (const item of items) {',
          "    const full = (dir === '/' ? '' : dir) + '/' + item.name;",
          "    if (item.name === 'evaluator.key' || (item.isDirectory() && item.name === '.factory')) hits.push(full);",
          "    if (item.isDirectory() && !['/proc', '/sys', '/dev'].includes(full)) walk(full, depth + 1);",
          '  }',
          '};',
          '// Targeted roots, not `/`: a full walk of the image took 30s under emulation, and',
          '// the roots that could plausibly hold operator state are the ones worth checking.',
          "for (const root of ['/root', '/home', '/workspace', '/tmp', '/opt', '/etc', '/usr/local', '/srv', '/mnt']) walk(root, 0);",
          '// 3. nothing in this process environment carries the key material.',
          "const environ = fs.readFileSync('/proc/self/environ', 'utf8');",
          'const envLeak = environ.includes(KEY) || /BIFROST_API_KEY=|DEEPSEEK_API_KEY=|EVALUATOR_PRIVATE/i.test(environ);',
          'console.log(JSON.stringify({ leaks, hostPathReachable, hits: hits.slice(0, 5), envLeak }));',
          'process.exit(leaks.length === 0 && !hostPathReachable && hits.length === 0 && !envLeak ? 0 : 1);',
        ].join('\n'),
        'utf8',
      );

      const inside = await runProbe('', { scriptFile: '/workspace/probe-45.js' });
      expect(inside.exitCode, 'no factory env var, no holdout path, no key material inside').toBe(
        0,
      );

      // The runner additionally refuses to *build* such a mount, so the property does not
      // depend on an operator remembering not to pass one.
      // `copyCheckout: false`, because the dangerous case is mounting the store *itself*.
      // With the default copy the runner mounts a temp copy, which is already safe — and a
      // test that passed that way would be asserting the copy, not the guard.
      const guard = createContainerRunner({
        image: WALL_IMAGE,
        cwd: worktree,
        copyCheckout: false,
        forbidMountsUnder: [fakeHome],
        prepare: () => join(fakeHome, 'holdout'),
      });
      const refused = await guard.run(runInput(['node', '-e', 'process.exit(0)'], 5_000));
      expect(refused.exitCode, 'a mount of the holdout home is refused, not measured').toBeNull();
      expect(refused.timedOut).toBe(false);
      expect(leftovers()).toEqual([]);
    } finally {
      rmSync(fakeHome, { recursive: true, force: true });
    }
  }, 180_000);

  it('[@docker] E2E-46: the cgroup limits are the ones the runner set, and a fork storm is capped', async () => {
    // 256 MiB and 64 pids, read back from the cgroup the container is actually in: this is
    // the flag taking effect, not the flag being passed.
    const expectedMemory = String(256 * 1024 * 1024);
    const expectedPids = '64';
    const result = await runProbe(
      `const fs=require('fs');
const read=(p)=>{try{return fs.readFileSync(p,'utf8').trim()}catch(e){return 'ERR:'+e.code}};
const mem=read('/sys/fs/cgroup/memory.max');
const pids=read('/sys/fs/cgroup/pids.max');
const {spawn}=require('child_process');
const kids=[];
const tryOne=()=>new Promise((res)=>{const c=spawn('/bin/sleep',['10'],{stdio:'ignore'});
  c.once('spawn',()=>{kids.push(c);res(true)});c.once('error',()=>res(false));});
(async()=>{
  let spawned=0, capHit=false;
  while(spawned < 400){ const ok=await tryOne(); if(!ok){capHit=true;break;} spawned+=1; }
  console.log(JSON.stringify({mem,pids,spawned,capHit}));
  process.exit(mem === ${JSON.stringify(expectedMemory)} && pids === ${JSON.stringify(expectedPids)} && spawned < 400 && capHit ? 0 : 1);
})();`,
      { memoryLimit: '256m', pidsLimit: 64, timeoutMs: 120_000 },
    );

    expect(result.exitCode, 'cgroup limits match the flags and the fork storm hits the cap').toBe(
      0,
    );
    expect(leftovers()).toEqual([]);
  }, 180_000);

  it('[@docker] a timed-out scenario leaves no container behind (the client is not the container)', async () => {
    // The container outlives the `docker run` client, so a timeout that killed only the
    // client would leave a hung scenario holding its memory and pid budget.
    const timedOut = await runner().run(
      runInput(['node', '-e', 'setInterval(()=>{},1000)'], 1_500),
    );

    expect(timedOut.timedOut).toBe(true);
    expect(
      timedOut.exitCode,
      'a timed-out run is unmeasured, never a pass and never a failure',
    ).toBeNull();

    let remaining = leftovers();
    for (let attempt = 0; attempt < 20 && remaining.length > 0; attempt += 1) {
      await new Promise((resolvePromise) => setTimeout(resolvePromise, 250));
      remaining = leftovers();
    }
    expect(remaining, 'no container from this suite may outlive its run').toEqual([]);
  }, 120_000);

  it('[@docker] the image under test is pinned by content, not by a mutable tag', async () => {
    // A locally built image has no registry digest, so the tag is the only handle — the
    // content id is the pin, and the caller records it in the verdict's `wallVersion`.
    expect(imageId, 'the image must be a content-addressed build').toMatch(IMAGE_ID_PATTERN);
    expect(imageContentId(WALL_IMAGE), 'the tag must not have been repointed mid-suite').toBe(
      imageId,
    );
  });
});
