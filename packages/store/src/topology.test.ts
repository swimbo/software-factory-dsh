/**
 * ND2 — the topology decision, offline.
 *
 * Every branch of `decideTopology()` is reachable here without a second uid, a `useradd`, or
 * the platform it describes: the snapshot is the input, so the Linux path is covered on this
 * macOS host instead of by hope. The two claims are asserted as *exact strings* because the
 * README, the status page and the handover quote them; a wording drift in one place is a
 * claim drift in three.
 */
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  SINGLE_UID_CLAIM,
  TWO_UID_CLAIM,
  WALL_USER,
  WORKER_USER,
  accountCommands,
  applyTopologyPlan,
  decideTopology,
  markerPath,
  modeDigits,
  modeSatisfied,
  modesFor,
  octal,
  parseTopologyMarker,
  probeTopology,
  provisionTopology,
  readTopologyMarker,
  statOwnership,
  topologyClaim,
  verifyTopology,
  writeTopologyMarker,
  type ProvisionInput,
  type TopologyMarker,
  type TopologyTarget,
  type TopologySnapshot,
} from './topology.ts';

const NOW = new Date('2026-11-01T12:00:00.000Z');

const ALL_PRESENT = {
  wallGroup: true,
  wallUser: true,
  workerGroup: true,
  workerUser: true,
} as const;

const NONE_PRESENT = {
  wallGroup: false,
  wallUser: false,
  workerGroup: false,
  workerUser: false,
} as const;

function marker(overrides: Partial<TopologyMarker> = {}): TopologyMarker {
  return {
    version: 'topology.v1',
    kind: 'two-uid',
    wallUser: WALL_USER,
    wallGroup: 'factory-wall',
    workerUser: WORKER_USER,
    wallUid: 901,
    workerUid: 902,
    provisionedAt: '2026-11-01T00:00:00.000Z',
    modes: modesFor('two-uid'),
    ...overrides,
  };
}

function snapshot(overrides: Partial<TopologySnapshot> = {}): TopologySnapshot {
  return {
    platform: 'linux',
    uid: 901,
    accounts: ALL_PRESENT,
    marker: marker(),
    markerError: null,
    ...overrides,
  };
}

let dir = '';
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'topology-'));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe('the two claims, as exact strings', () => {
  it('ratifies the single-uid sentence the operator approved, word for word', () => {
    expect(SINGLE_UID_CLAIM).toBe(
      'single-uid: the wall is a separate process, not a separate principal',
    );
    expect(topologyClaim('single-uid')).toBe(SINGLE_UID_CLAIM);
  });

  it('states the two-uid counterpart without borrowing the wall-independence claim', () => {
    expect(TWO_UID_CLAIM).toBe(
      'two-uid: the wall is a separate principal (factory-wall), not just a separate process',
    );
    expect(topologyClaim('two-uid')).toBe(TWO_UID_CLAIM);
    // Neither sentence claims safety or spend enforcement: those are ND1/ND3, not ND2.
    expect(TWO_UID_CLAIM).not.toMatch(/safe|enforc/);
    expect(SINGLE_UID_CLAIM).not.toMatch(/safe|enforc/);
  });
});

describe('decideTopology on a platform without a second uid', () => {
  it('answers single-uid for darwin, with the platform as the reason', () => {
    const decision = decideTopology(snapshot({ platform: 'darwin', marker: null }));
    expect(decision.kind).toBe('single-uid');
    expect(decision.source).toBe('platform');
    expect(decision.claim).toBe(SINGLE_UID_CLAIM);
    expect(decision.modes).toEqual([]);
    expect(decision.refusal).toBeNull();
    expect(decision.reason).toContain('darwin');
    expect(decision.reason).toContain('same user');
  });

  it('ignores a two-uid marker written by some other host', () => {
    // A copied FACTORY_HOME must not upgrade the claim on a host that cannot honour it.
    const decision = decideTopology(snapshot({ platform: 'darwin', marker: marker() }));
    expect(decision.kind).toBe('single-uid');
    expect(decision.source).toBe('platform');
    expect(decision.marker).toBeNull();
  });

  it('covers win32 the same way rather than throwing on a missing getuid', () => {
    const decision = decideTopology(snapshot({ platform: 'win32', uid: null, marker: null }));
    expect(decision.kind).toBe('single-uid');
    expect(decision.principal).toBe('operator');
  });
});

