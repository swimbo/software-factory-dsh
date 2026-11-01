/**
 * The broker's claim, tested as a claim.
 *
 * > a privileged operation is either brokered under a recorded human decision or refused,
 * > never silently performed.
 *
 * So the specs are written from the attacker's side: sneak `sudo` past the classifier with
 * a shell string, reuse one decision for a second command, present a decision the operator
 * never made, run an operation whose command position nobody can resolve. Each ends in a
 * refusal with a stable rule id, because the audit quotes rule ids and an exit code alone
 * cannot be re-read six months later.
 */
import { generateKeyPairSync } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { broker, createMemoryRegistry, describeRefusal, type DecisionSink } from './broker.ts';
import { classify, operationSha } from './classify.ts';
import { buildDecision, toArtifact, type PrivilegedDecision } from './decision.ts';
import { keyId } from '../../gates/src/signing.ts';

const HOME = '/Users/operator';

const OPERATOR = (() => {
  const pair = generateKeyPairSync('ed25519', {
    privateKeyEncoding: { format: 'pem', type: 'pkcs8' },
    publicKeyEncoding: { format: 'pem', type: 'spki' },
  });
  return { privateKeyPem: pair.privateKey, publicKeyPem: pair.publicKey };
})();
const ACTIVE_KEYS = new Map([[keyId(OPERATOR.publicKeyPem), OPERATOR.publicKeyPem]]);
const PHRASE = 'allow sudo to install the build toolchain';
const ISSUED_AT = '2026-11-01T12:00:00.000Z';
const EXPIRES_AT = '2026-11-01T13:00:00.000Z';

function decideFor(argv: readonly string[]): PrivilegedDecision {
  const classification = classify(argv, { home: HOME });
  return buildDecision(
    {
      taskId: 'U-7f3a9c',
      phrase: PHRASE,
      issuedAt: ISSUED_AT,
      expiresAt: EXPIRES_AT,
      outcome: 'allow',
      classification,
      privateKeyPem: OPERATOR.privateKeyPem,
      publicKeyPem: OPERATOR.publicKeyPem,
    },
    operationSha(classification),
  );
}

function recordingSink(): DecisionSink & { readonly events: unknown[] } {
  const events: unknown[] = [];
  return { events, append: (event) => events.push(event) };
}

const baseOptions = {
  nowIso: ISSUED_AT,
  home: HOME,
  operatorPhrase: PHRASE,
  registry: createMemoryRegistry(),
  activeKeys: ACTIVE_KEYS,
} as const;

describe('an ordinary operation is not brokered', () => {
  it('allows a command that names no privileged operation and no privileged path', () => {
    const sink = recordingSink();
    const outcome = broker(['node', '--test', 'tests/'], {
      ...baseOptions,
      decision: null,
      sink,
    });
    expect(outcome.kind).toBe('allow');
    if (outcome.kind !== 'allow') throw new Error('expected an allow');
    expect(outcome.decision).toBeNull();
    // Nothing is recorded for an unbundled operation: the decision trail is for decisions.
    expect(sink.events).toHaveLength(0);
  });
});

describe('a privileged operation without a decision is refused, exit 5', () => {
  it('refuses sudo and names the rule', () => {
    const outcome = broker(['sudo', 'ls'], { ...baseOptions, decision: null, sink: null });
    expect(outcome.kind).toBe('refuse');
    if (outcome.kind !== 'refuse') throw new Error('expected a refusal');
    expect(outcome.code).toBe('GATE_REQUIRED');
    expect(outcome.exitCode).toBe(5);
    expect(outcome.matchedRule).toBe('broker.no-decision');
    // The operator is told which operation was refused, by hash, so the decision they make
    // next can be about the right command.
    expect(outcome.detail).toContain('sha256:');
    expect(describeRefusal(outcome)).toContain('GATE_REQUIRED');
  });

  it('refuses a privileged operation hidden in a shell string (the denylist hole)', () => {
    // `argv.join(' ')` would contain `sudo`, but the denylist's word-boundary rules are
    // written for the command position, not for the inside of a quoted script.
    const outcome = broker(['sh', '-c', 'sudo rm -rf /tmp/cache'], {
      ...baseOptions,
      decision: null,
      sink: null,
    });
    expect(outcome.kind).toBe('refuse');
    if (outcome.kind !== 'refuse') throw new Error('expected a refusal');
    expect(outcome.matchedRule).toBe('broker.no-decision');
    expect(outcome.classification.ruleId).toBe('sudo.exec');
  });

  it('refuses a path-qualified binary exactly like the bare name', () => {
    const bare = broker(['sudo', 'ls'], { ...baseOptions, decision: null, sink: null });
    const qualified = broker(['/usr/bin/sudo', 'ls'], {
      ...baseOptions,
      decision: null,
      sink: null,
    });
    expect(bare.kind).toBe('refuse');
    expect(qualified.kind).toBe('refuse');
    if (bare.kind !== 'refuse' || qualified.kind !== 'refuse') throw new Error('expected refusals');
    expect(qualified.matchedRule).toBe('broker.no-decision');
    expect(qualified.detail).toBe(bare.detail);
  });

  it('refuses an operation whose command position cannot be resolved', () => {
    const outcome = broker(['sh', '-c', 'X=sudo; $X rm -rf /'], {
      ...baseOptions,
      decision: null,
      sink: null,
    });
    expect(outcome.kind).toBe('refuse');
    if (outcome.kind !== 'refuse') throw new Error('expected a refusal');
    expect(outcome.matchedRule).toBe('ambiguous.dynamic-word');
    expect(outcome.exitCode).toBe(5);
  });

  it('refuses an unknown binary naming a privileged path rather than allowing by default', () => {
    const outcome = broker(['mytool', '/etc/hosts'], {
      ...baseOptions,
      decision: null,
      sink: null,
    });
    expect(outcome.kind).toBe('refuse');
    if (outcome.kind !== 'refuse') throw new Error('expected a refusal');
    expect(outcome.matchedRule).toBe('ambiguous.unknown-writer');
  });
});

