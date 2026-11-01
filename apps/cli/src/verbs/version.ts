/**
 * `factory version` — what this build expects, and what it can see.
 *
 * The pinned dsh version is a *reproducibility claim*, not a preference: a
 * mismatch is refused at startup (`DSH_VERSION_MISMATCH`, exit 8) rather than
 * warned about, because a factory that runs on an unknown harness version cannot
 * claim its own results (`ux-plan.md` §5.2).
 */
import { execFileSync } from 'node:child_process';

import { currentPolicyVersion } from '@factory/qualifier';

import { FACTORY_VERSION, PINNED_DSH_VERSION, WALL_VERSION_FALLBACK } from '../render/status.ts';
import type { VerbInput, VerbSpec } from './types.ts';

export { FACTORY_VERSION, PINNED_DSH_VERSION };

/**
 * The one process this CLI spawns without dispatching work. Absent binary, a
 * non-zero exit and unparsable output all mean the same thing: the version is
 * `unknown`, and unknown is printed as unknown.
 */
export function observedDshVersion(ctx: VerbInput['ctx']): string | null {
  if (ctx.executor.binPath === null) return null;
  try {
    const out = execFileSync(ctx.executor.binPath, ['--version'], {
      encoding: 'utf8',
      timeout: 5_000,
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    const match = /(\d+\.\d+\.\d+(?:-[0-9A-Za-z.]+)?)/u.exec(out);
    return match?.[1] ?? null;
  } catch {
    return null;
  }
}

export function runVersion(input: VerbInput): number {
  const { ctx } = input;
  const observed = observedDshVersion(ctx);
  const payload = {
    version: FACTORY_VERSION,
    dshVersionExpected: PINNED_DSH_VERSION,
    dshVersionObserved: observed,
    policyVersion: currentPolicyVersion(),
    wallVersion: ctx.wall.available ? WALL_VERSION_FALLBACK : null,
    executor: { available: ctx.executor.available, binPath: ctx.executor.binPath },
    home: ctx.home,
    traceId: ctx.traceId,
  };
  input.emit(payload);

  const observedText = observed === null ? 'unknown (no dsh on PATH)' : observed;
  const lines = [
    `factory  ${FACTORY_VERSION}`,
    `dsh      expected ${PINNED_DSH_VERSION}  ${'·'}  observed ${observedText}`,
    `policy   ${currentPolicyVersion()}`,
    `executor ${ctx.executor.available ? 'available' : 'unavailable'}  (${ctx.executor.detail})`,
    `home     ${ctx.home}`,
  ];
  if (observed !== null && observed !== PINNED_DSH_VERSION) {
    lines.push(
      '',
      `DSH_VERSION_MISMATCH: this factory pins dsh ${PINNED_DSH_VERSION}; found ${observed}.`,
      'Refusing to dispatch is the correct behaviour — a warning here would be a lie about reproducibility.',
    );
  }
  for (const line of lines) ctx.ui.err(line);
  return 0;
}

export const versionVerb: VerbSpec = {
  name: 'version',
  verb: 'version',
  summary: 'Print the versions this build expects and what it can see',
  configure: () => undefined,
  action: runVersion,
};
