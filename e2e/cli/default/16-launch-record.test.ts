/**
 * E2E-33 — the worker path cannot reach the holdout, the operator key, or the model credential.
 *
 * The test does not assert a promise about the code; it reads the file the adapter writes at
 * launch (`launch.json`, next to `receipt.json`) and checks that the worker's world does not
 * contain the three things the factory holds:
 *
 *   - the **holdout corpus** — the scenarios the wall is about to judge the change with. A
 *     worker that knows its path can read its own exam;
 *   - the **operator signing key** — a worker that can reach it can sign its own promotion;
 *   - the **model credential** — the worker talks to the proxy, never to Bifrost.
 *
 * The environment is deliberately hostile: the holdout root, the key path and two real-looking
 * credentials are all exported, and the launched attempt is checked for every one of them, by
 * name and by value. The record is the same one the real executor writes, so what is proven
 * here is the allowlist and the record — not the container.
 *
 * Clause counted `UNKNOWN` here: the **container's** filesystem isolation (a worker inside the
 * image cannot open the host's holdout directory even if it guesses the path). That needs the
 * wall image, which v1 does not ship; `@docker` E2E-45 owns it. This spec proves the path never
 * reaches the worker, not that the mount hides it.
 */
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { jsonOf, runFactory } from '../../harness/factory.ts';
import { createWallFixture, type WallFixture } from '../../harness/wall-fixture.ts';

let fixture: WallFixture;

beforeEach(() => {
  fixture = createWallFixture();
});

afterEach(() => {
  fixture.cleanup();
});

const MODEL_KEY_VALUE = 'sk-bifrost-live-do-not-leak';
const DEEPSEEK_KEY_VALUE = 'sk-deepseek-live-do-not-leak';

interface Launched {
  readonly unitId: string;
  readonly attemptId: string;
  readonly recordDir: string;
  readonly recordPath: string;
  readonly raw: string;
  readonly record: Record<string, unknown>;
}

/** Run one unit through the scripted worker with a hostile environment, then read the record. */
function launchUnderHostileEnv(): Launched {
  const unitId = fixture.submit();
  const operatorKeyPath = join(fixture.home, 'keys', 'operator.key.pem');
  const env = fixture.wallEnv({
    // Every one of these is something the worker must never see.
    BIFROST_API_KEY: MODEL_KEY_VALUE,
    DEEPSEEK_API_KEY: DEEPSEEK_KEY_VALUE,
    FACTORY_OPERATOR_KEY: operatorKeyPath,
    FACTORY_HOLDOUT_ROOT: fixture.holdoutRoot,
    FACTORY_PRISTINE_REPO: fixture.mirror,
    FACTORY_SIGNING_KEY: operatorKeyPath,
  });

  const run = runFactory(['run', unitId, '--scenario', fixture.scenarioPath, '--json'], {
    home: fixture.home,
    env,
    timeoutMs: 120_000,
  });
  expect(run.code, `${run.stdout}\n${run.stderr}`).toBe(0);
  const attemptId = String(jsonOf(run)['attemptId']);

  const recordDir = join(fixture.home, 'attempts', unitId, attemptId);
  const recordPath = join(recordDir, 'launch.json');
  expect(existsSync(recordPath), `no launch record at ${recordPath}`).toBe(true);
  const raw = readFileSync(recordPath, 'utf8');
  return {
    unitId,
    attemptId,
    recordDir,
    recordPath,
    raw,
    record: JSON.parse(raw) as Record<string, unknown>,
  };
}

