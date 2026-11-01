/**
 * The spend gate — human gate 2, and the only place a `-y` is answered with "no".
 *
 * Two rules live here, and both are structural rather than advisory:
 *
 * 1. **A raise is signed by a typed phrase, not by a keystroke.** `[y/N]` is the wrong
 *    cost for an irreversible authorisation: it lets an operator approve a number they
 *    did not read (`ux-plan.md` §3.6, §7.2). The phrase names the number — "raise
 *    per-unit envelope to 4.00" — so approving it means typing the amount. A mismatch
 *    refuses with `GATE_REQUIRED` and prints the phrase; nothing is partially applied.
 * 2. **No bypass flag exists on any gated verb.** `--yes`, `--force`, `-f` and friends
 *    are refused with a usage error (exit 2) before any parsing happens. The absence of
 *    a shortcut is a testable property, so it is tested (`assertNoBypassFlag`).
 *
 * Lowering an envelope is *not* a gate: tightening a ceiling cannot authorise anything.
 * It still needs a reason, because a ceiling change with no recorded reason is an
 * unauditable decision (`data-map.md` §2.21 keeps the row forever, with `raised_by`).
 */
import { FactoryError, contentHash } from '@factory/contracts';
import {
  GateUsageError,
  makeGateDecision,
  resolveNow,
  type GateDecisionResult,
} from './decision.ts';
import { keyId, verifyPayloadSignature } from './signing.ts';

/** `data-map.md` §2.21 `BudgetEnvelope.scope` — a ceiling applies to one unit, one day or one task class. */
export const ENVELOPE_SCOPES = ['unit', 'day', 'class'] as const;
export type EnvelopeScope = (typeof ENVELOPE_SCOPES)[number];

/**
 * Flags that would let an operator skip a gate. The list is closed on purpose: a new
 * convenience flag cannot be added to a gate without editing this constant, which is
 * the file an auditor reads.
 */
export const BYPASS_FLAGS = ['-y', '-f', '--yes', '--force', '--assume-yes'] as const;

/** Verbs that can encounter a human gate (`ux-plan.md` §5.2 `GATE_REQUIRED`). */
export const GATED_VERBS = ['promote', 'budget', 'credential'] as const;

export interface OperatorSignature {
  readonly signaturePem: string;
  /** The trusted operator key. The CLI loads this from operator config, never from argv. */
  readonly operatorPublicKeyPem: string;
}

export interface EnvelopeRaiseInput {
  readonly scope: EnvelopeScope;
  /** The unit id, `YYYY-MM-DD` or class key the ceiling applies to (`data-map.md` §2.21). */
  readonly scopeKey?: string;
  readonly fromUsd: number;
  readonly toUsd: number;
  /** Required for any change: an unauditable envelope change is not allowed. */
  readonly reason: string;
  /** What the operator actually typed. */
  readonly typedPhrase: string;
  /** What the gate printed and will accept. Use {@link envelopeRaisePhrase} to build it. */
  readonly expectedPhrase: string;
  /** Injected clock, for replay. Defaults to the wall clock. */
  readonly nowIso?: string;
  /** Optional ed25519 proof, for operators whose key is configured (`data-map.md` §2.21). */
  readonly signature?: OperatorSignature;
}

export interface EnvelopeDecision {
  /** The gate's own record: kind, outcome, reason, deterministic ids. */
  readonly decision: GateDecisionResult;
  readonly scope: EnvelopeScope;
  readonly scopeKey: string | null;
  readonly fromUsd: number;
  readonly toUsd: number;
  readonly reasonText: string;
  /** False for a lowering or a no-op: those are not human gates. */
  readonly gated: boolean;
  /** False for a no-op (`toUsd === fromUsd`). */
  readonly applied: boolean;
  /** `env_<hash[0:24]>`; deterministic, so a replayed raise cannot add a second row. */
  readonly envelopeId: string;
  readonly effectiveFrom: string;
  readonly confirmation: {
    readonly phrase: string;
    readonly confirmedAt: string;
    /** The verified ed25519 signature, or `null` when the operator key was not supplied. */
    readonly humanSignature: string | null;
    readonly humanKeyId: string | null;
  };
}

/** The phrase the gate prints and compares. One builder, so the CLI cannot drift from it. */
export function envelopeRaisePhrase(scope: EnvelopeScope, toUsd: number): string {
  const noun =
    scope === 'unit' ? 'per-unit envelope' : scope === 'day' ? 'daily envelope' : 'class envelope';
  return `raise ${noun} to ${toUsd.toFixed(2)}`;
}

