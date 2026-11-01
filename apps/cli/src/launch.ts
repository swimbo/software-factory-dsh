/**
 * Performing the launch effect: the one place a worker is started.
 *
 * Both `run` and `recover` come through here, which is the point. If the retry path had
 * its own copy of "start a worker", the two would drift and the retry would be the one
 * nobody tested. Everything in this module *is* the effect; whether to perform it — and
 * how to settle it afterwards — is the caller's business.
 */
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { FactoryError, type ErrorCode } from '@factory/contracts';

import { openAttemptCredential, type AttemptCredential } from './credential.ts';
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

/**
 * The prompt the worker is given, rendered from the unit's spec and written as `task.md`.
 *
 * The adapter refuses to launch without it — "the caller must prepare the prompt" — and this is
 * the caller: the prompt is a function of the spec the operator minted, not of anything the
 * worker said, so it can be re-rendered byte for byte on a retry. The text carries acceptance
 * oracles as commands to run, because an oracle a worker cannot run is not checkable.
 */
function renderPrompt(spec: {
  readonly slug: string;
  readonly revision: number;
  readonly intent: string;
  readonly acceptance: readonly {
    readonly id: string;
    readonly text: string;
    readonly oracle: { readonly kind: string; readonly target: string; readonly expect: string };
  }[];
  readonly touchPaths: readonly string[];
  readonly sizeBudget: { readonly files: number; readonly lines: number };
}): string {
  const lines: string[] = [
    `# ${spec.slug} (revision ${String(spec.revision)})`,
    '',
    '## Intent',
    '',
    spec.intent,
    '',
    '## Acceptance criteria — each one must hold when this attempt ends',
    '',
  ];
  for (const criterion of spec.acceptance) {
    lines.push(`- ${criterion.id}: ${criterion.text}`);
    lines.push(`  - oracle (${criterion.oracle.kind}): ${criterion.oracle.target}`);
    lines.push(`  - expected: ${criterion.oracle.expect}`);
  }
  lines.push('', '## Touch paths', '');
  for (const path of spec.touchPaths) lines.push(`- ${path}`);
  lines.push(
    '',
    '## Limits',
    '',
    `- at most ${String(spec.sizeBudget.files)} files and ${String(spec.sizeBudget.lines)} changed lines`,
    '',
    '## Rules',
    '',
    '- Work only inside the current working directory; it is the whole of your world.',
    '- Change the touch paths above; do not edit anything else unless an acceptance criterion',
    '  cannot be met otherwise.',
    '- Run the acceptance oracles exactly as written before you finish.',
    '- Commit nothing, push nothing, and never read or write outside this directory.',
    '',
  );
  return lines.join('\n');
}

/**
 * Write `task.md` into the attempt record directory, unless it is already there.
 *
 * Idempotent on purpose: a retry re-renders the same text from the same spec, and rewriting a
 * file the run already read would make the prompt differ from the record for no reason.
 */
async function ensureTaskPrompt(ctx: VerbInput['ctx'], launch: LaunchPayloadLike): Promise<void> {
  const adapter = await import('@factory/dsh-adapter').catch(() => null);
  if (adapter === null) return;
  const recordDir = adapter.attemptRecordDir(ctx.home, launch.unitId, launch.attemptId);
  const taskPath = join(recordDir, adapter.TASK_FILE);
  if (existsSync(taskPath)) return;
  const unit = ctx.store.getUnit(launch.unitId);
  if (unit === null) return;
  mkdirSync(recordDir, { recursive: true });
  writeFileSync(taskPath, renderPrompt(unit.spec), { mode: 0o600 });
}

/** The two provider API shapes the overlay knows, validated rather than cast. */
function modelApiOf(value: string): 'anthropic-messages' | 'openai-completions' | undefined {
  if (value === 'anthropic-messages' || value === 'openai-completions') return value;
  return undefined;
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
  // The prompt comes from the spec, not from the transport: both executors see the same text,
  // so a scripted run and a live run cannot drift on what the worker was asked to do.
  await ensureTaskPrompt(ctx, launch);
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
        // A scenario stands in for the worker, so its `command` steps are worker output and
        // pass the broker when the policy says so (`FACTORY_PRIVILEGED_BROKERING=on`).
        privilegedBrokering: ctx.policy.privilegedBrokering,
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

  // The consent switch, and now *only* a consent switch: `FACTORY_LIVE_MODEL=1` says this run
  // may spend, and the credential is opened below as a scoped token behind a localhost proxy.
  // Before ADR-007 the same flag copied `BIFROST_API_KEY` into the child's environment — the
  // one place where "the worker never holds the gateway key" was false.
  const liveConsent = (ctx.env.FACTORY_LIVE_MODEL ?? '').trim() === '1';
  let credential: AttemptCredential | null = null;
  if (liveConsent) {
    const lease = ctx.store.getLiveLease(launch.unitId);
    const opened = await openAttemptCredential({
      env: ctx.env,
      nowIso: ctx.nowIso,
      attemptId: launch.attemptId,
      leaseExpiresAt: lease === null ? null : lease.expiresAt,
    });
    if (!opened.ok) return { ok: false, code: opened.code, detail: opened.detail };
    credential = opened.credential;
  }

  const modelApi = modelApiOf((ctx.env.FACTORY_MODEL_API ?? '').trim());
  try {
    const executor = adapter.createDshExecutor({
      dshBin: ctx.executor.binPath,
      factoryHome: ctx.home,
      proxyBaseUrl,
      modelId,
      // Absent means the default shape the overlay has always produced.
      ...(modelApi === undefined ? {} : { modelApi }),
      log: {
        info: (fields: Record<string, unknown>, message?: string) =>
          ctx.ui.err(message ?? JSON.stringify(fields)),
        warn: (fields: Record<string, unknown>, message?: string) =>
          ctx.ui.err(`WARN ${message ?? JSON.stringify(fields)}`),
        error: (fields: Record<string, unknown>, message?: string) =>
          ctx.ui.err(`ERROR ${message ?? JSON.stringify(fields)}`),
      },
    });
    const receipt = await executor.run(
      {
        ...launch,
        // The door and the token, not the key: the adapter writes the token into the child
        // environment and the proxy's URL into the overlay, and records the fact that the
        // credential was scoped in `launch.json`.
        ...(credential === null
          ? {}
          : {
              credentialProxy: {
                baseUrl: credential.baseUrl,
                token: credential.token,
                expiresAt: credential.expiresAt,
              },
            }),
      },
      { effectId, attempt: attemptNo - 1 },
    );
    return { ok: true, receipt };
  } catch (error) {
    if (error instanceof FactoryError)
      return { ok: false, code: error.code, detail: error.message };
    return {
      ok: false,
      code: 'EXECUTOR_UNAVAILABLE',
      detail: error instanceof Error ? error.message : String(error),
    };
  } finally {
    // Revoke before the verdict exists. The caller writes the receipt and the verdict after
    // this returns, so a token that outlived its attempt would be a credential alive while the
    // factory had already recorded the attempt as over. `settle()` is idempotent and runs on
    // the failure path too: a launch that threw must not leave a live token behind.
    if (credential !== null) {
      await credential.settle();
      // The door is bookkeeping and the token is the property, but neither should outlive the
      // attempt: the proxy is per-invocation and this is the last moment it can be of use.
      await credential.close();
    }
  }
}
