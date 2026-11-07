/**
 * The off-host anchor: a second place that remembers what the ledger said.
 *
 * ## What this is for
 *
 * The ledger is append-only *in SQLite*, which is a promise made by triggers inside the same file a
 * host-level attacker controls. Every control in this factory — the wall's verdicts, the budget's
 * reservations, the receipt hashes — is evidence kept on one machine, and a machine that can rewrite
 * its own history makes all of it unfalsifiable. The anchor is the smallest thing that changes that:
 * once a day, a small record `{seq, headHash, eventCount, anchoredAt}` is written somewhere the
 * factory does not own, and the factory refuses to trust a ledger whose head has no anchor newer than
 * `maxAgeHours` (ND4, ratified 2026-11-01).
 *
 * ## What it does not do
 *
 * It does not prevent a rewrite; it makes one **detectable within the window**. It does not prove the
 * anchored content was correct, only that this head existed at that time. And a "local" transport
 * (another directory on the same disk) is recorded as such: `verify` distinguishes an anchor that is
 * merely old from an anchor that is not off-host at all, because "anchored" on the same disk is the
 * claim this module exists to avoid.
 *
 * ## The head, defined so two implementations agree
 *
 * `headHash` is a chain over every event in `seq` order:
 *
 *     chain₀ = "sha256:" + hex(sha256("factory-ledger/v1"))
 *     chainᵢ = "sha256:" + hex(sha256(chainᵢ₋₁ + contentHash(eventᵢ)))
 *
 * `contentHash` is the contracts' canonical-JSON hash, so field order cannot change the answer. A
 * verifier that reads the same events computes the same head; that is the whole mechanism.
 */
