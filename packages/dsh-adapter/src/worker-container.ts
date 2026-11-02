/**
 * The worker's container: the launch path that runs the turn inside `factory-env`.
 *
 * Before this module the factory had exactly one way to run a turn — spawn `dsh` as a child of
 * this process — and the README said so. The wall's *scenarios* had a container
 * (`packages/wall/src/container.ts`); the *worker* did not, so a candidate model that escaped its
 * sandbox was fenced in by nothing but its own good behaviour. This is that fence.
 *
 * Three decisions are the whole design:
 *
 * 1. **Selection is a pure function of the environment and two probes.** `chooseWorkerIsolation`
 *    takes what docker said and returns `host`, `container`, or a refusal with the runbook line.
 *    Every branch is a spec that runs on a machine without docker, which is most machines; the
 *    branch that needs docker is the only one that does.
 * 2. **A refusal is not a fallback.** If the operator asked for `container` and docker, the image,
 *    or a flag the platform cannot honour is missing, the launch stops with
 *    `CONTAINER_UNAVAILABLE` (exit 8) and the build/start command to fix it. Silently running a
 *    host child would make the strongest sentence in the README false while every test stayed
 *    green — the exact failure mode this file exists to prevent.
 * 3. **The container is named, labelled, and reaped.** `docker run` is a *client*: killing it does
 *    not kill the container, and `--rm` is a promise about the client's lifetime, not the
 *    container's. So the launch carries `--cidfile` and `org.factory.attempt=<attemptId>`, and
 *    every exit path sweeps by label, and {@link sweepAttemptContainers} is the form
 *    `factory recover` calls when the process that would have swept is the one that died. A
 *    container left behind by a killed attempt is a leak, and the wall suite already holds itself
 *    to zero leftovers; the worker path is held to the same standard.
 *
 * The flags are the wall's, deliberately: `--network none`, `--read-only`, `--tmpfs /tmp`,
 * `--cap-drop ALL`, `--security-opt no-new-privileges`, `--memory`, `--pids-limit`. A worker that
 * can reach the network can reach the holdout key's destination; one that can write its own root
 * can outlive its attempt's evidence.
 */
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';

import { FactoryError } from '@factory/contracts';

/** `host` (the default) or `container`. An unset/empty value means host. */
export const WORKER_ISOLATION_ENV = 'FACTORY_WORKER_ISOLATION';
/** The image to run the worker in. Defaults to the tag `docker/factory-env` builds. */
export const WORKER_IMAGE_ENV = 'FACTORY_WORKER_IMAGE';
/** `uid:gid` inside the container. Defaults to the image's `factory` account (10001:10001). */
export const WORKER_USER_ENV = 'FACTORY_WORKER_CONTAINER_USER';
/** The docker client to use. Defaults to `docker` on `PATH`. */
export const DOCKER_BIN_ENV = 'FACTORY_DOCKER_BIN';
/** The worker image's memory ceiling. Defaults to {@link DEFAULT_WORKER_MEMORY}. */
export const WORKER_MEMORY_ENV = 'FACTORY_WORKER_MEMORY';
/** The worker image's pid ceiling. Defaults to {@link DEFAULT_WORKER_PIDS}. */
export const WORKER_PIDS_ENV = 'FACTORY_WORKER_PIDS';

/** The tag `docker/factory-env/Dockerfile` builds, and the one the runbook names. */
export const DEFAULT_WORKER_IMAGE = 'factory-env:rc5';
/** The uid:gid the image creates for the worker (`uid=10001(factory)`). */
export const DEFAULT_WORKER_USER = '10001:10001';
export const DEFAULT_WORKER_MEMORY = '2g';
export const DEFAULT_WORKER_PIDS = 512;

/** The label that names the attempt, so a leftover can be found from a different process. */
export const ATTEMPT_LABEL = 'org.factory.attempt';
/** The label that names the run, shared with the wall's containers (`packages/wall`). */
export const RUN_LABEL = 'org.factory.run';

/** Where the worker's container is mounted from. All three are host paths, mounted identically. */
export interface WorkerContainerPaths {
  /** The attempt clone: the only read-write mount, and the container's working directory. */
  readonly attemptDir: string;
  /** The per-attempt `DSH_HOME`, so the session log lands on the host for the read-out. */
  readonly home: string;
  /** The attempt record directory (the overlay lives in it): mounted **read-only**. */
  readonly recordDir: string;
}

