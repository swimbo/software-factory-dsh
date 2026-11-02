/**
 * `factory alerts --notify`: the smallest channel that makes "a person is told" true.
 *
 * `alerts` answers in an exit code and a log line, and until this file existed the log *was* the page
 * — a scheduled monitor that only writes to a file reports to nobody. This module is the smallest
 * channel that changes that without inventing an account, a credential or a new exit code:
 *
 *  - **local** (default when no URL is configured): one macOS notification through `osascript`, plus
 *    one line on stderr. On a host that is not macOS it is a no-op *with the reason stated*, never an
 *    error, because a channel that cannot be shown must not hide the alert the verb already printed.
 *  - **webhook** (`FACTORY_ALERTS_WEBHOOK_URL`): one POST of the same `alerts.v1` document the command
 *    printed — the same bytes, from the same validated object.
 *
 * Three rules hold this surface honest:
 *
 * 1. **The decision is pure and separate from delivery.** {@link planNotification} takes the document
 *    and the exit code and returns `null` when there is nothing to say. It reads no clock, no store,
 *    no network and no `process.env`; a channel that decided what to say would be a second monitor.
 * 2. **The exit code describes the evidence, not the transport.** A delivery failure is reported on
 *    stderr and `runAlerts` returns the decision's code unchanged: an unreachable webhook must not
 *    turn exit 9 into exit 8, because the evidence is still expired.
 * 3. **Nothing here logs a secret.** A webhook URL usually *is* a credential — a query token for some
 *    services, a secret path for others — so it is reduced to scheme + host before it is ever printed.
 *    The one thing worse than no channel is a channel that leaks its credential into a log file that
 *    is kept forever.
 *
 * The delivery is deliberately not durable: one attempt, at most one retry for the POST, and no
 * queue. The next scheduled run is the retry, which is the same reason the launchd job has no retry.
 */
import { spawnSync } from 'node:child_process';
import { URL } from 'node:url';

import type { Alert, AlertCode, AlertSeverity, AlertsV1 } from '@factory/contracts';

import { EXIT } from './exit.ts';

/** The one environment variable that moves the channel off this machine. */
export const WEBHOOK_ENV = 'FACTORY_ALERTS_WEBHOOK_URL';

/** One webhook attempt's budget. Two attempts at most, so a wedged endpoint costs ~10 s, not a day. */
export const WEBHOOK_TIMEOUT_MS = 5_000;

/** `osascript` is bounded for the same reason: a wedged Script Editor must not wedge the 04:00 job. */
export const LOCAL_TIMEOUT_MS = 10_000;

/** How many distinct subjects a notification names before it says "+N more". */
const MAX_SUBJECTS = 5;

/** How much of a failure reason is worth one line. The log is not a stack-trace dump. */
const MAX_DETAIL = 300;

/**
 * One alert code, collapsed.
 *
 * `decideAlerts` emits one alert per class, so a store with forty stale classes emits forty alerts.
 * A notification that listed all forty would be unreadable *and* would make the one class that
 * matters unfindable — so the decision is one entry per code, with the subjects summarised.
 */
export interface NotifyEntry {
  readonly code: AlertCode;
  readonly severity: AlertSeverity;
  /** How many alerts this code stands for (1 for most codes, more for a per-class code). */
  readonly count: number;
  /** The distinct subjects, first-seen order. A class name repeated twice is named once. */
  readonly subjects: readonly string[];
  /** The first alert's reason: one line is what a notification can carry, the log has them all. */
  readonly reason: string;
  readonly investigation: string;
}

export interface NotifyPlan {
  /** The code the evidence earned. It rides in the title, so 8 and 9 can never be confused. */
  readonly exitCode: number;
  /** The notification title. */
  readonly title: string;
  /** The anchor, summarised the way the verb renders it: `FRESH — anchored 1.5 h ago`. */
  readonly anchor: string;
  /** Integrity entries only, one per code, document order. */
  readonly entries: readonly NotifyEntry[];
  /** The notification body: the anchor, one line per code, and the next command(s). */
  readonly body: string;
}

