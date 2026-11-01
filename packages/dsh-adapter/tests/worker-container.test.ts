/**
 * The worker's container: the decision, the argv, and the refusals — with no docker.
 *
 * This is the layer that has to be right on a machine that has never run a container, because
 * that is where a wrong answer is most expensive: an operator asks for isolation and gets a host
 * child, or gets a refusal that names nothing they can act on. Every branch below is a pure
 * function of the environment and the probe result, so all of it runs in CI.
 *
 * The one thing this file cannot prove is that docker accepts the argv. `e2e/cli/docker/
 * 08-worker-container.test.ts` proves that, and skips with a reason when there is no image.
 */
import { describe, expect, it } from 'vitest';
import {
  ATTEMPT_LABEL,
  BUILD_RUNBOOK,
  DEFAULT_WORKER_IMAGE,
  DEFAULT_WORKER_MEMORY,
  DEFAULT_WORKER_PIDS,
  DEFAULT_WORKER_USER,
  RUN_LABEL,
  WORKER_IMAGE_ENV,
  WORKER_ISOLATION_ENV,
  WORKER_MEMORY_ENV,
  WORKER_PIDS_ENV,
  WORKER_USER_ENV,
  chooseWorkerIsolation,
  decideWorkerIsolation,
  dockerBinOf,
  reapAttemptContainers,
  requestedIsolation,
  workerContainerArgv,
  workerImageOf,
  workerVersionArgv,
  type DockerProbe,
  type WorkerContainerPlan,
} from '../src/worker-container.ts';

const UP: DockerProbe = {
  dockerAvailable: true,
  imagePresent: true,
  imageDigest: 'factory-env@sha256:0123456789abcdef',
  detail: 'docker 29.8.2',
};
const NO_DAEMON: DockerProbe = {
  dockerAvailable: false,
  imagePresent: false,
  imageDigest: null,
  detail: 'Cannot connect to the Docker daemon at unix:///var/run/docker.sock',
};
const NO_IMAGE: DockerProbe = {
  dockerAvailable: true,
  imagePresent: false,
  imageDigest: null,
  detail: `image ${DEFAULT_WORKER_IMAGE}: Error: No such image`,
};

const plan: WorkerContainerPlan = {
  dockerBin: 'docker',
  image: DEFAULT_WORKER_IMAGE,
  imageDigest: UP.imageDigest,
  user: DEFAULT_WORKER_USER,
  memoryLimit: DEFAULT_WORKER_MEMORY,
  pidsLimit: DEFAULT_WORKER_PIDS,
  runToken: 'EFF-1',
};

describe('the isolation request', () => {
  it('is the host by default, and for both spellings of an explicit host', () => {
    expect(requestedIsolation({})).toBe('host');
    expect(requestedIsolation({ [WORKER_ISOLATION_ENV]: 'host' })).toBe('host');
    expect(requestedIsolation({ [WORKER_ISOLATION_ENV]: ' HOST ' })).toBe('host');
    expect(requestedIsolation({ [WORKER_ISOLATION_ENV]: 'process' })).toBe('host');
    expect(requestedIsolation({ [WORKER_ISOLATION_ENV]: '' })).toBe('host');
    expect(requestedIsolation({ [WORKER_ISOLATION_ENV]: 'container' })).toBe('container');
    expect(requestedIsolation({ [WORKER_ISOLATION_ENV]: 'podman' })).toBe('invalid');
  });

  it('defaults the image and the docker client without reading anything else', () => {
    expect(workerImageOf({})).toBe(DEFAULT_WORKER_IMAGE);
    expect(workerImageOf({ [WORKER_IMAGE_ENV]: 'factory-env:rc5-pinned' })).toBe(
      'factory-env:rc5-pinned',
    );
    expect(dockerBinOf({})).toBe('docker');
    expect(dockerBinOf({ FACTORY_DOCKER_BIN: '/usr/local/bin/docker' })).toBe(
      '/usr/local/bin/docker',
    );
  });
});

