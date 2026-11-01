/**
 * The receipt, and the law it enforces.
 *
 * L1: **an agent report is not evidence.** So the receipt is not the agent's
 * prose — it is mechanical facts the factory itself captured (diff hash, argv,
 * exit codes, output hashes, ceilings). `narrative` exists only for the
 * operator's eyes and is *excluded* from every decision path at the type level:
 * `DecisionReceipt` is the only receipt type any verifier may accept.
 */
import { z } from 'zod';

import { contentHash } from './canonical.ts';

/**
 * Where a recorded command came from.
 *
 * The distinction exists because the wall replays commands, and not every recorded command
 * can be replayed: the worker launch is the thing under test (non-deterministic, side
 * effecting, and on a live attempt it costs money), and the factory's own post-attempt
 * `git diff` reads depend on index state the wall does not reconstruct. Without provenance
 * the wall had one option — replay everything — and the first live attempt was refused with
 * `receipt_unfaithful` for re-running things that cannot be re-run.
 */
export const COMMAND_SOURCES = ['worker-launch', 'worker-command', 'factory-verification'] as const;
export type CommandSource = (typeof COMMAND_SOURCES)[number];

export const CommandRecord = z
  .object({
    argv: z.array(z.string().min(1)).min(1).max(64),
    cwd: z.string().min(1),
    exitCode: z.number().int().nullable(),
    timedOut: z.boolean(),
    /** Hash of the captured stdout+stderr, so the wall can re-execute and compare without storing megabytes. */
    outputSha: z.string().regex(/^sha256:[0-9a-f]{64}$/),
    durationMs: z.number().int().nonnegative(),
    /**
     * Provenance. Optional so historical receipts still parse; a record without it is
     * **not** replayable, because "no provenance" must never be read as "safe to re-run".
     */
    source: z.enum(COMMAND_SOURCES).optional(),
    /**
     * May the wall re-execute this command?
     *
     * Set where the command is recorded, never defaulted: absent means `false` in the wall's
     * policy, so an adapter that forgets the field loses replay coverage (loudly, via
     * `faithfulness_partial`) rather than silently re-running a model.
     */
    replayable: z.boolean().optional(),
    /** Why not. Required whenever `replayable` is explicitly `false`, so the verdict can say it. */
    replaySkipReason: z.string().min(1).max(500).optional(),
  })
  .superRefine((command, ctx) => {
    if (command.replayable === false && command.replaySkipReason === undefined) {
      ctx.addIssue({
        code: 'custom',
        path: ['replaySkipReason'],
        message: 'a command marked replayable: false must say why',
      });
    }
    // The launch is the thing under test: replaying it would re-run the worker (and, on a
    // live attempt, pay for it), and its output cannot be reproduced by construction.
    if (command.source === 'worker-launch' && command.replayable === true) {
      ctx.addIssue({
        code: 'custom',
        path: ['replayable'],
        message: 'a worker-launch command is never replayable',
      });
    }
    // `factory-verification` reads *are* replayable — as a sequence, from the receipt's base,
    // in an index the wall rebuilds (see `packages/wall/src/replay.ts`). The recorder may mark
    // them either way; the wall decides by class and sequence, because a receipt that marks
    // them unreplayable would leave every real attempt unmeasurable (`unknown` refuses gates,
    // and a gate that can never open is not caution). No issue here, deliberately.
  });
export type CommandRecord = z.infer<typeof CommandRecord>;

export const SuiteResult = z.object({
  command: z.array(z.string().min(1)).min(1),
  exitCode: z.number().int().nullable(),
  passed: z.number().int().nonnegative(),
  failed: z.number().int().nonnegative(),
  skipped: z.number().int().nonnegative(),
  /** Tests that could not be evaluated (crash, timeout, missing binary). Never folded into `passed`. */
  unknown: z.number().int().nonnegative(),
});
export type SuiteResult = z.infer<typeof SuiteResult>;

export const Ceilings = z.object({
  turnsUsed: z.number().int().nonnegative(),
  wallClockMs: z.number().int().nonnegative(),
  /** Which ceilings actually tripped, in the order they tripped. */
  hit: z.array(z.enum(['turns', 'wall-clock', 'tokens', 'output-bytes'])).max(4),
});
export type Ceilings = z.infer<typeof Ceilings>;

