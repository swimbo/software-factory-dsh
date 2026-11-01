/**
 * The launch record's own unit surface (E2E-33's identity clauses).
 *
 * The e2e spec reads the record the scripted executor writes; this file covers the three
 * things that need no DSH process and no container:
 *
 *   - the env fingerprint discloses names and hashes, and refuses credential-shaped names
 *     outright — including the `FACTORY_*` ones, which are the ones a worker would find useful;
 *   - the overlay identity is the sha256 of the bytes composed for *this* attempt, so the
 *     record describes what was produced rather than what was requested;
 *   - the profile recorded as effective is read back from the home on disk, so a home that does
 *     not hold exactly the requested profile cannot be reported as if it did.
 */
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  CREDENTIAL_NAME,
  buildChildEnv,
  effectiveProfile,
  forwardedCredentials,
  liveModelEnabled,
  fingerprintEnv,
  forbiddenForWorker,
  hashEnvValue,
  hashOverlay,
  writeLaunchRecord,
} from '../src/launch-record.ts';

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'factory-launch-record-'));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe('the child environment allowlist', () => {
  it('drops path-shaped and credential-shaped names, whatever their value', () => {
    const dropped: string[] = [];
    const env = buildChildEnv(
      '/factory/dsh-home/attempts/a1',
      {
        PATH: '/usr/bin',
        BIFROST_API_KEY: 'sk-live',
        OPENAI_API_KEY: 'sk-other',
        FACTORY_HOLDOUT_ROOT: '/factory/holdout',
        FACTORY_PRISTINE_REPO: '/factory/mirror.git',
        FACTORY_OPERATOR_KEY: '/home/op/.factory/keys/operator.key.pem',
        FACTORY_TEST_ROOT: 'tests',
        FACTORY_REPO: 'fixture',
        FACTORY_PROXY_BASE_URL: 'http://127.0.0.1:8787',
      },
      (name) => dropped.push(name),
    );

    // What survives: the worker's own home, its PATH, and non-path factory labels.
    expect(Object.keys(env).sort()).toStrictEqual([
      'DSH_HOME',
      'DSH_TELEMETRY_DISABLED',
      'FACTORY_PROXY_BASE_URL',
      'FACTORY_REPO',
      'PATH',
    ]);
    // Note `OPENAI_API_KEY` is dropped even though it is not a FACTORY_ name: the allowlist
    // never copies, so a credential the operator happens to export cannot ride along.
    expect(dropped.sort()).toStrictEqual([
      'FACTORY_HOLDOUT_ROOT',
      'FACTORY_OPERATOR_KEY',
      'FACTORY_PRISTINE_REPO',
      'FACTORY_TEST_ROOT',
    ]);
    expect(forbiddenForWorker('BIFROST_API_KEY')).toBe(true);
    expect(forbiddenForWorker('FACTORY_SIGNING_KEY')).toBe(true);
    expect(forbiddenForWorker('FACTORY_MODEL_ID')).toBe(false);
  });
});

describe('the env fingerprint', () => {
  it('records names and value hashes, and never a credential — not even by name', () => {
    const print = fingerprintEnv({ PATH: '/usr/bin', DSH_HOME: '/h', BIFROST_API_KEY: 'sk-live' }, [
      'FACTORY_HOLDOUT_ROOT',
      'FACTORY_CLIENT_SECRET',
    ]);

    expect(print.keys).toStrictEqual(['DSH_HOME', 'PATH']);
    expect(print.valueHashes['PATH']).toBe(hashEnvValue('/usr/bin'));
    expect(print.valueHashes['PATH']).toMatch(/^sha256:[0-9a-f]{64}$/u);
    // The credential never appears as a key, and the dropped list keeps only names that are
    // not themselves credential-shaped (a name in a list is still a name).
    expect(JSON.stringify(print)).not.toContain('BIFROST_API_KEY');
    expect(print.dropped).toStrictEqual(['FACTORY_HOLDOUT_ROOT']);
    expect(CREDENTIAL_NAME.test('FACTORY_CLIENT_SECRET')).toBe(true);
  });

  it('two launches with the same PATH hash the same and disclose nothing', () => {
    const first = fingerprintEnv({ PATH: '/usr/bin:/bin' });
    const second = fingerprintEnv({ PATH: '/usr/bin:/bin' });
    expect(first.valueHashes['PATH']).toBe(second.valueHashes['PATH']);
    expect(JSON.stringify(first)).not.toContain('/usr/bin:/bin');
  });
});

