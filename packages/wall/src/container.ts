/**
 * A container-backed `ScenarioRunner`.
 *
 * This is the runner the factory is supposed to use in production, and it exists to
 * make three properties physical rather than hopeful:
 *
 * 1. **The scenario cannot reach the network.** `--network none`, not a firewall rule
 *    and not a promise. A holdout that can fetch the candidate's own test output, or
 *    that can be defeated by DNS, is not a holdout.
 * 2. **The scenario cannot touch the real checkout.** The prepared tree is copied to a
 *    temp directory and *that* is mounted read-write, so an adversarial scenario can
 *    scribble over its mount without touching the tree the wall will inspect next.
 * 3. **The scenario cannot run forever.** `timeoutMs` is a hard kill, and a killed run
 *    is reported as `timedOut` — which the wall classifies as unmeasured, never as a
 *    pass and never as a failure it cannot justify.
 *
 * The amended contract (A4.4) adds five requirements, all of them flags rather than
 * intentions: a **digest-pinned** image (a tag can be repointed between the verdict and
 * the audit), **non-root**, a **read-only root filesystem**, an **egress-free network**,
 * and **no mount of the holdout store or the key directory** — the last one enforced by
 * refusing to build the argv rather than by remembering to avoid it.
 *
 * The scenario driver lives *outside* this container and holds the expectations; the
 * candidate only ever receives argv. There is deliberately no field on the options type
 * for an expected exit code or a scenario id, so an expectation cannot be serialised
 * into the candidate's process by accident.
 *
 * What this file deliberately does *not* do: decide anything. It returns exit codes,
 * an output hash and a timeout flag. Interpretation lives in `evaluate.ts`, and the
 * purity test there forbids that module from importing this one — execution is
 * injected, never constructed by the decision.
 *
 * Note on the clock: duration is measured with `performance.now()`, not `Date.now()`.
 * It is monotonic, it is not a wall clock, and a duration used in a verdict must not
 * jump when the machine's clock is corrected.
 */
