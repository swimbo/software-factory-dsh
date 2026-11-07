/**
 * `factory gate` end to end: one decision, one operation, across processes.
 *
 * This is the R5 acceptance path, and every assertion is about a *process boundary* — `gate
 * decide`, `run`, `run` again are three separate `node` invocations over one `FACTORY_HOME`. The
 * bug this closes is not "the broker forgot to check": it is that the registry used to be a per-
 * invocation `Map`, so the second process started with an empty one and the same signed decision
 * authorised the same operation again.
 *
 * The four facts, in the order the operator meets them:
 *
 * 1. a privileged `command` step is refused (exit 5) when no decision covers it, and nothing runs;
 * 2. after `gate decide`, the same step is executed, exactly once, and recorded;
 * 3. a second run presenting the same decision is refused — the marker is durable, not per-process;
 * 4. the same decision does not authorise a *different* operation.
 *
 * The privileged argv is `cp /etc/hosts <home>/ran-once.txt`: `cp` writing outside the attempt
 * clone is a `path-write` (the broker's rule), and the destination is inside the temp home, so
 * "did it run?" is a file check rather than a guess — while being harmless to the machine.
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { generateKeyPairSync } from 'node:crypto';
import { existsSync } from 'node:fs';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { signPayload } from '../../../packages/gates/src/index.ts';
import { openStore } from '../../../packages/store/src/index.ts';
import {
  jsonOf,
  newFactoryHome,
  runFactory,
  specFor,
  submitUnit,
  type FactoryRun,
} from '../../harness/factory.ts';
import { createFixtureRepo, type FixtureRepo } from '../../harness/fixture.ts';

let fixture: FixtureRepo;
let home: string;

beforeEach(() => {
  fixture = createFixtureRepo();
  home = newFactoryHome();
});

afterEach(() => {
  fixture.cleanup();
});

/** Where the privileged step copies to, so "it ran" is observable without side effects. */
function landedPath(): string {
  return join(home, 'ran-once.txt');
}

function privilegedArgv(destination = landedPath()): readonly string[] {
  return ['cp', '/etc/hosts', destination];
}

/**
 * The fixture's slug helper, plus the one export the unit was meant to add.
 *
 * Replacing the file outright would delete `slugify` and the visible suite would fail — a scenario
 * that breaks the SUT is not "honest", it is a different test, and the wall would (correctly)
 * refuse the attempt for the wrong reason.
 */
const SLUG_SRC_KEPT = `export function slugify(input) {
  return String(input)
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}
export const unique = true;
`;

/** A scenario whose first step is the privileged command, followed by the honest worker's work. */
function scenario(): Record<string, unknown> {
  return {
    steps: [
      { kind: 'command', argv: [...privilegedArgv()] },
      { kind: 'write', path: 'src/slug.js', content: SLUG_SRC_KEPT },
      // `dot` prints one character per test, deterministically: the wall compares output hashes,
      // and the default reporter embeds per-test timings.
      { kind: 'command', argv: ['node', '--test', '--test-reporter=dot', 'tests/'] },
      {
        kind: 'emit',
        events: [
          { type: 'session', sessionId: 's-gate' },
          { type: 'turn_end', reason: { kind: 'completed' } },
        ],
      },
      { kind: 'exit', code: 0 },
    ],
    receipt: {
      filesChanged: 1,
      insertions: 1,
      deletions: 0,
      patch: 'diff --git a/src/slug.js b/src/slug.js\n',
      narrative: 'the privileged step is the point of this spec',
      ceilings: { turnsUsed: 1, wallClockMs: 12, hit: [] },
    },
  };
}

/** Publish an operator key, exactly as a real operator's rotation would. */
function publishKey(): { readonly privatePem: string } {
  const keys = join(home, 'keys');
  mkdirSync(keys, { recursive: true });
  const pair = generateKeyPairSync('ed25519', {
    privateKeyEncoding: { format: 'pem', type: 'pkcs8' },
    publicKeyEncoding: { format: 'pem', type: 'spki' },
  });
  writeFileSync(join(keys, 'operator.pub.pem'), pair.publicKey);
  return { privatePem: pair.privateKey };
}