describe('the launch record (E2E-33)', () => {
  it('[@default] control: the record is never empty — argv, cwd, env keys and hashes are present', () => {
    const launched = launchUnderHostileEnv();
    const record = launched.record;

    // A leak spec that passes because the file is empty is worse than no spec: the control
    // asserts the file describes a launch before the absence assertions mean anything.
    expect(record['schema']).toBe('launch/1');
    expect(record['unitId']).toBe(launched.unitId);
    expect(record['attemptId']).toBe(launched.attemptId);

    const argv = record['argv'] as string[];
    expect(Array.isArray(argv)).toBe(true);
    expect(argv.length).toBeGreaterThan(0);
    expect(argv.join(' ')).toContain('scenario:');

    // The working directory is the attempt clone, and the mount target is the same path:
    // that equality is what makes the container mount and session adoption work. Compared by
    // suffix because macOS resolves `/var` to `/private/var`, and the record holds the path
    // the process actually used rather than the one the test can spell.
    const cwd = String(record['cwd']);
    // The clone lives under the state directory, keyed by attempt id; compared by suffix
    // because macOS resolves `/var` to `/private/var`.
    expect(cwd.endsWith(join('attempts', launched.attemptId))).toBe(true);
    expect(record['mountedAt']).toBe(cwd);

    const env = record['env'] as {
      keys: string[];
      valueHashes: Record<string, string>;
      dropped: string[];
    };
    // The child was given an environment, and it is recorded as names plus hashes.
    expect(env.keys.length).toBeGreaterThan(0);
    expect(env.keys).toContain('PATH');
    expect(env.keys).toContain('DSH_HOME');
    expect(env.keys).toContain('FACTORY_FAKE_WORKER');
    for (const name of env.keys) {
      expect(env.valueHashes[name], `hash for ${name}`).toMatch(/^sha256:[0-9a-f]{64}$/u);
    }
    // The record names what it refused, which is what makes the refusal auditable.
    expect(env.dropped).toContain('FACTORY_HOLDOUT_ROOT');
    expect(env.dropped).toContain('FACTORY_OPERATOR_KEY');
    expect(env.dropped).toContain('FACTORY_PRISTINE_REPO');
  });

  it('[@default] the holdout root reaches neither the record, the env keys, nor the directory', () => {
    const launched = launchUnderHostileEnv();

    // By value: the path itself never appears anywhere in the record.
    expect(launched.raw).not.toContain(fixture.holdoutRoot);
    // By name: no key shaped like a holdout location was handed to the child.
    const keys = (launched.record['env'] as { keys: string[] }).keys;
    expect(keys.filter((name) => /HOLDOUT/iu.test(name))).toStrictEqual([]);
    // And not by listing: nothing in the attempt directory is named after it.
    const listing = readdirSync(launched.recordDir);
    expect(listing.filter((name) => /holdout/iu.test(name))).toStrictEqual([]);
    // The holdout manifest is the sharpest form of the leak: the corpus identity.
    expect(launched.raw).not.toContain('manifest.json');
    expect(launched.raw).not.toContain('h-duplicate');
  });

  it('[@default] the operator key and the model credentials never reach the child', () => {
    const launched = launchUnderHostileEnv();
    const keys = (launched.record['env'] as { keys: string[] }).keys;

    // The signing key, by path and by name.
    expect(launched.raw).not.toContain(join(fixture.home, 'keys'));
    expect(keys.filter((name) => /OPERATOR|SIGNING|PRIVATE/iu.test(name))).toStrictEqual([]);
    expect(readdirSync(launched.recordDir).filter((name) => /key/iu.test(name))).toStrictEqual([]);

    // The model credentials: never the value, and never the name either — a record that
    // lists `BIFROST_API_KEY` tells a reader which variable to hunt for.
    expect(launched.raw).not.toContain(MODEL_KEY_VALUE);
    expect(launched.raw).not.toContain(DEEPSEEK_KEY_VALUE);
    expect(launched.raw).not.toContain('BIFROST_API_KEY');
    expect(launched.raw).not.toContain('DEEPSEEK_API_KEY');
    expect(keys.filter((name) => /KEY|TOKEN|SECRET/iu.test(name))).toStrictEqual([]);
    // The environment really did hold them: the spec is not passing on an empty parent env.
    expect(launched.raw).toContain('PATH');
  });
});