import { appendFile, mkdir, readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';

import { canonicalJson, FactoryError, isFactoryError, sha256Hex } from '@factory/contracts';

/** The record written off-host. Small on purpose: it is read on every `verify`. */
export interface AnchorRecord {
  readonly schemaVersion: 1;
  /** The last ledger `seq` included in `headHash`. */
  readonly seq: number;
  readonly eventCount: number;
  readonly headHash: string;
  readonly anchoredAt: string;
}

/** The chain's origin is itself a hash, so an empty ledger still has a hash-shaped head. */
const GENESIS_INPUT = 'factory-ledger/v1';
const GENESIS_HASH = `sha256:${sha256Hex(GENESIS_INPUT)}`;

/** Canonical hash of one event. Exported because a verifier needs to recompute the chain. */
export function eventContentHash(event: unknown): string {
  return `sha256:${sha256Hex(canonicalJson(event))}`;
}

/**
 * The chain head for `events`, which must be in `seq` order.
 *
 * The chain is built from the events themselves rather than from stored per-row hashes: a database
 * that could rewrite a row could rewrite its stored hash too, and then the anchor would agree with
 * the forgery.
 */
export function computeHeadHash(events: readonly unknown[]): string {
  let chain = GENESIS_HASH;
  for (const event of events) chain = `sha256:${sha256Hex(chain + eventContentHash(event))}`;
  return chain;
}

/** Build the record for the ledger's current head. */
export function computeAnchor(events: readonly unknown[], anchoredAt: string): AnchorRecord {
  const sorted = [...events];
  return {
    schemaVersion: 1,
    seq: lastSeq(sorted),
    eventCount: sorted.length,
    headHash: computeHeadHash(sorted),
    anchoredAt,
  };
}

function lastSeq(events: readonly unknown[]): number {
  let last = 0;
  for (const event of events) {
    const seq = (event as { seq?: unknown }).seq;
    if (typeof seq === 'number' && seq > last) last = seq;
  }
  return last;
}

export type AnchorOutcome = 'fresh' | 'stale' | 'missing' | 'rollback';

export interface AnchorVerdict {
  /** `fresh` is the only outcome that lets a caller claim the ledger is anchored. */
  readonly outcome: AnchorOutcome;
  /** True when the anchor lives somewhere other than this machine's factory home. */
  readonly offHost: boolean;
  readonly ageHours: number | null;
  readonly record: AnchorRecord | null;
  readonly reason: string;
}

export interface VerifyOptions {
  readonly nowIso: string;
  readonly maxAgeHours?: number;
  /** Where the transport says the anchor lives; see `AnchorTransport.scope`. */
  readonly scope?: 'off-host' | 'local';
  /** The local head, so a rolled-back database is detected rather than reported fresh. */
  readonly local?: { readonly seq: number; readonly eventCount: number } | undefined;
}

export const DEFAULT_MAX_AGE_HOURS = 48;

/**
 * Decide whether the anchor is worth anything *right now*.
 *
 * `rollback` is the outcome that matters most and the one a naive "is it recent?" check misses: if
 * the anchor says the ledger had 400 events and this database has 380, the local file was replaced
 * with an older copy. Reporting that as `fresh` because the anchor was written an hour ago would be
 * the exact failure the anchor exists to catch.
 */
export function verifyAnchor(record: AnchorRecord | null, options: VerifyOptions): AnchorVerdict {
  const maxAgeHours = options.maxAgeHours ?? DEFAULT_MAX_AGE_HOURS;
  const scope = options.scope ?? 'local';
  const offHost = scope === 'off-host';
  if (record === null) {
    return {
      outcome: 'missing',
      offHost,
      ageHours: null,
      record: null,
      reason:
        'no anchor exists, so nothing off this machine can contradict a rewritten ledger; run `factory ledger anchor`',
    };
  }
  const anchoredAt = Date.parse(record.anchoredAt);
  const now = Date.parse(options.nowIso);
  if (Number.isNaN(anchoredAt) || Number.isNaN(now)) {
    return {
      outcome: 'missing',
      offHost,
      ageHours: null,
      record,
      reason: 'the anchor has an unparseable timestamp, which is the same as having none',
    };
  }
  const ageHours = (now - anchoredAt) / 3_600_000;
  if (options.local !== undefined && record.eventCount > options.local.eventCount) {
    return {
      outcome: 'rollback',
      offHost,
      ageHours,
      record,
      reason:
        `the anchor has ${String(record.eventCount)} events and this ledger has ` +
        `${String(options.local.eventCount)}: the local database is older than an anchor that was ` +
        'already written, so it was replaced or restored. Investigate before trusting any verdict.',
    };
  }
  if (ageHours > maxAgeHours) {
    return {
      outcome: 'stale',
      offHost,
      ageHours,
      record,
      reason:
        `the last anchor is ${ageHours.toFixed(1)} h old (limit ${String(maxAgeHours)} h); a rewrite ` +
        'after that point is undetectable until the next anchor',
    };
  }
  return {
    outcome: 'fresh',
    offHost,
    ageHours,
    record,
    reason: offHost
      ? `anchored ${ageHours.toFixed(1)} h ago, off-host`
      : `anchored ${ageHours.toFixed(1)} h ago, but the anchor is on this machine — this detects ` +
        'truncation, not a host that rewrites both copies',
  };
}

/**
 * Where the anchor is kept. Two implementations and no third: a directory, or a command (which is how
 * `ssh host 'cat …'` is expressed). A `scope` that says `local` for anything on this disk is load-bearing
 * — `verify` will not call a local anchor off-host.
 */
export interface AnchorTransport {
  readonly kind: 'file' | 'command';
  readonly scope: 'off-host' | 'local';
  /** Human-readable, and safe to print: never a key, never a secret. */
  describe(): string;
  append(record: AnchorRecord): Promise<void>;
  readHead(): Promise<AnchorRecord | null>;
}

/** A JSON-lines file of anchors: append-only by construction, last line wins. */
export function fileTransport(
  directory: string,
  scope: 'off-host' | 'local' = 'local',
): AnchorTransport {
  const path = join(directory, 'ledger-anchors.jsonl');
  return {
    kind: 'file',
    scope,
    describe: () => `file ${path} (${scope})`,
    async append(record) {
      await mkdir(dirname(path), { recursive: true });
      await appendFile(path, `${JSON.stringify(record)}\n`, 'utf8');
    },
    async readHead() {
      let text: string;
      try {
        text = await readFile(path, 'utf8');
      } catch (error) {
        // A genuinely absent file is a fact about the ledger: nothing was ever anchored here, and
        // `verify` must say `missing` (exit 9). Anything else — `EACCES`, `EISDIR`, a disk that
        // refuses — means nobody looked, and it must not be reported as `missing` (exit 8 instead).
        if (errnoOf(error) === 'ENOENT') return null;
        throw new FactoryError(
          'ANCHOR_UNAVAILABLE',
          `the anchor at file ${path} could not be read: ${errnoDetail(error)}. ` +
            'This is an environment failure, not a verdict about the ledger — nothing was learned ' +
            'about the ledger, so it is not `missing`.',
          { transport: `file ${path}`, errno: errnoOf(error) },
        );
      }
      return recordOrRefuse(text, `file ${path}`);
    },
  };
}

/**
 * A command pair, for `ssh <host> 'cat …'` and `ssh <host> 'cat >> …'`.
 *
 * The command runs with `sh -c` and its stdin is the record on append. It is only ever reached from a
 * composition root that read the command from configuration, never from a unit's spec or a receipt —
 * an anchor command taken from data would be a remote shell in a config file.
 */
export function commandTransport(options: {
  readonly read: string;
  readonly append: string;
  readonly label: string;
  /**
   * How many times a **transport** failure is retried before the read is called unavailable.
   *
   * The 04:00 job reads the anchor over ssh, and the first attempt after a laptop wakes can lose a
   * route for a few seconds: observed once in four nights, as `ssh: connect … Operation timed out`.
   * One flake is not evidence that the ledger is unwatched, and an alarm that fires on one is an
   * alarm people learn to ignore. A *persistent* failure still refuses — the retry bounds how long a
   * transient one is allowed to hide, it does not let an unreachable host report `fresh`.
   *
   * Only a non-zero exit (ssh's 255, a shell that never started) is retried. A read that succeeded
   * with unparseable content is a fact about the file and a second attempt cannot change it.
   */
  readonly retry?: { readonly attempts: number; readonly delayMs: number } | undefined;
}): AnchorTransport {
  const attempts = Math.max(1, Math.trunc(options.retry?.attempts ?? 3));
  const delayMs = Math.max(0, Math.trunc(options.retry?.delayMs ?? 750));
  return {
    kind: 'command',
    scope: 'off-host',
    describe: () => `command ${options.label}`,
    async append(record) {
      const { spawn } = await import('node:child_process');
      await new Promise<void>((resolve, reject) => {
        const child = spawn('sh', ['-c', options.append], { stdio: ['pipe', 'ignore', 'pipe'] });
        let stderr = '';
        child.stderr.setEncoding('utf8');
        child.stderr.on('data', (chunk: string) => (stderr += chunk));
        child.once('error', reject);
        child.once('close', (code) =>
          code === 0
            ? resolve()
            : reject(
                new FactoryError(
                  'ANCHOR_UNAVAILABLE',
                  `the anchor at ${options.label} could not be written (exit ${String(code)}): ` +
                    `${(stderr.trim() || 'no stderr').replace(/\.+$/u, '')}. This is an environment ` +
                    'failure, not a verdict ' +
                    'about the ledger.',
                  { transport: options.label, exitCode: code },
                ),
              ),
        );
        child.stdin.end(`${JSON.stringify(record)}\n`);
      });
    },
    /**
     * Read the head, and keep "I could not look" apart from "there is nothing there".
     *
     * A non-zero exit — ssh's 255 for an unreachable host, a shell that could not start — means the
     * anchor was never read, and that is an **environment** failure, not a verdict about the ledger.
     * Resolving `null` made `ledger verify` call an unreachable host `missing`, which is the same
     * class of lie as reporting a transport failure as "fresh": the reader is told a fact about the
     * ledger that nobody measured.
     *
     * A *successful* command with no parseable record — an empty file, a file whose last line is
     * half-written — is genuinely `missing` and resolves `null`. The read commands are composed to
     * make that distinction reliable: the remote `tail … || true` keeps a missing *file* at exit 0
     * while ssh's own connection failure still exits 255.
     */
    async readHead() {
      let last: unknown = null;
      for (let attempt = 1; attempt <= attempts; attempt += 1) {
        try {
          return await readOnce();
        } catch (error) {
          last = error;
          const retryable = isFactoryError(error) && error.details['retryable'] === true;
          if (!retryable || attempt === attempts) break;
          if (delayMs > 0) await new Promise((resolve) => setTimeout(resolve, delayMs));
        }
      }
      // The sentence an operator reads must say how hard the check tried, or a flake and an outage
      // look the same in the log — which is the defect this retry exists to fix.
      if (isFactoryError(last) && attempts > 1) {
        throw new FactoryError(last.code, `${last.message} (retried ${String(attempts)} times)`, {
          ...last.details,
          attempts,
        });
      }
      if (last instanceof Error) throw last;
      throw new FactoryError(
        'ANCHOR_UNAVAILABLE',
        `the anchor at ${options.label} could not be read: ${String(last)}. This is an environment ` +
          'failure, not a verdict about the ledger.',
        { transport: options.label },
      );
    },
  };

  async function readOnce(): Promise<AnchorRecord | null> {
    const { spawn } = await import('node:child_process');
    return await new Promise<AnchorRecord | null>((resolve, reject) => {
      const child = spawn('sh', ['-c', options.read], { stdio: ['ignore', 'pipe', 'pipe'] });
      let stdout = '';
      let stderr = '';
      child.stdout.setEncoding('utf8');
      child.stderr.setEncoding('utf8');
      child.stdout.on('data', (chunk: string) => (stdout += chunk));
      child.stderr.on('data', (chunk: string) => (stderr += chunk));
      child.once('error', (error) => {
        reject(
          new FactoryError(
            'ANCHOR_UNAVAILABLE',
            `the anchor at ${options.label} could not be read: ${error.message}. ` +
              'This is an environment failure, not a verdict about the ledger.',
            { transport: options.label },
          ),
        );
      });
      child.once('close', (code) => {
        if (code !== 0) {
          const last = stderr.trim().split('\n').filter(Boolean).slice(-1)[0] ?? 'no stderr';
          // ssh's own messages end in a period; the sentence continues, so drop it rather than
          // print "...failed.." to an operator.
          const detail = last.replace(/\.+$/u, '');
          reject(
            new FactoryError(
              'ANCHOR_UNAVAILABLE',
              `the anchor at ${options.label} could not be read (exit ${String(code)}): ${detail}. ` +
                'This is an environment failure, not a verdict about the ledger — nothing was ' +
                'learned about the ledger, so it is not `missing`.',
              // `retryable` is the whole distinction: the check never ran. An unparseable anchor
              // (below) is also ANCHOR_UNAVAILABLE, but asking again cannot change a file.
              { transport: options.label, exitCode: code, retryable: true },
            ),
          );
          return;
        }
        // `recordOrRefuse` throws for content that exists but cannot be parsed, and a throw inside
        // an event handler is an uncaught exception rather than a rejection — it would escape the
        // promise, so it is turned into a rejection here, deliberately.
        try {
          resolve(recordOrRefuse(stdout, options.label));
        } catch (error) {
          reject(error);
        }
      });
    });
  }
}

/**
 * How an off-host anchor is reached: one place, so `read` and `append` cannot drift apart.
 *
 * `ConnectTimeout` is load-bearing and was missing. Without it a dead route hangs until the kernel
 * gives up — measured as a ~2-minute wait at 04:00 before the job reported `UNREACHABLE` — so the
 * bounded retry in `commandTransport` would have multiplied a minute-scale hang by three. With a
 * 10 s connect timeout each attempt fails fast enough to be worth retrying.
 *
 * `ServerAliveInterval`/`ServerAliveCountMax` bound the other half: a connection that establishes and
 * then goes silent (a laptop sleeping mid-read) is dropped after ~10 s instead of blocking the job.
 */
const SSH_OPTIONS =
  '-o BatchMode=yes -o ConnectTimeout=10 -o ServerAliveInterval=5 -o ServerAliveCountMax=2';

/** The remote command, quoted so configuration cannot become a second shell command. */
export function sshCommand(host: string, remoteCommand: string): string {
  const quoted = remoteCommand.replace(/'/gu, "'\\''");
  return `ssh ${SSH_OPTIONS} -- ${host} '${quoted}'`;
}

/** What the operator configured, or a refusal that names both variables. */
export interface AnchorTarget {
  readonly transport: AnchorTransport;
  /** True when a `--dir` flag overrode the environment: the flag wins, by design. */
  readonly overridden: boolean;
}

/**
 * Build the anchor transport from the running configuration, the same way for every caller.
 *
 * One function, not two: `factory ledger verify` and `factory alerts` must read the same variable,
 * apply the same default path and refuse with the same sentence, or a monitor can watch a different
 * anchor than the one the control verifies. This lives in `@factory/anchor` rather than in either
 * verb for that reason — it is the shape of the configuration, not a rendering decision.
 *
 * Precedence: an explicit `--dir` (local, and reported as local) beats `FACTORY_ANCHOR_SSH`, which
 * beats `FACTORY_ANCHOR_DIR`. A local transport is never called off-host, because it is not.
 */
export function anchorTargetFrom(
  env: Readonly<Record<string, string | undefined>>,
  overrides: { readonly directory?: string | undefined } = {},
): AnchorTarget {
  const explicitDir = overrides.directory?.trim();
  const host = (env['FACTORY_ANCHOR_SSH'] ?? '').trim();
  const remotePath = (env['FACTORY_ANCHOR_PATH'] ?? '/var/lib/factory/ledger-anchors.jsonl').trim();
  const directory = explicitDir ?? (env['FACTORY_ANCHOR_DIR'] ?? '').trim();

  if (explicitDir !== undefined && explicitDir !== '') {
    return { transport: fileTransport(explicitDir, 'local'), overridden: true };
  }
  if (host !== '') {
    // `--` and single quotes: the host and path are configuration, and neither may grow into a shell.
    // `|| true` on the read is deliberate: a missing remote *file* is `missing`, an unreachable host
    // is ssh's own non-zero exit, and only the latter should be a transport failure.
    return {
      transport: commandTransport({
        read: sshCommand(host, `tail -n 50 -- ${remotePath} 2>/dev/null || true`),
        append: sshCommand(host, `cat >> ${remotePath}`),
        label: `ssh ${host}:${remotePath}`,
      }),
      overridden: false,
    };
  }
  if (directory !== '') return { transport: fileTransport(directory, 'local'), overridden: false };

  throw new FactoryError(
    'ANCHOR_UNAVAILABLE',
    'no anchor target is configured: set FACTORY_ANCHOR_SSH (+ FACTORY_ANCHOR_PATH) for an off-host ' +
      'anchor, or FACTORY_ANCHOR_DIR for a local one. A local anchor detects truncation but not a host ' +
      'that rewrites both copies, and `verify` will say so.',
  );
}

/** The errno of a filesystem error, when it has one. */
function errnoOf(error: unknown): string | null {
  const code = (error as { code?: unknown } | null)?.code;
  return typeof code === 'string' ? code : null;
}

/** The errno and its sentence, because "could not be read" alone sends the reader to `ls`. */
function errnoDetail(error: unknown): string {
  const code = errnoOf(error);
  const message = error instanceof Error ? error.message : String(error);
  return code === null ? message : message.includes(code) ? message : `${code}: ${message}`;
}

/**
 * A record, or a refusal — never a silent `null` for content that exists but cannot be parsed.
 *
 * Both transports route through this, because the same claim has to hold for a local file and for an
 * ssh read: **empty means missing** (the command ran, the file is empty or absent behind `|| true`),
 * and **non-empty but unparseable means the check could not be performed** — an anchor file with
 * garbage in it, a half-written record with no earlier good line, a schema this build does not know.
 * Returning `null` for the second case would report `missing` (exit 9), which asserts a fact about
 * the ledger that nobody established; exit 8 says only what is true: I could not look.
 */
function recordOrRefuse(text: string, label: string): AnchorRecord | null {
  const record = lastValidRecord(text);
  if (record !== null) return record;
  const trimmed = text.trim();
  if (trimmed === '') return null;
  throw new FactoryError(
    'ANCHOR_UNAVAILABLE',
    `the anchor at ${label} exists but holds no readable record (${trimmed.length} bytes, no line ` +
      'parses as an anchor). This is an environment failure, not a verdict about the ledger — the ' +
      'check could not be performed, so it is not `missing`.',
    { transport: label, bytes: trimmed.length },
  );
}

/** The last line that parses as an anchor. A truncated tail must not hide a good record. */
export function lastValidRecord(text: string): AnchorRecord | null {
  const lines = text.split('\n').filter((line) => line.trim() !== '');
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    const parsed = parseRecord(lines[index] ?? '');
    if (parsed !== null) return parsed;
  }
  return null;
}

function parseRecord(line: string): AnchorRecord | null {
  try {
    const value: unknown = JSON.parse(line);
    if (typeof value !== 'object' || value === null) return null;
    const record = value as Partial<AnchorRecord>;
    if (record.schemaVersion !== 1) return null;
    if (typeof record.seq !== 'number' || typeof record.eventCount !== 'number') return null;
    if (typeof record.headHash !== 'string' || typeof record.anchoredAt !== 'string') return null;
    return {
      schemaVersion: 1,
      seq: record.seq,
      eventCount: record.eventCount,
      headHash: record.headHash,
      anchoredAt: record.anchoredAt,
    };
  } catch {
    return null;
  }
}

/** A stable name for a hash, for logs: enough to compare, not enough to leak a payload. */
export function shortHash(hash: string): string {
  return hash.startsWith('sha256:') ? `sha256:${hash.slice(7, 19)}…` : hash.slice(0, 12);
}
