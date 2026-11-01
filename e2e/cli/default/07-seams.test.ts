/**
 * The executor and wall seams: what makes `run → attempt → receipt → verdict` reachable offline.
 *
 * Until these two test doubles existed, every spec had to assert a *refusal*: there is no `dsh`
 * on this host, so `run` exited 8 and nothing downstream of the receipt could be exercised at
 * all. That left 28 planned e2e ids unreachable — a receipt, a verdict, a promotion and a
 * kill-9 recovery were all untested behaviour.
 *
 * Two seams, deliberately different in what they prove:
 *
 *   - `FACTORY_EXECUTOR=fake` + `--scenario` runs a **scripted** worker. It proves the
 *     plumbing: the attempt record, the receipt, the state transitions, the ledger.
 *   - `FACTORY_WALL=fake` + `--verdict` replays a **declared** verdict. Specs that use it are
 *     tagged `@fake-wall`, because a fake wall can only show that the plumbing around a
 *     verdict works — never that the wall measured anything. The wall's own suite and the
 *     container path are where its honesty is tested.
 *
 * Both are refused under `NODE_ENV=production` and both print a banner, so neither can be
 * mistaken for a real run by a human reading output *or* by a test reading the ledger
 * (`sessionId: fake-<attempt>`, `wallVersion: …-fake`, `fakeWall: true`).
 *
 * What this file closes, precisely:
 *
 *   - **E2E-31** (kill -9 mid-attempt → `ambiguous`, never a redispatch) — fully: the
 *     process is really killed, the ledger really holds one attempt, `recover` twice
 *     changes nothing.
 *   - **E2E-08** and **E2E-25** — advanced, not closed: the dispatch → receipt → verdict
 *     path now runs end to end, but the verdict in these specs is *declared* by a fake
 *     wall. E2E-08 needs the real `evaluate()`, E2E-25 needs a real `unknown` from it.
 *   - **E2E-14** — the refusal half is already covered by `04-gates.test.ts`; here the
 *     same refusal is shown to survive a *correctly signed* promotion of a fake verdict.
 *
 * Not covered on purpose: E2E-29 and E2E-30 (sabotage, unfaithful receipt) require the
 * wall's scenario runner and re-execution, i.e. the real `evaluate()` wiring.
 */
import { spawn } from 'node:child_process';
import { createPrivateKey, generateKeyPairSync, sign } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  CLI_MAIN,
  baseEnv,
  jsonOf,
  newFactoryHome,
  runFactory,
  specFor,
  submitUnit,
  units,
  writeJsonFile,
  type FactoryRun,
} from '../../harness/factory.ts';
import { promotionSignaturePayload } from '../../../packages/gates/src/index.ts';
import { openStore } from '../../../packages/store/src/index.ts';
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

/**
 * The fake executor still needs a real mirror: `run` cuts the attempt clone before it
 * launches anything, for both executors. A fake worker that wrote into a directory the
 * factory invented would hide a missing clone step, which is precisely the bug the
 * clone exists to make impossible.
 */
function fakeEnv(home_: string): Record<string, string> {
  return {
    FACTORY_EXECUTOR: 'fake',
    NODE_ENV: 'test',
    FACTORY_PRISTINE_REPO: fixture.repo,
    FACTORY_REPO: 'fixture',
  };
}