/** Everything the launcher needs to run one attempt in a container. */
export interface WorkerContainerPlan {
  readonly dockerBin: string;
  /** The image reference as passed to `docker run` (tag, never a digest). */
  readonly image: string;
  /** `sha256:…` when the image is pinned by digest, which the built image is not by default. */
  readonly imageDigest: string | null;
  readonly user: string;
  readonly memoryLimit: string;
  readonly pidsLimit: number;
  /** `org.factory.run`'s value: unique per invocation, so a sweep can tell runs apart. */
  readonly runToken: string;
}

/** What the two probes said. Pure data, so the decision below can be a spec without docker. */
export interface DockerProbe {
  readonly dockerAvailable: boolean;
  readonly imagePresent: boolean;
  readonly imageDigest: string | null;
  readonly detail: string;
}

/**
 * The three answers: run on the host, run in a container, or refuse.
 *
 * `refuse` carries a `code` because the two refusals are different classes: a bad env value is a
 * usage error (exit 2, a person typed something wrong), while a missing daemon or image is an
 * environment fact (exit 8, `CONTAINER_UNAVAILABLE`, retryable after a fix).
 */
export type IsolationChoice =
  | { readonly mode: 'host'; readonly reason: string }
  | { readonly mode: 'container'; readonly reason: string; readonly plan: WorkerContainerPlan }
  | {
      readonly mode: 'refuse';
      readonly code: 'USAGE' | 'CONTAINER_UNAVAILABLE';
      readonly reason: string;
      readonly runbook: string;
    };

/** The command that builds the image the runbook tells an operator to build. */
export const BUILD_RUNBOOK = 'docker build --tag factory-env:rc5 docker/factory-env';

/**
 * Read the isolation request out of the environment.
 *
 * Exported separately from {@link chooseWorkerIsolation} so the "what did the operator ask for"
 * half can be spec'd without pretending a probe ran.
 */
export function requestedIsolation(
  env: Readonly<Record<string, string | undefined>>,
): 'host' | 'container' | 'invalid' {
  const raw = (env[WORKER_ISOLATION_ENV] ?? '').trim().toLowerCase();
  if (raw === '' || raw === 'host' || raw === 'process') return 'host';
  if (raw === 'container') return 'container';
  return 'invalid';
}

/** The docker client the environment names, defaulted to `docker`. */
export function dockerBinOf(env: Readonly<Record<string, string | undefined>>): string {
  return (env[DOCKER_BIN_ENV] ?? '').trim() || 'docker';
}

/** The worker image the environment names, defaulted to the tag `docker/factory-env` builds. */
export function workerImageOf(env: Readonly<Record<string, string | undefined>>): string {
  return (env[WORKER_IMAGE_ENV] ?? '').trim() || DEFAULT_WORKER_IMAGE;
}

/** `docker version --format {{.Server.Version}}` — the daemon, not just the client. */
function dockerServerVersion(dockerBin: string): { ok: boolean; detail: string } {
  const run = spawnSync(dockerBin, ['version', '--format', '{{.Server.Version}}'], {
    encoding: 'utf8',
    timeout: 10_000,
  });
  if (run.error !== undefined) return { ok: false, detail: run.error.message };
  const version = (run.stdout ?? '').trim();
  if ((run.status ?? 1) !== 0) {
    return {
      ok: false,
      detail: (run.stderr ?? '').trim().split('\n')[0] ?? 'docker version failed',
    };
  }
  if (version === '') return { ok: false, detail: 'no server version reported' };
  return { ok: true, detail: `docker ${version}` };
}

/** `docker image inspect` for the presence and, when it has one, the repo digest. */
function dockerImage(
  dockerBin: string,
  image: string,
): { present: boolean; digest: string | null; detail: string } {
  const run = spawnSync(
    dockerBin,
    ['image', 'inspect', image, '--format', '{{if .RepoDigests}}{{index .RepoDigests 0}}{{end}}'],
    { encoding: 'utf8', timeout: 20_000 },
  );
  if (run.error !== undefined) return { present: false, digest: null, detail: run.error.message };
  if ((run.status ?? 1) !== 0) {
    const first = (run.stderr ?? '').trim().split('\n')[0] ?? 'no such image';
    return { present: false, digest: null, detail: first };
  }
  const digest = (run.stdout ?? '').trim();
  return { present: true, digest: digest === '' ? null : digest, detail: 'present' };
}

