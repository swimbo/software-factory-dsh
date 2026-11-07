/**
 * The soak harness's own specs.
 *
 * Three things are worth testing about a soak, and none of them is throughput:
 *
 * 1. **The schedule is reproducible from the seed.** A soak whose incident at unit 37 cannot be
 *    reproduced is a story, not a measurement.
 * 2. **The invariant checker can fail.** A checker that has only ever seen green runs is the
 *    same as no checker; these specs hand it fabricated rows and require a scream.
 * 3. **`--units 0` is a usage error**, because "nothing was soaked" must never look like a pass.
 *
 * The end-to-end case is `--units 4 --seed 5`: small enough to live in the suite, and large
 * enough that a real run writes a real `soak.json` with a throwaway home.
 */
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { LedgerEvent } from '../packages/contracts/src/index.ts';
import { INCIDENT_KINDS, checkRows, scheduleFor } from './soak-entry.ts';

function event(type: LedgerEvent['type'], payload: Record<string, unknown>, seq = 0): LedgerEvent {
  return {
    seq,
    eventId: `E-${String(seq)}`,
    type,
    occurredAt: '2026-11-01T12:00:00.000Z',
    actor: 'control',
    traceId: `T-${String(seq)}`,
    payload,
  };
}

describe('the injection schedule is derivable from the seed alone', () => {
  it('is a pure function of (seed, units): same seed, same schedule', () => {
    expect(scheduleFor(1, 50)).toStrictEqual(scheduleFor(1, 50));
    expect(scheduleFor(7, 12)).toStrictEqual(scheduleFor(7, 12));
    // Different seeds move the incidents: if this ever passes for many seed pairs, the seed is
    // decorative and a failure at unit 37 is unreproducible.
    expect(scheduleFor(1, 50)).not.toStrictEqual(scheduleFor(2, 50));
  });

  it('runs every known incident exactly once in a full soak, and leaves clean units too', () => {
    const schedule = scheduleFor(20261101, 50);
    expect(schedule).toHaveLength(50);
    for (const kind of INCIDENT_KINDS) {
      expect(schedule.filter((entry) => entry === kind)).toHaveLength(1);
    }
    expect(schedule.filter((entry) => entry === 'none').length).toBeGreaterThan(0);
  });

  it('keeps the CI shape small but not incident-free', () => {
    const schedule = scheduleFor(1, 5);
    expect(schedule).toHaveLength(5);
    expect(schedule.filter((entry) => entry !== 'none')).toHaveLength(1);
    expect(schedule.filter((entry) => entry === 'none')).toHaveLength(4);
  });
});

describe('the invariant checkers can fail (a checker that cannot fail is decoration)', () => {
  const cleanRows = {
    units: [{ unitId: 'U-1', state: 'verified' }],
    // `produced-receipt` is the state a successful attempt reaches; the machine has no
    // `succeeded` (a receipt is a fact, "success" is a verdict) -- which is why the fabricated
    // row below is a real test of the checker rather than a typo it happens to catch.
    attempts: [{ attemptId: 'A-1', unitId: 'U-1', state: 'produced-receipt' }],
    events: [
      event('unit.verified', {
        unitId: 'U-1',
        attemptId: 'A-1',
        verdictId: 'V-1',
        outcome: 'pass',
      }),
      event('unit.promoted', {
        unitId: 'U-1',
        verdictId: 'V-1',
        promotionSha: 'sha256:x',
        signedBy: 'human:bo',
      }),
    ],
    incidentUnits: [{ kind: 'ambiguous' as const, unitIndex: 0 }],
  };

  it('passes a clean set of rows', () => {
    expect(checkRows(cleanRows).every((report) => report.ok)).toBe(true);
  });

  it('screams at a state the state machine does not define', () => {
    const reports = checkRows({
      ...cleanRows,
      units: [{ unitId: 'U-1', state: 'soaking' }],
    });
    const state = reports.find((report) => report.name.startsWith('no unit or attempt'));
    expect(state?.ok).toBe(false);
    expect(state?.detail).toContain('soaking');
  });

  it('screams at a promotion with no human signature', () => {
    const reports = checkRows({
      ...cleanRows,
      events: [
        event('unit.verified', {
          unitId: 'U-1',
          attemptId: 'A-1',
          verdictId: 'V-1',
          outcome: 'pass',
        }),
        event('unit.promoted', {
          unitId: 'U-1',
          verdictId: 'V-1',
          promotionSha: 'sha256:x',
          signedBy: '',
        }),
      ],
    });
    const signed = reports.find((report) => report.name.startsWith('nothing promoted'));
    expect(signed?.ok).toBe(false);
    expect(signed?.detail).toContain('1 unsigned');
  });

  it('screams at an unknown verdict that was promoted anyway', () => {
    const reports = checkRows({
      ...cleanRows,
      events: [
        event('unit.verified', {
          unitId: 'U-1',
          attemptId: 'A-1',
          verdictId: 'V-1',
          outcome: 'unknown',
        }),
        event('unit.promoted', {
          unitId: 'U-1',
          verdictId: 'V-1',
          promotionSha: 'sha256:x',
          signedBy: 'human:bo',
        }),
      ],
    });
    const unknown = reports.find((report) => report.name.startsWith('unknown is never'));
    expect(unknown?.ok).toBe(false);
    expect(unknown?.detail).toContain('1 promoted');
  });

  it('screams at a redispatch after recovery', () => {
    const reports = checkRows({
      ...cleanRows,
      attempts: [
        { attemptId: 'A-1', unitId: 'U-soak-amb-0', state: 'ambiguous' },
        { attemptId: 'A-2', unitId: 'U-soak-amb-0', state: 'running' },
      ],
    });
    const redispatch = reports.find((report) => report.name.startsWith('no redispatch'));
    expect(redispatch?.ok).toBe(false);
    expect(redispatch?.detail).toContain('U-soak-amb-0');
  });
});

describe('the entry point refuses to soak nothing', () => {
  it('is a usage error (exit 2), never a silent pass', () => {
    let code = 0;
    let stderr = '';
    try {
      execFileSync('bash', ['scripts/soak.sh', '--units', '0'], { encoding: 'utf8' });
    } catch (error) {
      const failure = error as { status?: number; stderr?: string };
      code = failure.status ?? 1;
      stderr = failure.stderr ?? '';
    }
    expect(code).toBe(2);
    expect(stderr).toContain('--units must be a positive integer');
  });
});

describe('a real run (small, seeded, offline)', () => {
  it('soaks 4 units, writes soak.json, and never targets the operator home', () => {
    const out = execFileSync('bash', ['scripts/soak.sh', '--units', '4', '--seed', '5'], {
      encoding: 'utf8',
    });
    expect(out).toContain('RESULT ok');
    const summary = JSON.parse(
      readFileSync(join(process.cwd(), 'e2e', 'soak', 'artifacts', 'soak-5-4.json'), 'utf8'),
    ) as {
      paidModelCalls: number;
      soakHome: string;
      unitsAttempted: number;
      incidents: readonly {
        ok: boolean;
        steps: readonly { expectedExit: number; observedExit: number }[];
      }[];
      failures: readonly string[];
    };
    expect(summary.paidModelCalls).toBe(0);
    expect(summary.unitsAttempted).toBe(4);
    expect(summary.failures).toStrictEqual([]);
    // The home is a throwaway temp dir; the operator's `~/.factory` is never the target.
    expect(summary.soakHome.startsWith(tmpdir())).toBe(true);
    expect(summary.soakHome).not.toContain(join(homedir(), '.factory'));
  }, 120_000);
});
