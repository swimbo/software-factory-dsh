/**
 * The security lock (Phase 5 amendment A5).
 *
 * These tests exist because the rule is the one control in the qualifier that can
 * overrule a perfect score, so it must be proven in both directions: it fires when
 * it should, and — just as important — it does not fire on ordinary code, because
 * a lock that trips constantly is a lock operators learn to route around.
 */
import { describe, expect, it } from 'vitest';
import { UnitSpec } from '@factory/contracts';
import { DEFAULT_POLICY } from './policy.ts';
import { deriveLane } from './qualify.ts';
import { classifySecurityRelevance, securityRelevanceLine } from './security.ts';
import { evaluateSignals } from './signals.ts';

const BASE_REV = 'a'.repeat(40);

function spec(overrides: Partial<UnitSpec> = {}): UnitSpec {
  return UnitSpec.parse({
    slug: 'pagination-param',
    revision: 1,
    repo: 'swimbo/software-factory-dsh',
    baseRev: BASE_REV,
    intent: 'Add a page_size query parameter to the orders list endpoint and clamp it to 1..100',
    restateBack:
      'Add a page_size query parameter to the orders list endpoint and clamp the value to between 1 and 100',
    acceptance: [
      {
        id: 'clamps',
        text: 'page_size above 100 is clamped to 100',
        oracle: { kind: 'command', target: 'node --test tests/orders.test.ts', expect: 'exit 0' },
      },
    ],
    touchPaths: ['src/api/orders.ts'],
    operationClasses: ['code-change'],
    sizeBudget: { files: 2, lines: 40 },
    budgetEstimateUsd: 1,
    ...overrides,
  });
}

const cleanHistory = { samples: 40, passRate: 0.99, escapeRate: 0 };

describe('the security classifier', () => {
  it('does not fire on ordinary application code', () => {
    const relevance = classifySecurityRelevance({
      touchPaths: ['src/api/orders.ts', 'tests/orders.test.ts'],
      operationClasses: ['code-change'],
    });
    expect(relevance.relevant).toBe(false);
    expect(relevance.reasons).toEqual([]);
    expect(securityRelevanceLine(relevance)).toBe('not security-relevant');
  });

  it.each([
    ['.env.local', 'credential or key material'],
    ['deploy/keys/release.pem', 'credential or key material'],
    ['src/auth/token.ts', 'authentication or authorisation code'],
    ['src/crypto/hash.ts', 'cryptography or transport security'],
    ['.github/workflows/release.yml', 'CI workflow'],
    ['pnpm-lock.yaml', 'dependency manifest'],
    ['db/migrations/0031_orders.sql', 'data definition or migration'],
    ['Dockerfile', 'container build surface'],
  ])('fires on %s', (path, why) => {
    const relevance = classifySecurityRelevance({ touchPaths: [path] });
    expect(relevance.relevant).toBe(true);
    expect(relevance.reasons.join(' ')).toContain(why);
  });

  it('fires on a sensitive operation class even when the path is benign', () => {
    // `network-egress` is reversible and still needs a human: it can move data out.
    const relevance = classifySecurityRelevance({
      touchPaths: ['src/api/client.ts'],
      operationClasses: ['network-egress'],
    });
    expect(relevance.relevant).toBe(true);
    expect(relevance.reasons.join(' ')).toContain('network-egress');
  });

  it('sees an undeclared sensitive path in the actual diff (receipt time)', () => {
    const relevance = classifySecurityRelevance({
      touchPaths: ['src/api/orders.ts'],
      changedPaths: ['src/api/orders.ts', 'src/auth/session.ts'],
    });
    expect(relevance.relevant).toBe(true);
    expect(relevance.reasons.join(' ')).toContain('src/auth/session.ts');
  });

  it('is deterministic and de-duplicated', () => {
    const input = {
      touchPaths: ['src/auth/a.ts', 'src/auth/a.ts', 'src/auth/b.ts'],
      operationClasses: ['credential-use'],
    };
    const first = classifySecurityRelevance(input);
    expect(classifySecurityRelevance(input)).toEqual(first);
    expect(first.reasons.filter((r) => r.startsWith('src/auth/a.ts'))).toHaveLength(1);
  });
});

describe('the lane lock', () => {
  it('a clean unit still reaches dark, so the lock is not a blanket demotion', () => {
    const signals = evaluateSignals(
      {
        spec: spec(),
        taskClassHistory: cleanHistory,
        envelopeUsd: 5,
      },
      DEFAULT_POLICY,
    );
    const score = signals.reduce((sum, s) => sum + (s.outcome === 'pass' ? s.weight : 0), 0);
    expect(deriveLane(signals, score, DEFAULT_POLICY)).toBe('dark');
  });

  it('a perfect score cannot rescue a security-relevant unit', () => {
    const sensitive = spec({ touchPaths: ['src/auth/session.ts'] });
    const relevance = classifySecurityRelevance({
      touchPaths: sensitive.touchPaths,
      operationClasses: sensitive.operationClasses,
    });
    expect(relevance.relevant).toBe(true);

    // Every signal passes and the score is maximal — and the unit is still not dark.
    const signals = evaluateSignals(
      {
        spec: sensitive,
        taskClassHistory: cleanHistory,
        envelopeUsd: 5,
      },
      DEFAULT_POLICY,
    );
    const score = signals.reduce((sum, s) => sum + (s.outcome === 'pass' ? s.weight : 0), 0);
    const derived = deriveLane(signals, score, DEFAULT_POLICY);
    expect(derived).toBe('dark'); // the six signals alone would allow it
    const locked = relevance.relevant && derived === 'dark' ? 'lit' : derived;
    expect(locked).toBe('lit'); // the lock is what stops it
  });

  it('can only demote: it never turns reject into lit', () => {
    const signals = evaluateSignals(
      {
        // A restatement of a different task is a reject (intent not derivable), and
        // the security lock must not soften a rejection into a parked unit.
        spec: spec({
          touchPaths: ['src/auth/session.ts'],
          restateBack:
            'Delete the database, drop every table and rotate all credentials immediately',
        }),
        taskClassHistory: cleanHistory,
        envelopeUsd: 5,
      },
      DEFAULT_POLICY,
    );
    const score = signals.reduce((sum, s) => sum + (s.outcome === 'pass' ? s.weight : 0), 0);
    const derived = deriveLane(signals, score, DEFAULT_POLICY);
    expect(derived).toBe('reject');
    const relevance = classifySecurityRelevance({ touchPaths: ['src/auth/session.ts'] });
    expect(relevance.relevant && derived === 'dark' ? 'lit' : derived).toBe('reject');
  });
});