/**
 * Ask docker two questions: is there a daemon, and is the image there?
 *
 * Two subprocesses rather than one, because they fail for different reasons and an operator needs
 * to know which: `docker` not on PATH is not "the daemon is down", and a missing image is neither.
 */
export function probeDocker(dockerBin: string, image: string): DockerProbe {
  const server = dockerServerVersion(dockerBin);
  if (!server.ok) {
    return {
      dockerAvailable: false,
      imagePresent: false,
      imageDigest: null,
      detail: server.detail,
    };
  }
  const found = dockerImage(dockerBin, image);
  return {
    dockerAvailable: true,
    imagePresent: found.present,
    imageDigest: found.digest,
    detail: found.present ? server.detail : `image ${image}: ${found.detail}`,
  };
}

/** `uid:gid`, both numeric. An unparseable value is a usage error, not a silent default. */
function parseUser(raw: string): string | null {
  return /^\d+:\d+$/.test(raw) ? raw : null;
}

/** A docker memory size: digits followed by `m` or `g`. `2g`, `512m`. */
function parseMemory(raw: string): string | null {
  return /^\d+(m|g)$/.test(raw.toLowerCase()) ? raw.toLowerCase() : null;
}

/**
 * Decide how this launch will run, from the environment and the probes.
 *
 * Never returns "container" without a probe that says the daemon answered and the image exists;
 * never returns "host" when `container` was requested. The refusals are the point.
 */
export function chooseWorkerIsolation(input: {
  readonly env: Readonly<Record<string, string | undefined>>;
  readonly platform: NodeJS.Platform | string;
  readonly probe: DockerProbe;
}): IsolationChoice {
  const { env, platform, probe } = input;
  const requested = requestedIsolation(env);
  if (requested === 'host') {
    return {
      mode: 'host',
      reason: `the worker runs as a child of this process (${WORKER_ISOLATION_ENV} is not 'container')`,
    };
  }
  if (requested === 'invalid') {
    const value = (env[WORKER_ISOLATION_ENV] ?? '').trim();
    return {
      mode: 'refuse',
      code: 'USAGE',
      reason:
        `${WORKER_ISOLATION_ENV}=${JSON.stringify(value)} is not an isolation mode; ` +
        "the modes are 'host' (the default) and 'container'",
      runbook: `runbook: unset ${WORKER_ISOLATION_ENV} to run the worker as a host child, or set it to 'container'`,
    };
  }

  const dockerBin = dockerBinOf(env);
  const image = workerImageOf(env);
  const userRaw = (env[WORKER_USER_ENV] ?? '').trim() || DEFAULT_WORKER_USER;
  const user = parseUser(userRaw);
  if (user === null) {
    return {
      mode: 'refuse',
      code: 'USAGE',
      reason:
        `${WORKER_USER_ENV}=${JSON.stringify(userRaw)} is not a uid:gid pair; the worker must run as an ` +
        'explicit, non-root identity inside the container',
      runbook: `runbook: set ${WORKER_USER_ENV}=<uid>:<gid> (the image's factory account is ${DEFAULT_WORKER_USER})`,
    };
  }
  const memoryRaw = (env[WORKER_MEMORY_ENV] ?? '').trim() || DEFAULT_WORKER_MEMORY;
  const memoryLimit = parseMemory(memoryRaw);
  if (memoryLimit === null) {
    return {
      mode: 'refuse',
      code: 'USAGE',
      reason: `${WORKER_MEMORY_ENV}=${JSON.stringify(memoryRaw)} is not a docker memory size (for example '2g')`,
      runbook: `runbook: set ${WORKER_MEMORY_ENV}=<n>m or <n>g, or unset it for ${DEFAULT_WORKER_MEMORY}`,
    };
  }
  const pidsRaw = (env[WORKER_PIDS_ENV] ?? '').trim() || String(DEFAULT_WORKER_PIDS);
  const pidsLimit = Number(pidsRaw);
  if (!Number.isInteger(pidsLimit) || pidsLimit <= 0) {
    return {
      mode: 'refuse',
      code: 'USAGE',
      reason: `${WORKER_PIDS_ENV}=${JSON.stringify(pidsRaw)} is not a positive integer`,
      runbook: `runbook: set ${WORKER_PIDS_ENV}=<n>, or unset it for ${String(DEFAULT_WORKER_PIDS)}`,
    };
  }

  if (platform === 'win32') {
    return {
      mode: 'refuse',
      code: 'CONTAINER_UNAVAILABLE',
      reason:
        'container isolation is POSIX-only in this tree: the launcher bind-mounts absolute attempt ' +
        'paths and runs `docker run` with linux flags, and neither is valid for a Windows worker',
      runbook: `runbook: unset ${WORKER_ISOLATION_ENV} on Windows, or run the factory under WSL2 with docker`,
    };
  }
  if (!probe.dockerAvailable) {
    return {
      mode: 'refuse',
      code: 'CONTAINER_UNAVAILABLE',
      reason: `docker is not reachable at ${JSON.stringify(dockerBin)}: ${probe.detail}`,
      runbook:
        `runbook: start a docker daemon (and, if it is not on PATH, set ${DOCKER_BIN_ENV}), ` +
        `or unset ${WORKER_ISOLATION_ENV} to accept a host child`,
    };
  }
  if (!probe.imagePresent) {
    return {
      mode: 'refuse',
      code: 'CONTAINER_UNAVAILABLE',
      reason: `${probe.detail}`,
      runbook: `runbook: ${BUILD_RUNBOOK}, then re-run (or set ${WORKER_IMAGE_ENV} to the tag you built)`,
    };
  }

  return {
    mode: 'container',
    reason:
      `the worker runs in ${image} as ${user} — no network, read-only root, ` +
      `${memoryLimit} of memory and ${String(pidsLimit)} pids`,
    plan: {
      dockerBin,
      image,
      imageDigest: probe.imageDigest,
      user,
      memoryLimit,
      pidsLimit,
      runToken: '',
    },
  };
}

