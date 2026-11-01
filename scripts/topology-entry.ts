/**
 * `scripts/topology-entry.ts` — the logic behind `scripts/provision-topology.sh`.
 *
 * The shell wrapper exists so the runbooks and the handover can name one command; this file
 * exists because everything that matters here is a decision, and a decision written as `if
 * uname` in shell cannot be tested on the host that has the *other* platform. The decision
 * itself lives in `packages/store/src/topology.ts` — the same module `factory status` reads —
 * so the topology a script provisions and the topology the running factory reports cannot
 * disagree.
 *
 * What this script will not do: create a system account. If `factory-wall` / `factory-worker`
 * are missing it prints the exact `groupadd`/`useradd` lines, provisions nothing, and exits 8
 * (environment). Provisioning a factory must not mint system users on a typo.
 *
 * Usage:
 *   scripts/provision-topology.sh [--root DIR] [--corpus DIR] [--apply] [--json]
 *
 * Exit codes: 0 the topology is what this host can honour; 8 the environment cannot support
 * the two-uid layout as asked (missing accounts, or an apply that failed or did not verify);
 * 2 a usage error.
 */
import { spawnSync } from 'node:child_process';
import { rmSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

import {
  TOPOLOGY_MARKER_MODE,
  WALL_GROUP,
  WALL_USER,
  WORKER_GROUP,
  WORKER_USER,
  applyTopologyPlan,
  markerActions,
  modesFor,
  provisionTopology,
  readTopologyMarker,
  statOwnership,
  verifyTopology,
  writeTopologyMarker,
  type ProvisionInput,
  type RunResult,
  type TopologyAccounts,
  type TopologyMode,
  type TopologyTarget,
} from '../packages/store/src/topology.ts';

const EXIT_ENVIRONMENT = 8;
const EXIT_USAGE = 2;

interface Options {
  readonly root: string;
  readonly corpus: string;
  readonly apply: boolean;
  readonly json: boolean;
  /**
   * Reporting overrides, for a runbook that wants the Linux answer from a macOS host and for the
   * specs that cover the branch this machine cannot reach. They may not change what is *claimed*:
   * a marker written here is ignored by `decideTopology()` on a non-Linux platform, and `--apply`
   * refuses to run at all when either override is in play.
   */
  readonly platform: string;
  readonly accountsOverride: 'probe' | 'none' | 'present';
}

function usage(message: string): never {
  process.stderr.write(`provision-topology: ${message}\n`);
  process.stderr.write(
    'usage: scripts/provision-topology.sh [--root DIR] [--corpus DIR] [--apply] [--json]\n',
  );
  process.exit(EXIT_USAGE);
}

function parseArgs(argv: readonly string[]): Options {
  let root = (process.env['FACTORY_HOME'] ?? '').trim() || join(homedir(), '.factory');
  let corpus =
    (process.env['FACTORY_HOLDOUT_ROOT'] ?? '').trim() || join(homedir(), '.factory', 'holdout');
  let apply = false;
  let json = false;
  let platform = process.platform;
  let accountsOverride: Options['accountsOverride'] = 'probe';
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    switch (arg) {
      case '--root':
        root = argv[++index] ?? usage('--root needs a directory');
        break;
      case '--corpus':
        corpus = argv[++index] ?? usage('--corpus needs a directory');
        break;
      case '--apply':
        apply = true;
        break;
      case '--json':
        json = true;
        break;
      case '--platform':
        platform = argv[++index] ?? usage('--platform needs a platform name');
        break;
      case '--accounts': {
        const value = argv[++index] ?? usage('--accounts needs probe, none or present');
        if (value !== 'probe' && value !== 'none' && value !== 'present') {
          usage(`--accounts must be probe, none or present (got ${value})`);
        }
        accountsOverride = value;
        break;
      }
      case '-h':
      case '--help':
        process.stdout.write(
          'provision-topology: provision or report the wall topology (two-uid / single-uid)\n',
        );
        process.exit(0);
        break;
      default:
        usage(`unknown argument: ${String(arg)}`);
    }
  }
  return { root, corpus, apply, json, platform, accountsOverride };
}