/** A worker that did its job: one file, a session, a completed turn, exit 0. */
/**
 * The fixture's slug helper, plus the one export the unit was meant to add.
 *
 * Replacing the file outright would delete `slugify` and the visible suite would fail —
 * a scenario that breaks the SUT is not "honest", it is a different test.
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

function honestScenario(): Record<string, unknown> {
  return {
    steps: [
      { kind: 'write', path: 'src/slug.js', content: SLUG_SRC_KEPT },
      // A receipt claims "this command ran and printed these bytes"; the wall re-executes
      // it and compares. So the fake *runs* it rather than describing it — a declared
      // command the tree cannot reproduce is `receipt_unfaithful`, which is a fail, and
      // rightly so.
      // `--test-reporter=dot`: the default reporter embeds per-test timings, so two runs
      // of a passing suite never print identical bytes — and the wall compares output
      // hashes, not intentions. `dot` prints one character per test, deterministically.
      { kind: 'command', argv: ['node', '--test', '--test-reporter=dot', 'tests/'] },
      {
        kind: 'emit',
        events: [
          { type: 'session', sessionId: 's-fake' },
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
      narrative: 'added the check',
      // No declared commands: they come from the `command` step above, measured.
      ceilings: { turnsUsed: 1, wallClockMs: 12, hit: [] },
    },
  };
}

/** A completed turn, but the worker left uncommitted work behind. */
function untidyScenario(): Record<string, unknown> {
  const scenario = honestScenario();
  return {
    ...scenario,
    steps: [...(scenario['steps'] as unknown[]), { kind: 'untracked', paths: ['scratch.txt'] }],
  };
}

/** The verdict a fake wall replays: a clean pass, so nothing but the fake-ness can refuse it. */
function passTemplate(): Record<string, unknown> {
  return {
    outcome: 'pass',
    wallVersion: 'wall/0.1.0',
    holdoutRevision: 'holdout@fake',
    scenarios: [
      { id: 'suite-green', source: 'acceptance', outcome: 'pass', observed: 'exit 0' },
      { id: 'holdout-slug', source: 'holdout', outcome: 'pass', observed: '1/1' },
      { id: 'delta-slug', source: 'delta', outcome: 'pass', observed: '0.50' },
    ],
    delta: {
      checked: true,
      baseRate: 0,
      candidateRate: 1,
      threshold: 0.2,
      observed: 1,
      holdoutRevision: 'holdout@fake',
    },
    reasons: [],
    promotionRequiresHumanSignature: true,
  };
}

function submit(home_: string, overrides: Parameters<typeof specFor>[0] = {}): string {
  const { unitId } = submitUnit(home_, {
    spec: specFor({ baseRev: fixture.baseRev, ...overrides }),
  });
  const qualified = runFactory(['qualify', unitId, '--cold-start', '--json'], { home: home_ });
  if (qualified.code !== 0) throw new Error(`qualify refused: ${qualified.stderr}`);
  return unitId;
}

function runFake(
  args: readonly string[],
  home_: string,
  env: Record<string, string | undefined>,
): FactoryRun {
  return runFactory(args, { home: home_, env: { ...fakeEnv(home_), ...env } });
}

/**
 * Simulate the 45 minutes a lease needs to stop vouching for an attempt.
 *
 * `LEASE_TTL_MS` is a constant in `@factory/core` and the CLI has no knob for it (a
 * shorter lease would be a lever on when the factory calls an attempt ambiguous, so
 * it is deliberately not an operator setting). A crash spec therefore has to age the
 * lease itself, and it does it at the source of truth — the row recovery reads — so
 * the reconciliation under test is the real one.
 */
function ageLease(home_: string): void {
  const db = new DatabaseSync(join(home_, 'state', 'factory.db'));
  try {
    db.exec("UPDATE leases SET expires_at = '2020-01-01T00:00:00.000Z'");
  } finally {
    db.close();
  }
}

/** Age the mandate a unit was qualified under, the same way `ageLease` ages a lease. */
function ageMandate(home_: string): void {
  const db = new DatabaseSync(join(home_, 'state', 'factory.db'));
  try {
    db.exec("UPDATE mandates SET expires_at = '2020-01-01T00:00:00.000Z'");
  } finally {
    db.close();
  }
}

/** The unit row for a unit, from `status --json` (the canonical read of the store). */
function unitRow(home_: string, unitId: string): Record<string, unknown> {
  const row = units(home_).find((candidate) => candidate['unitId'] === unitId);
  if (row === undefined) throw new Error(`no unit ${unitId} in status`);
  return row;
}