describe('the decision: host, container, or a refusal', () => {
  it('runs on the host when nobody asked for a container, whatever docker says', () => {
    for (const probe of [UP, NO_DAEMON, NO_IMAGE]) {
      const choice = chooseWorkerIsolation({ env: {}, platform: 'darwin', probe });
      expect(choice.mode).toBe('host');
      expect(choice.mode === 'host' ? choice.reason : '').toContain('child of this process');
    }
  });

  it('refuses an unrecognised mode by name, as a usage error', () => {
    const choice = chooseWorkerIsolation({
      env: { [WORKER_ISOLATION_ENV]: 'podman' },
      platform: 'darwin',
      probe: UP,
    });
    expect(choice.mode).toBe('refuse');
    if (choice.mode !== 'refuse') throw new Error('unreachable');
    expect(choice.code).toBe('USAGE');
    expect(choice.reason).toContain('"podman"');
    expect(choice.reason).toContain("'container'");
    expect(choice.runbook).toContain(WORKER_ISOLATION_ENV);
  });

  it('refuses a container request when docker is not reachable, and never falls back to the host', () => {
    const choice = chooseWorkerIsolation({
      env: { [WORKER_ISOLATION_ENV]: 'container' },
      platform: 'darwin',
      probe: NO_DAEMON,
    });
    expect(choice.mode).toBe('refuse');
    if (choice.mode !== 'refuse') throw new Error('unreachable');
    expect(choice.code).toBe('CONTAINER_UNAVAILABLE');
    // The reason names what was looked for, not just that something was missing.
    expect(choice.reason).toContain('docker');
    expect(choice.reason).toContain('Cannot connect to the Docker daemon');
    expect(choice.runbook).toContain('docker daemon');
    // The fallback that this whole task exists to prevent.
    expect(choice.mode).not.toBe('host');
  });

  it('refuses when the image is absent, and the runbook is the command that builds it', () => {
    const choice = chooseWorkerIsolation({
      env: { [WORKER_ISOLATION_ENV]: 'container' },
      platform: 'linux',
      probe: NO_IMAGE,
    });
    expect(choice.mode).toBe('refuse');
    if (choice.mode !== 'refuse') throw new Error('unreachable');
    expect(choice.code).toBe('CONTAINER_UNAVAILABLE');
    expect(choice.reason).toContain(DEFAULT_WORKER_IMAGE);
    expect(choice.runbook).toContain(BUILD_RUNBOOK);
    expect(choice.runbook).toContain(WORKER_IMAGE_ENV);
  });

  it('refuses on Windows rather than pretend the bind mounts and linux flags are portable', () => {
    const choice = chooseWorkerIsolation({
      env: { [WORKER_ISOLATION_ENV]: 'container' },
      platform: 'win32',
      probe: UP,
    });
    expect(choice.mode).toBe('refuse');
    if (choice.mode !== 'refuse') throw new Error('unreachable');
    expect(choice.code).toBe('CONTAINER_UNAVAILABLE');
    expect(choice.reason).toContain('POSIX');
  });

  it('accepts only a numeric uid:gid, a docker memory size and a positive pid count', () => {
    const refuseWith = (env: Record<string, string>): string => {
      const choice = chooseWorkerIsolation({
        env: { [WORKER_ISOLATION_ENV]: 'container', ...env },
        platform: 'linux',
        probe: UP,
      });
      expect(choice.mode).toBe('refuse');
      return choice.mode === 'refuse' ? choice.reason : '';
    };
    expect(refuseWith({ [WORKER_USER_ENV]: 'factory' })).toContain('uid:gid');
    expect(refuseWith({ [WORKER_USER_ENV]: '10001:' })).toContain('uid:gid');
    expect(refuseWith({ [WORKER_MEMORY_ENV]: '2gb' })).toContain('memory size');
    expect(refuseWith({ [WORKER_MEMORY_ENV]: '2048' })).toContain('memory size');
    expect(refuseWith({ [WORKER_PIDS_ENV]: '0' })).toContain('positive integer');
    expect(refuseWith({ [WORKER_PIDS_ENV]: 'many' })).toContain('positive integer');
  });

  it('hands back a plan with the image, digest, uid and limits when everything is present', () => {
    const choice = chooseWorkerIsolation({
      env: {
        [WORKER_ISOLATION_ENV]: 'container',
        [WORKER_IMAGE_ENV]: 'factory-env:rc5-pinned',
        [WORKER_USER_ENV]: '10001:10001',
        [WORKER_MEMORY_ENV]: '1g',
        [WORKER_PIDS_ENV]: '128',
        FACTORY_DOCKER_BIN: '/opt/docker',
      },
      platform: 'linux',
      probe: UP,
    });
    expect(choice.mode).toBe('container');
    if (choice.mode !== 'container') throw new Error('unreachable');
    expect(choice.plan).toMatchObject({
      dockerBin: '/opt/docker',
      image: 'factory-env:rc5-pinned',
      imageDigest: UP.imageDigest,
      user: '10001:10001',
      memoryLimit: '1g',
      pidsLimit: 128,
    });
    expect(choice.reason).toContain('factory-env:rc5-pinned');
    expect(choice.reason).toContain('no network');
  });

  it('decide() probes only when a container was asked for, and keeps the defaults in one place', () => {
    // A host request must not depend on docker being installed at all.
    const host = decideWorkerIsolation({ env: {}, platform: 'darwin' });
    expect(host.mode).toBe('host');
    // A container request against a binary that cannot exist: the refusal names it, and no
    // container plan is produced.
    const refused = decideWorkerIsolation({
      env: { [WORKER_ISOLATION_ENV]: 'container', FACTORY_DOCKER_BIN: '/nonexistent/docker' },
      platform: 'darwin',
    });
    expect(refused.mode).toBe('refuse');
    if (refused.mode !== 'refuse') throw new Error('unreachable');
    expect(refused.code).toBe('CONTAINER_UNAVAILABLE');
    expect(refused.reason).toContain('/nonexistent/docker');
  });
});