describe('decideTopology on linux without the accounts', () => {
  it('refuses, names both missing accounts, and exits 8', () => {
    const decision = decideTopology(snapshot({ accounts: NONE_PRESENT, marker: null, uid: 1000 }));
    expect(decision.kind).toBe('single-uid');
    expect(decision.source).toBe('accounts-missing');
    expect(decision.claim).toBe(SINGLE_UID_CLAIM);
    expect(decision.modes).toEqual([]);
    const refusal = decision.refusal;
    expect(refusal).not.toBeNull();
    if (refusal === null) throw new Error('unreachable');
    expect(refusal.code).toBe('TOPOLOGY_ACCOUNTS_MISSING');
    expect(refusal.exitCode).toBe(8);
    expect(refusal.message).toContain(WALL_USER);
    expect(refusal.message).toContain(WORKER_USER);
    expect(refusal.message).toContain('will not create system accounts implicitly');
    expect(refusal.commands).toHaveLength(4);
  });

  it('prints only the commands for the accounts that are actually missing', () => {
    const decision = decideTopology(
      snapshot({
        accounts: { ...NONE_PRESENT, wallGroup: true },
        marker: null,
      }),
    );
    const refusal = decision.refusal;
    if (refusal === null) throw new Error('expected a refusal');
    expect(refusal.commands).toHaveLength(3);
    const joined = refusal.commands.join('\n');
    expect(joined).not.toContain('groupadd --system factory-wall');
    expect(joined).toContain('useradd --system --gid factory-wall');
    // The message names what is missing, and only what is missing.
    expect(refusal.message).toContain('user factory-wall');
    expect(refusal.message).toContain('group factory-worker');
    expect(refusal.message).not.toContain('group factory-wall');
  });

  it('prefers the missing account over a marker that says otherwise', () => {
    // An account that no longer exists is a stronger fact than a file claiming it did.
    const decision = decideTopology(snapshot({ accounts: NONE_PRESENT }));
    expect(decision.source).toBe('accounts-missing');
    expect(decision.refusal?.commands.length).toBeGreaterThan(0);
  });

  it('never invents a command for an account it was not told about', () => {
    expect(accountCommands(null)).toHaveLength(4);
    expect(accountCommands(ALL_PRESENT)).toHaveLength(0);
    expect(accountCommands({ ...ALL_PRESENT, workerUser: false })).toEqual([
      `useradd --system --gid factory-worker --home-dir /var/lib/factory/worker ` +
        `--no-create-home --shell /usr/sbin/nologin ${WORKER_USER}`,
    ]);
  });
});

describe('decideTopology on linux with the accounts but no marker', () => {
  it('stays single-uid and points at the provisioning script', () => {
    const decision = decideTopology(snapshot({ marker: null, uid: 1000 }));
    expect(decision.kind).toBe('single-uid');
    expect(decision.source).toBe('unprovisioned');
    expect(decision.reason).toContain('scripts/provision-topology.sh');
  });

  it('does not treat an unreadable marker as "probably two-uid"', () => {
    const decision = decideTopology(
      snapshot({ marker: null, markerError: 'Unexpected token } in JSON' }),
    );
    expect(decision.kind).toBe('single-uid');
    expect(decision.source).toBe('marker-unreadable');
    expect(decision.reason).toContain('Unexpected token');
  });
});

