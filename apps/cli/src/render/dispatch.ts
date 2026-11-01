/**
 * The `run` progress model: **one appended line per state transition**, and
 * nothing between transitions (`ux-plan.md` §3.3).
 *
 * There is no spinner, no percentage, no ETA and no `\r` redraw, because a
 * cursor-addressing loop is the one thing that reliably breaks a screen reader
 * and a percentage over a model loop is a fabricated number. Silent, by rule:
 * per-tool-call chatter, the model's prose, and the diff.
 */
import { field } from './format.ts';

export type TransitionKind =
  | 'dispatched'
  | 'running'
  | 'receipt'
  | 'verifying'
  | 'verdict'
  | 'promotion'
  | 'ambiguous'
  | 'killed';

export interface Transition {
  readonly kind: TransitionKind;
  readonly at: string;
  readonly detail: string;
}

/** `dispatched   A-01  attempt 1/1  container …  base a1b2c3d` */
export function transitionLine(transition: Transition): string {
  return `${transition.kind.padEnd(12)} ${transition.detail}`;
}

export function dispatched(
  attemptId: string,
  attemptNo: number,
  maxAttempts: number,
  detail: string,
): Transition {
  return {
    kind: 'dispatched',
    at: new Date(0).toISOString(),
    detail: `${attemptId}  attempt ${attemptNo}/${maxAttempts}  ${detail}`,
  };
}

export function receiptLine(
  receiptId: string,
  files: number,
  added: number,
  removed: number,
  commands: number,
): Transition {
  return {
    kind: 'receipt',
    at: new Date(0).toISOString(),
    detail: `${receiptId}  diff ${files} file(s) +${added}/-${removed}  commands ${commands}`,
  };
}

export function verdictLine(
  verdictId: string,
  state: string,
  delta: string,
  holdout: string,
  wall: string,
): Transition {
  return {
    kind: 'verdict',
    at: new Date(0).toISOString(),
    detail: `${verdictId}  ${state}  delta ${delta}  holdout ${holdout}  ${wall}`,
  };
}

/**
 * The promotion notice that follows a passing verdict and precedes the gate: the
 * operator is told what is withheld and the one command that unfreezes it.
 */
export function promotionWithheld(unitId: string): string[] {
  return [
    field('promotion', 'withheld - first promotion of this unit requires your signature'),
    `             -> factory promote ${unitId}`,
  ];
}