/** What a parsed webhook configuration amounts to. `invalid` is a fact to report, never a fallback. */
export type WebhookConfig =
  | { readonly kind: 'unset' }
  | { readonly kind: 'invalid'; readonly detail: string }
  | { readonly kind: 'http'; readonly target: WebhookTarget };

export interface WebhookTarget {
  /** The exact URL the POST goes to. Never printed. */
  readonly url: string;
  /** Scheme + host + port: everything before the first `/`. This is what a log line may carry. */
  readonly origin: string;
}

/**
 * The alert codes that are facts about the anchor. Used only to decide whether an exit-8
 * notification needs its own "go look at the anchor" line: if an anchor alert is already in the
 * body, its investigation already is that line.
 */
const ANCHOR_CODES: readonly AlertCode[] = ['ANCHOR_STALE', 'ANCHOR_MISSING', 'ANCHOR_ROLLBACK'];

/**
 * What to notify about, from the document and the exit code. `null` means "nothing to say".
 *
 * **Exit 0 is silence, even when a warning alert is present.** `alerts.v1` says a warning is printed
 * and logged and does *not* page; a channel that paged for a spend ceiling would be muted within a
 * week, and it would take the exit-9 pages with it.
 *
 * **Exit 8 and exit 9 say different things**, because they send a person to different places: 8 is
 * "nobody looked, nothing is known" (fix the transport) and 9 is "someone looked and the evidence is
 * expired or untrustworthy" (re-anchor, re-certify, recover). Collapsing them would be the monitor's
 * original sin in a new medium.
 */
export function planNotification(document: AlertsV1, exitCode: number): NotifyPlan | null {
  if (exitCode === EXIT.ok) return null;

  const entries = entriesFrom(document.alerts);
  const anchor = summariseAnchor(document);
  const lines = [evidenceLine(exitCode, document), `anchor: ${anchor}`];
  for (const entry of entries) lines.push(renderEntry(entry));
  for (const investigation of nextCommands(exitCode, entries)) lines.push(`next: ${investigation}`);
  if (exitCode === EXIT.environment) {
    lines.push('nothing is known about this ledger until the anchor answers');
  }
  return {
    exitCode,
    title: headline(exitCode, document),
    anchor,
    entries,
    body: lines.join('\n'),
  };
}

/**
 * One integrity entry per code, in document order.
 *
 * Warning codes are excluded on purpose: they are already in the log, and mixing them into a page is
 * how the reader learns that a page does not always mean "do not trust this ledger".
 */
function entriesFrom(alerts: readonly Alert[]): readonly NotifyEntry[] {
  const order: AlertCode[] = [];
  const byCode = new Map<AlertCode, Alert[]>();
  for (const alert of alerts) {
    if (alert.severity !== 'integrity') continue;
    const bucket = byCode.get(alert.code);
    if (bucket === undefined) {
      byCode.set(alert.code, [alert]);
      order.push(alert.code);
    } else {
      bucket.push(alert);
    }
  }
  const entries: NotifyEntry[] = [];
  for (const code of order) {
    const bucket = byCode.get(code);
    const first = bucket?.[0];
    // `order` and `byCode` are filled together, so this is a type-level guard, not a branch a caller
    // can reach: skipping rather than throwing keeps a notification from becoming the failure.
    if (bucket === undefined || first === undefined) continue;
    entries.push({
      code,
      severity: 'integrity',
      count: bucket.length,
      subjects: [...new Set(bucket.map((alert) => alert.subject))],
      reason: first.reason,
      investigation: first.investigation,
    });
  }
  return entries;
}

function renderEntry(entry: NotifyEntry): string {
  const shown = entry.subjects.slice(0, MAX_SUBJECTS);
  const hidden = entry.subjects.length - shown.length;
  const more = hidden > 0 ? ` +${String(hidden)} more` : '';
  const count = entry.count > 1 ? ` ×${String(entry.count)}` : '';
  return `${entry.severity === 'integrity' ? 'INTEGRITY' : 'WARNING'}  ${entry.code}${count}  ${shown.join(', ')}${more}`;
}

