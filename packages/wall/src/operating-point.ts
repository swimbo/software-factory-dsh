/**
 * The certification operating point, and the α it publishes.
 *
 * Ratified decision ND1 (`docs/planning/dark-factory-dsh/findings.md` § DECIDED 2026-11-01):
 * one trial unit is a **task class**, not the factory and not the product; a class is certified at
 * **m = 20 attempts with k = 18 passes**; and the number published alongside that is
 *
 *     α = P(a class that truly passes p0 = 0.95 fails certification)
 *       = P(X ≤ k − 1) for X ~ Binomial(m, p0)
 *
 * α is computed here, exactly, rather than quoted from a table — a published probability that
 * nobody can reproduce is a number, not a measurement. The same arithmetic gives β(p), the power to
 * certify a class whose true pass rate is `p` (`certificationRisk` below); what it cannot give is the
 * probability that a wall refuses a *wrong* patch — that is a property of the corpus, counted rather
 * than computed in `e2e/certification/regressions.ts`. And α says nothing about production success,
 * because the trial population is this factory's task classes.
 */

export interface OperatingPoint {
  /** Attempts required before a class can be judged at all. */
  readonly m: number;
  /** Passes required among those attempts. */
  readonly k: number;
  /** The true pass rate the certification is calibrated against. */
  readonly p0: number;
}

export const DEFAULT_OPERATING_POINT: OperatingPoint = Object.freeze({
  m: 20,
  k: 18,
  p0: 0.95,
});

export type CertificationOutcome = 'certified' | 'not-certified' | 'insufficient';

export interface ClassCertification extends OperatingPoint {
  readonly outcome: CertificationOutcome;
  /** P(a class that truly passes p0 fails certification) — the published number. */
  readonly alpha: number;
  /** α as a decimal string exact to 20 places; below that resolution, `<1e-20` — never an untrue 0. */
  readonly alphaExact: string;
  readonly samples: number;
  readonly passes: number;
}

/** p as an exact `numerator/denominator` pair, from its shortest decimal representation. */
function toFraction(p: number): { readonly numerator: bigint; readonly denominator: bigint } {
  if (!Number.isFinite(p) || p < 0 || p > 1) {
    throw new RangeError(`p0 must be a probability in [0, 1], got ${String(p)}`);
  }
  const text = p.toString();
  const [whole = '0', fraction = ''] = text.split('.');
  const denominator = 10n ** BigInt(fraction.length);
  const numerator = BigInt(whole + fraction);
  return { numerator, denominator };
}

/** `n choose r`, exactly. */
function binomialCoefficient(n: number, r: number): bigint {
  let result = 1n;
  for (let i = 1; i <= r; i += 1) {
    result = (result * BigInt(n - r + i)) / BigInt(i);
  }
  return result;
}

const DECIMAL_PLACES = 20n;
const SCALE = 10n ** DECIMAL_PLACES;

/**
 * Render an exact rational `numerator/denominator` probability to twenty decimal places.
 *
 * `value` is the *truncated* decimal as a double; `exact` is its string. A probability that is
 * non-zero but below 10^-20 truncates to an all-zero decimal, and printing `0` there would be a
 * lie in a number someone quotes — so `exact` says `<1e-20` instead, and `value` stays 0 (the
 * decimal the printer can represent). `value: 0` is never a claim that the probability is zero;
 * only `exact: '0'` means zero.
 */
function formatRational(
  numerator: bigint,
  denominator: bigint,
): { readonly value: number; readonly exact: string } {
  if (numerator === 0n) return { value: 0, exact: '0' };
  if (numerator === denominator) return { value: 1, exact: '1' };
  const scaled = (numerator * SCALE) / denominator;
  if (scaled === 0n) return { value: 0, exact: '<1e-20' };
  const whole = scaled / SCALE;
  const fraction = (scaled % SCALE).toString().padStart(Number(DECIMAL_PLACES), '0');
  return {
    value: Number(whole) + Number(fraction) / Number(SCALE),
    exact: `${whole.toString()}.${fraction}`,
  };
}

/**
 * P(X ≤ atMost) for X ~ Binomial(trials, p), computed exactly in rational arithmetic and printed
 * to 20 decimal places. Exactness matters here: the published α is small (≈0.075), and a float
 * summation of twenty terms with a 0.05^k factor is the kind of number that silently drifts.
 */
export function binomialCdfAtMost(
  atMost: number,
  trials: number,
  p: number,
): { readonly value: number; readonly exact: string } {
  if (atMost < 0) return { value: 0, exact: '0' };
  if (atMost >= trials) return { value: 1, exact: '1' };
  const { numerator: pNum, denominator: pDen } = toFraction(p);
  const qNum = pDen - pNum;
  let totalNum = 0n;
  for (let i = 0; i <= atMost; i += 1) {
    totalNum += binomialCoefficient(trials, i) * pNum ** BigInt(i) * qNum ** BigInt(trials - i);
  }
  return formatRational(totalNum, pDen ** BigInt(trials));
}

/**
 * P(X ≥ atLeast) for X ~ Binomial(trials, p), the exact upper tail.
 *
 * The mirror of `binomialCdfAtMost` rather than its `1 −` complement, so the power a certificate
 * publishes is computed from the same rational machinery as the α it was calibrated against and
 * never through a floating-point subtraction of two twenty-term sums.
 */
