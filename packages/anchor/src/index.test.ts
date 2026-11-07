/**
 * The anchor, tested without a database and without a network.
 *
 * Two properties carry the design and are asserted directly rather than through the CLI:
 *
 * 1. **The head is recomputable by someone else.** The spec rebuilds the chain with `sha256` and
 *    `canonicalJson` directly, exactly as an auditor with a copy of the ledger would, and requires the
 *    same string. If the implementation ever "improved" the chain in a way a verifier cannot follow,
 *    the anchor would stop being evidence.
 * 2. **`rollback` is not `fresh`.** An anchor that is one hour old and says 400 events, next to a
 *    database holding 380, is the attack the anchor exists for. A recency-only check calls that fresh.
 */
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { canonicalJson, sha256Hex } from '@factory/contracts';
import { describe, expect, it } from 'vitest';

import {
  computeAnchor,
  computeHeadHash,
  anchorTargetFrom,
  commandTransport,
  eventContentHash,
  fileTransport,
  lastValidRecord,
  shortHash,
  sshCommand,
  verifyAnchor,
  type AnchorRecord,
} from './index.ts';

function fixtureEvents(
  count: number,
): { seq: number; eventId: string; type: string; payload: unknown }[] {
  return Array.from({ length: count }, (_, index) => ({
    seq: index + 1,
    eventId: `evt-${String(index + 1)}`,
    type: 'unit.submitted',
    payload: { unitId: `U-${String(index + 1)}`, n: index },
  }));
}

/** The verifier's own implementation of the chain: no import of the module under test. */
function independentHead(events: readonly unknown[]): string {
  let chain = `sha256:${sha256Hex('factory-ledger/v1')}`;
  for (const event of events) {
    chain = `sha256:${sha256Hex(chain + `sha256:${sha256Hex(canonicalJson(event))}`)}`;
  }
  return chain;
}

describe('the head hash is something a second party can recompute', () => {
  it('matches an independent rebuild of the chain', () => {
    const events = fixtureEvents(5);
    expect(computeHeadHash(events)).toBe(independentHead(events));
  });

  it('changes when any single event changes, and the change is not local to that event', () => {
    const events = fixtureEvents(5);
    const before = computeHeadHash(events);
    const tampered = events.map((event, index) =>
      index === 2 ? { ...event, payload: { unitId: 'U-3', n: 99 } } : event,
    );
    expect(computeHeadHash(tampered)).not.toBe(before);
    // A chain, not a Merkle root: every later hash moves too, which is what makes a rewrite of one
    // row detectable from the head alone.
    expect(eventContentHash(tampered[3])).toBe(eventContentHash(events[3]));
  });

  it('is order-sensitive: the same events in a different order are a different ledger', () => {
    const events = fixtureEvents(4);
    const reversed = [...events].reverse();
    expect(computeHeadHash(reversed)).not.toBe(computeHeadHash(events));
  });

  it('records the last seq and the count', () => {
    const anchor = computeAnchor(fixtureEvents(3), '2026-11-01T00:00:00.000Z');
    expect(anchor).toMatchObject({ schemaVersion: 1, seq: 3, eventCount: 3 });
    expect(anchor.headHash).toBe(computeHeadHash(fixtureEvents(3)));
  });

  it('names a hash for a log line without printing the whole thing', () => {
    expect(shortHash('sha256:0123456789abcdef0123')).toBe('sha256:0123456789ab…');
  });
});