function nextCommands(exitCode: number, entries: readonly NotifyEntry[]): readonly string[] {
  const commands = new Set(entries.map((entry) => entry.investigation));
  if (
    exitCode === EXIT.environment &&
    !entries.some((entry) => ANCHOR_CODES.includes(entry.code))
  ) {
    // No anchor alert exists for an unreachable transport (by design: unreachable is not missing), so
    // the 8 case supplies its own next command rather than sending a person to a blank body.
    commands.add('factory ledger verify; docs/runbooks/ledger-anchor.md');
  }
  return [...commands];
}

function headline(exitCode: number, document: AlertsV1): string {
  if (exitCode === EXIT.environment && document.anchor.state === 'unconfigured') {
    return 'factory alerts: no anchor configured (exit 8)';
  }
  if (exitCode === EXIT.environment) return 'factory alerts: anchor host unreachable (exit 8)';
  if (exitCode === EXIT.integrity) return 'factory alerts: integrity alert (exit 9)';
  return `factory alerts: exit ${String(exitCode)}`;
}

function evidenceLine(exitCode: number, document: AlertsV1): string {
  if (exitCode === EXIT.environment) {
    return document.anchor.state === 'unconfigured'
      ? 'evidence: UNKNOWN — no anchor target is configured (exit 8)'
      : 'evidence: UNKNOWN — the anchor host did not answer (exit 8)';
  }
  if (exitCode === EXIT.integrity) return 'evidence: EXPIRED OR UNTRUSTWORTHY (exit 9)';
  return `evidence: exit ${String(exitCode)}`;
}

function summariseAnchor(document: AlertsV1): string {
  const anchor = document.anchor;
  // The same two parts the verb prints on stderr (`STATE — reason`), so a person reading the log and
  // a person reading the notification are not told two different stories about the same run.
  return `${anchor.state.toUpperCase()} — ${anchor.reason}`;
}

/**
 * Read the webhook configuration. Empty and whitespace-only mean "unset", because a launchd plist
 * with an empty `<string/>` should behave like no configuration rather than like a broken channel.
 */
export function webhookConfig(env: Readonly<Record<string, string | undefined>>): WebhookConfig {
  const raw = (env[WEBHOOK_ENV] ?? '').trim();
  if (raw.length === 0) return { kind: 'unset' };
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    // The value is not echoed: a malformed URL can still carry a token in its path.
    return { kind: 'invalid', detail: `${WEBHOOK_ENV} is set but is not a URL; nothing was sent` };
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    return { kind: 'invalid', detail: `${WEBHOOK_ENV} must be an http(s) URL; nothing was sent` };
  }
  if (url.hostname.length === 0) {
    return { kind: 'invalid', detail: `${WEBHOOK_ENV} has no host; nothing was sent` };
  }
  // `origin` keeps scheme, host and port and drops userinfo, path, query and fragment. Withholding the
  // whole path (not just the query) is deliberate: the common webhook services put the credential in
  // the path, and this line is appended to a log that is never rotated away.
  return { kind: 'http', target: { url: raw, origin: url.origin } };
}

export type DeliveryStatus = 'delivered' | 'failed' | 'skipped';

export interface NotifyOutcome {
  /** False when there was nothing to report: no request, no notification, no stderr line. */
  readonly planned: boolean;
  readonly delivered: boolean;
  readonly status: DeliveryStatus;
  readonly transport: 'local' | 'webhook' | 'none';
  /** One line's worth of what happened, already sanitised. */
  readonly detail: string;
}