/**
 * The exact bytes an optional ed25519 confirmation signs.
 *
 * Exported so the operator's tooling — and the gate's own error message — can name what
 * was signed. It is a hash, so the signed bytes are ASCII and platform-independent.
 */
export function envelopeRaiseSignaturePayload(input: {
  readonly scope: EnvelopeScope;
  readonly scopeKey: string | null;
  readonly fromUsd: number;
  readonly toUsd: number;
  readonly reason: string;
}): string {
  return contentHash({
    kind: 'budget-envelope-raise',
    scope: input.scope,
    scopeKey: input.scopeKey,
    fromUsd: input.fromUsd,
    toUsd: input.toUsd,
    reason: input.reason,
  });
}

function refuseGate(message: string, details: Record<string, unknown>): never {
  throw new FactoryError('GATE_REQUIRED', message, details);
}

function requireUsd(name: string, value: number): void {
  if (!Number.isFinite(value) || value < 0) {
    throw new GateUsageError(`${name} must be a finite amount >= 0 in USD, got ${String(value)}`);
  }
}

/**
 * Raise (or lower) a budget envelope.
 *
 * @throws GateUsageError (exit 2) for malformed input — an unknown scope, a negative
 * amount, a missing reason.
 * @throws FactoryError `GATE_REQUIRED` (exit 5) when the typed phrase does not match or
 * the supplied signature does not verify. Nothing is applied in that case.
 */
export function signEnvelopeRaise(input: EnvelopeRaiseInput): EnvelopeDecision {
  if (!ENVELOPE_SCOPES.includes(input.scope)) {
    throw new GateUsageError(
      `unknown envelope scope ${JSON.stringify(input.scope)}; expected one of ${ENVELOPE_SCOPES.join(', ')}`,
    );
  }
  requireUsd('fromUsd', input.fromUsd);
  requireUsd('toUsd', input.toUsd);
  if (input.reason.trim().length === 0) {
    throw new GateUsageError(
      'a budget envelope change needs a --reason; an unauditable ceiling change is refused',
    );
  }

  const scopeKey =
    input.scopeKey === undefined || input.scopeKey.trim().length === 0
      ? null
      : input.scopeKey.trim();
  const now = resolveNow(input.nowIso);
  const raising = input.toUsd > input.fromUsd;
  const lowering = input.toUsd < input.fromUsd;

  // Tightening a ceiling grants nothing, so there is no gate to close and no phrase to
  // type. The change is still recorded (the row keeps `raised_by` for the audit).
  if (!raising) {
    const envelopeId = envelopeIdOf(input, scopeKey);
    const decision = makeGateDecision({
      gateKind: 'budget',
      decision: 'allow',
      subject: `${input.scope}:${scopeKey ?? '*'}`,
      code: 'ALLOW',
      detail: lowering
        ? `envelope lowered $${input.fromUsd.toFixed(2)} -> $${input.toUsd.toFixed(2)} (not a gate)`
        : `envelope unchanged at $${input.fromUsd.toFixed(2)}`,
      matchedRule: lowering ? 'budget.envelope.lowering-is-not-a-gate' : 'budget.envelope.no-op',
    });
    return {
      decision,
      scope: input.scope,
      scopeKey,
      fromUsd: input.fromUsd,
      toUsd: input.toUsd,
      reasonText: input.reason,
      gated: false,
      applied: lowering,
      envelopeId,
      effectiveFrom: now,
      confirmation: {
        phrase: input.typedPhrase,
        confirmedAt: now,
        humanSignature: null,
        humanKeyId: null,
      },
    };
  }

  // A raise is a gate. The phrase must match exactly — no trim, no case folding: the
  // point is that the operator read and retyped the number.
  if (input.typedPhrase.trim().length === 0) {
    refuseGate(
      `GATE_REQUIRED: budget-envelope-raise. Sign by typing exactly: "${input.expectedPhrase}"`,
      {
        gate: 'budget-envelope-raise',
        reason: 'phrase-absent',
        expectedPhrase: input.expectedPhrase,
      },
    );
  }
  if (input.typedPhrase !== input.expectedPhrase) {
    refuseGate(
      `GATE_REQUIRED: budget-envelope-raise: phrase did not match; envelope unchanged ($${input.fromUsd.toFixed(2)}). Sign by typing exactly: "${input.expectedPhrase}"`,
      {
        gate: 'budget-envelope-raise',
        reason: 'phrase-mismatch',
        expectedPhrase: input.expectedPhrase,
        typedPhrase: input.typedPhrase,
      },
    );
  }

  // Optional proof of a person, when the operator key is configured. A signature that
  // is present but does not verify is a refusal: a bad signature must never be treated
  // as decoration on top of a phrase.
  let humanSignature: string | null = null;
  let humanKeyId: string | null = null;
  if (input.signature !== undefined) {
    const payload = envelopeRaiseSignaturePayload({
      scope: input.scope,
      scopeKey,
      fromUsd: input.fromUsd,
      toUsd: input.toUsd,
      reason: input.reason,
    });
    const verified = verifyPayloadSignature({
      payload,
      signaturePem: input.signature.signaturePem,
      publicKeyPem: input.signature.operatorPublicKeyPem,
    });
    if (!verified) {
      refuseGate(
        'GATE_REQUIRED: budget-envelope-raise: the supplied operator signature does not verify over the envelope change. Nothing was applied.',
        {
          gate: 'budget-envelope-raise',
          reason: 'signature-invalid',
          payload,
          expectedPhrase: input.expectedPhrase,
        },
      );
    }
    humanSignature = input.signature.signaturePem;
    humanKeyId = keyId(input.signature.operatorPublicKeyPem);
  }

  const envelopeId = envelopeIdOf(input, scopeKey);
  const decision = makeGateDecision({
    gateKind: 'budget',
    decision: 'allow',
    subject: `${input.scope}:${scopeKey ?? '*'}`,
    code: 'ALLOW',
    detail: `envelope raised $${input.fromUsd.toFixed(2)} -> $${input.toUsd.toFixed(2)} by typed phrase`,
    matchedRule:
      humanSignature === null
        ? 'budget.envelope.typed-phrase'
        : 'budget.envelope.typed-phrase+signature',
  });
  return {
    decision,
    scope: input.scope,
    scopeKey,
    fromUsd: input.fromUsd,
    toUsd: input.toUsd,
    reasonText: input.reason,
    gated: true,
    applied: true,
    envelopeId,
    effectiveFrom: now,
    confirmation: { phrase: input.expectedPhrase, confirmedAt: now, humanSignature, humanKeyId },
  };
}

