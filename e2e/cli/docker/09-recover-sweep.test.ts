/**
 * E2E-45's orphan-sweep clause: a `SIGKILL`ed control plane's container is swept by the next
 * process that knows the attempt id.
 *
 * The id is E2E-45, not a new number. `docs/planning/dark-factory-dsh/e2e-tests.md:188` defines
 * E2E-45 as "Killing the worker container mid-attempt yields `ambiguous` + no redispatch", and its
 * acceptance column ends with "orphan sweep recorded (session id, process group)"; E2E-51 is
 * re-scoped as "process-group reap proven offline; container descendants → E2E-45". The id is
 * shared the way E2E-43 and E2E-44 are: `08-worker-container.test.ts` measures the `docker kill`
 * → `ambiguous`, one attempt, no redispatch half, and this spec measures the orphan sweep that
 * E2E-45's acceptance column names. E2E-46 is the cgroup-limits spec in `07-isolation.test.ts` and
 * is not this file.
 *
 * One deliberate difference from the plan's wording: the acceptance column says the sweep is
 * recorded as "(session id, process group)", which is how a host child is identified. A
 * container's identity here is `org.factory.attempt=<attemptId>` — the label the runner sets and
 * the only thing the sweep filters on — so that is what this clause asserts. Sweeping by session
 * id would mean listing containers by a label nothing writes.
 *
 * ## The defect this spec exists for
 *
 * `--rm` is a promise about the *client's* lifetime. `e2e/cli/docker/08-worker-container.test.ts`
 * kills the worker container while the control plane is alive, so the launcher's own sweep runs
 * and nothing is left behind. A control plane killed with `SIGKILL` executes none of its exit
 * paths: the `docker run` client is orphaned and the container keeps running, labelled
 * `org.factory.attempt=<attemptId>`, with nothing left to say so. This spec is the positive
 * control for that, and then the proof that `factory recover` closes it.
 *
 * ## What is real, and what is the stand-in
 *
 * Real: the image (`factory-env`, node 26.12.1, uid 10001), the launch path, the labels, the
 * `SIGKILL`, the lease, the store, `docker ps`/`docker rm -f`, and the whole `run → recover`
 * path. Stand-in: the `dsh` *inside* the image, replaced with a script that answers `--version`
 * with the pinned string, emits the start of a turn and then sleeps. A spec may not call a model;
 * what is under test here is the lifecycle of the container, not the turn.
 *
 * The host has no `dsh` on `PATH` (`NO_DSH_PATH`), so a receipt from a host child is impossible in
 * the container case; the host case supplies its own stub through `DSH_BIN` and asserts the launch
 * record says `container: null`.
 *
 * ## This clause's shape
 *
 * 1. **Positive control.** `run` in the hang image → wait for the worker container → `SIGKILL`
 *    the control plane mid-turn → the container is *still listed*. That is the orphan; if this
 *    assertion ever fails, the rest of the spec is not testing anything.
 * 2. **The fix.** Age the lease (the CLI has no TTL knob on purpose), then `recover` → exit 4
 *    (the `ATTEMPT_AMBIGUOUS` class), the attempt recorded `ambiguous`, the container gone
 *    (`docker ps -aq --filter label=…` is empty), and the output names the id it removed.
 * 3. **Fail-soft, never a false clean.** The sweep result is a value in `--json` (`status`,
 *    `removed`, `remaining`, `reason`), not a sentence. The negative case below proves the sweep
 *    never calls docker for a host attempt, and `apps/cli/src/recover.test.ts` proves a docker it
 *    cannot reach is `failed` with a reason while the exit code stays 4.
 * 4. **Idempotent.** A second `recover` reconciles nothing, sweeps nothing, and exits 0.
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
  jsonOf,
  newFactoryHome,
  runFactory,
  specFor,
  submitUnit,
} from '../../harness/factory.ts';
import { createFixtureRepo, type FixtureRepo } from '../../harness/fixture.ts';

/** The image `docker/factory-env/Dockerfile` builds against node 26.12.1 + dsh 0.2.1-rc.5. */
const BASE_IMAGE = 'factory-env:rc5';

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
const SUITE = `the recover-side sweep${SKIP_REASON === null ? '' : ` — SKIPPED: ${SKIP_REASON}`}`;

/** A turn that will not finish: enough evidence to know it started, then it waits to be killed. */
const STUB_HANG = `#!/bin/sh
set -eu
if [ "\${1:-}" = "--version" ]; then
  printf '%s\\n' "0.2.1-rc.5"
  exit 0
fi
printf '%s\\n' '{"type":"session","sessionId":"sess-recover-sweep"}'
printf '%s\\n' '{"type":"status","phase":"turn_start","turn":1}'
sleep 300
`;