export const DiffRecord = z.object({
  /** Path to the patch file inside the attempt directory (never inside the repo). */
  patchFile: z.string().min(1),
  sha: z.string().regex(/^sha256:[0-9a-f]{64}$/),
  filesChanged: z.number().int().nonnegative(),
  insertions: z.number().int().nonnegative(),
  deletions: z.number().int().nonnegative(),
  /** The commit the patch applies to; re-execution is meaningless without it. */
  baseRev: z.string().regex(/^[0-9a-f]{40}$/),
  /**
   * Paths `git status --porcelain` reported but the patch does not contain —
   * untracked or unstaged work the agent left behind. Optional so receipts written
   * before this field existed still parse (the column is JSON, so there is no
   * migration). The wall uses it to distinguish "changed nothing" from "did work it
   * never staged", which `filesChanged: number` alone cannot express.
   */
  statusPaths: z.array(z.string().min(1)).max(4096).optional(),
});
export type DiffRecord = z.infer<typeof DiffRecord>;

export const ArtifactRecord = z.object({
  path: z.string().min(1),
  sha: z.string().regex(/^sha256:[0-9a-f]{64}$/),
  bytes: z.number().int().nonnegative(),
  kind: z.enum(['log', 'test-report', 'coverage', 'screenshot', 'other']),
});
export type ArtifactRecord = z.infer<typeof ArtifactRecord>;

/**
 * What the adapter assembled from a real DSH run. `narrative` is the only
 * free-text field and it is *not* part of the decision type below.
 */
export const WorkerReceipt = z.object({
  unitId: z.string().min(1),
  attemptId: z.string().min(1),
  /** The DSH session id, so a run can be found in the operator's own DSH logs. */
  sessionId: z.string().min(1),
  startedAt: z.string().datetime(),
  endedAt: z.string().datetime(),
  /** The DSH process exit code, verbatim. `null` when the process was killed. */
  exitCode: z.number().int().nullable(),
  diff: DiffRecord,
  commands: z.array(CommandRecord).max(512),
  suite: SuiteResult.nullable(),
  ceilings: Ceilings,
  artifacts: z.array(ArtifactRecord).max(256),
  /** For humans only. Never an input to a gate, a verdict or a lane. */
  narrative: z.string().max(200_000).nullable(),
});
export type WorkerReceipt = z.infer<typeof WorkerReceipt>;

/**
 * The L1 barrier, expressed in the type system: strip the narrative before any
 * verifier sees the receipt. `Omit` rather than a runtime delete, so a verifier
 * cannot reach the field even by reflection on a narrowed type.
 */
export type DecisionReceipt = Omit<WorkerReceipt, 'narrative'>;

export function toDecisionReceipt(receipt: WorkerReceipt): DecisionReceipt {
  const { narrative, ...rest } = receipt;
  void narrative;
  return rest;
}

/**
 * The identity of a receipt's **evidence**.
 *
 * Hashed over the decision projection — the receipt *without* `narrative` — because
 * that is the only form the wall ever sees (L1: the agent's prose is not evidence).
 * Hashing the whole body instead put the factory in a state where a receipt with a
 * narrative could not be joined to the verdict that judged it: the wall hashes what
 * it was given, the store hashed what it stored, and the two never matched.
 *
 * One function, used by the engine when it files a receipt, by the store when it
 * joins a verdict to one, and by every fixture. If this changes, evidence filed
 * under the old function stops joining — which is the correct behaviour for an
 * identity change, and the reason it lives here rather than at three call sites.
 */
export function receiptShaFor(receipt: WorkerReceipt): string {
  return contentHash(toDecisionReceipt(receipt));
}

/**
 * A receipt is "faithful" when its mechanical claims survived independent
 * re-execution. The wall computes this; the receipt itself cannot assert it.
 */
export const Faithfulness = z.object({
  receiptSha: z.string().regex(/^sha256:[0-9a-f]{64}$/),
  commandsReexecuted: z.number().int().nonnegative(),
  commandsMatching: z.number().int().nonnegative(),
  /** First divergence, if any: index + byte offset + both hashes. Opaque to the agent. */
  divergence: z
    .object({
      index: z.number().int().nonnegative(),
      byteOffset: z.number().int().nonnegative(),
      claimed: z.string(),
      observed: z.string(),
    })
    .nullable(),
  verdict: z.enum(['faithful', 'unfaithful', 'unknown']),
});
export type Faithfulness = z.infer<typeof Faithfulness>;
