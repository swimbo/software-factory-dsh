/**
 * Secret files: the one place this CLI reads a credential it did not receive in its environment.
 *
 * Two credentials now live in a file rather than a variable — the alert webhook and, as of this
 * round, the model key — for the same reason: an environment variable is copied into whatever
 * inherits the process (a launch agent in `~/Library/LaunchAgents`, which other local users can
 * read; a `ps`-visible argv; a shell history file), and a 0600 file under the factory home is not.
 *
 * The rules are one function so that the two call sites cannot drift:
 *
 *  1. **Open first, then check the mode on that descriptor.** `stat(path)` followed by
 *     `open(path)` is a race: another process can swap the file in between, and the check then
 *     describes a file nobody read. `fstat` on the open descriptor describes the file that was
 *     read.
 *  2. **Refuse, never warn.** A group- or world-readable secret is not used and the value is never
 *     read — a warning would be printed into a log that outlives the mistake.
 *  3. **Name the fix.** The refusal says `chmod 600 <path>` because "insecure permissions" leaves
 *     the operator to guess which command, and an operator who guesses wrong stops reading.
 *  4. **Never echo the value.** No branch of this function puts the secret in a message; the
 *     messages carry the path and the mode only.
 *
 * @see docs/runbooks/evidence-expiry.md — the alert webhook
 * @see docs/runbooks/live-model.md — the model key
 */
import { closeSync, fstatSync, openSync, readFileSync } from 'node:fs';

/** What a secret file turned out to be. `refused` always means "nothing was read". */
export type SecretFile =
  | { readonly kind: 'value'; readonly value: string }
  | { readonly kind: 'missing' }
  | { readonly kind: 'refused'; readonly detail: string };

/** The only mode a secret file may have: owner read/write, nobody else anything. */
export const SECRET_FILE_MASK = 0o077;

/**
 * Read a secret from a file that only its owner can read.
 *
 * A trailing newline is trimmed (a value pasted from a terminal has one); an interior newline is
 * not, because a value with an interior newline is a mistake the caller should see fail on use
 * rather than a value silently truncated here.
 */
export function readSecretFile(path: string): SecretFile {
  let fd: number;
  try {
    fd = openSync(path, 'r');
  } catch (error) {
    if (isMissingFile(error)) return { kind: 'missing' };
    return { kind: 'refused', detail: `${path} could not be opened: ${singleLine(error)}` };
  }
  try {
    const stat = fstatSync(fd);
    if (!stat.isFile()) {
      return { kind: 'refused', detail: `${path} is not a regular file, so it was not read` };
    }
    if ((stat.mode & SECRET_FILE_MASK) !== 0) {
      return {
        kind: 'refused',
        detail:
          `${path} is mode ${octalMode(stat.mode)} — group- or world-accessible, so it was not ` +
          `read. Run: chmod 600 ${path}`,
      };
    }
    const value = readFileSync(fd, 'utf8').trim();
    if (value.length === 0) return { kind: 'refused', detail: `${path} is empty` };
    return { kind: 'value', value };
  } finally {
    closeSync(fd);
  }
}

/** `755`, never `0o755`: the mode is reported the way `ls -l` and `chmod` write it. */
export function octalMode(mode: number): string {
  return (mode & 0o777).toString(8).padStart(3, '0');
}

function isMissingFile(error: unknown): boolean {
  if (typeof error !== 'object' || error === null || !('code' in error)) return false;
  return error.code === 'ENOENT';
}

export function singleLine(value: unknown): string {
  const text = (value instanceof Error ? `${value.name}: ${value.message}` : String(value))
    .replace(/\s+/gu, ' ')
    .trim();
  return text.length > 0 ? text : 'no detail';
}
