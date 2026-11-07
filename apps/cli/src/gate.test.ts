/**
 * `factory gate`: the verb that turns "I approve this" into a record the broker accepts.
 *
 * The properties worth pinning, in the order they matter:
 *
 * 1. **The tool cannot sign.** `decide` takes a signature and refuses without one; there is no
 *    flag, key or environment variable here that mints it. A gate the tool can complete on its
 *    own is not a gate.
 * 2. **A refusal writes nothing.** Not a draft artifact, not a ledger event: the specs assert the
 *    filesystem and the event count, not the message.
 * 3. **The timestamps are inside the signed payload**, so the payload `request` prints must be the
 *    payload `decide` reconstructs. Signing at T and minting at T+1s fails closed — the copy-the-
 *    command-an-hour-later case is a refusal, not a decision that quietly re-dates itself.
 * 4. **The read-only actions are read-only.** `request`, `list` and `show` never move the ledger.
 *
 * The signature is made here with the same library function an operator would use (`signPayload`
 * from `@factory/gates`) — the CLI never sees a private key, which is exactly the point.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { generateKeyPairSync } from 'node:crypto';
import { describe, expect, it } from 'vitest';

import { openStore } from '@factory/store';
import { signPayload } from '@factory/gates';
import { EXIT } from './exit.ts';
import { jsonOf, runCli, tempHome, type CliResult } from './testing.ts';

const PRIVILEGED_ARGV = ['cp', '/etc/hosts', '/dev/null'];
const UNPRIVILEGED_ARGV = ['node', '--test', 'tests/'];

/** Publish an operator public key the way a real operator does, and keep the private half here. */
function publishKey(home: string): { readonly privatePem: string } {
  const keys = join(home, 'keys');
  mkdirSync(keys, { recursive: true });
  const pair = generateKeyPairSync('ed25519', {
    privateKeyEncoding: { format: 'pem', type: 'pkcs8' },
    publicKeyEncoding: { format: 'pem', type: 'spki' },
  });
  writeFileSync(join(keys, 'operator.pub.pem'), pair.publicKey);
  return { privatePem: pair.privateKey };
}

function gate(args: readonly string[], home: string): CliResult {
  return runCli(['gate', ...args], { home });
}

/**
 * `--json` must sit *before* the `--` separator, or it becomes part of the operation argv — which
 * is the same trap an operator hits at the shell, so the helper is where it gets handled once.
 */
function gateJson(args: readonly string[], home: string): Record<string, unknown> {
  const [action, ...rest] = args;
  return jsonOf(gate([action ?? '', '--json', ...rest], home));
}

/** What an operator would sign: the payload string `request` printed. */
function request(home: string): Record<string, unknown> {
  return gateJson(['request', '--', ...PRIVILEGED_ARGV], home);
}

function eventTypes(home: string): readonly string[] {
  const store = openStore({ dir: join(home, 'state') });
  try {
    return store.eventsSince(0).map((event) => event.type);
  } finally {
    store.close();
  }
}