describe('decideTopology on a provisioned linux host', () => {
  it('answers two-uid, and says which principal is reading', () => {
    const decision = decideTopology(snapshot({ uid: 901 }));
    expect(decision.kind).toBe('two-uid');
    expect(decision.source).toBe('marker');
    expect(decision.claim).toBe(TWO_UID_CLAIM);
    expect(decision.principal).toBe('wall');
    expect(decision.modes).toHaveLength(6);
    expect(decision.reason).toContain('this process is the wall principal');
  });

  it('tells the worker it cannot read the corpus, in the same sentence', () => {
    const decision = decideTopology(snapshot({ uid: 902 }));
    expect(decision.principal).toBe('worker');
    expect(decision.reason).toContain('cannot read the corpus or rewrite a verdict');
  });

  it('says an operator surface is neither principal rather than pretending to be the wall', () => {
    const decision = decideTopology(snapshot({ uid: 501 }));
    expect(decision.kind).toBe('two-uid');
    expect(decision.principal).toBe('operator');
    expect(decision.reason).toContain('neither principal');
  });

  it('says it cannot tell when the uid is unreadable, instead of guessing', () => {
    const decision = decideTopology(snapshot({ uid: null }));
    expect(decision.principal).toBe('unknown');
    expect(decision.reason).toContain('cannot tell');
  });
});

describe('mode arithmetic', () => {
  it('plans five modes for two-uid and none for single-uid', () => {
    expect(modesFor('single-uid')).toEqual([]);
    const targets = modesFor('two-uid').map((mode) => mode.target);
    expect(targets).toEqual([
      'state-dir',
      'store-db',
      'corpus',
      'key-dir',
      'worker-home',
      'evaluator-home',
    ]);
  });

  it('gives the store and corpus to the wall at 0750 and the key to the wall alone', () => {
    const byTarget = new Map(modesFor('two-uid').map((mode) => [mode.target, mode]));
    expect(byTarget.get('state-dir')).toEqual({
      target: 'state-dir',
      mode: 0o750,
      owner: WALL_USER,
      group: 'factory-wall',
    });
    expect(byTarget.get('corpus')?.mode).toBe(0o750);
    expect(byTarget.get('store-db')?.mode).toBe(0o640);
    // 0700, not 0750: a group that can traverse is a group that can be widened later.
    expect(byTarget.get('key-dir')).toEqual({
      target: 'key-dir',
      mode: 0o700,
      owner: WALL_USER,
      group: null,
    });
    expect(byTarget.get('worker-home')?.owner).toBe(WORKER_USER);
    expect(byTarget.get('evaluator-home')?.owner).toBe(WALL_USER);
  });

  it('has zero world bits on every target — that is the isolation, not the group bits', () => {
    for (const mode of modesFor('two-uid')) {
      expect(mode.mode & 0o007, `${mode.target} is world-accessible`).toBe(0);
      expect(modeSatisfied(mode.mode, mode.mode)).toBe(true);
    }
  });

  it('has zero group bits on the key directory', () => {
    const key = modesFor('two-uid').find((mode) => mode.target === 'key-dir');
    expect(key).toBeDefined();
    expect((key?.mode ?? 0) & 0o070).toBe(0);
  });

  it('accepts a tighter mode and rejects a widened one', () => {
    expect(modeSatisfied(0o750, 0o750)).toBe(true);
    expect(modeSatisfied(0o700, 0o750)).toBe(true); // tighter is fine
    expect(modeSatisfied(0o755, 0o750)).toBe(false); // world x
    expect(modeSatisfied(0o777, 0o750)).toBe(false); // world rwx
    expect(modeSatisfied(0o640, 0o640)).toBe(true);
    expect(modeSatisfied(0o604, 0o640)).toBe(false); // world read on the store
    expect(modeSatisfied(0o604, 0o600)).toBe(false);
  });

  it('separates the display octal from the chmod digits, because chmod rejects `0o750`', () => {
    expect(modeDigits(0o750)).toBe('750');
    expect(modeDigits(0o640)).toBe('640');
    expect(modeDigits(0o700)).toBe('700');
    expect(modeDigits(0o070)).toBe('070');
    expect(octal(0o750)).not.toBe(modeDigits(0o750));
  });

  it('prints octals in the form a refusal or a runbook uses', () => {
    expect(octal(0o750)).toBe('0o750');
    expect(octal(0o070)).toBe('0o070');
    expect(octal(0o640)).toBe('0o640');
  });
});

