/**
 * The end-to-end path, with nothing faked except the worker itself.
 *
 * Everything measured here is the real thing: a real git mirror, a real attempt clone,
 * the real `evaluate()` from `@factory/wall` driven by its local runner, a real holdout
 * corpus that genuinely fails on the base revision and passes on the candidate, a real
 * ed25519 signature and a real promotion artifact. The only substitute is the *worker*,
 * because this host has no `dsh` — and that substitution is declared by the executor
 * banner and by `sessionId: fake-…` in the ledger.
 *
 * Two properties make this the spec that proves the product works:
 *
 *   - the verdict is **measured**: the holdout fails on `base` (so Δ is real, not
 *     asserted), the pinned suite runs over the base test root, and the receipt's
 *     commands are re-executed and their output hashes compared;
 *   - promotion is **earned**: unsigned is refused with nothing on disk, signed writes
 *     the artifact.
 *
 * E2E-08 and E2E-25 of `e2e-tests.md`.
 */
import { createPrivateKey, generateKeyPairSync, sign } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { contentHash } from '../../../packages/contracts/src/index.ts';
import { hashableScenarios, type HoldoutScenario } from '../../../packages/wall/src/index.ts';
import { promotionSignaturePayload } from '../../../packages/gates/src/index.ts';
import { openStore } from '../../../packages/store/src/index.ts';
import { jsonOf, newFactoryHome, runFactory } from '../../harness/factory.ts';

/**
 * A repository whose visible suite passes on both revisions and whose holdout only
 * passes on the candidate — the shape `evaluate()` needs in order to measure Δ at all.
 *
 * The visible suite is one plain Node script rather than `node --test`, on purpose: the
 * wall's pinned suite reads a machine-readable `FACTORY_SUMMARY` line, and a suite whose
 * counts have to be scraped from a reporter's prose is exactly the parsing the amendment
 * removed.
 */
const SUITE_SOURCE = `import assert from 'node:assert/strict';
import { slugify } from '../src/slug.js';

assert.equal(slugify('ABC'), 'abc');
assert.equal(slugify(' a '), 'a');
assert.equal(slugify('a.b!c'), 'a-b-c');
console.log('FACTORY_SUMMARY {"passed":3,"failed":0,"unknown":0,"exitCode":0}');
`;

/** Base: slugify only. The holdout needs \`uniqueSlug\`, so it fails here — that is the Δ. */
const SLUG_BASE = `export function slugify(input) {
  return String(input)
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}
`;

/** Candidate: adds the uniqueness check the unit asked for. */
const SLUG_CANDIDATE = `${SLUG_BASE}
export function uniqueSlug(existing, candidate) {
  const slug = slugify(candidate);
  return existing.includes(slug) ? null : slug;
}
`;

const HOLDOUT_SCENARIO = `import assert from 'node:assert/strict';
import { pathToFileURL } from 'node:url';
import { join } from 'node:path';

// The scenario lives outside the repository and imports the candidate tree it is run in.
const src = await import(pathToFileURL(join(process.cwd(), 'src', 'slug.js')).href);
assert.equal(src.uniqueSlug(['taken'], 'Taken'), null, 'a duplicate slug must be refused');
assert.equal(src.uniqueSlug(['taken'], 'free-one'), 'free-one');
`;

const HOLDOUT_ID = 'h-77aa';

let root: string;
let repo: string;
let baseRev: string;
let mirror: string;
let holdoutRoot: string;
let home: string;
let scenarioPath: string;
let verdictPath: string;

