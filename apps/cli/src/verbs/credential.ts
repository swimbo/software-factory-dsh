/**
 * `factory credential` — human gate 3 (privileged issuance) and revocation.
 *
 * The gate's *output* is a token id and an expiry. The secret value is never
 * echoed, never logged and never in `--json` (`ux-plan.md` §3.10): the credential
 * proxy holds it, the worker container gets an opaque proxy token, and this
 * terminal does not see it. That is a property of the return type, not of the
 * print statement — `CredentialGrant` has no field a secret could hide in.
 *
 * Unscoped requests are refused structurally (exit 3): `--repo` is required and
 * `--ttl` is capped at one hour.
 */
import { FactoryError } from '@factory/contracts';
import {
  issueCredential,
  MAX_CREDENTIAL_TTL_SECONDS,
  privilegedCredentialPhrase,
} from '@factory/gates';

import { UsageError } from '../exit.ts';
import { field } from '../render/format.ts';
import { renderCredentialGate } from '../render/gate.ts';
import { textOption, type VerbInput, type VerbSpec } from './types.ts';

/** `15m`, `90s`, `1h` — a duration the operator can type without arithmetic. */
export function parseTtlSeconds(raw: string | undefined): number {
  if (raw === undefined) {
    throw new UsageError(
      `USAGE: --ttl is required and must be <= ${MAX_CREDENTIAL_TTL_SECONDS / 60}m; unscoped privileged credentials do not exist in this system.`,
    );
  }
  const match = /^(\d+)(s|m|h)$/u.exec(raw.trim());
  if (match === null) {
    throw new UsageError(`USAGE: --ttl expects <n>s, <n>m or <n>h; got ${JSON.stringify(raw)}`);
  }
  const amount = Number(match[1]);
  const unit = match[2];
  const seconds = unit === 's' ? amount : unit === 'm' ? amount * 60 : amount * 3600;
  if (!Number.isInteger(seconds) || seconds <= 0) {
    throw new UsageError(
      `USAGE: --ttl must be a positive whole number of seconds; got ${JSON.stringify(raw)}`,
    );
  }
  return seconds;
}

export function runCredentialRequest(input: VerbInput): number {
  const { ctx } = input;
  const credentialClass = (textOption(input.options, 'class') ?? 'privileged').trim();
  const privileged = credentialClass === 'privileged';
  if (credentialClass !== 'privileged' && credentialClass !== 'standard') {
    throw new UsageError(
      `USAGE: --class expects privileged or standard; got ${JSON.stringify(credentialClass)}`,
    );
  }
  const repo = textOption(input.options, 'repo');
  if (repo === undefined || repo.trim().length === 0) {
    // Exit 3, not 2: the shape is wrong *and* the policy refuses an unscoped
    // grant. §3.10 gives this refusal to `SPEC_INVALID` because there is nothing
    // to retry — the request has to name a repository.
    throw new FactoryError(
      'SPEC_INVALID',
      'SPEC_INVALID: a credential request must name --repo; unscoped privileged credentials do not exist in this system.',
      { credentialClass },
    );
  }
  const ttlSeconds = parseTtlSeconds(textOption(input.options, 'ttl'));
  if (ttlSeconds > MAX_CREDENTIAL_TTL_SECONDS) {
    // Exit 3, not 2: the request is well-formed but the factory refuses the scope.
    throw new FactoryError(
      'SPEC_INVALID',
      `SPEC_INVALID: ttl ${ttlSeconds}s exceeds the ${MAX_CREDENTIAL_TTL_SECONDS}s ceiling; unscoped privileged credentials do not exist in this system.`,
      { repo, ttlSeconds },
    );
  }
  const phrase = privilegedCredentialPhrase(repo);
  const reason = textOption(input.options, 'reason') ?? 'unspecified';
  const typed = textOption(input.options, 'confirm');

  if (privileged && typed !== phrase) {
    const gateBlock = renderCredentialGate({ repo, ttlSeconds, phrase, reason });
    for (const line of gateBlock.trimEnd().split('\n')) ctx.ui.err(line);
    throw new FactoryError(
      'GATE_REQUIRED',
      `GATE_REQUIRED: privileged-credential-issuance. ${
        typed === undefined ? 'No phrase was typed' : 'The phrase did not match'
      }; nothing was issued. Sign by typing exactly: "${phrase}" (non-interactive: --confirm "${phrase}")`,
      { gate: 'privileged-credential-issuance', repo, expectedPhrase: phrase },
    );
  }

  const grant = issueCredential({
    repo,
    ttlSeconds,
    privileged,
    typedPhrase: typed ?? '',
    nowIso: ctx.nowIso(),
  });

  ctx.store.insertCredential({
    grantId: grant.grantId,
    repo: grant.scope.repo,
    ttlSeconds: grant.ttlSeconds,
    issuedBy: 'operator',
    issuedAt: grant.issuedAt,
    expiresAt: grant.expiresAt,
  });

  input.emit({
    grantId: grant.grantId,
    scope: { repo: grant.scope.repo },
    ttlSeconds: grant.ttlSeconds,
    privileged: grant.privileged,
    issuedAt: grant.issuedAt,
    expiresAt: grant.expiresAt,
    gateDecisionId: grant.gateDecisionId,
    reason,
    secret: null,
    traceId: ctx.traceId,
  });

  ctx.ui.err(
    `IssuedToken ${grant.grantId} ${'·'} expires ${grant.expiresAt} ${'·'} value not printed (by design)`,
  );
  ctx.ui.err(
    field('  scope', `repo:${grant.scope.repo}  ttl ${Math.round(grant.ttlSeconds / 60)}m`),
  );
  ctx.ui.err(field('  revoke', `factory credential revoke ${grant.grantId}`));
  return 0;
}