describe('the marker', () => {
  it('round-trips through the file it is written to, at 0640', () => {
    writeTopologyMarker(dir, marker());
    const read = readTopologyMarker(dir);
    expect(read.error).toBeNull();
    expect(read.marker?.wallUid).toBe(901);
    expect(read.marker?.modes).toHaveLength(6);
    const stat = statOwnership(markerPath(dir));
    expect(stat?.mode).toBe(0o640);
  });

  it('reports an absent marker as absent, not as an error', () => {
    expect(readTopologyMarker(dir)).toEqual({ marker: null, error: null });
  });

  it('reports a corrupt marker as an error rather than as nothing', () => {
    writeTopologyMarker(dir, marker());
    const path = markerPath(dir);
    rmSync(path);
    writeFileSync(path, '{ not json');
    const read = readTopologyMarker(dir);
    expect(read.marker).toBeNull();
    expect(read.error).not.toBeNull();
  });

  it('validates every field a claim depends on', () => {
    expect(parseTopologyMarker(marker()).marker?.kind).toBe('two-uid');
    expect(parseTopologyMarker({ ...marker(), version: 'topology.v0' }).error).toContain(
      'topology.v1',
    );
    expect(parseTopologyMarker({ ...marker(), kind: 'single-uid' }).error).toBe(
      'kind is not two-uid',
    );
    expect(parseTopologyMarker({ ...marker(), wallUser: '' }).error).toBe('wallUser is missing');
    expect(parseTopologyMarker({ ...marker(), wallUid: 9.5 }).error).toBe(
      'wallUid is not an integer',
    );
    expect(parseTopologyMarker({ ...marker(), modes: [{ target: 'state-dir' }] }).error).toContain(
      'modes',
    );
    expect(parseTopologyMarker(null).error).toBe('not an object');
  });
});

describe('probeTopology — what the running factory reads', () => {
  it('is single-uid on this host, with the platform as the reason', () => {
    const decision = probeTopology(dir, { platform: 'darwin', uid: 501 });
    expect(decision.kind).toBe('single-uid');
    expect(decision.source).toBe('platform');
    expect(decision.claim).toBe(SINGLE_UID_CLAIM);
  });

  it('is two-uid on a host whose marker says so — read from the store directory', () => {
    writeTopologyMarker(dir, marker());
    const wall = probeTopology(dir, { platform: 'linux', uid: 901 });
    expect(wall.kind).toBe('two-uid');
    expect(wall.principal).toBe('wall');
    const worker = probeTopology(dir, { platform: 'linux', uid: 902 });
    expect(worker.principal).toBe('worker');
  });

  it('degrades to single-uid when the marker is corrupt, never to two-uid', () => {
    writeFileSync(markerPath(dir), '{"version":"topology.v1","kind":"two-uid"}');
    const decision = probeTopology(dir, { platform: 'linux', uid: 901 });
    expect(decision.kind).toBe('single-uid');
    expect(decision.source).toBe('marker-unreadable');
  });
});

function planInput(overrides: Partial<ProvisionInput> = {}): ProvisionInput {
  return {
    home: join(dir, 'home'),
    corpusRoot: join(dir, 'holdout'),
    platform: 'linux',
    uid: 901,
    accounts: ALL_PRESENT,
    marker: null,
    markerError: null,
    wallUid: 901,
    workerUid: 902,
    now: NOW,
    ...overrides,
  };
}

