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
