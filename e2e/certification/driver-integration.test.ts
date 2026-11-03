/**
 * The driver, over real `factory run` invocations: does "the third failure stops it" survive
 * contact with an actual wall verdict?
 *
 * `driver.test.ts` proves the stop arithmetic against a stubbed CLI, which is the right way to test
 * a decision that is a function of exit codes — but it cannot prove that a real verdict produces the
 * exit code the driver reads, nor that the credential substitution is the only thing standing
 * between the driver and a paid call. Both are checked here, offline: the executor is scripted
 * (`FACTORY_EXECUTOR=fake`), so every unit is a real mirror, clone, receipt, wall evaluation and
 * verdict with no model in the loop, and the credential command is a stub whose value is then hunted
 * for in the transcript and on disk.
 *
 * The plan is [fail, fail, pass, fail, pass]: two failures must not stop the loop (m - k = 2 is the
 * budget, the third failure is the stop), so the third and fourth units are dispatched and the
 * fifth is not. The last two rows are the interesting ones — one proves the driver did not stop
 * early, the other proves it did stop.
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

import { openStore } from '../../packages/store/src/index.ts';
import {
  almostFixedDocs,
  createDocsSubstrate,
  TASK_CLASS,
  writeCandidateScenario,
  type DocsSubstrate,
} from './docs-substrate.ts';

const REPO_ROOT = fileURLToPath(new URL('../../', import.meta.url));
const DRIVER = join(REPO_ROOT, 'scripts', 'certify-class.sh');
const SENTINEL = 'sk-driver-integration-sentinel-do-not-print';

/** Which units get the almost-fixed patch: the 1st, 2nd and 4th dispatched. */
const SHOULD_FAIL = new Set([0, 1, 3]);

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

let substrate: DocsSubstrate;
let unitIds: readonly string[];
let scratch: string;
let keyCalls: string;

beforeAll(() => {
  substrate = createDocsSubstrate({ units: 5 });
  scratch = mkdtempSync(join(tmpdir(), 'certify-driver-live-'));
  keyCalls = join(scratch, 'key-calls.log');
  writeFileSync(keyCalls, '');

  // The substituted credential command: prints a sentinel and records that it ran, so "once per
  // run" is a count rather than a promise. The real `ssh … cat …/credential` line is never run.
  const stubKey = join(scratch, 'key-stub.sh');
  writeFileSync(
    stubKey,
    `#!/bin/sh\nprintf 'called\\n' >> "${keyCalls}"\nprintf '${SENTINEL}\\n'\n`,
  );
  chmodSync(stubKey, 0o755);

  unitIds = substrate.units.map((unit, index) => {
    if (SHOULD_FAIL.has(index)) {
      writeCandidateScenario(unit.scenarioPath, unit, almostFixedDocs(unit.index));
    }
    return substrate.submit(unit);
  });
  writeFileSync(join(scratch, 'key-stub.sh.permissions'), '');
  // The driver reads the credential command from its environment; the stub path is the whole
  // substitution.
  writeFileSync(join(scratch, 'key-command'), stubKey);
}, 120_000);

afterAll(() => {
  substrate.cleanup();
  rmSync(scratch, { recursive: true, force: true });
});

describe('scripts/certify-class.sh over real verdicts', () => {
  it('dispatches, reads the key per run, and stops at the third failure without running the fifth unit', () => {
    const stubKey = readFileSync(join(scratch, 'key-command'), 'utf8');
    const unitsFile = join(scratch, 'units.txt');
    writeFileSync(unitsFile, `${unitIds.join('\n')}\n`);
    const env: Record<string, string> = {
      PATH: [dirname(process.execPath), '/usr/bin', '/bin', '/usr/sbin', '/sbin'].join(':'),
      TERM: 'dumb',
      NO_COLOR: '1',
      FACTORY_HOME: substrate.home,
      CERTIFY_KEY_COMMAND: stubKey,
      CERTIFY_ROOT: REPO_ROOT,
      ...substrate.wallEnv(),
    };

    let code = 0;
    let stdout = '';
    let stderr = '';
    try {
      stdout = execFileSync('bash', [DRIVER, '--units-file', unitsFile], {
        encoding: 'utf8',
        env,
        timeout: 240_000,
      });
    } catch (error) {
      const failure = error as { status?: number; stdout?: string; stderr?: string };
      code = failure.status ?? -1;
      stdout = typeof failure.stdout === 'string' ? failure.stdout : '';
      stderr = typeof failure.stderr === 'string' ? failure.stderr : '';
    }

    // Four dispatches, then the stop. The exit is 1: the loop ended without a certificate, which
    // is the honest outcome for a four-unit plan against m = 20.
    expect(code, stderr).toBe(1);
    expect(stdout).toContain('stop failure-budget-exhausted');
    expect(stdout).toContain('m=20 k=18');
    expect(stdout).toContain('allowed failures 2 (m - k)');
    // The row that stopped it, then the tally.
    expect(stdout).toMatch(new RegExp(`${unitIds[3] ?? '?'}\\s+3\\s+fail\\s+1\\s+3\\s+4`, 'u'));
    expect(stdout).not.toContain(unitIds[4] ?? '?');

    // The credential was read once per dispatch (four dispatches, four reads), and its value is
    // nowhere the operator could find it afterwards.
    expect(
      readFileSync(keyCalls, 'utf8')
        .split('\n')
        .filter((line) => line.length > 0),
    ).toHaveLength(4);
    expect(stdout).not.toContain(SENTINEL);
    expect(stderr).not.toContain(SENTINEL);
    const leaked = filesUnder(substrate.home).filter((path) =>
      readFileSync(path, 'utf8').includes(SENTINEL),
    );
    expect(leaked).toEqual([]);

    // The fifth unit was never dispatched, so the store has no attempt for it at all — not a
    // planned attempt, not an aborted one. This is the claim that spending stopped.
    const store = openStore({ dir: join(substrate.home, 'state') });
    try {
      const fifth = unitIds[4] ?? '';
      expect(store.listAttemptsForUnit(fifth)).toEqual([]);
      const fourth = unitIds[3] ?? '';
      const verdict = store.latestVerdictForUnit(fourth);
      expect(verdict?.verdict.outcome).toBe('fail');
      expect(verdict?.verdict.reasons).toEqual(['holdout_failed']);
      // A real fail exit code (3) really did become the driver's "fail" row: this is the mapping
      // the stubbed test assumed.
      const first = unitIds[0] ?? '';
      expect(store.latestVerdictForUnit(first)?.verdict.outcome).toBe('fail');
      const third = unitIds[2] ?? '';
      expect(store.latestVerdictForUnit(third)?.verdict.outcome).toBe('pass');
    } finally {
      store.close();
    }

    // The driver prints the store's own answer at the end, and it is never-certified: four
    // measured revisions are not twenty.
    expect(stdout).toContain('state=never-certified');
    expect(stdout).toContain(`class ${TASK_CLASS}`);
  }, 300_000);
});
