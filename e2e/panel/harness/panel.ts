/**
 * The panel under test: a real `apps/panel/src/main.ts` process, one per spec.
 *
 * Nothing here mocks HTTP. The spec spawns the shipped entry point, waits for the line
 * it prints, and then drives a browser at it — which is the only way to prove that what
 * an operator sees is what the process actually serves.
 *
 * Three environment facts make a spec hermetic:
 *
 *   - `FACTORY_HOME` (and `FACTORY_STATE_DIR`, which is the panel's own variable) point
 *     at the spec's temp directory, so no spec can read the operator's real store;
 *   - `FACTORY_PANEL_PORT=0` asks the OS for a free port, so parallel workers never
 *     collide and no spec depends on being the first to bind a fixed port;
 *   - `PATH` contains no `dsh`, so the DSH probe fails by default and a spec that wants
 *     a readable version supplies a stub — the same convention `e2e/harness/factory.ts`
 *     uses for the CLI.
 */
import { spawn, type ChildProcess } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { chmodSync, mkdirSync, writeFileSync } from 'node:fs';
import { delimiter, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

/** The entry point under test, run through the same runtime as the suite. */
export const PANEL_MAIN = fileURLToPath(
  new URL('../../../apps/panel/src/main.ts', import.meta.url),
);

/** Node's own directory plus the POSIX defaults; deliberately no `dsh`. */
export const NO_DSH_PATH = [
  dirname(process.execPath),
  '/usr/bin',
  '/bin',
  '/usr/sbin',
  '/sbin',
].join(delimiter);

export interface PanelStatusResponse {
  readonly status: number;
  readonly body: string;
  /** Parsed JSON when the body is an object, otherwise `null`. */
  readonly json: Record<string, unknown> | null;
}

export interface PanelHandle {
  /** The temp directory the panel reads its store from. */
  readonly home: string;
  /** The secret this instance accepts. It is never rendered by the page itself. */
  readonly token: string;
  /** `http://127.0.0.1:<ephemeral port>` — the origin this instance owns. */
  readonly origin: string;
  /** Absolute URL for a route, with the token attached the way a browser tab would. */
  urlFor(route?: string): string;
  /** `GET /api/status` with the token. */
  statusRequest(): Promise<PanelStatusResponse>;
  /** `GET /` with the token. */
  html(): Promise<string>;
  /** Everything the process printed, for failure messages. */
  output(): string;
  close(): Promise<void>;
}

export interface StartPanelOptions {
  readonly token?: string;
  readonly env?: Readonly<Record<string, string | undefined>>;
  readonly readyMs?: number;
}

/** Random per instance: a token that leaked into HTML would be obvious, not guessed. */
export function newPanelToken(): string {
  return randomBytes(24).toString('hex');
}

/**
 * A stub `dsh` that reports one version and nothing else.
 *
 * Supplied to the panel through `FACTORY_DSH_BIN`, exactly as an operator would point
 * it at a real harness. The panel probes it once at startup, so this file is the whole
 * difference between a silent health strip and `DSH VERSION UNAVAILABLE`.
 */
export function writeDshStub(dir: string, version: string): string {
  const binDir = join(dir, 'bin');
  mkdirSync(binDir, { recursive: true });
  const path = join(binDir, 'dsh');
  writeFileSync(path, `#!/bin/sh\necho "dsh/${version}"\n`, 'utf8');
  chmodSync(path, 0o755);
  return path;
}

function childEnv(
  home: string,
  overrides: Readonly<Record<string, string | undefined>> = {},
): Record<string, string> {
  const env: Record<string, string> = {
    PATH: NO_DSH_PATH,
    FACTORY_HOME: home,
    // The panel resolves its store from its own variable; the CLI uses FACTORY_HOME.
    // Both are set so one temp directory is the single source of truth for a spec.
    FACTORY_STATE_DIR: join(home, 'state'),
    TERM: 'dumb',
    NO_COLOR: '1',
  };
  for (const [key, value] of Object.entries(overrides)) {
    if (value === undefined) delete env[key];
    else env[key] = value;
  }
  return env;
}

interface SpawnedPanel {
  readonly child: ChildProcess;
  readonly token: string;
  readonly ready: Promise<string>;
  readonly output: () => string;
}

function spawnPanel(home: string, options: StartPanelOptions): SpawnedPanel {
  const token = options.token ?? newPanelToken();
  const child = spawn(process.execPath, [PANEL_MAIN], {
    env: {
      ...childEnv(home, options.env),
      FACTORY_PANEL_TOKEN: token,
      FACTORY_PANEL_PORT: '0',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let stdout = '';
  let stderr = '';
  child.stdout?.on('data', (chunk: Buffer) => {
    stdout += chunk.toString();
  });
  child.stderr?.on('data', (chunk: Buffer) => {
    stderr += chunk.toString();
  });
  const output = (): string => `stdout:\n${stdout}\nstderr:\n${stderr}`;
  const readyMs = options.readyMs ?? 15_000;
  const ready = new Promise<string>((resolve, reject) => {
    const deadline = setTimeout(() => {
      reject(
        new Error(`the panel did not print its URL within ${String(readyMs)} ms\n${output()}`),
      );
    }, readyMs);
    const check = (): void => {
      const match = /factory panel: (http:\/\/127\.0\.0\.1:\d+)/u.exec(stdout);
      if (match?.[1] === undefined) return;
      clearTimeout(deadline);
      child.off('exit', onExit);
      resolve(match[1]);
    };
    const onExit = (code: number | null): void => {
      clearTimeout(deadline);
      reject(new Error(`the panel exited (${String(code)}) before printing its URL\n${output()}`));
    };
    child.on('exit', onExit);
    child.stdout?.on('data', check);
    check();
  });
  return { child, token, ready, output };
}

/**
 * Start the real panel against `home` and wait until it answers.
 *
 * The URL line is printed *after* the listener is bound, but the process still has to
 * accept the first connection, so a short poll makes the wait deterministic instead of
 * a sleep. A panel that never answers fails the spec here, with its own output attached.
 */
export async function startPanel(
  home: string,
  options: StartPanelOptions = {},
): Promise<PanelHandle> {
  const spawned = spawnPanel(home, options);
  const printed = await spawned.ready;
  const origin = `http://127.0.0.1:${new URL(printed).port}`;
  const token = spawned.token;
  const deadline = Date.now() + 5_000;
  for (;;) {
    const probe = await fetch(`${origin}/api/status?token=${token}`).catch(() => null);
    if (probe !== null) break;
    if (Date.now() > deadline) {
      throw new Error(`the panel printed ${printed} but never answered\n${spawned.output()}`);
    }
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  return {
    home,
    token,
    origin,
    urlFor: (route = '/') =>
      `${origin}${route.startsWith('/') ? route : `/${route}`}?token=${token}`,
    statusRequest: async () => {
      const response = await fetch(`${origin}/api/status?token=${token}`);
      const body = await response.text();
      let json: Record<string, unknown> | null = null;
      try {
        const parsed: unknown = JSON.parse(body);
        if (typeof parsed === 'object' && parsed !== null) {
          json = parsed as Record<string, unknown>;
        }
      } catch {
        json = null;
      }
      return { status: response.status, body, json };
    },
    html: async () => {
      const response = await fetch(`${origin}/?token=${token}`);
      return response.text();
    },
    output: spawned.output,
    close: async () => {
      const child = spawned.child;
      if (child.exitCode !== null || child.signalCode !== null) return;
      await new Promise<void>((resolve) => {
        const timer = setTimeout(() => {
          child.kill('SIGKILL');
          resolve();
        }, 3_000);
        child.once('exit', () => {
          clearTimeout(timer);
          resolve();
        });
        child.kill('SIGTERM');
      });
    },
  };
}
