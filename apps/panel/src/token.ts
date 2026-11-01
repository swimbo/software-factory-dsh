/**
 * Where the panel's token comes from.
 *
 * The token is the only thing between the operator's browser and the whole
 * factory, so it is never defaulted, never derived from the host, and never
 * accepted from a URL the page can leak by accident (`Referrer-Policy: no-referrer`
 * and a `?token=` query are both supported, and the query form is what makes the
 * first click work without a header-plugin).
 *
 * Resolution order, and the reason for it:
 *  1. `FACTORY_PANEL_TOKEN` — explicit, greppable, what a service manager uses.
 *  2. `FACTORY_PANEL_TOKEN_FILE` (default `~/.factory/state/panel.token`) — the
 *     shared secret between `factory panel` runs; created `0600` on first start so
 *     a fresh machine works without the operator inventing a token.
 */
import { randomBytes } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';

export const TOKEN_FILE_NAME = 'panel.token';
export const TOKEN_FILE_ENV = 'FACTORY_PANEL_TOKEN_FILE';
export const TOKEN_ENV = 'FACTORY_PANEL_TOKEN';

/** `~/.factory/state/panel.token` unless the environment points somewhere else. */
export function tokenFilePath(
  env: Readonly<Record<string, string | undefined>>,
  home: string = homedir(),
): string {
  const override = env[TOKEN_FILE_ENV];
  if (typeof override === 'string' && override.trim().length > 0) return override;
  return join(home, '.factory', 'state', TOKEN_FILE_NAME);
}

export type TokenSource = 'env' | 'file' | 'created';

export type TokenResolution =
  | {
      readonly ok: true;
      readonly token: string;
      readonly source: TokenSource;
      readonly path: string;
    }
  | { readonly ok: false; readonly message: string };

/** 32 bytes of randomness, hex — never a passphrase, never a date, never reused. */
export function generateToken(): string {
  return randomBytes(32).toString('hex');
}

/**
 * Resolve the token, creating the 0600 file on first start.
 *
 * A resolution failure is a message, not an exception: `main.ts` prints it and
 * exits non-zero, which is the only sane response to "I cannot authenticate the
 * page you asked me to serve".
 */
export function resolvePanelToken(
  env: Readonly<Record<string, string | undefined>>,
  home: string = homedir(),
): TokenResolution {
  const path = tokenFilePath(env, home);
  const configured = env[TOKEN_ENV];
  if (configured !== undefined) {
    const trimmed = configured.trim();
    if (trimmed.length === 0) {
      return {
        ok: false,
        message: `${TOKEN_ENV} is set but empty — unset it to use the token file, or give it a token`,
      };
    }
    return { ok: true, token: trimmed, source: 'env', path };
  }

  if (existsSync(path)) {
    let content: string;
    try {
      content = readFileSync(path, 'utf8');
    } catch (error) {
      return { ok: false, message: `cannot read ${path}: ${(error as Error).message}` };
    }
    const trimmed = content.trim();
    if (trimmed.length === 0) {
      return {
        ok: false,
        message: `${path} exists but is empty — delete it or write a token into it`,
      };
    }
    return { ok: true, token: trimmed, source: 'file', path };
  }

  const token = generateToken();
  try {
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    writeFileSync(path, `${token}\n`, { encoding: 'utf8', mode: 0o600, flag: 'wx' });
    // `wx` plus the explicit chmod: `writeFileSync`'s mode is masked by umask.
    chmodSync(path, 0o600);
  } catch (error) {
    return {
      ok: false,
      message: `cannot create ${path}: ${(error as Error).message} — set ${TOKEN_ENV} instead`,
    };
  }
  return { ok: true, token, source: 'created', path };
}
