/**
 * Exit codes, and the one funnel every failure goes through.
 *
 * `ux-plan.md` §5.1 makes the exit code a *contract*: a script may switch on `$?`
 * alone, so a code never means two different next-actions and `1` is never a
 * catch-all for a class that has its own code. The table is therefore written
 * out here rather than derived, and `errors.test.ts` in `@factory/contracts`
 * pins the code → class mapping from the other side.
 *
 * Two refusals live here because they happen *before* any verb parses anything:
 *
 * - a bypass flag (`-y`, `--force`, …) is a usage error on every verb. There is
 *   no path in this CLI where a keystroke substitutes for a typed phrase
 *   (§7 A-3); the absence of the flag is the design, so it is refused by name.
 * - anything we did not expect becomes `INTERNAL` (exit 1) carrying the traceId
 *   the ledger rows were written under, because "it broke" without an id to grep
 *   is not a report a person can act on.
 */
import { randomBytes } from 'node:crypto';

import { exitCodeFor, isFactoryError, type ErrorCode } from '@factory/contracts';

/** The nine classes of `ux-plan.md` §5.1. `0` is the only success. */
export const EXIT = {
  ok: 0,
  internal: 1,
  usage: 2,
  policy: 3,
  unknown: 4,
  gate: 5,
  budget: 6,
  conflict: 7,
  environment: 8,
  integrity: 9,
} as const;

export type ExitCode = (typeof EXIT)[keyof typeof EXIT];

const EXIT_VALUES: readonly number[] = [0, 1, 2, 3, 4, 5, 6, 7, 8, 9];

export function isExitCode(value: number): value is ExitCode {
  return EXIT_VALUES.includes(value);
}

/**
 * Flags that would let an operator skip a gate. The list is closed: a new
 * convenience flag cannot appear without editing this constant, which is the
 * line an auditor reads. `@factory/gates` owns the same list for the gate
 * package; `main.test.ts` asserts the two agree so they cannot drift.
 */
export const BYPASS_FLAGS = ['-y', '-f', '--yes', '--force', '--assume-yes'] as const;

/**
 * One id per invocation. It is printed with every failure and passed to the
 * engine, so the ledger rows and the refusal share it — a trace id that only
 * exists in one of the two is not a trace.
 */
export function newTraceIdForCli(): string {
  return `T-${randomBytes(5).toString('hex')}`;
}

/** A refusal about the *shape* of the invocation — never about the factory's state. */
export class UsageError extends Error {
  readonly code = 'USAGE';
  readonly exitCode: ExitCode = EXIT.usage;

  constructor(message: string) {
    super(message);
    this.name = 'UsageError';
  }
}

export interface FailureReport {
  /** The same string the ledger and `--json` use (`ux-plan.md` §5.2). */
  readonly code: string;
  readonly exitCode: ExitCode;
  readonly message: string;
  /** Printed for every failure, so a bug report has one id to grep. */
  readonly traceId: string;
  /** The one line that tells the operator what to do about an environment failure. */
  readonly runbook: string | null;
}

interface UsageLike {
  readonly code: string;
  readonly exitCode: number;
  readonly message: string;
}

/**
 * `@factory/gates` refuses malformed gate input with its own `GateUsageError`
 * (exit 2) rather than a `FactoryError`, because "you typed a bad amount" is not
 * a factory fact. We duck-type instead of importing the class so no verb needs
 * the gates package merely to render an error.
 */
export function isUsageLike(error: unknown): error is UsageLike {
  if (typeof error !== 'object' || error === null) return false;
  const candidate = error as { code?: unknown; exitCode?: unknown; message?: unknown };
  return (
    candidate.code === 'USAGE' &&
    candidate.exitCode === EXIT.usage &&
    typeof candidate.message === 'string'
  );
}

/** `errorCodeFor` with the table validated: an unlisted code is an internal failure, not code 0. */
export function exitCodeOf(code: string): ExitCode {
  const value = exitCodeFor(code as ErrorCode);
  return isExitCode(value) ? value : EXIT.internal;
}