export function binomialCdfAtLeast(
  atLeast: number,
  trials: number,
  p: number,
): { readonly value: number; readonly exact: string } {
  if (atLeast <= 0) return { value: 1, exact: '1' };
  if (atLeast > trials) return { value: 0, exact: '0' };
  const { numerator: pNum, denominator: pDen } = toFraction(p);
  const qNum = pDen - pNum;
  let totalNum = 0n;
  for (let i = atLeast; i <= trials; i += 1) {
    totalNum += binomialCoefficient(trials, i) * pNum ** BigInt(i) * qNum ** BigInt(trials - i);
  }
  return formatRational(totalNum, pDen ** BigInt(trials));
}

/** α for an operating point: the probability a class that truly passes p0 fails certification. */
export function certificationAlpha(point: OperatingPoint = DEFAULT_OPERATING_POINT): {
  readonly value: number;
  readonly exact: string;
} {
  const { value, exact } = binomialCdfAtMost(point.k - 1, point.m, point.p0);
  return { value, exact };
}

/** Refuse a point that cannot be a certification gate: `m ≥ 1`, `k ∈ [1, m]`, `p0 ∈ [0, 1]`. */
function assertPoint(point: OperatingPoint): void {
  if (!Number.isInteger(point.m) || point.m < 1)
    throw new RangeError('m must be a positive integer');
  if (!Number.isInteger(point.k) || point.k < 1 || point.k > point.m) {
    throw new RangeError('k must be an integer in [1, m]');
  }
  toFraction(point.p0); // throws unless p0 is a probability in [0, 1]
}

/**
 * The two-sided risk of one operating point, in closed form.
 *
 * Both α and β(p) are probabilities over the *attempts*, not over a corpus: with a fixed `m` and
 * `k`, a class whose true pass rate is `p` is certified iff at least `k` of its `m` attempts pass,
 * which is exactly `P(X ≥ k)` for `X ~ Binomial(m, p)`. So:
 *
 *   - `alpha` is `P(X ≤ k − 1)` at `p = p0` — the ratified α, reproduced here bit-for-bit;
 *   - `certifiedAt(p)` is `P(X ≥ k)` at `p` — β's *power* half (how often a class that truly
 *     passes at rate `p` is certified); it is non-decreasing in `p`;
 *   - `refusedAt(p)` is `P(X ≤ k − 1)` at `p` — the false-refusal risk; `refusedAt(p0) === alpha`.
 *
 * This is deliberately **not** β's other half — the probability that a wall whose visible check is
 * green but whose holdout rules are violated is refused. That quantity has no closed form: it is a
 * property of the corpus, measured as a detection *count* (see the certification regressions
 * fixture), never published as a rate.
 */
export interface CertificationRisk {
  readonly point: OperatingPoint;
  readonly alpha: number;
  readonly alphaExact: string;
  /** P(certified | true pass rate p) = P(X ≥ k), X ~ Binomial(m, p). Non-decreasing in p. */
  certifiedAt(p: number): { readonly value: number; readonly exact: string };
  /** P(refused | true pass rate p) = P(X ≤ k − 1). Non-increasing in p; equals α at p0. */
  refusedAt(p: number): { readonly value: number; readonly exact: string };
}

export function certificationRisk(
  point: OperatingPoint = DEFAULT_OPERATING_POINT,
): CertificationRisk {
  assertPoint(point);
  const { value: alpha, exact: alphaExact } = certificationAlpha(point);
  return {
    point,
    alpha,
    alphaExact,
    certifiedAt(p) {
      return binomialCdfAtLeast(point.k, point.m, p);
    },
    refusedAt(p) {
      return binomialCdfAtMost(point.k - 1, point.m, p);
    },
  };
}

/**
 * Certify one task class from its observed attempts.
 *
 * `insufficient` is not a soft yes: fewer than `m` attempts is *unknown*, and L3 says unknown never
 * satisfies a gate, so a caller that gates on certification must treat it as "ask a person".
 */
export function certificationForClass(input: {
  readonly samples: number;
  readonly passes: number;
  readonly m?: number;
  readonly k?: number;
  readonly p0?: number;
}): ClassCertification {
  const point: OperatingPoint = {
    m: input.m ?? DEFAULT_OPERATING_POINT.m,
    k: input.k ?? DEFAULT_OPERATING_POINT.k,
    p0: input.p0 ?? DEFAULT_OPERATING_POINT.p0,
  };
  assertPoint(point);
  if (!Number.isInteger(input.samples) || input.samples < 0) {
    throw new RangeError('samples must be a non-negative integer');
  }
  if (!Number.isInteger(input.passes) || input.passes < 0 || input.passes > input.samples) {
    throw new RangeError('passes must be an integer in [0, samples]');
  }
  const { value: alpha, exact: alphaExact } = certificationAlpha(point);
  const outcome: CertificationOutcome =
    input.samples < point.m
      ? 'insufficient'
      : input.passes >= point.k
        ? 'certified'
        : 'not-certified';
  return { ...point, outcome, alpha, alphaExact, samples: input.samples, passes: input.passes };
}
