/**
 * The recover-side container sweep: the process that would have reaped is the one that died.
 *
 * `--rm` is a promise about the *client's* lifetime. The launcher reaps its attempt's container on
 * every exit path it can still execute (`reapAttemptContainers`), but a `SIGKILL`ed control plane
 * executes none of them: its `docker run` client is orphaned and the container keeps running with
 * nothing left to say so. `factory recover` is the only later process that knows the attempt id,
 * so the sweep lives here.
 *
 * Four rules, and they are the whole design:
 *
 * 1. **Only the attempt this invocation reconciled.** The engine marks an attempt `ambiguous`
 *    when its lease has stopped vouching for it; the caller passes exactly those attempts, and
 *    nothing else is ever swept. An attempt that was already ambiguous is not swept again: a
 *    second `recover` must not be able to remove a container a person is inspecting.
 * 2. **Only by `org.factory.attempt=<attemptId>`, from the record.** The id is the one the store
 *    just reconciled and the launch record confirms; the image and every other label are never a
 *    filter. A malformed record, or one that names a different attempt, is a refusal — not a
 *    licence to guess.
 * 3. **A live lease is never swept.** A live lease says some process may own the attempt, and a
 *    container under a live lease may be someone's running worker. The engine's ambiguity only
 *    follows an expired lease today; this guard makes that a property of the sweep rather than an
 *    assumption about its caller.
 * 4. **Fail soft, never clean.** Docker absent, the daemon down, a record that cannot be parsed,
 *    or a container that survives `rm -f` are all `failed` with a reason. `swept` with
 *    `removed: []` is the one and only way to say "there was nothing to remove", and it is only
 *    reachable when the daemon actually answered. A sweep that cannot run must never be reported
 *    as a clean factory.
 *
 * The safety argument is the same one the reap has always made, one process later: a container is
 * a fact on a daemon, not a child of this process, so the only proof of "gone" is a listing after
 * the removal. `remaining` and `status` are returned together so a caller cannot read the removal
 * list without the answer to "is the label clear?".
 */
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

import type { AttemptContainerSweep } from '@factory/dsh-adapter';

/** One attempt the reconciler just moved to `ambiguous`, and the unit it belongs to. */
export interface ReconciledAttempt {
  readonly attemptId: string;
  readonly unitId: string;
}

/** The adapter seam this module needs: the docker client name and the sweep itself. */
export interface SweepAdapter {
  /** The label a container carries its attempt id in (`org.factory.attempt`). */
  readonly attemptLabel: string;
  /** `FACTORY_DOCKER_BIN`, or `docker`; read by the adapter, which owns that default. */
  readonly dockerBinOf: (env: Readonly<Record<string, string | undefined>>) => string;
  /** The fail-soft sweep (`sweepAttemptContainers`): listing, `rm -f`, listing again. */
  readonly sweep: (dockerBin: string, attemptId: string) => AttemptContainerSweep;
}

/**
 * Resolve the adapter lazily, exactly as the launch path does.
 *
 * `factory recover` must keep working on a host where the harness package is not installed — the
 * CLI's contract is that the adapter is optional until something is actually launched. A static
 * import here would turn "the adapter is absent" into a module-load crash instead of a reported
 * `failed` sweep with a reason.
 */
export async function resolveSweepAdapter(): Promise<SweepAdapter | null> {
  try {
    const adapter = await import('@factory/dsh-adapter');
    return {
      attemptLabel: adapter.ATTEMPT_LABEL,
      dockerBinOf: adapter.dockerBinOf,
      sweep: adapter.sweepAttemptContainers,
    };
  } catch {
    return null;
  }
}

/** `swept` is a fact about the daemon; `skipped` is a decision; `failed` is a hole to look at. */
export type SweepStatus = 'swept' | 'skipped' | 'failed';

/** What happened to one reconciled attempt's containers. Every field is a value, not a sentence. */
export interface AttemptSweepReport {
  readonly attemptId: string;
  readonly unitId: string;
  readonly status: SweepStatus;
  /** The image the launch record names, or `null` when it records no container. */
  readonly image: string | null;
  readonly removed: readonly string[];
  readonly remaining: readonly string[];
  /** Why the sweep did not sweep. `null` for `swept`; never `null` for `failed`. */
  readonly reason: string | null;
  /** The command that shows what the sweep could not remove; `null` when no sweep ran. */
  readonly checkCommand: string | null;
}

export interface SweepOptions {
  /** The factory root: the launch record lives at `attempts/<unitId>/<attemptId>/launch.json`. */
  readonly home: string;
  readonly env: Readonly<Record<string, string | undefined>>;
  /** Exactly the attempts this `recover` invocation moved to `ambiguous`. */
  readonly attempts: readonly ReconciledAttempt[];
  /** `store.getLiveLease`, injected so a spec can age a lease without a store. */
  readonly liveLease: (
    unitId: string,
  ) => { readonly leaseId: string; readonly expiresAt: string } | null;
  /** `null` when the adapter package could not be resolved. */
  readonly adapter: SweepAdapter | null;
}

/** The two ids become path segments, so they are held to the adapter's own rule. */
const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * What the launch record says the worker ran inside.
 *
 * `container: null` and a record with no `container` key are different history and the same fact:
 * the worker did not run in a container. `absent` is a third thing again — the adapter writes
 * `launch.json` before it spawns `docker run`, so a missing record is positive evidence that no
 * container was started for this attempt.
 */
type LaunchRecordRead =
  | { readonly kind: 'container'; readonly image: string }
  | { readonly kind: 'host'; readonly detail: string }
  | { readonly kind: 'absent'; readonly detail: string }
  | { readonly kind: 'malformed'; readonly detail: string };