function git(cwd: string, args: readonly string[]): string {
  return execFileSync('git', [...args], {
    cwd,
    encoding: 'utf8',
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: 'factory-e2e',
      GIT_AUTHOR_EMAIL: 'e2e@factory.invalid',
      GIT_COMMITTER_NAME: 'factory-e2e',
      GIT_COMMITTER_EMAIL: 'e2e@factory.invalid',
      GIT_CONFIG_NOSYSTEM: '1',
    },
  }).trim();
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'factory-real-wall-'));
  repo = join(root, 'repo');
  mkdirSync(join(repo, 'src'), { recursive: true });
  mkdirSync(join(repo, 'tests'), { recursive: true });
  writeFileSync(
    join(repo, 'package.json'),
    `${JSON.stringify({ name: 'wallfixture', private: true, type: 'module' }, null, 2)}\n`,
  );
  writeFileSync(join(repo, 'src', 'slug.js'), SLUG_BASE);
  writeFileSync(join(repo, 'tests', 'suite.js'), SUITE_SOURCE);
  git(repo, ['init', '-q', '-b', 'main']);
  git(repo, ['add', '-A']);
  git(repo, ['commit', '-q', '-m', 'base: slugify with a visible suite']);
  baseRev = git(repo, ['rev-parse', 'HEAD']);

  // The mirror the factory clones from; read-only by convention, never by permission.
  mirror = join(root, 'mirror.git');
  execFileSync('git', ['clone', '--mirror', '--quiet', repo, mirror], { encoding: 'utf8' });

  // The holdout corpus, outside the repository, at the revision the manifest names.
  holdoutRoot = join(root, 'holdout');
  const classDir = join(holdoutRoot, 'slug-check', HOLDOUT_ID);
  mkdirSync(classDir, { recursive: true });
  writeFileSync(join(classDir, 'h-unique.js'), HOLDOUT_SCENARIO);
  const scenarios: HoldoutScenario[] = [
    {
      id: 'h-unique',
      taskClass: 'slug-check',
      argv: ['node', join(classDir, 'h-unique.js')],
      expectExit: [0],
    },
  ];
  const sorted = [...scenarios].sort((a, b) => (a.id < b.id ? -1 : 1));
  writeFileSync(
    join(classDir, 'manifest.json'),
    `${JSON.stringify(
      {
        revision: HOLDOUT_ID,
        taskClass: 'slug-check',
        scenarios: sorted,
        revisionHash: contentHash(hashableScenarios(sorted)),
      },
      null,
      2,
    )}\n`,
  );

  home = newFactoryHome();

  // The worker: writes the candidate file, runs the visible suite for real (so the
  // receipt's command is faithful), ends its turn, exits 0.
  scenarioPath = join(home, 'scenario.json');
  writeFileSync(
    scenarioPath,
    `${JSON.stringify(
      {
        steps: [
          { kind: 'write', path: 'src/slug.js', content: SLUG_CANDIDATE },
          { kind: 'command', argv: ['node', 'tests/suite.js'] },
          {
            kind: 'emit',
            events: [
              { type: 'session', sessionId: 's-e2e' },
              { type: 'turn_end', reason: { kind: 'completed' } },
            ],
          },
          { kind: 'exit', code: 0 },
        ],
      },
      null,
      2,
    )}\n`,
  );
  // Present but unused: a real wall measures, so a fake template must never be read.
  verdictPath = join(home, 'verdict.json');
  writeFileSync(verdictPath, '{"outcome":"pass","reasons":[],"scenarios":[]}\n');
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

function wallEnv(overrides: Record<string, string | undefined> = {}): Record<string, string> {
  const env: Record<string, string> = {
    FACTORY_EXECUTOR: 'fake',
    NODE_ENV: 'test',
    FACTORY_PRISTINE_REPO: mirror,
    FACTORY_REPO: 'fixture',
    FACTORY_HOLDOUT_ROOT: holdoutRoot,
    FACTORY_HOLDOUT_TASK_CLASS: 'slug-check',
    FACTORY_TEST_ROOT: 'tests',
    FACTORY_WALL_SUITE: 'node tests/suite.js',
  };
  for (const [key, value] of Object.entries(overrides)) {
    if (value === undefined) delete env[key];
    else env[key] = value;
  }
  return env;
}

