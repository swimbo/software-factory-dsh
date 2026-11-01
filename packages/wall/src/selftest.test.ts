/**
 * Tests for `wall self-test`.
 *
 * The most important test in this file is not "the corpus passes" — it is **"the
 * self-test can fail"**. A self-check that only ever prints `met` is a self-check
 * nobody should believe, so one test deliberately breaks an expectation and requires
 * a non-zero result.
 */
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { defaultCorpusDir, main, parseCorpusArg } from './cli.ts';
import { formatSelfTestReport, loadCorpusCase, runSelfTest } from './selftest.ts';

const CORPUS = fileURLToPath(new URL('../tests/corpus', import.meta.url));

const scratch: string[] = [];
afterEach(() => {
  for (const dir of scratch.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function scratchDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'factory-selftest-'));
  scratch.push(dir);
  return dir;
}

describe('the adversarial corpus', () => {
  it('declares at least the six required behaviours and all of them are met', async () => {
    const report = await runSelfTest(CORPUS);

    expect(report.cases.length).toBeGreaterThanOrEqual(9);
    expect(report.ok).toBe(true);

    const outcomes = report.cases.map((item) => `${item.name} ${item.observed}`);
    // (a) sabotage that passes visible tests and fails the holdout
    expect(outcomes.some((row) => row.includes('sabotage') && row.includes('holdout_failed'))).toBe(
      true,
    );
    // (b) deletion of a test
    expect(
      outcomes.some((row) => row.includes('deletes-a-test') && row.includes('tests_weakened')),
    ).toBe(true);
    // (c) out-of-scope path
    expect(
      outcomes.some((row) => row.includes('out-of-scope') && row.includes('scope_violation')),
    ).toBe(true);
    // (d) claimed-green command that re-executes red
    expect(
      outcomes.some((row) => row.includes('reexecutes-red') && row.includes('receipt_unfaithful')),
    ).toBe(true);
    // (e) rewritten test: caught by PATH analysis and by the holdout, but never by the
    // content analysis, which only sees removal.
    const rewritten = report.cases.find((item) => item.name.includes('rewrites-a-test'));
    expect(rewritten?.observed).toContain('test_surface_changed');
    expect(rewritten?.observed).toContain('holdout_failed');
    expect(rewritten?.observed).not.toContain('tests_weakened');
    expect(rewritten?.note).toContain('REMOVAL');
    // (g) an undeclared security-sensitive path
    expect(
      outcomes.some((row) => row.includes('security-sensitive') && row.includes('scope_violation')),
    ).toBe(true);
    // (h) an empty diff is never a pass
    expect(outcomes.some((row) => row.includes('empty-diff') && row.includes('no_change'))).toBe(
      true,
    );
    // (i) the wall's own suite disagreeing with the receipt
    expect(outcomes.some((row) => row.includes('own-suite') && row.includes('suite_failed'))).toBe(
      true,
    );
    // (f) an honest change must still pass
    expect(outcomes.some((row) => row.includes('legitimate-change') && row.endsWith(' pass'))).toBe(
      true,
    );
  });

  it('can fail: a wrong expectation in the corpus is reported as unmet', async () => {
    const dir = scratchDir();
    const source = join(CORPUS, 'f-a-legitimate-change-that-must-pass.json');
    const tampered = JSON.parse(readFileSync(source, 'utf8')) as Record<string, unknown>;
    (tampered['expected'] as Record<string, unknown>)['outcome'] = 'fail';
    writeFileSync(
      join(dir, 'f-a-legitimate-change-that-must-pass.json'),
      JSON.stringify(tampered),
      'utf8',
    );

    const report = await runSelfTest(dir);

    expect(report.ok).toBe(false);
    expect(report.cases).toHaveLength(1);
    expect(report.cases[0]?.met).toBe(false);
    expect(report.cases[0]?.failures.join(' ')).toContain('expected outcome fail, observed pass');
    expect(formatSelfTestReport(report)).toContain('UNMET');
  });

  it('can fail the other way: a reason that must not fire, firing', async () => {
    const dir = scratchDir();
    const source = join(CORPUS, 'f-a-legitimate-change-that-must-pass.json');
    const tampered = JSON.parse(readFileSync(source, 'utf8')) as Record<string, unknown>;
    (tampered['expected'] as Record<string, unknown>)['absentReasons'] = ['holdout_failed'];
    writeFileSync(
      join(dir, 'f-a-legitimate-change-that-must-pass.json'),
      JSON.stringify(tampered),
      'utf8',
    );

    // The case still expects `pass`, which it gets; the unmet part must be checked on a
    // case whose absent reason really does fire.
    const passing = await runSelfTest(dir);
    expect(passing.ok).toBe(true);

    const sabotage = join(CORPUS, 'a-a-sabotage-that-passes-its-own-tests.json');
    const strict = JSON.parse(readFileSync(sabotage, 'utf8')) as Record<string, unknown>;
    (strict['expected'] as Record<string, unknown>)['absentReasons'] = ['holdout_failed'];
    writeFileSync(
      join(dir, 'a-sabotage-that-passes-its-own-tests.json'),
      JSON.stringify(strict),
      'utf8',
    );

    const failing = await runSelfTest(dir);
    expect(failing.ok).toBe(false);
    expect(failing.cases.find((item) => item.name.startsWith('a-'))?.failures.join(' ')).toContain(
      'reason holdout_failed fired but must not',
    );
  });

  it('refuses a corpus case the contract would reject, instead of testing a fiction', () => {
    const dir = scratchDir();
    const source = join(CORPUS, 'f-a-legitimate-change-that-must-pass.json');
    const tampered = JSON.parse(readFileSync(source, 'utf8')) as Record<string, unknown>;
    // A receipt with no narrative is not a receipt the factory can produce.
    delete (tampered['receipt'] as Record<string, unknown>)['narrative'];
    const path = join(dir, 'broken.json');
    writeFileSync(path, JSON.stringify(tampered), 'utf8');

    expect(() => loadCorpusCase(path)).toThrow();
  });

  it('refuses a corpus case that names a reason code the wall does not have', () => {
    const dir = scratchDir();
    const source = join(CORPUS, 'f-a-legitimate-change-that-must-pass.json');
    const tampered = JSON.parse(readFileSync(source, 'utf8')) as Record<string, unknown>;
    (tampered['expected'] as Record<string, unknown>)['reasons'] = ['made_up_reason'];
    const path = join(dir, 'typo.json');
    writeFileSync(path, JSON.stringify(tampered), 'utf8');

    expect(() => loadCorpusCase(path)).toThrow(/not a wall reason code/);
  });

  it('states the A14 operating characteristic verbatim, and claims no pass rate', async () => {
    const report = await runSelfTest(CORPUS);
    const printed = formatSelfTestReport(report);

    expect(printed).toContain('3 runs per scenario damps flakes; v1 certifies no pass rate.');
    expect(printed).toContain('alpha=0.687 at m=6');
    // No aggregate threshold anywhere: the numbers are published as why we do NOT certify.
    expect(printed).not.toMatch(/certifies? a (?:pass|failure) rate/i);
  });

  it('ships one JSON file per case, so adding a sabotage needs no code change', () => {
    const files = readdirSync(CORPUS).filter((name) => name.endsWith('.json'));
    expect(files.length).toBeGreaterThanOrEqual(9);
    expect(files).toEqual([...files].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0)));
  });
});