describe('provisionTopology plans, it does not act', () => {
  it('plans nothing on a platform that cannot honour two uids', () => {
    const plan = provisionTopology(planInput({ platform: 'darwin' }));
    expect(plan.decision.kind).toBe('single-uid');
    expect(plan.actions).toEqual([]);
    expect(plan.marker).toBeNull();
  });

  it('plans nothing at all when the accounts are missing — no half-provisioning', () => {
    const plan = provisionTopology(planInput({ accounts: NONE_PRESENT }));
    expect(plan.actions).toEqual([]);
    expect(plan.marker).toBeNull();
    expect(plan.decision.refusal?.commands).toHaveLength(4);
  });

  it('plans the exact install/chown/chmod argv for a provisioned host', () => {
    const plan = provisionTopology(planInput());
    expect(plan.decision.kind).toBe('two-uid');
    const commands = plan.actions.map((action) => action.argv.join(' '));
    expect(commands).toContain(
      `install -d -m 750 -o factory-wall -g factory-wall ${join(dir, 'home', 'state')}`,
    );
    expect(commands).toContain(
      `install -d -m 750 -o factory-wall -g factory-wall ${join(dir, 'holdout')}`,
    );
    expect(commands).toContain(`install -d -m 700 -o factory-wall ${join(dir, 'home', 'keys')}`);
    expect(commands).toContain(
      `install -d -m 700 -o factory-worker ${join(dir, 'home', 'dsh-home', 'worker')}`,
    );
    expect(commands).toContain(
      `install -d -m 700 -o factory-wall ${join(dir, 'home', 'dsh-home', 'evaluator')}`,
    );
    expect(commands).toContain(
      `chown factory-wall:factory-wall ${join(dir, 'home', 'state', 'factory.db')}`,
    );
    // `chmod`/`install -m` take `640`, never `0o640`: the latter is what a plan written from
    // TypeScript looks like, and GNU chmod rejects it (found on a real Linux host).
    expect(commands).toContain(`chmod 640 ${join(dir, 'home', 'state', 'factory.db')}`);
  });

  it('marks the store-file actions as conditional, because SQLite may not have made it yet', () => {
    const plan = provisionTopology(planInput());
    const conditional = plan.actions.filter((action) => action.onlyIfExists);
    expect(conditional.map((action) => action.argv[0])).toEqual(['chown', 'chmod']);
  });

  it('writes a marker carrying the resolved uids and the planned modes', () => {
    const plan = provisionTopology(planInput());
    expect(plan.marker?.wallUid).toBe(901);
    expect(plan.marker?.workerUid).toBe(902);
    expect(plan.marker?.provisionedAt).toBe(NOW.toISOString());
    expect(plan.marker?.modes).toHaveLength(6);
  });

  it('refuses to record a marker when the principal ids cannot be read', () => {
    const plan = provisionTopology(planInput({ wallUid: null }));
    expect(plan.decision.kind).toBe('single-uid');
    expect(plan.marker).toBeNull();
    expect(plan.actions).toEqual([]);
    expect(plan.decision.reason).toContain('unknown principal');
  });
});

describe('applyTopologyPlan executes only what was planned', () => {
  it('skips the conditional store-file actions while the database does not exist', () => {
    const plan = provisionTopology(planInput());
    const seen: string[] = [];
    const result = applyTopologyPlan(
      plan.actions,
      (argv) => {
        seen.push(argv.join(' '));
        return { status: 0, stderr: '' };
      },
      () => false,
    );
    expect(result.failed).toEqual([]);
    expect(result.skipped).toHaveLength(2);
    expect(seen.some((line) => line.startsWith('chown'))).toBe(false);
    expect(result.applied.length).toBe(plan.actions.length - 2);
  });

  it('stops at the first failure and reports the command that failed', () => {
    const plan = provisionTopology(planInput());
    const result = applyTopologyPlan(
      plan.actions,
      (argv) =>
        argv[0] === 'install' && argv.includes(join(dir, 'holdout'))
          ? { status: 1, stderr: 'chown: operation not permitted' }
          : { status: 0, stderr: '' },
      () => true,
    );
    expect(result.failed).toHaveLength(1);
    expect(result.failed[0]).toContain('operation not permitted');
    // Everything before the failing command applied; nothing after it ran.
    expect(result.applied).toHaveLength(3);
    expect(result.applied.at(-1)).toContain(join(dir, 'home', 'state', 'factory.db'));
  });
});

