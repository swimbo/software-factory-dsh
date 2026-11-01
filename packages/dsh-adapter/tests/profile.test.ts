/**
 * The profile integration test: the real `dsh` binary, offline.
 *
 * This is the only place the suite touches the installed harness, and it can do
 * so for free because of one property of DSH: **a fresh `DSH_HOME` has no
 * credentials**, so a headless run fails closed at `MISSING_CREDENTIAL` before
 * any HTTP request exists. That gives us a real boot — every plugin activated,
 * the real projection stream written — with no network and no paid call.
 *
 * What only this file can prove:
 *
 * - the five-entry overlay (+ the compaction patch) composes with **every entry
 *   activating**, which `--dump-config` alone cannot show (schema composition is
 *   not plugin activation — a broken permission pair dumps fine and only warns
 *   at run time);
 * - the real event shapes the parser accepts are the shapes the installed binary
 *   actually emits;
 * - a fresh home carries no `cordis.patch.yml`, so no operator home layer can
 *   reach a factory run.
 *
 * It skips when the pinned binary is absent. `FACTORY_DSH_BIN` overrides the
 * path for a machine that installed DSH elsewhere.
 */

import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { DSH_PROFILE } from '../src/executor.ts';
import { parseHeadlessStream } from '../src/ndjson.ts';
import { buildOverlay } from '../src/overlay.ts';
import { tempDir } from './helpers.ts';

const PINNED_DSH = '/Applications/DeepSeek Harness.app/Contents/Resources/runtime/cli/bin/dsh';
const DSH = process.env['FACTORY_DSH_BIN'] ?? PINNED_DSH;
const available = existsSync(DSH);

const PROXY = 'http://127.0.0.1:4010';
const MODEL = 'factory-worker-tier';

/**
 * A fresh DSH_HOME with the profile provisioned exactly as
 * `scripts/provision-dsh-home.sh` does it, an attempt-ish workspace, and the
 * overlay written for it.
 *
 * Provisioning here rather than reusing the shipped `headless` profile is
 * deliberate: the executor boots the provisioned profile, so a test that booted
 * `headless` would be validating a profile production never uses.
 */
function compose(): { home: string; work: string; overlayPath: string; attemptDir: string } {
  const root = tempDir('profile');
  const home = join(root, 'home');
  const attemptDir = join(root, 'attempt');
  // One path, not two: the clone root is the sandbox root and the process cwd
  // (A3.2). DSH keys its session log by cwd, so a nested `worktree/` here would
  // mean the slug production uses is never exercised.
  const work = attemptDir;
  mkdirSync(home, { recursive: true });
  mkdirSync(work, { recursive: true });

  const provision = spawnSync(
    DSH,
    ['--profile', DSH_PROFILE, '--from-default-profile', 'headless', '--dump-config'],
    { cwd: work, encoding: 'utf8', env: env(home) },
  );
  if (provision.status !== 0) {
    throw new Error(`provisioning the profile failed: ${provision.stderr}`);
  }

  const overlayPath = join(attemptDir, 'dsh-overlay.yml');
  writeFileSync(overlayPath, buildOverlay({ attemptDir, proxyBaseUrl: PROXY, modelId: MODEL }));
  return { home, work, overlayPath, attemptDir };
}

function env(home: string): NodeJS.ProcessEnv {
  const base: NodeJS.ProcessEnv = { ...process.env, DSH_HOME: home, DSH_TELEMETRY_DISABLED: '1' };
  // A fresh `DSH_HOME` has no credentials, and this suite relies on that: the boot must fail
  // closed at MISSING_CREDENTIAL, which is also the proof that nothing was sent anywhere. Spreading
  // `process.env` broke that the moment the operator had a real gateway key exported — the boot
  // then got a credential, tried the network and reported `TRANSPORT: Connection error` instead,
  // so this spec measured the developer's shell. A credential-shaped variable inherited from the
  // parent must never reach a child whose whole purpose is to have none.
  for (const key of Object.keys(base)) {
    if (/KEY|TOKEN|SECRET|CREDENTIAL/iu.test(key)) delete base[key];
  }
  return base;
}

/** Split the composed config dump into `id -> block`, dropping comment lines. */
function dumpEntries(dump: string): Map<string, string> {
  const entries = new Map<string, string>();
  let currentId: string | null = null;
  let buffer: string[] = [];
  const flush = (): void => {
    if (currentId !== null) entries.set(currentId, buffer.join('\n'));
    buffer = [];
  };
  for (const line of dump.split('\n')) {
    const match = /^- id: (.+)$/.exec(line);
    if (match !== null) {
      flush();
      currentId = match[1] ?? '';
      buffer.push(line);
      continue;
    }
    // The layer markers between entries are provenance, not configuration.
    if (line.startsWith('# ==')) continue;
    buffer.push(line);
  }
  flush();
  return entries;
}

