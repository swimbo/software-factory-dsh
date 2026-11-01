/**
 * The unit contract: what a unit of intent may be, and which state changes are
 * legal.
 *
 * The transition table is not bookkeeping — it is where "the agent's report is
 * not evidence" (L1) becomes mechanical. `dispatched → verified` is absent on
 * purpose: a unit cannot reach a verdict without first producing a receipt, so
 * no amount of narrative can short-circuit into a `pass`.
 */
import { describe, expect, it } from 'vitest';
import {
  assertTransition,
  canTransition,
  isTerminal,
  TERMINAL_UNIT_STATES,
  UNIT_STATES,
  UnitSpec,
  type UnitSpec as UnitSpecType,
  type UnitState,
} from './unit.ts';

const validSpec = (): UnitSpecType => ({
  slug: 'slug-check',
  revision: 1,
  repo: 'dark-factory-dsh',
  baseRev: 'a'.repeat(40),
  intent: 'Trim whitespace and slugify the identifiers shown by the CLI check command.',
  restateBack: 'Make slugify turn " A B " into "a-b". Nothing else in the CLI changes.',
  acceptance: [
    {
      id: 'ac-1',
      text: 'slugify(" A B ") === "a-b"',
      oracle: { kind: 'unit-test', target: 'tests/slug.test.ts', expect: 'exit 0' },
    },
    {
      id: 'ac-2',
      text: 'the check command exits 0',
      oracle: { kind: 'command', target: 'node --test tests/', expect: 'exit 0' },
    },
  ],
  touchPaths: ['cli/check.ts', 'tests/slug.test.ts'],
  operationClasses: ['code-change', 'test-change'],
  sizeBudget: { files: 8, lines: 200 },
  budgetEstimateUsd: 0.5,
});

/** Why a spec was refused, as dotted paths, so a test names the rule and not just the outcome. */
function issuePaths(value: unknown): readonly string[] {
  const result = UnitSpec.safeParse(value);
  return result.success ? [] : result.error.issues.map((issue) => issue.path.join('.'));
}

describe('UnitSpec', () => {
  it('accepts a fully specified, machine-checkable spec (the fixture used below)', () => {
    expect(UnitSpec.safeParse(validSpec()).success).toBe(true);
  });

  it('rejects a manual oracle kind: a criterion a machine cannot check is not a criterion', () => {
    const spec = {
      ...validSpec(),
      acceptance: [
        {
          id: 'ac-1',
          text: 'a human reads the diff and agrees',
          oracle: { kind: 'manual', target: 'the diff', expect: 'a human says yes' },
        },
      ],
    };
    expect(issuePaths(spec)).toContain('acceptance.0.oracle.kind');
  });

  it('rejects an empty acceptance array (a unit with no criteria cannot be verified)', () => {
    expect(issuePaths({ ...validSpec(), acceptance: [] })).toContain('acceptance');
  });

  it('rejects a baseRev that is not a 40-hex commit (a branch name is not a reproducible base)', () => {
    expect(issuePaths({ ...validSpec(), baseRev: 'main' })).toContain('baseRev');
    expect(issuePaths({ ...validSpec(), baseRev: 'abc123' })).toContain('baseRev');
  });

  it('rejects a slug that is not lower-kebab', () => {
    expect(issuePaths({ ...validSpec(), slug: 'Slug_Check' })).toContain('slug');
  });

  it('rejects a negative budget estimate', () => {
    expect(issuePaths({ ...validSpec(), budgetEstimateUsd: -1 })).toContain('budgetEstimateUsd');
  });

  it('rejects more than 64 acceptance criteria', () => {
    const acceptance = Array.from({ length: 65 }, (_unused, index) => ({
      id: `ac-${index}`,
      text: 'the command exits 0',
      oracle: { kind: 'command', target: 'node --test tests/', expect: 'exit 0' },
    }));
    expect(issuePaths({ ...validSpec(), acceptance })).toContain('acceptance');
  });

  it('accepts a null budget estimate, because an unknown spend is representable (L3)', () => {
    expect(UnitSpec.safeParse({ ...validSpec(), budgetEstimateUsd: null }).success).toBe(true);
  });
});

describe('the unit state machine', () => {
  const DARK_PATH: readonly (readonly [UnitState, UnitState])[] = [
    ['submitted', 'qualified'],
    ['qualified', 'dispatched'],
    ['dispatched', 'receipted'],
    ['receipted', 'verified'],
    ['verified', 'promoted'],
  ];

  for (const [from, to] of DARK_PATH) {
    it(`${from} → ${to} is legal on the dark path`, () => {
      expect(canTransition(from, to)).toBe(true);
    });
  }

  it('dispatched → verified is illegal: a unit must be receipted first, so no report becomes a verdict', () => {
    expect(canTransition('dispatched', 'verified')).toBe(false);
    expect(() => assertTransition('dispatched', 'verified')).toThrow(
      /illegal unit transition dispatched → verified/,
    );
  });

  it('lit_parked has no outgoing transitions (the parked unit is not resumed behind the operator)', () => {
    for (const to of UNIT_STATES) {
      expect(canTransition('lit_parked', to)).toBe(false);
    }
  });

  it('every terminal state is a sink', () => {
    for (const terminal of TERMINAL_UNIT_STATES) {
      for (const to of UNIT_STATES) {
        expect(canTransition(terminal, to)).toBe(false);
      }
    }
  });

  it('ambiguous → receipted is legal: re-observation under the original identity, never a redispatch', () => {
    expect(canTransition('ambiguous', 'receipted')).toBe(true);
    expect(() => assertTransition('ambiguous', 'receipted')).not.toThrow();
  });

  it('a verified unit cannot re-enter dispatch (no re-running a unit that already has a verdict)', () => {
    expect(canTransition('verified', 'dispatched')).toBe(false);
    expect(canTransition('verified', 'receipted')).toBe(false);
  });

  it('no state transitions to itself', () => {
    for (const state of UNIT_STATES) {
      expect(canTransition(state, state)).toBe(false);
    }
  });

  it('isTerminal covers exactly promoted, rejected, aborted and lit_parked', () => {
    const terminal = UNIT_STATES.filter((state) => isTerminal(state));
    expect(terminal).toHaveLength(4);
    expect([...terminal].sort()).toEqual(['aborted', 'lit_parked', 'promoted', 'rejected']);
  });

  /**
   * GAP — reported to the lead, not fixed here (`data-map.md §4.1`, row
   * `receipted → rejected : Verdict verdict fail`; the same document also has
   * `ambiguous → rejected`). The table has neither edge, so a *measured*
   * failure — `VERDICT_FAILED`, exit 3, a known outcome — can only leave
   * `receipted` via an operator `abort` or by being reclassified `ambiguous`.
   * That is the L3 inversion the plan forbids: a measured failure must not
   * become an unknown.
   *
   * `it.fails` asserts the required rule while keeping the suite green; it goes
   * red the moment the edge is added, which is the prompt to promote it to `it`.
   */
  it('receipted → rejected is legal, because a fail verdict rejects the unit', () => {
    expect(canTransition('receipted', 'rejected')).toBe(true);
  });
});
