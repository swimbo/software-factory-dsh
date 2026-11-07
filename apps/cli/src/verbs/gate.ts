/**
 * `factory gate` — request, record and read the human decision behind one privileged operation.
 *
 * The verb exists because the broker could only refuse. A refusal with no way to record the
 * decision that would change the answer is not a gate, it is a wall: the operator could read the
 * operation hash out of a log and there was still no command that turned "I approve this" into a
 * record the factory would accept.
 *
 * The tool *verifies* signatures and never holds a private key — `factory promote`'s rule, and the
 * reason `decide` takes a signature instead of minting one. The signing step is the operator's,
 * run wherever their private key already lives (see `docs/runbooks/rotate-operator-key.md`).
 *
 * Four actions, two of them read-only:
 *
 * | action    | writes | exit                                                         |
 * |-----------|--------|--------------------------------------------------------------|
 * | `request` | no     | 0 unprivileged or already covered · 5 privileged and undecided |
 * | `decide`  | yes    | 0 recorded · 2 usage · 5 the signature does not verify        |
 * | `list`    | no     | 0                                                             |
 * | `show`    | no     | 0 · 2 when no artifact carries that id                        |
 *
 * `--signature` names a file (or carries an armoured signature verbatim), the same contract
 * `factory promote` documents.
 */
import { existsSync, readFileSync } from 'node:fs';

import { contentHash, FactoryError } from '@factory/contracts';
import { keyId, verifyPayloadSignature } from '@factory/gates';
import {
  classify,
  decisionIdOf,
  decisionPayload,
  gatePhraseOf,
  liveDecisionFor,
  operationSha,
  toEvent,
} from '../../../../packages/proxy/src/index.ts';
import type { DecisionContent, PrivilegedDecision } from '../../../../packages/proxy/src/index.ts';
import { UsageError } from '../exit.ts';
import {
  activeOperatorKeys,
  addMs,
  DEFAULT_DECISION_TTL_MS,
  decisionFromArtifact,
  gateArtifactPath,
  gateDir,
  gatePhrase,
  gateTaskId,
  loadDecisions,
  operatorPublicKeyPems,
  parseDuration,
  writeDecisionArtifact,
} from '../gate.ts';
import type { Json, VerbInput, VerbSpec } from './types.ts';
import { textOption, requiredOption } from './types.ts';

const ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/u;

/** `--signature <path>` names a file; anything else is the armoured signature itself. */
function resolveSignature(value: string | undefined): string | undefined {
  if (value === undefined) return undefined;
  if (existsSync(value)) {
    try {
      const text = readFileSync(value, 'utf8').trim();
      if (text.length > 0) return text;
    } catch {
      return value;
    }
  }
  return value;
}

/**
 * The operation an argv resolves to, refusing the cases where "there is nothing to decide" and
 * "nobody can prove what will run" would otherwise be conflated.
 */
function operationFor(
  argv: readonly string[],
  input: VerbInput,
): {
  readonly classification: ReturnType<typeof classify>;
  readonly sha: string;
} {
  const classification = classify(argv, { home: input.ctx.home });
  if (classification.ambiguous) {
    throw new FactoryError(
      'GATE_REQUIRED',
      `GATE_REQUIRED: ${classification.detail}. An operation the classifier cannot resolve is one a ` +
        'person has to look at (L3); it cannot be decided by hash either.',
      { argv: [...argv] },
    );
  }
  return { classification, sha: operationSha(classification) };
}

function renderOperation(classification: ReturnType<typeof classify>): string {
  return classification.segments.map((segment) => segment.words.join(' ')).join(' && ');
}

