/**
 * The real-wall fixture, shared by the specs that need a measured verdict.
 *
 * Same shape as `e2e/cli/default/09-holdout-sabotage.test.ts` (which is the reference
 * implementation), extracted because four more specs need it: a real git mirror, a real
 * attempt clone, a real holdout corpus outside the repository, the real `evaluate()` driven
 * by its local runner, and a *scripted* worker (`FACTORY_EXECUTOR=fake`) because this host
 * has no `dsh`.
 *
 * What stays fake is only what the test cannot own: the worker's behaviour. Everything the
 * verdict is made of — patch, receipt, re-executed commands, holdout, Δ — is measured.
 *
 * The defaults are deliberately boring: a base revision with a correct `uniqueSlug`, a holdout
 * that passes on base, and a worker that writes the same correct implementation. A spec that
 * wants a different story passes `candidate`, `holdoutScenario` or `scenario`.
 */
import { execFileSync } from 'node:child_process';
import { createPrivateKey, generateKeyPairSync, sign } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { contentHash } from '../../packages/contracts/src/index.ts';
import { promotionSignaturePayload } from '../../packages/gates/src/index.ts';
import { openStore } from '../../packages/store/src/index.ts';
import { hashableScenarios, type HoldoutScenario } from '../../packages/wall/src/index.ts';
import { jsonOf, newFactoryHome, runFactory, type FactoryRun } from './factory.ts';

export const SUITE_SOURCE = `import assert from 'node:assert/strict';
import { slugify } from '../src/slug.js';

assert.equal(slugify('ABC'), 'abc');
assert.equal(slugify(' a '), 'a');
assert.equal(slugify('a.b!c'), 'a-b-c');
console.log('FACTORY_SUMMARY {"passed":3,"failed":0,"unknown":0,"exitCode":0}');
`;

/** Base: `slugify` only. The holdout needs `uniqueSlug`, so it fails here — that is the Δ. */
export const SLUG_BASE = `export function slugify(input) {
  return String(input)
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}
`;

/** Candidate: adds the uniqueness check the unit asked for. */
export const SLUG_CANDIDATE = `${SLUG_BASE}
export function uniqueSlug(existing, candidate) {
  const slug = slugify(candidate);
  if (existing.includes(slug)) return null;
  return slug;
}
`;

export const HOLDOUT_SCENARIO = `import assert from 'node:assert/strict';
import { pathToFileURL } from 'node:url';
import { join } from 'node:path';

const src = await import(pathToFileURL(join(process.cwd(), 'src', 'slug.js')).href);
assert.equal(src.uniqueSlug(['taken'], 'Taken'), null, 'a duplicate slug must be refused');
assert.equal(src.uniqueSlug(['taken'], 'free-one'), 'free-one');
`;

export const HOLDOUT_ID = 'h-77aa';
export const TASK_CLASS = 'slug-check';

export interface ScenarioSpec {
  readonly steps: readonly unknown[];
  readonly receipt?: unknown;
}

export interface WallFixtureOptions {
  /** The source the scripted worker writes. Defaults to `SLUG_CANDIDATE`. */
  readonly candidate?: string;
  /** Replace the default worker scenario entirely (steps + optional receipt claims). */
  readonly scenario?: ScenarioSpec;
  /** Replace the holdout scenario source (it always lives outside the repository). */
  readonly holdoutScenario?: string;
  /** Files the worker writes before its turn ends, beyond `src/slug.js`. */
  readonly extraFiles?: readonly { readonly path: string; readonly content: string }[];
  readonly specOverrides?: Record<string, unknown>;
}

export interface WallFixture {
  readonly root: string;
  readonly repo: string;
  readonly baseRev: string;
  readonly mirror: string;
  readonly holdoutRoot: string;
  readonly home: string;
  /** Scenario path for the default worker (writes the candidate, runs the visible suite). */
  readonly scenarioPath: string;
  wallEnv(overrides?: Record<string, string | undefined>): Record<string, string>;
  writeScenario(name: string, scenario: ScenarioSpec): string;
  submit(overrides?: Record<string, unknown>): string;
  run(unitId: string, args?: readonly string[], env?: Record<string, string>): FactoryRun;
  signPromotion(unitId: string): string;
  cleanup(): void;
}

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

