import { describe, expect, it } from 'vitest';

import {
  binomialCdfAtLeast,
  binomialCdfAtMost,
  certificationAlpha,
  certificationForClass,
  certificationRisk,
  DEFAULT_OPERATING_POINT,
} from './operating-point.ts';

/**
 * The published α, derived independently of the implementation.
 *
 * α = P(X ≤ k − 1) for X ~ Binomial(m = 20, p0 = 0.95), i.e. the probability that a class which
 * truly passes 95 % of the time still fails to produce the 18 passes certification asks for.
 *
 *     α = Σ_{i=0}^{17} C(20, i) · 0.95^i · 0.05^(20 − i)
 *
 * Four terms carry almost all of it (0.95^17 = 0.418120, 0.05^3 = 1.25e-4, …):
 *
 *     i = 17: C(20,17) = 1140  → 1140 · 0.418120 · 1.25e-4  = 0.059582
 *     i = 16: C(20,16) = 4845  → 4845 · 0.440127 · 6.25e-6  = 0.013330
 *     i = 15: C(20,15) = 15504 → 15504 · 0.463291 · 3.125e-7 = 0.002246
 *     i = 14: C(20,14) = 38760 → 38760 · 0.487675 · 1.5625e-8 = 0.000295
 *     tail below i = 14:                                       ≈ 0.000031
 *
 *     α ≈ 0.075484
 *
 * The exact rational value is 0.07548367378849634297…, which is what `alphaExact` prints. The
 * second assertion below recomputes the same sum in floating point, from factorial-based binomial
 * coefficients written here rather than imported, so the two agree only if both are right.
 */
const EXPECTED_ALPHA_EXACT = '0.07548367378849634297';
const EXPECTED_ALPHA = 0.07548367378849634;

function choose(n: number, r: number): number {
  let out = 1;
  for (let i = 0; i < r; i += 1) out = (out * (n - i)) / (i + 1);
  return out;
}

function alphaFromScratch(): number {
  let total = 0;
  for (let failures = 0; failures <= 17; failures += 1) {
    total += choose(20, failures) * 0.95 ** failures * 0.05 ** (20 - failures);
  }
  return total;
}

describe('the certification operating point', () => {
  it('[the published α is 0.07548367378849634, computed exactly]', () => {
    const alpha = certificationAlpha();
    expect(alpha.exact).toBe(EXPECTED_ALPHA_EXACT);
    expect(alpha.value).toBe(EXPECTED_ALPHA);
    // Independent recomputation: factorial-free coefficients, plain float summation.
    expect(Math.abs(alphaFromScratch() - alpha.value)).toBeLessThan(1e-12);
  });

  it('[m = 20, k = 18, p0 = 0.95 are the ratified defaults and are published with the result]', () => {
    expect(DEFAULT_OPERATING_POINT).toStrictEqual({ m: 20, k: 18, p0: 0.95 });
    const cert = certificationForClass({ samples: 20, passes: 18 });
    expect(cert.m).toBe(20);
    expect(cert.k).toBe(18);
    expect(cert.p0).toBe(0.95);
    expect(cert.alpha).toBe(EXPECTED_ALPHA);
    expect(cert.alphaExact).toBe(EXPECTED_ALPHA_EXACT);
  });

  it('[a class at 18 of 20 certifies]', () => {
    const cert = certificationForClass({ samples: 20, passes: 18 });
    expect(cert.outcome).toBe('certified');
  });

  it('[a class at 17 of 20 does not certify, and says not-certified — not insufficient]', () => {
    const cert = certificationForClass({ samples: 20, passes: 17 });
    expect(cert.outcome).toBe('not-certified');
  });

  it('[3 of 20 is insufficient: unknown is not probably fine]', () => {
    const cert = certificationForClass({ samples: 3, passes: 3 });
    expect(cert.outcome).toBe('insufficient');
    expect(cert.outcome).not.toBe('certified');
  });

  it('[a passing 6 of 6 does NOT certify — the m = 6 default this replaced would have]', () => {
    const cert = certificationForClass({ samples: 6, passes: 6 });
    expect(cert.outcome).toBe('insufficient');
    // The old operating point (m = 6, k = 6) certifies this same evidence, which is exactly why
    // it was replaced: α there is 1 − 0.95^6 = 0.2649, so a fluke class certifies one time in four.
    expect(certificationForClass({ samples: 6, passes: 6, m: 6, k: 6 }).outcome).toBe('certified');
  });

  it('[α is a property of the operating point, so it is identical for every class and every sample count]', () => {
    const a = certificationForClass({ samples: 3, passes: 0 });
    const b = certificationForClass({ samples: 40, passes: 40 });
    expect(a.alpha).toBe(b.alpha);
    // And it is not the pass rate: 0.95 (the calibrated truth) is not 0.0755 (the false-refusal risk).
    expect(a.alpha).not.toBe(DEFAULT_OPERATING_POINT.p0);
  });

  it('[the exact CDF agrees with the float CDF at the boundary and refuses nonsense]', () => {
    expect(binomialCdfAtMost(20, 20, 0.95).value).toBe(1);
    expect(binomialCdfAtMost(-1, 20, 0.95).value).toBe(0);
    expect(() => certificationForClass({ samples: 3, passes: 4 })).toThrow(/passes/u);
    expect(() => certificationForClass({ samples: -1, passes: 0 })).toThrow(/samples/u);
    expect(() => certificationForClass({ samples: 20, passes: 18, m: 10, k: 11 })).toThrow(
      /k must/u,
    );
  });
});

