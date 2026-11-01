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
