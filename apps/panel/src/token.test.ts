/**
 * Token resolution — `env` first, then the `0600` file, then creation.
 *
 * The failure modes are the interesting part: a blank `FACTORY_PANEL_TOKEN`, an
 * empty token file, and a directory that cannot be created must all stop the panel
 * with a message instead of starting it with a token nobody can guess or, worse,
 * with no token at all.
 */
import { chmodSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { generateToken, resolvePanelToken, tokenFilePath } from './token.ts';

let home: string;
beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'factory-panel-home-'));
});
afterEach(() => {
  rmSync(home, { recursive: true, force: true });
});

describe('where the token comes from', () => {
  it('prefers FACTORY_PANEL_TOKEN', () => {
    const resolved = resolvePanelToken({ FACTORY_PANEL_TOKEN: 'env-token' }, home);
    expect(resolved).toMatchObject({ ok: true, token: 'env-token', source: 'env' });
  });

  it('honours FACTORY_PANEL_TOKEN_FILE over the default path', () => {
    const path = join(home, 'custom.token');
    writeFileSync(path, 'file-token\n', 'utf8');
    const resolved = resolvePanelToken({ FACTORY_PANEL_TOKEN_FILE: path }, home);
    expect(resolved).toMatchObject({ ok: true, token: 'file-token', source: 'file' });
    expect(tokenFilePath({ FACTORY_PANEL_TOKEN_FILE: path }, home)).toBe(path);
  });

  it('creates the file 0600 on first start and reuses it afterwards', () => {
    const resolved = resolvePanelToken({}, home);
    expect(resolved.ok).toBe(true);
    if (!resolved.ok) return;
    expect(resolved.source).toBe('created');
    expect(resolved.token).toMatch(/^[0-9a-f]{64}$/);
    expect(resolved.path).toBe(join(home, '.factory', 'state', 'panel.token'));
    expect(statSync(resolved.path).mode & 0o777).toBe(0o600);
    expect(readFileSync(resolved.path, 'utf8').trim()).toBe(resolved.token);

    const again = resolvePanelToken({}, home);
    expect(again).toMatchObject({ ok: true, token: resolved.token, source: 'file' });
  });

  it('generates a different token every time', () => {
    const tokens = new Set(Array.from({ length: 8 }, () => generateToken()));
    expect(tokens.size).toBe(8);
    for (const token of tokens) expect(token).toMatch(/^[0-9a-f]{64}$/);
  });
});

describe('refusals', () => {
  it('refuses a blank FACTORY_PANEL_TOKEN instead of falling through to the file', () => {
    const resolved = resolvePanelToken({ FACTORY_PANEL_TOKEN: '   ' }, home);
    expect(resolved.ok).toBe(false);
    if (resolved.ok) return;
    expect(resolved.message).toContain('FACTORY_PANEL_TOKEN');
    expect(resolved.message).toContain('empty');
  });

  it('refuses an empty token file rather than serving an empty token', () => {
    const path = tokenFilePath({}, home);
    const resolved = resolvePanelToken({}, home);
    expect(resolved.ok).toBe(true);
    if (!resolved.ok) return;
    writeFileSync(path, '\n', 'utf8');
    const blank = resolvePanelToken({}, home);
    expect(blank.ok).toBe(false);
    if (blank.ok) return;
    expect(blank.message).toContain('empty');
  });

  it('refuses to create a token it cannot write, and says what to do instead', () => {
    const blocked = join(home, 'not-a-dir');
    writeFileSync(blocked, 'file where a directory is needed', 'utf8');
    const resolved = resolvePanelToken(
      { FACTORY_PANEL_TOKEN_FILE: join(blocked, 'panel.token') },
      home,
    );
    expect(resolved.ok).toBe(false);
    if (resolved.ok) return;
    expect(resolved.message).toContain('FACTORY_PANEL_TOKEN');
  });

  it('reports a token file it cannot read', () => {
    const path = tokenFilePath({}, home);
    const created = resolvePanelToken({}, home);
    expect(created.ok).toBe(true);
    chmodSync(path, 0o000);
    try {
      const resolved = resolvePanelToken({}, home);
      // Running as root would still read it; either way the token is never empty.
      if (!resolved.ok) expect(resolved.message).toContain(path);
      else expect(resolved.token.length).toBeGreaterThan(0);
    } finally {
      chmodSync(path, 0o600);
    }
  });
});