describe('gate request: read-only, and the payload is the decision', () => {
  it('prints the operation, the payload, and a decide command that pins both timestamps', () => {
    const home = tempHome();
    publishKey(home);

    const result = gate(['request', '--json', '--', ...PRIVILEGED_ARGV], home);
    const json = jsonOf(result);

    // Exit 5 is the point of the verb: the operation is privileged and nobody has decided yet.
    expect(result.status).toBe(EXIT.gate);
    expect(result.stderr).toContain('no live decision covers this operation');

    expect(json['privileged']).toBe(true);
    expect(json['operation']).toBe('cp /etc/hosts /dev/null');
    expect(json['operationSha']).toMatch(/^sha256:[0-9a-f]{64}$/u);
    expect(json['payload']).toMatch(/^sha256:[0-9a-f]{64}$/u);
    expect(json['taskId']).toBe(`gate:${String(json['operationSha']).slice(7, 15)}`);
    expect(json['phrase']).toBe(`decide ${String(json['operationSha']).slice(7, 15)}`);

    // The printed command must be enough on its own: a payload that hashes both timestamps is
    // unreproducible unless the caller is told which timestamps were hashed.
    const command = String(json['decideCommand']);
    expect(command).toContain(`--issued-at ${String(json['issuedAt'])}`);
    expect(command).toContain('--expires-in 15m');
    expect(command).toContain(`--confirm "${String(json['phrase'])}"`);
    expect(command).toContain('-- cp /etc/hosts /dev/null');
  });

  it('writes nothing at all: no artifact, no ledger event, no gates directory', () => {
    const home = tempHome();
    publishKey(home);

    expect(request(home)).toBeDefined();

    expect(existsSync(join(home, 'gates'))).toBe(false);
    expect(eventTypes(home)).toEqual([]);
  });

  it('exits 0 for an unprivileged argv and says there is nothing to decide', () => {
    const home = tempHome();
    publishKey(home);

    const result = gate(['request', '--json', '--', ...UNPRIVILEGED_ARGV], home);
    const json = jsonOf(result);

    expect(result.status).toBe(EXIT.ok);
    expect(json['privileged']).toBe(false);
    expect(existsSync(join(home, 'gates'))).toBe(false);
    expect(eventTypes(home)).toEqual([]);
  });

  it('exits 5 when no operator key is published, because nothing could be verified', () => {
    const home = tempHome();

    const result = gate(['request', '--json', '--', ...PRIVILEGED_ARGV], home);

    expect(result.status).toBe(EXIT.gate);
    expect(result.stderr).toContain('operator key: NONE');
  });
});

