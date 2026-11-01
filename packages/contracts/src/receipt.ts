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

export const CommandRecord = z.object({
  argv: z.array(z.string().min(1)).min(1).max(64),
  cwd: z.string().min(1),
  exitCode: z.number().int().nullable(),
  timedOut: z.boolean(),
  /** Hash of the captured stdout+stderr, so the wall can re-execute and compare without storing megabytes. */
  outputSha: z.string().regex(/^sha256:[0-9a-f]{64}$/),
  durationMs: z.number().int().nonnegative(),
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
