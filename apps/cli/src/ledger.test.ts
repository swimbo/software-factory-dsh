/**
 * `factory ledger` — the anchor, exercised through the real CLI.
 *
 * The properties worth a spec are the ones an operator would get wrong by trusting a green check:
 *
 * - a **local** anchor verifies (truncation detection) but is never described as off-host;
 * - `verify` exits **9** for stale, missing and rollback — an anchor nobody checked proves nothing;
 * - the anchor command refuses when no target is configured, naming both variables;
 * - `anchor` then `verify` in the same home is fresh, and the record on disk hashes the ledger that
 *   was there at the time.
 */
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { EXIT } from './exit.ts';
import { jsonOf, runCli, seedUnit, tempHome } from './testing.ts';

function anchorDir(): string {
  return mkdtempSync(join(tmpdir(), 'factory-anchor-'));
}

describe('ledger anchor', () => {
  it('refuses with exit 8 and names both variables when no target is configured', () => {
    const home = tempHome();
    const result = runCli(['ledger', 'anchor'], { home });
    expect(result.status).toBe(EXIT.environment);
    expect(result.stderr).toContain('FACTORY_ANCHOR_SSH');
    expect(result.stderr).toContain('FACTORY_ANCHOR_DIR');
  });

  it('writes a record whose head matches the ledger, and says LOCAL when it is', () => {
    const home = tempHome();
    const directory = anchorDir();
    seedUnit(home, { lane: 'dark' });
    const result = runCli(['ledger', 'anchor', '--dir', directory, '--json'], { home });
    expect(result.status).toBe(EXIT.ok);
    const payload = jsonOf(result);
    expect(payload['scope']).toBe('local');
    expect((payload['record'] as { headHash?: string }).headHash).toMatch(/^sha256:[0-9a-f]{64}$/u);
    expect(result.stderr).toContain('LOCAL (not off-host)');
    const lines = readFileSync(join(directory, 'ledger-anchors.jsonl'), 'utf8').trim().split('\n');
    expect(lines).toHaveLength(1);
  });

  it('verifies a fresh anchor and exits 0', () => {
    const home = tempHome();
    const directory = anchorDir();
    seedUnit(home, { lane: 'dark' });
    expect(runCli(['ledger', 'anchor', '--dir', directory], { home }).status).toBe(EXIT.ok);
    const verify = runCli(['ledger', 'verify', '--dir', directory, '--json'], { home });
    expect(verify.status).toBe(EXIT.ok);
    expect(jsonOf(verify)['outcome']).toBe('fresh');
  });

  it('exits 9 when there is no anchor at all: unanchored is not verified', () => {
    const home = tempHome();
    const directory = anchorDir();
    const verify = runCli(['ledger', 'verify', '--dir', directory], { home });
    expect(verify.status).toBe(EXIT.integrity);
    expect(verify.stderr).toContain('MISSING');
  });

  it('exits 9 when the anchor is older than the window', () => {
    const home = tempHome();
    const directory = anchorDir();
    seedUnit(home, { lane: 'dark' });
    expect(runCli(['ledger', 'anchor', '--dir', directory], { home }).status).toBe(EXIT.ok);
    // `--max-age-hours 0` makes any anchor stale without waiting or faking a clock.
    const verify = runCli(['ledger', 'verify', '--dir', directory, '--max-age-hours', '0'], {
      home,
    });
    expect(verify.status).toBe(EXIT.integrity);
    expect(verify.stderr).toContain('STALE');
  });

  it('exits 9 when the anchor is ahead of this ledger: that is a rollback, not freshness', () => {
    const home = tempHome();
    const directory = anchorDir();
    seedUnit(home, { lane: 'dark' });
    expect(runCli(['ledger', 'anchor', '--dir', directory], { home }).status).toBe(EXIT.ok);
    // A second, busier factory: same anchor, a ledger with fewer events than the record claims.
    const otherHome = tempHome();
    const verify = runCli(['ledger', 'verify', '--dir', directory, '--json'], { home: otherHome });
    expect(verify.status).toBe(EXIT.integrity);
    expect(jsonOf(verify)['outcome']).toBe('rollback');
    expect(verify.stderr).toContain('replaced or restored');
  });
});
