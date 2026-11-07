/**
 * The driver's stop conditions — proven where it is free to be wrong.
 *
 * `scripts/certify-class.sh` spends money, so the one thing it must never do is keep spending
 * after the certificate has become arithmetically impossible (or stop while it can still exist).
 * Both halves are tested here against a stubbed `factory`, because the stop decision is a function
 * of per-unit exit codes and nothing else; `e2e/certification/driver-integration.test.ts` then
 * drives the same script over real `factory run` invocations, so the mapping from a real verdict
 * to the outcome the driver reads is not assumed.
 *
 * The credential line is never executed by this file: `CERTIFY_KEY_COMMAND` replaces it with a
 * stub, and every test that runs the loop asserts the stub's sentinel appears in no transcript and
 * in no file under the factory home. The real line (`ssh … cat …/credential`) is not run, read or
 * printed anywhere in this suite.
 *
 * The mutation check is the fourth test: with the allowed-failures budget widened by one
 * (`m - k + 1`), the same plan that must stop at the third failure runs to the end of the file.
 * The guard that the mutation actually bit is an assertion on the source text before it is
 * applied — a mutation check whose mutation silently does nothing proves nothing.
 */
import { execFileSync } from 'node:child_process';
import {
  chmodSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { createDocsSubstrate, TASK_CLASS } from './docs-substrate.ts';

const REPO_ROOT = fileURLToPath(new URL('../../', import.meta.url));
const DRIVER = join(REPO_ROOT, 'scripts', 'certify-class.sh');

/** The sentinel the substituted credential command prints. It must never escape. */
const SENTINEL = 'sk-certify-sentinel-do-not-print';

interface StubRun {
  readonly code: number;
  readonly body: Record<string, unknown>;
}

interface StubAudit {
  readonly body: Record<string, unknown>;
  readonly code: number;
}

interface DriverResult {
  readonly code: number;
  readonly stdout: string;
  readonly stderr: string;
}

/**
 * A stand-in for the CLI: it records every invocation and replays a scripted table. It exists
 * because the stop condition is `factory run`'s exit code, and replaying exit codes is how that
 * decision gets tested without a wall, a mirror or a git object in the way.
 */
const STUB_FACTORY = `import { appendFileSync, readFileSync } from 'node:fs';

const [verb, ...rest] = process.argv.slice(2);
appendFileSync(process.env.STUB_CALLS ?? '/dev/null', \`\${verb} \${rest.join(' ')}\\n\`);
const script = JSON.parse(readFileSync(process.env.STUB_SCRIPT ?? '/dev/null', 'utf8'));

if (verb === 'run') {
  const entry = script.runs[rest[0]] ?? { code: 8, body: { ok: false, code: 'EXECUTOR_UNAVAILABLE' } };
  process.stdout.write(\`\${JSON.stringify(entry.body)}\\n\`);
  process.exit(entry.code);
}
if (verb === 'audit') {
  process.stdout.write(\`\${JSON.stringify(script.audit.body)}\\n\`);
  process.exit(script.audit.code);
}
process.stdout.write('{}\\n');
process.exit(0);
`;

/** The substituted credential command. It counts its invocations, so "per run" is proven. */
const STUB_KEY = `#!/bin/sh
printf 'called\\n' >> "\${STUB_KEY_CALLS:-/dev/null}"
printf '${SENTINEL}\\n'
`;

interface DriverHarness {
  readonly root: string;
  readonly home: string;
  readonly unitsFile: string;
  readonly stubScript: string;
  readonly callsFile: string;
  readonly keyCallsFile: string;
  /** Run the driver with the stub CLI and stub credential; returns what the operator saw. */
  run(
    units: readonly string[],
    options?: { readonly script?: StubScript; readonly env?: Record<string, string> },
  ): DriverResult;
  /** Run a *mutated copy* of the driver (the mutation check). */
  runMutated(units: readonly string[], script: StubScript): DriverResult;
  /** Number of `run <unitId>` invocations the stub CLI saw, in order. */
  runCalls(): readonly string[];
  keyCalls(): number;
  cleanup(): void;
}

interface StubScript {
  readonly runs: Record<string, StubRun>;
  readonly audit: StubAudit;
}

const NEVER_CERTIFIED: StubAudit = {
  code: 1,
  body: {
    kind: 'certifications',
    classes: [
      {
        taskClass: TASK_CLASS,
        state: 'never-certified',
        outcome: 'insufficient',
        samples: 4,
        m: 20,
        alpha: 0.07548367378849634,
        reasons: [],
      },
    ],
  },
};

const CERTIFIED: StubAudit = {
  code: 0,
  body: {
    kind: 'certifications',
    classes: [
      {
        taskClass: TASK_CLASS,
        state: 'current',
        outcome: 'certified',
        samples: 20,
        m: 20,
        alpha: 0.07548367378849634,
        reasons: [],
      },
    ],
  },
};

const PASS: StubRun = { code: 0, body: { ok: true, outcome: 'pass' } };
const FAIL: StubRun = { code: 3, body: { ok: true, outcome: 'fail' } };

function pass(): StubRun {
  return PASS;
}

function fail(): StubRun {
  return FAIL;
}

function makeHarness(): DriverHarness {
  const substrate = createDocsSubstrate({ units: 1 });
  const root = mkdtempSync(join(tmpdir(), 'certify-driver-'));
  const stubFactory = join(root, 'factory-stub.mjs');
  const stubKey = join(root, 'key-stub.sh');
  const stubScript = join(root, 'script.json');
  const callsFile = join(root, 'factory-calls.log');
  const keyCallsFile = join(root, 'key-calls.log');
  writeFileSync(stubFactory, STUB_FACTORY);
  writeFileSync(stubKey, STUB_KEY);
  chmodSync(stubKey, 0o755);
  writeFileSync(callsFile, '');
  writeFileSync(keyCallsFile, '');
  const unitsFile = join(root, 'units.txt');

  const baseEnv: Record<string, string> = {
    PATH: [dirname(process.execPath), '/usr/bin', '/bin', '/usr/sbin', '/sbin'].join(':'),
    TERM: 'dumb',
    NO_COLOR: '1',
    FACTORY_HOME: substrate.home,
    FACTORY_HOLDOUT_ROOT: substrate.holdoutRoot,
    FACTORY_HOLDOUT_TASK_CLASS: TASK_CLASS,
    FACTORY_EXECUTOR: 'fake',
    CERTIFY_KEY_COMMAND: stubKey,
    CERTIFY_FACTORY_ENTRY: stubFactory,
    CERTIFY_ROOT: REPO_ROOT,
    STUB_SCRIPT: stubScript,
    STUB_CALLS: callsFile,
    STUB_KEY_CALLS: keyCallsFile,
  };

  const writeScript = (script: StubScript): void => {
    writeFileSync(stubScript, `${JSON.stringify(script, null, 2)}\n`);
  };

  const runWith = (
    driverPath: string,
    units: readonly string[],
    env: Record<string, string>,
  ): DriverResult => {
    // One invocation, one transcript: a test that asserts on the calls of *this* run must not see
    // the rows of the previous one.
    writeFileSync(callsFile, '');
    writeFileSync(keyCallsFile, '');
    writeFileSync(unitsFile, `${units.join('\n')}\n`);
    const merged = { ...baseEnv, ...env };
    try {
      const stdout = execFileSync('bash', [driverPath, '--units-file', unitsFile], {
        encoding: 'utf8',
        env: merged,
        timeout: 120_000,
      });
      return { code: 0, stdout, stderr: '' };
    } catch (error) {
      const failure = error as { status?: number; stdout?: string; stderr?: string };
      return {
        code: failure.status ?? -1,
        stdout: typeof failure.stdout === 'string' ? failure.stdout : '',
        stderr: typeof failure.stderr === 'string' ? failure.stderr : '',
      };
    }
  };

  const harness: DriverHarness = {
    root,
    home: substrate.home,
    unitsFile,
    stubScript,
    callsFile,
    keyCallsFile,
    run(units, options = {}) {
      if (options.script !== undefined) writeScript(options.script);
      return runWith(DRIVER, units, options.env ?? {});
    },
    runMutated(units, script) {
      writeScript(script);
      const source = readFileSync(DRIVER, 'utf8');
      const needle = 'ALLOWED_FAILURES=$((M - K))';
      // The mutation guard: if the budget line moves or is renamed, this fails loudly instead of
      // running an unmutated script and reporting "the mutation did not change the behaviour".
      expect(source).toContain(needle);
      const mutated = source.replace(needle, 'ALLOWED_FAILURES=$((M - K + 1))');
      expect(mutated).not.toBe(source);
      const mutatedPath = join(root, 'certify-class.mutated.sh');
      writeFileSync(mutatedPath, mutated);
      return runWith(mutatedPath, units, {});
    },
    runCalls() {
      return readFileSync(callsFile, 'utf8')
        .split('\n')
        .filter((line) => line.startsWith('run '))
        .map((line) => line.slice('run '.length))
        .map((line) => line.split(' ')[0] ?? '');
    },
    keyCalls() {
      return readFileSync(keyCallsFile, 'utf8')
        .split('\n')
        .filter((line) => line.length > 0).length;
    },
    cleanup() {
      substrate.cleanup();
      rmSync(root, { recursive: true, force: true });
    },
  };
  return harness;
}

/** Every file under `dir`, so a leak assertion is "nowhere on disk", not "nowhere I looked". */
function filesUnder(dir: string): readonly string[] {
  const out: string[] = [];
  const walk = (current: string): void => {
    for (const name of readdirSync(current)) {
      const path = join(current, name);
      if (statSync(path).isDirectory()) walk(path);
      else out.push(path);
    }
  };
  walk(dir);
  return out;
}

describe('scripts/certify-class.sh', () => {
  let harness: DriverHarness;

  beforeAll(() => {
    harness = makeHarness();
  });

  afterAll(() => {
    harness.cleanup();
  });

  it('refuses to spend without a corpus, a task class or a store', () => {
    const units = ['U-stub-1'];
    const script: StubScript = { runs: {}, audit: NEVER_CERTIFIED };

    const noCorpus = harness.run(units, {
      script,
      env: { FACTORY_HOLDOUT_ROOT: '' },
    });
    expect(noCorpus.code).toBe(2);
    expect(noCorpus.stderr).toContain('FACTORY_HOLDOUT_ROOT');

    const noClass = harness.run(units, {
      script,
      env: { FACTORY_HOLDOUT_TASK_CLASS: '' },
    });
    expect(noClass.code).toBe(2);
    expect(noClass.stderr).toContain('FACTORY_HOLDOUT_TASK_CLASS');

    const noHome = harness.run(units, { script, env: { FACTORY_HOME: '' } });
    expect(noHome.code).toBe(2);
    expect(noHome.stderr).toContain('FACTORY_HOME');

    const before = harness.runCalls().length;
    expect(before).toBe(0);
  });

  it('reads the credential once per run and never writes or prints it', () => {
    const units = ['U-stub-a', 'U-stub-b'];
    const result = harness.run(units, {
      script: {
        runs: { 'U-stub-a': pass(), 'U-stub-b': fail() },
        audit: NEVER_CERTIFIED,
      },
    });

    // Once per `factory run`, not once per loop and not zero times.
    expect(harness.keyCalls()).toBe(2);
    expect(harness.runCalls()).toEqual(['U-stub-a', 'U-stub-b']);
    // The value exists in neither stream...
    expect(result.stdout).not.toContain(SENTINEL);
    expect(result.stderr).not.toContain(SENTINEL);
    // ...and in no file the driver produced. (The stub's own counter file lives outside the
    // factory home; everything under the home is the driver's.)
    const leaked = filesUnder(harness.home).filter((path) =>
      readFileSync(path, 'utf8').includes(SENTINEL),
    );
    expect(leaked).toEqual([]);
    // The per-unit line names the unit, the exit code, the outcome and the running tally.
    expect(result.stdout).toMatch(/U-stub-a\s+0\s+pass\s+1\s+0\s+1/u);
    expect(result.stdout).toMatch(/U-stub-b\s+3\s+fail\s+1\s+1\s+2/u);
  });

  it('does not stop early at m - k failures, and stops at m - k + 1', () => {
    // The plan: two failures, then a pass (this is where a driver that stopped at the *first*
    // failure, or at m - k failures, would diverge), then a third failure, then a unit that
    // must never be dispatched. m = 20, k = 18, so m - k = 2 and the stop is the third failure.
    const units = ['U-a', 'U-b', 'U-c', 'U-d', 'U-never'];
    const result = harness.run(units, {
      script: {
        runs: {
          'U-a': fail(),
          'U-b': fail(),
          'U-c': pass(),
          'U-d': fail(),
          'U-never': pass(),
        },
        audit: NEVER_CERTIFIED,
      },
    });

    // Two failures did not stop it: the third and fourth units were dispatched.
    expect(harness.runCalls()).toEqual(['U-a', 'U-b', 'U-c', 'U-d']);
    expect(result.stdout).toContain('stop failure-budget-exhausted');
    expect(harness.runCalls()).not.toContain('U-never');
    // The tally is cumulative and the row that stopped it is the third failure.
    expect(result.stdout).toMatch(/U-d\s+3\s+fail\s+1\s+3\s+4/u);
    // The driver reports the wall's operating point (m=20 k=18) rather than a private guess.
    expect(result.stdout).toContain('m=20 k=18');
    expect(result.stdout).toContain('allowed failures 2 (m - k)');
    expect(result.stdout).toContain('a certificate becomes impossible at 3');
    // No certificate exists, so the drive does not claim one.
    expect(result.code).toBe(1);
  });

  it('mutation: a budget of m - k + 1 does not stop at the (m - k + 1)th failure', () => {
    // Same plan as above. With the allowed-failures budget widened by one, the third failure is
    // no longer the stop, so the fifth unit is dispatched — which is exactly the behaviour the
    // previous test forbids. If this ever passes, the previous assertion has lost its teeth.
    const units = ['U-a', 'U-b', 'U-c', 'U-d', 'U-never'];
    const result = harness.runMutated(units, {
      runs: {
        'U-a': fail(),
        'U-b': fail(),
        'U-c': pass(),
        'U-d': fail(),
        'U-never': pass(),
      },
      audit: NEVER_CERTIFIED,
    });

    expect(harness.runCalls()).toEqual(['U-a', 'U-b', 'U-c', 'U-d', 'U-never']);
    expect(result.stdout).not.toContain('stop failure-budget-exhausted');
    // The plan ran out before the operating point; that is a named ending, not a silent pass.
    expect(result.stdout).toContain('stop units-exhausted');
    expect(result.code).toBe(2);
  });

  it('stops on a budget refusal (exit 6) and on an environment refusal (exit 8), naming each', () => {
    const budget = harness.run(['U-budget', 'U-after'], {
      script: {
        runs: {
          'U-budget': { code: 6, body: { ok: false, code: 'BUDGET_EXCEEDED' } },
          'U-after': pass(),
        },
        audit: NEVER_CERTIFIED,
      },
    });
    expect(budget.code).toBe(6);
    expect(budget.stdout).toContain('stop budget-refusal');
    expect(harness.runCalls()).toEqual(['U-budget']);

    const environment = harness.run(['U-env', 'U-after'], {
      script: {
        runs: {
          'U-env': { code: 8, body: { ok: false, code: 'EXECUTOR_UNAVAILABLE' } },
          'U-after': pass(),
        },
        audit: NEVER_CERTIFIED,
      },
    });
    expect(environment.code).toBe(8);
    expect(environment.stdout).toContain('stop environment-refusal');
    expect(harness.runCalls()).toEqual(['U-env']);
  });

  it('reports the store certificate, not its own tally: a current certificate exits 0', () => {
    const result = harness.run(['U-1', 'U-2'], {
      script: {
        runs: { 'U-1': pass(), 'U-2': pass() },
        audit: CERTIFIED,
      },
    });
    expect(result.code).toBe(0);
    expect(result.stdout).toContain('state=current');
    expect(result.stdout).toContain('outcome=certified');
    expect(result.stdout).toContain('samples=20');
  });

  it('refuses before spending when the credential cannot be read', () => {
    // A stub that prints nothing is an unreachable key: the driver must stop before the first
    // dispatch, because a run without consent is a paid call the operator did not authorise.
    const emptyKey = join(harness.root, 'empty-key.sh');
    writeFileSync(emptyKey, '#!/bin/sh\nexit 1\n');
    chmodSync(emptyKey, 0o755);
    const result = harness.run(['U-1'], {
      script: { runs: { 'U-1': pass() }, audit: NEVER_CERTIFIED },
      env: { CERTIFY_KEY_COMMAND: emptyKey },
    });
    expect(harness.runCalls()).toEqual([]);
    expect(result.stderr).toContain('credential-unavailable');
    expect(result.code).toBe(8);
  });
});

// The harness is also exercised with the *real* CLI in driver-integration.test.ts, which is where
// the "exit 3 means a measured fail" mapping is proven against a real wall verdict.