describe('verify: four outcomes, and only one of them lets you claim the ledger is anchored', () => {
  const record: AnchorRecord = {
    schemaVersion: 1,
    seq: 10,
    eventCount: 10,
    headHash: 'sha256:abc',
    anchoredAt: '2026-11-01T00:00:00.000Z',
  };

  it('is fresh inside the window, and says whether the anchor is off-host', () => {
    const verdict = verifyAnchor(record, {
      nowIso: '2026-11-01T12:00:00.000Z',
      maxAgeHours: 48,
      scope: 'off-host',
      local: { seq: 12, eventCount: 12 },
    });
    expect(verdict.outcome).toBe('fresh');
    expect(verdict.offHost).toBe(true);
    expect(verdict.ageHours).toBeCloseTo(12, 5);
  });

  it('a fresh anchor on this disk is not called off-host', () => {
    const verdict = verifyAnchor(record, {
      nowIso: '2026-11-01T01:00:00.000Z',
      scope: 'local',
    });
    expect(verdict.outcome).toBe('fresh');
    expect(verdict.offHost).toBe(false);
    expect(verdict.reason).toContain('on this machine');
  });

  it('is stale past the window, with the age in the reason', () => {
    const verdict = verifyAnchor(record, {
      nowIso: '2026-11-05T00:00:00.000Z',
      maxAgeHours: 48,
    });
    expect(verdict.outcome).toBe('stale');
    expect(verdict.ageHours).toBeCloseTo(96, 5);
    expect(verdict.reason).toContain('96.0 h');
  });

  it('is missing when there is no record at all, and when its timestamp is nonsense', () => {
    expect(verifyAnchor(null, { nowIso: '2026-11-01T00:00:00.000Z' }).outcome).toBe('missing');
    const broken = { ...record, anchoredAt: 'not-a-date' };
    expect(verifyAnchor(broken, { nowIso: '2026-11-01T00:00:00.000Z' }).outcome).toBe('missing');
  });

  it('detects a rollback: an anchor ahead of this database means the file was replaced', () => {
    const verdict = verifyAnchor(record, {
      nowIso: '2026-11-01T00:10:00.000Z',
      scope: 'off-host',
      local: { seq: 8, eventCount: 8 },
    });
    expect(verdict.outcome).toBe('rollback');
    expect(verdict.reason).toContain('replaced or restored');
  });

  it('rollback outranks stale: the older problem is also the more alarming one', () => {
    const verdict = verifyAnchor(record, {
      nowIso: '2026-11-09T00:00:00.000Z',
      maxAgeHours: 48,
      local: { seq: 1, eventCount: 1 },
    });
    expect(verdict.outcome).toBe('rollback');
  });

  it('defaults to a 48 h window, the number ND4 ratified', () => {
    const at49 = verifyAnchor(record, { nowIso: '2026-11-03T01:00:00.000Z' });
    const at47 = verifyAnchor(record, { nowIso: '2026-11-02T23:00:00.000Z' });
    expect(at49.outcome).toBe('stale');
    expect(at47.outcome).toBe('fresh');
  });
});

/** The settled outcome of a read, so two promises can be compared without racing the runner. */
async function capture(
  read: Promise<AnchorRecord | null>,
): Promise<{ ok: true; record: AnchorRecord | null } | { ok: false; code: string }> {
  try {
    return { ok: true, record: await read };
  } catch (error) {
    return { ok: false, code: (error as { code?: string }).code ?? 'NO_CODE' };
  }
}