function requestAction(input: VerbInput): number {
  const argv = input.args.slice(1);
  if (argv.length === 0) {
    throw new UsageError(
      'USAGE: factory gate request <argv…>. Example: factory gate request -- sudo ls /root',
    );
  }
  const { classification, sha } = operationFor(argv, input);
  const operation = renderOperation(classification);

  if (!classification.privileged) {
    input.emit({
      action: 'request',
      privileged: false,
      operation,
      operationSha: sha,
      covered: false,
      detail: classification.detail,
    });
    input.ctx.ui.err(`not privileged: ${operation}`);
    input.ctx.ui.err(
      `operationSha ${sha} — nothing to decide: the broker would allow this unbrokered`,
    );
    return 0;
  }

  const issuedAt = input.ctx.nowIso();
  const expiresAt = addMs(issuedAt, DEFAULT_DECISION_TTL_MS);
  const taskId = gateTaskId(sha);
  const phrase = gatePhrase(sha);
  const activeKeys = activeOperatorKeys(input.ctx.env, input.ctx.paths);
  const pems = operatorPublicKeyPems(input.ctx.env, input.ctx.paths);
  const firstKeyId = pems.length === 0 ? null : safeKeyId(pems[0] as string);

  // What the operator would be signing. `decide` rebuilds exactly this from `--issued-at` and
  // `--expires-in`, which is why the command below pins both instead of letting `decide` read the
  // clock again: a payload that includes timestamps cannot be signed in one process and verified in
  // another unless both agree on the timestamps.
  const content: DecisionContent = {
    taskId,
    operator: firstKeyId ?? 'ed25519:unknown',
    phrase,
    expiresAt,
    operationSha: sha,
    issuedAt,
    outcome: 'allow',
    keyId: firstKeyId ?? 'ed25519:unknown',
  };

  const covered = liveDecisionFor(argv, {
    home: input.ctx.home,
    nowIso: issuedAt,
    activeKeys,
    decisions: loadDecisions(input.ctx.home).decisions,
  });

  const payload = firstKeyId === null ? null : decisionPayload(content);
  const decideCommand =
    `factory gate decide --signature <file-with-your-signature> ` +
    `--expires-in 15m --issued-at ${issuedAt} --confirm "${phrase}" -- ${argv.join(' ')}`;

  input.emit({
    action: 'request',
    privileged: true,
    operation,
    operationSha: sha,
    taskId,
    phrase,
    issuedAt,
    expiresAt,
    operatorKeyId: firstKeyId,
    payload,
    decideCommand,
    covered: covered !== null,
    coveredBy: covered?.decisionId ?? null,
  });

  const ui = input.ctx.ui;
  ui.err(`operation  ${operation}`);
  ui.err(`operationSha ${sha}`);
  ui.err(
    `taskId     ${taskId}  (a label for reading; a standalone decision binds an operation, not a unit)`,
  );
  if (firstKeyId === null) {
    ui.err('');
    ui.err('operator key: NONE — a decision cannot be verified without one.');
    ui.err(
      `  place it at ${gateDir(input.ctx.home)}/../keys/operator.pub.pem or set FACTORY_OPERATOR_KEY to its path`,
    );
    return 5;
  }
  ui.err(`operator key ${firstKeyId}`);
  ui.err('');
  ui.err(
    'payload to sign (sha256 over the canonical content; the signature covers both timestamps):',
  );
  ui.err(`  ${String(payload)}`);
  ui.err('');
  if (covered !== null) {
    ui.err(
      `already covered by ${covered.decisionId} (expires ${covered.expiresAt}); nothing to decide.`,
    );
    return 0;
  }
  ui.err('no live decision covers this operation. Sign the payload above, then run:');
  ui.err(`  ${decideCommand}`);
  return 5;
}

