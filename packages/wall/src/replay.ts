/**
 * Replaying the factory's own verification reads.
 *
 * The first live attempt exposed two opposite mistakes in the same check:
 *
 * 1. replaying the worker launch (`dsh …`) — the thing under test, non-deterministic, and on a
 *    paid attempt a replay spends money;
 * 2. replaying the factory's `git diff --cached` / `--numstat` reads *in isolation and out of
 *    order*, so they diverged even though nothing was wrong with the change.
 *
 * Fixing (1) alone produced a worse defect: every command on a real receipt is non-replayable,
 * so the wall replayed nothing, and L3 (`unknown` never satisfies a gate) turned the central
 * path into "no real worker can ever produce a promotable unit". A gate that cannot open is not
 * caution.
 *
 * The resolution is in this file: those reads **are** replayable, because they are deterministic
 * functions of (base commit, staged tree) — and the wall can reconstruct that state. Each replay
 * runs the recorded command in a scratch copy whose index was rebuilt from the receipt's base by
 * the replay itself:
 *
 *     git read-tree <base> && git add --all -- . && <recorded argv>
 *
 * `read-tree` discards whatever index the checkout shipped with (the operator's), `add --all`
 * stages the candidate tree the runner produced, and then the recorded read runs against
 * exactly the state it was recorded in. The prefix is silent, so the command's output hash
 * still compares against the recorded one.
 *
 * Two things this file deliberately does **not** do:
 *
 * - It never invents a shell. A token outside `SAFE_TOKEN` makes the command unreplayable with
 *   a reason instead of being escaped, so there is no quoting surface to get wrong.
 * - It does not decide anything for `worker-launch`: that is the caller's refusal, by definition
 *   (see `replayPolicy` in `evaluate.ts`).
 */
import type { CommandRecord } from '@factory/contracts';

const SHA = /^[0-9a-f]{40}$/u;

/**
 * Characters safe to interpolate into the replay script unquoted. Anything else — a space, a
 * quote, a `$`, a backtick — makes the command unreplayable-with-reason rather than escaped.
 */
const SAFE_TOKEN = /^[A-Za-z0-9_@%+=:,./-]+$/u;

export function isGitReadTree(argv: readonly string[]): boolean {
  return argv[0] === 'git' && argv[1] === 'read-tree';
}

/** `git add --all`, in any of the spellings a recorder might use, but never plain `git add x`. */
export function isGitAddAll(argv: readonly string[]): boolean {
  if (argv[0] !== 'git' || argv[1] !== 'add') return false;
  return argv.includes('--all') || argv.includes('-A');
}

const isVerification = (command: CommandRecord): boolean =>
  command.source === 'factory-verification';

/**
 * Is the recorded verification group in the order the replay needs?
 *
 * Returns a reason string when it is not, and `null` when the group is usable. A group with no
 * reconstruction commands at all is usable: the wall supplies the reconstruction from the
 * receipt's base (the recorded reads say *what to compare*, not how to set up the tree).
 */
export function verificationSequenceProblem(
  commands: readonly CommandRecord[],
  baseRev: string,
): string | null {
  const group = commands.filter(isVerification);
  if (group.length === 0) return null;

  const hasReconstruction = group.some(
    (command) => isGitReadTree(command.argv) || isGitAddAll(command.argv),
  );
  if (!hasReconstruction) return null;

  // With reconstruction commands recorded, the order is load-bearing: a read captured before
  // the index existed cannot be trusted, and replaying it "anyway" is the original defect.
  let stage: 'start' | 'tree' | 'add' = 'start';
  for (const command of group) {
    if (isGitReadTree(command.argv)) {
      if (stage !== 'start') return 'git read-tree is recorded after the reads it should precede';
      const target = command.argv[2];
      if (target !== undefined && target !== baseRev) {
        return `git read-tree names ${target.slice(0, 12)}…, not the receipt base ${baseRev.slice(0, 12)}…`;
      }
      stage = 'tree';
      continue;
    }
    if (isGitAddAll(command.argv)) {
      if (stage !== 'tree') return 'git add is recorded before git read-tree';
      stage = 'add';
      continue;
    }
    if (stage === 'start') return 'a verified read is recorded before git read-tree';
    if (stage === 'tree') return 'a verified read is recorded before git add';
  }
  return null;
}

/**
 * The argv that replays one recorded verification read in a reconstructed index, or `null` when
 * this command cannot be replayed faithfully.
 */
export function replayScript(baseRev: string, argv: readonly string[]): string | null {
  if (!SHA.test(baseRev) || argv.length === 0) return null;
  for (const token of argv) if (!SAFE_TOKEN.test(token)) return null;
  return `git read-tree ${baseRev} && git add --all -- . && ${argv.join(' ')}`;
}

/** The argv handed to the runner for a replayed verification read. */
export function replayArgv(baseRev: string, argv: readonly string[]): readonly string[] | null {
  const script = replayScript(baseRev, argv);
  return script === null ? null : ['sh', '-c', script];
}
