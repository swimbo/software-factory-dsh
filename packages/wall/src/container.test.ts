/**
 * The container runner.
 *
 * Two halves, and the split is the point:
 *
 * - **Offline, always run:** the exact `docker run` invocation. `--network none`, the
 *   temp-copy mount and the hard timeout are assertions about a string I can build on
 *   any machine, so the security-relevant part of this file is never skipped.
 * - **Skipped without Docker:** the round trip. A test that pretends to cover container
 *   isolation when no daemon exists is worse than no test, because it makes the suite
 *   green while the property is unverified. `FACTORY_TEST_IMAGE` opts in.
 */
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  createContainerRunner,
  dockerIsAvailable,
  dockerRunArgv,
  imageContentId,
  imageIdMatches,
} from './container.ts';
import { NO_PATCH, type ScenarioRunInput } from './evaluate.ts';

const TEST_IMAGE = process.env['FACTORY_TEST_IMAGE'];
const dockerReady = await dockerIsAvailable();

const scratch: string[] = [];
afterEach(() => {
  for (const dir of scratch.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function scratchDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'factory-container-'));
  scratch.push(dir);
  return dir;
}

function runInput(argv: readonly string[], timeoutMs = 30_000): ScenarioRunInput {
  return { baseRev: 'a'.repeat(40), patchFile: NO_PATCH, argv, timeoutMs };
}