/** What the container name may contain: docker's own rule, narrowed to what an attempt id allows. */
function containerName(attemptId: string): string {
  return `factory-worker-${attemptId}`;
}

/**
 * Refuse a mount path docker would split, mis-parse, or silently reshape.
 *
 * `--volume` is `host:container[:opts]`, so a colon in the host path is an argument the operator
 * did not mean; a newline is worse. Both are bugs in the caller, caught before a container exists.
 */
function mountSpec(host: string, mode: 'rw' | 'ro'): string {
  if (
    !host.startsWith('/') ||
    host.includes(':') ||
    host.includes('\n') ||
    host.includes('\u0000')
  ) {
    throw new FactoryError(
      'INTERNAL',
      `refusing an unsafe container mount path: ${JSON.stringify(host)}`,
    );
  }
  return `${host}:${host}:${mode}`;
}

/** Env names docker accepts. Anything else would be an argv injection dressed as an assignment. */
const ENV_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;

/**
 * The argv that runs one attempt inside the image.
 *
 * `argv` is the same `dsh` argv the host path would have spawned — the prompt is argv, not a file,
 * because the host path already passes it that way and a second transport would be a second thing
 * to keep honest.
 *
 * `env` is the *already allowlisted* child environment (`buildChildEnv`): PATH is dropped because
 * the container has its own, and `HOME`/`DSH_HOME` are passed explicitly so the image's copies do
 * not leak in.
 */
export function workerContainerArgv(input: {
  readonly plan: WorkerContainerPlan;
  readonly paths: WorkerContainerPaths;
  readonly argv: readonly string[];
  readonly env: Readonly<Record<string, string | undefined>>;
  readonly attemptId: string;
  readonly cidFile: string;
}): readonly string[] {
  const { plan, paths, argv, attemptId, cidFile } = input;
  const envFlags: string[] = [];
  const names = Object.keys(input.env).sort();
  for (const name of names) {
    if (!ENV_NAME.test(name)) continue;
    if (name === 'PATH' || name === 'HOME' || name === 'DSH_HOME') continue;
    const value = input.env[name];
    if (value === undefined) continue;
    envFlags.push('-e', `${name}=${value}`);
  }
  // The container's own runtime: the mounted home, not the image's baked-in one.
  envFlags.push('-e', `DSH_HOME=${paths.home}`, '-e', `HOME=${paths.home}`);

  return [
    plan.dockerBin,
    'run',
    '--rm',
    '--cidfile',
    cidFile,
    '--name',
    containerName(attemptId),
    '--label',
    `${RUN_LABEL}=${plan.runToken}`,
    '--label',
    `${ATTEMPT_LABEL}=${attemptId}`,
    '--network',
    'none',
    '--user',
    plan.user,
    '--cap-drop',
    'ALL',
    '--security-opt',
    'no-new-privileges',
    '--read-only',
    '--tmpfs',
    '/tmp',
    '--memory',
    plan.memoryLimit,
    '--pids-limit',
    String(plan.pidsLimit),
    '--workdir',
    paths.attemptDir,
    '--volume',
    mountSpec(paths.attemptDir, 'rw'),
    '--volume',
    mountSpec(paths.home, 'rw'),
    '--volume',
    mountSpec(paths.recordDir, 'ro'),
    ...envFlags,
    plan.image,
    ...argv,
  ];
}

