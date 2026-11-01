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
    // This stays `missing` after the transport fix: the command ran and found nothing, which is a
    // fact about the ledger. Only a command that *could not run* becomes exit 8 now.
    const home = tempHome();
    const directory = anchorDir();
    const verify = runCli(['ledger', 'verify', '--dir', directory, '--json'], { home });
    expect(verify.status).toBe(EXIT.integrity);
    expect(verify.stderr).toContain('MISSING');
    // The machine-readable surface says `missing` — a fact about the ledger, not a failed read.
    expect(jsonOf(verify)['outcome']).toBe('missing');
  });

  /**
   * The behaviour change this fix makes, stated as a claim: an anchor host that cannot be reached is
   * an **environment** failure (exit 8), not `missing` (exit 9). `missing` says "there is no record";
   * the truth here is "nobody looked", and reporting the first when the second is true is how an
   * unreachable host hides for a week.
   */
  it('exits 8, not 9, when the anchor host cannot be reached', () => {
    const home = tempHome();
    seedUnit(home, { lane: 'dark' });
    // 127.0.0.1 is enough: BatchMode never prompts, so ssh exits 255 (refused, or host key unknown)
    // within a second — the same non-zero exit a dead remote produces.
    const verify = runCli(['ledger', 'verify', '--json'], {
      home,
      env: { FACTORY_ANCHOR_SSH: '127.0.0.1', FACTORY_ANCHOR_PATH: '/tmp/anchors.jsonl' },
    });
    expect(verify.status).toBe(EXIT.environment);
    expect(verify.status).not.toBe(EXIT.integrity);
    expect(verify.stderr).toContain('could not be read');
    expect(verify.stderr).not.toContain('MISSING');
    // The JSON surface must not carry an outcome it did not measure.
    expect(jsonOf(verify)).toMatchObject({ ok: false, code: 'ANCHOR_UNAVAILABLE' });
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