describe.skipIf(!available)('the real dsh profile', () => {
  it('is the pinned version, because every fact here is version-specific', () => {
    const result = spawnSync(DSH, ['--version'], { encoding: 'utf8' });
    expect(result.status).toBe(0);
    // The event shapes, the `--json` projection and the five required entries
    // were all established against the 0.2.1 series. A different series must
    // break here rather than misparse silently.
    expect(result.stdout.trim()).toMatch(/^0\.2\.1/);
  });

  it('composes the overlay with the sandbox and approval pair a preset allows', () => {
    const { home, work, overlayPath } = compose();
    const result = spawnSync(
      DSH,
      ['--profile', DSH_PROFILE, '--patch', overlayPath, '--dump-config'],
      {
        cwd: work,
        encoding: 'utf8',
        env: env(home),
      },
    );

    expect(result.status).toBe(0);
    const entries = dumpEntries(result.stdout);

    expect(entries.get('sandbox-policy')).toContain('mode: workspace-write');
    expect(entries.get('approval')).toContain('policy: never');
    const permission = entries.get('permission') ?? '';
    expect(permission).toContain('defaultPreset: factory-worker');
    expect(permission).toContain('sandbox: workspace-write');
    expect(permission).toContain('approval: never');
    expect(entries.get('llm-pi-ai')).toContain(`baseURL: ${PROXY}`);
    expect(entries.get('llm-pi-ai')).toContain('apiKeyEnv: BIFROST_API_KEY');
    expect(entries.get('agent-default-model')).toContain(`model: ${MODEL}`);
    expect(entries.get('compaction-basic')).toContain('auto: false');

    // Every overlay entry composed into the profile; the dump marks which layer
    // patched which entry, so an entry that did not land is visible here.
    expect(result.stdout).toContain(`patched by ${overlayPath}`);
  });

  it('boots every entry with no activation warning, and no model call', async () => {
    // The negative control the dump cannot give: a plugin that fails to activate
    // still dumps fine. Only a boot warns.
    const { home, work, overlayPath } = compose();
    const started = Date.now();
    const child = spawn(
      DSH,
      ['--profile', DSH_PROFILE, '--patch', overlayPath, '--json', 'say nothing'],
      {
        cwd: work,
        env: env(home),
        stdio: ['ignore', 'pipe', 'pipe'],
      },
    );
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk: string) => {
      stdout += chunk;
    });
    child.stderr.on('data', (chunk: string) => {
      stderr += chunk;
    });
    // A hung harness must fail this test rather than hang the suite. 60 s, not 15: this boots a
    // real `dsh` (composing every profile entry) inside a full-suite run, and 15 s measured the
    // machine's load rather than a hang -- it went red at 15,147 ms on a busy run and passes in
    // isolation in ~4 s.
    const guard = setTimeout(() => child.kill('SIGKILL'), 60_000);
    const code = await new Promise<number | null>((resolve) => {
      child.once('close', (exitCode) => resolve(exitCode));
    });
    clearTimeout(guard);
    expect(Date.now() - started).toBeLessThan(60_000);

    // Not an activation failure.
    expect(stderr).not.toContain('did not activate');
    expect(stdout).not.toContain('did not activate');

    // It really booted, and it failed closed on the missing credential — which is
    // also the proof that nothing was sent anywhere.
    expect(stderr).toContain('MISSING_CREDENTIAL');
    expect(code).toBe(1);

    // The installed binary's stream parses to an error turn end, not to success.
    const parsed = parseHeadlessStream(stdout.split('\n'));
    expect(parsed.sessionId).not.toBeNull();
    expect(parsed.turnEnd?.kind).toBe('error');
    expect(parsed.error?.code).toBe('MISSING_CREDENTIAL');
    expect(parsed.ok).toBe(false);
    expect(parsed.turnsUsed).toBe(1);
    expect(parsed.malformed).toStrictEqual([]);
    // And the terminal `final` is present even though the turn failed: presence
    // of a final is not success.
    expect(parsed.finalText).toBe('');
  });

  it('keys the session log by the working directory, which is why the path must be identical', () => {
    // The reason A3.2 insists on the same absolute path inside and outside the
    // container: the log lands under `$DSH_HOME/sessions/<slug-of-cwd>/<sessionId>`.
    // If the host and the container disagree about cwd, the log for a run is filed
    // under a slug nothing will look for, and `--session-id` adoption is dead.
    const { home, work, overlayPath } = compose();
    const result = spawnSync(
      DSH,
      ['--profile', DSH_PROFILE, '--patch', overlayPath, '--dump-config'],
      {
        cwd: work,
        encoding: 'utf8',
        env: env(home),
      },
    );
    expect(result.status).toBe(0);

    const boot = spawnSync(
      DSH,
      ['--profile', DSH_PROFILE, '--patch', overlayPath, '--json', 'say nothing'],
      {
        cwd: work,
        encoding: 'utf8',
        env: env(home),
      },
    );
    // Fails closed on the missing credential, as always — no network, no call.
    expect(boot.status).toBe(1);

    const sessionRoot = join(home, 'sessions');
    expect(existsSync(sessionRoot)).toBe(true);
    const slugs = readdirSync(sessionRoot);
    expect(slugs).toHaveLength(1);
    const slug = slugs[0] ?? '';
    // Every segment of the cwd appears in the slug, in order.
    for (const segment of work.split('/').filter((part) => part !== '')) {
      expect(slug).toContain(segment);
    }
    // And the session directory under it is the one the stream named.
    const parsed = parseHeadlessStream(boot.stdout.split('\n'));
    expect(parsed.sessionId).not.toBeNull();
    expect(readdirSync(join(sessionRoot, slug))).toContain(parsed.sessionId);
  });

  it('starts from a home with no operator patch layer', () => {
    // DSH composes `$DSH_HOME/cordis.patch.yml` into *every* profile, which is how
    // the operator's MCP servers and personal credentials would otherwise reach a
    // worker. A fresh home has no such file, and the factory never writes one.
    const { home, work, overlayPath } = compose();
    expect(existsSync(join(home, 'cordis.patch.yml'))).toBe(false);
    spawnSync(DSH, ['--profile', DSH_PROFILE, '--patch', overlayPath, '--dump-config'], {
      cwd: work,
      encoding: 'utf8',
      env: env(home),
    });
    expect(existsSync(join(home, 'cordis.patch.yml'))).toBe(false);
  });
});
