/**
 * The worker's container (E2E-45): the turn runs inside `factory-env`, and killing it leaves
 * nothing behind.
 *
 * ## What is being proved, and what is deliberately replaced
 *
 * Two things are real here and one is a stand-in:
 *
 *   - **Real:** the image (built from `docker/factory-env`, node 26.12.1, `uid 10001(factory)`), the
 *     launch path (`docker run` with `--network none --read-only --tmpfs /tmp --memory
 *     --pids-limit`), the mounts, the labels, the kill, the sweep, and the whole ledger path from
 *     `run` through `recover`.
 *   - **Stand-in:** the `dsh` *inside* the image. A real turn needs a model call, which no spec may
 *     make, so a derived image replaces `/usr/local/bin/dsh` with a script that answers
 *     `--version` with the pinned string and emits the NDJSON stream the adapter folds. That is
 *     the same substitution `packages/dsh-adapter/tests/executor.test.ts` makes on the host, moved
 *     one layer out: what these specs test is the *isolation and kill* path, not DSH's behaviour.
 *
 * The host has **no `dsh` on `PATH`** in these specs (`NO_DSH_PATH`). A turn that produced a
 * receipt with no host `dsh` can only have run inside the image.
 *
 * ## E2E-45's shape
 *
 * `run` → poll `docker ps` for the worker container → `docker kill` it → the launch is refused
 * with `ATTEMPT_AMBIGUOUS` (exit 4), no receipt, exactly one attempt → age the lease the way
 * `e2e/cli/default/07-seams.test.ts` documents (the CLI has no knob for the TTL on purpose) →
 * `recover` marks the attempt `ambiguous` and **relaunches nothing** → a second `recover` is
 * idempotent → and after all of it, no container labelled for the attempt exists.
 */
import { spawn, spawnSync } from 'node:child_process';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  CLI_MAIN,
  baseEnv,
  newFactoryHome,
  runFactory,
  specFor,
  submitUnit,
} from '../../harness/factory.ts';
import { createFixtureRepo, type FixtureRepo } from '../../harness/fixture.ts';
import { openStore } from '../../../packages/store/src/index.ts';

/** The image `docker/factory-env/Dockerfile` builds against node 26.12.1 + dsh 0.2.1-rc.5. */
const BASE_IMAGE = 'factory-env:rc5';
/**
 * The docker client, resolved to an absolute path.
 *
 * The e2e harness runs the CLI with `NO_DSH_PATH` (node + POSIX defaults, no `dsh`), which does
 * not include `/usr/local/bin` on macOS — so a bare `docker` from `PATH` is `ENOENT` inside the
 * child. Pinning the absolute path keeps the "no host `dsh`" property *and* lets the probe find
 * the daemon.
 */
function resolveDocker(): string {
  const explicit = (process.env['FACTORY_DOCKER_BIN'] ?? '').trim();
  if (explicit !== '') return explicit;
  const which = spawnSync('/usr/bin/which', ['docker'], { encoding: 'utf8' });
  const found = (which.stdout ?? '').trim();
  return (which.status ?? 1) === 0 && found !== '' ? found : 'docker';
}

const DOCKER = resolveDocker();
const BUILD_COMMAND = `docker build --tag ${BASE_IMAGE} docker/factory-env`;