/**
 * The configuration conflict's runbook line.
 *
 * Exported because the probe (`context.ts`) sets the same string on `ExecutorProbe.runbook`, and two
 * copies of one instruction is how a reader ends up with the wrong one. It is deliberately *not*
 * the `CONTAINER_UNAVAILABLE` line: there is nothing to build and no daemon to start.
 */
export const CONFIGURATION_CONFLICT_RUNBOOK =
  'runbook: docs/runbooks/worker-container.md §"When the two settings cannot both be honoured" — ' +
  'the daemon and the image are fine; unset FACTORY_WORKER_ISOLATION (drop the container) or ' +
  'FACTORY_LIVE_MODEL (call the model from the host), then re-run: factory run <unitId>';

/**
 * One line per environment/integrity code, because `ux-plan.md` §5.2 promises a
 * "printed runbook line" for the class-8 and class-9 refusals.
 */
const RUNBOOKS: Readonly<Record<string, string>> = {
  ANCHOR_UNAVAILABLE:
    'runbook: docs/runbooks/ledger-anchor.md — either no target is configured (set FACTORY_ANCHOR_SSH + FACTORY_ANCHOR_PATH, or FACTORY_ANCHOR_DIR to accept a local anchor) or the host did not answer; the message above says which',
  EXECUTOR_UNAVAILABLE:
    'runbook: install the pinned dsh on PATH and start a docker daemon, then re-run: factory run <unitId>',
  CONTAINER_UNAVAILABLE:
    'runbook: build or pull the worker image and check the daemon — docker build --tag factory-env:rc5 docker/factory-env — then re-run; leaving container mode is an explicit choice (unset FACTORY_WORKER_ISOLATION), never an automatic fallback',
  CONFIGURATION_CONFLICT: CONFIGURATION_CONFLICT_RUNBOOK,
  DSH_VERSION_MISMATCH:
    'runbook: install dsh 0.2.1-rc.5 exactly — a version mismatch is refused, never warned about',
  STORE_QUARANTINED:
    'runbook: docs/runbooks/store-quarantine.md — do not reset, delete or re-initialise the store; copy it and read',
  WALL_UNAVAILABLE:
    'runbook: restore the wall (docker daemon + holdout store), then: factory run <unitId> --verify-only',
  ATTEMPT_AMBIGUOUS:
    'runbook: observe first (factory status <unitId> --attempt <attemptId>), then decide — nothing is retried automatically',
};

export function runbookFor(code: string): string | null {
  return RUNBOOKS[code] ?? null;
}

/** Turn anything thrown into the exit code the contract promises it means. */
export function classify(error: unknown, traceId: string): FailureReport {
  if (isFactoryError(error)) {
    return {
      code: error.code,
      exitCode: exitCodeOf(error.code),
      message: error.message,
      traceId,
      runbook: runbookFor(error.code),
    };
  }
  if (isUsageLike(error)) {
    return {
      code: 'USAGE',
      exitCode: EXIT.usage,
      message: error.message,
      traceId,
      runbook: null,
    };
  }
  const detail = error instanceof Error ? error.message : String(error);
  return {
    code: 'INTERNAL',
    exitCode: EXIT.internal,
    message: `INTERNAL: ${detail}`,
    traceId,
    runbook: null,
  };
}

/**
 * Refuse a bypass flag before commander sees it.
 *
 * Doing this first — rather than relying on "unknown option" — means the answer
 * is the same on every verb, includes the reason, and cannot be turned off by a
 * future `allowUnknownOption()`.
 */
export function refuseBypassFlags(argv: readonly string[]): void {
  for (const arg of argv) {
    if (!(BYPASS_FLAGS as readonly string[]).includes(arg)) continue;
    throw new UsageError(
      `USAGE: ${arg} is not an option in this CLI (exit 2). No gate can be bypassed by a flag ` +
        '(ux-plan.md §7 A-3); a gate is answered by typing its phrase with --confirm "<phrase>". ' +
        'Nothing was changed.',
    );
  }
}