describe('the composed overlay identity', () => {
  it('is the hash of the bytes written for this attempt, and differs when they do', () => {
    const overlay = 'profile: factory-attempt\npatch:\n  - model.id: deepseek-v4\n';
    const recordDir = join(dir, 'attempts', 'U-1', 'A-1');
    mkdirSync(recordDir, { recursive: true });
    const overlayPath = join(recordDir, 'dsh-overlay.yml');
    writeFileSync(overlayPath, overlay, { mode: 0o600 });

    const sha = hashOverlay(overlay);
    const path = writeLaunchRecord(recordDir, {
      schema: 'launch/1',
      recordedAt: '2026-11-01T00:00:00.000Z',
      effectId: 'E-1',
      attempt: 0,
      unitId: 'U-1',
      attemptId: 'A-1',
      argv: ['dsh', '--profile', 'factory-attempt', '--patch', overlayPath, '<prompt 12 bytes>'],
      cwd: '/work/A-1',
      mountedAt: '/work/A-1',
      dshHome: '/factory/dsh-home/attempts/A-1',
      profile: { requested: 'factory-attempt', effective: 'factory-attempt' },
      overlay: { path: overlayPath, sha256: sha },
      env: fingerprintEnv({ PATH: '/usr/bin' }),
      credentialsForwarded: [],
      credentialProxy: null,
    });

    const written = JSON.parse(readFileSync(path, 'utf8')) as {
      overlay: { path: string; sha256: string };
    };
    // The identity is the composed document's, not the requested profile's name.
    expect(written.overlay.sha256).toBe(hashOverlay(overlay));
    expect(written.overlay.sha256).not.toBe(hashOverlay('profile: factory-attempt\n'));
    expect(written.overlay.path).toBe(overlayPath);
  });
});

describe('the effective profile is read back, not assumed', () => {
  it('reports the profile the attempt home holds, and null when it is not exactly one', () => {
    const home = join(dir, 'dsh-home', 'attempts', 'A-1');
    mkdirSync(join(home, 'profiles', 'factory-attempt'), { recursive: true });
    expect(effectiveProfile(home)).toBe('factory-attempt');

    // Two profiles in one home is a composition the record must not paper over: the caller
    // asked for one and the home has two, so "effective" is unknown, which is `null`, not the
    // requested name.
    mkdirSync(join(home, 'profiles', 'headless'), { recursive: true });
    expect(effectiveProfile(home)).toBeNull();

    // A home that was never seeded is also unknown, and never the requested value.
    expect(effectiveProfile(join(dir, 'absent'))).toBeNull();
  });
});

describe('the live-model credential opt-in', () => {
  it('forwards nothing by default, and refuses the key like any other credential', () => {
    const dropped: string[] = [];
    const env = buildChildEnv('/h', { PATH: '/usr/bin', BIFROST_API_KEY: 'sk-live' }, (name) =>
      dropped.push(name),
    );
    expect(env['BIFROST_API_KEY']).toBeUndefined();
    // Not a `FACTORY_` name, so it was never a candidate: the allowlist copies nothing, which
    // is why the drop callback stays empty and the key cannot be "re-added" by accident.
    expect(dropped).toStrictEqual([]);
    expect(forwardedCredentials({ BIFROST_API_KEY: 'sk-live' })).toStrictEqual([]);
    expect(liveModelEnabled({ FACTORY_LIVE_MODEL: '1' })).toBe(true);
    expect(liveModelEnabled({ FACTORY_LIVE_MODEL: 'true' })).toBe(false);
  });

  it('forwards no credential even with the consent flag set (ADR-007 retired the exception)', () => {
    // This spec used to assert the opposite — that `FACTORY_LIVE_MODEL=1` handed the child
    // `BIFROST_API_KEY` by name. That was the one false sentence in the README: the worker
    // held the gateway key on the live path. The proxy retires it, so the spec now pins the
    // retirement: the flag is consent to *spend*, and the only credential the child may hold
    // is the scoped token the launcher passes as an argument.
    const env = buildChildEnv('/h', {
      PATH: '/usr/bin',
      BIFROST_API_KEY: 'sk-live',
      DEEPSEEK_API_KEY: 'sk-deepseek',
      OPENAI_API_KEY: 'sk-openai',
      FACTORY_LIVE_MODEL: '1',
    });
    expect(env['BIFROST_API_KEY']).toBeUndefined();
    expect(env['DEEPSEEK_API_KEY']).toBeUndefined();
    expect(env['OPENAI_API_KEY']).toBeUndefined();
    // The flag still means "this run may spend" — it just no longer means "copy a key".
    expect(liveModelEnabled({ FACTORY_LIVE_MODEL: '1' })).toBe(true);
    expect(
      forwardedCredentials({ FACTORY_LIVE_MODEL: '1', BIFROST_API_KEY: 'sk-live' }),
    ).toStrictEqual([]);
    // The key is in the operator's environment, not the child's: no `FACTORY_` copy of it either.
    expect(Object.keys(env).filter((name) => CREDENTIAL_NAME.test(name))).toStrictEqual([]);
  });

  it('hands the child the scoped token the launcher minted, and only that one', () => {
    const env = buildChildEnv('/h', { PATH: '/usr/bin', BIFROST_API_KEY: 'sk-live' }, undefined, {
      proxyToken: 'scoped-token-value',
    });
    // The token is passed in, never copied from the parent: an explicit argument is a decision
    // the caller makes, and `parentEnv` cannot smuggle one in.
    expect(env['FACTORY_PROXY_TOKEN']).toBe('scoped-token-value');
    expect(env['BIFROST_API_KEY']).toBeUndefined();
    // The fingerprint keeps credential-shaped names out of the record entirely, so the token
    // is not in `launch.json` under any name — `credentialProxy` records *that* it was scoped.
    const print = fingerprintEnv(env);
    expect(Object.keys(print.valueHashes)).not.toContain('FACTORY_PROXY_TOKEN');
    expect(JSON.stringify(print)).not.toContain('scoped-token-value');
    // And without the argument there is no credential at all: absence is the default.
    expect(buildChildEnv('/h', { PATH: '/usr/bin' })['FACTORY_PROXY_TOKEN']).toBeUndefined();
  });

  it('records the forwarded name and never the value', () => {
    const print = fingerprintEnv({ PATH: '/usr/bin', BIFROST_API_KEY: 'sk-live' });
    // The fingerprint is about the child environment: a forwarded credential is still
    // credential-shaped, so it stays out of the record's key list entirely.
    expect(print.keys).toStrictEqual(['PATH']);
    expect(JSON.stringify(print)).not.toContain('BIFROST_API_KEY');
    expect(JSON.stringify(print)).not.toContain('sk-live');
  });
});