describe('verifyTopology — the check that a mode was really applied', () => {
  const IDS: Record<string, { uid: number; gid: number }> = {
    'factory-wall': { uid: 901, gid: 901 },
    'factory-worker': { uid: 902, gid: 902 },
  };
  const resolve = (name: string): { uid: number; gid: number } | null => IDS[name] ?? null;
  const pathOf = (target: TopologyTarget): string => `/p/${target}`;

  function statFor(
    overrides: Record<string, { uid: number; gid: number; mode: number }> = {},
  ): (path: string) => { uid: number; gid: number; mode: number } | null {
    const base: Record<string, { uid: number; gid: number; mode: number }> = {
      'state-dir': { uid: 901, gid: 901, mode: 0o750 },
      'store-db': { uid: 901, gid: 901, mode: 0o640 },
      corpus: { uid: 901, gid: 901, mode: 0o750 },
      'key-dir': { uid: 901, gid: 901, mode: 0o700 },
      'worker-home': { uid: 902, gid: 902, mode: 0o700 },
      'evaluator-home': { uid: 901, gid: 901, mode: 0o700 },
    };
    return (path: string) => {
      const target = path.replace('/p/', '');
      return overrides[target] ?? base[target] ?? null;
    };
  }

  const modes = modesFor('two-uid');
  const verify = (
    stat: (path: string) => { uid: number; gid: number; mode: number } | null,
  ): ReturnType<typeof verifyTopology> => verifyTopology(modes, resolve, stat, pathOf);

  it('passes a correctly provisioned host', () => {
    const result = verify(statFor());
    expect(result.ok).toBe(true);
    expect(result.mismatches).toEqual([]);
  });

  it('fails a store the operator widened with chmod -R a+rX', () => {
    const result = verify(statFor({ 'state-dir': { uid: 901, gid: 901, mode: 0o755 } }));
    expect(result.ok).toBe(false);
    expect(result.mismatches[0]).toContain('0o755');
    expect(result.mismatches[0]).toContain('0o750');
  });

  it('fails a store owned by the wrong principal', () => {
    const result = verify(statFor({ corpus: { uid: 902, gid: 901, mode: 0o750 } }));
    expect(result.ok).toBe(false);
    expect(result.mismatches[0]).toContain('owned by uid 902');
  });

  it('fails a corpus whose group is not the wall group', () => {
    const result = verify(statFor({ corpus: { uid: 901, gid: 20, mode: 0o750 } }));
    expect(result.ok).toBe(false);
    expect(result.mismatches[0]).toContain('wants group factory-wall');
  });

  it('fails a directory that does not exist rather than skipping it', () => {
    const result = verify(() => null);
    expect(result.ok).toBe(false);
    expect(result.mismatches).toHaveLength(5);
    expect(result.mismatches[0]).toContain('state-dir: /p/state-dir does not exist');
  });

  it('treats the store file as pending, not as a failure, before the first openStore', () => {
    // A fresh host has a verified directory and no database yet; the directory is what isolates.
    const stat = statFor();
    const result = verify((path: string) => (path === '/p/store-db' ? null : stat(path)));
    expect(result.ok).toBe(true);
    expect(result.mismatches).toEqual([]);
    expect(result.pending).toEqual(['store-db: /p/store-db']);
  });

  it('fails closed when a principal cannot be resolved', () => {
    const result = verifyTopology(
      modes,
      () => null,
      () => ({ uid: 901, gid: 901, mode: 0o700 }),
      pathOf,
    );
    expect(result.ok).toBe(false);
    expect(result.mismatches.join('\n')).toContain('cannot resolve factory-wall');
  });
});