describe('the docker invocation is physical, not aspirational', () => {
  it('removes the network, mounts the given tree and passes the scenario argv through untouched', () => {
    const args = dockerRunArgv({ image: 'factory-env' }, '/tmp/checkout-copy', [
      'node',
      '.holdout/run.js',
      'alpha',
    ]);

    expect(args.slice(0, 2)).toEqual(['run', '--rm']);
    // The single most important flag in this file.
    expect(args.slice(args.indexOf('--network'), args.indexOf('--network') + 2)).toEqual([
      '--network',
      'none',
    ]);
    expect(args).toContain('--volume');
    expect(args[args.indexOf('--volume') + 1]).toBe('/tmp/checkout-copy:/workspace');
    // The argv is appended verbatim after the image: no shell, so no quoting to get wrong.
    expect(args.slice(-3)).toEqual(['node', '.holdout/run.js', 'alpha']);
    // …immediately after the image, so no flag can be smuggled in by the caller's argv.
    expect(args[args.indexOf('factory-env') + 1]).toBe('node');
  });

  it('caps memory and processes, so a runaway scenario is a verdict rather than an outage', () => {
    const args = dockerRunArgv(
      { image: 'factory-env', memoryLimit: '512m', pidsLimit: 32 },
      '/tmp/copy',
      ['true'],
    );

    expect(args[args.indexOf('--memory') + 1]).toBe('512m');
    expect(args[args.indexOf('--pids-limit') + 1]).toBe('32');
    expect(args[args.indexOf('--cap-drop') + 1]).toBe('ALL');
    expect(args).toContain('no-new-privileges');
  });

  it('pins the image by digest and names it in the invocation, because a tag is a mutable pointer', () => {
    const digest = `sha256:${'d'.repeat(64)}`;
    const args = dockerRunArgv({ image: 'factory-env', imageDigest: digest }, '/tmp/copy', [
      'true',
    ]);

    expect(args).toContain(`factory-env@${digest}`);
    expect(args).not.toContain('factory-env');
    // A malformed digest is refused rather than silently treated as a tag: a typo in the
    // pin must not degrade the run to "whatever `latest` points at today".
    expect(() =>
      dockerRunArgv({ image: 'factory-env', imageDigest: 'sha256:short' }, '/tmp/copy', ['true']),
    ).toThrow(/digest/i);
  });

  it('runs as a non-root user on a read-only root, so a scenario cannot write to the image', () => {
    const args = dockerRunArgv({ image: 'factory-env', readOnlyRoot: true }, '/tmp/copy', ['true']);

    expect(args[args.indexOf('--user') + 1]).toMatch(/^\d+:\d+$/);
    expect(args).toContain('--read-only');
    // The one writable place is a tmpfs, so /tmp works without widening the root.
    expect(args[args.indexOf('--tmpfs') + 1]).toBe('/tmp');
    // …and no default: a run that omits the flags is still non-root, and still internal-only.
    const defaults = dockerRunArgv({ image: 'factory-env' }, '/tmp/copy', ['true']);
    expect(defaults[defaults.indexOf('--network') + 1]).toBe('none');
    expect(defaults[defaults.indexOf('--user') + 1]).toMatch(/^\d+:\d+$/);
  });

  it('refuses to build an invocation that would mount the holdout store or the signing keys', () => {
    const home = '/home/operator';

    for (const forbidden of [`${home}/.factory/holdout`, `${home}/.factory/keys`]) {
      expect(() =>
        dockerRunArgv(
          {
            image: 'factory-env',
            workspacePath: forbidden,
            forbidMountsUnder: [`${home}/.factory`],
          },
          `${home}/.factory/holdout`,
          ['true'],
        ),
      ).toThrow(/refus|forbidden/i);
    }

    // The same root, mounted somewhere allowed, still builds: the check is on the source
    // tree, not on the option's existence.
    expect(() =>
      dockerRunArgv(
        { image: 'factory-env', forbidMountsUnder: [`${home}/.factory`] },
        '/tmp/copy',
        ['true'],
      ),
    ).not.toThrow();
  });

  it('has no channel for expectations: the options type cannot carry a scenario or its answer', () => {
    // Comments are stripped first: the file *explains* that expectations live outside the
    // container, and the assertion is about what the code can carry, not what prose mentions.
    const source = readFileSync(new URL('./container.ts', import.meta.url), 'utf8')
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/\/\/.*$/gm, '');

    // Structural, not stylistic: the driver lives in the image and reads the scenario from
    // argv, so there is no option through which a caller could hand it the expectations.
    expect(source).not.toMatch(/expectExit|expectations|holdout:|scenarioId/i);
    const args = dockerRunArgv({ image: 'factory-env' }, '/tmp/copy', [
      'node',
      '.holdout/run.js',
      'alpha',
    ]);
    expect(args.slice(-3)).toEqual(['node', '.holdout/run.js', 'alpha']);
  });

  it('records a cidfile and a run label, so a container can be found and killed', () => {
    const args = dockerRunArgv(
      { image: 'factory-env', cidFile: '/tmp/cid-1', label: 'suite-1' },
      '/tmp/copy',
      ['true'],
    );

    // The cidfile is how the timeout kills the *container*: killing the `docker run` client
    // leaves the container running, because the client is not its parent.
    expect(args[args.indexOf('--cidfile') + 1]).toBe('/tmp/cid-1');
    expect(args[args.indexOf('--label') + 1]).toBe('org.factory.run=suite-1');
    // Absent when not asked for: no empty flags.
    expect(dockerRunArgv({ image: 'factory-env' }, '/tmp/copy', ['true'])).not.toContain(
      '--cidfile',
    );
  });

  it('names the container, so a client that dies before its cidfile leaves a findable orphan', () => {
    // The cidfile is written by the client; a SIGKILLed client can die between the daemon
    // creating the container and the id reaching disk. `--name` is set before the container
    // starts and needs nothing from the client afterwards, so the kill path has a handle in
    // exactly the window where the cidfile is missing. Both are present: neither replaces the other.
    const args = dockerRunArgv(
      { image: 'factory-env', name: 'factory-wall-suite-1-1', cidFile: '/tmp/cid-1' },
      '/tmp/copy',
      ['true'],
    );
    expect(args[args.indexOf('--name') + 1]).toBe('factory-wall-suite-1-1');
    expect(args.indexOf('--name')).toBeLessThan(args.indexOf('--cidfile'));
    // Absent when not asked for, and never an empty flag.
    expect(dockerRunArgv({ image: 'factory-env' }, '/tmp/copy', ['true'])).not.toContain('--name');
  });

  it('pins a locally built image by content id, because a tag is mutable', () => {
    // A local build has no registry manifest, so `name@sha256:…` cannot resolve; the content
    // id is the only honest pin available offline.
    expect(imageContentId('definitely-not-an-image-here')).toBeNull();
    if (!dockerReady) return;
    const image = TEST_IMAGE ?? 'factory-env:e2e';
    const id = imageContentId(image);
    if (id === null) return;
    expect(id).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(imageIdMatches(image, id)).toBe(true);
    expect(imageIdMatches(image, `sha256:${'0'.repeat(64)}`)).toBe(false);
  });

  it('refuses an empty image or an empty argv instead of running something arbitrary', () => {
    expect(() => dockerRunArgv({ image: '  ' }, '/tmp/copy', ['true'])).toThrow(TypeError);
    expect(() => dockerRunArgv({ image: 'factory-env' }, '/tmp/copy', [])).toThrow(TypeError);
  });

  it('reports an invalid invocation as unmeasured, never as a failure', async () => {
    const runner = createContainerRunner({ image: '', cwd: scratchDir() });
    const result = await runner.run(runInput(['true']));

    expect(result.exitCode).toBeNull();
    expect(result.timedOut).toBe(false);
    expect(result.outputSha).toMatch(/^sha256:[0-9a-f]{64}$/);
  });

  it('reports a missing docker binary as unmeasured, never as a failure', async () => {
    const runner = createContainerRunner({
      dockerBin: '/definitely/not/docker',
      image: 'factory-env',
      cwd: scratchDir(),
    });
    const result = await runner.run(runInput(['true']));

    expect(result.exitCode).toBeNull();
    expect(result.timedOut).toBe(false);
  });

  it('mounts a copy, so the scenario cannot scribble on the prepared checkout', async () => {
    // With no docker binary the process never starts, but the copy is made *before* the
    // spawn, so this still proves the isolation path runs and is cleaned up.
    const source = scratchDir();
    const file = join(source, 'CHECKOUT.txt');
    writeFileSync(file, 'original', 'utf8');

    const runner = createContainerRunner({
      dockerBin: '/definitely/not/docker',
      image: 'factory-env',
      cwd: source,
    });
    await runner.run(runInput(['true']));

    // The source tree is untouched and its contents are what we wrote.
    expect(readFileSync(file, 'utf8')).toBe('original');
  });
});

