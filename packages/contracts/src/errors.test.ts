/**
 * The refusal contract.
 *
 * Scripts switch on the exit code alone (`ux-plan.md` §5.1 says so normatively),
 * so the code→exit mapping is not an implementation detail: it is the interface
 * the e2e suite, the status page and any operator script agree on. The table
 * below is asserted in full and explicitly — a derived assertion could drift
 * with the source and would then agree with its own bug.
 *
 * The other rule this file protects is L3: **unknown is not pass.** A gate
 * satisfied by `unknown` would let a missing measurement become a verdict.
 */
import { describe, expect, it } from 'vitest';
import {
  ERROR_CODES,
  type ErrorCode,
  exitCodeFor,
  FactoryError,
  gateSatisfied,
  isFactoryError,
  triFromBool,
  triIsPass,
} from './errors.ts';

/** `ux-plan.md` §5.1, transcribed: 0 success · 1 internal · 2 usage · 3 policy · 4 unknown · 5 gate · 6 budget · 7 conflict · 8 environment · 9 integrity. */
const EXPECTED_EXIT_CODES: Readonly<Record<ErrorCode, number>> = {
  // 3 — policy refusal: known, correct, fixable by editing or resubmitting
  SPEC_INVALID: 3,
  DUPLICATE_UNIT: 3,
  LANE_NOT_DARK: 3,
  UNIT_NOT_FOUND: 3,
  ATTEMPT_NOT_FOUND: 3,
  MANDATE_EXPIRED: 3,
  UNIT_ALREADY_TERMINAL: 3,
  CLASS_NOT_CERTIFIED: 3,
  VERDICT_FAILED: 3,
  // 4 — unknown / ambiguous
  ATTEMPT_AMBIGUOUS: 4,
  WALL_UNAVAILABLE: 4,
  // 5 — human gate
  GATE_REQUIRED: 5,
  PROMOTION_UNSIGNED: 5,
  VERDICT_MISSING: 5,
  VERDICT_STALE: 5,
  VERDICT_UNKNOWN: 5,
  // 6 — budget
  BUDGET_EXCEEDED: 6,
  USAGE_UNRECONCILED: 6,
  // 7 — concurrency / conflict
  CONCURRENCY_LIMIT: 7,
  LEASE_HELD: 7,
  RECEIPT_CONFLICT: 7,
  // 8 — environment
  ANCHOR_UNAVAILABLE: 8,
  EXECUTOR_UNAVAILABLE: 8,
  DSH_VERSION_MISMATCH: 8,
  CONTAINER_UNAVAILABLE: 8,
  CONFIGURATION_CONFLICT: 8,
  // 9 — integrity
  STORE_QUARANTINED: 9,
  // 1 — internal
  INTERNAL: 1,
};

function codesWithExit(exitCode: number): readonly ErrorCode[] {
  return ERROR_CODES.filter((code) => exitCodeFor(code) === exitCode);
}

describe('the exit-code table', () => {
  it('maps every error code to exactly one exit code, matching ux-plan §5.1 in full', () => {
    const actual = Object.fromEntries(ERROR_CODES.map((code) => [code, exitCodeFor(code)]));
    expect(actual).toEqual(EXPECTED_EXIT_CODES);
  });

  it('declares each error code once (a duplicate would give one code two next-actions)', () => {
    expect(new Set(ERROR_CODES).size).toBe(ERROR_CODES.length);
  });

  it('never maps a refusal to exit 0 (success) or 2 (usage)', () => {
    for (const code of ERROR_CODES) {
      expect(exitCodeFor(code)).not.toBe(0);
      expect(exitCodeFor(code)).not.toBe(2);
    }
  });

  it('draws exit codes only from the documented classes', () => {
    expect(new Set(ERROR_CODES.map((code) => exitCodeFor(code)))).toEqual(
      new Set([1, 3, 4, 5, 6, 7, 8, 9]),
    );
  });

  it('keeps class 4 to exactly the unknown/ambiguous pair (never implies success or failure)', () => {
    expect(codesWithExit(4)).toEqual(['ATTEMPT_AMBIGUOUS', 'WALL_UNAVAILABLE']);
  });

  it('keeps class 9 to the single integrity code', () => {
    expect(codesWithExit(9)).toEqual(['STORE_QUARANTINED']);
  });

  it('keeps class 1 to the single internal code (never a catch-all for a classified refusal)', () => {
    expect(codesWithExit(1)).toEqual(['INTERNAL']);
  });
});

describe('FactoryError', () => {
  it('carries the code and the exit code the table assigns to it', () => {
    const error = new FactoryError('BUDGET_EXCEEDED', 'projected $2.41 > envelope $2.00');
    expect(error.code).toBe('BUDGET_EXCEEDED');
    expect(error.exitCode).toBe(6);
  });

  it('is an Error with a stable name, so a crash log names the contract', () => {
    const error = new FactoryError('INTERNAL', 'unaccounted state');
    expect(error).toBeInstanceOf(Error);
    expect(error.name).toBe('FactoryError');
  });

  it('freezes a copy of details, so later mutation cannot rewrite the evidence', () => {
    const details: Record<string, unknown> = { unitId: 'U-1' };
    const error = new FactoryError('UNIT_NOT_FOUND', 'no unit U-1', details);
    details['unitId'] = 'U-2';
    expect(error.details).toEqual({ unitId: 'U-1' });
    expect(Object.isFrozen(error.details)).toBe(true);
  });

  it('refuses mutation of details after construction', () => {
    const error = new FactoryError('LEASE_HELD', 'attempt holds the lease', { holderPid: 41902 });
    expect(() => {
      (error.details as Record<string, unknown>)['holderPid'] = 1;
    }).toThrow(TypeError);
  });

  it('is narrowed by isFactoryError', () => {
    const exitCodeOf = (value: unknown): number | undefined =>
      isFactoryError(value) ? value.exitCode : undefined;
    expect(exitCodeOf(new FactoryError('GATE_REQUIRED', 'budget gate'))).toBe(5);
  });

  it('does not treat a plain Error as a FactoryError (a bug is not a classified refusal)', () => {
    expect(isFactoryError(new Error('boom'))).toBe(false);
    expect(isFactoryError('SPEC_INVALID')).toBe(false);
    expect(isFactoryError(null)).toBe(false);
  });
});

describe('the tri-state helpers', () => {
  it('satisfies a gate only with an explicit pass', () => {
    expect(gateSatisfied('pass')).toBe(true);
  });

  it("does not satisfy a gate with 'unknown' — unknown never satisfies a gate", () => {
    expect(gateSatisfied('unknown')).toBe(false);
  });

  it("does not satisfy a gate with 'fail'", () => {
    expect(gateSatisfied('fail')).toBe(false);
  });

  it('derives pass/fail from a boolean without ever producing unknown', () => {
    expect(triFromBool(true)).toBe('pass');
    expect(triFromBool(false)).toBe('fail');
  });

  it('treats only pass as passing', () => {
    expect(triIsPass('pass')).toBe(true);
    expect(triIsPass('unknown')).toBe(false);
    expect(triIsPass('fail')).toBe(false);
  });
});