const HANG_IMAGE = 'factory-env:e2e-recover-sweep-hang';

let scratch: string;
let fixture: FixtureRepo;
/**
 * Attempt ids whose containers this spec may have to clean up.
 *
 * A red assertion must not leak a running container into the machine running the suite; the
 * afterAll hook removes whatever is left under exactly these labels — the same filter the sweep
 * uses, never a name-prefix guess.
 */
const touchedAttempts = new Set<string>();
/** Host worker pids started by the negative case, in case a red assertion leaves one running. */
const hostWorkerPids = new Set<number>();

/** A derived image: the shipped worker, with `dsh` replaced by one stub. Cached base ⇒ ~1 s. */
function buildStubImage(tag: string, script: string, name: string): void {
  const dir = join(scratch, `image-${name}`);
  mkdirSync(dir, { recursive: true });
  const bin = join(dir, 'dsh');
  writeFileSync(bin, script, { mode: 0o755 });
  chmodSync(bin, 0o755);
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

/**
 * A host `dsh` stand-in for the negative case: version probe, turn start, then it records its own
 * pid and waits. `exec` matters — the pid the spec records has to be the one it later kills.
 */
function writeHostStub(pidFile: string): string {
  const dir = join(scratch, 'host-stub');
  mkdirSync(dir, { recursive: true });
  const path = join(dir, 'dsh');
  writeFileSync(
    path,
    [
      '#!/bin/sh',
      'set -eu',
      'if [ "${1:-}" = "--version" ]; then',
      '  printf \'%s\\n\' "0.2.1-rc.5"',
      '  exit 0',
      'fi',
      'printf \'%s\\n\' \'{"type":"session","sessionId":"sess-recover-host-hang"}\'',
      'printf \'%s\\n\' \'{"type":"status","phase":"turn_start","turn":1}\'',
      `printf '%s\\n' "$$" > ${JSON.stringify(pidFile)}`,
      'exec sleep 300',
      '',
    ].join('\n'),
    { mode: 0o755 },
  );
  chmodSync(path, 0o755);
  return path;
}

const suite = describe.skipIf(SKIP_REASON !== null);

suite(SUITE, () => {
  beforeAll(() => {
    scratch = mkdtempSync(join(tmpdir(), 'factory-recover-sweep-'));
    buildStubImage(HANG_IMAGE, STUB_HANG, 'hang');
    fixture = createFixtureRepo();
  }, 300_000);

  afterAll(() => {
    // Containers first: removing one also releases the orphaned `docker run` client attached to
    // it. Then any host worker a red assertion left behind.
    for (const attemptId of touchedAttempts) {
      const ids = attemptContainersFor(attemptId);
      if (ids.length > 0) docker(['rm', '-f', ...ids], 120_000);
    }
    for (const pid of hostWorkerPids) {
      try {
        process.kill(pid, 'SIGKILL');
      } catch {
        // Already gone: the test's own kill won the race, which is the expected case.
      }
    }
    fixture?.cleanup();
    if (scratch !== undefined) rmSync(scratch, { recursive: true, force: true });
  });

  /**
   * The provisioned profile template the per-attempt home is seeded from.
   *
   * `scripts/provision-dsh-home.sh` writes it from a real `dsh`, which this host does not have —
   * and both stubs ignore the profile. The spec seeds the same three files the adapter's own
   * fixture seeds (`packages/dsh-adapter/tests/helpers.ts`): provisioning is a prerequisite here,
   * not the subject.
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

  /** A unit, qualified, with the fixture mirror as its base. */
  function qualifiedUnit(home: string): string {
    seedTemplate(home);
    const { unitId } = submitUnit(home, { spec: specFor({ baseRev: fixture.baseRev }) });
    const qualified = runFactory(['qualify', unitId, '--cold-start', '--json'], { home });
    expect(qualified.code).toBe(0);
    return unitId;
  }

  /** The container launch's environment: the only difference from a host run. */
  function containerEnv(home: string, image: string): Record<string, string> {
    return {
      FACTORY_WORKER_ISOLATION: 'container',
      FACTORY_WORKER_IMAGE: image,
      FACTORY_DOCKER_BIN: DOCKER,
      FACTORY_PRISTINE_REPO: fixture.repo,
      FACTORY_REPO: 'fixture',
      FACTORY_PROXY_BASE_URL: 'http://127.0.0.1:4010',
      FACTORY_MODEL_ID: 'factory-worker-tier',
      ...baseEnv(home),
    };
  }

  /** The host launch's environment: no isolation, no image, a stub dsh on `DSH_BIN`. */
  function hostEnv(home: string, dshBin: string): Record<string, string> {
    return {
      DSH_BIN: dshBin,
      FACTORY_PRISTINE_REPO: fixture.repo,
      FACTORY_REPO: 'fixture',
      FACTORY_PROXY_BASE_URL: 'http://127.0.0.1:4010',
      FACTORY_MODEL_ID: 'factory-worker-tier',
      ...baseEnv(home),
    };
  }

  /** The ids `docker ps -aq` reports for one attempt label. The only filter this spec uses. */
  function attemptContainersFor(attemptId: string): string[] {
    const listed = docker(['ps', '-aq', '--filter', `label=org.factory.attempt=${attemptId}`]);
    return listed.out === '' ? [] : listed.out.split('\n').map((line) => line.trim());
  }

  function attemptContainers(home: string, unitId: string): string[] {
    const attemptId = attemptIdOf(home, unitId);
    return attemptId === null ? [] : attemptContainersFor(attemptId);
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

  function recordDirOf(home: string, unitId: string): string {
    const attemptId = attemptIdOf(home, unitId);
    if (attemptId === null) throw new Error('no attempt directory');
    return join(home, 'attempts', unitId, attemptId);
  }

  function launchRecord(home: string, unitId: string): Record<string, unknown> {
    return JSON.parse(
      readFileSync(join(recordDirOf(home, unitId), 'launch.json'), 'utf8'),
    ) as Record<string, unknown>;
  }

  /** What "that process is gone" looks like to `recover`: every lease in the past. */
  function ageLeases(home: string): void {
    const db = new DatabaseSync(join(home, 'state', 'factory.db'));
    try {
      db.exec("UPDATE leases SET expires_at = '2020-01-01T00:00:00.000Z'");
    } finally {
      db.close();
    }
  }

  /** Spawn `run`, capturing its streams; resolves when it exits. */
  function spawnRun(
    home: string,
    unitId: string,
    env: Record<string, string>,
  ): { child: ReturnType<typeof spawn>; exited: Promise<number | null>; streams: () => string } {
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
    const exited = new Promise<number | null>((resolve) =>
      child.once('close', (code) => resolve(code)),
    );
    return { child, exited, streams: () => `stdout:\n${stdout}\nstderr:\n${stderr}` };
  }

  it('[@docker] E2E-45 (orphan sweep): a SIGKILLed control plane orphans its container, and recover sweeps it by attempt label', async () => {
    const home = newFactoryHome();
    const unitId = qualifiedUnit(home);
    const env = containerEnv(home, HANG_IMAGE);
    const run = spawnRun(home, unitId, env);

    // ---- positive control: a real container, running, labelled for this attempt ----------
    const attemptId = await waitFor(async () => attemptIdOf(home, unitId), 60_000);
    expect(attemptId).not.toBeNull();
    if (attemptId === null) throw new Error('no attempt directory was created');
    touchedAttempts.add(attemptId);

    // `ps -q` (running only) rather than `ps -aq`: "exists" and "is running" are different facts,
    // and the orphan this spec is about is a *running* container.
    const containerId = await waitFor(async () => {
      const listed = docker(['ps', '-q', '--filter', `label=org.factory.attempt=${attemptId}`]);
      return listed.out === '' ? null : (listed.out.split('\n')[0] ?? null);
    }, 60_000);
    expect(containerId, 'the worker container never appeared').not.toBeNull();
    if (containerId === null) throw new Error('container id was not observed');

    // The record must say "container" before the sweep may act on it: `null` means host child.
    const record = launchRecord(home, unitId);
    expect(record['attemptId']).toBe(attemptId);
    expect(record['container']).not.toBeNull();
    expect((record['container'] as Record<string, unknown>)['image']).toBe(HANG_IMAGE);

    // ---- kill the *control plane*, not the container: `kill -9` mid-turn --------------------
    run.child.kill('SIGKILL');
    const killedCode = await run.exited;
    expect(killedCode).toBeNull();
    expect(run.child.signalCode).toBe('SIGKILL');

    // The orphan, asserted before `recover` runs. If this is empty, docker itself reaped the
    // container and the rest of the spec would prove nothing about the sweep.
    const orphaned = attemptContainersFor(attemptId);
    expect(orphaned).toContain(containerId);

    // ---- the fix: recover reconciles the attempt and sweeps its containers ------------------
    ageLeases(home);
    const recovered = runFactory(['recover', '--json'], { home, env });
    expect(recovered.code, `${recovered.stderr}\n${recovered.stdout}`).toBe(4);
    const payload = jsonOf(recovered);
    expect(payload['ambiguous']).toBe(1);

    // The defect first: the container is gone, and the answer to "is it gone?" is the daemon's
    // listing after the removal, not `docker rm`'s exit code.
    expect(attemptContainers(home, unitId)).toEqual([]);

    // Then the sweep as a value: status/removed/remaining/reason are data, not prose.
    const sweeps = payload['sweeps'] as Array<Record<string, unknown>>;
    expect(sweeps).toHaveLength(1);
    expect(sweeps[0]).toStrictEqual({
      attemptId,
      unitId,
      status: 'swept',
      image: HANG_IMAGE,
      removed: [containerId],
      remaining: [],
      reason: null,
      checkCommand: null,
    });

    // The text names what it removed, so a person reading stderr is not told "swept 1".
    expect(recovered.stderr).toContain(`swept: removed ${containerId}`);

    // ---- idempotent: a second recover reconciles nothing and sweeps nothing -----------------
    const second = runFactory(['recover', '--json'], { home, env });
    expect(second.code).toBe(0);
    expect(jsonOf(second)['sweeps']).toStrictEqual([]);
    expect(attemptContainers(home, unitId)).toEqual([]);
  }, 240_000);

  it('[@docker] does not sweep, and does not call docker, for an attempt whose record says container: null', async () => {
    const home = newFactoryHome();
    const unitId = qualifiedUnit(home);
    // A host launch is the honest way to produce a `container: null` record: the worker is a
    // real process here, and it outlives the SIGKILLed control plane exactly like the container
    // does — which is why "not swept" is a decision, not an absence of evidence.
    const pidFile = join(home, 'host-worker.pid');
    const dshBin = writeHostStub(pidFile);
    const run = spawnRun(home, unitId, hostEnv(home, dshBin));

    const workerPid = await waitFor(async () => {
      if (!existsSync(pidFile)) return null;
      const pid = Number(readFileSync(pidFile, 'utf8').trim());
      return Number.isInteger(pid) && pid > 0 ? pid : null;
    }, 60_000);
    expect(workerPid).not.toBeNull();
    if (workerPid === null) throw new Error('the host worker never recorded its pid');
    hostWorkerPids.add(workerPid);

    const attemptId = await waitFor(async () => attemptIdOf(home, unitId), 60_000);
    expect(attemptId).not.toBeNull();
    if (attemptId === null) throw new Error('no attempt directory was created');
    touchedAttempts.add(attemptId);

    const record = launchRecord(home, unitId);
    expect(record['attemptId']).toBe(attemptId);
    // The negative case's premise, asserted rather than assumed.
    expect(record['container']).toBeNull();

    run.child.kill('SIGKILL');
    expect(await run.exited).toBeNull();
    expect(run.child.signalCode).toBe('SIGKILL');
    // The host worker really is still alive: this is the same "it outlived the control plane"
    // fact as the orphaned container, and the sweep must not touch it (`recover` never signals a
    // worker, and only removes containers).
    expect(() => process.kill(workerPid, 0)).not.toThrow();

    // A docker client that records every invocation. If the sweep touches docker for a host
    // attempt, this file appears and the assertion below fails.
    const marker = join(home, 'docker-was-called');
    const fakeDocker = join(home, 'fake-docker');
    writeFileSync(
      fakeDocker,
      `#!/bin/sh\nprintf '%s\\n' "$*" >> ${JSON.stringify(marker)}\nexit 1\n`,
      { mode: 0o755 },
    );
    chmodSync(fakeDocker, 0o755);

    ageLeases(home);
    const recovered = runFactory(['recover', '--json'], {
      home,
      env: { ...hostEnv(home, dshBin), FACTORY_DOCKER_BIN: fakeDocker },
    });
    // The exit code is still the ambiguity's: the negative case is not a sweep failure.
    expect(recovered.code, `${recovered.stderr}\n${recovered.stdout}`).toBe(4);
    const sweeps = jsonOf(recovered)['sweeps'] as Array<Record<string, unknown>>;
    expect(sweeps).toHaveLength(1);
    expect(sweeps[0]).toMatchObject({
      attemptId,
      unitId,
      status: 'skipped',
      image: null,
      removed: [],
      remaining: [],
    });
    expect(String(sweeps[0]?.['reason'])).toMatch(/host child/u);
    // The proof that "needs no docker call" is true rather than asserted: the client was never
    // spawned. A `recover` that probed docker here would have written the marker (and, with
    // docker down, reported `failed`).
    expect(existsSync(marker)).toBe(false);
    expect(recovered.stderr).toMatch(/skipped:/u);

    // The host worker was left for a person, not signalled by recovery; the spec kills it.
    expect(() => process.kill(workerPid, 0)).not.toThrow();
    process.kill(workerPid, 'SIGKILL');
    hostWorkerPids.delete(workerPid);
  }, 240_000);
});

/** Poll `check` until it returns something other than null, or fail the spec with what it saw. */
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