let unitTick = 0;
/** A submitted, cold-started (dark-lane) unit, which is what `run` needs to dispatch. */
function qualifiedUnit(): string {
  unitTick += 1;
  const { unitId } = submitUnit(home, {
    spec: specFor({ baseRev: fixture.baseRev, slug: `gate-check-${String(unitTick)}` }),
  });
  const qualified = runFactory(['qualify', unitId, '--cold-start', '--json'], { home });
  if (qualified.code !== 0) throw new Error(`qualify refused: ${qualified.stderr}`);
  return unitId;
}

/** The env a scripted worker needs, plus the policy that makes a `command` step brokered. */
function fakeEnv(extra: Record<string, string> = {}): Record<string, string> {
  return {
    FACTORY_EXECUTOR: 'fake',
    FACTORY_PRIVILEGED_BROKERING: 'on',
    // A refused launch leaves its attempt reconcilable, and this spec deliberately keeps several
    // attempts in one home (that is what makes the decision shared). The ceiling is not what is
    // under test here, so it is raised rather than waited out.
    FACTORY_MAX_CONCURRENT_ATTEMPTS: '4',
    NODE_ENV: 'test',
    FACTORY_PRISTINE_REPO: fixture.repo,
    FACTORY_REPO: 'fixture',
    ...extra,
  };
}

function runWith(unitId: string, scenarioPath: string): FactoryRun {
  return runFactory(['run', unitId, '--scenario', scenarioPath, '--json'], {
    home,
    env: fakeEnv(),
  });
}

function eventsOfType(type: string): readonly unknown[] {
  const store = openStore({ dir: join(home, 'state') });
  try {
    return store.eventsSince(0).filter((event) => event.type === type);
  } finally {
    store.close();
  }
}

/** Mint one decision for `privilegedArgv()` through the real CLI, and return its id. */
function decide(argv: readonly string[] = privilegedArgv()): string {
  const { privatePem } = publishKey();
  const requested = jsonOf(runFactory(['gate', 'request', '--json', '--', ...argv], { home }));
  const signaturePath = join(home, 'decision.sig');
  writeFileSync(signaturePath, signPayload(String(requested['payload']), privatePem));
  const decided = runFactory(
    [
      'gate',
      'decide',
      '--signature',
      signaturePath,
      '--issued-at',
      String(requested['issuedAt']),
      '--confirm',
      String(requested['phrase']),
      '--json',
      '--',
      ...argv,
    ],
    { home },
  );
  const json = jsonOf(decided);
  if (decided.code !== 0) throw new Error(`gate decide refused: ${decided.stderr}`);
  return String(json['decisionId']);
}

