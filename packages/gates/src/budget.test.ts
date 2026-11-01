/**
 * The budget gate: a typed phrase, and no flag that replaces it.
 *
 * The interesting assertions are the negative ones. A gate that accepts `--yes` is a gate
 * that does not exist, so `assertNoBypassFlag` is tested against every flag shape —
 * including the `--flag=value` form and the `-fy` short cluster — and against the
 * non-gated verb it must *not* block.
 */
import { describe, expect, it } from 'vitest';
import { FactoryError, isFactoryError } from '@factory/contracts';
import {
  BYPASS_FLAGS,
  GATED_VERBS,
  assertNoBypassFlag,
  envelopeRaisePhrase,
  envelopeRaiseSignaturePayload,
  signEnvelopeRaise,
  type EnvelopeRaiseInput,
} from './budget.ts';
import { GateUsageError } from './decision.ts';
import { signPayload } from './signing.ts';
import { IMPOSTOR, OPERATOR } from '../test-support/keys.ts';

const NOW = '2026-11-01T14:00:00.000Z';

function raise(overrides: Partial<EnvelopeRaiseInput> = {}): EnvelopeRaiseInput {
  const toUsd = overrides.toUsd ?? 4;
  return {
    scope: 'unit',
    scopeKey: 'U-7f3a9c',
    fromUsd: 2,
    toUsd,
    reason: 'U-7f3a9c needs a second verification pass',
    typedPhrase: envelopeRaisePhrase('unit', toUsd),
    expectedPhrase: envelopeRaisePhrase('unit', toUsd),
    nowIso: NOW,
    ...overrides,
  };
}

function gateRefusal(run: () => unknown): FactoryError {
  try {
    run();
  } catch (error) {
    if (isFactoryError(error)) return error;
    throw error;
  }
  throw new Error('expected a FactoryError, but the call returned normally');
}

describe('signEnvelopeRaise — a raise is a gate', () => {
  it('applies a raise signed with the exact phrase', () => {
    const decision = signEnvelopeRaise(raise());

    expect(decision.applied).toBe(true);
    expect(decision.gated).toBe(true);
    expect(decision.decision.decision).toBe('allow');
    expect(decision.decision.reason.code).toBe('ALLOW');
    expect(decision.decision.reason.matchedRule).toBe('budget.envelope.typed-phrase');
    expect(decision.envelopeId).toMatch(/^env_[0-9a-f]{24}$/);
    expect(decision.decision.gateDecisionId).toMatch(/^gd_[0-9a-f]{24}$/);
    expect(decision.effectiveFrom).toBe(NOW);
    expect(decision.confirmation.phrase).toBe('raise per-unit envelope to 4.00');
    expect(decision.confirmation.confirmedAt).toBe(NOW);
    expect(decision.confirmation.humanSignature).toBeNull();
  });

  it('refuses a phrase that does not match, printing the phrase it will accept', () => {
    const error = gateRefusal(() =>
      signEnvelopeRaise(raise({ typedPhrase: 'raise per-unit envelope to 40.00' })),
    );

    expect(error.code).toBe('GATE_REQUIRED');
    expect(error.exitCode).toBe(5);
    expect(error.details.reason).toBe('phrase-mismatch');
    expect(error.details.expectedPhrase).toBe('raise per-unit envelope to 4.00');
    expect(error.message).toContain('raise per-unit envelope to 4.00');
    // The state is untouched: the message must say so, because the operator's next question
    // is always "did it half-apply?".
    expect(error.message).toContain('envelope unchanged');
  });

  it('refuses an empty phrase as an unanswered gate', () => {
    const error = gateRefusal(() => signEnvelopeRaise(raise({ typedPhrase: '' })));
    expect(error.code).toBe('GATE_REQUIRED');
    expect(error.details.reason).toBe('phrase-absent');
  });

  it('is exact: a near-miss, extra whitespace or different case is a refusal', () => {
    for (const typed of [
      'raise per-unit envelope to 4.0',
      'Raise per-unit envelope to 4.00',
      'raise per-unit envelope to 4.00 ',
    ]) {
      const error = gateRefusal(() => signEnvelopeRaise(raise({ typedPhrase: typed })));
      expect(error.code).toBe('GATE_REQUIRED');
    }
  });

  it('prints the same phrase for each scope, naming the ceiling it changes', () => {
    expect(envelopeRaisePhrase('unit', 4)).toBe('raise per-unit envelope to 4.00');
    expect(envelopeRaisePhrase('day', 20)).toBe('raise daily envelope to 20.00');
    expect(envelopeRaisePhrase('class', 1.5)).toBe('raise class envelope to 1.50');
  });

  it('verifies an optional ed25519 confirmation, and refuses one that does not verify', () => {
    const unsigned = raise();
    const payload = envelopeRaiseSignaturePayload({
      scope: unsigned.scope,
      scopeKey: 'U-7f3a9c',
      fromUsd: unsigned.fromUsd,
      toUsd: unsigned.toUsd,
      reason: unsigned.reason,
    });

    const good = signEnvelopeRaise(
      raise({
        signature: {
          signaturePem: signPayload(payload, OPERATOR.privateKeyPem),
          operatorPublicKeyPem: OPERATOR.publicKeyPem,
        },
      }),
    );
    expect(good.confirmation.humanSignature).not.toBeNull();
    expect(good.confirmation.humanKeyId).toMatch(/^ed25519:[0-9a-f]{8}$/);
    expect(good.decision.reason.matchedRule).toBe('budget.envelope.typed-phrase+signature');

    const error = gateRefusal(() =>
      signEnvelopeRaise(
        raise({
          signature: {
            signaturePem: signPayload(payload, IMPOSTOR.privateKeyPem),
            operatorPublicKeyPem: OPERATOR.publicKeyPem,
          },
        }),
      ),
    );
    expect(error.code).toBe('GATE_REQUIRED');
    expect(error.details.reason).toBe('signature-invalid');
  });
});

