/**
 * `factory intent` — where a bad spec is cheapest to catch.
 *
 * Two properties are tested because they are the two ways this command can waste
 * the operator's attention: a refusal that does not name where the mistake is
 * (they must re-read a 40-line file to find one wrong word), and a duplicate
 * submission that silently creates a second unit or fails when it should be a
 * no-op.
 */
import { describe, expect, it } from 'vitest';

import { EXIT } from './exit.ts';
import { baseSpec, jsonOf, runCli, tempHome, writeRestate, writeSpec } from './testing.ts';

describe('a valid spec', () => {
  it('exits 0, prints the unit id on stderr, and keeps stdout empty', () => {
    const home = tempHome();
    const file = writeSpec(home);
    const restate = writeRestate(home, String(baseSpec()['restateBack']));
    const result = runCli(['intent', '--file', file, '--restate', restate], { home });
    expect(result.status).toBe(EXIT.ok);
    expect(result.stdout).toBe('');
    expect(result.stderr).toMatch(/UNIT\s+U-[0-9a-f]+/u);
  });

  it('warns, and still succeeds, when no restate-back is supplied', () => {
    const home = tempHome();
    const file = writeSpec(home);
    const result = runCli(['intent', '--file', file], { home });
    expect(result.status).toBe(EXIT.ok);
    expect(result.stderr).toContain('INTENT_NOT_DERIVABLE');
  });

  it('prints exactly one JSON object with the ids the ledger uses', () => {
    const home = tempHome();
    const file = writeSpec(home);
    const json = jsonOf(runCli(['intent', '--file', file, '--json'], { home }));
    expect(json).toMatchObject({
      ok: true,
      slug: 'slug-check',
      repo: 'fixture',
      revision: 1,
      created: true,
    });
    expect(String(json['unitId'])).toMatch(/^U-/u);
    expect(String(json['specHash'])).toMatch(/^sha256:[0-9a-f]{64}$/u);
  });
});

describe('a spec that breaks the schema', () => {
  it('exits 3 SPEC_INVALID naming the exact schema path', () => {
    const home = tempHome();
    const file = writeSpec(home, {
      acceptance: [
        {
          id: 'manual',
          text: 'the reviewer eyeballs it',
          oracle: { kind: 'manual', target: 'a human', expect: 'looks right' },
        },
      ],
    });
    const result = runCli(['intent', '--file', file], { home });
    expect(result.status).toBe(EXIT.policy);
    expect(result.stderr).toContain('SPEC_INVALID');
    expect(result.stderr).toContain('acceptance[0].oracle.kind');
  });

  it('names the file and a line number, so the operator can jump to it', () => {
    const home = tempHome();
    const file = writeSpec(home, { baseRev: 'HEAD' });
    const result = runCli(['intent', '--file', file], { home });
    expect(result.status).toBe(EXIT.policy);
    expect(result.stderr).toMatch(/spec\.json:\d+:\d+/u);
  });

  it('refuses an unreadable file rather than creating a unit', () => {
    const home = tempHome();
    const result = runCli(['intent', '--file', `${home}/nope.json`], { home });
    expect(result.status).toBe(EXIT.policy);
    expect(result.stderr).toContain('SPEC_INVALID');
  });

  it('refuses a restate-back file that does not match the spec, because the hash is what binds', () => {
    const home = tempHome();
    const file = writeSpec(home);
    const restate = writeRestate(
      home,
      'something else entirely, quite different from the spec text',
    );
    const result = runCli(['intent', '--file', file, '--restate', restate], { home });
    expect(result.status).toBe(EXIT.policy);
    expect(result.stderr).toContain('restateBack');
  });
});

describe('a duplicate submission', () => {
  it('is idempotent: same unit id, exit 0, "existing" wording, no second unit', () => {
    const home = tempHome();
    const file = writeSpec(home);
    const first = jsonOf(runCli(['intent', '--file', file, '--json'], { home }));
    const second = runCli(['intent', '--file', file], { home });
    expect(second.status).toBe(EXIT.ok);
    expect(second.stderr).toContain('existing');
    const again = jsonOf(runCli(['intent', '--file', file, '--json'], { home }));
    expect(again['unitId']).toBe(first['unitId']);
    expect(again['created']).toBe(false);
  });

  it('refuses the same slug and revision with different content (the intent changed)', () => {
    const home = tempHome();
    runCli(['intent', '--file', writeSpec(home)], { home });
    const changed = writeSpec(
      home,
      { intent: 'A completely different intent, with more words in it to pass the minimum.' },
      'changed.json',
    );
    const result = runCli(['intent', '--file', changed], { home });
    expect(result.status).toBe(EXIT.policy);
    expect(result.stderr).toContain('DUPLICATE_UNIT');
  });
});

describe('argument handling', () => {
  it('exits 2 when --file is missing', () => {
    const result = runCli(['intent']);
    expect(result.status).toBe(EXIT.usage);
    expect(result.stderr).toContain('--file');
  });

  it('exits 2 for a bypass flag even on a non-gated verb', () => {
    expect(runCli(['intent', '--yes']).status).toBe(EXIT.usage);
  });
});

describe('the spec fixture itself', () => {
  it('is the spec the other tests claim it is (guards against a fixture that stops parsing)', () => {
    expect(baseSpec()).toMatchObject({ slug: 'slug-check', operationClasses: ['code-change'] });
  });
});
