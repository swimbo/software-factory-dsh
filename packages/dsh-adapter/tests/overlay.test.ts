/**
 * The overlay is the only DSH surface the factory writes, so its shape is pinned
 * here rather than left to a probe document.
 */

import { describe, expect, it } from 'vitest';

import { assertNoSecrets, buildDshHome, buildOverlay, type DshDomain } from '../src/overlay.ts';
import { entryValue, overlayEntries } from './helpers.ts';

const INPUT = {
  attemptDir: '/var/factory/attempts/u1/a1',
  proxyBaseUrl: 'http://127.0.0.1:4010',
  modelId: 'factory-worker-tier',
};

/** The five entries the integration probe verified compose with no warning. */
const PROBE_ENTRIES = [
  'sandbox-policy',
  'approval',
  'permission',
  'llm-pi-ai',
  'agent-default-model',
];

describe('buildOverlay', () => {
  it('emits the five probe-verified entries, once each, in id order', () => {
    const entries = overlayEntries(buildOverlay(INPUT));
    for (const id of PROBE_ENTRIES) {
      expect(entries.has(id), `missing entry ${id}`).toBe(true);
    }
    const ids = [...entries.keys()];
    expect(ids.filter((id) => PROBE_ENTRIES.includes(id))).toStrictEqual(PROBE_ENTRIES);
  });

  it('composes a sandbox and approval pair that matches a named preset', () => {
    // The trap: `workspace-write` + `ask` matches no preset, the permission
    // service throws, and DSH continues with degraded permissions. The preset
    // declaration is what makes the pair legal.
    const entries = overlayEntries(buildOverlay(INPUT));

    const sandbox = entries.get('sandbox-policy') ?? '';
    expect(sandbox).toContain('mode: workspace-write');
    expect(entryValue(sandbox, 'workspaceRoot')).toBe(INPUT.attemptDir);

    const approval = entries.get('approval') ?? '';
    expect(approval).toContain('policy: never');

    const permission = entries.get('permission') ?? '';
    expect(permission).toContain('defaultPreset: factory-worker');
    expect(permission).toContain('sandbox: workspace-write');
    expect(permission).toContain('approval: never');
  });

  it('routes the worker through the proxy by name, never by key value', () => {
    const overlay = buildOverlay(INPUT);
    const llm = overlayEntries(overlay).get('llm-pi-ai') ?? '';
    expect(llm).toContain('apiKeyEnv: BIFROST_API_KEY');
    expect(llm).toContain('api: anthropic-messages');
    expect(entryValue(llm, 'baseURL')).toBe(INPUT.proxyBaseUrl);
    expect(llm).toContain(`- id: ${INPUT.modelId}`);
    // The overlay names the variable; the proxy holds the value.
    expect(overlay).not.toMatch(/sk-/);
  });

  it('pins the default model to the same provider and model id', () => {
    const model = overlayEntries(buildOverlay(INPUT)).get('agent-default-model') ?? '';
    expect(model).toContain('provider: bifrost');
    expect(model).toContain(`model: ${INPUT.modelId}`);
  });

  it('disables automatic compaction by default', () => {
    // Compaction summarises with the session's own provider and model, so it
    // spends proxied requests the admission budget never reserved, and it drops
    // tool results from the surface the receipt is meant to explain.
    const compaction = overlayEntries(buildOverlay(INPUT)).get('compaction-basic') ?? '';
    expect(compaction).toContain('auto: false');
  });

  it('omits the compaction entry when compression is explicitly on', () => {
    const entries = overlayEntries(buildOverlay({ ...INPUT, compression: 'auto' }));
    expect(entries.has('compaction-basic')).toBe(false);
    expect(entries.size).toBe(PROBE_ENTRIES.length);
  });

  it('adds no MCP server and no third-party plugin entry', () => {
    // Enforced by absence rather than by a disable patch: a disable for an entry
    // id that does not exist is itself the `did not activate` failure we guard.
    const overlay = buildOverlay(INPUT);
    expect([...overlayEntries(overlay).keys()]).toStrictEqual([
      ...PROBE_ENTRIES,
      'compaction-basic',
    ]);
    expect(overlay).not.toMatch(/mcp/i);
  });

  it('is byte-identical across calls, so a receipt can name it by hash', () => {
    expect(buildOverlay(INPUT)).toBe(buildOverlay(INPUT));
  });

  it('quotes scalars that YAML would otherwise retype', () => {
    // A model id of `no` read as a boolean would silently change the model.
    const overlay = buildOverlay({ ...INPUT, modelId: 'no' });
    expect(overlay).toContain("model: 'no'");
    expect(overlay).toContain("  - id: 'no'");
  });

  it('quotes a path containing a space or a colon', () => {
    const overlay = buildOverlay({ ...INPUT, attemptDir: '/var/with space/and:colon' });
    expect(overlay).toContain("workspaceRoot: '/var/with space/and:colon'");
  });

  it('refuses a proxy URL that carries a key value', () => {
    expect(() =>
      buildOverlay({ ...INPUT, proxyBaseUrl: 'http://127.0.0.1:4010?key=sk-ant-abcdefgh' }),
    ).toThrow(/overlay refused/);
  });
});

describe('assertNoSecrets', () => {
  it('accepts a credential variable name', () => {
    expect(() => assertNoSecrets('        apiKeyEnv: BIFROST_API_KEY\n')).not.toThrow();
  });

  it('refuses an sk- token in any field', () => {
    expect(() => assertNoSecrets('    apiKeyEnv: sk-ant-api03-abcdefghijklmn')).toThrow(
      /sk- prefixed API key/,
    );
  });

  it('refuses an environment assignment', () => {
    expect(() => assertNoSecrets('BIFROST_API_KEY=not-a-real-key')).toThrow(
      /credential assignment/,
    );
  });

  it('refuses a credential field holding a value', () => {
    expect(() => assertNoSecrets('  secret: hunter2')).toThrow(/credential field with a value/);
  });

  it('accepts an explicit null credential field', () => {
    expect(() => assertNoSecrets('  apiKey: null')).not.toThrow();
  });

  it('refuses a private key block', () => {
    expect(() => assertNoSecrets('-----BEGIN RSA PRIVATE KEY-----')).toThrow(/private key block/);
  });

  it('never echoes the matched value in the error', () => {
    // An error log is one of the places a leaked key ends up.
    try {
      assertNoSecrets('BIFROST_API_KEY=super-secret-value');
      expect.unreachable('should have thrown');
    } catch (cause) {
      expect((cause as Error).message).not.toContain('super-secret-value');
    }
  });

  it('reports the line number of the offending value', () => {
    expect(() => assertNoSecrets('a: 1\nb: 2\nc: sk-abcdefghijklmn')).toThrow(/line 3/);
  });
});

describe('buildDshHome', () => {
  it('gives each trust domain its own home under the factory root', () => {
    expect(buildDshHome('/factory', 'worker')).toBe('/factory/dsh-home/worker');
    expect(buildDshHome('/factory', 'evaluator')).toBe('/factory/dsh-home/evaluator');
    expect(buildDshHome('/factory', 'worker')).not.toBe(buildDshHome('/factory', 'evaluator'));
  });

  it('is deterministic and does not depend on the caller cwd', () => {
    expect(buildDshHome('/factory', 'worker')).toBe(buildDshHome('/factory', 'worker'));
  });

  it('refuses an unknown domain', () => {
    expect(() => buildDshHome('/factory', 'host' as unknown as DshDomain)).toThrow(
      /unknown DSH trust domain/,
    );
  });
});
