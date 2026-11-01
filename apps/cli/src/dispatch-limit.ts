/**
 * The dispatch ceiling: how many things may be in flight, and what "in flight" means.
 *
 * This module is deliberately a *refusal*, not a scheduler. The plan's IN #5 asks for a
 * ceiling on concurrent attempts and walls; the honest v1 of that is "when the ceiling is
 * reached, the next dispatch is refused with exit 7, and nothing is reserved". A queue
 * would be a promise about *when* work happens, and this build has no loop that could keep
 * that promise — `--no-wait` exists precisely because the operator, not the factory, decides
 * when the deferred attempt runs.
 *
 * ## What counts as in flight
 *
 * An **attempt** is in flight when its state is `launching` or `running`: a worker may be
 * running right now. Two states are deliberately excluded:
 *
 * - `ambiguous` — the state a crashed or unparseable attempt leaves behind. Counting it
 *   would mean one kill -9 stops the factory until a person reconciles, which is a worse
 *   failure than the overlap the ceiling exists to prevent. `recover` is what reconciles
 *   it, and it is the operator's decision, not a counter's.
 * - `planned` — the row exists but nothing has been spawned; no worker can be running.
 *
 * A **unit** is also occupied when it holds a live lease for such an attempt: the lease is
 * the second witness to a controller that may still be alive, so a unit whose attempt row
 * was advanced but whose controller is still working is not counted as free.
 *
 * A **wall** is in flight when an attempt reached `produced-receipt` *and* no verdict has
 * been recorded for the unit. The state alone is not enough — there is no "verified" attempt
 * state, so a finished unit keeps `produced-receipt` and would otherwise occupy a wall slot
 * forever. A wall that dies measuring therefore leaves its slot held until `recover`
 * reconciles the attempt; that is fail-closed and visible in `status` (`state: at-ceiling`),
 * which is the honest trade for not inventing a wall-start marker this build does not have.
 *
 * ## Why the refusal happens before `engine.runUnit`
 *
 * The same reason the budget gate does: `engine.runUnit` writes an attempt row, takes a
 * lease and reserves budget. A ceiling that reserved first and refused afterwards would be
 * worse than no ceiling — the operator would see a busy factory and an attempt that never
 * ran. So `run` reads the occupancy and refuses *before* the transaction; the spec asserts
 * no attempt row, no lease and no effect exist after the refusal.
 */
import { FactoryError, type ErrorCode } from '@factory/contracts';
import type { AttemptRow, Store } from '@factory/store';

/** The attempt states in which a worker may be running. */
export const IN_FLIGHT_ATTEMPT_STATES = ['launching', 'running'] as const;

/** The attempt state in which a wall may be measuring. */
export const IN_FLIGHT_WALL_STATES = ['produced-receipt'] as const;

export interface Occupancy {
  /** Units with an attempt that may be running (or a live lease over one). */
  readonly attempts: number;
  /** Units whose receipt is recorded and whose verdict is not. */
  readonly walls: number;
}

export type OccupancyRead =
  | { readonly ok: true; readonly occupancy: Occupancy }
  /** The store could not be read: `status` must render `unknown`, never `0`. */
  | { readonly ok: false; readonly detail: string };

function inFlight(state: AttemptRow['state'], states: readonly AttemptRow['state'][]): boolean {
  return states.includes(state);
}

/**
 * Read the occupancy of the whole factory.
 *
 * Iterating `listUnits` × `listAttemptsForUnit` is O(units) queries; the alternative is a
 * new store method, and `packages/store` is another owner's file. The count is read at
 * dispatch and at `status`, not in a loop, so the cost is one query per unit.
 */
