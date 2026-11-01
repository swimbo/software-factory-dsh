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
import { mkdtempSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { canonicalJson, sha256Hex } from '@factory/contracts';
import { describe, expect, it } from 'vitest';

import {
  computeAnchor,
  computeHeadHash,
  commandTransport,
  eventContentHash,
  fileTransport,
  lastValidRecord,
  shortHash,
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
    ).rejects.toThrow(/anchor write failed/u);
  });
});