describe('the docker run argv', () => {
  const paths = {
    attemptDir: '/factory/attempts/unit-1/attempt-1',
    home: '/factory/attempts/unit-1/attempt-1/dsh-home',
    recordDir: '/factory/attempts/unit-1/attempt-1/record',
  };
  const argvOf = (): readonly string[] =>
    workerContainerArgv({
      plan,
      paths,
      argv: [
        '--profile',
        'factory-worker',
        '--patch',
        `${paths.recordDir}/dsh-overlay.yml`,
        '--json',
        'do it',
      ],
      env: {
        PATH: '/usr/bin:/bin',
        HOME: '/Users/operator',
        DSH_HOME: '/Users/operator/.dsh',
        NODE_ENV: 'production',
        FACTORY_PROXY_TOKEN: 'scoped-token',
        'not a name': 'dropped',
      },
      attemptId: 'attempt-1',
      cidFile: `${paths.recordDir}/container.cid`,
    });

  it('is a docker run with the isolation flags, and nothing from the host that widens it', () => {
    const argv = argvOf();
    expect(argv[0]).toBe('docker');
    expect(argv[1]).toBe('run');
    for (const flag of [
      '--rm',
      '--read-only',
      '--cap-drop',
      '--security-opt',
      '--memory',
      '--pids-limit',
      '--user',
      '--network',
      '--tmpfs',
      '--cidfile',
      '--name',
      '--label',
      '--workdir',
      '--volume',
    ]) {
      expect(argv).toContain(flag);
    }
    expect(argv[argv.indexOf('--network') + 1]).toBe('none');
    expect(argv[argv.indexOf('--cap-drop') + 1]).toBe('ALL');
    expect(argv[argv.indexOf('--security-opt') + 1]).toBe('no-new-privileges');
    expect(argv[argv.indexOf('--user') + 1]).toBe(DEFAULT_WORKER_USER);
    expect(argv[argv.indexOf('--tmpfs') + 1]).toBe('/tmp');
    expect(argv[argv.indexOf('--memory') + 1]).toBe(DEFAULT_WORKER_MEMORY);
    expect(argv[argv.indexOf('--pids-limit') + 1]).toBe(String(DEFAULT_WORKER_PIDS));
    // The docker socket is not mounted: a worker that can talk to the daemon can start a
    // container without any of these flags.
    expect(argv.join(' ')).not.toContain('docker.sock');
  });

  it('mounts the clone and the home read-write and the record read-only, by label-nameable intent', () => {
    const argv = argvOf();
    const volumes = argv.flatMap((arg, index) =>
      arg === '--volume' ? [argv[index + 1] ?? ''] : [],
    );
    expect(volumes).toEqual([
      `${paths.attemptDir}:${paths.attemptDir}:rw`,
      `${paths.home}:${paths.home}:rw`,
      `${paths.recordDir}:${paths.recordDir}:ro`,
    ]);
    expect(argv[argv.indexOf('--workdir') + 1]).toBe(paths.attemptDir);
    const labels = argv.flatMap((arg, index) => (arg === '--label' ? [argv[index + 1] ?? ''] : []));
    expect(labels).toContain(`${RUN_LABEL}=${plan.runToken}`);
    expect(labels).toContain(`${ATTEMPT_LABEL}=attempt-1`);
    expect(argv[argv.indexOf('--name') + 1]).toBe('factory-worker-attempt-1');
  });

  it('passes the image, then the dsh arguments, and never a host PATH or the image-home', () => {
    const argv = argvOf();
    const imageAt = argv.indexOf(plan.image);
    expect(imageAt).toBeGreaterThan(0);
    expect(argv.slice(imageAt + 1)).toEqual([
      '--profile',
      'factory-worker',
      '--patch',
      `${paths.recordDir}/dsh-overlay.yml`,
      '--json',
      'do it',
    ]);
    const envs = argv.flatMap((arg, index) => (arg === '-e' ? [argv[index + 1] ?? ''] : []));
    expect(envs).toContain(`DSH_HOME=${paths.home}`);
    expect(envs).toContain(`HOME=${paths.home}`);
    // The host's PATH and DSH_HOME are not the worker's: the image has its own.
    expect(envs.some((entry) => entry.startsWith('PATH='))).toBe(false);
    expect(envs.some((entry) => entry === 'DSH_HOME=/Users/operator/.dsh')).toBe(false);
    // The one credential-shaped name that is deliberate, and no other.
    expect(envs).toContain('FACTORY_PROXY_TOKEN=scoped-token');
    expect(envs).toContain('NODE_ENV=production');
    // A name that is not an identifier would be an argv injection dressed as an assignment.
    expect(envs.some((entry) => entry.startsWith('not a name'))).toBe(false);
  });

  it('refuses a mount path docker would split or reshape, before a container exists', () => {
    expect(() =>
      workerContainerArgv({
        plan,
        paths: { ...paths, attemptDir: '/factory/attempts/unit:1/attempt-1' },
        argv: ['--json', 'x'],
        env: {},
        attemptId: 'attempt-1',
        cidFile: `${paths.recordDir}/container.cid`,
      }),
    ).toThrow(/unsafe container mount path/);
    expect(() =>
      workerContainerArgv({
        plan,
        paths: { ...paths, home: 'relative/home' },
        argv: ['--json', 'x'],
        env: {},
        attemptId: 'attempt-1',
        cidFile: `${paths.recordDir}/container.cid`,
      }),
    ).toThrow(/unsafe container mount path/);
  });

  it('probes the version inside the same image, with the same limits and no mounts', () => {
    const argv = workerVersionArgv(plan, ['--version']);
    expect(argv.slice(0, 2)).toEqual(['docker', 'run']);
    expect(argv).toContain('--network');
    expect(argv).not.toContain('--volume');
    expect(argv).not.toContain('--read-write');
    const imageAt = argv.indexOf(plan.image);
    expect(argv.slice(imageAt + 1)).toEqual(['--version']);
  });
});

describe('the reap', () => {
  it('reports nothing to remove when docker answers with no ids, without invoking rm', () => {
    // A fake client that answers the listing with an empty string: the shape docker gives when
    // there is nothing to sweep. The call must not treat "no output" as an error.
    const result = reapAttemptContainers(
      { ...plan, dockerBin: 'true' },
      'attempt-with-nothing-left',
    );
    expect(result.removed).toEqual([]);
    expect(result.remaining).toEqual([]);
  });
});