export function readOccupancy(
  store: Store,
  options: {
    /**
     * The unit whose own operation is being judged.
     *
     * A wall measures *its own* receipt, so that unit's attempt is already in
     * `produced-receipt` when the wall ceiling is checked — counting it would make a ceiling
     * of one refuse every measurement, including the first. The ceiling answers "how many
     * *others* are in flight", so the caller names itself and is excluded.
     */
    readonly excludeUnitId?: string;
  } = {},
): OccupancyRead {
  try {
    let attempts = 0;
    let walls = 0;
    for (const unit of store.listUnits()) {
      if (unit.unitId === options.excludeUnitId) continue;
      const unitAttempts = store.listAttemptsForUnit(unit.unitId);
      const lease = store.getLiveLease(unit.unitId);
      const live = unitAttempts.some((attempt) =>
        inFlight(attempt.state, IN_FLIGHT_ATTEMPT_STATES),
      );
      // A receipt with no verdict is a wall that is measuring — or one that died measuring.
      // The state alone is not enough: after a verdict the attempt keeps its
      // `produced-receipt` state (there is no "verified" attempt state), so counting the
      // state alone would leave every finished unit occupying a wall slot forever.
      const measuring =
        unitAttempts.some((attempt) => inFlight(attempt.state, IN_FLIGHT_WALL_STATES)) &&
        store.latestVerdictForUnit(unit.unitId) === null;
      // A lease without an in-flight attempt row still names a controller that may be alive;
      // the unit is not free just because its attempt row moved on.
      if (live || (lease !== null && !measuring)) attempts += 1;
      if (measuring) walls += 1;
    }
    return { ok: true, occupancy: { attempts, walls } };
  } catch (error) {
    return { ok: false, detail: error instanceof Error ? error.message : String(error) };
  }
}

function refuse(input: {
  readonly what: string;
  readonly inFlight: number;
  readonly limit: number;
  readonly limitIsDefault: boolean;
  readonly envName: string;
  readonly unitId: string;
}): FactoryError {
  const ceiling = input.limitIsDefault
    ? `${String(input.limit)} (the documented default, not an operator envelope)`
    : String(input.limit);
  const detail =
    `CONCURRENCY_LIMIT: ${String(input.inFlight)} ${input.what} in flight and the ceiling is ${ceiling}. ` +
    `Nothing was dispatched: no attempt, no lease, no reservation. ` +
    `This build refuses rather than queues — wait for the running work to finish, or raise ${input.envName}.`;
  return new FactoryError('CONCURRENCY_LIMIT', detail, {
    unitId: input.unitId,
    inFlight: input.inFlight,
    limit: input.limit,
    limitIsDefault: input.limitIsDefault,
    code: 'CONCURRENCY_LIMIT' satisfies ErrorCode,
  });
}

/**
 * Refuse the attempt when the ceiling is reached.
 *
 * `limitIsDefault` is threaded in so the message can label a documented default as one
 * (A-2: a number an operator did not set is not an envelope they chose).
 */
export function assertAttemptCapacity(input: {
  readonly read: OccupancyRead;
  readonly limit: number;
  readonly limitIsDefault: boolean;
  readonly unitId: string;
}): void {
  if (!input.read.ok) {
    // A failed read is not permission: fail closed, with a message that says which read.
    throw new FactoryError(
      'CONCURRENCY_LIMIT',
      `CONCURRENCY_LIMIT: the dispatch ceiling could not be read (${input.read.detail}), so ` +
        `dispatch is refused rather than allowed. Nothing was dispatched.`,
      { unitId: input.unitId, reason: 'occupancy-unreadable' },
    );
  }
  const { attempts } = input.read.occupancy;
  if (attempts >= input.limit) {
    throw refuse({
      what: 'attempt(s)',
      inFlight: attempts,
      limit: input.limit,
      limitIsDefault: input.limitIsDefault,
      envName: 'FACTORY_MAX_CONCURRENT_ATTEMPTS',
      unitId: input.unitId,
    });
  }
}

/** Refuse the wall run when the wall ceiling is reached, before any measurement starts. */
export function assertWallCapacity(input: {
  readonly read: OccupancyRead;
  readonly limit: number;
  readonly limitIsDefault: boolean;
  readonly unitId: string;
}): void {
  if (!input.read.ok) {
    throw new FactoryError(
      'CONCURRENCY_LIMIT',
      `CONCURRENCY_LIMIT: the wall ceiling could not be read (${input.read.detail}), so the ` +
        `wall is refused rather than allowed to measure. No verdict was recorded.`,
      { unitId: input.unitId, reason: 'occupancy-unreadable' },
    );
  }
  const { walls } = input.read.occupancy;
  if (walls >= input.limit) {
    throw refuse({
      what: 'wall run(s)',
      inFlight: walls,
      limit: input.limit,
      limitIsDefault: input.limitIsDefault,
      envName: 'FACTORY_MAX_CONCURRENT_WALLS',
      unitId: input.unitId,
    });
  }
}

/** `true` when the ceiling is the shipped default rather than an operator's envelope. */
export function ceilingIsDefault(
  env: Readonly<Record<string, string | undefined>>,
  name: string,
): boolean {
  return (env[name] ?? '').trim() === '';
}