function specJson(): Record<string, unknown> {
  return {
    slug: 'slug-check',
    revision: 1,
    repo: 'fixture',
    baseRev,
    // Wording mirrors the accepted `specFor` fixture in the harness: the qualifier's
    // INTENT_DERIVABILITY signal measures restate/intent overlap, and a paraphrase that
    // scores below 0.5 is rejected before dispatch (correctly).
    intent:
      'Add a slug-uniqueness check on the read path so duplicate slugs are rejected before insert.',
    restateBack:
      'You asked for: a slug uniqueness check on the read path, proven by a unit test. Not asking for: a schema migration.',
    acceptance: [
      {
        id: 'suite-green',
        text: 'node tests/suite.js exits 0',
        oracle: { kind: 'command', target: 'node tests/suite.js', expect: 'exit 0' },
      },
    ],
    touchPaths: ['src/slug.js'],
    operationClasses: ['code-change'],
    sizeBudget: { files: 4, lines: 80 },
    budgetEstimateUsd: 0.42,
  };
}

function submit(): string {
  const specPath = join(home, 'spec.json');
  writeFileSync(specPath, `${JSON.stringify(specJson(), null, 2)}\n`);
  const restatePath = join(home, 'restate.md');
  writeFileSync(restatePath, `${String(specJson()['restateBack'])}\n`);
  const submitted = runFactory(['intent', '--file', specPath, '--restate', restatePath, '--json'], {
    home,
  });
  const json = jsonOf(submitted);
  if (submitted.code !== 0) throw new Error(`intent refused:\n${submitted.stderr}`);
  const unitId = String(json['unitId']);
  const qualified = runFactory(['qualify', unitId, '--cold-start', '--json'], { home });
  if (qualified.code !== 0) throw new Error(`qualify refused:\n${qualified.stderr}`);
  return unitId;
}

function signPromotion(unitId: string): { signaturePath: string } {
  const keys = join(home, 'keys');
  mkdirSync(keys, { recursive: true });
  const privateFile = join(keys, 'operator.key.pem');
  if (!existsSync(privateFile)) {
    const pair = generateKeyPairSync('ed25519', {
      privateKeyEncoding: { format: 'pem', type: 'pkcs8' },
      publicKeyEncoding: { format: 'pem', type: 'spki' },
    });
    writeFileSync(privateFile, pair.privateKey);
    writeFileSync(join(keys, 'operator.pub.pem'), pair.publicKey);
  }
  const store = openStore({ dir: join(home, 'state') });
  let payload: string;
  try {
    const row = store.latestVerdictForUnit(unitId);
    if (row === null) throw new Error(`no verdict for ${unitId}`);
    payload = promotionSignaturePayload({
      unitId,
      verdict: row.verdict,
      approvedBy: 'operator',
    }).payload;
  } finally {
    store.close();
  }
  const signature = sign(
    null,
    Buffer.from(payload, 'utf8'),
    createPrivateKey(readFileSync(privateFile, 'utf8')),
  );
  const signaturePath = join(home, 'signature.txt');
  writeFileSync(signaturePath, signature.toString('base64'));
  return { signaturePath };
}