describe('gate decisions across processes', () => {
  it('refuses a privileged step with no decision, and executes nothing', () => {
    const unitId = qualifiedUnit();
    const scenarioPath = join(home, 'scenario.json');
    writeFileSync(scenarioPath, JSON.stringify(scenario()));

    const run = runWith(unitId, scenarioPath);
    const json = jsonOf(run);

    // Exit 5 with GATE_REQUIRED is the broker's refusal, surfaced through `run`: the operation is
    // brokered and nobody decided, so the step never spawned.
    expect(run.code, `${JSON.stringify(json)}\n${run.stderr}`).toBe(5);
    expect(json['code']).toBe('GATE_REQUIRED');
    expect(String(json['message'])).toMatch(/cp .*\/etc\/hosts/u);
    // The message names the refusal once. Double prefixes ("GATE_REQUIRED: GATE_REQUIRED: …") are
    // what happens when a detail that already carries its code is wrapped again.
    expect(String(json['message']).startsWith('GATE_REQUIRED: GATE_REQUIRED')).toBe(false);
    expect(existsSync(landedPath())).toBe(false);
    // Nothing was decided, so nothing may look decided afterwards.
    expect(existsSync(join(home, 'gates'))).toBe(false);
    expect(eventsOfType('privileged.decided')).toHaveLength(0);
    expect(eventsOfType('attempt.receipted')).toHaveLength(0);
  });

  it('authorises exactly one operation with one signed decision, then refuses the replay', () => {
    const scenarioPath = join(home, 'scenario.json');
    writeFileSync(scenarioPath, JSON.stringify(scenario()));

    // 1. Refused, before anything is decided.
    const refused = qualifiedUnit();
    expect(runWith(refused, scenarioPath).code).toBe(5);
    expect(existsSync(landedPath())).toBe(false);

    // 2. The operator decides, in their own process, with their own key.
    const decisionId = decide();

    // 3. A different unit, the same privileged argv: now it is allowed and it really ran.
    const allowed = qualifiedUnit();
    const allowedRun = runWith(allowed, scenarioPath);
    const allowedJson = jsonOf(allowedRun);
    expect(allowedRun.code, `${JSON.stringify(allowedJson)}\n${allowedRun.stderr}`).toBe(5);
    // Exit 5 here is the *unknown verdict* (no wall evidence declared), not a gate refusal: a
    // receipt was produced, which is what proves the brokered step executed.
    expect(allowedJson['code']).toBeUndefined();
    expect(allowedJson['receiptSha']).toMatch(/^sha256:[0-9a-f]{64}$/u);
    expect(existsSync(landedPath())).toBe(true);

    const store = openStore({ dir: join(home, 'state') });
    try {
      const receipt = store.latestReceiptForUnit(allowed);
      expect(receipt).not.toBeNull();
      const commands = (receipt?.receipt.commands ?? []).map((command) => command.argv.join(' '));
      // The brokered command is in the receipt exactly once: it executed, and it executed once.
      expect(commands.filter((line) => line === privilegedArgv().join(' '))).toHaveLength(1);
      // The decision's own event, and its consumption, are separate facts.
      expect(eventsOfType('privileged.decided')).toHaveLength(1);
      expect(store.isDecisionConsumed(decisionId)).toBe(true);
    } finally {
      store.close();
    }

    // 4. A third unit, same decision, same operation: refused, because the decision is spent.
    const replayed = qualifiedUnit();
    const replayRun = runWith(replayed, scenarioPath);
    const replayJson = jsonOf(replayRun);
    expect(replayRun.code).toBe(5);
    expect(replayJson['code']).toBe('GATE_REQUIRED');
    expect(String(replayJson['message'])).toMatch(/already|replay/iu);
    // No second receipt and no second decision event: the refusal happened before the command.
    expect(eventsOfType('attempt.receipted')).toHaveLength(1);
    expect(eventsOfType('privileged.decided')).toHaveLength(1);
    const after = openStore({ dir: join(home, 'state') });
    try {
      expect(after.latestReceiptForUnit(replayed)).toBeNull();
    } finally {
      after.close();
    }
  });

  it('does not let one decision authorise a different privileged operation', () => {
    const scenarioPath = join(home, 'scenario.json');
    writeFileSync(scenarioPath, JSON.stringify(scenario()));
    // A decision for the copy to `ran-once.txt`...
    decide();
    // ...and a unit whose privileged step copies somewhere else. Same binary, same source, same
    // shape; a different operation, so the decision does not cover it.
    const unitId = qualifiedUnit();
    const otherScenario = join(home, 'other-scenario.json');
    const other = scenario();
    other['steps'] = [
      { kind: 'command', argv: ['cp', '/etc/hosts', join(home, 'somewhere-else.txt')] },
      ...(other['steps'] as unknown[]).slice(1),
    ];
    writeFileSync(otherScenario, JSON.stringify(other));

    const run = runWith(unitId, otherScenario);
    const json = jsonOf(run);

    expect(run.code).toBe(5);
    expect(json['code']).toBe('GATE_REQUIRED');
    expect(existsSync(join(home, 'somewhere-else.txt'))).toBe(false);
    // The decision for the other operation is untouched: a refusal must not spend it.
    const store = openStore({ dir: join(home, 'state') });
    try {
      const decisions = store.eventsSince(0).filter((event) => event.type === 'privileged.decided');
      expect(decisions).toHaveLength(1);
      const decisionId = String(decisions[0]?.payload['decisionId']);
      expect(store.isDecisionConsumed(decisionId)).toBe(false);
    } finally {
      store.close();
    }
  });
});
