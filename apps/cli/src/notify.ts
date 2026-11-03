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
 *  - **webhook** (`FACTORY_ALERTS_WEBHOOK_URL`, a file, or `$FACTORY_HOME/secrets/alerts-webhook`): one
 *    POST. A Discord webhook is the operator's channel (`#dsh`), so a Discord URL gets the
 *    `content`/`embeds` body Discord actually accepts; every other URL keeps the raw `alerts.v1`
 *    document this module has always sent, byte for byte.
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
 *    services, a secret path for others — so it is reduced to scheme + host before it is ever printed,
 *    and a secret file that group or world can read is refused rather than used. The one thing worse
 *    than no channel is a channel that leaks its credential into a log file that is kept forever.
 *
 * The delivery is deliberately not durable: one attempt, at most one retry for the POST, and no
 * queue. The next scheduled run is the retry, which is the same reason the launchd job has no retry.
 */
import { spawnSync } from 'node:child_process';
import { closeSync, fstatSync, openSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { URL } from 'node:url';

import type { Alert, AlertCode, AlertSeverity, AlertsV1 } from '@factory/contracts';

// `resolveHome` is the one rule for where `$FACTORY_HOME` is; a second copy here is how the secret file
// and the store's state directory would start pointing at different factories a release later.
import { resolveHome } from './context.ts';
import { EXIT } from './exit.ts';

/** The environment variable that moves the channel off this machine; the 0600 file below is default. */
export const WEBHOOK_ENV = 'FACTORY_ALERTS_WEBHOOK_URL';

/** A file that holds the same URL, for a host where an environment variable is more visible. */
export const WEBHOOK_FILE_ENV = 'FACTORY_ALERTS_WEBHOOK_URL_FILE';

/** Where the operator's webhook lives by default: `$FACTORY_HOME/secrets/alerts-webhook`. */
export const WEBHOOK_SECRET_PATH = 'secrets/alerts-webhook';

/** One webhook attempt's budget. Two attempts at most, so a wedged endpoint costs ~10 s, not a day. */
export const WEBHOOK_TIMEOUT_MS = 5_000;

/**
 * The two hosts that serve Discord webhooks. `discordapp.com` is the legacy name and is still the
 * host in plenty of copied URLs; the adapter treats both the same.
 */
export const DISCORD_HOSTS: readonly string[] = ['discord.com', 'discordapp.com'];

/** A Discord webhook's path. A bare host is not enough: someone may point this at a real channel. */
export const DISCORD_WEBHOOK_PATH = '/api/webhooks/';

/** Discord's limits, enforced here rather than discovered as a 400 at 04:00. */
export const DISCORD_CONTENT_LIMIT = 2_000;
export const DISCORD_EMBED_LIMIT = 10;
export const DISCORD_DESCRIPTION_LIMIT = 4_096;
/** The whole message — content plus every embed — must stay under this. */
export const DISCORD_PAYLOAD_LIMIT = 6_000;

/** Discord embed colours (decimal RGB). Red is expired evidence; amber is "nothing is known". */
export const DISCORD_COLOR_EXPIRED = 0xed4245;
export const DISCORD_COLOR_UNKNOWN = 0xf0b232;

/** How long a 429 may make this process wait. A timer job must not sleep for a minute. */
export const RETRY_AFTER_CAP_MS = 5_000;

/** Used only when a 429's body carries no `retry_after` at all. */
const DEFAULT_RETRY_WAIT_MS = 1_000;

/** Where the launchd job appends; the truncation tail points the reader at the full record. */
const ALERTS_LOG = '~/.factory/alerts.log';

/** The exit-8 next command. Shared by the notification body and the Discord card so they cannot drift. */
const ANCHOR_VERIFY = 'factory ledger verify; docs/runbooks/ledger-anchor.md';

/** The exit-8 evidence line. The verb's body and the amber Discord card quote the same sentence. */
const UNREACHABLE_EVIDENCE = 'evidence: UNKNOWN — the anchor host did not answer (exit 8)';

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
    commands.add(ANCHOR_VERIFY);
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
      : UNREACHABLE_EVIDENCE;
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
 * Resolve the webhook configuration, in one order and with one rule for each source:
 *
 * 1. `FACTORY_ALERTS_WEBHOOK_URL` — the one-off/test override; it wins so a spec or a single run can
 *    point the channel somewhere without editing a file on disk.
 * 2. `FACTORY_ALERTS_WEBHOOK_URL_FILE` — a path to the same URL. A file named this way but missing,
 *    empty or readable by others is a **reported failure**, never a silent fallback to the local
 *    channel: the operator believes the webhook is wired, and pretending otherwise is worse than
 *    saying it is not.
 * 3. `$FACTORY_HOME/secrets/alerts-webhook` — the operator's real secret. Absent means "no webhook was
 *    ever configured", which is the normal local-notification case and therefore falls through to
 *    the local channel rather than failing.
 *
 * Empty and whitespace-only values mean "unset" at every step, because a launchd plist with an empty
 * `<string/>` should behave like no configuration rather than like a broken channel.
 */
export function resolveWebhookConfig(
  env: Readonly<Record<string, string | undefined>>,
  home: string,
): WebhookConfig {
  const direct = (env[WEBHOOK_ENV] ?? '').trim();
  if (direct.length > 0) return parseWebhookEnvUrl(direct);

  const named = (env[WEBHOOK_FILE_ENV] ?? '').trim();
  if (named.length > 0) {
    const file = readSecretFile(named);
    if (file.kind === 'value') return parseWebhookFileUrl(file.value, named);
    const why = file.kind === 'missing' ? 'it does not exist' : file.detail;
    return {
      kind: 'invalid',
      detail: `${WEBHOOK_FILE_ENV} names ${named}, but ${why}; nothing was sent`,
    };
  }

  const standard = join(home, WEBHOOK_SECRET_PATH);
  const file = readSecretFile(standard);
  if (file.kind === 'missing') return { kind: 'unset' };
  if (file.kind === 'value') return parseWebhookFileUrl(file.value, standard);
  return { kind: 'invalid', detail: file.detail };
}

/** The parsed shape of an http(s) URL, or the reason it is not one. The reason is never the value. */
type ParsedUrl = { readonly url: URL } | { readonly why: 'not-a-url' | 'not-http' | 'no-host' };

function asHttpUrl(raw: string): ParsedUrl {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    // The value is not echoed: a malformed URL can still carry a token in its path.
    return { why: 'not-a-url' };
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return { why: 'not-http' };
  if (url.hostname.length === 0) return { why: 'no-host' };
  return { url };
}

/** `origin` keeps scheme, host and port and drops userinfo, path, query and fragment. Withholding the
 * whole path (not just the query) is deliberate: the common webhook services put the credential in
 * the path, and this line is appended to a log that is never rotated away. */
function targetOf(raw: string, url: URL): WebhookTarget {
  return { url: raw, origin: url.origin };
}

function parseWebhookEnvUrl(raw: string): WebhookConfig {
  const parsed = asHttpUrl(raw);
  if ('url' in parsed) return { kind: 'http', target: targetOf(raw, parsed.url) };
  if (parsed.why === 'not-a-url') {
    return { kind: 'invalid', detail: `${WEBHOOK_ENV} is set but is not a URL; nothing was sent` };
  }
  if (parsed.why === 'not-http') {
    return { kind: 'invalid', detail: `${WEBHOOK_ENV} must be an http(s) URL; nothing was sent` };
  }
  return { kind: 'invalid', detail: `${WEBHOOK_ENV} has no host; nothing was sent` };
}

function parseWebhookFileUrl(raw: string, path: string): WebhookConfig {
  const parsed = asHttpUrl(raw);
  if ('url' in parsed) return { kind: 'http', target: targetOf(raw, parsed.url) };
  if (parsed.why === 'not-a-url') {
    return { kind: 'invalid', detail: `${path} does not contain a URL; nothing was sent` };
  }
  if (parsed.why === 'not-http') {
    return { kind: 'invalid', detail: `${path} must contain an http(s) URL; nothing was sent` };
  }
  return { kind: 'invalid', detail: `${path} contains a URL with no host; nothing was sent` };
}

type SecretFile =
  | { readonly kind: 'missing' }
  | { readonly kind: 'refused'; readonly detail: string }
  | { readonly kind: 'value'; readonly value: string };

/**
 * Read a webhook URL from a file that is only the owner's to read.
 *
 * The file is opened first and its mode checked with `fstat` on that descriptor, not with a separate
 * `stat` on the path: checking a path then opening it is a race, and the whole point of the rule is
 * that the value is not touched when the mode is wrong. A group- or world-readable file is refused
 * before a single byte of the URL is read, and the refusal names the fix (`chmod 600`) because a
 * message that only says "insecure" leaves the operator to guess.
 */
function readSecretFile(path: string): SecretFile {
  let fd: number;
  try {
    fd = openSync(path, 'r');
  } catch (error) {
    if (isMissingFile(error)) return { kind: 'missing' };
    return {
      kind: 'refused',
      detail: `${path} could not be opened: ${singleLine(error)}; nothing was sent`,
    };
  }
  try {
    const stat = fstatSync(fd);
    if (!stat.isFile()) {
      return { kind: 'refused', detail: `${path} is not a regular file; nothing was sent` };
    }
    if ((stat.mode & 0o077) !== 0) {
      return {
        kind: 'refused',
        detail:
          `${path} is mode ${octalMode(stat.mode)} — group- or world-accessible, so it is not read. ` +
          `Run: chmod 600 ${path}; nothing was sent`,
      };
    }
    const value = readFileSync(fd, 'utf8').trim();
    if (value.length === 0) {
      return { kind: 'refused', detail: `${path} is empty; nothing was sent` };
    }
    return { kind: 'value', value };
  } finally {
    closeSync(fd);
  }
}

function octalMode(mode: number): string {
  return (mode & 0o777).toString(8).padStart(3, '0');
}

function isMissingFile(error: unknown): boolean {
  if (typeof error !== 'object' || error === null || !('code' in error)) return false;
  return error.code === 'ENOENT';
}

// ---------------------------------------------------------------------------
// Discord: the operator's channel is a webhook, and a webhook is not an `alerts.v1` sink
// ---------------------------------------------------------------------------

/** One Discord embed: what a channel member sees as a card. */
export interface DiscordEmbed {
  readonly title: string;
  readonly description: string;
  /** Decimal RGB. Red is expired evidence; amber is "nothing is known". */
  readonly color: number;
}

/**
 * The body Discord accepts. `allowed_mentions` is not optional and not configurable: it is the field
 * that makes the difference between a notification channel and a way for a message — whose text comes
 * from a spec, a store or an anchor reason — to ping `@here` or a role at 04:00. Discord parses
 * mentions in message content unless this field says otherwise; `{ parse: [] }` says "none, ever",
 * and it is emitted on every body this module builds, including a truncated one.
 */
export interface DiscordPayload {
  readonly content: string;
  readonly embeds: readonly DiscordEmbed[];
  readonly allowed_mentions: { readonly parse: readonly string[] };
}

/**
 * True when the URL is a Discord webhook. Host **and** path: an unrelated `/api/webhooks/` endpoint on
 * another host keeps the raw `alerts.v1` POST, and `discord.com` without the webhook path is not
 * Discord's message API either.
 */
export function isDiscordWebhook(target: WebhookTarget): boolean {
  const url = new URL(target.url);
  return (
    DISCORD_HOSTS.includes(url.hostname.toLowerCase()) &&
    url.pathname.startsWith(DISCORD_WEBHOOK_PATH)
  );
}

/**
 * Build the Discord body for this document, or `null` when there is nothing to deliver.
 *
 * The decision of *whether* to say anything is still {@link planNotification}'s: exit 0 is silence (a
 * warning alone does not page), and the same `null` is returned here so a caller cannot accidentally
 * build a message for a clean run.
 *
 * The payload is built from the document rather than from the collapsed plan on purpose: Discord shows
 * one card per alert, which is where a per-class code is most useful, and the limits below are the
 * place where the list is bounded and the loss is admitted.
 */
export function discordPayload(document: AlertsV1, exitCode: number): DiscordPayload | null {
  if (planNotification(document, exitCode) === null) return null;

  const embeds = discordEmbeds(document);
  const summary = discordSummary(document);
  let kept: readonly DiscordEmbed[] = embeds.slice(0, DISCORD_EMBED_LIMIT);
  let omitted = embeds.length - kept.length;

  // Discord rejects a body over its budget, so shrink until the serialized body fits. The body's JSON
  // length is at least the character count Discord measures, so this is conservative in the safe
  // direction; a dropped alert is always counted in the tail rather than silently lost.
  for (;;) {
    const content = bound(
      omitted > 0 ? `${summary} …and ${String(omitted)} more, see \`${ALERTS_LOG}\`` : summary,
      DISCORD_CONTENT_LIMIT,
    );
    const candidate: DiscordPayload = {
      content,
      embeds: kept,
      allowed_mentions: { parse: [] },
    };
    if (JSON.stringify(candidate).length <= DISCORD_PAYLOAD_LIMIT) return candidate;
    if (kept.length === 0) return candidate;
    kept = kept.slice(0, -1);
    omitted += 1;
  }
}

/** One card per integrity alert, in document order; warnings never ride the page. */
function discordEmbeds(document: AlertsV1): readonly DiscordEmbed[] {
  const embeds: DiscordEmbed[] = [];
  if (document.anchor.state === 'unreachable') {
    // Unreachable is not an alert (alerts.v1: unreachable is not missing), so without this card the
    // exit-8 page would be a colourless sentence with nothing to act on. Amber is the colour that says
    // "nothing is known", which is exactly the distinction exit 8 makes against exit 9's red.
    embeds.push({
      title: 'ANCHOR_UNREACHABLE',
      description: `${UNREACHABLE_EVIDENCE}\nnext: ${ANCHOR_VERIFY}`,
      color: DISCORD_COLOR_UNKNOWN,
    });
  }
  for (const alert of document.alerts) {
    if (alert.severity !== 'integrity') continue;
    embeds.push({
      title: alert.code,
      description: bound(
        `${alert.subject} — ${alert.reason}\nnext: ${alert.investigation}`,
        DISCORD_DESCRIPTION_LIMIT,
      ),
      // Every alert that pages is integrity-grade by construction, and integrity-grade is red.
      color: DISCORD_COLOR_EXPIRED,
    });
  }
  return embeds;
}

/** One line, as Discord shows it above the cards: the count that matters and the anchor's state. */
function discordSummary(document: AlertsV1): string {
  const integrity = document.counts.bySeverity.integrity;
  const count = integrity > 0 ? [`${String(integrity)} integrity`] : [];
  const anchor = document.anchor.state;
  if (anchor === 'unreachable') {
    return `factory alerts — ${[...count, 'anchor unreachable (exit 8)'].join(', ')}`;
  }
  if (anchor === 'unconfigured') {
    return `factory alerts — ${[...count, 'no anchor configured (exit 8)'].join(', ')}`;
  }
  return `factory alerts — ${[...count, `anchor ${anchor}`].join(', ')}`;
}

/** Bound one field to its Discord limit. The ellipsis is how a truncated field admits it. */
function bound(text: string, limit: number): string {
  return text.length <= limit ? text : `${text.slice(0, limit - 1)}…`;
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
  /**
   * The factory home, so the default secret can be read from `$FACTORY_HOME/secrets/alerts-webhook`.
   * The CLI passes it from its context; when it is omitted (a direct caller that predates the file),
   * {@link resolveHome} applies the one home rule rather than a second copy of it. Specs pass a temp
   * directory so a spec can never read the operator's real secret.
   */
  readonly home?: string | undefined;
  /** `process.platform`, injected so the non-macOS no-op is a spec rather than an assumption. */
  readonly platform: string;
  /** Where the one line about the channel goes: stderr, never stdout (`--json` owns stdout). */
  readonly warn: (line: string) => void;
  readonly timeoutMs?: number | undefined;
  /** `osascript`'s budget; injectable so a spec can prove the kill without waiting ten seconds. */
  readonly localTimeoutMs?: number | undefined;
  /** The 429 backoff; injectable so a spec proves the retry without sleeping in the suite. */
  readonly sleep?: ((ms: number) => Promise<void>) | undefined;
  /**
   * Discord detection, injectable for the same reason `platform` is: a spec for the Discord adapter has
   * to talk to a loopback listener, and a spec that resolves `discord.com` is a spec that can page a
   * real channel. Production always uses {@link isDiscordWebhook}.
   */
  readonly detectsDiscord?: ((target: WebhookTarget) => boolean) | undefined;
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
    const config = resolveWebhookConfig(options.env, options.home ?? resolveHome(options.env));
    if (config.kind === 'http') {
      // Discord gets a body it accepts; everything else keeps the raw `alerts.v1` POST it always had.
      const detects = options.detectsDiscord ?? isDiscordWebhook;
      outcome = detects(config.target)
        ? await deliverDiscord(document, exitCode, config.target, options)
        : await deliverRawDocument(document, config.target, options);
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

/**
 * The non-Discord transport: one POST of the validated `alerts.v1` document, unchanged from `045ae5f`.
 *
 * The body is stringified once from the same validated object `--json` prints, so a receiver and a log
 * reader cannot be told different counts. This path must stay byte-identical for every endpoint that
 * is not a Discord webhook: a consumer that parsed `alerts.v1` yesterday must keep parsing it today.
 */
async function deliverRawDocument(
  document: AlertsV1,
  target: WebhookTarget,
  options: DeliverOptions,
): Promise<NotifyOutcome> {
  const timeoutMs = options.timeoutMs ?? WEBHOOK_TIMEOUT_MS;
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

/** The Discord transport: one POST of the `content`/`embeds` body, with the mention guard on it. */
async function deliverDiscord(
  document: AlertsV1,
  exitCode: number,
  target: WebhookTarget,
  options: DeliverOptions,
): Promise<NotifyOutcome> {
  const payload = discordPayload(document, exitCode);
  if (payload === null) {
    // `deliverNotification` already returned for a null plan, so this is a type-level guard rather
    // than a branch a caller can reach: a side channel must never become the failure.
    return {
      planned: false,
      delivered: false,
      status: 'skipped',
      transport: 'none',
      detail: 'nothing to report',
    };
  }
  const result = await postDiscord(target.url, payload, {
    timeoutMs: options.timeoutMs ?? WEBHOOK_TIMEOUT_MS,
    sleep: options.sleep,
  });
  const attempts = `${String(result.attempts)} attempt${result.attempts === 1 ? '' : 's'}`;
  if (result.ok) {
    return {
      planned: true,
      delivered: true,
      status: 'delivered',
      transport: 'webhook',
      detail: `${target.origin} accepted the Discord message (${result.detail}, ${attempts})`,
    };
  }
  return {
    planned: true,
    delivered: false,
    status: 'failed',
    transport: 'webhook',
    detail: `${target.origin} did not accept the Discord message: ${result.detail} (${attempts})`,
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

export interface DiscordPostOptions {
  readonly timeoutMs?: number | undefined;
  /** Injected so a 429 spec records the wait instead of performing it. */
  readonly sleep?: ((ms: number) => Promise<void>) | undefined;
}

/** One delivery plus at most one retry, like the raw transport. */
export const DISCORD_MAX_ATTEMPTS = 2;

/** What one Discord attempt decided. The caller owns the retry policy; this owns one HTTP exchange. */
type DiscordAttempt =
  | { readonly kind: 'delivered'; readonly status: number }
  | {
      readonly kind: 'rate-limited';
      readonly status: number;
      readonly waitMs: number;
      readonly note: string;
      readonly detail: string;
    }
  | { readonly kind: 'retryable'; readonly status: number | null; readonly detail: string }
  | { readonly kind: 'refused'; readonly status: number; readonly detail: string };

/**
 * One POST of the Discord body, one retry, no more.
 *
 * Discord answers **204 No Content** on success — there is no body to parse — and **200** for some
 * endpoints, so any 2xx is a delivery. A 400 is not retried: the same message refused for the same
 * reason would be refused again, and the body carries Discord's own `message`, which is what the
 * operator needs to fix it. A 429 *is* retried, because it is a "not now", not a "no": the one retry
 * waits `retry_after` (fractional seconds) but never more than {@link RETRY_AFTER_CAP_MS}, because a
 * timer job that sleeps for a minute is a job that holds a process for nothing. A 5xx or a transport
 * failure gets the same single retry as the raw transport; redirects are refused, not followed.
 */
export async function postDiscord(
  url: string,
  payload: DiscordPayload,
  options: DiscordPostOptions = {},
): Promise<PostResult> {
  const timeoutMs = options.timeoutMs ?? WEBHOOK_TIMEOUT_MS;
  const sleep = options.sleep ?? delay;
  const body = JSON.stringify(payload);
  let retryNote: string | null = null;
  let last: PostResult = { ok: false, attempts: 0, status: null, detail: 'no attempt was made' };

  for (let attempt = 1; attempt <= DISCORD_MAX_ATTEMPTS; attempt += 1) {
    const outcome = await oneDiscordAttempt(url, body, timeoutMs);
    if (outcome.kind === 'delivered') {
      const after = retryNote === null ? '' : ` after a 429 (${retryNote})`;
      return {
        ok: true,
        attempts: attempt,
        status: outcome.status,
        detail: `HTTP ${String(outcome.status)}${after}`,
      };
    }
    last = {
      ok: false,
      attempts: attempt,
      status: outcome.status,
      detail: outcome.detail,
    };
    if (outcome.kind === 'rate-limited' && attempt < DISCORD_MAX_ATTEMPTS) {
      retryNote = outcome.note;
      await sleep(outcome.waitMs);
      continue;
    }
    if (outcome.kind === 'rate-limited') {
      return {
        ok: false,
        attempts: attempt,
        status: outcome.status,
        detail: `HTTP 429: still rate-limited after one retry (${outcome.note})`,
      };
    }
    if (outcome.kind === 'retryable' && attempt < DISCORD_MAX_ATTEMPTS) continue;
    return last;
  }
  return last;
}

async function oneDiscordAttempt(
  url: string,
  body: string,
  timeoutMs: number,
): Promise<DiscordAttempt> {
  try {
    const response = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body,
      redirect: 'error',
      signal: AbortSignal.timeout(timeoutMs),
    });
    // Read the body even on success: Discord's 204 has none, an unread response keeps the socket
    // alive, and a 400's `message` is the only useful part of a refusal.
    const text = await response.text().catch(() => '');
    if (response.ok) return { kind: 'delivered', status: response.status };
    const detail = withDiscordMessage(`HTTP ${String(response.status)}`, text);
    if (response.status === 429) {
      const retryAfter = retryAfterSeconds(text);
      const waitMs =
        retryAfter === null
          ? DEFAULT_RETRY_WAIT_MS
          : Math.min(retryAfter * 1_000, RETRY_AFTER_CAP_MS);
      const note =
        retryAfter === null
          ? 'the 429 carried no retry_after'
          : retryAfter * 1_000 > RETRY_AFTER_CAP_MS
            ? `retry_after ${String(retryAfter)} s, capped at ${String(RETRY_AFTER_CAP_MS / 1_000)} s`
            : `retry_after ${String(retryAfter)} s`;
      return { kind: 'rate-limited', status: 429, waitMs, note, detail: `${detail} (${note})` };
    }
    if (response.status >= 500) {
      return { kind: 'retryable', status: response.status, detail };
    }
    return { kind: 'refused', status: response.status, detail };
  } catch (error) {
    return { kind: 'retryable', status: null, detail: reasonOf(error) };
  }
}

/** Discord's own `message` field, when the body has one. Never the token: the URL is not echoed. */
function withDiscordMessage(prefix: string, text: string): string {
  const parsed = parsedJson(text);
  if (parsed === null || typeof parsed !== 'object' || !('message' in parsed)) return prefix;
  const message: unknown = parsed.message;
  if (typeof message !== 'string' || message.trim().length === 0) return prefix;
  return `${prefix}: ${singleLine(message)}`;
}

/** `retry_after` in seconds (Discord sends fractions); `null` when the body does not carry a number. */
function retryAfterSeconds(text: string): number | null {
  const parsed = parsedJson(text);
  if (parsed === null || typeof parsed !== 'object' || !('retry_after' in parsed)) return null;
  const value: unknown = parsed.retry_after;
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) return null;
  return value;
}

/** JSON.parse without the throw, for response bodies that may be empty (204) or not JSON at all. */
function parsedJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

/** The real backoff. Production's only sleep; every spec injects its own. */
function delay(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
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