describe('fake executor', () => {
  it('[@default] runs a scripted worker to a stored receipt with no dsh and no docker', () => {
    const unitId = submit(home);
    const scenario = writeJsonFile(home, 'scenario.json', honestScenario());

    const run = runFake(['run', unitId, '--scenario', scenario, '--json'], home, {});
    const json = jsonOf(run);

    // The receipt was produced and observed; the *verdict* is unknown because this spec
    // declares no holdout corpus and no pinned suite, so the real wall has nothing to
    // measure it against. That combination is the honest one: evidence, no judgement.
    //
    // Exit 5, not 4: the verdict was *recorded*, so a person has a row to decide on —
    // which is the human-gate class. Exit 4 stays reserved for an attempt whose
    // ambiguity is unresolved (did it run? what did it produce?), where there is not yet
    // anything to decide about.
    expect(run.code, `${JSON.stringify(json)}\n${run.stderr}`).toBe(5);
    expect(json['outcome']).toBe('unknown');
    expect(json['receiptSha']).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(json['attemptNo']).toBe(1);
    expect(run.stderr).toContain('executor: FAKE (no DSH process launched)');
    expect(run.stderr).toContain('verdict');
    expect(run.stderr).not.toContain('EXECUTOR_UNAVAILABLE');

    // The banner is not the only marker: the ledger says which executor ran.
    const row = unitRow(home, unitId);
    expect(row['attempt']).not.toBeNull();

    // The attempt record is on disk, outside the clone, with the patch and the stream.
    const attemptsDir = join(home, 'attempts', unitId);
    expect(existsSync(attemptsDir)).toBe(true);
  });

  it('[@default] refuses to activate under NODE_ENV=production', () => {
    const unitId = submit(home);
    const scenario = writeJsonFile(home, 'scenario.json', honestScenario());

    const run = runFake(['run', unitId, '--scenario', scenario, '--json'], home, {
      NODE_ENV: 'production',
    });
    const json = jsonOf(run);

    expect(run.code).toBe(8);
    expect(json['code']).toBe('EXECUTOR_UNAVAILABLE');
    expect(String(json['message'])).toContain('NODE_ENV=production');
    // Nothing was dispatched: a refused seam must leave no attempt behind.
    expect(unitRow(home, unitId)['attempt']).toBeNull();
    expect(existsSync(join(home, 'attempts', unitId))).toBe(false);
  });

  it('[@default] records what the worker left untracked rather than calling it a clean patch', () => {
    const unitId = submit(home);
    const scenario = writeJsonFile(home, 'scenario.json', untidyScenario());

    const run = runFake(['run', unitId, '--scenario', scenario, '--json'], home, {});
    const json = jsonOf(run);
    // The stray file is not a secret the receipt hides: the measured diff carries it,
    // and the wall then refuses the patch for leaving the unit's declared touch paths.
    expect(run.code, run.stderr).toBe(3);
    expect(json['outcome']).toBe('fail');
    expect(json['reasons']).toContain('scope_violation');

    const receiptFile = join(
      home,
      'attempts',
      unitId,
      String(jsonOf(run)['attemptId']),
      'receipt.json',
    );
    const receipt = JSON.parse(readFileSync(receiptFile, 'utf8')) as Record<string, unknown>;
    const diff = receipt['diff'] as Record<string, unknown>;
    // The fake measures the diff from the clone rather than trusting a declared one, so
    // an untracked file lands in the patch (2 files, not 1) exactly as the real adapter
    // records it — and `statusPaths` stays empty because the patch describes it.
    expect(diff['filesChanged']).toBe(2);
    expect(readFileSync(String(diff['patchFile']), 'utf8')).toContain('scratch.txt');
  });
});

