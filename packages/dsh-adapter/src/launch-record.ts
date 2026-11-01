/**
 * The launch record: what the worker was actually given.
 *
 * An auditor must be able to answer "what did that process see?" from the attempt directory
 * alone, without the ledger, the operator's shell, or a live host. This module exists because
 * of E2E-33: the boundary between the worker and everything the factory holds — the holdout
 * corpus, the operator's signing key, the model credential — must be *checkable*, and a
 * boundary nobody wrote down is a boundary nobody can check.
 *
 * Two rules, and they are the whole design:
 *
 * 1. **Keys and hashes, never values.** A launch record is evidence, and evidence gets copied,
 *    attached to tickets and pasted into reports. Values stay out of it; a per-value sha256 is
 *    enough to prove two launches had the same `PATH` without disclosing it.
 * 2. **Credential-shaped names do not appear at all.** Not the value, not the key, not a
 *    placeholder. A record that says `BIFROST_API_KEY: <redacted>` still tells an attacker
 *    which variable to look for, and tells a reviewer that the worker *was* given it.
 *
 * The same file is written by both executors. The scripted executor has no DSH home and no
 * overlay, and it records that absence (`null`) rather than omitting the fields: an absent
 * field is ambiguous, an explicit `null` is a fact.
 */
import { createHash } from 'node:crypto';
import { readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

/** The record file, next to `receipt.json` in the attempt record directory. */
export const LAUNCH_FILE = 'launch.json';

/**
 * Env-var names that look like they carry a credential.
 *
 * Applied to `FACTORY_*` passthrough as well: a `FACTORY_PROXY_TOKEN` is still a
 * token, and the allowlist must not become a loophole just because the name
 * starts with the factory's prefix.
 */
export const CREDENTIAL_NAME = /(?:API_?KEY|TOKEN|SECRET|PASSWORD|PASSWD|CREDENTIAL|PRIVATE_KEY)/i;

/**
 * Names that point at something the worker must never be handed: a host path, a control
 * handle, or a fixture location. `FACTORY_HOLDOUT_ROOT` is the one that matters most — a
 * worker that learns the holdout path can read the corpus the wall is about to judge it with,
 * which is the whole attack E2E-33 exists for.
 *
 * This is a *category* rule, not a list of known-bad names, because the failure mode is the
 * variable somebody adds next week: anything shaped like a path or a control handle is
 * dropped, including `FACTORY_TEST_ROOT`, `FACTORY_PRISTINE_REPO` and `FACTORY_HOME`.
 */
/**
 * The one documented opt-in for a credential in the worker environment.
 *
 * v1 has no credential proxy: the gateway key must reach `dsh` itself, so a live run needs
 * exactly one credential name forwarded to the child — `BIFROST_API_KEY` — and nothing else.
 * The flag is the operator saying "this run may spend money"; without it the allowlist is
 * unchanged and a live run cannot authenticate, which is the offline-safe default.
 */
export const LIVE_MODEL_FLAG = 'FACTORY_LIVE_MODEL';
export const LIVE_MODEL_CREDENTIAL = 'BIFROST_API_KEY';

/** Whether the operator opted this process into a live, billable model call. */
export function liveModelEnabled(parentEnv: NodeJS.ProcessEnv): boolean {
  return (parentEnv[LIVE_MODEL_FLAG] ?? '').trim() === '1';
}

/**
 * The credential names forwarded to the child: the named key under the flag, nothing else.
 *
 * Returns names so the launch record can say *that* a credential was forwarded without the
 * value ever reaching the record, a log, or a diff.
 */
export function forwardedCredentials(parentEnv: NodeJS.ProcessEnv): readonly string[] {
  if (!liveModelEnabled(parentEnv)) return [];
  const value = parentEnv[LIVE_MODEL_CREDENTIAL];
  return value === undefined || value === '' ? [] : [LIVE_MODEL_CREDENTIAL];
}

export const PATH_LIKE_NAME =
  /(?:HOLDOUT|PRISTINE|MIRROR|OPERATOR|SIGNING|_HOME|_ROOT|_DIR|_PATH|_FILE|_PID|SCENARIO)/i;

/** Whether a variable name is refused to the worker. */
export function forbiddenForWorker(name: string): boolean {
  return CREDENTIAL_NAME.test(name) || PATH_LIKE_NAME.test(name);
}

/**
 * The child environment: an allowlist, never a copy.
 *
 * Copying `process.env` and deleting the key is the pattern that fails the day
 * someone adds `OPENAI_API_KEY` or `ANTHROPIC_API_KEY` to the operator's shell.
 * An allowlist fails closed instead. There is deliberately no `HOME`, and no path
 * under `~/.factory` other than the per-attempt home: the worker's world is the
 * mount plus its own home, and the holdout is not on either.
 */
export function buildChildEnv(
  dshHome: string,
  parentEnv: NodeJS.ProcessEnv,
  onDropped?: (name: string) => void,
): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {
    DSH_HOME: dshHome,
    // Product telemetry posts to an external collector; a factory run must not
    // reach anything but the proxy.
    DSH_TELEMETRY_DISABLED: '1',
    PATH: parentEnv['PATH'] ?? '/usr/local/bin:/usr/bin:/bin',
  };
  const liveCredential = forwardedCredentials(parentEnv);
  for (const [name, value] of Object.entries(parentEnv)) {
    if (value === undefined) continue;
    if (liveCredential.includes(name)) {
      // The single documented exception, and it is never silent: the record says which name
      // was forwarded (`credentialsForwarded`), never the value.
      env[name] = value;
      continue;
    }
    if (!name.startsWith('FACTORY_')) continue;
    if (forbiddenForWorker(name)) {
      onDropped?.(name);
      continue;
    }
    env[name] = value;
  }
  return env;
}