describe('a valid decision allows exactly one operation', () => {
  it('allows the operation it was granted for, records the event, and consumes the decision', () => {
    const sink = recordingSink();
    const registry = createMemoryRegistry();
    const argv = ['sudo', 'install', 'build-tool'];
    const decision = decideFor(argv);

    const outcome = broker(argv, { ...baseOptions, registry, decision, sink });
    expect(outcome.kind).toBe('allow');
    if (outcome.kind !== 'allow') throw new Error('expected an allow');
    expect(outcome.decision?.decisionId).toBe(decision.decisionId);
    // What runs is what was classified.
    expect(outcome.operation).toEqual([['sudo', 'install', 'build-tool']]);
    expect(registry.isConsumed(decision.decisionId)).toBe(true);
    expect(sink.events).toHaveLength(1);
    expect(sink.events[0]).toMatchObject({ type: 'privileged.decided', outcome: 'allow' });
  });

  it('refuses the second use of the same decision — a decision is not a session', () => {
    const registry = createMemoryRegistry();
    const argv = ['sudo', 'install', 'build-tool'];
    const decision = decideFor(argv);

    expect(broker(argv, { ...baseOptions, registry, decision, sink: null }).kind).toBe('allow');
    const replay = broker(argv, { ...baseOptions, registry, decision, sink: null });
    expect(replay.kind).toBe('refuse');
    if (replay.kind !== 'refuse') throw new Error('expected a refusal');
    expect(replay.matchedRule).toBe('broker.replayed');
    expect(replay.exitCode).toBe(5);
  });

  it('refuses a decision replayed for a different argv', () => {
    const decision = decideFor(['sudo', 'install', 'build-tool']);
    const outcome = broker(['sudo', 'rm', '-rf', '/'], {
      ...baseOptions,
      registry: createMemoryRegistry(),
      decision,
      sink: null,
    });
    expect(outcome.kind).toBe('refuse');
    if (outcome.kind !== 'refuse') throw new Error('expected a refusal');
    expect(outcome.code).toBe('MANDATE_EXPIRED');
    expect(outcome.exitCode).toBe(3);
    expect(outcome.matchedRule).toBe('broker.sha-mismatch');
  });

  it('refuses an expired decision against the injected clock', () => {
    const argv = ['sudo', 'ls'];
    const decision = decideFor(argv);
    const outcome = broker(argv, {
      ...baseOptions,
      nowIso: '2026-11-01T13:00:01.000Z',
      registry: createMemoryRegistry(),
      decision,
      sink: null,
    });
    expect(outcome.kind).toBe('refuse');
    if (outcome.kind !== 'refuse') throw new Error('expected a refusal');
    expect(outcome.matchedRule).toBe('broker.expired');
  });

  it('refuses a decision the operator did not phrase on this invocation', () => {
    const argv = ['sudo', 'ls'];
    const decision = decideFor(argv);
    const outcome = broker(argv, {
      ...baseOptions,
      operatorPhrase: 'yes',
      registry: createMemoryRegistry(),
      decision,
      sink: null,
    });
    expect(outcome.kind).toBe('refuse');
    if (outcome.kind !== 'refuse') throw new Error('expected a refusal');
    expect(outcome.matchedRule).toBe('broker.phrase-mismatch');
    // The refusal does not consume the decision: the operator can still approve it.
    expect(createMemoryRegistry().isConsumed(decision.decisionId)).toBe(false);
  });

  it('does not spend the decision when the operation is refused', () => {
    const registry = createMemoryRegistry();
    const argv = ['sh', '-c', 'sudo ls'];
    const decision = decideFor(argv);
    // Right decision, wrong phrase: refused.
    const refused = broker(argv, {
      ...baseOptions,
      operatorPhrase: 'nope',
      registry,
      decision,
      sink: null,
    });
    expect(refused.kind).toBe('refuse');
    expect(registry.isConsumed(decision.decisionId)).toBe(false);
    // Same decision, correct phrase: allowed, and only now is it consumed.
    const allowed = broker(argv, { ...baseOptions, registry, decision, sink: null });
    expect(allowed.kind).toBe('allow');
    expect(registry.isConsumed(decision.decisionId)).toBe(true);
  });

  it('brokers a macos-security operation and a privileged path write through the same gates', () => {
    for (const argv of [
      ['security', 'find-generic-password', '-s', 'github'],
      ['defaults', 'write', 'com.apple.dock', 'autohide', '-bool', 'true'],
      ['cp', '/etc/hosts', '/tmp/hosts'],
    ]) {
      const decision = decideFor(argv);
      const outcome = broker(argv, {
        ...baseOptions,
        registry: createMemoryRegistry(),
        decision,
        sink: null,
      });
      expect(outcome.kind, argv.join(' ')).toBe('allow');
    }
  });

  it('refuses an unsigned decision even when every other field is right', () => {
    const argv = ['sudo', 'install', 'build-tool'];
    const decision = { ...decideFor(argv), signature: null };
    const outcome = broker(argv, {
      ...baseOptions,
      registry: createMemoryRegistry(),
      decision,
      sink: null,
    });
    expect(outcome.kind).toBe('refuse');
    if (outcome.kind !== 'refuse') throw new Error('expected a refusal');
    // Before signatures this record was *accepted*: correct command, live expiry, right
    // phrase. That acceptance was the laundering route.
    expect(outcome.matchedRule).toBe('broker.unsigned');
    expect(outcome.exitCode).toBe(5);
  });

  it('refuses a decision edited after signing, even when the edit only extends the expiry', () => {
    const argv = ['sudo', 'install', 'build-tool'];
    const decision = { ...decideFor(argv), expiresAt: '2030-01-01T00:00:00.000Z' };
    const outcome = broker(argv, {
      ...baseOptions,
      registry: createMemoryRegistry(),
      decision,
      sink: null,
    });
    expect(outcome.kind).toBe('refuse');
    if (outcome.kind !== 'refuse') throw new Error('expected a refusal');
    expect(outcome.matchedRule).toBe('broker.signature-invalid');
  });

  it('refuses a decision signed by a key that is no longer active', () => {
    const retired = (() => {
      const pair = generateKeyPairSync('ed25519', {
        privateKeyEncoding: { format: 'pem', type: 'pkcs8' },
        publicKeyEncoding: { format: 'pem', type: 'spki' },
      });
      return { privateKeyPem: pair.privateKey, publicKeyPem: pair.publicKey };
    })();
    const argv = ['sudo', 'ls'];
    const classification = classify(argv, { home: HOME });
    const decision = buildDecision(
      {
        taskId: 'U-7f3a9c',
        phrase: PHRASE,
        issuedAt: ISSUED_AT,
        expiresAt: EXPIRES_AT,
        outcome: 'allow',
        classification,
        privateKeyPem: retired.privateKeyPem,
        publicKeyPem: retired.publicKeyPem,
      },
      operationSha(classification),
    );
    const outcome = broker(argv, {
      ...baseOptions,
      registry: createMemoryRegistry(),
      decision,
      sink: null,
    });
    expect(outcome.kind).toBe('refuse');
    if (outcome.kind !== 'refuse') throw new Error('expected a refusal');
    expect(outcome.matchedRule).toBe('broker.key-unknown');
  });

  it('names the operation and the reason in the artifact an operator reads', () => {
    const argv = ['kubectl', 'delete', 'deployment/api'];
    const decision = decideFor(argv);
    const artifact = toArtifact(decision);
    expect(artifact['operationSha']).toBe(decision.operationSha);
    // The refusal a person sees names the same operation hash the artifact carries.
    const outcome = broker(argv, { ...baseOptions, decision: null, sink: null });
    if (outcome.kind !== 'refuse') throw new Error('expected a refusal');
    expect(outcome.detail).toContain(decision.operationSha);
  });
});
