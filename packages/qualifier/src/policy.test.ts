/**
 * The policy contract: the shipped numbers, the frozen object, the version identity.
 *
 * The version is the load-bearing part. `LaneDecision.policy_version` is half of the
 * `(unit_id, policy_version)` key in the store, so if a rule change did not change the
 * version, a stale `dark` decision would be reused under new rules; and if the version
 * could change for a reason other than the rules (key order, insertion order), every
 * unit would re-score for no reason. Both directions are tested here.
 */
import { describe, expect, it } from 'vitest';
import { SIGNAL_NAMES, contentHash } from '@factory/contracts';
import {
  DEFAULT_POLICY,
  assertPolicy,
  currentPolicyVersion,
  legacyPolicyVersions,
  type QualifierPolicy,
} from './policy.ts';

const SHA256_PREFIXED = /^sha256:[0-9a-f]{64}$/;

function weightSum(policy: QualifierPolicy): number {
  return SIGNAL_NAMES.reduce((total, name) => total + policy.weights[name], 0);
}

describe('DEFAULT_POLICY', () => {
  it('carries the shipped thresholds', () => {
    expect(DEFAULT_POLICY.darkThreshold).toBe(90);
    expect(DEFAULT_POLICY.minSamples).toBe(10);
    expect(DEFAULT_POLICY.minPassRate).toBe(0.95);
    expect(DEFAULT_POLICY.maxEscapeRate).toBe(0.02);
    expect(DEFAULT_POLICY.maxLines).toBe(400);
    expect(DEFAULT_POLICY.maxFiles).toBe(25);
    expect(DEFAULT_POLICY.restateOverlapMin).toBe(0.5);
  });

  it('weights every signal exactly once and sums to 100', () => {
    expect(Object.keys(DEFAULT_POLICY.weights).sort()).toEqual([...SIGNAL_NAMES].sort());
    expect(weightSum(DEFAULT_POLICY)).toBe(100);
    for (const name of SIGNAL_NAMES) {
      expect(DEFAULT_POLICY.weights[name]).toBeGreaterThan(0);
      expect(DEFAULT_POLICY.weights[name]).toBeLessThanOrEqual(100);
    }
  });

  it('lets each rejecting signal outweigh the gap below the dark threshold', () => {
    // intent_derivability and observability are the two signals whose failure rejects.
    // If either weighed 10 or less, a rejected unit could score >= 90 and
    // `assertLaneIsDerived` would refuse the decision. This pins the arithmetic
    // argument made in `qualify.ts` to the actual numbers.
    const gap = 100 - DEFAULT_POLICY.darkThreshold;
    expect(DEFAULT_POLICY.weights.intent_derivability).toBeGreaterThan(gap);
    expect(DEFAULT_POLICY.weights.observability).toBeGreaterThan(gap);
  });

  it('is frozen, so no caller can retune the shipped rules at run time', () => {
    expect(Object.isFrozen(DEFAULT_POLICY)).toBe(true);
    expect(Object.isFrozen(DEFAULT_POLICY.weights)).toBe(true);

    const top = DEFAULT_POLICY as unknown as { darkThreshold: number };
    expect(() => {
      top.darkThreshold = 50;
    }).toThrow();

    const nested = DEFAULT_POLICY.weights as unknown as { size: number };
    expect(() => {
      nested.size = 99;
    }).toThrow();

    expect(DEFAULT_POLICY.darkThreshold).toBe(90);
    expect(DEFAULT_POLICY.weights.size).toBe(10);
  });
});

describe('assertPolicy', () => {
  it('accepts the shipped policy', () => {
    expect(() => assertPolicy(DEFAULT_POLICY)).not.toThrow();
  });

  it('rejects a weight outside 0..100', () => {
    expect(() =>
      assertPolicy({
        ...DEFAULT_POLICY,
        weights: { ...DEFAULT_POLICY.weights, size: -1, budget: 21 },
      }),
    ).toThrow(/weight size must be a number in \[0,100\]/);
  });

  it('rejects weights that do not sum to 100', () => {
    expect(() =>
      assertPolicy({ ...DEFAULT_POLICY, weights: { ...DEFAULT_POLICY.weights, size: 40 } }),
    ).toThrow(/sum to 100/);
  });

  it('rejects an unknown weight name, which would otherwise change the version without changing the rules', () => {
    const weights = {
      ...DEFAULT_POLICY.weights,
      size: 5,
      extra_signal: 5,
    } as unknown as QualifierPolicy['weights'];
    expect(() => assertPolicy({ ...DEFAULT_POLICY, weights })).toThrow(/unknown signal/);
  });

  it('rejects a threshold outside 0..100', () => {
    expect(() => assertPolicy({ ...DEFAULT_POLICY, darkThreshold: 101 })).toThrow(/darkThreshold/);
  });

  it('rejects non-integer counts', () => {
    expect(() => assertPolicy({ ...DEFAULT_POLICY, minSamples: 2.5 })).toThrow(/minSamples/);
    expect(() => assertPolicy({ ...DEFAULT_POLICY, maxLines: 0 })).toThrow(/maxLines/);
    expect(() => assertPolicy({ ...DEFAULT_POLICY, maxFiles: 1.5 })).toThrow(/maxFiles/);
  });

  it('rejects a rate outside 0..1', () => {
    expect(() => assertPolicy({ ...DEFAULT_POLICY, minPassRate: 1.5 })).toThrow(/minPassRate/);
    expect(() => assertPolicy({ ...DEFAULT_POLICY, maxEscapeRate: -0.1 })).toThrow(/maxEscapeRate/);
    expect(() => assertPolicy({ ...DEFAULT_POLICY, restateOverlapMin: 2 })).toThrow(
      /restateOverlapMin/,
    );
  });
});