/**
 * The two-sided risk the certificate can now state, instead of "β is not measured".
 *
 * With `m` and `k` fixed, a class whose true pass rate is `p` is certified iff at least `k` of its
 * `m` attempts pass — exactly `P(X ≥ k)` for `X ~ Binomial(m, p)`. That is β's *power* half, and it
 * is closed-form arithmetic: no corpus, no spend. β's other half (does the wall refuse a candidate
 * that is actually wrong) is a corpus property, measured as a detection count by the certification
 * regressions fixture, not published here as a rate.
 *
 * `certifiedAt(p)` and `refusedAt(p)` are each truncated to 20 places independently, so the two
 * tails can differ from `1` in the last printed digit; the exact relations asserted below are the
 * ones that carry meaning — `refusedAt(p0) === alpha`, and the float tails sum to `1`.
 */
describe('the two-sided risk of the operating point', () => {
  it('[β reproduces the ratified α at p = p0: refusedAt(p0) is the published α]', () => {
    const risk = certificationRisk();
    expect(risk.alphaExact).toBe(EXPECTED_ALPHA_EXACT);
    expect(risk.alpha).toBe(EXPECTED_ALPHA);
    expect(risk.refusedAt(DEFAULT_OPERATING_POINT.p0).exact).toBe(EXPECTED_ALPHA_EXACT);
    // The certified tail is the complement of α, within one printed digit.
    expect(
      Math.abs(risk.certifiedAt(DEFAULT_OPERATING_POINT.p0).value - (1 - EXPECTED_ALPHA)),
    ).toBeLessThan(1e-16);
  });

  it('[certifiedAt(p) is non-decreasing and refusedAt(p) non-increasing in p]', () => {
    const risk = certificationRisk();
    const ps = [0.8, 0.85, 0.9, 0.93, 0.95, 0.97];
    for (let i = 1; i < ps.length; i += 1) {
      const p = ps[i];
      const prev = ps[i - 1];
      if (p === undefined || prev === undefined) throw new Error('unreachable');
      expect(risk.certifiedAt(p).value).toBeGreaterThan(risk.certifiedAt(prev).value);
      expect(risk.refusedAt(p).value).toBeLessThan(risk.refusedAt(prev).value);
    }
  });

  it('[the endpoints are exact: a class that never passes is never certified, one that always passes is always certified]', () => {
    const risk = certificationRisk();
    expect(risk.certifiedAt(1)).toEqual({ value: 1, exact: '1' });
    expect(risk.refusedAt(1)).toEqual({ value: 0, exact: '0' });
    expect(risk.certifiedAt(0)).toEqual({ value: 0, exact: '0' });
    expect(risk.refusedAt(0)).toEqual({ value: 1, exact: '1' });
  });

  it('[k = m does NOT yield α = 0 — requiring a perfect corpus raises false refusals to 0.64]', () => {
    // The surprise the runbook table must not carry by assumption. α is about a class that *truly*
    // passes p0, not one that *observed* m passes: a truly-95% class fails at least one of twenty
    // attempts 64% of the time, so "all 20 must pass" is a stricter filter, not a zero-risk one.
    // α = 0 at k = m only in the degenerate p0 = 1 limit.
    const perfect = certificationRisk({ m: 20, k: 20, p0: 0.95 });
    expect(perfect.alphaExact).toBe('0.64151407759145776564');
    // Independent recomputation: α = 1 − P(all 20 pass) = 1 − 0.95^20.
    expect(perfect.alpha).toBeCloseTo(1 - 0.95 ** 20, 12);
    expect(certificationRisk({ m: 20, k: 20, p0: 1 }).alpha).toBe(0);
  });

  it('[k = 0 is refused: a gate that requires no passes certifies everything, so it is not a gate]', () => {
    expect(() => certificationRisk({ m: 20, k: 0, p0: 0.95 })).toThrow(/k must/u);
    expect(() => certificationRisk({ m: 20, k: 21, p0: 0.95 })).toThrow(/k must/u);
    expect(() => certificationRisk({ m: 20, k: 18, p0: 1.5 })).toThrow(/p0 must/u);
  });

  it('[a probability below the 20-place printer is printed <1e-20, never as 0]', () => {
    const permissive = certificationRisk({ m: 20, k: 1, p0: 0.95 });
    // α = P(0 of 20 pass | truly 0.95) = 0.05^20 ≈ 9.5e-27, below the printer's resolution.
    expect(permissive.alphaExact).toBe('<1e-20');
    expect(permissive.alpha).toBe(0); // the decimal the printer can represent
    expect(0.05 ** 20).toBeGreaterThan(0); // …but it is not zero, and the string says so
  });

  it('[the upper tail is the exact complement of the lower tail, not a float subtraction]', () => {
    expect(binomialCdfAtLeast(0, 20, 0.95)).toEqual({ value: 1, exact: '1' });
    expect(binomialCdfAtLeast(21, 20, 0.95)).toEqual({ value: 0, exact: '0' });
    for (const p of [0.8, 0.9, 0.95, 0.97]) {
      const lower = binomialCdfAtMost(17, 20, p);
      const upper = binomialCdfAtLeast(18, 20, p);
      expect(Math.abs(lower.value + upper.value - 1)).toBeLessThan(1e-16);
    }
  });

  it('[the 2026-11-07 ruling holds: dropping k makes the gate MORE permissive at the alternative]', () => {
    // The round list that prompted the ruling assumed 17/16 would be *stricter* than 18. They are the
    // opposite: k is the minimum passes required, so a lower k is an easier bar, and α (the risk of
    // refusing a truly-0.95 class) falls precisely because the bar is easier. What grows is the
    // chance a worse class is certified anyway — the number that was never published. k=18 was kept
    // because it is the least permissive of the three, and this spec is what keeps that claim from
    // drifting if someone "tightens" α later.
    const accept90 = (k: number): string =>
      certificationRisk({ m: 20, k, p0: 0.95 }).certifiedAt(0.9).exact;
    expect(accept90(16)).toBe('0.95682550471553661876');
    expect(accept90(17)).toBe('0.86704667656566492231');
    expect(accept90(18)).toBe('0.67692680518946603571');
    // Direction, not just the three constants: lowering k raises the acceptance probability.
    expect(Number(accept90(17))).toBeGreaterThan(Number(accept90(18)));
    expect(Number(accept90(16))).toBeGreaterThan(Number(accept90(17)));
    // And α falls as k falls, which is what made the permissive reading tempting.
    expect(certificationRisk({ m: 20, k: 17, p0: 0.95 }).alpha).toBeLessThan(
      certificationRisk({ m: 20, k: 18, p0: 0.95 }).alpha,
    );
  });

  it('[the six-row β table the runbook quotes is this function output, digit for digit]', () => {
    const risk = certificationRisk();
    // Re-generate: `node --input-type=module -e "…"` — the runbook table is a paste of this, and
    // this test turns "re-typed by hand" into "asserted".
    const rows: readonly { p: number; certified: string; refused: string }[] = [
      { p: 0.8, certified: '0.20608471894847389696', refused: '0.79391528105152610304' },
      { p: 0.85, certified: '0.40489627800743543384', refused: '0.59510372199256456615' },
      { p: 0.9, certified: '0.67692680518946603571', refused: '0.32307319481053396429' },
      { p: 0.93, certified: '0.83899711726135142049', refused: '0.16100288273864857950' },
      { p: 0.95, certified: '0.92451632621150365702', refused: '0.07548367378849634297' },
      { p: 0.97, certified: '0.97899164362165711488', refused: '0.02100835637834288511' },
    ];
    for (const row of rows) {
      expect(risk.certifiedAt(row.p).exact).toBe(row.certified);
      expect(risk.refusedAt(row.p).exact).toBe(row.refused);
    }
  });
});
