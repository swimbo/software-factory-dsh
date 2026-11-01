import { describe, expect, it } from 'vitest';

import {
  binomialCdfAtMost,
  certificationAlpha,
  certificationForClass,
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