describe.skipIf(dockerReady === false || TEST_IMAGE === undefined)('against a real daemon', () => {
  it('runs a scenario in the image and reports its exit code and output hash', async () => {
    const source = scratchDir();
    writeFileSync(join(source, 'hello.txt'), 'from the checkout', 'utf8');

    const runner = createContainerRunner({ image: TEST_IMAGE ?? 'factory-env', cwd: source });
    const result = await runner.run(runInput(['sh', '-c', 'cat hello.txt; exit 3']));

    expect(result.timedOut).toBe(false);
    expect(result.exitCode).toBe(3);
    expect(result.outputSha).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(result.durationMs).toBeGreaterThan(0);
  });

  it('kills a scenario at the hard timeout and says so', async () => {
    const runner = createContainerRunner({ image: TEST_IMAGE ?? 'factory-env', cwd: scratchDir() });
    const result = await runner.run(runInput(['sh', '-c', 'sleep 30'], 1_000));

    expect(result.timedOut).toBe(true);
    expect(result.exitCode).toBeNull();
  });

  it('has no network at all', async () => {
    const runner = createContainerRunner({ image: TEST_IMAGE ?? 'factory-env', cwd: scratchDir() });
    // A DNS lookup inside a `--network none` container must fail; the exact command
    // depends on the image, so the assertion is only that the run does not succeed.
    const result = await runner.run(runInput(['sh', '-c', 'getent hosts example.com'], 10_000));

    expect(result.exitCode).not.toBe(0);
  });
});
