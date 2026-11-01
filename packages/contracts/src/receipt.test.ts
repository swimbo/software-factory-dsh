/**
 * The receipt contract — the L1 barrier.
 *
 * L1 says an agent's report is not evidence. The receipt is therefore the
 * factory's *own* capture of mechanical facts (diff hash, argv, exit codes,
 * output hashes, ceilings), and `narrative` — the only free-text field — is
 * excluded from every decision path at the type level. The tests below prove
 * both halves: the mechanical fields are constrained enough to be re-executable,
 * and the narrative cannot reach a verifier by accident.
 */
import { describe, expect, it } from 'vitest';
import {
  toDecisionReceipt,
  WorkerReceipt,
  type DecisionReceipt,
  type WorkerReceipt as WorkerReceiptType,
} from './receipt.ts';

const validReceipt = (): WorkerReceiptType => ({
  unitId: 'U-7f3a9c',
  attemptId: 'A-01',
  sessionId: 'sess-9f41',
  startedAt: '2026-11-01T12:00:00.000Z',
  endedAt: '2026-11-01T12:04:11.000Z',
  exitCode: 0,
  diff: {
    patchFile: 'work/U-7f3a9c/A-01/change.patch',
    sha: `sha256:${'a'.repeat(64)}`,
    filesChanged: 2,
    insertions: 34,
    deletions: 7,
    baseRev: 'b'.repeat(40),
  },
  commands: [
    {
      argv: ['node', '--test', 'tests/'],
      cwd: 'work/U-7f3a9c/A-01',
      exitCode: 0,
      timedOut: false,
      outputSha: `sha256:${'c'.repeat(64)}`,
      durationMs: 1200,
    },
  ],
  suite: {
    command: ['node', '--test', 'tests/'],
    exitCode: 0,
    passed: 9,
    failed: 0,
    skipped: 0,
    unknown: 0,
  },
  ceilings: { turnsUsed: 14, wallClockMs: 251_000, hit: [] },
  artifacts: [
    {
      path: 'artifacts/test-report.txt',
      sha: `sha256:${'d'.repeat(64)}`,
      bytes: 2048,
      kind: 'test-report',
    },
  ],
  narrative: 'Implemented slugify; all tests pass.',
});

/** Why a receipt was refused, as dotted paths, so a test names the rule it protects. */
function issuePaths(value: unknown): readonly string[] {
  const result = WorkerReceipt.safeParse(value);
  return result.success ? [] : result.error.issues.map((issue) => issue.path.join('.'));
}

describe('WorkerReceipt', () => {
  it('accepts a receipt of mechanical facts (the fixture used below)', () => {
    expect(WorkerReceipt.safeParse(validReceipt()).success).toBe(true);
  });

  it('requires the diff hash to be sha256-prefixed, so it cannot be mistaken for a raw digest', () => {
    const receipt = { ...validReceipt(), diff: { ...validReceipt().diff, sha: 'a'.repeat(64) } };
    expect(issuePaths(receipt)).toContain('diff.sha');
  });

  it('requires filesChanged to be an integer (a fractional count is not a measurement)', () => {
    const receipt = { ...validReceipt(), diff: { ...validReceipt().diff, filesChanged: 1.5 } };
    expect(issuePaths(receipt)).toContain('diff.filesChanged');
  });

  it('requires the diff baseRev to be the 40-hex commit the patch applies to', () => {
    const receipt = { ...validReceipt(), diff: { ...validReceipt().diff, baseRev: 'HEAD' } };
    expect(issuePaths(receipt)).toContain('diff.baseRev');
  });

  it('treats patchFile as an attempt-relative path: the digest is diff.sha, not patchFile', () => {
    // The plan's brief asked for patchFile to be hash-validated. The contract
    // documents it as a path (`receipt.ts:43`) and constrains the hash in
    // `diff.sha`; an arbitrary attempt path must therefore parse.
    const receipt = {
      ...validReceipt(),
      diff: { ...validReceipt().diff, patchFile: 'a/change.patch' },
    };
    expect(WorkerReceipt.safeParse(receipt).success).toBe(true);
  });

  it('still refuses an empty patchFile', () => {
    const receipt = { ...validReceipt(), diff: { ...validReceipt().diff, patchFile: '' } };
    expect(issuePaths(receipt)).toContain('diff.patchFile');
  });

  it('refuses a receipt with no narrative key at all: "no narrative" must be stated as null', () => {
    const { narrative: _omitted, ...withoutNarrative } = validReceipt();
    expect(issuePaths(withoutNarrative)).toContain('narrative');
  });

  it('can record a suite with unknowns, which are never folded into passed (L3)', () => {
    const receipt = {
      ...validReceipt(),
      suite: { ...validReceipt().suite, passed: 6, unknown: 3 },
    };
    expect(WorkerReceipt.safeParse(receipt).success).toBe(true);
  });
});