function decideAction(input: VerbInput): number {
  const argv = input.args.slice(1);
  if (argv.length === 0) {
    throw new UsageError(
      'USAGE: factory gate decide --signature <path|literal> --confirm "decide <sha8>" <argv…>',
    );
  }
  const signatureValue = resolveSignature(textOption(input.options, 'signature'));
  if (signatureValue === undefined) {
    throw new UsageError(
      'USAGE: missing --signature. This tool verifies an operator signature; it never holds a private ' +
        'key, so it cannot make one. Sign the payload `factory gate request` prints, then pass it here.',
    );
  }
  const confirm = requiredOption(
    input.options,
    'confirm',
    'A decision needs the phrase typed on purpose; there is no -y.',
  );
  const issuedAtRaw = textOption(input.options, 'issuedAt') ?? input.ctx.nowIso();
  if (!ISO.test(issuedAtRaw)) {
    throw new UsageError(
      `USAGE: --issued-at must be an ISO-8601 UTC timestamp, got ${JSON.stringify(issuedAtRaw)}. ` +
        'Use the exact value `factory gate request` printed.',
    );
  }
  const expiresInRaw = textOption(input.options, 'expiresIn') ?? '15m';
  const ttlMs = parseDuration(expiresInRaw);
  if (ttlMs === null) {
    throw new UsageError(
      `USAGE: --expires-in expects a duration with a unit (15m, 30s, 2h, 500ms), got ` +
        `${JSON.stringify(expiresInRaw)}. A bare number would be a guess about which unit was meant, ` +
        'and this is not a place to guess.',
    );
  }

  const { classification, sha } = operationFor(argv, input);
  if (!classification.privileged) {
    throw new UsageError(
      `USAGE: ${renderOperation(classification)} is not a privileged operation, so there is nothing to ` +
        'decide. `factory gate request` prints the same classification without writing anything.',
    );
  }

  const phrase = gatePhrase(sha);
  if (confirm !== phrase) {
    throw new UsageError(
      `USAGE: --confirm must be exactly "${phrase}" for this operation. The phrase is derived from the ` +
        'operation hash, so a decision always names the operation it authorises and nothing else.',
    );
  }

  const pems = operatorPublicKeyPems(input.ctx.env, input.ctx.paths);
  if (pems.length === 0) {
    throw new FactoryError(
      'GATE_REQUIRED',
      'GATE_REQUIRED: no operator public key is configured, so the signature cannot be verified and ' +
        'nothing can be recorded. Place it at $FACTORY_HOME/keys/operator.pub.pem or set ' +
        'FACTORY_OPERATOR_KEY to its path.',
      { argv: [...argv] },
    );
  }
  const publicKeyPem = pems[0] as string;
  const operator = keyId(publicKeyPem);

  // `--signed-by` is an echo of the key, never a field of the signed content: `DecisionContent.operator`
  // is a key identity (`ed25519:ab02…`) precisely so that no narratable name enters a hash (L1).
  const signedBy = textOption(input.options, 'signedBy');
  if (signedBy !== undefined && signedBy !== operator) {
    throw new UsageError(
      `USAGE: --signed-by ${JSON.stringify(signedBy)} is not the signing key. The signer is the key ` +
        `${operator}, not a name: a name would be a string the worker could assert, and the record ` +
        'must not contain one. Pass the key id `factory gate request` printed, or omit --signed-by.',
    );
  }

  const expiresAt = addMs(issuedAtRaw, ttlMs);
  const content: DecisionContent = {
    taskId: gateTaskId(sha),
    operator,
    phrase,
    expiresAt,
    operationSha: sha,
    issuedAt: issuedAtRaw,
    outcome: 'allow',
    keyId: operator,
  };
  const payload = decisionPayload(content);
  const signature = signatureValue;
  if (!verifyPayloadSignature({ payload, signaturePem: signature, publicKeyPem })) {
    throw new FactoryError(
      'GATE_REQUIRED',
      `GATE_REQUIRED: the signature does not verify against ${operator} for payload ${payload}. ` +
        'Either it was made with a different key, or it covers a different payload — check that ' +
        '--issued-at and --expires-in reproduce the timestamps `factory gate request` printed.',
      { operationSha: sha, operatorKeyId: operator },
    );
  }

  const decision: PrivilegedDecision = { decisionId: decisionIdOf(content), ...content, signature };
  const artifactPath = gateArtifactPath(input.ctx.home, decision.decisionId);
  const already = existsSync(artifactPath);

  // Idempotent: the id is a function of the content, so the same signed envelope is the same
  // decision. Re-writing the artifact is harmless; appending a second `privileged.decided` event
  // for one decision would read as two decisions, so it is skipped.
  let eventSeq: number | null = null;
  if (!already) {
    writeDecisionArtifact(input.ctx.home, decision);
    const event = input.ctx.store.appendEvent(toEvent(decision), {
      actor: 'control',
      traceId: input.ctx.traceId,
      occurredAt: input.ctx.nowIso(),
    });
    eventSeq = event.seq;
  }

  input.emit({
    action: 'decide',
    decisionId: decision.decisionId,
    taskId: decision.taskId,
    operationSha: decision.operationSha,
    operator: decision.operator,
    expiresAt: decision.expiresAt,
    issuedAt: decision.issuedAt,
    artifactPath,
    eventSeq,
    alreadyRecorded: already,
  });

  const ui = input.ctx.ui;
  ui.err(`decision   ${decision.decisionId}`);
  ui.err(`operation  ${renderOperation(classification)}`);
  ui.err(`operationSha ${decision.operationSha}`);
  ui.err(`signed by  ${decision.operator}${signedBy === undefined ? '' : ` (as ${signedBy})`}`);
  ui.err(`live until ${decision.expiresAt} (issued ${decision.issuedAt})`);
  ui.err(`artifact   ${artifactPath}`);
  ui.err(
    already
      ? 'ledger     already recorded — the same signed envelope is the same decision, not a second one'
      : `ledger     privileged.decided seq ${String(eventSeq)}`,
  );
  ui.err('');
  ui.err('Next, one of:');
  ui.err(`  factory gate show ${decision.decisionId}`);
  ui.err(`  factory gate request -- ${argv.join(' ')}   # now reports "already covered"`);
  return 0;
}