import { spawn, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { cpSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ScenarioRunner, ScenarioRunInput, ScenarioRunResult } from './evaluate.ts';

export interface ContainerRunnerOptions {
  /** The image the factory owns, e.g. `factory-env`. Never a candidate-supplied name. */
  readonly image: string;
  /**
   * The pinned digest, `sha256:<64 hex>`.
   *
   * A tag is a mutable pointer: `factory-env:latest` verified today and audited next
   * month are two different instruments. When set, the image reference becomes
   * `name@digest`, which cannot be repointed.
   */
  readonly imageDigest?: string;
  /**
   * The uid:gid the container runs as. Defaults to the host user's, which is non-root
   * for every operator this runs as and keeps the one writable mount writable.
   */
  readonly user?: string;
  /**
   * `none` (default) is strictly stronger than the amendment's `--internal`: there is no
   * interface at all, rather than one with no route out. `internal` exists for the case
   * where the scenario legitimately needs a loopback-only network.
   */
  readonly network?: 'none' | 'internal';
  /** Read-only root filesystem (default true). Only the workspace mount and `/tmp` are writable. */
  readonly readOnlyRoot?: boolean;
  /**
   * Refuse to mount anything inside these paths — the holdout root and the key directory.
   *
   * Enforced at argv construction, so a future caller cannot forget: mounting
   * `~/.factory/holdout` into a candidate container hands it the scenarios it is being
   * graded on, and mounting the key directory hands it the ability to sign its own verdict.
   */
  readonly forbidMountsUnder?: readonly string[];
  /** A prepared checkout. Copied per run unless `copyCheckout` is false. */
  readonly cwd: string;
  readonly dockerBin?: string;
  /** Where the checkout appears inside the container. */
  readonly workspacePath?: string;
  /** Memory ceiling for the container. Untrusted code that OOMs the host is not a verdict. */
  readonly memoryLimit?: string;
  readonly pidsLimit?: number;
  /** Extra `docker run` flags, appended before the image. */
  readonly extraArgs?: readonly string[];
  /**
   * Which prepared tree to mount for a given run.
   *
   * The default mounts `cwd` for every revision, which is only correct when the caller
   * has already materialised one tree per run. A real executor supplies this to map
   * `(baseRev, patchFile)` onto its own checkout layout — the wall does not know and
   * must not guess how patches are applied.
   */
  readonly prepare?: (input: ScenarioRunInput) => string;
  /** Copy the tree before mounting (default true). `false` mounts the source directly. */
  readonly copyCheckout?: boolean;
  /**
   * Where `docker run` writes the container id (a `--cidfile`).
   *
   * Load-bearing on timeout: killing the `docker run` *client* leaves the container
   * running, because the client is not the container's parent. The cidfile is how the
   * wall finds the container it started and kills *it*, so a hung scenario cannot outlive
   * the run that measured it.
   */
  readonly cidFile?: string;
  /**
   * A label applied to the container, so an orphan can be found and asserted on.
   *
   * `--label org.factory.run=<token>` makes "is anything still running from this suite?"
   * a query rather than a guess.
   */
  readonly label?: string;
}

const DEFAULT_WORKSPACE = '/workspace';
const DEFAULT_MEMORY = '2g';
const DEFAULT_PIDS = 256;

const DIGEST_PATTERN = /^sha256:[0-9a-f]{64}$/;

/** `factory-env@sha256:…`, or the bare name when no digest is pinned (and that is a warning, not a style choice). */
export function resolveImage(
  options: Pick<ContainerRunnerOptions, 'image' | 'imageDigest'>,
): string {
  const image = options.image.trim();
  if (image === '') throw new TypeError('container runner needs an image');
  if (options.imageDigest === undefined) return image;
  if (!DIGEST_PATTERN.test(options.imageDigest)) {
    throw new TypeError(`imageDigest must be sha256:<64 hex>, got ${options.imageDigest}`);
  }
  return `${image}@${options.imageDigest}`;
}

/**
 * The content address of a **locally built** image (`docker image inspect -f '{{.Id}}'`).
 *
 * A locally built image has no registry manifest, so it has no `name@sha256:…` reference
 * to pin — `docker run img@<imageID>` fails, because digest references resolve through a
 * registry. The image id *is* a content address though, and it is the only honest pin
 * available offline: the caller records it in the verdict and this function re-checks, at
 * run time, that the tag still resolves to it.
 */
export function imageContentId(image: string, dockerBin = 'docker'): string | null {
  const probe = spawnSync(dockerBin, ['image', 'inspect', '--format', '{{.Id}}', image], {
    encoding: 'utf8',
  });
  if (probe.status !== 0) return null;
  const id = (probe.stdout ?? '').trim();
  return DIGEST_PATTERN.test(id) ? id : null;
}

/**
 * Does the tag still resolve to the digest we measured?
 *
 * This is the offline substitute for a registry pin: a tag is mutable, so the wall checks
 * the mutation rather than trusting the name. `false` means "run nothing" — a scenario run
 * against an image nobody pinned is a measurement of something else.
 */
export function imageIdMatches(image: string, expectedId: string, dockerBin = 'docker'): boolean {
  return imageContentId(image, dockerBin) === expectedId;
}

/** Host uid:gid, so the container is non-root and can still write the one mount it is given. */
export function defaultContainerUser(): string {
  return typeof process.getuid === 'function' && typeof process.getgid === 'function'
    ? `${process.getuid().toString()}:${process.getgid().toString()}`
    : '65532:65532';
}

function assertMountAllowed(mountDir: string, forbidden: readonly string[]): void {
  const normalised = mountDir.replace(/\/$/, '');
  for (const banned of forbidden) {
    const root = banned.replace(/\/$/, '');
    if (root === '') continue;
    if (normalised === root || normalised.startsWith(`${root}/`)) {
      throw new TypeError(
        `refusing to mount ${mountDir}: it is inside the protected path ${banned}`,
      );
    }
  }
}

/** The exact `docker run` invocation, exported so it can be asserted without a daemon. */
export function dockerRunArgv(
  options: Pick<
    ContainerRunnerOptions,
    | 'image'
    | 'imageDigest'
    | 'workspacePath'
    | 'memoryLimit'
    | 'pidsLimit'
    | 'extraArgs'
    | 'user'
    | 'network'
    | 'readOnlyRoot'
    | 'forbidMountsUnder'
    | 'cidFile'
    | 'label'
  >,
  mountDir: string,
  argv: readonly string[],
): string[] {
  const image = resolveImage(options);
  if (!Array.isArray(argv) || argv.length === 0)
    throw new TypeError('scenario argv must not be empty');
  if (mountDir.trim() === '') throw new TypeError('container runner needs a mount directory');
  assertMountAllowed(mountDir, options.forbidMountsUnder ?? []);
  const workspace = options.workspacePath ?? DEFAULT_WORKSPACE;

  return [
    'run',
    '--rm',
    // Written before the container starts, so a timeout always has a name to kill.
    ...(options.cidFile === undefined ? [] : ['--cidfile', options.cidFile]),
    ...(options.label === undefined ? [] : ['--label', `org.factory.run=${options.label}`]),
    // No network, no exceptions: a holdout that can call out is a holdout that can be
    // talked to.
    '--network',
    options.network ?? 'none',
    // Non-root, and the capabilities it has are none of them.
    '--user',
    options.user ?? defaultContainerUser(),
    '--cap-drop',
    'ALL',
    '--security-opt',
    'no-new-privileges',
    ...(options.readOnlyRoot === false ? [] : ['--read-only']),
    '--workdir',
    workspace,
    '--volume',
    `${mountDir}:${workspace}`,
    '--memory',
    options.memoryLimit ?? DEFAULT_MEMORY,
    '--pids-limit',
    String(options.pidsLimit ?? DEFAULT_PIDS),
    // A read-only root means the toolchain needs somewhere to write scratch state.
    '--tmpfs',
    '/tmp',
    ...(options.extraArgs ?? []),
    image,
    ...argv,
  ];
}

function hashOf(chunks: readonly Buffer[]): string {
  const hash = createHash('sha256');
  for (const chunk of chunks) hash.update(chunk);
  return `sha256:${hash.digest('hex')}`;
}

/** Is a working Docker daemon reachable? Used by tests to skip, and by the executor to preflight. */
export async function dockerIsAvailable(dockerBin = 'docker'): Promise<boolean> {
  return await new Promise<boolean>((resolvePromise) => {
    let settled = false;
    const finish = (value: boolean): void => {
      if (settled) return;
      settled = true;
      resolvePromise(value);
    };
    try {
      const child = spawn(dockerBin, ['info', '--format', '{{.ServerVersion}}'], {
        stdio: 'ignore',
      });
      const timer = setTimeout(() => {
        child.kill('SIGKILL');
        finish(false);
      }, 5_000);
      child.on('error', () => {
        clearTimeout(timer);
        finish(false);
      });
      child.on('close', (code) => {
        clearTimeout(timer);
        finish(code === 0);
      });
    } catch {
      finish(false);
    }
  });
}

/** The container id from a cidfile, or null when docker never wrote one. */
function readContainerId(path: string): string | null {
  try {
    const id = readFileSync(path, 'utf8').trim();
    return id === '' ? null : id;
  } catch {
    return null;
  }
}

/**
 * Kill a container by id, best-effort.
 *
 * `docker kill` and not a signal to the docker client: the container outlives the client,
 * so without this a timed-out scenario keeps running.
 */
function killContainer(dockerBin: string, id: string): void {
  const killed = spawnSync(dockerBin, ['kill', id], { encoding: 'utf8' });
  if (killed.status === 0) return;
  // Already gone, or never started: `rm -f` is the belt to `kill`'s braces.
  spawnSync(dockerBin, ['rm', '-f', id], { encoding: 'utf8' });
}

/**
 * Build the runner.
 *
 * A run that cannot be started at all — no docker binary, no prepared tree, a broken
 * mount — resolves as `{ exitCode: null, timedOut: false }`. That is not a failure of
 * the candidate and must never be recorded as one: the wall maps `null` to `unknown`,
 * which refuses promotion while staying honest about why.
 */
export function createContainerRunner(options: ContainerRunnerOptions): ScenarioRunner {
  const dockerBin = options.dockerBin ?? 'docker';
  const copyCheckout = options.copyCheckout ?? true;
  let runs = 0;

  return {
    // Container isolation is exactly what this runner provides, so `requires: 'container'`
    // and `network: 'none'` are satisfied rather than refused (the default is `--network none`).
    kind: 'container',

    async run(input: ScenarioRunInput): Promise<ScenarioRunResult> {
      const started = performance.now();
      const source = options.prepare === undefined ? options.cwd : options.prepare(input);

      let mountDir = source;
      let tempDir: string | null = null;
      runs += 1;
      const cidFile =
        options.cidFile ?? join(tmpdir(), `factory-cid-${String(process.pid)}-${String(runs)}.txt`);
      const label = options.label;
      if (copyCheckout) {
        tempDir = mkdtempSync(join(tmpdir(), 'factory-run-'));
        try {
          cpSync(source, tempDir, { recursive: true, dereference: false });
        } catch {
          rmSync(tempDir, { recursive: true, force: true });
          return {
            exitCode: null,
            outputSha: hashOf([]),
            durationMs: Math.round(performance.now() - started),
            timedOut: false,
          };
        }
        mountDir = tempDir;
      }

      try {
        return await new Promise<ScenarioRunResult>((resolvePromise) => {
          const chunks: Buffer[] = [];
          let timedOut = false;
          let settled = false;
          // Declared before `finish` so the invalid-invocation path can settle without
          // touching a timer that was never created (a TDZ ReferenceError here would
          // turn a config error into a crash inside the runner).
          let timer: ReturnType<typeof setTimeout> | null = null;

          const finish = (exitCode: number | null): void => {
            if (settled) return;
            settled = true;
            if (timer !== null) clearTimeout(timer);
            // A cidfile that outlives the run leaks a name; remove it with the run.
            rmSync(cidFile, { force: true });
            resolvePromise({
              exitCode,
              outputSha: hashOf(chunks),
              durationMs: Math.round(performance.now() - started),
              timedOut,
            });
          };

          let args: string[];
          try {
            args = dockerRunArgv(
              { ...options, ...(label === undefined ? {} : { label }), cidFile },
              mountDir,
              input.argv,
            );
          } catch {
            // Invalid invocation (no image, empty argv): unmeasured, not failed.
            finish(null);
            return;
          }

          const child = spawn(dockerBin, args, { stdio: ['ignore', 'pipe', 'pipe'] });
          timer = setTimeout(
            () => {
              timedOut = true;
              // Kill the client so the promise settles…
              child.kill('SIGKILL');
              // …and the container, which the client's death does not stop: a hung
              // scenario would otherwise keep its memory and pid budget after the wall had
              // already classified the run as timed out.
              const id = readContainerId(cidFile);
              if (id !== null) killContainer(dockerBin, id);
            },
            Math.max(1, input.timeoutMs),
          );

          child.stdout?.on('data', (chunk: Buffer) => chunks.push(chunk));
          child.stderr?.on('data', (chunk: Buffer) => chunks.push(chunk));
          child.on('error', () => finish(null));
          child.on('close', (code) => {
            // 125 is Docker's own "the daemon refused" code: the container never ran,
            // so there is no measurement to report.
            finish(code === 125 ? null : code);
          });
        });
      } finally {
        if (tempDir !== null) rmSync(tempDir, { recursive: true, force: true });
      }
    },
  };
}