describe('toDecisionReceipt — the L1 barrier', () => {
  it('strips the narrative and throws nothing', () => {
    const receipt = validReceipt();
    expect(() => toDecisionReceipt(receipt)).not.toThrow();
    expect('narrative' in toDecisionReceipt(receipt)).toBe(false);
  });

  it('has no narrative key at all, not merely a narrative key holding undefined', () => {
    const result = toDecisionReceipt(validReceipt());
    expect(Object.keys(result)).not.toContain('narrative');
    expect(JSON.stringify(result)).not.toContain('all tests pass');
  });

  it('keeps every mechanical fact unchanged', () => {
    const receipt = validReceipt();
    const result = toDecisionReceipt(receipt);
    const expectedKeys = Object.keys(receipt)
      .filter((key) => key !== 'narrative')
      .sort();
    expect(Object.keys(result).sort()).toEqual(expectedKeys);
    expect(result.diff).toEqual(receipt.diff);
    expect(result.commands).toEqual(receipt.commands);
    expect(result.ceilings).toEqual(receipt.ceilings);
  });

  it('strips a 200k-character narrative without choking on it', () => {
    const receipt = { ...validReceipt(), narrative: 'x'.repeat(200_000) };
    const result = toDecisionReceipt(receipt);
    expect('narrative' in result).toBe(false);
    expect(result.unitId).toBe('U-7f3a9c');
  });

  it('excludes narrative at the type level too, so a verifier cannot reach the field', () => {
    // Compile-time fact asserted at runtime: if DecisionReceipt ever regains
    // `narrative`, this annotation stops typechecking before the suite runs.
    type DecisionReceiptHasNarrative = 'narrative' extends keyof DecisionReceipt ? true : false;
    const hasNarrative: DecisionReceiptHasNarrative = false;
    expect(hasNarrative).toBe(false);
  });
});

/**
 * Command provenance — the fix for the first live attempt.
 *
 * The wall replays commands. A live attempt recorded the worker launch (`dsh …`) and the
 * factory's own post-attempt `git diff --cached` / `--numstat` reads alongside the real
 * worker commands, so "replay everything" meant re-running a paid model and diffing an index
 * the wall does not reconstruct. The wall refused a good change with `receipt_unfaithful`.
 *
 * The fix is provenance on the record, set where the command is recorded, so the schema
 * enforces what can and cannot be replayed instead of leaving it to the wall's memory.
 */
describe('CommandRecord provenance', () => {
  const baseCommand = () => ({
    argv: ['pnpm', 'test'],
    cwd: 'worktree',
    exitCode: 0,
    timedOut: false,
    outputSha: `sha256:${'d'.repeat(64)}`,
    durationMs: 12,
  });

  const withCommand = (command: Record<string, unknown>) => ({
    ...validReceipt(),
    commands: [{ ...baseCommand(), ...command }],
  });

  it('rejects a worker-launch marked replayable: the attempt under test is not re-runnable', () => {
    const parsed = WorkerReceipt.safeParse(
      withCommand({ source: 'worker-launch', replayable: true }),
    );
    expect(parsed.success).toBe(false);
    // Not merely "some error": the message has to name the reason, because whoever reads it
    // is deciding whether to change the adapter.
    expect(JSON.stringify(parsed.error?.issues)).toContain('never replayable');
  });

  it('accepts a replayable factory-verification: the reads are deterministic from the base', () => {
    // This used to be a rejection. It was wrong: the reads are functions of (base commit,
    // staged tree) and the wall reconstructs that state, so refusing them left every real
    // receipt with zero replayable commands — `unknown` forever, which is a gate that cannot
    // open. The wall still refuses a *launch*, which is the command that truly cannot be re-run.
    const parsed = WorkerReceipt.safeParse(
      withCommand({ source: 'factory-verification', replayable: true }),
    );
    expect(parsed.success).toBe(true);
    // And an unreplayable one is still fine, as long as it says why.
    const explained = WorkerReceipt.safeParse(
      withCommand({
        source: 'factory-verification',
        replayable: false,
        replaySkipReason: 'captured on a checkout whose index could not be rebuilt',
      }),
    );
    expect(explained.success).toBe(true);
  });

  it('requires a skip reason whenever a command says it is not replayable', () => {
    const bare = WorkerReceipt.safeParse(
      withCommand({ source: 'worker-command', replayable: false }),
    );
    expect(bare.success).toBe(false);
    expect(JSON.stringify(bare.error?.issues)).toContain('must say why');

    const explained = WorkerReceipt.safeParse(
      withCommand({
        source: 'worker-command',
        replayable: false,
        replaySkipReason: 'the test hits an external service whose responses are not reproducible',
      }),
    );
    expect(explained.success).toBe(true);
  });

  it('accepts a replayable worker command, which is the only thing the wall may re-run', () => {
    const parsed = WorkerReceipt.safeParse(
      withCommand({ source: 'worker-command', replayable: true }),
    );
    expect(parsed.success).toBe(true);
  });

  it('still parses a historical receipt with no provenance, and the wall treats it as not replayable', () => {
    // Backwards compatibility is a parsing promise, not a replay promise: an old receipt
    // must still load (the ledger is history), but absence is never read as "safe to re-run".
    const parsed = WorkerReceipt.safeParse(withCommand({}));
    expect(parsed.success).toBe(true);
    expect(parsed.data?.commands[0]?.replayable).toBeUndefined();
  });
});
