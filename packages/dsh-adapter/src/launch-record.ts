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
 * The operator's consent to spend money on a model call — and nothing else.
 *
 * It used to be worse than that: while v1 had no credential proxy, the flag also meant "copy
 * `BIFROST_API_KEY` into the child's environment", because `dsh` had to authenticate somewhere
 * and there was nowhere else for the key to go (ADR-006's amendment). `packages/credential-proxy`
 * retires that: the worker is handed a **scoped token** for a localhost proxy, so this flag now
 * only says "this run may spend". It is still the default-off switch, because a run that
 * cannot authenticate is the offline-safe default and a live run is a deliberate act.
 */
export const LIVE_MODEL_FLAG = 'FACTORY_LIVE_MODEL';

/** The old name the flag used to forward. Kept exported for readers of the retirement. */
export const LIVE_MODEL_CREDENTIAL = 'BIFROST_API_KEY';

/**
 * The environment variable the *scoped* credential travels in.
 *
 * This is the only credential-shaped name the child is given, and it is given deliberately:
 * the overlay names it (`apiKeyEnv`), and its value is a token that this process can revoke,
 * that expires with the attempt's lease, and that is worthless anywhere but the factory's own
 * proxy. It is never the gateway key.
 */
export const PROXY_TOKEN_ENV = 'FACTORY_PROXY_TOKEN';

/** Whether the operator opted this process into a live, billable model call. */
export function liveModelEnabled(parentEnv: NodeJS.ProcessEnv): boolean {
  return (parentEnv[LIVE_MODEL_FLAG] ?? '').trim() === '1';
}

/**
 * The credential names forwarded from the operator's environment to the worker: **none**.
 *
 * This function is kept, and kept named this way, because it is the auditable answer to
 * "what did we hand over?" — and since ADR-007 the answer is a constant. When it returned
 * `['BIFROST_API_KEY']` the README was false on the live path; a function that says "nothing,
 * ever" is harder to quietly regress than a deleted one. The scoped proxy token is *not*
 * forwarded from the parent environment at all: it is minted per attempt by the launcher and
 * handed in explicitly (see {@link PROXY_TOKEN_ENV}), which is why it cannot appear here.
 */
export function forwardedCredentials(_parentEnv: NodeJS.ProcessEnv): readonly string[] {
  return [];
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
  options: {
    /**
     * The scoped proxy token this attempt may use, minted by the launcher.
     *
     * Passed as a value rather than read from `parentEnv` on purpose: forwarding a credential
     * that happens to be in the operator's shell is the pattern ADR-007 removed, and an
     * argument the caller must produce is a decision the caller must make. `undefined` means
     * "no model call is authorised for this attempt" and the child gets no credential at all.
     */
    readonly proxyToken?: string | undefined;
  } = {},
): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {
    DSH_HOME: dshHome,
    // Product telemetry posts to an external collector; a factory run must not
    // reach anything but the proxy.
    DSH_TELEMETRY_DISABLED: '1',
    PATH: parentEnv['PATH'] ?? '/usr/local/bin:/usr/bin:/bin',
  };
  if (options.proxyToken !== undefined && options.proxyToken !== '') {
    env[PROXY_TOKEN_ENV] = options.proxyToken;
  }
  for (const [name, value] of Object.entries(parentEnv)) {
    if (value === undefined) continue;
    // No credential-shaped name is ever copied from the parent, including under
    // `FACTORY_LIVE_MODEL=1`: the scoped token above is the only credential in this env.
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
   * Credential variable *names* forwarded from the operator's environment. Always empty since
   * ADR-007: a name here would mean the worker held something the factory did not mint.
   */
  readonly credentialsForwarded: readonly string[];
  /**
   * The scoped credential the attempt was given, or `null` when it was given none.
   *
   * The *fact* and the expiry, never the token: a launch record is copied, attached and
   * pasted, and a token in it would be a credential in a document. `state: 'scoped'` says
   * what the reader needs — this was not the gateway key, and it dies at `expiresAt`.
   */
  readonly credentialProxy: { readonly token: 'scoped'; readonly expiresAt: string } | null;
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