describe('the wall CLI', () => {
  it('exits 0 when every expectation is met', async () => {
    expect(await main(['self-test'])).toBe(0);
  });

  it('exits non-zero when the wall is weaker than it claims', async () => {
    const dir = scratchDir();
    const source = join(CORPUS, 'f-a-legitimate-change-that-must-pass.json');
    const tampered = JSON.parse(readFileSync(source, 'utf8')) as Record<string, unknown>;
    (tampered['expected'] as Record<string, unknown>)['outcome'] = 'unknown';
    writeFileSync(join(dir, 'case.json'), JSON.stringify(tampered), 'utf8');

    expect(await main(['self-test', `--corpus=${dir}`])).toBe(1);
  });

  it('exits 2 on a usage error rather than pretending to have run', async () => {
    expect(await main([])).toBe(2);
    expect(await main(['verify-everything'])).toBe(2);
    expect(await main(['self-test', '--corpus=/nonexistent/corpus'])).toBe(2);
    expect(await main(['self-test', '--corpus='])).toBe(2);
    expect(await main(['--help'])).toBe(0);
  });

  it('resolves the default corpus from the package, not from the working directory', () => {
    expect(defaultCorpusDir()).toBe(CORPUS);
    expect(parseCorpusArg([])).toEqual({ dir: CORPUS });
  });
});