describe('signEnvelopeRaise — tightening is not a gate', () => {
  it('applies a lowering without a phrase, because it grants nothing', () => {
    const decision = signEnvelopeRaise(
      raise({ fromUsd: 4, toUsd: 2, typedPhrase: '', expectedPhrase: '' }),
    );

    expect(decision.gated).toBe(false);
    expect(decision.applied).toBe(true);
    expect(decision.decision.decision).toBe('allow');
    expect(decision.decision.reason.matchedRule).toBe('budget.envelope.lowering-is-not-a-gate');
  });

  it('treats an unchanged envelope as a no-op, not a gate', () => {
    const decision = signEnvelopeRaise(raise({ fromUsd: 2, toUsd: 2, typedPhrase: '' }));
    expect(decision.gated).toBe(false);
    expect(decision.applied).toBe(false);
    expect(decision.decision.reason.matchedRule).toBe('budget.envelope.no-op');
  });
});

describe('signEnvelopeRaise — malformed input is a usage error, not a gate', () => {
  it('needs a reason', () => {
    expect(() => signEnvelopeRaise(raise({ reason: '   ' }))).toThrow(GateUsageError);
  });

  it('refuses an unknown scope', () => {
    expect(() =>
      signEnvelopeRaise(raise({ scope: 'galaxy' as unknown as EnvelopeRaiseInput['scope'] })),
    ).toThrow(GateUsageError);
  });

  it('refuses a negative or non-finite amount', () => {
    expect(() => signEnvelopeRaise(raise({ fromUsd: -1 }))).toThrow(GateUsageError);
    expect(() => signEnvelopeRaise(raise({ toUsd: Number.NaN }))).toThrow(GateUsageError);
  });

  it('refuses a malformed injected timestamp', () => {
    expect(() => signEnvelopeRaise(raise({ nowIso: 'four o’clock' }))).toThrow(GateUsageError);
  });
});

describe('signEnvelopeRaise — determinism', () => {
  it('derives the same envelope id and decision hash for a replayed raise', () => {
    const first = signEnvelopeRaise(raise());
    const second = signEnvelopeRaise(raise());

    expect(second.envelopeId).toBe(first.envelopeId);
    expect(second.decision.decisionHash).toBe(first.decision.decisionHash);
    expect(second.decision.gateDecisionId).toBe(first.decision.gateDecisionId);
  });

  it('derives a different envelope id when the amount differs', () => {
    const small = signEnvelopeRaise(raise({ toUsd: 3 }));
    const large = signEnvelopeRaise(raise({ toUsd: 6 }));
    expect(large.envelopeId).not.toBe(small.envelopeId);
  });
});

describe('assertNoBypassFlag', () => {
  it.each([...BYPASS_FLAGS])('refuses %s on every gated verb', (flag) => {
    for (const verb of GATED_VERBS) {
      let thrown: unknown;
      try {
        assertNoBypassFlag([verb, 'run', flag]);
      } catch (error) {
        thrown = error;
      }
      expect(thrown).toBeInstanceOf(GateUsageError);
      const usage = thrown as GateUsageError;
      expect(usage.exitCode).toBe(2);
      expect(usage.code).toBe('USAGE');
      expect(usage.message).toContain(flag);
      expect(usage.message).toContain('no force path');
    }
  });

  it.each(['--yes=1', '--force=true', '--assume-yes=1', '-fy', '-yf'])(
    'refuses the disguised form %s',
    (token) => {
      expect(() => assertNoBypassFlag(['budget', 'raise', token])).toThrow(GateUsageError);
    },
  );

  it('accepts an argv that names no gated verb', () => {
    expect(() => assertNoBypassFlag(['status', '--yes'])).not.toThrow();
    expect(() => assertNoBypassFlag(['run', 'U-7f3a9c', '--force'])).not.toThrow();
    expect(() => assertNoBypassFlag(['--yes'])).not.toThrow();
    // Exact verb matching: a unit id that contains the word is not a verb.
    expect(() => assertNoBypassFlag(['status', 'unit-budget-7', '--yes'])).not.toThrow();
  });

  it('accepts a clean gated invocation, including the phrase argument', () => {
    expect(() =>
      assertNoBypassFlag([
        'budget',
        'raise',
        '--to',
        '4.00',
        '--reason',
        'why',
        '--confirm',
        'raise per-unit envelope to 4.00',
      ]),
    ).not.toThrow();
  });

  it('is not a FactoryError, because no error code maps to exit 2', () => {
    try {
      assertNoBypassFlag(['promote', 'U-7f3a9c', '--yes']);
      throw new Error('expected a refusal');
    } catch (error) {
      expect(isFactoryError(error)).toBe(false);
      expect((error as GateUsageError).exitCode).toBe(2);
    }
  });
});