/**
 * The probe argv: the same image and the same flags, no mounts, one argument.
 *
 * The version probe runs **inside** the container on purpose. A host `dsh --version` proves the
 * host's binary is pinned; what the worker will actually execute is the image's, and that is the
 * binary whose version the receipt has to vouch for.
 */
export function workerVersionArgv(
  plan: WorkerContainerPlan,
  bin: readonly string[],
): readonly string[] {
  return [
    plan.dockerBin,
    'run',
    '--rm',
    '--network',
    'none',
    '--read-only',
    '--tmpfs',
    '/tmp',
    '--user',
    plan.user,
    '--cap-drop',
    'ALL',
    '--security-opt',
    'no-new-privileges',
    '--memory',
    plan.memoryLimit,
    '--pids-limit',
    String(plan.pidsLimit),
    plan.image,
    ...bin,
  ];
}

/** The container id `docker run --cidfile` wrote, or `null` when the client never got that far. */
export function readContainerId(cidFile: string): string | null {
  // A read, not a cached value: the file appears when the client starts the container, which may
  // be after the first check.
  try {
    const raw = readFileSync(cidFile, 'utf8').trim();
    return raw === '' ? null : raw;
  } catch {
    return null;
  }
}

/** `docker kill <id>`: the container dies even though the client that started it may not. */
export function killContainer(plan: WorkerContainerPlan, containerId: string): boolean {
  const run = spawnSync(plan.dockerBin, ['kill', containerId], {
    encoding: 'utf8',
    timeout: 20_000,
  });
  if (run.error !== undefined) return false;
  // 1 is "no such container" — already gone, which is the outcome this call wants.
  return (run.status ?? 1) === 0 || /no such container/i.test(run.stderr ?? '');
}

/** The one filter this module ever sweeps by: the attempt label, and nothing else. */
function attemptFilter(attemptId: string): string {
  return `label=${ATTEMPT_LABEL}=${attemptId}`;
}

/** The first line of docker's stderr, which is where it puts the reason a call failed. */
function firstLine(text: string): string {
  return (text.trim().split('\n')[0] ?? '').trim();
}

/**
 * `docker ps -aq` for one attempt label, with the failure a caller has to be able to see.
 *
 * Distinguished from "no ids" on purpose: an unreadable daemon and an empty listing are the same
 * bytes on stdout and opposite facts. Collapsing them is how a sweep reports "0 removed, clean"
 * about a machine it never reached.
 */
type ContainerList =
  | { readonly ok: true; readonly ids: readonly string[] }
  | { readonly ok: false; readonly detail: string };

function listAttemptContainers(dockerBin: string, attemptId: string): ContainerList {
  const run = spawnSync(dockerBin, ['ps', '-aq', '--filter', attemptFilter(attemptId)], {
    encoding: 'utf8',
    timeout: 20_000,
  });
  if (run.error !== undefined) {
    return { ok: false, detail: `cannot run ${JSON.stringify(dockerBin)}: ${run.error.message}` };
  }
  if ((run.status ?? 1) !== 0) {
    const reason = firstLine(run.stderr ?? '') || 'no stderr';
    return {
      ok: false,
      detail: `${JSON.stringify(dockerBin)} ps exited ${String(run.status ?? '(no status)')}: ${reason}`,
    };
  }
  return {
    ok: true,
    ids: (run.stdout ?? '')
      .split('\n')
      .map((line) => line.trim())
      .filter((line) => line !== ''),
  };
}

/**
 * What a sweep of one attempt's containers actually did — never a bare count.
 *
 * `status: 'swept'` is only returned when docker answered the listing and nothing labelled for
 * this attempt remains; `removed: []` with `status: 'swept'` therefore means a true clean.
 * Everything a caller cannot know (no docker client, no daemon, a `rm` that did not take effect)
 * is `failed` with a `reason`, because "swept 0" about a daemon nobody reached is the false clean
 * this type exists to prevent.
 */
