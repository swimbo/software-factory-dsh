/**
 * Performing the launch effect: the one place a worker is started.
 *
 * Both `run` and `recover` come through here, which is the point. If the retry path had
 * its own copy of "start a worker", the two would drift and the retry would be the one
 * nobody tested. Everything in this module *is* the effect; whether to perform it — and
 * how to settle it afterwards — is the caller's business.
 */
import { execFileSync } from 'node:child_process';
import { existsSync, rmSync } from 'node:fs';

import { FactoryError, type ErrorCode } from '@factory/contracts';

import type { VerbInput } from './verbs/types.ts';

/** The effect payload `engine.runUnit` commits: everything a launch needs. */
export interface LaunchPayloadLike {
  readonly attemptId: string;
  readonly unitId: string;
  readonly attemptDir: string;
}

/**
 * Cut the attempt clone from the mirror. The mirror is only ever read.
 *
 * A retry calls this again for an attempt whose first launch was refused, so the
 * directory has three possible states and each gets an answer:
 *
 * - absent — clone it;
 * - already checked out at `baseRev` — reuse it. Re-cloning would be busywork, and the
 *   directory cannot contain worker output: the worker never started;
 * - present and *not* a checkout at `baseRev` — a leftover from a failed clone. It holds
 *   no evidence (nothing ran in it), so it is removed and cut again. Without this the
 *   retry would fail forever on "attempt directory is not empty", which is a leak wearing
 *   a different hat.
 */
function isCheckoutAt(attemptDir: string, baseRev: string): boolean {
  try {
    const head = execFileSync('git', ['-C', attemptDir, 'rev-parse', 'HEAD'], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
    return head === baseRev;
  } catch {
    return false;
  }
}

/** Cut the attempt clone from the mirror. The mirror is only ever read. */
export async function cloneAttempt(
  ctx: VerbInput['ctx'],
  payload: unknown,
  pristineRepo: string,
  baseRev: string,
): Promise<{ readonly ok: true } | { readonly ok: false; readonly detail: string }> {
  const launch = payload as LaunchPayloadLike;
  const adapter = await import('@factory/dsh-adapter').catch(() => null);
  if (adapter === null) {
    return { ok: false, detail: 'the @factory/dsh-adapter package could not be imported' };
  }
  const attemptDir = launch.attemptDir;
  if (existsSync(attemptDir)) {
    if (isCheckoutAt(attemptDir, baseRev)) return { ok: true };
    rmSync(attemptDir, { recursive: true, force: true });
  }
  try {
    await adapter.createAttemptClone({ pristineRepo, baseRev, attemptDir });
    return { ok: true };
  } catch (error) {
    return {
      ok: false,
      detail: `cannot check out ${baseRev.slice(0, 7)} from ${pristineRepo}: ${
        error instanceof Error ? error.message : String(error)
      }`,
    };
  }
}

export type LaunchOutcome =
  | { readonly ok: true; readonly receipt: unknown }
  | { readonly ok: false; readonly code: ErrorCode; readonly detail: string };

/**
 * Perform the launch effect through `@factory/dsh-adapter`, resolved lazily: the
 * adapter is optional by construction, and a host without it must get a refusal
 * rather than an import-time crash.
 */
export async function launchAttempt(
  ctx: VerbInput['ctx'],
  payload: unknown,
  effectId: string,
  attemptNo: number,
  baseRev: string,
): Promise<LaunchOutcome> {
  const launch = payload as LaunchPayloadLike;
  if (ctx.executor.kind === 'fake' && ctx.executor.scenarioPath !== null) {
    // Test-only, and bannered before it does anything (`--scenario` on `run`).
    ctx.ui.err('executor: FAKE (no DSH process launched)');
    const adapter = await import('@factory/dsh-adapter').catch(() => null);
    if (adapter === null)
      return {
        ok: false,
        code: 'EXECUTOR_UNAVAILABLE',
        detail: 'the @factory/dsh-adapter package could not be imported',
      };
    try {
      const pidFile = (ctx.env.FACTORY_SCENARIO_PID_FILE ?? '').trim();
      const executor = adapter.createFakeExecutorFromFile(ctx.executor.scenarioPath, {
        factoryHome: ctx.home,
        baseRev,
        ...(pidFile === '' ? {} : { pidFile }),
        log: {
          info: (fields: Record<string, unknown>, message?: string) =>
            ctx.ui.err(message ?? JSON.stringify(fields)),
          warn: (fields: Record<string, unknown>, message?: string) =>
            ctx.ui.err(`WARN ${message ?? JSON.stringify(fields)}`),
          error: (fields: Record<string, unknown>, message?: string) =>
            ctx.ui.err(`ERROR ${message ?? JSON.stringify(fields)}`),
        },
      });
      return {
        ok: true,
        receipt: await executor.run(launch, { effectId, attempt: attemptNo - 1 }),
      };
    } catch (error) {
      if (error instanceof FactoryError)
        return { ok: false, code: error.code, detail: error.message };
      return {
        ok: false,
        code: 'EXECUTOR_UNAVAILABLE',
        detail: error instanceof Error ? error.message : String(error),
      };
    }
  }
  const proxyBaseUrl = (ctx.env.FACTORY_PROXY_BASE_URL ?? '').trim();
  const modelId = (ctx.env.FACTORY_MODEL_ID ?? '').trim();
  if (proxyBaseUrl.length === 0 || modelId.length === 0) {
    return {
      ok: false,
      code: 'EXECUTOR_UNAVAILABLE',
      detail:
        'FACTORY_PROXY_BASE_URL and FACTORY_MODEL_ID must be set for a launch; no proxy means no worker',
    };
  }
  if (ctx.executor.binPath === null)
    return { ok: false, code: 'EXECUTOR_UNAVAILABLE', detail: 'no dsh binary' };

  const adapter = await import('@factory/dsh-adapter').catch(() => null);
  if (adapter === null)
    return {
      ok: false,
      code: 'EXECUTOR_UNAVAILABLE',
      detail: 'the @factory/dsh-adapter package could not be imported',
    };

  try {
    const executor = adapter.createDshExecutor({
      dshBin: ctx.executor.binPath,
      factoryHome: ctx.home,
      proxyBaseUrl,
      modelId,
      log: {
        info: (fields: Record<string, unknown>, message?: string) =>
          ctx.ui.err(message ?? JSON.stringify(fields)),
        warn: (fields: Record<string, unknown>, message?: string) =>
          ctx.ui.err(`WARN ${message ?? JSON.stringify(fields)}`),
        error: (fields: Record<string, unknown>, message?: string) =>
          ctx.ui.err(`ERROR ${message ?? JSON.stringify(fields)}`),
      },
    });
    const receipt = await executor.run(launch, { effectId, attempt: attemptNo - 1 });
    return { ok: true, receipt };
  } catch (error) {
    if (error instanceof FactoryError)
      return { ok: false, code: error.code, detail: error.message };
    return {
      ok: false,
      code: 'EXECUTOR_UNAVAILABLE',
      detail: error instanceof Error ? error.message : String(error),
    };
  }
}