/** `sha256:` prefix plus the hex digest — the only form in which a value is recorded. */
export function hashEnvValue(value: string): string {
  return `sha256:${createHash('sha256').update(value, 'utf8').digest('hex')}`;
}

/**
 * Where a recorded command came from — and therefore what kind of claim it is.
 *
 * "The worker launched" and "the factory measured the tree" are not the same claim, and a
 * receipt that lists them together invites a reader to replay both. Provenance travels with the
 * command so the wall can replay the subset that is replayable and say, in the verdict, which
 * commands it did not re-execute. Set at the recording site; never defaulted to `true`.
 */
export type CommandSource = 'worker-launch' | 'worker-command' | 'factory-verification';

export interface CommandProvenance {
  readonly source: CommandSource;
  readonly replayable: boolean;
  /** Required when `replayable` is false: a refusal without a reason is a shrug. */
  readonly replaySkipReason?: string;
}

/** The launch itself: not a claim about the world, and replaying it would re-spend money. */
export const WORKER_LAUNCH_PROVENANCE: CommandProvenance = {
  source: 'worker-launch',
  replayable: false,
  replaySkipReason:
    'the worker launch is the thing under test: replaying it starts another worker (a paid ' +
    'model call in a live run) and cannot reproduce its output by construction',
};

/**
 * The factory's own post-attempt git reads — replayable, **as a sequence**.
 *
 * `git diff --cached` is read-only in intent but not in fact: its output depends on the
 * `GIT_INDEX_FILE` the attempt staged into. The precondition is therefore part of the claim:
 * these commands are replayable only in recorded order, starting from the receipt's base, after
 * the wall has reconstructed the attempt index (`packages/wall/src/replay.ts` does exactly that
 * — `read-tree`, then `add`, then the two `diff` reads). Replayed out of order or against a
 * different index they measure a different tree, which is why the recorder states the
 * precondition rather than leaving a reader to assume the commands are independent.
 *
 * Without this, no real attempt could ever be promotable: the launch can never be replayed, so
 * a receipt whose only other commands are refused would replay 0 of N and leave every real
 * worker at `unknown` forever.
 */
export const FACTORY_VERIFICATION_PROVENANCE: CommandProvenance = {
  source: 'factory-verification',
  replayable: true,
};

/**
 * A factory read whose output depends on the *worktree*, not just on (base, staged tree).
 *
 * `git status --porcelain` lists untracked and ignored paths, and an ignored `node_modules/`
 * either exists in the wall's scratch copy or it does not. Replaying these measures a different
 * filesystem, so they are recorded as evidence of what the attempt's own tree looked like —
 * never as a claim the wall can re-run. Measured the hard way: the first live replay reproduced
 * `read-tree`, `add`, both `diff` reads and `ls-files`, and mismatched exactly these two.
 */