function malformed(detail: string): LaunchRecordRead {
  return { kind: 'malformed', detail };
}

/**
 * Read one launch record and narrow it to the two facts the sweep may act on.
 *
 * The record is data written by another process, so every field this module reads is checked.
 * In particular the attempt id it names must be the one the store reconciled: sweeping by a
 * label the record does not confirm would be sweeping a container this process cannot account
 * for, which is the one thing the safety rule forbids.
 */
export function readLaunchRecord(recordPath: string, attemptId: string): LaunchRecordRead {
  if (!existsSync(recordPath)) {
    return {
      kind: 'absent',
      detail:
        `no launch record at ${recordPath}; the adapter writes launch.json before it starts a ` +
        'container, so no container was started for this attempt',
    };
  }
  let text: string;
  try {
    text = readFileSync(recordPath, 'utf8');
  } catch (error) {
    return malformed(`launch record ${recordPath} cannot be read: ${messageOf(error)}`);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (error) {
    return malformed(`launch record ${recordPath} is not valid JSON: ${messageOf(error)}`);
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    return malformed(`launch record ${recordPath} is not a JSON object`);
  }
  const record = parsed as Record<string, unknown>;
  const named = record['attemptId'];
  if (typeof named !== 'string' || named === '') {
    return malformed(
      `launch record ${recordPath} does not name the attempt it belongs to; refusing to sweep by ` +
        'a label the record does not confirm',
    );
  }
  if (named !== attemptId) {
    return malformed(
      `launch record ${recordPath} names attempt ${JSON.stringify(named)}, not ` +
        `${JSON.stringify(attemptId)}; refusing to sweep a container the record does not confirm`,
    );
  }
  // `container` absent means the record predates the container path; `null` means "host child".
  // Both are the same decision for a sweep, and neither is "unknown".
  const container = record['container'];
  if (container === undefined || container === null) {
    return {
      kind: 'host',
      detail:
        'the launch record records no container (`container` is absent or null), so the worker ' +
        'ran as a host child; there is nothing to sweep',
    };
  }
  if (typeof container !== 'object' || Array.isArray(container)) {
    return malformed(`launch record ${recordPath} has a container field that is not an object`);
  }
  const image = (container as Record<string, unknown>)['image'];
  return {
    kind: 'container',
    image: typeof image === 'string' && image !== '' ? image : '(image not recorded)',
  };
}

function skipped(attempt: ReconciledAttempt, reason: string): AttemptSweepReport {
  return {
    attemptId: attempt.attemptId,
    unitId: attempt.unitId,
    status: 'skipped',
    image: null,
    removed: [],
    remaining: [],
    reason,
    checkCommand: null,
  };
}

function failed(attempt: ReconciledAttempt, reason: string): AttemptSweepReport {
  return {
    attemptId: attempt.attemptId,
    unitId: attempt.unitId,
    status: 'failed',
    image: null,
    removed: [],
    remaining: [],
    reason,
    checkCommand: null,
  };
}

/** Sweep one reconciled attempt, deciding first whether it may be swept at all. */
function sweepOne(attempt: ReconciledAttempt, options: SweepOptions): AttemptSweepReport {
  if (!SAFE_ID.test(attempt.unitId) || !SAFE_ID.test(attempt.attemptId)) {
    return failed(
      attempt,
      `the reconciled ids (unit ${JSON.stringify(attempt.unitId)}, attempt ` +
        `${JSON.stringify(attempt.attemptId)}) are not safe path segments, so the launch record ` +
        'cannot be located and nothing is swept',
    );
  }
  const recordPath = join(
    options.home,
    'attempts',
    attempt.unitId,
    attempt.attemptId,
    'launch.json',
  );
  const record = readLaunchRecord(recordPath, attempt.attemptId);
  if (record.kind === 'absent') return skipped(attempt, record.detail);
  if (record.kind === 'malformed') return failed(attempt, record.detail);
  if (record.kind === 'host') return skipped(attempt, record.detail);

  const lease = options.liveLease(attempt.unitId);
  if (lease !== null) {
    return skipped(
      attempt,
      `lease ${lease.leaseId} is live until ${lease.expiresAt}, and a live attempt may own a ` +
        'running container; nothing is swept while the lease still vouches for a worker',
    );
  }
  if (options.adapter === null) {
    return failed(
      attempt,
      'the @factory/dsh-adapter package could not be resolved, so the docker client cannot be ' +
        `named and the container labelled for this attempt (${record.image}) may still be running`,
    );
  }
  const dockerBin = options.adapter.dockerBinOf(options.env);
  const sweep = options.adapter.sweep(dockerBin, attempt.attemptId);
  const report: AttemptSweepReport = {
    attemptId: attempt.attemptId,
    unitId: attempt.unitId,
    status: sweep.status,
    image: record.image,
    removed: sweep.removed,
    remaining: sweep.remaining,
    reason:
      sweep.status === 'failed' ? (sweep.reason ?? 'the sweep failed without a reason') : null,
    checkCommand:
      sweep.status === 'failed'
        ? `${dockerBin} ps -aq --filter label=${options.adapter.attemptLabel}=${attempt.attemptId}`
        : null,
  };
  return report;
}

/**
 * Sweep every attempt this invocation just reconciled — and report each one, including the ones
 * it decided not to touch. The caller renders these and returns its own exit code: a failed
 * sweep is visible, never fatal, because it says nothing about the *attempt* the operator is
 * being asked to observe.
 */
export function sweepReconciledAttempts(options: SweepOptions): readonly AttemptSweepReport[] {
  return options.attempts.map((attempt) => sweepOne(attempt, options));
}