describe('gate decide: verify, never sign', () => {
  /** One `decide` invocation, so every refusal spec below differs only in its input. */
  function decideWith(
    home: string,
    envelope: {
      readonly signaturePath: string;
      readonly issuedAt: string;
      readonly phrase: string;
      readonly extra?: readonly string[];
    },
  ): CliResult {
    return gate(
      [
        'decide',
        '--signature',
        envelope.signaturePath,
        '--issued-at',
        envelope.issuedAt,
        ...(envelope.extra ?? []),
        '--confirm',
        envelope.phrase,
        '--json',
        '--',
        ...PRIVILEGED_ARGV,
      ],
      home,
    );
  }

  /** The happy path, spelled once so the refusal specs below are the only variation. */
  function mint(
    home: string,
    privatePem: string,
    overrides: { issuedAt?: string; expiresIn?: string; confirm?: string } = {},
  ): { payload: string; issuedAt: string; phrase: string; result: CliResult } {
    const requested = request(home);
    const payload = String(requested['payload']);
    const issuedAt = overrides.issuedAt ?? String(requested['issuedAt']);
    const phrase = overrides.confirm ?? String(requested['phrase']);
    const signaturePath = join(home, 'decision.sig');
    writeFileSync(signaturePath, signPayload(payload, privatePem));
    const result = decideWith(home, {
      signaturePath,
      issuedAt,
      phrase,
      ...(overrides.expiresIn === undefined
        ? {}
        : { extra: ['--expires-in', overrides.expiresIn] }),
    });
    return { payload, issuedAt, phrase, result };
  }

  it('records a signed decision as an artifact and exactly one ledger event', () => {
    const home = tempHome();
    const { privatePem } = publishKey(home);

    const { result } = mint(home, privatePem);
    const json = jsonOf(result);

    expect(result.status, result.stderr).toBe(EXIT.ok);
    expect(json['decisionId']).toMatch(/^gd_[0-9a-f]{24}$/u);
    expect(json['alreadyRecorded']).toBe(false);
    expect(json['eventSeq']).toBe(1);

    const artifactPath = join(home, 'gates', `${String(json['decisionId'])}.json`);
    expect(existsSync(artifactPath)).toBe(true);
    const artifact = JSON.parse(readFileSync(artifactPath, 'utf8')) as Record<string, unknown>;
    expect(artifact['decisionId']).toBe(json['decisionId']);
    expect(artifact['operationSha']).toBe(json['operationSha']);
    // The artifact deliberately carries no phrase — only its hash — so the phrase is not a
    // secret the next reader inherits.
    expect(artifact['phrase']).toBeUndefined();
    expect(artifact['phraseSha']).toMatch(/^sha256:[0-9a-f]{64}$/u);

    expect(eventTypes(home)).toEqual(['privileged.decided']);
  });

  it('re-running the same signed envelope appends no second event', () => {
    const home = tempHome();
    const { privatePem } = publishKey(home);
    // Minted once, then replayed verbatim: a second `request` would carry a new `issuedAt` and be
    // a *different* decision, which would prove nothing about idempotency.
    const first = mint(home, privatePem);
    expect(first.result.status).toBe(EXIT.ok);
    const again = {
      result: decideWith(home, {
        signaturePath: join(home, 'decision.sig'),
        issuedAt: first.issuedAt,
        phrase: first.phrase,
      }),
    };

    expect(again.result.status).toBe(EXIT.ok);
    // The id is a function of the content: the same signed envelope is the same decision, so a
    // second event for it would read as a second decision in the audit.
    expect(jsonOf(again.result)['alreadyRecorded']).toBe(true);
    expect(jsonOf(again.result)['eventSeq']).toBeNull();
    expect(eventTypes(home)).toEqual(['privileged.decided']);
  });

  it('fails closed when the payload is signed at T and minted at T+1s', () => {
    // The copy-the-command-an-hour-later case. Both timestamps are inside the signed payload, so
    // re-dating the decision invalidates the signature — and the tool must say so rather than
    // quietly re-hash with a fresh clock.
    const home = tempHome();
    const { privatePem } = publishKey(home);
    const requested = request(home);
    const issuedAt = String(requested['issuedAt']);
    const signaturePath = join(home, 'decision.sig');
    writeFileSync(signaturePath, signPayload(String(requested['payload']), privatePem));
    const oneSecondLater = new Date(Date.parse(issuedAt) + 1_000).toISOString();

    const result = gate(
      [
        'decide',
        '--signature',
        signaturePath,
        '--issued-at',
        oneSecondLater,
        '--confirm',
        String(requested['phrase']),
        '--json',
        '--',
        ...PRIVILEGED_ARGV,
      ],
      home,
    );

    expect(result.status).toBe(EXIT.gate);
    expect(result.stderr).toContain('does not verify');
    expect(result.stderr).toContain('--issued-at');
    // Nothing was written: a refused decision is not a draft.
    expect(existsSync(join(home, 'gates'))).toBe(false);
    expect(eventTypes(home)).toEqual([]);
  });

  it('refuses a signature over a different payload with exit 5 and writes nothing', () => {
    const home = tempHome();
    const { privatePem } = publishKey(home);
    const requested = request(home);
    const signaturePath = join(home, 'decision.sig');
    writeFileSync(signaturePath, signPayload(`sha256:${'0'.repeat(64)}`, privatePem));

    const result = gate(
      [
        'decide',
        '--signature',
        signaturePath,
        '--issued-at',
        String(requested['issuedAt']),
        '--confirm',
        String(requested['phrase']),
        '--json',
        '--',
        ...PRIVILEGED_ARGV,
      ],
      home,
    );

    expect(result.status).toBe(EXIT.gate);
    expect(result.stderr).toContain('does not verify');
    expect(existsSync(join(home, 'gates'))).toBe(false);
    expect(eventTypes(home)).toEqual([]);
  });

  it('refuses with exit 5 when the key is published but retired between request and decide', () => {
    const home = tempHome();
    const { privatePem } = publishKey(home);
    const requested = request(home);
    const retired = generateKeyPairSync('ed25519', {
      privateKeyEncoding: { format: 'pem', type: 'pkcs8' },
      publicKeyEncoding: { format: 'pem', type: 'spki' },
    });
    writeFileSync(join(home, 'keys', 'operator.pub.pem'), retired.publicKey);
    const signaturePath = join(home, 'decision.sig');
    writeFileSync(signaturePath, signPayload(String(requested['payload']), privatePem));

    const result = gate(
      [
        'decide',
        '--signature',
        signaturePath,
        '--issued-at',
        String(requested['issuedAt']),
        '--confirm',
        String(requested['phrase']),
        '--json',
        '--',
        ...PRIVILEGED_ARGV,
      ],
      home,
    );

    expect(result.status).toBe(EXIT.gate);
    expect(result.stderr).toContain('does not verify');
    expect(eventTypes(home)).toEqual([]);
  });

  it('refuses an invocation with no --signature: there is nothing to verify', () => {
    const home = tempHome();
    publishKey(home);

    const result = gate(
      [
        'decide',
        '--issued-at',
        '2026-11-01T12:00:00.000Z',
        '--confirm',
        'decide deadbeef',
        '--',
        ...PRIVILEGED_ARGV,
      ],
      home,
    );

    expect(result.status).toBe(EXIT.usage);
    expect(result.stderr).toContain('never holds a private key');
  });

  it('refuses a malformed --expires-in instead of guessing the unit', () => {
    const home = tempHome();
    const { privatePem } = publishKey(home);

    const { result } = mint(home, privatePem, { expiresIn: '15' });

    expect(result.status).toBe(EXIT.usage);
    expect(result.stderr).toContain('duration with a unit');
    expect(existsSync(join(home, 'gates'))).toBe(false);
  });

  it('refuses a malformed --issued-at instead of reading the clock instead', () => {
    const home = tempHome();
    const { privatePem } = publishKey(home);

    const { result } = mint(home, privatePem, { issuedAt: '12:00' });

    expect(result.status).toBe(EXIT.usage);
    expect(result.stderr).toContain('ISO-8601');
  });

  it('refuses the wrong typed phrase with exit 2 and names the phrase that works', () => {
    const home = tempHome();
    const { privatePem } = publishKey(home);

    const { result } = mint(home, privatePem, { confirm: 'decide yes' });

    expect(result.status).toBe(EXIT.usage);
    expect(result.stderr).toContain('--confirm must be exactly');
    expect(existsSync(join(home, 'gates'))).toBe(false);
  });

  it('refuses a --signed-by that names something other than the key', () => {
    const home = tempHome();
    const { privatePem } = publishKey(home);
    const requested = request(home);
    const signaturePath = join(home, 'decision.sig');
    writeFileSync(signaturePath, signPayload(String(requested['payload']), privatePem));

    const result = gate(
      [
        'decide',
        '--signature',
        signaturePath,
        '--issued-at',
        String(requested['issuedAt']),
        '--signed-by',
        'alice',
        '--confirm',
        String(requested['phrase']),
        '--json',
        '--',
        ...PRIVILEGED_ARGV,
      ],
      home,
    );

    // A name is a string the worker could assert; the record names the key instead (L1).
    expect(result.status).toBe(EXIT.usage);
    expect(result.stderr).toContain('is not the signing key');
    expect(result.stderr).toMatch(/The signer is the key/u);
  });

  it('accepts --signed-by when it echoes the signing key id, and never hashes the name', () => {
    const home = tempHome();
    const { privatePem } = publishKey(home);
    const requested = request(home);
    const keyIdValue = String(requested['operatorKeyId']);
    const signaturePath = join(home, 'decision.sig');
    writeFileSync(signaturePath, signPayload(String(requested['payload']), privatePem));

    const result = gate(
      [
        'decide',
        '--signature',
        signaturePath,
        '--issued-at',
        String(requested['issuedAt']),
        '--signed-by',
        keyIdValue,
        '--confirm',
        String(requested['phrase']),
        '--json',
        '--',
        ...PRIVILEGED_ARGV,
      ],
      home,
    );

    expect(result.status, result.stderr).toBe(EXIT.ok);
    expect(jsonOf(result)['operator']).toBe(keyIdValue);
  });

  it('refuses to decide an unprivileged operation: there is nothing to authorise', () => {
    const home = tempHome();
    publishKey(home);

    const result = gate(
      [
        'decide',
        '--signature',
        'whatever',
        '--confirm',
        'decide deadbeef',
        '--',
        ...UNPRIVILEGED_ARGV,
      ],
      home,
    );

    expect(result.status).toBe(EXIT.usage);
    expect(result.stderr).toContain('not a privileged operation');
  });
});