describe('currentPolicyVersion', () => {
  it('is an algorithm-prefixed sha256 digest', () => {
    expect(currentPolicyVersion()).toMatch(SHA256_PREFIXED);
    expect(currentPolicyVersion(DEFAULT_POLICY)).toBe(currentPolicyVersion());
  });

  it('is stable across calls and independent of key order', () => {
    const reordered: QualifierPolicy = {
      weights: {
        budget: 10,
        size: 10,
        task_class_history: 10,
        observability: 20,
        reversibility: 20,
        intent_derivability: 30,
      },
      restateOverlapMin: 0.5,
      maxFiles: 25,
      maxLines: 400,
      maxEscapeRate: 0.02,
      minPassRate: 0.95,
      minSamples: 10,
      allowColdStart: false,
      privilegedBrokering: 'off',
      darkThreshold: 90,
    };
    // Same content, different literal order: the version must not move, or every
    // unit would re-score because someone reordered a file.
    expect(currentPolicyVersion(reordered)).toBe(currentPolicyVersion());
    expect(currentPolicyVersion(reordered)).toBe(currentPolicyVersion(reordered));
  });

  it.each([
    { label: 'darkThreshold', patch: { darkThreshold: 95 } },
    { label: 'minSamples', patch: { minSamples: 11 } },
    { label: 'minPassRate', patch: { minPassRate: 0.96 } },
    { label: 'maxEscapeRate', patch: { maxEscapeRate: 0.03 } },
    { label: 'maxLines', patch: { maxLines: 401 } },
    { label: 'maxFiles', patch: { maxFiles: 26 } },
    { label: 'restateOverlapMin', patch: { restateOverlapMin: 0.51 } },
  ])('changes when $label changes', ({ patch }) => {
    const changed: QualifierPolicy = { ...DEFAULT_POLICY, ...patch };
    expect(currentPolicyVersion(changed)).not.toBe(currentPolicyVersion());
  });

  it('changes when a weight moves between signals but the sum stays 100', () => {
    const moved: QualifierPolicy = {
      ...DEFAULT_POLICY,
      weights: { ...DEFAULT_POLICY.weights, size: 11, budget: 9 },
    };
    expect(weightSum(moved)).toBe(100);
    expect(currentPolicyVersion(moved)).not.toBe(currentPolicyVersion());
  });

  it('refuses to version an invalid policy', () => {
    expect(() => currentPolicyVersion({ ...DEFAULT_POLICY, darkThreshold: -1 })).toThrow();
  });
});

describe('dispatch ceilings are not policy (the pre-split recognition)', () => {
  // Defect A: the ceilings used to live on `QualifierPolicy`, so `currentPolicyVersion` moved
  // when an operator changed `FACTORY_MAX_CONCURRENT_ATTEMPTS` — a certificate minted under one
  // ceiling read as `stale` under the default, forever. The fields are gone now; `legacyPolicyVersions`
  // is the bridge that lets evidence recorded *before* the split keep comparing as "the same rules".

  const legacyDigest = (rules: QualifierPolicy, attempts: number, walls: number): string =>
    contentHash({ ...rules, maxConcurrentAttempts: attempts, maxConcurrentWalls: walls });

  it('recognises a pre-split digest of the same rules under a different ceiling', () => {
    // The exact case that broke: the loop ran at MAX_CONCURRENT_ATTEMPTS=4, walls=1.
    const recorded = legacyDigest(DEFAULT_POLICY, 4, 1);
    expect(recorded).not.toBe(currentPolicyVersion());
    expect(legacyPolicyVersions(DEFAULT_POLICY).has(recorded)).toBe(true);
  });

  it('does not recognise the new rules-only digest as a legacy alias', () => {
    expect(legacyPolicyVersions(DEFAULT_POLICY).has(currentPolicyVersion())).toBe(false);
  });

  it('does not recognise the digest of a different rule set', () => {
    const tightened: QualifierPolicy = { ...DEFAULT_POLICY, darkThreshold: 95 };
    const recorded = legacyDigest(tightened, 4, 1);
    expect(legacyPolicyVersions(tightened).has(recorded)).toBe(true);
    expect(legacyPolicyVersions(DEFAULT_POLICY).has(recorded)).toBe(false);
  });

  it('scans exactly the bounded ceiling range', () => {
    expect(legacyPolicyVersions(DEFAULT_POLICY, 3).size).toBe(9);
  });
});
