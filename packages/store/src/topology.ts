/**
 * ND2 — which topology is this factory actually running under?
 *
 * The ratified decision (`findings.md` § DECIDED 2026-11-01, ND2) is that on the Linux target
 * the wall is a separate **principal**: `factory-wall` owns the verdict store, the holdout
 * corpus and the operator key (`0750`, group `factory-wall`), the worker runs as
 * `factory-worker`, and the worker is not a member of the wall's group — which is what makes
 * "the wall is independent" a property of the deployment rather than a claim about a process
 * boundary. On a host with no second uid (this macOS dev machine) the same code runs
 * single-uid, and the wall is a separate **process**, not a separate principal.
 *
 * Why this is a module instead of two `if uname` branches in a provisioning script:
 *
 *  - the answer has to be *reportable*. `factory status` prints the topology it is running
 *    under, so a claim scoped to two uids cannot leak onto a single-uid host. A decision that
 *    only exists inside a script cannot be reported by the running factory.
 *  - the answer has to be *testable offline*. `decideTopology()` is pure over a snapshot
 *    (platform, uid, account presence, the provisioned marker), so the Linux path and the
 *    macOS path are both covered by a spec on any host — including this one, which can never
 *    *be* the Linux path.
 *  - a shell script that mints system users is a script that mints system users on a typo.
 *    `provisionTopology()` only plans; `applyTopologyPlan()` executes exactly the planned
 *    argv. A missing account is a refusal that prints the `groupadd`/`useradd` lines and
 *    exits 8 (environment), never an implicit `useradd`.
 *
 * What this does not buy, in the same words the decision uses: protection from root on the
 * host, and no isolation at all on a single-uid platform. `decision.claim` is the sentence a
 * surface is allowed to print, and it says which of the two topologies it got.
 */
import { existsSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

export const TOPOLOGY_KINDS = ['two-uid', 'single-uid'] as const;
export type TopologyKind = (typeof TOPOLOGY_KINDS)[number];

export const WALL_USER = 'factory-wall';
export const WALL_GROUP = 'factory-wall';
export const WORKER_USER = 'factory-worker';
export const WORKER_GROUP = 'factory-worker';

/** The marker a provisioned host carries, so the running factory reads a fact, not a guess. */
export const TOPOLOGY_MARKER_FILE = 'topology.json';
export const TOPOLOGY_MARKER_VERSION = 'topology.v1';

/**
 * The exact sentences. `findings.md` ratified the second one; the first is its two-uid
 * counterpart, and both are in code so the README, the status page and the specs cannot
 * quote three slightly different claims.
 */
export const TWO_UID_CLAIM =
  'two-uid: the wall is a separate principal (factory-wall), not just a separate process';
export const SINGLE_UID_CLAIM =
  'single-uid: the wall is a separate process, not a separate principal';

export function topologyClaim(kind: TopologyKind): string {
  return kind === 'two-uid' ? TWO_UID_CLAIM : SINGLE_UID_CLAIM;
}

/** Why the decision came out the way it did. Total over the ways it can be reached. */
export type TopologySource =
  'platform' | 'marker' | 'unprovisioned' | 'marker-unreadable' | 'accounts-missing';

/** Which principal the *reading* process runs as. Not the same question as the host's topology. */
export type TopologyPrincipal = 'wall' | 'worker' | 'operator' | 'unknown';

export interface TopologyAccounts {
  readonly wallGroup: boolean;
  readonly wallUser: boolean;
  readonly workerGroup: boolean;
  readonly workerUser: boolean;
}

export type TopologyTarget =
  | 'state-dir'
  | 'store-db'
  | 'corpus'
  | 'key-dir'
  | 'worker-home'
  | 'evaluator-home'
  | 'topology-marker';

export interface TopologyMode {
  readonly target: TopologyTarget;
  readonly mode: number;
  readonly owner: string;
  readonly group: string | null;
}

export interface TopologyMarker {
  readonly version: typeof TOPOLOGY_MARKER_VERSION;
  readonly kind: 'two-uid';
  readonly wallUser: string;
  readonly wallGroup: string;
  readonly workerUser: string;
  readonly wallUid: number;
  readonly workerUid: number;
  readonly provisionedAt: string;
  readonly modes: readonly TopologyMode[];
}

export interface TopologyRefusal {
  readonly code: 'TOPOLOGY_ACCOUNTS_MISSING';
  /** 8 is the environment class in the exit-code contract — nothing was spent, nothing broke. */
  readonly exitCode: 8;
  readonly message: string;
  readonly commands: readonly string[];
}

export interface TopologyDecision {
  readonly kind: TopologyKind;
  readonly source: TopologySource;
  readonly reason: string;
  readonly claim: string;
  readonly principal: TopologyPrincipal;
  /** Empty for `single-uid`: a file mode cannot separate a principal from itself. */
  readonly modes: readonly TopologyMode[];
  readonly refusal: TopologyRefusal | null;
  readonly marker: TopologyMarker | null;
}

export interface TopologySnapshot {
  readonly platform: string;
  readonly uid: number | null;
  /** `null` = not probed (the status path never shells out to NSS). */
  readonly accounts: TopologyAccounts | null;
  readonly marker: TopologyMarker | null;
  readonly markerError: string | null;
}

/**
 * The modes the two-uid layout needs, as numbers so the arithmetic is testable.
 *
 * The isolation is *not* in the group bits: `0750` on the store directory grants the wall
 * group read-and-traverse, and what keeps the worker out is that `factory-worker` is not a
 * member of `factory-wall`, so the "other" bits (`0o007`) are the ones doing the work — they
 * are zero on every target, and a spec asserts that rather than trusting the octal literal.
 * The key directory is `0700` rather than `0750` because a group that can traverse is a group
 * that can be widened later; the key has one reader.
 */
export function modesFor(kind: TopologyKind): readonly TopologyMode[] {
  if (kind === 'single-uid') return [];
  return [
    { target: 'state-dir', mode: 0o750, owner: WALL_USER, group: WALL_GROUP },
    { target: 'store-db', mode: 0o640, owner: WALL_USER, group: WALL_GROUP },
    { target: 'corpus', mode: 0o750, owner: WALL_USER, group: WALL_GROUP },
    { target: 'key-dir', mode: 0o700, owner: WALL_USER, group: null },
    // The two DSH homes `scripts/provision-dsh-home.sh` creates. Separate homes are what keep the
    // wall's credentials out of the worker's reach; under two uids they are also separate owners,
    // so a bug that resolves the wrong home fails with EACCES instead of silently running the
    // worker as the evaluator.
    { target: 'worker-home', mode: 0o700, owner: WORKER_USER, group: null },
    { target: 'evaluator-home', mode: 0o700, owner: WALL_USER, group: null },
  ];
}

/**
 * The marker file's own mode and owner.
 *
 * It is not one of `modesFor('two-uid')` because it is a *record* of the modes rather than one of
 * them — but it needs the same treatment, and for a reason a container found the hard way: written
 * by root, a `0640 root:root` marker is unreadable by `factory-wall`, so the wall's own `status`
 * reported single-uid on a provisioned host. The record of the topology has to be readable by the
 * principal whose topology it records.
 */
export const TOPOLOGY_MARKER_MODE: TopologyMode = {
  target: 'topology-marker',
  mode: 0o640,
  owner: WALL_USER,
  group: WALL_GROUP,
};

/** The two commands that make the marker readable by the wall, run after it is written. */
export function markerActions(path: string): readonly ProvisionAction[] {
  return [
    {
      argv: ['chown', `${WALL_USER}:${WALL_GROUP}`, path],
      note: 'marker owner',
      onlyIfExists: true,
    },
    { argv: ['chmod', '640', path], note: 'marker mode', onlyIfExists: true },
  ];
}

/**
 * Is a mode at most as permissive as the target requires?
 *
 * Two rules, both load-bearing: no world access ever, and nothing beyond what the target was
 * granted (an operator who ran `chmod -R a+rX` to "fix" a permission error has widened the
 * tree, and this says so instead of accepting any octal with the right owner).
 */
export function modeSatisfied(actual: number, required: number): boolean {
  if ((actual & 0o007) !== 0) return false;
  const allowed = required & 0o777;
  return (actual & ~allowed & 0o777) === 0;
}

/** `0o750`, the form a TypeScript reader, a spec diff and a runbook table use. */
export function octal(mode: number): string {
  return `0o${modeDigits(mode)}`;
}

/**
 * `750`, the form `chmod` and `install -m` accept.
 *
 * Not the same string as `octal()`: GNU `chmod 0o750` is an error ("invalid mode"), and this
 * distinction is exactly the kind a spec written from the plan would have missed — the container
 * proof caught `install: invalid mode: '0o750'` on a real Linux host.
 */
export function modeDigits(mode: number): string {
  return (mode & 0o777).toString(8).padStart(3, '0');
}

function missingAccounts(accounts: TopologyAccounts): readonly string[] {
  const missing: string[] = [];
  if (!accounts.wallGroup) missing.push(`group ${WALL_GROUP}`);
  if (!accounts.wallUser) missing.push(`user ${WALL_USER}`);
  if (!accounts.workerGroup) missing.push(`group ${WORKER_GROUP}`);
  if (!accounts.workerUser) missing.push(`user ${WORKER_USER}`);
  return missing;
}

/**
 * The commands that create the missing accounts — exactly the missing ones, in the order the
 * decision argues for (a group exists before the user that has it as its primary group).
 *
 * These are printed, never executed: provisioning a factory must not mint system users on the
 * operator's behalf, and `--system` accounts are the kind an operator wants to see before they
 * exist. `nologin`, because neither principal should ever hold a shell.
 */
export function accountCommands(accounts: TopologyAccounts | null): readonly string[] {
  const present = accounts ?? {
    wallGroup: false,
    wallUser: false,
    workerGroup: false,
    workerUser: false,
  };
  const commands: string[] = [];
  if (!present.wallGroup) commands.push(`groupadd --system ${WALL_GROUP}`);
  if (!present.wallUser) {
    commands.push(
      `useradd --system --gid ${WALL_GROUP} --home-dir /var/lib/factory/wall ` +
        `--no-create-home --shell /usr/sbin/nologin ${WALL_USER}`,
    );
  }
  if (!present.workerGroup) commands.push(`groupadd --system ${WORKER_GROUP}`);
  if (!present.workerUser) {
    commands.push(
      `useradd --system --gid ${WORKER_GROUP} --home-dir /var/lib/factory/worker ` +
        `--no-create-home --shell /usr/sbin/nologin ${WORKER_USER}`,
    );
  }
  return commands;
}

function singleUid(
  source: TopologySource,
  reason: string,
  marker: TopologyMarker | null,
  principal: TopologyPrincipal = 'operator',
): TopologyDecision {
  return {
    kind: 'single-uid',
    source,
    reason,
    claim: SINGLE_UID_CLAIM,
    principal,
    modes: [],
    refusal: null,
    marker,
  };
}

/**
 * Platform → topology. Pure over the snapshot, so every branch is a spec and none of them
 * needs an account, a root shell or the platform it describes.
 *
 * The ordering matters: a refusal on Linux is checked *before* the marker, because an account
 * that no longer exists is a stronger fact than a marker file that says it once did. And a
 * marker that cannot be read is never treated as "probably two-uid" — L3, unknown is not pass.
 */
export function decideTopology(snapshot: TopologySnapshot): TopologyDecision {
  const { platform, uid, accounts, marker, markerError } = snapshot;

  if (platform !== 'linux') {
    return singleUid(
      'platform',
      `${platform} has no second uid for the factory: the worker and the wall run as the same ` +
        `user, so no file mode can separate them`,
      null,
    );
  }

  if (accounts !== null) {
    const missing = missingAccounts(accounts);
    if (missing.length > 0) {
      const refused = singleUid(
        'accounts-missing',
        `the two-uid layout needs ${missing.join(', ')} and the account(s) do not exist; ` +
          `create them with the commands below and re-run, or run single-uid`,
        marker,
      );
      return {
        ...refused,
        refusal: {
          code: 'TOPOLOGY_ACCOUNTS_MISSING',
          exitCode: 8,
          message:
            `TOPOLOGY_ACCOUNTS_MISSING: ${missing.join(', ')} missing — the factory will not ` +
            `create system accounts implicitly`,
          commands: accountCommands(accounts),
        },
      };
    }
  }

  if (markerError !== null) {
    return singleUid(
      'marker-unreadable',
      `the topology marker at ${TOPOLOGY_MARKER_FILE} is unreadable (${markerError}); an ` +
        `unreadable marker is not a two-uid deployment, so the claim stays single-uid`,
      null,
    );
  }

  if (marker === null) {
    return singleUid(
      'unprovisioned',
      accounts === null
        ? `no ${TOPOLOGY_MARKER_FILE} marker records a verified two-uid layout for this store; ` +
            `run scripts/provision-topology.sh --apply on the Linux target to create it`
        : `the two accounts exist but no ${TOPOLOGY_MARKER_FILE} marker records verified ` +
            `store/corpus ownership; run scripts/provision-topology.sh --apply`,
      null,
    );
  }

  const principal =
    uid === null
      ? 'unknown'
      : uid === marker.wallUid
        ? 'wall'
        : uid === marker.workerUid
          ? 'worker'
          : 'operator';

  const reads =
    principal === 'wall'
      ? 'this process is the wall principal'
      : principal === 'worker'
        ? 'this process is the worker principal, which cannot read the corpus or rewrite a verdict'
        : principal === 'unknown'
          ? 'this process cannot tell which principal it is'
          : 'this process is neither principal (a read-only operator surface)';

  return {
    kind: 'two-uid',
    source: 'marker',
    reason:
      `provisioned ${marker.provisionedAt}: ${marker.wallUser} owns the store, corpus and key, ` +
      `${marker.workerUser} runs the worker and is not a member of ${marker.wallGroup}; ${reads}`,
    claim: TWO_UID_CLAIM,
    principal,
    modes: marker.modes,
    refusal: null,
    marker,
  };
}

/** `process.getuid` is absent on Windows; every read here tolerates that rather than guessing. */
export function currentUid(): number | null {
  const getuid = process.getuid;
  return typeof getuid === 'function' ? getuid() : null;
}

export interface MarkerReadResult {
  readonly marker: TopologyMarker | null;
  readonly error: string | null;
}

function isMode(value: unknown): value is TopologyMode {
  if (typeof value !== 'object' || value === null) return false;
  const candidate = value as Record<string, unknown>;
  return (
    typeof candidate['target'] === 'string' &&
    typeof candidate['mode'] === 'number' &&
    typeof candidate['owner'] === 'string' &&
    (typeof candidate['group'] === 'string' || candidate['group'] === null)
  );
}

/**
 * Validate rather than cast: a marker is written by provisioning and read by the running
 * factory, so a hand-edited or half-written file must not become a claim. Anything that does
 * not line up comes back as an error, and the caller reports single-uid.
 */
export function parseTopologyMarker(raw: unknown): MarkerReadResult {
  if (typeof raw !== 'object' || raw === null) return { marker: null, error: 'not an object' };
  const value = raw as Record<string, unknown>;
  if (value['version'] !== TOPOLOGY_MARKER_VERSION) {
    return { marker: null, error: `expected version ${TOPOLOGY_MARKER_VERSION}` };
  }
  if (value['kind'] !== 'two-uid') return { marker: null, error: 'kind is not two-uid' };
  const strings = ['wallUser', 'wallGroup', 'workerUser', 'provisionedAt'] as const;
  for (const key of strings) {
    if (typeof value[key] !== 'string' || (value[key] as string).length === 0) {
      return { marker: null, error: `${key} is missing` };
    }
  }
  const numbers = ['wallUid', 'workerUid'] as const;
  for (const key of numbers) {
    if (typeof value[key] !== 'number' || !Number.isInteger(value[key] as number)) {
      return { marker: null, error: `${key} is not an integer` };
    }
  }
  const modes = value['modes'];
  if (!Array.isArray(modes) || !modes.every(isMode)) {
    return { marker: null, error: 'modes is not a list of topology modes' };
  }
  return {
    marker: {
      version: TOPOLOGY_MARKER_VERSION,
      kind: 'two-uid',
      wallUser: value['wallUser'] as string,
      wallGroup: value['wallGroup'] as string,
      workerUser: value['workerUser'] as string,
      wallUid: value['wallUid'] as number,
      workerUid: value['workerUid'] as number,
      provisionedAt: value['provisionedAt'] as string,
      modes,
    },
    error: null,
  };
}

export function markerPath(stateDir: string): string {
  return join(stateDir, TOPOLOGY_MARKER_FILE);
}

export function readTopologyMarker(stateDir: string): MarkerReadResult {
  const path = markerPath(stateDir);
  if (!existsSync(path)) return { marker: null, error: null };
  let text: string;
  try {
    text = readFileSync(path, 'utf8');
  } catch (error) {
    return { marker: null, error: error instanceof Error ? error.message : String(error) };
  }
  try {
    return parseTopologyMarker(JSON.parse(text) as unknown);
  } catch (error) {
    return { marker: null, error: error instanceof Error ? error.message : String(error) };
  }
}

export function writeTopologyMarker(stateDir: string, marker: TopologyMarker): string {
  const path = markerPath(stateDir);
  writeFileSync(path, `${JSON.stringify(marker, null, 2)}\n`, { mode: 0o640 });
  return path;
}

/**
 * The decision for the store this process is holding — no subprocess, no NSS, no account
 * lookup, because `factory status` runs on paths where forking `getent` would be a surprise.
 * Everything comes from the platform, this process's uid, and the marker beside the store.
 */
export function probeTopology(
  stateDir: string,
  options: { readonly platform?: string; readonly uid?: number | null } = {},
): TopologyDecision {
  const read = readTopologyMarker(stateDir);
  return decideTopology({
    platform: options.platform ?? process.platform,
    uid: options.uid === undefined ? currentUid() : options.uid,
    accounts: null,
    marker: read.marker,
    markerError: read.error,
  });
}

export interface ProvisionAction {
  /** The exact argv, so a spec can assert the command line instead of a substring of it. */
  readonly argv: readonly string[];
  readonly note: string;
  /** `chown`/`chmod` on the store file only apply once SQLite has created it. */
  readonly onlyIfExists: boolean;
}

export interface ProvisionPlan {
  readonly decision: TopologyDecision;
  readonly actions: readonly ProvisionAction[];
  readonly marker: TopologyMarker | null;
}

export interface ProvisionInput {
  readonly home: string;
  readonly corpusRoot: string;
  readonly platform: string;
  readonly uid: number | null;
  readonly accounts: TopologyAccounts | null;
  readonly marker: TopologyMarker | null;
  readonly markerError: string | null;
  /** Resolved from NSS by the caller; `null` when the account does not exist. */
  readonly wallUid: number | null;
  readonly workerUid: number | null;
  readonly now: Date;
}

function pathFor(target: TopologyTarget, input: ProvisionInput): string {
  switch (target) {
    case 'state-dir':
      return join(input.home, 'state');
    case 'store-db':
      return join(input.home, 'state', 'factory.db');
    case 'corpus':
      return input.corpusRoot;
    case 'key-dir':
      return join(input.home, 'keys');
    case 'worker-home':
      return join(input.home, 'dsh-home', 'worker');
    case 'evaluator-home':
      return join(input.home, 'dsh-home', 'evaluator');
    case 'topology-marker':
      return markerPath(join(input.home, 'state'));
  }
}

/**
 * Plan, do not act. On a single-uid platform the plan is empty and says why; on Linux with the
 * accounts present it is the `install -d` / `chown` / `chmod` lines that give the two
 * principals their modes; on Linux without them it is a refusal and *no actions at all*, so a
 * script cannot half-provision a host it is about to abandon.
 */
export function provisionTopology(input: ProvisionInput): ProvisionPlan {
  // The platform check and the account check come first, and each returns *no actions*: a host
  // the factory cannot provision must not be half-provisioned by the part that would have run.
  const eligibility = decideTopology({
    platform: input.platform,
    uid: input.uid,
    accounts: input.accounts,
    marker: input.marker,
    markerError: input.markerError,
  });
  if (eligibility.kind !== 'two-uid' && eligibility.source !== 'unprovisioned') {
    // `unprovisioned` is the one outcome provisioning exists to change, so it falls through.
    return { decision: eligibility, actions: [], marker: null };
  }
  if (input.platform !== 'linux') return { decision: eligibility, actions: [], marker: null };

  // A marker with an unknown principal id would make every later `principal` answer wrong, so
  // the plan refuses rather than writing a marker it cannot stand behind.
  if (input.wallUid === null || input.workerUid === null) {
    return {
      decision: {
        kind: 'single-uid',
        source: 'unprovisioned',
        reason:
          `the accounts exist but their ids could not be read (${WALL_USER}=${String(input.wallUid)}, ` +
          `${WORKER_USER}=${String(input.workerUid)}); refusing to record a two-uid marker with ` +
          `an unknown principal`,
        claim: SINGLE_UID_CLAIM,
        principal: 'operator',
        modes: [],
        refusal: null,
        marker: null,
      },
      actions: [],
      marker: null,
    };
  }

  // Reuse the marker already on disk (idempotent re-run) and otherwise write the one this run
  // is about to make true; a corrupt marker is replaced rather than preserved.
  const marker: TopologyMarker = eligibility.marker ?? {
    version: TOPOLOGY_MARKER_VERSION,
    kind: 'two-uid',
    wallUser: WALL_USER,
    wallGroup: WALL_GROUP,
    workerUser: WORKER_USER,
    wallUid: input.wallUid,
    workerUid: input.workerUid,
    provisionedAt: input.now.toISOString(),
    modes: modesFor('two-uid'),
  };
  const decision = decideTopology({
    platform: input.platform,
    uid: input.uid,
    accounts: input.accounts,
    marker,
    markerError: null,
  });

  const actions: ProvisionAction[] = [];
  for (const mode of modesFor('two-uid')) {
    const path = pathFor(mode.target, input);
    if (mode.target === 'store-db') {
      const owner = mode.group === null ? mode.owner : `${mode.owner}:${mode.group}`;
      actions.push({ argv: ['chown', owner, path], note: 'store file owner', onlyIfExists: true });
      actions.push({
        argv: ['chmod', modeDigits(mode.mode), path],
        note: 'store file mode',
        onlyIfExists: true,
      });
      continue;
    }
    const group = mode.group === null ? [] : ['-g', mode.group];
    actions.push({
      argv: ['install', '-d', '-m', modeDigits(mode.mode), '-o', mode.owner, ...group, path],
      note: `directory ${mode.target}`,
      onlyIfExists: false,
    });
  }

  return { decision, actions, marker };
}

export interface RunResult {
  readonly status: number | null;
  readonly stderr: string;
}

export interface ApplyResult {
  readonly applied: readonly string[];
  readonly skipped: readonly string[];
  readonly failed: readonly string[];
}

/**
 * Execute exactly the planned argv. `onlyIfExists` actions are skipped with a note rather than
 * failing (SQLite has not created the database yet on a fresh host), and the first non-zero
 * exit stops the plan — a half-applied topology is worse than an unapplied one.
 */
export function applyTopologyPlan(
  actions: readonly ProvisionAction[],
  run: (argv: readonly string[]) => RunResult,
  exists: (path: string) => boolean = existsSync,
): ApplyResult {
  const applied: string[] = [];
  const skipped: string[] = [];
  const failed: string[] = [];
  for (const action of actions) {
    const line = action.argv.join(' ');
    const target = action.argv[action.argv.length - 1];
    if (action.onlyIfExists && target !== undefined && !exists(target)) {
      skipped.push(line);
      continue;
    }
    const result = run(action.argv);
    if (result.status !== 0) {
      failed.push(`${line} — ${result.stderr.trim()}`);
      break;
    }
    applied.push(line);
  }
  return { applied, skipped, failed };
}

/** Read the ids the marker needs, without importing a `useradd`-shaped dependency. */
export function statOwnership(path: string): { uid: number; gid: number; mode: number } | null {
  try {
    const info = statSync(path);
    return { uid: info.uid, gid: info.gid, mode: info.mode & 0o777 };
  } catch {
    return null;
  }
}

export interface OwnershipStat {
  readonly uid: number;
  readonly gid: number;
  readonly mode: number;
}

export interface TopologyVerification {
  readonly ok: boolean;
  readonly mismatches: readonly string[];
  /**
   * Targets that do not exist yet and are allowed not to. The store *file* is created by the
   * first `openStore`, so a fresh host has a verified directory and no database; the directory
   * mode (`0750`, others excluded) is what isolates, and the file's `0640` is applied on the
   * next `--apply`. Anything else missing is a mismatch.
   */
  readonly pending: readonly string[];
}

/**
 * Verify the modes and owners that were actually applied, rather than trusting the plan.
 *
 * The uid/gid comparison needs a name→id resolver, which the caller passes instead of this
 * module importing one: `id -u factory-wall` is a subprocess, and a library that silently
 * shells out is a library that hangs in a test.
 */
export const OPTIONAL_TOPOLOGY_TARGETS: readonly TopologyTarget[] = ['store-db'];

export function verifyTopology(
  modes: readonly TopologyMode[],
  resolve: (name: string) => { readonly uid: number; readonly gid: number } | null,
  stat: (path: string) => OwnershipStat | null,
  pathOf: (target: TopologyTarget) => string,
): TopologyVerification {
  const mismatches: string[] = [];
  const pending: string[] = [];
  for (const mode of modes) {
    const path = pathOf(mode.target);
    const actual = stat(path);
    if (actual === null) {
      if (OPTIONAL_TOPOLOGY_TARGETS.includes(mode.target)) pending.push(`${mode.target}: ${path}`);
      else mismatches.push(`${mode.target}: ${path} does not exist`);
      continue;
    }
    if (!modeSatisfied(actual.mode, mode.mode)) {
      mismatches.push(
        `${mode.target}: ${path} is ${octal(actual.mode)}, wants at most ${octal(mode.mode)}`,
      );
    }
    const owner = resolve(mode.owner);
    if (owner === null) {
      // An unresolvable principal is not a pass: fail closed, the way an unknown verdict does.
      mismatches.push(`${mode.target}: cannot resolve ${mode.owner}`);
      continue;
    }
    if (actual.uid !== owner.uid) {
      mismatches.push(`${mode.target}: ${path} is owned by uid ${actual.uid}, wants ${mode.owner}`);
    }
    if (mode.group !== null) {
      const group = resolve(mode.group);
      if (group === null) {
        mismatches.push(`${mode.target}: cannot resolve ${mode.group}`);
      } else if (actual.gid !== group.gid) {
        mismatches.push(`${mode.target}: ${path} has gid ${actual.gid}, wants group ${mode.group}`);
      }
    }
  }
  return { ok: mismatches.length === 0, mismatches, pending };
}