function listAction(input: VerbInput): number {
  const loaded = loadDecisions(input.ctx.home);
  const activeKeys = activeOperatorKeys(input.ctx.env, input.ctx.paths);
  const nowIso = input.ctx.nowIso();
  const rows: Json[] = loaded.decisions.map((decision) => ({
    decisionId: decision.decisionId,
    taskId: decision.taskId,
    operator: decision.operator,
    operationSha: decision.operationSha,
    issuedAt: decision.issuedAt,
    expiresAt: decision.expiresAt,
    outcome: decision.outcome,
    keyActive: activeKeys.has(decision.keyId),
    expired: nowIso >= decision.expiresAt,
    consumed: input.ctx.store.isDecisionConsumed(decision.decisionId),
  }));
  input.emit({
    action: 'list',
    gatesDir: gateDir(input.ctx.home),
    decisions: rows,
    problems: loaded.problems,
  });

  const ui = input.ctx.ui;
  if (rows.length === 0) {
    ui.err(`no decisions under ${gateDir(input.ctx.home)}`);
  }
  for (const row of rows) {
    const state = row['consumed'] === true ? 'used' : row['expired'] === true ? 'expired' : 'live';
    ui.err(
      `${String(row['decisionId'])}  ${state}  ${String(row['operator'])}  until ${String(row['expiresAt'])}`,
    );
    ui.err(`  ${String(row['operationSha'])}`);
  }
  for (const problem of loaded.problems) {
    ui.err(`unreadable: ${problem.path}`);
    ui.err(`  ${problem.detail}`);
  }
  if (loaded.problems.length > 0) return 3;
  return 0;
}