export interface DeliverOptions {
  readonly env: Readonly<Record<string, string | undefined>>;
  /** `process.platform`, injected so the non-macOS no-op is a spec rather than an assumption. */
  readonly platform: string;
  /** Where the one line about the channel goes: stderr, never stdout (`--json` owns stdout). */
  readonly warn: (line: string) => void;
  readonly timeoutMs?: number | undefined;
  /** `osascript`'s budget; injectable so a spec can prove the kill without waiting ten seconds. */
  readonly localTimeoutMs?: number | undefined;
}

/**
 * Deliver the plan, and report exactly one line about the channel.
 *
 * The line is emitted for every *attempted* delivery — delivered, failed or skipped — and never for
 * the "nothing to report" case, because a daily "nothing happened" line is how a log teaches its
 * reader to stop reading it.
 */
export async function deliverNotification(
  document: AlertsV1,
  exitCode: number,
  options: DeliverOptions,
): Promise<NotifyOutcome> {
  const plan = planNotification(document, exitCode);
  if (plan === null) {
    return {
      planned: false,
      delivered: false,
      status: 'skipped',
      transport: 'none',
      detail: 'nothing to report',
    };
  }

  let outcome: NotifyOutcome;
  try {
    const config = webhookConfig(options.env);
    if (config.kind === 'http') {
      outcome = await deliverWebhook(document, config.target, options);
    } else if (config.kind === 'invalid') {
      // No fallback to the local channel: a configured channel that does not work must be reported,
      // not silently replaced — otherwise the operator keeps believing the webhook is wired.
      outcome = {
        planned: true,
        delivered: false,
        status: 'failed',
        transport: 'none',
        detail: config.detail,
      };
    } else {
      outcome = deliverLocal(plan, options);
    }
  } catch (error) {
    // A side channel must not be able to change what the evidence earned. Anything unexpected in
    // here is a delivery failure, reported like every other one; `runAlerts` returns the decision's
    // exit code regardless.
    outcome = {
      planned: true,
      delivered: false,
      status: 'failed',
      transport: 'none',
      detail: `the notification channel threw: ${reasonOf(error)}`,
    };
  }
  options.warn(notifyLine(outcome));
  return outcome;
}

function notifyLine(outcome: NotifyOutcome): string {
  const consequence =
    outcome.status === 'failed' ? ' (the exit code describes the evidence, not the transport)' : '';
  return `NOTIFY  ${outcome.status.toUpperCase()} — ${outcome.detail}${consequence}`;
}

async function deliverWebhook(
  document: AlertsV1,
  target: WebhookTarget,
  options: DeliverOptions,
): Promise<NotifyOutcome> {
  const timeoutMs = options.timeoutMs ?? WEBHOOK_TIMEOUT_MS;
  // The body is the validated `alerts.v1` object, stringified once: the webhook receives the same
  // document `--json` prints, so a receiver and a log reader cannot be told different counts.
  const result = await postAlerts(target.url, JSON.stringify(document), timeoutMs);
  const attempts = `${String(result.attempts)} attempt${result.attempts === 1 ? '' : 's'}`;
  if (result.ok) {
    return {
      planned: true,
      delivered: true,
      status: 'delivered',
      transport: 'webhook',
      detail: `${target.origin} answered HTTP ${String(result.status)} (${attempts})`,
    };
  }
  return {
    planned: true,
    delivered: false,
    status: 'failed',
    transport: 'webhook',
    detail: `${target.origin} did not accept the alert: ${result.detail} (${attempts})`,
  };
}

export interface PostResult {
  readonly ok: boolean;
  readonly attempts: number;
  readonly status: number | null;
  readonly detail: string;
}

/**
 * One POST, one retry, no more.
 *
 * Retry policy: a transport failure or a 5xx is retried once (the endpoint may be restarting); a 4xx
 * is not, because the same request refused for the same reason will be refused again. Redirects are
 * refused rather than followed: a 30x would re-POST the alert set to a host nobody configured.
 */
