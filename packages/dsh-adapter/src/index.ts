/**
 * `@factory/dsh-adapter` — everything that knows DSH exists.
 *
 * The blast radius is the point of this package. DSH is a fast-moving product
 * with an unstable profile schema and two event shapes in the wild; when it
 * changes, exactly this package should break and nothing above it should need a
 * patch. Nothing outside `src/` here may import a DSH path, a DSH config key or
 * a DSH event name.
 *
 * Six modules, each with one job:
 *
 * - {@link buildOverlay} / {@link buildDshHome} — turn an attempt into a DSH
 *   profile overlay and a private `DSH_HOME` (`overlay.ts`).
 * - {@link parseHeadlessStream} — read the NDJSON projection and decide, from
 *   the structured turn end and never from prose, whether the turn completed
 *   (`ndjson.ts`).
 * - {@link createWatchdog} / {@link killProcessGroup} — host-measured ceilings
 *   and the process-group kill (`watchdog.ts`).
 * - {@link createDshExecutor} — one attempt in, one schema-valid
 *   `WorkerReceipt` out (`executor.ts`).
 * - {@link createAttemptClone} — the self-contained checkout every attempt runs
 *   in, at one absolute path in both worlds (`clone.ts`).
 * - {@link seedAttemptHome} — the per-attempt `DSH_HOME`: seeded read-only, read
 *   out after receipt capture, destroyed after (`home.ts`).
 */

export {
  buildOverlay,
  assertNoSecrets,
  buildDshHome,
  DSH_HOMES,
  type Compression,
  type DshDomain,
  type OverlayInput,
} from './overlay.ts';

export {
  createLineSplitter,
  parseHeadlessStream,
  type DshError,
  type HeadlessParse,
  type MalformedLine,
  type StatusEntry,
  type TurnEnd,
} from './ndjson.ts';

export {
  createWatchdog,
  killProcessGroup,
  type Watchdog,
  type WatchdogCeiling,
  type WatchdogOptions,
} from './watchdog.ts';

export {
  buildChildEnv,
  createDshExecutor,
  DEFAULT_MAX_OUTPUT_BYTES,
  DEFAULT_WALL_CLOCK_MS,
  DSH_PROFILE,
  PINNED_DSH_VERSION,
  TASK_FILE,
  attemptHomePath,
  attemptRecordDir,
  type DshExecutorOptions,
  type Executor,
  type LaunchContext,
  type LaunchPayload,
  type LogSink,
} from './executor.ts';

export { assertSelfContainedClone, createAttemptClone, type CloneOptions } from './clone.ts';

/**
 * The worker's container: selection, the `docker run` argv, and the reaping.
 *
 * Exported so the CLI can make the decision (and print the refusal) before it opens a store or
 * reserves anything — a refusal that arrives after a reservation is a refusal that cost a run.
 */
export {
  ATTEMPT_LABEL,
  BUILD_RUNBOOK,
  DEFAULT_WORKER_IMAGE,
  DEFAULT_WORKER_MEMORY,
  DEFAULT_WORKER_PIDS,
  DEFAULT_WORKER_USER,
  DOCKER_BIN_ENV,
  RUN_LABEL,
  WORKER_IMAGE_ENV,
  WORKER_ISOLATION_ENV,
  WORKER_MEMORY_ENV,
  WORKER_PIDS_ENV,
  WORKER_USER_ENV,
  chooseWorkerIsolation,
  decideWorkerIsolation,
  dockerBinOf,
  killContainer,
  probeDocker,
  readContainerId,
  reapAttemptContainers,
  requestedIsolation,
  sweepAttemptContainers,
  workerContainerArgv,
  workerImageOf,
  workerVersionArgv,
  type AttemptContainerSweep,
  type DockerProbe,
  type IsolationChoice,
  type WorkerContainerPaths,
  type WorkerContainerPlan,
} from './worker-container.ts';

/**
 * **Test-only.** A scripted worker behind the same `Executor` interface, so the
 * `run → attempt → receipt → verdict → promotion` path can be driven offline with
 * no `dsh`, no container and no model key. Refused under `NODE_ENV=production` by
 * the CLI's executor probe, and bannered on every command that uses it.
 */
export {
  createFakeExecutor,
  createFakeExecutorFromFile,
  parseFakeScenario,
  scenarioTurnCompleted,
  type FakeExecutorOptions,
  type FakeReceiptSpec,
  type FakeScenario,
  type FakeStep,
} from './fake-executor.ts';

export {
  destroyAttemptHome,
  listHomeFiles,
  readHomeFile,
  readOutSession,
  seedAttemptHome,
  seedTemplateDir,
  WORKER_DOMAIN,
  type ReadoutFile,
} from './home.ts';