describe('run to verdict to promotion, with the real wall', () => {
  it('measures a pass with the local runner, then refuses an unsigned promotion and accepts a signed one', () => {
    const unitId = submit();

    const run = runFactory(['run', unitId, '--scenario', scenarioPath, '--json'], {
      home,
      env: wallEnv(),
    });
    const runJson = jsonOf(run);

    expect(run.code).toBe(0);
    expect(runJson['outcome']).toBe('pass');
    // The instrument is named: no containment, no container, and it says so.
    expect(String(runJson['wallVersion'])).toContain('+local');
    expect(runJson['wallVersion']).not.toContain('-fake');
    expect(runJson['fakeWall']).toBe(false);
    expect(runJson['reasons']).toEqual([]);
    // The worker was the only fake, and the banner says which half was fake.
    expect(run.stderr).toContain('executor: FAKE (no DSH process launched)');
    expect(run.stderr).toContain('wall: local runner');

    // Δ was measured, not asserted: the holdout fails on base and passes on candidate.
    const store = openStore({ dir: join(home, 'state') });
    try {
      const row = store.latestVerdictForUnit(unitId);
      expect(row).not.toBeNull();
      expect(row?.verdict.outcome).toBe('pass');
      expect(row?.verdict.delta.checked).toBe(true);
      expect(row?.verdict.delta.baseRate).toBe(0);
      expect(row?.verdict.delta.candidateRate).toBe(1);
      expect(row?.verdict.holdoutRevision).toBe(HOLDOUT_ID);
      // Every scenario the wall ran passed, and there is at least one of each kind.
      const sources = new Set(row?.verdict.scenarios.map((scenario) => scenario.source));
      expect(sources.has('holdout')).toBe(true);
      expect(sources.has('acceptance')).toBe(true);
      expect(sources.has('faithfulness')).toBe(true);
      expect(sources.has('suite')).toBe(true);
    } finally {
      store.close();
    }

    // Unsigned: refused, and nothing is written — not even a draft artifact directory.
    const unsigned = runFactory(['promote', unitId, '--json'], { home });
    expect(unsigned.code).toBe(5);
    expect(jsonOf(unsigned)['code']).toBe('PROMOTION_UNSIGNED');
    expect(existsSync(join(home, 'artifacts', unitId))).toBe(false);

    // A pass verifies; it does not promote itself.
    const beforeSign = jsonOf(runFactory(['status', unitId, '--json'], { home }));
    const beforeUnit = (beforeSign['units'] as Record<string, unknown>[])[0];
    expect(beforeUnit?.['state'], JSON.stringify(beforeUnit)).toBe('verified');

    // Signed: the artifact is written, and it names the verdict it came from.
    const { signaturePath } = signPromotion(unitId);
    const signed = runFactory(
      [
        'promote',
        unitId,
        '--signature',
        signaturePath,
        '--confirm',
        `sign promotion ${unitId}`,
        '--json',
      ],
      { home },
    );
    expect(signed.code, signed.stderr).toBe(0);
    const promotionPath = join(home, 'artifacts', unitId, 'promotion.yaml');
    expect(existsSync(promotionPath)).toBe(true);
    const artifact = readFileSync(promotionPath, 'utf8');
    expect(artifact).toContain('verdict_outcome: "pass"');
    expect(artifact).toContain('approved_by: "operator"');
    // `minDeltaSamples: 0` disables the class-certification gate, so this unit needed
    // no signature for *certification* — the signature below is the promotion gate, and
    // the artifact says which of the two applied.
    expect(artifact).toContain('promotion_requires_human_signature: false');
    // The signature is armoured, and the payload it covers is named by hash.
    expect(artifact).toContain('-----BEGIN SIGNATURE-----');
    expect(artifact).toContain('signature_payload_sha:');
    expect(artifact).toMatch(/promotion_sha: "sha256:[0-9a-f]{64}"/);

    // Nothing was pushed and nothing was deployed: the fixture repository is untouched.
    expect(git(repo, ['rev-parse', 'HEAD'])).toBe(baseRev);
  });

  it('rejects a receipt whose claimed command does not reproduce (E2E-30)', () => {
    const unitId = submit();
    // The worker *claims* `node -e "process.exit(1)"` exited 0. It did not: the wall
    // re-executes every recorded command and compares exit code and output hash, so the
    // claim is caught by measurement rather than by suspicion.
    const lying = join(home, 'lying.json');
    writeFileSync(
      lying,
      `${JSON.stringify({
        steps: [
          { kind: 'write', path: 'src/slug.js', content: SLUG_CANDIDATE },
          {
            kind: 'emit',
            events: [
              { type: 'session', sessionId: 's-liar' },
              { type: 'turn_end', reason: { kind: 'completed' } },
            ],
          },
          { kind: 'exit', code: 0 },
        ],
        receipt: {
          commands: [{ argv: ['node', '-e', 'process.exit(1)'], exitCode: 0, output: 'all good' }],
          ceilings: { turnsUsed: 1, wallClockMs: 5, hit: [] },
        },
      })}\n`,
    );

    const run = runFactory(['run', unitId, '--scenario', lying, '--json'], {
      home,
      env: wallEnv({ FACTORY_WALL_SUITE: 'node tests/suite.js' }),
    });
    const json = jsonOf(run);

    expect(run.code, run.stderr).toBe(3);
    expect(json['outcome']).toBe('fail');
    expect(json['reasons']).toContain('receipt_unfaithful');
    // The operator learns which layer diverged; the worker never learns which byte.
    expect(run.stderr).toContain('receipt_unfaithful');
    expect(run.stderr).not.toContain('all good');
  });

  it('re-measures a recorded receipt with --verify-only and dispatches nothing', () => {
    const unitId = submit();
    // A first run whose verdict is *unknown*: no pinned suite, so the wall has no oracle.
    const blind = runFactory(['run', unitId, '--scenario', scenarioPath, '--json'], {
      home,
      env: wallEnv({ FACTORY_WALL_SUITE: undefined }),
    });
    expect(blind.code).not.toBe(0);
    expect(blind.stderr).toContain('no FACTORY_WALL_SUITE');

    // The unknown verdict left the unit receipted; the count of attempts is the thing
    // that must not move, because `--verify-only` re-measures evidence it already has.
    const beforeJson = jsonOf(runFactory(['status', unitId, '--json'], { home }));
    const beforeUnit = (beforeJson['units'] as Record<string, unknown>[])[0];
    // The status renderer presents an unmeasured verdict as `unknown` rather than
    // `receipted`: from an operator's chair the unit is not merely receipted, it is a
    // unit with evidence nobody was able to judge.
    expect(beforeUnit?.['state'], JSON.stringify(beforeUnit)).toBe('unknown');
    expect(beforeUnit?.['verdict']).toMatchObject({
      state: 'unknown',
      unknownReason: 'suite_unknown',
    });
    const attemptBefore = JSON.parse(
      String(beforeUnit?.['attempt'] === null ? 'null' : JSON.stringify(beforeUnit?.['attempt'])),
    ) as Record<string, unknown> | null;

    // Same evidence, now with the suite declared: measured, and still one attempt.
    const verified = runFactory(['run', unitId, '--verify-only', '--json'], {
      home,
      env: wallEnv(),
    });
    expect(verified.code).toBe(0);
    expect(jsonOf(verified)['dispatched']).toBe(false);
    expect(jsonOf(verified)['outcome']).toBe('pass');

    const afterJson = jsonOf(runFactory(['status', unitId, '--json'], { home }));
    const afterUnit = (afterJson['units'] as Record<string, unknown>[])[0];
    expect(afterUnit?.['state']).toBe('verified');
    const attemptAfter = JSON.parse(
      String(afterUnit?.['attempt'] === null ? 'null' : JSON.stringify(afterUnit?.['attempt'])),
    ) as Record<string, unknown> | null;
    expect(attemptAfter?.['attemptId']).toBe(attemptBefore?.['attemptId']);
    expect(attemptAfter?.['number']).toBe(attemptBefore?.['number']);
  });
});