export async function postAlerts(
  url: string,
  body: string,
  timeoutMs = WEBHOOK_TIMEOUT_MS,
): Promise<PostResult> {
  let last: PostResult = {
    ok: false,
    attempts: 0,
    status: null,
    detail: 'no attempt was made',
  };
  for (let attempt = 1; attempt <= 2; attempt += 1) {
    try {
      const response = await fetch(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body,
        redirect: 'error',
        signal: AbortSignal.timeout(timeoutMs),
      });
      // Drain the body before deciding: an unread response keeps the socket, and the process, alive.
      await response.arrayBuffer().catch(() => undefined);
      last = {
        ok: response.ok,
        attempts: attempt,
        status: response.status,
        detail: `HTTP ${String(response.status)}`,
      };
      if (response.ok) return last;
      if (response.status < 500) return last;
    } catch (error) {
      last = { ok: false, attempts: attempt, status: null, detail: reasonOf(error) };
    }
  }
  return last;
}

function deliverLocal(plan: NotifyPlan, options: DeliverOptions): NotifyOutcome {
  if (options.platform !== 'darwin') {
    return {
      planned: true,
      delivered: false,
      status: 'skipped',
      transport: 'none',
      detail: `no local notification transport on ${options.platform}: osascript is macOS-only, so nothing was displayed (set ${WEBHOOK_ENV}, or read the alert lines above)`,
    };
  }
  const invocation = osascriptInvocation(plan);
  const result = spawnSync(invocation.command, [...invocation.args], {
    encoding: 'utf8',
    timeout: options.localTimeoutMs ?? LOCAL_TIMEOUT_MS,
    env: spawnEnv(options.env),
  });
  if (result.error !== undefined) {
    return failedLocal(`osascript could not be run: ${reasonOf(result.error)}`);
  }
  if (result.status !== 0) {
    const detail =
      (result.stderr ?? '').trim() ||
      (result.stdout ?? '').trim() ||
      `osascript exited ${String(result.status)} with no output`;
    return failedLocal(`osascript exited ${String(result.status)}: ${singleLine(detail)}`);
  }
  return {
    planned: true,
    delivered: true,
    status: 'delivered',
    transport: 'local',
    detail: 'macOS notification displayed through osascript',
  };
}

function failedLocal(detail: string): NotifyOutcome {
  return { planned: true, delivered: false, status: 'failed', transport: 'local', detail };
}

/**
 * The AppleScript, with the alert text passed as **argv** rather than built into the source.
 *
 * A task class or an anchor reason is data that came from a spec; interpolating it into AppleScript
 * would make a quote in a class name executable. `osascript -e <script> <arg>…` passes the arguments
 * to the script's `on run argv` handler (verified in `man osascript` on this host), so the text is
 * always text.
 */
export function osascriptInvocation(plan: NotifyPlan): {
  readonly command: string;
  readonly args: readonly string[];
} {
  const script = [
    'on run argv',
    'display notification (item 2 of argv) with title (item 1 of argv)',
    'end run',
  ].join('\n');
  return { command: 'osascript', args: ['-e', script, plan.title, plan.body] };
}

/** `spawn`'s env must contain only strings; an `undefined` value is a `TypeError`, not "unset". */
function spawnEnv(env: Readonly<Record<string, string | undefined>>): NodeJS.ProcessEnv {
  const out: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(env)) {
    if (value !== undefined) out[key] = value;
  }
  return out;
}

/** `<message>` plus its `cause`, because node's fetch reports a refusal as a bare "fetch failed". */
function reasonOf(error: unknown): string {
  if (!(error instanceof Error)) return singleLine(error);
  const cause = error.cause instanceof Error ? ` (${error.cause.message})` : '';
  return singleLine(`${error.message}${cause}`);
}

/** One line, bounded: a failure reason must not turn the one NOTIFY line into a block. */
function singleLine(value: unknown): string {
  const text = (value instanceof Error ? `${value.name}: ${value.message}` : String(value))
    .replace(/\s+/gu, ' ')
    .trim();
  if (text.length === 0) return 'no detail';
  return text.length > MAX_DETAIL ? `${text.slice(0, MAX_DETAIL)}…` : text;
}
