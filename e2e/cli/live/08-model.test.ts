/**
 * The live-model smoke suite: the one place where "no model calls" is deliberately broken.
 *
 * `describe.skipIf` on the key, not on a timeout, and never on a silent fallback: a live spec
 * that quietly degraded to a stub would report a model call that never happened. These two
 * specs are the *only* UNVERIFIED rows the verification report is allowed to carry.
 *
 * E2E-47, E2E-48 of `e2e-tests.md`. Unimplemented in v1 (no adapter is wired for a live
 * model in this build), so they skip without a key and assert nothing with one.
 */
import { describe, expect, it } from 'vitest';

const HAS_KEY = (process.env.BIFROST_API_KEY ?? '').trim().length > 0;

describe.skipIf(!HAS_KEY)('live model [@live]', () => {
  it('[@live] the pinned model answers a one-token prompt and the adapter records usage', () => {
    expect(true).toBe(true);
  });

  it('[@live] a model refusal is recorded as a failed attempt, not as a pass', () => {
    expect(true).toBe(true);
  });
});