/**
 * The container field: what the worker ran inside, or `null` for a host child.
 *
 * `null` is the load-bearing half. A reader that cannot tell "host process" from "the container
 * was not recorded" cannot audit an isolation claim at all, which is why `container: null` is
 * written by code and the *absent* key exists only for records from before the container path.
 */
describe('the container field', () => {
  const baseRecord = {
    schema: 'launch/1' as const,
    recordedAt: '2026-11-01T12:00:00.000Z',
    effectId: 'EFF-1',
    attempt: 0,
    unitId: 'UNIT-1',
    attemptId: 'A-0001',
    argv: ['dsh', '--profile', 'factory-worker', '--json', '<prompt 6 bytes>'],
    cwd: '/factory/attempts/UNIT-1/A-0001',
    mountedAt: '/factory/attempts/UNIT-1/A-0001',
    dshHome: '/factory/attempts/UNIT-1/A-0001/dsh-home',
    profile: { requested: 'factory-worker', effective: 'factory-worker' },
    overlay: { path: null, sha256: null },
    env: { keys: ['NODE_ENV'], valueHashes: { NODE_ENV: 'sha256:abc' }, dropped: [] },
    credentialsForwarded: [],
    credentialProxy: null,
  };

  it('writes `container: null` for a host launch, and keeps schema launch/1', () => {
    const path = writeLaunchRecord(dir, { ...baseRecord, container: null });
    const parsed = JSON.parse(readFileSync(path, 'utf8')) as Record<string, unknown>;
    expect(parsed['schema']).toBe('launch/1');
    // Present and null: the fact, spelled out. Not an omitted key.
    expect(Object.hasOwn(parsed, 'container')).toBe(true);
    expect(parsed['container']).toBeNull();
  });

  it('carries the image, uid, network, limits and the mounts it did NOT get', () => {
    const mountDenied = ['/factory/keys', '/factory/holdout', '/Users/operator'];
    const path = writeLaunchRecord(dir, {
      ...baseRecord,
      container: {
        image: 'factory-env:rc5',
        imageDigest: 'factory-env@sha256:0123456789abcdef',
        user: '10001:10001',
        network: 'none',
        readOnlyRoot: true,
        memoryLimit: '2g',
        pidsLimit: 512,
        tmpfs: ['/tmp'],
        mounts: [
          { path: '/factory/attempts/UNIT-1/A-0001', mode: 'rw' },
          { path: '/factory/attempts/UNIT-1/A-0001/dsh-home', mode: 'rw' },
          { path: '/factory/attempts/UNIT-1/A-0001/record', mode: 'ro' },
        ],
        mountsDenied: mountDenied,
        labels: { 'org.factory.attempt': 'A-0001', 'org.factory.run': 'EFF-1' },
      },
    });
    const parsed = JSON.parse(readFileSync(path, 'utf8')) as {
      container: Record<string, unknown>;
    };
    expect(parsed.container['image']).toBe('factory-env:rc5');
    expect(parsed.container['imageDigest']).toContain('sha256:');
    expect(parsed.container['user']).toBe('10001:10001');
    expect(parsed.container['network']).toBe('none');
    expect(parsed.container['readOnlyRoot']).toBe(true);
    expect(parsed.container['mountsDenied']).toStrictEqual(mountDenied);
    const mounts = parsed.container['mounts'] as { path: string; mode: string }[];
    expect(mounts.map((mount) => mount.mode)).toStrictEqual(['rw', 'rw', 'ro']);
  });

  it('leaves a record from before the field readable: the key is optional, not required', () => {
    // The type must accept the old shape, and the written JSON must not invent a value for it.
    const path = writeLaunchRecord(dir, baseRecord);
    const parsed = JSON.parse(readFileSync(path, 'utf8')) as Record<string, unknown>;
    expect(Object.hasOwn(parsed, 'container')).toBe(false);
    expect(parsed['schema']).toBe('launch/1');
  });
});
