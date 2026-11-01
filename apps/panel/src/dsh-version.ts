/**
 * The one fact the panel cannot read out of the store: which DSH the workers run.
 *
 * The store records the *pinned* version (`PINNED_DSH_VERSION`), never the observed
 * one, so a page that only reads the store must either stay silent about a version
 * skew or claim a green it cannot verify. Both are wrong, which is why the observed
 * version is probed once at startup and injected: a successful probe makes silence
 * possible, and a failed probe is the truthful "unavailable" case rather than the
 * default one.
 *
 * The probe is local, offline and bounded: `spawnSync` with a short timeout, one
 * process, no retries. A missing or hanging binary yields `null` — the page then
 * says it could not look, which is exactly what happened.
 */
import { spawnSync } from 'node:child_process';

/** Overrides the binary that gets probed. Same variable the adapter uses for workers. */
export const DSH_BIN_ENV = 'FACTORY_DSH_BIN';
/** Short enough that a wedged binary cannot delay startup by more than a moment. */
export const PROBE_TIMEOUT_MS = 1_500;

/**
 * Pull a version out of whatever `--version` printed.
 *
 * Real outputs look like `dsh/0.2.1-rc.5`, `dsh 0.2.1-rc.5` or `0.2.1-rc.5`; the
 * parser takes the first semver-shaped token and ignores the rest, so a banner line
 * or a build suffix cannot turn a readable answer into `null`.
 */
export function parseDshVersion(output: string): string | null {
  const match = /(\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?)/.exec(output);
  return match?.[1] ?? null;
}

export interface ProbeOptions {
  readonly env?: Readonly<Record<string, string | undefined>>;
  readonly timeoutMs?: number;
}

/**
 * Ask `$FACTORY_DSH_BIN --version` (or `dsh --version`) once.
 *
 * Every failure mode — absent binary, non-zero exit, timeout, unparseable output —
 * returns `null` rather than throwing: the panel's job is to report, and "I could
 * not read it" is a reportable fact, not a reason to refuse to start.
 */
export function probeDshVersion(options: ProbeOptions = {}): string | null {
  const env = options.env ?? process.env;
  const configured = env[DSH_BIN_ENV];
  const bin =
    typeof configured === 'string' && configured.trim().length > 0 ? configured.trim() : 'dsh';
  const result = spawnSync(bin, ['--version'], {
    encoding: 'utf8',
    timeout: options.timeoutMs ?? PROBE_TIMEOUT_MS,
    // stdin closed, both streams captured: the probe must never wait for input.
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  if (result.error !== undefined) return null;
  if (result.status !== 0) return null;
  const stdout = typeof result.stdout === 'string' ? result.stdout : '';
  const stderr = typeof result.stderr === 'string' ? result.stderr : '';
  return parseDshVersion(`${stdout}\n${stderr}`);
}