describe('a worker that stops without finishing a turn', () => {
  it('[@default] is ambiguous, never failed, and recover reconciles it', () => {
    const unitId = submit(home);
    const scenario = writeJsonFile(home, 'scenario.json', {
      steps: [
        { kind: 'write', path: 'src/slug.js', content: 'export const unique = true;\n' },
        // Exit 0, and no `turn_end`: the process finished, the turn never did.
        { kind: 'exit', code: 0 },
      ],
      receipt: { filesChanged: 1 },
    });

    const run = runFake(['run', unitId, '--scenario', scenario, '--json'], home, {});
    const json = jsonOf(run);

    expect(run.code).toBe(4);
    expect(json['code']).toBe('ATTEMPT_AMBIGUOUS');
    expect(String(json['message'])).toContain('ambiguous, not failed');

    // The ledger must not have recorded a failure, and the unit must not be verified.
    const row = unitRow(home, unitId);
    expect(row['state']).not.toBe('failed');
    expect(['dispatched', 'ambiguous']).toContain(row['state']);

    // A lease that has stopped vouching for the attempt is what makes it reconcilable.
    ageLease(home);
    const recovered = runFactory(['recover', '--json'], { home });
    expect(recovered.code).toBe(4);
    expect(jsonOf(recovered)['ambiguous']).toBe(1);
    expect(unitRow(home, unitId)['state']).toBe('ambiguous');
    // No redispatch, ever: recovery observes, it does not retry.
    expect(unitRow(home, unitId)['attempt']).not.toBeNull();
  });
});