/**
 * The new envelope's identity, derived from the change and not from the clock: replaying
 * the same raise must not create a second `BudgetEnvelope` row (`data-map.md` §2.21).
 */
function envelopeIdOf(input: EnvelopeRaiseInput, scopeKey: string | null): string {
  const hash = contentHash({
    kind: 'budget-envelope',
    scope: input.scope,
    scopeKey,
    fromUsd: input.fromUsd,
    toUsd: input.toUsd,
    reason: input.reason,
  });
  return `env_${hash.slice('sha256:'.length, 'sha256:'.length + 24)}`;
}

/** A bypass flag as written in `argv`, or `null`. Covers `-y`, `--yes=1` and `-fy` clusters. */
function bypassFlagOf(token: string): string | null {
  const bare = token.split('=')[0] ?? '';
  for (const flag of BYPASS_FLAGS) {
    if (bare === flag) return flag;
  }
  // A short cluster such as `-fy` smuggles the same permission past a naive check.
  if (/^-[a-zA-Z]{2,}$/.test(bare)) {
    const letters = bare.slice(1);
    if (letters.includes('y')) return '-y';
    if (letters.includes('f')) return '-f';
  }
  return null;
}

/**
 * Refuse a bypass flag on any invocation that names a gated verb.
 *
 * The rule is "an argv that names a gated verb is a gated invocation", which is
 * deliberately fail-closed: it holds whether the caller passes `['budget', 'raise', …]`,
 * `['factory', 'budget', …]` or a full `process.argv` slice. Verbs are matched exactly,
 * so a unit id that happens to contain the word `budget` does not make an invocation
 * gated.
 *
 * @throws GateUsageError (exit 2) naming the flag and the absence of any force path.
 */
export function assertNoBypassFlag(argv: readonly string[]): void {
  const namesGatedVerb = argv.some((token) => (GATED_VERBS as readonly string[]).includes(token));
  if (!namesGatedVerb) return;

  for (const token of argv) {
    const flag = bypassFlagOf(token);
    if (flag === null) continue;
    throw new GateUsageError(
      `usage: ${flag} is not accepted here. Human gates in this tool have no force path — answer the gate by typing the phrase it prints (see factory <verb> --help).`,
    );
  }
}