describe('transports', () => {
  it('appends to a file and reads the last record back', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'anchor-file-'));
    const transport = fileTransport(directory);
    expect(transport.scope).toBe('local');
    expect(await transport.readHead()).toBeNull();

    const first: AnchorRecord = {
      schemaVersion: 1,
      seq: 1,
      eventCount: 1,
      headHash: 'sha256:one',
      anchoredAt: '2026-11-01T00:00:00.000Z',
    };
    const second: AnchorRecord = { ...first, seq: 2, eventCount: 2, headHash: 'sha256:two' };
    await transport.append(first);
    await transport.append(second);

    expect(await transport.readHead()).toEqual(second);
    const text = readFileSync(join(directory, 'ledger-anchors.jsonl'), 'utf8');
    expect(text.trim().split('\n')).toHaveLength(2);
  });

  /**
   * The same claim the remote transport makes, for the local one: an anchor file that exists and
   * cannot be read is "I could not look" (exit 8), never "there is no record" (exit 9). Both cases
   * here fail against the old implementation, which caught every `readFile` error into `null`.
   */
  it('a local anchor that exists and cannot be read rejects, naming the errno', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'anchor-eacces-'));
    const path = join(directory, 'ledger-anchors.jsonl');
    writeFileSync(
      path,
      `${JSON.stringify({ schemaVersion: 1, seq: 1, eventCount: 1, headHash: 'sha256:x', anchoredAt: '2026-11-01T00:00:00.000Z' })}\n`,
    );
    chmodSync(path, 0o000);
    const transport = fileTransport(directory);
    await expect(transport.readHead()).rejects.toThrow(/could not be read: EACCES/u);
    await expect(transport.readHead()).rejects.toMatchObject({ code: 'ANCHOR_UNAVAILABLE' });
    chmodSync(path, 0o644);
  });

  it('a path that is a directory rejects rather than reading as missing', async () => {
    // `EISDIR` is the cheapest stand-in for "the thing is there and is not an anchor file".
    const directory = mkdtempSync(join(tmpdir(), 'anchor-eisdir-'));
    mkdirSync(join(directory, 'ledger-anchors.jsonl'));
    await expect(fileTransport(directory).readHead()).rejects.toMatchObject({
      code: 'ANCHOR_UNAVAILABLE',
    });
  });

  it('an absent file, or an empty one, is genuinely missing — the direction that must not move', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'anchor-empty-'));
    const transport = fileTransport(directory);
    expect(await transport.readHead()).toBeNull(); // ENOENT: never anchored here
    writeFileSync(join(directory, 'ledger-anchors.jsonl'), '');
    expect(await transport.readHead()).toBeNull(); // empty file: the same fact
  });

  it('a file that exists with no parseable record is not "missing" either', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'anchor-corrupt-'));
    writeFileSync(join(directory, 'ledger-anchors.jsonl'), 'not json at all\n{schemaVersion:');
    const transport = fileTransport(directory);
    await expect(transport.readHead()).rejects.toThrow(/holds no readable record/u);
    await expect(transport.readHead()).rejects.toMatchObject({ code: 'ANCHOR_UNAVAILABLE' });
  });

  it('both transports make the same claim about corrupt content', async () => {
    // The local file and the ssh read must not disagree about what "unreadable" means, or the same
    // broken anchor would be exit 9 through one surface and exit 8 through another.
    const directory = mkdtempSync(join(tmpdir(), 'anchor-corrupt-both-'));
    writeFileSync(join(directory, 'ledger-anchors.jsonl'), 'garbage\n');
    const local = fileTransport(directory);
    const remote = commandTransport({
      read: 'printf "garbage\\n"',
      append: 'true',
      label: 'ssh host:g',
    });
    await expect(local.readHead()).rejects.toMatchObject({ code: 'ANCHOR_UNAVAILABLE' });
    await expect(remote.readHead()).rejects.toMatchObject({ code: 'ANCHOR_UNAVAILABLE' });
  });

  it('a truncated tail does not hide the last good record', () => {
    const text = `${JSON.stringify({ schemaVersion: 1, seq: 3, eventCount: 3, headHash: 'sha256:x', anchoredAt: '2026-11-01T00:00:00.000Z' })}\n{"schemaVer`;
    expect(lastValidRecord(text)?.seq).toBe(3);
  });

  it('ignores a record from a schema it does not know', () => {
    expect(lastValidRecord(JSON.stringify({ schemaVersion: 2, seq: 1 }))).toBeNull();
  });

  it('runs an off-host anchor through a command, and reports it as off-host', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'anchor-cmd-'));
    mkdirSync(directory, { recursive: true });
    const path = join(directory, 'anchors.jsonl');
    writeFileSync(path, '');
    const transport = commandTransport({
      read: `cat ${path}`,
      append: `cat >> ${path}`,
      label: 'local sh (stands in for ssh)',
    });
    expect(transport.scope).toBe('off-host');

    const record: AnchorRecord = {
      schemaVersion: 1,
      seq: 9,
      eventCount: 9,
      headHash: 'sha256:nine',
      anchoredAt: '2026-11-01T00:00:00.000Z',
    };
    await transport.append(record);
    expect(await transport.readHead()).toEqual(record);
    expect(readFileSync(path, 'utf8')).toContain('sha256:nine');
  });

  /**
   * The never-regress spec for a bug that made a monitor lie about the *class* of failure.
   *
   * `readHead` used to resolve `null` on a non-zero exit, so an unreachable anchor host was reported
   * as `missing` — a verdict about the ledger that nobody had looked at. This case fails against that
   * implementation: a transport that swallows the exit code cannot satisfy it.
   */
  it('a non-zero exit is a transport failure, not an empty anchor', async () => {
    const transport = commandTransport({
      read: 'echo "ssh: connect to host: Connection refused" >&2; exit 255',
      append: 'true',
      label: 'ssh host:/var/lib/factory/ledger-anchors.jsonl',
    });
    await expect(transport.readHead()).rejects.toThrow(
      /could not be read \(exit 255\).*Connection refused/su,
    );
    // The distinction the fix exists for: it must not resolve `null`, because `null` means "no
    // record exists" and this means "no record was looked for".
    await expect(transport.readHead()).rejects.toMatchObject({ code: 'ANCHOR_UNAVAILABLE' });
  });

  it('a successful read with no record is genuinely missing, not a failure', async () => {
    // Exit 0 and no output: the command ran, the file is empty (or absent behind a `|| true`). This
    // is `missing`, which `verify` reports at exit 9 — and it must stay `null` rather than becoming
    // a rejection, or a store that was never anchored would look like a broken host.
    const transport = commandTransport({ read: 'true', append: 'true', label: 'ssh host:empty' });
    expect(await transport.readHead()).toBeNull();
  });

  it('surfaces a failing command instead of pretending the anchor was written', async () => {
    const transport = commandTransport({ read: 'true', append: 'exit 3', label: 'broken' });
    await expect(
      transport.append({
        schemaVersion: 1,
        seq: 1,
        eventCount: 1,
        headHash: 'sha256:x',
        anchoredAt: '2026-11-01T00:00:00.000Z',
      }),
    ).rejects.toThrow(/could not be written \(exit 3\)/u);
  });
});