function docker(
  args: readonly string[],
  timeoutMs = 60_000,
): { ok: boolean; out: string; err: string } {
  const run = spawnSync(DOCKER, [...args], { encoding: 'utf8', timeout: timeoutMs });
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
const SUITE = `the worker's container${SKIP_REASON === null ? '' : ` — SKIPPED: ${SKIP_REASON}`}`;

/**
 * The `dsh` stand-in: the success stream, a session log under `$DSH_HOME`, and the process facts
 * the spec asserts on. `id -u` and `$HOME` are printed as NDJSON so they travel through the same
 * fold a real turn's text does — the receipt path, not a side channel.
 */
const STUB_SUCCESS = `#!/bin/sh
set -eu
if [ "\${1:-}" = "--version" ]; then
  printf '%s\\n' "0.2.1-rc.5"
  exit 0
fi
printf '%s\\n' '{"type":"session","sessionId":"sess-container-success"}'
printf '%s\\n' '{"type":"status","phase":"turn_start","turn":1}'
# Outside the heredoc on purpose: a quoted heredoc does not expand, and the whole point of this
# line is that the shell inside the container reports its own identity back through the NDJSON the
# adapter folds into the receipt.
printf '{"type":"text","text":"IDENTITY uid=%s home=%s dsh_home=%s cwd=%s"}\\n' \
  "$(id -u)" "$HOME" "$DSH_HOME" "$(pwd)"
# The boundary, tested from inside rather than asserted from outside. The clone is
# <factoryHome>/state/attempts/<attempt>, so three levels up is the factory root: the holdout
# corpus and the evaluator key are *right there* on the host, and not mounted. If a mount ever
# widens, this line says LEAK and the spec goes red.
factory_root=$(cd "$(pwd)/../../.." && pwd)
for rel in holdout/corpus.txt keys/evaluator.key; do
  target="$factory_root/$rel"
  if [ -e "$target" ] && cat "$target" >/dev/null 2>&1; then
    printf '{"type":"text","text":"LEAK %s"}\\n' "$target"
  else
    printf '{"type":"text","text":"NOLEAK %s"}\\n' "$target"
  fi
done
# The root filesystem is read-only. Probe the image's own home, which *is* writable when the
# root is not mounted read-only (uid 10001 owns it) — so this line distinguishes the flag rather
# than re-testing that a non-root user cannot write the root directory.
if touch /home/factory/pwned 2>/dev/null; then
  printf '%s\\n' '{"type":"text","text":"ROOT writable /home/factory"}'
else
  printf '%s\\n' '{"type":"text","text":"ROOT read-only /home/factory"}'
fi
if [ -S /var/run/docker.sock ]; then
  printf '%s\\n' '{"type":"text","text":"SOCK present /var/run/docker.sock"}'
else
  printf '%s\\n' '{"type":"text","text":"SOCK absent /var/run/docker.sock"}'
fi
cat <<'EOF'
{"type":"tool_call","callId":"c1","tool":"bash","input":{"command":"pwd"}}
{"type":"tool_result","callId":"c1","tool":"bash","status":"ok","content":[{"type":"text","text":"ok"}]}
{"type":"turn_end","turn":1,"reason":{"kind":"completed"}}
{"type":"final","text":"finished inside the container"}
EOF
slug=$(pwd | tr '/' '-' | sed 's/^-/--/; s/-$/-/')
mkdir -p "$DSH_HOME/sessions/\${slug}/sess-container-success"
printf '%s\\n' '{"type":"usage","session":"sess-container-success","tokens":10}' \
  > "$DSH_HOME/sessions/\${slug}/sess-container-success/session.v4.jsonl"
exit 0
`;

/** A turn that will not finish: enough evidence to know it started, then it waits to be killed. */
const STUB_HANG = `#!/bin/sh
set -eu
if [ "\${1:-}" = "--version" ]; then
  printf '%s\\n' "0.2.1-rc.5"
  exit 0
fi
printf '%s\\n' '{"type":"session","sessionId":"sess-container-hang"}'
printf '%s\\n' '{"type":"status","phase":"turn_start","turn":1}'
sleep 300
`;

const SUCCESS_IMAGE = 'factory-env:e2e-worker-success';
const HANG_IMAGE = 'factory-env:e2e-worker-hang';

let scratch: string;
let fixture: FixtureRepo;

/** A derived image: the shipped worker, with `dsh` replaced by one stub. Cached base ⇒ ~1 s. */
function buildStubImage(tag: string, script: string, name: string): void {
  const dir = join(scratch, `image-${name}`);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'dsh'), script, { mode: 0o755 });
  chmodSync(join(dir, 'dsh'), 0o755);
  writeFileSync(
    join(dir, 'Dockerfile'),
    [
      `FROM ${BASE_IMAGE}`,
      // The image ends with `USER 10001:10001`, so a build-time `RUN chmod` would fail on a
      // root-owned copy. `COPY` preserves the source mode instead, which is 0755 above.
      `COPY --chmod=0755 --chown=10001:10001 dsh /usr/local/bin/dsh`,
      '',
    ].join('\n'),
  );
  const built = docker(['build', '--tag', tag, dir], 300_000);
  if (!built.ok) {
    throw new Error(`docker build ${tag} failed:\n${built.err}\n${built.out}`);
  }
}