export const WORKTREE_READ_PROVENANCE: CommandProvenance = {
  source: 'factory-verification',
  replayable: false,
  replaySkipReason:
    'output depends on untracked and ignored working-tree contents, which cannot be reconstructed ' +
    "from the receipt's base: an ignored node_modules/ either exists in the replay's scratch copy " +
    'or it does not',
};

export interface EnvFingerprint {
  /** Names the child was given, sorted. Never a value. */
  readonly keys: readonly string[];
  /** Per-name hash of the value, so two launches can be compared without disclosure. */
  readonly valueHashes: Readonly<Record<string, string>>;
  /** Names refused by the allowlist. Recorded so the refusal is auditable, never the value. */
  readonly dropped: readonly string[];
}

/** Fingerprint an environment for the launch record: keys and value hashes, never values. */
export function fingerprintEnv(
  env: NodeJS.ProcessEnv,
  dropped: readonly string[] = [],
): EnvFingerprint {
  const keys: string[] = [];
  const valueHashes: Record<string, string> = {};
  for (const [name, value] of Object.entries(env)) {
    if (value === undefined) continue;
    // A credential must not appear even as a name: a record that lists it tells a reader
    // which variable to hunt for, and tells a reviewer the worker held it.
    if (CREDENTIAL_NAME.test(name)) continue;
    keys.push(name);
    valueHashes[name] = hashEnvValue(value);
  }
  keys.sort();
  return {
    keys,
    valueHashes,
    dropped: [...dropped].filter((name) => CREDENTIAL_NAME.test(name) === false).sort(),
  };
}

export interface LaunchRecord {
  readonly schema: 'launch/1';
  readonly recordedAt: string;
  readonly effectId: string;
  readonly attempt: number;
  readonly unitId: string;
  readonly attemptId: string;
  /** The argv the child was spawned with, prompt included as `<prompt N bytes>`. */
  readonly argv: readonly string[];
  /** The working directory, which is also the sandbox root and the container mount. */
  readonly cwd: string;
  readonly mountedAt: string;
  /** `null` when there is no DSH home (the scripted executor). */
  readonly dshHome: string | null;
  /**
   * The profile the launch asked for, and the one the seeded home actually contains.
   *
   * Two fields because they are two facts: a requested profile that the provisioned template
   * cannot satisfy throws before any of this is written, so a divergence would be a bug worth
   * seeing rather than a number to assume. `effective` is read back from the home on disk.
   */
  readonly profile: { readonly requested: string; readonly effective: string | null };
  /** The composed overlay: the file on disk and the hash of the bytes that were written. */
  readonly overlay: { readonly path: string | null; readonly sha256: string | null };
  readonly env: EnvFingerprint;
  /**
   * Credential variable *names* the child was given. Empty unless the operator set
   * `FACTORY_LIVE_MODEL=1`; a name here is a fact an auditor may want and a value never is.
   */
  readonly credentialsForwarded: readonly string[];
}

/** Write the launch record and return its path. Mode 0600: it names the worker's world. */
export function writeLaunchRecord(recordDir: string, record: LaunchRecord): string {
  const path = join(recordDir, LAUNCH_FILE);
  writeFileSync(path, `${JSON.stringify(record, null, 2)}\n`, { mode: 0o600 });
  return path;
}

/**
 * The profile the attempt home actually holds, read from the directory it was seeded into.
 *
 * This is deliberately a read-back and not a pass-through of the requested name: the record
 * must describe the composition that happened, and a home with two profiles (or none) is
 * something an auditor should be able to see rather than something the record smooths over.
 */
export function effectiveProfile(attemptHome: string): string | null {
  try {
    const entries = readdirSync(join(attemptHome, 'profiles'), { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name)
      .sort();
    return entries.length === 1 ? (entries[0] ?? null) : null;
  } catch {
    return null;
  }
}

/** `sha256:` of an overlay document, as written to disk. */
export function hashOverlay(overlayText: string): string {
  return hashEnvValue(overlayText);
}
