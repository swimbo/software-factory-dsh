/**
 * The re-certification plan: what a spend would cost, and what may spend it.
 *
 * These specs exist because the plan is the only thing standing between a nightly job and a class
 * spending money without a person. Every decision it can reach is pinned here, in particular the two
 * refusals that are easy to lose: an unknown estimate never authorises a spend (L3 applied to money),
 * and a missing budget is a refusal, not a default.
 */
import { describe, expect, it } from 'vitest';

import {
  median,
  parseRecertifyBudgets,
  planRecertification,
  type RecertifyDueClass,
} from './recertify-plan.ts';

const CLASSES: readonly RecertifyDueClass[] = [
  { taskClass: 'docs-hygiene', state: 'never-certified', samples: 1, m: 20 },
  { taskClass: 'type-repair', state: 'current', samples: 20, m: 20 },
  { taskClass: 'stale-class', state: 'stale', samples: 5, m: 20 },
  { taskClass: 'unmeasured', state: 'never-certified', samples: 0, m: 20 },
];

function plan(overrides: {
  budgets?: Iterable<[string, number]>;
  tokens?: Iterable<[string, readonly number[]]>;
  units?: Iterable<[string, string | null]>;
}): ReturnType<typeof planRecertification> {
  return planRecertification({
    classes: CLASSES,
    budgets: new Map(overrides.budgets ?? []),
    tokensByTaskClass: new Map(overrides.tokens ?? []),
    unitsFiles: new Map(overrides.units ?? []),
  });
}

describe('median', () => {
  it('is the middle value, or the mean of the two middle values', () => {
    expect(median([])).toBeNull();
    expect(median([7])).toBe(7);
    expect(median([3, 9])).toBe(6);
    expect(median([9, 3, 4])).toBe(4);
    expect(median([1, 2, 3, 4])).toBe(3);
  });
});

describe('parseRecertifyBudgets', () => {
  it('reads class=token pairs, and an absent variable is no budget at all', () => {
    expect(parseRecertifyBudgets(undefined, () => expect.fail('must not fail')).size).toBe(0);
    expect(parseRecertifyBudgets('   ', () => expect.fail('must not fail')).size).toBe(0);
    const parsed = parseRecertifyBudgets('docs-hygiene=200000, type-repair=2500000', () =>
      expect.fail('must not fail'),
    );
    expect(parsed.get('docs-hygiene')).toBe(200000);
    expect(parsed.get('type-repair')).toBe(2500000);
  });

  it('refuses a malformed entry instead of dropping a cap', () => {
    const refusals: string[] = [];
    const fail = (message: string): never => {
      refusals.push(message);
      throw new Error(message);
    };
    expect(() => parseRecertifyBudgets('docs-hygiene', fail)).toThrow(/not <task-class>=<tokens>/);
    expect(() => parseRecertifyBudgets('docs-hygiene=0', fail)).toThrow(/positive integer/);
    expect(() => parseRecertifyBudgets('=100', fail)).toThrow(/positive integer|not </);
    expect(refusals.length).toBe(3);
  });
});

describe('planRecertification', () => {
  it('leaves a current class alone', () => {
    const [entry] = plan({
      tokens: [['type-repair', [100, 200, 300]]],
      budgets: [['type-repair', 1_000_000]],
      units: [['type-repair', '/tmp/type-repair.txt']],
    }).filter((item) => item.taskClass === 'type-repair');
    expect(entry?.decision).toBe('not-due');
    expect(entry?.remaining).toBe(0);
  });

  it('projects the measured median over the attempts still needed', () => {
    const entry = plan({
      tokens: [
        ['docs-hygiene', [76_494, 76_494]],
        ['stale-class', [1_000, 2_000, 3_000]],
        ['unmeasured', []],
      ],
      budgets: [['docs-hygiene', 2_000_000]],
      units: [['docs-hygiene', '/tmp/docs-hygiene.txt']],
    }).find((item) => item.taskClass === 'docs-hygiene');
    expect(entry?.remaining).toBe(19);
    expect(entry?.estimate).toEqual({
      basis: 'measured',
      medianTokensPerAttempt: 76_494,
      measuredAttempts: 2,
      projectedTokens: 1_453_386,
    });
    expect(entry?.decision).toBe('would-spend');
  });

  it('refuses an unknown estimate with no measured attempt behind it', () => {
    const entry = plan({ tokens: [['unmeasured', []]] }).find(
      (item) => item.taskClass === 'unmeasured',
    );
    // An unknown estimate must not fall through to "0 tokens, under budget": the refusal is the
    // point, because a spend authorised by a guess is the money version of `unknown` satisfying a gate.
    expect(entry?.estimate.basis).toBe('unknown');
    expect(entry?.estimate.projectedTokens).toBeNull();
    expect(entry?.decision).toBe('refused-unknown-estimate');
  });

  it('refuses when no budget is set for the class', () => {
    const entry = plan({ tokens: [['docs-hygiene', [10_000]]] }).find(
      (item) => item.taskClass === 'docs-hygiene',
    );
    expect(entry?.decision).toBe('refused-no-budget');
    expect(entry?.reason).toContain('FACTORY_RECERTIFY_BUDGET_TOKENS=docs-hygiene=<tokens>');
  });

  it('refuses when the projection exceeds the class budget', () => {
    const entry = plan({
      tokens: [['docs-hygiene', [76_494]]],
      budgets: [['docs-hygiene', 100_000]],
      units: [['docs-hygiene', '/tmp/docs-hygiene.txt']],
    }).find((item) => item.taskClass === 'docs-hygiene');
    expect(entry?.decision).toBe('refused-over-budget');
    expect(entry?.reason).toContain('1453386 tokens exceeds the 100000-token budget');
  });

  it('refuses when a budget fits but no units file exists', () => {
    const entry = plan({
      tokens: [['stale-class', [1_000]]],
      budgets: [['stale-class', 1_000_000]],
      units: [['stale-class', null]],
    }).find((item) => item.taskClass === 'stale-class');
    expect(entry?.decision).toBe('refused-no-units');
  });

  it('says nothing would spend when every class is current', () => {
    const entries = planRecertification({
      classes: [{ taskClass: 'type-repair', state: 'current', samples: 20, m: 20 }],
      budgets: new Map(),
      tokensByTaskClass: new Map(),
      unitsFiles: new Map(),
    });
    expect(entries.map((entry) => entry.decision)).toEqual(['not-due']);
  });
});