function run(argv: readonly string[]): RunResult {
  const result = spawnSync(argv[0] ?? '', argv.slice(1), { encoding: 'utf8' });
  return { status: result.status, stderr: result.stderr ?? '' };
}

function lookup(argv: readonly string[]): string | null {
  const result = spawnSync(argv[0] ?? '', argv.slice(1), { encoding: 'utf8' });
  if (result.status !== 0) return null;
  const text = (result.stdout ?? '').trim();
  return text === '' ? null : text;
}

/**
 * The NSS probe, kept out of `topology.ts` on purpose: the library must not fork. `getent` and
 * `id` are the two commands every runbook already assumes on the Linux target.
 */
function probeAccounts(platform: string): {
  readonly accounts: TopologyAccounts;
  readonly wallUid: number | null;
  readonly workerUid: number | null;
} | null {
  if (platform !== 'linux') return null;
  const group = (name: string): boolean => lookup(['getent', 'group', name]) !== null;
  const uid = (name: string): number | null => {
    const text = lookup(['id', '-u', name]);
    if (text === null) return null;
    const parsed = Number.parseInt(text, 10);
    return Number.isNaN(parsed) ? null : parsed;
  };
  return {
    accounts: {
      wallGroup: group(WALL_GROUP),
      wallUser: uid(WALL_USER) !== null,
      workerGroup: group(WORKER_GROUP),
      workerUser: uid(WORKER_USER) !== null,
    },
    wallUid: uid(WALL_USER),
    workerUid: uid(WORKER_USER),
  };
}

function resolveIds(): (name: string) => { readonly uid: number; readonly gid: number } | null {
  return (name: string) => {
    const uidText = lookup(['id', '-u', name]);
    const gidText = lookup(['id', '-g', name]);
    if (uidText === null || gidText === null) return null;
    const uid = Number.parseInt(uidText, 10);
    const gid = Number.parseInt(gidText, 10);
    if (Number.isNaN(uid) || Number.isNaN(gid)) return null;
    return { uid, gid };
  };
}

function pathOf(options: Options): (target: TopologyTarget) => string {
  return (target: TopologyTarget) => {
    switch (target) {
      case 'state-dir':
        return join(options.root, 'state');
      case 'store-db':
        return join(options.root, 'state', 'factory.db');
      case 'corpus':
        return options.corpus;
      case 'key-dir':
        return join(options.root, 'keys');
      case 'worker-home':
        return join(options.root, 'dsh-home', 'worker');
      case 'evaluator-home':
        return join(options.root, 'dsh-home', 'evaluator');
      case 'topology-marker':
        return join(options.root, 'state', 'topology.json');
    }
  };
}

function modeLines(modes: readonly TopologyMode[]): string[] {
  return modes.map(
    (mode) =>
      `  ${mode.target.padEnd(12)} 0o${mode.mode.toString(8).padStart(3, '0')} ` +
      `${mode.owner}${mode.group === null ? '' : `:${mode.group}`}`,
  );
}

