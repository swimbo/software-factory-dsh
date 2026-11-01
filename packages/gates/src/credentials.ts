/**
 * The privileged-credential gate — human gate 3.
 *
 * The gate's *output* is a handle and an expiry. It never returns the secret, because a
 * gate that returned a secret would put it in a terminal, a log, `--json` and a shell
 * history all at once (`ux-plan.md` §3.10: "value not printed (by design)"). The broker
 * in `packages/proxy` mints the value and stores only its hash (`data-map.md` §2.23
 * `IssuedToken.token_hash`); this module decides *whether* such a grant may exist.
 *
 * Refusals are structural, not stylistic:
 *
 * - an unscoped repo (empty, `*`, or a comma list) — "unscoped privileged credentials do
 *   not exist in this system" (`ux-plan.md` §3.10, exit 3);
 * - a TTL outside `(0, 3600]` seconds — a credential that outlives its unit's attempt is
 *   a credential nobody is watching;
 * - a privileged class without the typed phrase — the one thing an operator must read
 *   before a worker receives an elevated capability.
 */
import { FactoryError } from '@factory/contracts';
import {
  GateUsageError,
  addSeconds,
  makeGateDecision,
  resolveNow,
  type GateDecisionResult,
} from './decision.ts';

/** One hour. `ux-plan.md` §3.10 (`--ttl ≤ 60m`); `data-map.md` §2.23 caps stored TTL at 2 h. */
export const MAX_CREDENTIAL_TTL_SECONDS = 3600;

export interface IssueCredentialInput {
  /** Exactly one repository slug. Multi-repo and wildcard scopes are refused, not parsed. */
  readonly repo: string;
  readonly ttlSeconds: number;
  /** Privileged classes require a typed phrase; unprivileged classes do not. */
  readonly privileged: boolean;
  /** What the operator typed. Ignored for unprivileged classes (there is no gate to close). */
  readonly typedPhrase: string;
  /** Optional subject for the `IssuedToken` row (`data-map.md` §2.23). */
  readonly unitId?: string;
  readonly attemptId?: string;
  /** Injected clock, for replay. Defaults to the wall clock. */
  readonly nowIso?: string;
}

/**
 * A grant handle. Note what is *not* here: no token, no secret, no hash of a secret —
 * `IssuedToken.token_hash` is written by the broker that mints the value, not by the gate
 * that authorises it.
 */
export interface CredentialGrant {
  /** `it_<hash[0:24]>`: the `IssuedToken.issued_token_id` this decision authorises. */
  readonly grantId: string;
  readonly issuedAt: string;
  readonly expiresAt: string;
  /** Single-repository scope, echoed so the caller cannot widen it later. */
  readonly scope: { readonly repo: string };
  readonly ttlSeconds: number;
  readonly privileged: boolean;
  readonly decision: GateDecisionResult;
  readonly gateDecisionId: string;
}

/** The phrase a privileged issuance prints and compares. One builder, so the CLI cannot drift. */
export function privilegedCredentialPhrase(repo: string): string {
  return `issue privileged credential for ${repo}`;
}

function isUnscoped(repo: string): boolean {
  const trimmed = repo.trim();
  return trimmed.length === 0 || trimmed === '*' || trimmed.includes(',') || /\s/.test(trimmed);
}

/**
 * Authorise a short-lived, single-repo credential.
 *
 * @throws GateUsageError (exit 2) for a non-integer TTL.
 * @throws FactoryError `SPEC_INVALID` (exit 3) for an unscoped repo or a TTL outside
 * `(0, 3600]` — the operator fixes the request and resubmits.
 * @throws FactoryError `GATE_REQUIRED` (exit 5) when a privileged class lacks the phrase.
 */
export function issueCredential(input: IssueCredentialInput): CredentialGrant {
  if (!Number.isInteger(input.ttlSeconds)) {
    throw new GateUsageError(
      `ttlSeconds must be an integer number of seconds, got ${String(input.ttlSeconds)}`,
    );
  }
  if (input.ttlSeconds <= 0 || input.ttlSeconds > MAX_CREDENTIAL_TTL_SECONDS) {
    throw new FactoryError(
      'SPEC_INVALID',
      `SPEC_INVALID: request must name --repo and --ttl ≤ ${String(MAX_CREDENTIAL_TTL_SECONDS / 60)}m; got ttl ${String(input.ttlSeconds)}s. Unscoped or long-lived credentials do not exist in this system.`,
      { field: 'ttlSeconds', got: input.ttlSeconds, max: MAX_CREDENTIAL_TTL_SECONDS },
    );
  }
  if (isUnscoped(input.repo)) {
    throw new FactoryError(
      'SPEC_INVALID',
      `SPEC_INVALID: request must name exactly one --repo; got ${JSON.stringify(input.repo)}. Unscoped credentials do not exist in this system.`,
      { field: 'repo', got: input.repo },
    );
  }

  const repo = input.repo.trim();

  if (input.privileged) {
    const expectedPhrase = privilegedCredentialPhrase(repo);
    if (input.typedPhrase !== expectedPhrase) {
      throw new FactoryError(
        'GATE_REQUIRED',
        `GATE_REQUIRED: privileged-credential-issuance. Sign by typing exactly: "${expectedPhrase}"`,
        {
          gate: 'privileged-credential-issuance',
          reason: input.typedPhrase.trim().length === 0 ? 'phrase-absent' : 'phrase-mismatch',
          expectedPhrase,
          repo,
          ttlSeconds: input.ttlSeconds,
        },
      );
    }
  }

  const issuedAt = resolveNow(input.nowIso);
  const expiresAt = addSeconds(issuedAt, input.ttlSeconds);
  // The identity is a hash of the grant, so a replayed request cannot mint a second
  // `IssuedToken` row for the same grant.
  const gate = makeGateDecision({
    gateKind: 'credential',
    decision: 'allow',
    subject: `repo:${repo}`,
    code: 'ALLOW',
    detail: `${input.privileged ? 'privileged' : 'unprivileged'} credential for repo:${repo} ttl=${String(input.ttlSeconds)}s expires ${expiresAt}`,
    matchedRule: input.privileged
      ? 'credential.privileged.typed-phrase'
      : 'credential.unprivileged.no-gate',
  });

  return {
    grantId: `it_${gate.decisionHash.slice('sha256:'.length, 'sha256:'.length + 24)}`,
    issuedAt,
    expiresAt,
    scope: { repo },
    ttlSeconds: input.ttlSeconds,
    privileged: input.privileged,
    decision: gate,
    gateDecisionId: gate.gateDecisionId,
  };
}