describe('gate list and gate show: read-only', () => {
  it('lists a recorded decision and does not move the ledger', () => {
    const home = tempHome();
    const { privatePem } = publishKey(home);
    const requested = request(home);
    const signaturePath = join(home, 'decision.sig');
    writeFileSync(signaturePath, signPayload(String(requested['payload']), privatePem));
    const decided = gate(
      [
        'decide',
        '--signature',
        signaturePath,
        '--issued-at',
        String(requested['issuedAt']),
        '--confirm',
        String(requested['phrase']),
        '--json',
        '--',
        ...PRIVILEGED_ARGV,
      ],
      home,
    );
    expect(decided.status, decided.stderr).toBe(EXIT.ok);
    const before = eventTypes(home);

    const listed = gateJson(['list'], home);

    expect(listed['decisions']).toHaveLength(1);
    const row = (listed['decisions'] as Record<string, unknown>[])[0] as Record<string, unknown>;
    expect(row['consumed']).toBe(false);
    expect(row['expired']).toBe(false);
    expect(row['keyActive']).toBe(true);
    expect(eventTypes(home)).toEqual(before);
  });

  it('shows the verified record without writing anything', () => {
    const home = tempHome();
    const { privatePem } = publishKey(home);
    const requested = request(home);
    const signaturePath = join(home, 'decision.sig');
    writeFileSync(signaturePath, signPayload(String(requested['payload']), privatePem));
    const decided = jsonOf(
      gate(
        [
          'decide',
          '--signature',
          signaturePath,
          '--issued-at',
          String(requested['issuedAt']),
          '--confirm',
          String(requested['phrase']),
          '--json',
          '--',
          ...PRIVILEGED_ARGV,
        ],
        home,
      ),
    );
    const before = eventTypes(home);
    const artifactBefore = readFileSync(
      join(home, 'gates', `${String(decided['decisionId'])}.json`),
      'utf8',
    );

    const shown = gateJson(['show', String(decided['decisionId'])], home);

    expect(shown['signatureVerifies']).toBe(true);
    expect(shown['keyActive']).toBe(true);
    expect(shown['consumed']).toBe(false);
    expect(shown['phrase']).toBe(String(requested['phrase']));
    expect(eventTypes(home)).toEqual(before);
    const artifactAfter = readFileSync(
      join(home, 'gates', `${String(decided['decisionId'])}.json`),
      'utf8',
    );
    expect(artifactAfter).toBe(artifactBefore);
  });

  it('refuses an unknown decision id as a usage problem, naming the directory it looked in', () => {
    const home = tempHome();

    const result = gate(['show', 'gd_deadbeef'], home);

    expect(result.status).toBe(EXIT.usage);
    expect(result.stderr).toContain(join(home, 'gates'));
  });

  it('refuses an unknown action with exit 2', () => {
    const home = tempHome();

    const result = gate(['approve'], home);

    expect(result.status).toBe(EXIT.usage);
    expect(result.stderr).toContain('request|decide|list|show');
  });
});