function main(): number {
  const options = parseArgs(process.argv.slice(2));
  const overridden = options.platform !== process.platform || options.accountsOverride !== 'probe';
  if (options.apply && overridden) {
    usage('refusing to --apply a report that was asked to describe another platform or host');
  }
  const probe =
    options.accountsOverride === 'probe'
      ? probeAccounts(options.platform)
      : {
          accounts: {
            wallGroup: options.accountsOverride === 'present',
            wallUser: options.accountsOverride === 'present',
            workerGroup: options.accountsOverride === 'present',
            workerUser: options.accountsOverride === 'present',
          },
          wallUid: null,
          workerUid: null,
        };
  const markerRead = readTopologyMarker(join(options.root, 'state'));
  const input: ProvisionInput = {
    home: options.root,
    corpusRoot: options.corpus,
    platform: options.platform,
    uid: typeof process.getuid === 'function' ? process.getuid() : null,
    accounts: probe?.accounts ?? null,
    marker: markerRead.marker,
    markerError: markerRead.error,
    wallUid: probe?.wallUid ?? null,
    workerUid: probe?.workerUid ?? null,
    now: new Date(),
  };
  const plan = provisionTopology(input);
  const { decision } = plan;

  const applied = options.apply
    ? applyTopologyPlan(plan.actions, run)
    : { applied: [], skipped: [], failed: [] };
  const applyFailed = applied.failed.length > 0;

  // Order matters: apply the directories, then write the marker, then make the marker readable by
  // the wall, and only then verify. Verification runs last because it checks the marker too —
  // a record of the topology that the recorded principal cannot read is not a provisioned host.
  let markerPath: string | null = null;
  let markerFailure: string | null = null;
  if (options.apply && decision.kind === 'two-uid' && plan.marker !== null && !applyFailed) {
    const written = writeTopologyMarker(join(options.root, 'state'), plan.marker);
    const markerApply = applyTopologyPlan(markerActions(written), run);
    if (markerApply.failed.length > 0) {
      // A root-owned marker is unreadable by factory-wall, so `status` would report single-uid on a
      // host that is provisioned. Remove it rather than leave evidence that cannot be read.
      markerFailure = markerApply.failed.join('; ');
      rmSync(written, { force: true });
    } else {
      markerPath = written;
    }
  }

  const verification =
    options.apply && decision.kind === 'two-uid'
      ? verifyTopology(
          [...modesFor('two-uid'), TOPOLOGY_MARKER_MODE],
          resolveIds(),
          statOwnership,
          pathOf(options),
        )
      : null;
  const refusalFailed = plan.decision.refusal !== null;
  const verifyFailed = verification !== null && !verification.ok;
  const markerFailed = markerFailure !== null;
  const ok = !refusalFailed && !applyFailed && !verifyFailed && !markerFailed;

  if (options.json) {
    process.stdout.write(
      `${JSON.stringify(
        {
          ok,
          topology: {
            kind: decision.kind,
            source: decision.source,
            claim: decision.claim,
            reason: decision.reason,
            principal: decision.principal,
            modes: decision.modes.map((mode) => ({ ...mode, mode: `0o${mode.mode.toString(8)}` })),
          },
          refusal: decision.refusal,
          plan: plan.actions.map((action) => action.argv.join(' ')),
          applied: applied.applied,
          skipped: applied.skipped,
          failed: applied.failed,
          verification,
          markerPath,
        },
        null,
        2,
      )}\n`,
    );
  } else {
    const lines: string[] = [];
    lines.push(`topology  ${decision.kind}  (source: ${decision.source})`);
    lines.push(`claim     ${decision.claim}`);
    lines.push(`reason    ${decision.reason}`);
    if (decision.kind === 'two-uid') {
      lines.push(`principal ${decision.principal}`);
      lines.push('modes:');
      lines.push(...modeLines(decision.modes));
    } else {
      lines.push(
        'modes:    none — no two-uid layout is in force here, so there is no mode to enforce',
      );
    }
    if (decision.refusal !== null) {
      lines.push('');
      lines.push(`refused:  ${decision.refusal.message}`);
      lines.push('run these as root (this script does not run them for you):');
      for (const command of decision.refusal.commands) lines.push(`  ${command}`);
      lines.push('then re-run this script.');
    } else if (plan.actions.length > 0) {
      lines.push('');
      lines.push(options.apply ? 'applied:' : 'plan (pass --apply to execute):');
      for (const action of plan.actions) lines.push(`  ${action.argv.join(' ')}`);
      if (options.apply) {
        for (const line of applied.applied) lines.push(`  ok    ${line}`);
        for (const line of applied.skipped) lines.push(`  skip  ${line} (not created yet)`);
        for (const line of applied.failed) lines.push(`  FAIL  ${line}`);
      }
      if (verification !== null) {
        lines.push('');
        if (verification.ok)
          lines.push('verified: every mode and owner is what the plan asked for');
        else for (const mismatch of verification.mismatches) lines.push(`  MISMATCH ${mismatch}`);
      }
      if (markerPath !== null)
        lines.push(`marker:   ${markerPath} (owned ${WALL_USER}:${WALL_GROUP})`);
      if (markerFailure !== null) {
        lines.push(
          `marker:   could not be made readable by ${WALL_USER} (${markerFailure}) — removed`,
        );
      }
    }
    process.stdout.write(`${lines.join('\n')}\n`);
  }

  if (refusalFailed || applyFailed || verifyFailed || markerFailed) return EXIT_ENVIRONMENT;
  return 0;
}

process.exit(main());