export interface AttemptContainerSweep {
  /** The attempt whose label was swept. This is the only filter used. */
  readonly attemptId: string;
  readonly status: 'swept' | 'failed';
  readonly removed: readonly string[];
  readonly remaining: readonly string[];
  /** `null` only when `status` is `'swept'`; otherwise the reason a person needs. */
  readonly reason: string | null;
}

/**
 * `docker rm -f` every container labelled for this attempt, and say whether the label is clear.
 *
 * Takes the client rather than a {@link WorkerContainerPlan} because a *recovery* process has no
 * plan: the attempt it is sweeping was launched by a different invocation, and the only thing it
 * may use from that invocation is the attempt id. That narrowness is the safety rule — sweeping by
 * image or by a bare label would let a sweep remove a container it cannot account for.
 */
export function sweepAttemptContainers(
  dockerBin: string,
  attemptId: string,
): AttemptContainerSweep {
  const listed = listAttemptContainers(dockerBin, attemptId);
  if (!listed.ok) {
    return { attemptId, status: 'failed', removed: [], remaining: [], reason: listed.detail };
  }
  if (listed.ids.length === 0) {
    return { attemptId, status: 'swept', removed: [], remaining: [], reason: null };
  }
  const removed: string[] = [];
  const failures: string[] = [];
  for (const id of listed.ids) {
    const rm = spawnSync(dockerBin, ['rm', '-f', id], { encoding: 'utf8', timeout: 30_000 });
    if (rm.error !== undefined) {
      failures.push(`${id} (${rm.error.message})`);
      continue;
    }
    if ((rm.status ?? 1) !== 0) {
      failures.push(`${id} (${firstLine(rm.stderr ?? '') || 'docker rm failed'})`);
      continue;
    }
    removed.push(id);
  }
  const again = listAttemptContainers(dockerBin, attemptId);
  if (!again.ok) {
    return {
      attemptId,
      status: 'failed',
      removed,
      remaining: [],
      reason: `removed ${String(removed.length)} container(s), then the label listing failed: ${again.detail}`,
    };
  }
  if (again.ids.length === 0) {
    return { attemptId, status: 'swept', removed, remaining: [], reason: null };
  }
  const detail =
    failures.length > 0
      ? failures.join('; ')
      : 'docker rm reported success but the label listing still returns the container';
  return {
    attemptId,
    status: 'failed',
    removed,
    remaining: again.ids,
    reason: `${String(again.ids.length)} container(s) still carry ${attemptFilter(attemptId)} after rm -f: ${detail}`,
  };
}

/**
 * `docker rm -f` every container labelled for this attempt, and report what was left.
 *
 * Called on every exit path, including the one where the client was killed: `--rm` removes a
 * container when *its client* exits normally, and a kill is not a normal exit. This is the sweep
 * that makes "zero leftovers" true rather than hoped for.
 *
 * A listing that could not be read yields empty `removed`/`remaining`, exactly as it did before
 * {@link AttemptContainerSweep} existed; the launcher has no reporting channel for it. The
 * recover-side caller uses {@link sweepAttemptContainers} directly, because a recovery that
 * cannot see the daemon must say so rather than report a clean.
 */
export function reapAttemptContainers(
  plan: WorkerContainerPlan,
  attemptId: string,
): { readonly removed: readonly string[]; readonly remaining: readonly string[] } {
  const sweep = sweepAttemptContainers(plan.dockerBin, attemptId);
  return { removed: sweep.removed, remaining: sweep.remaining };
}

/** The probe a decision about the *host* does not need: nothing was asked of docker. */
const NO_PROBE: DockerProbe = {
  dockerAvailable: false,
  imagePresent: false,
  imageDigest: null,
  detail: 'not probed',
};

/**
 * Probe and decide in one call — what the CLI needs, and the only place the two defaults agree.
 *
 * The probes run only when the environment asks for a container: a host launch must not pay for
 * two docker subprocesses it will not consult, because `factory status` is a command people run
 * in a loop.
 */
export function decideWorkerIsolation(input: {
  readonly env: Readonly<Record<string, string | undefined>>;
  readonly platform: NodeJS.Platform | string;
}): IsolationChoice {
  const requested = requestedIsolation(input.env);
  if (requested !== 'container') {
    return chooseWorkerIsolation({ env: input.env, platform: input.platform, probe: NO_PROBE });
  }
  const probe = probeDocker(dockerBinOf(input.env), workerImageOf(input.env));
  return chooseWorkerIsolation({ env: input.env, platform: input.platform, probe });
}
