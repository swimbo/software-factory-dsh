/**
 * The `--json` contract for `factory class`, through the real binary.
 *
 * The contract is one line in `ux-plan.md` §6 and it is easy to break from inside a verb: *human text goes to
 * stderr; `--json` prints exactly one object on stdout*. This verb broke it — its report was written with
 * `console.log`, so `class doctor --json` printed a dozen sentences and then the object, and the first script
 * that tried to read it failed on `Expecting value: line 1 column 3`. The bug was found by scripting the
 * command, which is the point: a machine surface is only tested by a machine.
 *
 * The specs run `main.ts` as a process, because the defect is in where the bytes go, not in what they say.
 */
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

const ROOT = join(import.meta.dirname, '..', '..', '..', '..');
const scratch: string[] = [];

afterEach(() => {
  for (const dir of scratch.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function factory(
  args: readonly string[],
  home: string,
): { code: number; stdout: string; stderr: string } {
  const result = spawnSync(process.execPath, ['apps/cli/src/main.ts', ...args], {
    cwd: ROOT,
    encoding: 'utf8',
    env: { ...process.env, FACTORY_HOME: home },
  });
  return { code: result.status ?? -1, stdout: result.stdout ?? '', stderr: result.stderr ?? '' };
}

describe('factory class obeys the --json contract', () => {
  it('writes exactly one JSON object to stdout, with every human line on stderr', () => {
    const home = mkdtempSync(join(tmpdir(), 'factory-class-json-'));
    scratch.push(home);
    const corpus = mkdtempSync(join(tmpdir(), 'factory-class-corpus-'));
    scratch.push(corpus);

    const scaffold = factory(
      [
        'class',
        'new',
        '--class',
        'whitespace-hygiene',
        '--root',
        corpus,
        '--rule',
        'no-trailing-whitespace',
        '--visible',
        'node tools/check-whitespace.mjs',
        '--json',
      ],
      home,
    );
    expect(scaffold.code, scaffold.stderr).toBe(0);
    // One object, parseable on its own: no leading sentence, no trailing advice.
    const created = JSON.parse(scaffold.stdout) as { ok: boolean; revision: string };
    expect(created.ok).toBe(true);
    expect(created.revision).toMatch(/^h-whitespace-hygiene-/u);
    expect(scaffold.stderr).toContain('wrote');

    const doctor = factory(
      ['class', 'doctor', '--class', 'whitespace-hygiene', '--root', corpus, '--json'],
      home,
    );
    // The refusal is the exit code and the payload; the human report is on stderr.
    expect(doctor.code).toBe(3);
    const report = JSON.parse(doctor.stdout) as {
      ok: boolean;
      exitCode: number;
      findings: { id: string; severity: string }[];
    };
    expect(report.ok).toBe(false);
    expect(report.exitCode).toBe(3);
    expect(report.findings.some((finding) => finding.severity === 'policy')).toBe(true);
    expect(doctor.stderr).toContain('CLASS DOCTOR');
  }, 120_000);
});