export function createWallFixture(options: WallFixtureOptions = {}): WallFixture {
  const root = mkdtempSync(join(tmpdir(), 'factory-wall-'));
  const repo = join(root, 'repo');
  mkdirSync(join(repo, 'src'), { recursive: true });
  mkdirSync(join(repo, 'tests'), { recursive: true });
  writeFileSync(
    join(repo, 'package.json'),
    `${JSON.stringify({ name: 'wall-fixture', private: true, type: 'module' }, null, 2)}\n`,
  );
  writeFileSync(join(repo, 'src', 'slug.js'), SLUG_BASE);
  writeFileSync(join(repo, 'tests', 'suite.js'), SUITE_SOURCE);
  git(repo, ['init', '-q', '-b', 'main']);
  git(repo, ['add', '-A']);
  git(repo, ['commit', '-q', '-m', 'base: slugify + a correct uniqueSlug']);
  const baseRev = git(repo, ['rev-parse', 'HEAD']);

  const mirror = join(root, 'mirror.git');
  execFileSync('git', ['clone', '--mirror', '--quiet', repo, mirror], { encoding: 'utf8' });

  const holdoutRoot = join(root, 'holdout');
  const classDir = join(holdoutRoot, TASK_CLASS, HOLDOUT_ID);
  mkdirSync(classDir, { recursive: true });
  writeFileSync(join(classDir, 'h-duplicate.js'), options.holdoutScenario ?? HOLDOUT_SCENARIO);
  const scenarios: HoldoutScenario[] = [
    {
      id: 'h-duplicate',
      taskClass: TASK_CLASS,
      argv: ['node', join(classDir, 'h-duplicate.js')],
      expectExit: [0],
    },
  ];
  const sorted = [...scenarios].sort((a, b) => (a.id < b.id ? -1 : 1));
  writeFileSync(
    join(classDir, 'manifest.json'),
    `${JSON.stringify(
      {
        revision: HOLDOUT_ID,
        taskClass: TASK_CLASS,
        scenarios: sorted,
        revisionHash: contentHash(hashableScenarios(sorted)),
      },
      null,
      2,
    )}\n`,
  );

  const home = newFactoryHome();

  const stepList: unknown[] = [
    { kind: 'write', path: 'src/slug.js', content: options.candidate ?? SLUG_CANDIDATE },
    ...(options.extraFiles ?? []).map((file) => ({
      kind: 'write',
      path: file.path,
      content: file.content,
    })),
    { kind: 'command', argv: ['node', 'tests/suite.js'] },
    {
      kind: 'emit',
      events: [
        { type: 'session', sessionId: 's-e2e' },
        { type: 'turn_end', reason: { kind: 'completed' } },
      ],
    },
    { kind: 'exit', code: 0 },
  ];
  const scenarioPath = join(home, 'scenario.json');
  writeFileSync(
    scenarioPath,
    `${JSON.stringify(options.scenario ?? { steps: stepList }, null, 2)}\n`,
  );

  const specBase = {
    slug: TASK_CLASS,
    revision: 1,
    repo: 'fixture',
    baseRev,
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

  const fixture: WallFixture = {
    root,
    repo,
    baseRev,
    mirror,
    holdoutRoot,
    home,
    scenarioPath,
    wallEnv(overrides = {}) {
      const env: Record<string, string> = {
        FACTORY_EXECUTOR: 'fake',
        NODE_ENV: 'test',
        FACTORY_PRISTINE_REPO: mirror,
        FACTORY_REPO: 'fixture',
        FACTORY_HOLDOUT_ROOT: holdoutRoot,
        FACTORY_HOLDOUT_TASK_CLASS: TASK_CLASS,
        FACTORY_TEST_ROOT: 'tests',
        FACTORY_WALL_SUITE: 'node tests/suite.js',
      };
      for (const [key, value] of Object.entries(overrides)) {
        if (value === undefined) delete env[key];
        else env[key] = value;
      }
      return env;
    },
    writeScenario(name, scenario) {
      const path = join(home, name);
      writeFileSync(path, `${JSON.stringify(scenario, null, 2)}\n`);
      return path;
    },
    submit(overrides = {}) {
      const spec = { ...specBase, ...overrides };
      const specPath = join(home, `spec-${String(spec.revision)}.json`);
      writeFileSync(specPath, `${JSON.stringify(spec, null, 2)}\n`);
      const restatePath = join(home, `restate-${String(spec.revision)}.md`);
      writeFileSync(restatePath, `${String(spec.restateBack)}\n`);
      const submitted = runFactory(
        ['intent', '--file', specPath, '--restate', restatePath, '--json'],
        { home },
      );
      const json = jsonOf(submitted);
      if (submitted.code !== 0) throw new Error(`intent refused:\n${submitted.stderr}`);
      const unitId = String(json['unitId']);
      const qualified = runFactory(['qualify', unitId, '--cold-start', '--json'], { home });
      if (qualified.code !== 0) throw new Error(`qualify refused:\n${qualified.stderr}`);
      return unitId;
    },
    run(unitId, args = [], env = fixture.wallEnv()) {
      return runFactory(['run', unitId, '--scenario', scenarioPath, '--json', ...args], {
        home,
        env,
        timeoutMs: 120_000,
      });
    },
    signPromotion(unitId) {
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
      return signaturePath;
    },
    cleanup() {
      rmSync(root, { recursive: true, force: true });
    },
  };

  return fixture;
}