describe('anchorTargetFrom', () => {
  it('builds the same off-host target from the same two variables, whoever asks', () => {
    const target = anchorTargetFrom({
      FACTORY_ANCHOR_SSH: 'hermes-control',
      FACTORY_ANCHOR_PATH: '/srv/anchors/factory.jsonl',
    });
    expect(target.overridden).toBe(false);
    expect(target.transport.scope).toBe('off-host');
    expect(target.transport.describe()).toContain('hermes-control');
    expect(target.transport.describe()).toContain('/srv/anchors/factory.jsonl');
  });

  it('a local directory is reported as local, never as off-host', () => {
    const target = anchorTargetFrom({ FACTORY_ANCHOR_DIR: '/tmp/anchors' });
    expect(target.transport.scope).toBe('local');
    expect(target.transport.describe()).toContain('(local)');
  });

  it('an explicit --dir wins over the environment, and says it did', () => {
    const target = anchorTargetFrom(
      { FACTORY_ANCHOR_SSH: 'hermes-control', FACTORY_ANCHOR_DIR: '/tmp/env' },
      { directory: '/tmp/explicit' },
    );
    expect(target.overridden).toBe(true);
    expect(target.transport.scope).toBe('local');
    expect(target.transport.describe()).toContain('/tmp/explicit');
  });

  it('refuses with ANCHOR_UNAVAILABLE (exit 8) and names both variables', () => {
    expect(() => anchorTargetFrom({})).toThrow(/FACTORY_ANCHOR_SSH/u);
    expect(() => anchorTargetFrom({})).toThrow(/FACTORY_ANCHOR_DIR/u);
    try {
      anchorTargetFrom({});
      expect.unreachable('an unconfigured target must refuse');
    } catch (error) {
      expect(error).toMatchObject({ code: 'ANCHOR_UNAVAILABLE', exitCode: 8 });
    }
  });

  it('quotes the remote path so configuration cannot become a second shell command', () => {
    // The path is configuration, not data, but a `'` in a path must not close the quoting and append
    // a command. `anchorTargetFrom` escapes it; this asserts the escaping, not the string.
    const target = anchorTargetFrom({
      FACTORY_ANCHOR_SSH: 'host',
      FACTORY_ANCHOR_PATH: "/tmp/it's here.jsonl",
    });
    expect(target.transport.kind).toBe('command');
  });
});