function showAction(input: VerbInput): number {
  const decisionId = input.args[1];
  if (decisionId === undefined || decisionId.trim() === '') {
    throw new UsageError(
      'USAGE: factory gate show <decisionId>. `factory gate list` prints the ids.',
    );
  }
  const path = gateArtifactPath(input.ctx.home, decisionId);
  if (!existsSync(path)) {
    throw new UsageError(
      `USAGE: no decision artifact for ${JSON.stringify(decisionId)} (looked at ${path}). ` +
        '`factory gate list` prints the ids this factory holds.',
    );
  }
  let decision: PrivilegedDecision;
  try {
    decision = decisionFromArtifact(JSON.parse(readFileSync(path, 'utf8')));
  } catch (error) {
    throw new FactoryError(
      'SPEC_INVALID',
      `the artifact at ${path} is not a usable decision record: ${
        error instanceof Error ? error.message : String(error)
      }`,
      { decisionId },
    );
  }
  const activeKeys = activeOperatorKeys(input.ctx.env, input.ctx.paths);
  const nowIso = input.ctx.nowIso();
  const payload = decisionPayload(decision);
  const keyActive = activeKeys.has(decision.keyId);
  const publicKeyPem = activeKeys.get(decision.keyId);
  const signatureVerifies =
    publicKeyPem !== undefined &&
    decision.signature !== null &&
    verifyPayloadSignature({ payload, signaturePem: decision.signature, publicKeyPem });
  const consumed = input.ctx.store.isDecisionConsumed(decision.decisionId);
  const expired = nowIso >= decision.expiresAt;

  input.emit({
    action: 'show',
    decisionId: decision.decisionId,
    taskId: decision.taskId,
    operator: decision.operator,
    keyId: decision.keyId,
    keyActive,
    signatureVerifies,
    operationSha: decision.operationSha,
    phrase: decision.phrase,
    phraseSha: contentHash({ phrase: decision.phrase }),
    payload,
    issuedAt: decision.issuedAt,
    expiresAt: decision.expiresAt,
    outcome: decision.outcome,
    consumed,
    expired,
    artifactPath: path,
  });

  const ui = input.ctx.ui;
  ui.err(`decision   ${decision.decisionId}`);
  ui.err(`taskId     ${decision.taskId}`);
  ui.err(
    `operator   ${decision.operator} (${keyActive ? 'active' : 'NOT ACTIVE — retired or unknown'})`,
  );
  ui.err(`signature  ${signatureVerifies ? 'verifies' : 'DOES NOT VERIFY'}`);
  ui.err(`operationSha ${decision.operationSha}`);
  ui.err(`payload    ${payload}`);
  ui.err(`issued     ${decision.issuedAt}`);
  ui.err(`live until ${decision.expiresAt}${expired ? ' (EXPIRED)' : ''}`);
  ui.err(`consumed   ${consumed ? 'yes — a decision is not a session' : 'no'}`);
  ui.err(`artifact   ${path}`);
  return 0;
}

function safeKeyId(pem: string): string | null {
  try {
    return keyId(pem);
  } catch {
    return null;
  }
}

export const gateVerb: VerbSpec = {
  name: 'gate',
  verb: 'gate',
  summary: 'Request, record and read the human decision that authorises one privileged operation',
  arguments: ['<action>', '[argv...]'],
  configure: (command) => {
    command
      .option(
        '--signature <path|literal>',
        'the operator signature over the payload `request` printed',
      )
      .option(
        '--signed-by <id>',
        'echo of the signing key id; refused when it disagrees with the key',
      )
      .option('--expires-in <dur>', 'how long the decision stays live: 15m, 30s, 2h (default 15m)')
      .option('--issued-at <iso>', 'the exact issue time the payload was signed at')
      .option('--confirm <phrase>', 'the typed phrase: "decide <sha8>"');
  },
  action: (input) => {
    const action = (input.args[0] ?? '').trim();
    switch (action) {
      case 'request':
        return requestAction(input);
      case 'decide':
        return decideAction(input);
      case 'list':
        return listAction(input);
      case 'show':
        return showAction(input);
      default:
        throw new UsageError(
          `USAGE: factory gate <request|decide|list|show> <argv…>. Got ${JSON.stringify(action)}.`,
        );
    }
  },
};