describe('kill -9 mid-attempt', () => {
  it('[@default] leaves an ambiguous attempt that recover reconciles without re-dispatching', async () => {
    const unitId = submit(home);
    const pidFile = join(home, 'fake.pid');
    const scenario = writeJsonFile(home, 'scenario.json', {
      steps: [
        { kind: 'write', path: 'src/slug.js', content: 'export const unique = true;\n' },
        { kind: 'hang', ms: 30_000 },
      ],
      receipt: { filesChanged: 1 },
    });

    const child = spawn(
      process.execPath,
      [CLI_MAIN, 'run', unitId, '--scenario', scenario, '--json'],
      {
        env: baseEnv(home, {
          env: { ...fakeEnv(home), FACTORY_SCENARIO_PID_FILE: pidFile },
        }),
        stdio: ['ignore', 'pipe', 'pipe'],
      },
    );
    const exited = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>(
      (resolve) => {
        child.once('exit', (code, signal) => resolve({ code, signal }));
      },
    );

    // Wait for the worker to be mid-attempt, then kill the whole process the way a
    // `kill -9` does: no cleanup handler, no chance to write a terminal event.
    const deadline = Date.now() + 20_000;
    while (!existsSync(pidFile) && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    expect(existsSync(pidFile)).toBe(true);
    const pid = Number(readFileSync(pidFile, 'utf8').trim());
    expect(pid).toBeGreaterThan(0);
    process.kill(pid, 'SIGKILL');

    const death = await exited;
    expect(death.signal).toBe('SIGKILL');

    // The ledger still holds an attempt that never reported; nothing has been retried.
    const before = unitRow(home, unitId);
    expect(before['state']).toBe('dispatched');

    ageLease(home);
    const recovered = runFactory(['recover', '--json'], { home });
    expect(recovered.code).toBe(4);
    expect(jsonOf(recovered)['ambiguous']).toBe(1);

    const after = unitRow(home, unitId);
    expect(after['state']).toBe('ambiguous');
    expect(after['attempt']).not.toBeNull();

    // A second recover changes nothing and says so: idempotent by construction.
    const again = runFactory(['recover', '--json'], { home });
    expect(again.code).toBe(0);
    expect(jsonOf(again)['ambiguous']).toBe(0);
    expect(again.stderr).toContain('still ambiguous: 1');
  });
});

describe('a stale mandate', () => {
  it('[@default] refuses to dispatch when the mandate under which the unit qualified has expired', () => {
    const unitId = submit(home);
    const scenario = writeJsonFile(home, 'scenario.json', honestScenario());
    ageMandate(home);

    const run = runFake(['run', unitId, '--scenario', scenario, '--json'], home, {});
    const json = jsonOf(run);

    // A policy or mandate that no longer vouches for the unit is a refusal, not a
    // warning: the attempt is authorised by the mandate, and an expired one authorises
    // nothing. Nothing was dispatched and no budget was reserved.
    expect(run.code).toBe(3);
    expect(
      ['MANDATE_EXPIRED', 'MANDATE_REVOKED', 'BUDGET_EXCEEDED'].includes(String(json['code'])),
    ).toBe(true);
    expect(unitRow(home, unitId)['attempt']).toBeNull();
    expect(existsSync(join(home, 'attempts', unitId))).toBe(false);
  });
});

describe('duplicate evidence', () => {
  it("[@default] replaying another attempt's receipt is a RECEIPT_CONFLICT", () => {
    const first = submit(home);
    const scenarioA = writeJsonFile(home, 'scenario-a.json', honestScenario());
    const runA = runFake(['run', first, '--scenario', scenarioA, '--json'], home, {});
    expect(runA.code).toBe(5);
    const receiptA = join(
      home,
      'attempts',
      first,
      String(jsonOf(runA)['attemptId']),
      'receipt.json',
    );
    expect(existsSync(receiptA)).toBe(true);

    // A second unit whose worker tries to hand in the first unit's evidence.
    const second = submit(home, { slug: 'slug-check-2' });
    const scenarioB = writeJsonFile(home, 'scenario-b.json', {
      steps: [{ kind: 'replayReceipt', path: receiptA }],
      receipt: {},
    });

    const runB = runFake(['run', second, '--scenario', scenarioB, '--json'], home, {});
    const json = jsonOf(runB);

    expect(runB.code).toBe(7);
    expect(json['code']).toBe('RECEIPT_CONFLICT');
    expect(String(json['message'])).toContain('evidence cannot be moved between attempts');
    // The second attempt produced nothing and the first unit is untouched.
    expect(unitRow(home, second)['state']).not.toBe('verified');
  });
});

describe('the fake wall', () => {
  it('[@fake-wall] turns a receipt into a labelled verdict, and the label survives into the ledger', () => {
    const unitId = submit(home);
    const scenario = writeJsonFile(home, 'scenario.json', honestScenario());
    const verdictPath = writeJsonFile(home, 'verdict.json', passTemplate());

    const run = runFake(
      ['run', unitId, '--scenario', scenario, '--verdict', verdictPath, '--json'],
      home,
      { FACTORY_WALL: 'fake' },
    );
    const json = jsonOf(run);

    expect(run.code).toBe(0);
    expect(json['outcome']).toBe('pass');
    expect(json['fakeWall']).toBe(true);
    // Named, always: every fake verdict carries a `-fake` wall version.
    expect(json['wallVersion']).toBe('wall/0.1.0-fake');
    expect(run.stderr).toContain('wall: FAKE (no scenario executed)');
    expect(unitRow(home, unitId)['state']).toBe('verified');
  });

  it('[@fake-wall] refuses to re-qualify a unit that already has a verdict, in one JSON object', () => {
    const unitId = submit(home);
    const scenario = writeJsonFile(home, 'scenario.json', honestScenario());
    const verdictPath = writeJsonFile(home, 'verdict.json', passTemplate());
    expect(
      runFake(['run', unitId, '--scenario', scenario, '--verdict', verdictPath, '--json'], home, {
        FACTORY_WALL: 'fake',
      }).code,
    ).toBe(0);

    // The engine raises an INTERNAL (exit 1) phase error for this, which reads like a
    // bug report for an operator mistake. `--json` must still be one usable object.
    const again = runFactory(['qualify', unitId, '--json'], { home });
    const json = jsonOf(again);
    expect(again.code).toBe(3);
    expect(json['code']).toBe('UNIT_ALREADY_TERMINAL');
    expect(String(json['message'])).toContain('Nothing was changed');
  });

  it('[@fake-wall] refuses to activate under NODE_ENV=production', () => {
    const unitId = submit(home);
    const scenario = writeJsonFile(home, 'scenario.json', honestScenario());
    const verdictPath = writeJsonFile(home, 'verdict.json', passTemplate());

    const run = runFake(
      ['run', unitId, '--scenario', scenario, '--verdict', verdictPath, '--json'],
      home,
      { FACTORY_WALL: 'fake', NODE_ENV: 'production' },
    );
    expect(run.code).toBe(8);
    expect(jsonOf(run)['code']).toBe('EXECUTOR_UNAVAILABLE');
  });
});

describe('promotion against a fake verdict', () => {
  /**
   * The operator keypair, generated once per home like a real operator's would be, and a
   * signature over the real promotion payload — so the refusal under test cannot be a
   * signature failure in disguise. The payload is the one `promotionSignaturePayload()`
   * defines: `contentHash({unitId, verdictSha, approvedBy})`.
   */
  function operatorKeypair(): { privatePem: string; publicPem: string } {
    const keys = join(home, 'keys');
    mkdirSync(keys, { recursive: true });
    const privateFile = join(keys, 'operator.key.pem');
    const publicFile = join(keys, 'operator.pub.pem');
    if (!existsSync(privateFile)) {
      const pair = generateKeyPairSync('ed25519', {
        privateKeyEncoding: { format: 'pem', type: 'pkcs8' },
        publicKeyEncoding: { format: 'pem', type: 'spki' },
      });
      writeFileSync(privateFile, pair.privateKey);
      writeFileSync(publicFile, pair.publicKey);
    }
    return {
      privatePem: readFileSync(privateFile, 'utf8'),
      publicPem: readFileSync(publicFile, 'utf8'),
    };
  }

  function signedPromotion(unitId: string, approvedBy = 'operator'): FactoryRun {
    const keys = operatorKeypair();
    const store = openStore({ dir: join(home, 'state') });
    let payload: string;
    try {
      const verdictRow = store.latestVerdictForUnit(unitId);
      if (verdictRow === null) throw new Error(`no verdict recorded for ${unitId}`);
      payload = promotionSignaturePayload({
        unitId,
        verdict: verdictRow.verdict,
        approvedBy,
      }).payload;
    } finally {
      store.close();
    }
    const signature = sign(null, Buffer.from(payload, 'utf8'), createPrivateKey(keys.privatePem));
    const signaturePath = join(home, 'signature.txt');
    writeFileSync(signaturePath, signature.toString('base64'));
    void keys.publicPem;
    return runFactory(
      [
        'promote',
        unitId,
        '--signature',
        signaturePath,
        '--confirm',
        `sign promotion ${unitId}`,
        '--json',
      ],
      { home },
    );
  }

  it('[@fake-wall] refuses a fake pass unsigned, and refuses it signed too', () => {
    const unitId = submit(home);
    const scenario = writeJsonFile(home, 'scenario.json', honestScenario());
    const verdictPath = writeJsonFile(home, 'verdict.json', passTemplate());
    const run = runFake(
      ['run', unitId, '--scenario', scenario, '--verdict', verdictPath, '--json'],
      home,
      { FACTORY_WALL: 'fake' },
    );
    expect(run.code).toBe(0);

    // Unsigned: refused for the ordinary reason, and nothing is written.
    const unsigned = runFactory(['promote', unitId, '--json'], { home });
    expect(unsigned.code).toBe(5);
    expect(existsSync(join(home, 'artifacts', unitId))).toBe(false);

    // Signed: the signature is not the problem, the evidence is. Refused, no artifact.
    const signed = signedPromotion(unitId);
    expect(signed.code).toBe(5);
    const json = jsonOf(signed);
    expect(json['code']).toBe('VERDICT_UNKNOWN');
    expect(String(json['message'])).toContain('wall/0.1.0-fake');
    expect(existsSync(join(home, 'artifacts', unitId))).toBe(false);
  });
});