export function runCredentialRevoke(input: VerbInput): number {
  const { ctx } = input;
  // `args[0]` is the action (`revoke`); the id is the second positional.
  const grantId = input.args[1];
  if (grantId === undefined || grantId.trim().length === 0) {
    throw new UsageError('USAGE: factory credential revoke <grantId>');
  }
  try {
    ctx.store.revokeCredential(grantId.trim(), ctx.nowIso());
  } catch (error) {
    // The store raises `INTERNAL` for an id that names nothing. For an operator a
    // typo is not an internal failure: it is a refusal they can fix by re-reading
    // the id, so it exits 3. (The contract has no `CREDENTIAL_NOT_FOUND` code —
    // reported to the Lead.)
    if (error instanceof FactoryError && error.code === 'INTERNAL') {
      throw new FactoryError(
        'SPEC_INVALID',
        `SPEC_INVALID: no credential ${grantId.trim()} exists; nothing was revoked. ` +
          'Check the id against: factory audit --last 50',
        { grantId: grantId.trim() },
      );
    }
    throw error;
  }
  input.emit({ grantId: grantId.trim(), revokedAt: ctx.nowIso(), traceId: ctx.traceId });
  ctx.ui.err(`REVOKED  ${grantId.trim()}  at ${ctx.nowIso()}`);
  return 0;
}

export const credentialVerb: VerbSpec = {
  name: 'credential',
  verb: 'credential',
  summary:
    'Request a short-lived, single-repo credential (privileged needs a typed phrase) or revoke one',
  arguments: ['[action]', '[grantId]'],
  configure: (command) =>
    command
      .option('--class <class>', 'privileged (default) or standard')
      .option('--repo <repo>', 'the single repository this credential is scoped to (required)')
      .option('--ttl <duration>', 'e.g. 15m; capped at 60m')
      .option('--reason <text>', 'why the credential is needed (recorded forever)')
      .option(
        '--confirm <phrase>',
        'the typed phrase, exactly: issue privileged credential for <repo>',
      ),
  action: (input) => {
    const action = (input.args[0] ?? 'request').trim();
    if (action === 'request' || action === 'issue') return runCredentialRequest(input);
    if (action === 'revoke') return runCredentialRevoke(input);
    throw new UsageError(
      `USAGE: factory credential <request|revoke>; got ${JSON.stringify(action)}`,
    );
  },
};