const suite = describe.skipIf(SKIP_REASON !== null);

suite(SUITE, () => {
  beforeAll(() => {
    scratch = mkdtempSync(join(tmpdir(), 'factory-worker-container-'));
    buildStubImage(SUCCESS_IMAGE, STUB_SUCCESS, 'success');
    buildStubImage(HANG_IMAGE, STUB_HANG, 'hang');
    fixture = createFixtureRepo();
  }, 300_000);

  afterAll(() => {
    fixture?.cleanup();
    if (scratch !== undefined) rmSync(scratch, { recursive: true, force: true });
  });

  /**
   * The provisioned profile template the per-attempt home is seeded from.
   *
   * `scripts/provision-dsh-home.sh` writes it from a real `dsh`, which this host does not have —
   * and the stub image ignores the profile anyway. The spec seeds the same three files the
   * adapter's own fixture seeds (`packages/dsh-adapter/tests/helpers.ts`), so the launch path under
   * test is the real one: provisioning is a prerequisite here, not the subject.
   */
  function seedTemplate(home: string): void {
    const template = join(home, 'dsh-home', 'worker', 'profiles', 'factory-worker');
    mkdirSync(template, { recursive: true });
    writeFileSync(join(template, 'cordis.yml'), '[]\n');
    writeFileSync(join(template, 'cordis.patch.yml'), '[]\n');
    writeFileSync(
      join(template, 'package.json'),
      `${JSON.stringify(
        {
          name: 'dsh-profile-factory-worker',
          private: true,
          dependencies: {},
          dsh: { profile: { bundles: ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-headless'] } },
        },
        null,
        2,
      )}\n`,
    );
  }

  /** A unit, qualified, with the container as the only difference from a host run. */
  function containerUnit(home: string, image: string): string {
    seedTemplate(home);
    const { unitId } = submitUnit(home, { spec: specFor({ baseRev: fixture.baseRev }) });
    const qualified = runFactory(['qualify', unitId, '--cold-start', '--json'], { home });
    expect(qualified.code).toBe(0);
    return unitId;
  }

  function containerEnv(home: string, image: string): Record<string, string> {
    return {
      FACTORY_WORKER_ISOLATION: 'container',
      FACTORY_WORKER_IMAGE: image,
      FACTORY_DOCKER_BIN: DOCKER,
      FACTORY_PRISTINE_REPO: fixture.repo,
      FACTORY_REPO: 'fixture',
      // A launch needs a proxy URL and a model id even when nothing may spend: the overlay names
      // the door. Nothing calls it — the container has no network, and the stub never dials — so
      // no model is reached and no key is needed.
      FACTORY_PROXY_BASE_URL: 'http://127.0.0.1:4010',
      FACTORY_MODEL_ID: 'factory-worker-tier',
      ...baseEnv(home),
    };
  }

  /** Containers still alive for the one attempt under `home`. */
  function attemptContainers(home: string, unitId: string): string[] {
    const attemptId = attemptIdOf(home, unitId);
    if (attemptId === null) return [];
    const listed = docker(['ps', '-aq', '--filter', `label=org.factory.attempt=${attemptId}`]);
    return listed.out === '' ? [] : listed.out.split('\n').map((line) => line.trim());
  }

  function attemptIdOf(home: string, unitId: string): string | null {
    const dir = join(home, 'attempts', unitId);
    if (!existsSync(dir)) return null;
    const entries = readdirSafe(dir);
    return entries.length === 0 ? null : (entries[entries.length - 1] ?? null);
  }

  function readdirSafe(path: string): string[] {
    try {
      return (readdirSync(path) as string[]).sort();
    } catch {
      return [];
    }
  }

  function launchRecord(home: string, unitId: string): Record<string, unknown> {
    const attemptId = attemptIdOf(home, unitId);
    if (attemptId === null) throw new Error('no attempt directory');
    const path = join(home, 'attempts', unitId, attemptId, 'launch.json');
    return JSON.parse(readFileSync(path, 'utf8')) as Record<string, unknown>;
  }

  function recordDirOf(home: string, unitId: string): string {
    const attemptId = attemptIdOf(home, unitId);
    if (attemptId === null) throw new Error('no attempt directory');
    return join(home, 'attempts', unitId, attemptId);
  }

  it('[@docker] runs the turn in the image, and the record says what it ran inside', () => {
    const home = newFactoryHome();
    // The two things E2E-33 is about, planted where the factory actually keeps them. The host
    // must be able to read both — that is the positive control that makes the container's
    // refusal meaningful.
    mkdirSync(join(home, 'holdout'), { recursive: true });
    writeFileSync(
      join(home, 'holdout', 'corpus.txt'),
      'holdout corpus: must not be readable in the worker\n',
    );
    mkdirSync(join(home, 'keys'), { recursive: true });
    writeFileSync(join(home, 'keys', 'evaluator.key'), 'sk-evaluator-must-not-leak\n');
    const unitId = containerUnit(home, SUCCESS_IMAGE);

    // No `dsh` on PATH: a receipt from a host child is not possible.
    const run = runFactory(['run', unitId, '--json'], {
      home,
      env: containerEnv(home, SUCCESS_IMAGE),
      timeoutMs: 180_000,
    });

    // Exit 5 is the *wall's* honest `unknown` on this host (no holdout corpus, no declared suite),
    // not a launch failure: the turn ran, the receipt was stored, and the verdict says the
    // measurement is missing. What must not appear is a refusal.
    expect(run.code, run.stderr).toBe(5);
    expect(run.stderr).not.toMatch(/EXECUTOR_UNAVAILABLE|runbook:/u);
    const dispatched = JSON.parse(run.stdout) as Record<string, unknown>;
    expect(dispatched['state']).toBe('dispatched');
    expect(dispatched['receiptSha']).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(dispatched['outcome']).toBe('unknown');

    const record = launchRecord(home, unitId);
    // `container: null` would mean a host child, which is the failure this spec exists to see.
    expect(record['container']).not.toBeNull();
    const container = record['container'] as Record<string, unknown>;
    expect(container['image']).toBe(SUCCESS_IMAGE);
    expect(container['user']).toBe('10001:10001');
    expect(container['network']).toBe('none');
    expect(container['readOnlyRoot']).toBe(true);
    expect(container['memoryLimit']).toBe('2g');
    expect(container['pidsLimit']).toBe(512);
    expect(container['tmpfs']).toStrictEqual(['/tmp']);
    const mounts = container['mounts'] as { path: string; mode: string }[];
    const dir = recordDirOf(home, unitId);
    // The record names the clone (`mountedAt`) and the home (`dshHome`) itself, so the mount
    // assertion compares the record against the record's own paths — no layout restated in the
    // spec, which is the property "the mount target is the clone" is supposed to hold for.
    const attemptDir = String(record['mountedAt']);
    const homeDir = String(record['dshHome']);
    expect(mounts).toContainEqual({ path: attemptDir, mode: 'rw' });
    expect(mounts).toContainEqual({ path: homeDir, mode: 'rw' });
    expect(mounts).toContainEqual({ path: dir, mode: 'ro' });
    expect(attemptDir.startsWith(dir)).toBe(false);
    expect(homeDir.startsWith(attemptDir)).toBe(false);
    // The boundary claim, spelled out: what the worker did not get.
    const denied = container['mountsDenied'] as string[];
    expect(denied).toContain(join(home, 'keys'));
    expect(denied).toContain('/var/run/docker.sock');
    const labels = container['labels'] as Record<string, string>;
    expect(labels['org.factory.attempt']).toBe(attemptIdOf(home, unitId));

    // The candidate's own process saw the container's identity, not the host's.
    const stdout = readFileSync(join(dir, 'stdout.log'), 'utf8');
    expect(stdout).toContain('uid=10001');
    expect(stdout).toContain(`home=${homeDir}`);
    expect(stdout).toContain(`dsh_home=${homeDir}`);
    expect(stdout).toContain(`cwd=${attemptDir}`);
    // The host home is not visible, not even as a string the worker could reuse.
    expect(stdout).not.toContain(`home=${process.env['HOME'] ?? '/nonexistent'}`);
    // The control: the host can read both files this attempt was denied.
    expect(readFileSync(join(home, 'holdout', 'corpus.txt'), 'utf8')).toContain('holdout corpus');
    expect(readFileSync(join(home, 'keys', 'evaluator.key'), 'utf8')).toContain('sk-evaluator');
    // The worker tried the same paths from inside the container, three levels up from its clone,
    // and could not open either. This is the filesystem half of E2E-44's boundary, measured for
    // the *worker* rather than for the wall's scenario container.
    expect(stdout).toContain(`NOLEAK ${join(home, 'holdout', 'corpus.txt')}`);
    expect(stdout).toContain(`NOLEAK ${join(home, 'keys', 'evaluator.key')}`);
    // `"text":"LEAK ` cannot match the `NOLEAK` lines above: the quote is the discriminator.
    expect(stdout).not.toContain('"text":"LEAK ');
    expect(stdout).toContain('ROOT read-only /home/factory');
    expect(stdout).toContain('SOCK absent /var/run/docker.sock');
    // The fold still produced a receipt from the container's stdout, and it is in the ledger
    // under the sha the run returned.
    const store = openStore({ dir: join(home, 'state') });
    try {
      const row = store.getReceiptBySha(String(dispatched['receiptSha']));
      expect(row).not.toBeNull();
      const receipt = row?.receipt as unknown as Record<string, unknown>;
      expect(receipt['sessionId']).toBe('sess-container-success');
      expect(receipt['exitCode']).toBe(0);
    } finally {
      store.close();
    }
    // The sweep is part of the successful path too: nothing may outlive an attempt.
    expect(attemptContainers(home, unitId)).toEqual([]);
  }, 180_000);

  it('[@docker] E2E-45: a killed worker container is ambiguous, dispatched once, and leaves nothing behind', async () => {
    const home = newFactoryHome();
    const unitId = containerUnit(home, HANG_IMAGE);
    const env = containerEnv(home, HANG_IMAGE);

    const child = spawn(process.execPath, [CLI_MAIN, 'run', unitId, '--json'], {
      env: { ...process.env, ...env },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout?.setEncoding('utf8');
    child.stderr?.setEncoding('utf8');
    child.stdout?.on('data', (chunk: string) => {
      stdout += chunk;
    });
    child.stderr?.on('data', (chunk: string) => {
      stderr += chunk;
    });
    const exited = new Promise<number | null>((resolve) => child.once('close', resolve));

    // Wait for the worker container to exist, then kill it the way an operator would. The name
    // prefix is ours alone (`factory-worker-<attemptId>`), so another suite's containers are not
    // candidates.
    const containerId = await waitFor(async () => {
      const listed = docker(['ps', '-q', '--filter', 'name=factory-worker-']);
      const first = listed.out.split('\n')[0] ?? '';
      return first === '' ? null : first;
    }, 60_000);
    expect(containerId).not.toBeNull();

    const killed = docker(['kill', containerId ?? '']);
    expect(killed.ok).toBe(true);

    const code = await exited;
    // `ATTEMPT_AMBIGUOUS` is exit 4: the turn ran and nothing vouched for it. Exit 8 would mean
    // the launcher refused; exit 9/1 would mean a failure was claimed about work nobody observed.
    expect(code, `stdout:\n${stdout}\nstderr:\n${stderr}`).toBe(4);
    expect(stdout).toMatch(/ATTEMPT_AMBIGUOUS/u);
    expect(stderr + stdout).toMatch(/ambiguous/u);

    const attemptId = attemptIdOf(home, unitId);
    expect(attemptId).not.toBeNull();
    // Nothing outlived the kill: not the container, and not a container the sweep forgot.
    expect(attemptContainers(home, unitId)).toEqual([]);
    // No receipt was invented for a turn nobody saw end.
    const noReceipt = openStore({ dir: join(home, 'state') });
    try {
      expect(noReceipt.latestReceiptForUnit(unitId)).toBeNull();
    } finally {
      noReceipt.close();
    }

    // Exactly one attempt, and it is not `failed`: nobody observed it end, which is `ambiguous`
    // and not a claim about the work.
    const store = openStore({ dir: join(home, 'state') });
    const attemptsBefore = store.listAttemptsForUnit(unitId);
    expect(attemptsBefore).toHaveLength(1);
    expect(attemptsBefore[0]?.state).toBe('running');
    store.close();

    // The lease is what `recover` uses as a dead-man switch, and its TTL has no CLI knob on
    // purpose (a shorter lease would be a lever on when the factory calls an attempt ambiguous).
    // Ageing the row `recover` reads is the precedent set by `e2e/cli/default/07-seams.test.ts`:
    // the reconciliation under test is the real one.
    const db = new DatabaseSync(join(home, 'state', 'factory.db'));
    try {
      db.exec("UPDATE leases SET expires_at = '2020-01-01T00:00:00.000Z'");
    } finally {
      db.close();
    }

    const recovered = runFactory(['recover', '--json'], { home, env });
    expect(recovered.code).toBe(4);
    expect(JSON.parse(recovered.stdout) as Record<string, unknown>).toMatchObject({ ambiguous: 1 });

    const after = openStore({ dir: join(home, 'state') });
    const attemptsAfter = after.listAttemptsForUnit(unitId);
    expect(attemptsAfter).toHaveLength(1);
    expect(attemptsAfter[0]?.state).toBe('ambiguous');
    after.close();

    // Idempotent: a second recover cannot re-dispatch, re-mark, or mint a second attempt.
    const second = runFactory(['recover', '--json'], { home, env });
    expect(second.code).toBe(0);
    const afterSecond = openStore({ dir: join(home, 'state') });
    expect(afterSecond.listAttemptsForUnit(unitId)).toHaveLength(1);
    expect(afterSecond.listAttemptsForUnit(unitId)[0]?.state).toBe('ambiguous');
    afterSecond.close();
    expect(attemptContainers(home, unitId)).toEqual([]);
  }, 180_000);

  it('[@docker] refuses rather than degrading: a container request with no image is exit 8, not a host run', () => {
    const home = newFactoryHome();
    const unitId = containerUnit(home, SUCCESS_IMAGE);

    const run = runFactory(['run', unitId, '--json'], {
      home,
      env: {
        ...containerEnv(home, SUCCESS_IMAGE),
        FACTORY_WORKER_IMAGE: 'factory-env:definitely-not-built',
      },
      timeoutMs: 60_000,
    });

    // The whole point of the task: no silent fallback to a host process.
    expect(run.code).toBe(8);
    const said = `${run.stdout}${run.stderr}`;
    // The code is the environment class, and since the refusal was split it is the precise one:
    // `CONTAINER_UNAVAILABLE` says the turn could run, just not inside the image that was asked
    // for; `EXECUTOR_UNAVAILABLE` would have meant there is no way to run a turn at all. At 2am
    // the difference is "build the image" versus "install the runtime".
    expect(said).toMatch(/CONTAINER_UNAVAILABLE/u);
    expect(said).not.toMatch(/EXECUTOR_UNAVAILABLE/u);
    expect(said).toContain('factory-env:definitely-not-built');
    expect(said).toContain(BUILD_COMMAND);
    expect(said).toContain('runbook:');
    // Nothing was reserved and no attempt directory was cut.
    expect(existsSync(join(home, 'attempts', unitId))).toBe(false);
  }, 120_000);
});

/** Poll `check` until it returns something truthy, or fail the spec with what it saw. */
async function waitFor<T>(check: () => Promise<T | null>, timeoutMs: number): Promise<T | null> {
  const deadline = Date.now() + timeoutMs;
  let last: T | null = null;
  while (Date.now() < deadline) {
    last = await check();
    if (last !== null) return last;
    await new Promise((resolve) => setTimeout(resolve, 150));
  }
  return last;
}