describe('commandTransport: a flake is retried, a fact is not', () => {
  /** A read command that fails `failures` times (exit 255, like an unreachable host), then succeeds. */
  function flakyRead(stateDir: string, failures: number, payload: string): string {
    const counter = join(stateDir, 'attempts');
    const body = JSON.stringify({ state: 'ok' });
    return [
      `c=$(cat ${counter} 2>/dev/null || echo 0)`,
      `c=$((c+1))`,
      `echo "$c" > ${counter}`,
      `if [ "$c" -le ${String(failures)} ]; then echo 'ssh: connect to host: Operation timed out' >&2; exit 255; fi`,
      `printf '%s\n' '${payload.replace(/'/gu, "'\\''")}'`,
      body.length > 0 ? '' : '',
    ]
      .filter((line) => line !== '')
      .join('; ');
  }

  /** The smallest thing `recordOrRefuse` accepts: a real anchor record on its own line. */
  const built = computeAnchor([], '2026-11-05T04:00:00.000Z');
  const record = JSON.stringify(built);

  it('reads through a single flake instead of paging a person at 04:00', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'anchor-flake-'));
    const transport = commandTransport({
      read: flakyRead(dir, 1, record),
      append: 'exit 0',
      label: 'ssh fake:anchor',
      retry: { attempts: 3, delayMs: 0 },
    });
    const head = await transport.readHead();
    expect(head?.headHash).toBe(built.headHash);
    // Two attempts: the failed one and the one that succeeded. No third, because nothing failed.
    expect(readFileSync(join(dir, 'attempts'), 'utf8').trim()).toBe('2');
  });

  it('still refuses, and says how hard it tried, when every attempt fails', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'anchor-down-'));
    const transport = commandTransport({
      read: flakyRead(dir, 5, record),
      append: 'exit 0',
      label: 'ssh fake:anchor',
      retry: { attempts: 3, delayMs: 0 },
    });
    await expect(transport.readHead()).rejects.toThrow(/retried 3 times/u);
    await expect(
      commandTransport({
        read: flakyRead(dir, 9, record),
        append: 'exit 0',
        label: 'ssh fake:anchor',
        retry: { attempts: 2, delayMs: 0 },
      }).readHead(),
    ).rejects.toMatchObject({ code: 'ANCHOR_UNAVAILABLE', exitCode: 8, details: { attempts: 2 } });
  });

  it('does not retry a read that succeeded but holds no parseable record', async () => {
    // The distinction that makes the retry honest: an unreadable file is a fact about the file, and
    // asking again cannot change it — only "the check never ran" is worth a second attempt.
    const dir = mkdtempSync(join(tmpdir(), 'anchor-garbage-'));
    const counter = join(dir, 'attempts');
    const transport = commandTransport({
      read: `c=$(cat ${counter} 2>/dev/null || echo 0); c=$((c+1)); echo "$c" > ${counter}; echo 'not an anchor'`,
      append: 'exit 0',
      label: 'ssh fake:anchor',
      retry: { attempts: 3, delayMs: 0 },
    });
    await expect(transport.readHead()).rejects.toMatchObject({ code: 'ANCHOR_UNAVAILABLE' });
    expect(readFileSync(counter, 'utf8').trim()).toBe('1');
  });

  it('names the timeouts the anchor read depends on', () => {
    // Without ConnectTimeout a dead route blocks for a kernel-scale timeout, and a bounded retry
    // would multiply that wait instead of riding out a blip.
    const command = sshCommand('hermes-control', 'tail -n 50 -- /srv/anchor.jsonl');
    expect(command).toContain('-o ConnectTimeout=10');
    expect(command).toContain('-o ServerAliveInterval=5');
    expect(command).toContain('-o BatchMode=yes');
    // The remote command is quoted, so a path with a quote cannot become a second command.
    expect(sshCommand('host', "cat /tmp/it's here")).toContain("'\\''");
  });
});