describe('a factory with no usable mirror fails closed', () => {
  it('refuses to dispatch with exit 8, naming the key and the runbook, before anything is reserved', () => {
    const unitId = submit();

    const run = runFactory(['run', unitId, '--scenario', scenarioPath, '--json'], {
      home,
      env: wallEnv({ FACTORY_PRISTINE_REPO: undefined }),
    });
    const json = jsonOf(run);

    expect(run.code).toBe(8);
    expect(json['code']).toBe('EXECUTOR_UNAVAILABLE');
    expect(String(json['message'])).toContain('FACTORY_PRISTINE_REPO');
    expect(String(json['message'])).toContain('git clone --mirror');

    // Fail closed means: no attempt row, no attempt directory, no budget reserved.
    const status = jsonOf(runFactory(['status', unitId, '--json'], { home }));
    const unit = (status['units'] as Record<string, unknown>[])[0];
    expect(unit?.['attempt']).toBeNull();
    expect(existsSync(join(home, 'attempts', unitId))).toBe(false);
  });

  it('refuses a mirror that belongs to another repository', () => {
    const unitId = submit();
    const run = runFactory(['run', unitId, '--scenario', scenarioPath, '--json'], {
      home,
      env: wallEnv({ FACTORY_REPO: 'some-other-repo' }),
    });
    expect(run.code).toBe(8);
    expect(String(jsonOf(run)['message'])).toContain('some-other-repo');
  });
});
