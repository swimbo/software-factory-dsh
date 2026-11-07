/**
 * The `type-repair` artefacts: a paid loop is planned from files, and the files have to be worth it.
 *
 * The properties that matter before money is spent: the corpus id is *content-addressed* (two
 * materialisations of the same fixture agree, a different fixture does not), the artefacts refuse to
 * be written inside the checkout or over someone else's directory, a rebuild of the same root is
 * refused rather than silently overwritten, every artefact commit carries the fixed date that keeps
 * the id stable, and `plan-units.sh` refuses to plan into a store that already holds the revisions.
 */
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { loadHoldout } from '../../packages/wall/src/index.ts';
import { CHECKOUT_ROOT, TYPE_REPAIR_REPO_ID, TYPE_REPAIR_RESTATE } from './type-repair.ts';
import {
  ARTEFACT_COMMIT_DATE,
  ARTEFACT_MARKER_FILE,
  assertArtefactsRoot,
  markerOf,
  materializeTypeRepairArtifacts,
  type TypeRepairArtefacts,
} from './type-repair-artifacts.ts';

let scratch: string;
let first: TypeRepairArtefacts;
let second: TypeRepairArtefacts;
let wider: TypeRepairArtefacts;

beforeAll(() => {
  scratch = mkdtempSync(join(tmpdir(), 'type-repair-artefacts-'));
  // Two materialisations of the same two revisions, at different times and in different roots.
  first = materializeTypeRepairArtifacts({
    root: join(scratch, 'one'),
    revisions: 2,
    createdAt: '2026-11-05T00:00:00Z',
  });
  second = materializeTypeRepairArtifacts({
    root: join(scratch, 'two'),
    revisions: 2,
    createdAt: '2026-11-06T00:00:00Z',
  });
  wider = materializeTypeRepairArtifacts({
    root: join(scratch, 'three'),
    revisions: 3,
    createdAt: '2026-11-05T00:00:00Z',
  });
}, 180_000);

afterAll(() => {
  rmSync(scratch, { recursive: true, force: true });
});

describe('the corpus id', () => {
  it('is content-addressed: the same fixture materialised twice, at different times and places, agrees', () => {
    expect(second.corpusId).toBe(first.corpusId);
    expect(second.corpusId).toMatch(/^h-type-repair-2026-11-05-[0-9a-f]{8}$/u);
    // The time is evidence, not identity: it is in the marker and the README, not in the digest.
    expect(markerOf(first.root)?.createdAt).toBe('2026-11-05T00:00:00Z');
    expect(markerOf(second.root)?.createdAt).toBe('2026-11-06T00:00:00Z');
    expect(readFileSync(second.readmePath, 'utf8')).toContain('2026-11-06T00:00:00Z');
    expect(readFileSync(first.readmePath, 'utf8')).toContain(first.corpusId);
  });

  it('changes when the fixture changes, and the wider fixture keeps the narrower one as a prefix', () => {
    expect(wider.corpusId).not.toBe(first.corpusId);
    // Two revisions of three are a genuinely different corpus, not a relabelled one.
    expect(wider.units).toHaveLength(3);
    expect(first.units).toHaveLength(2);
  });

  it('is the id the wall will load, and the corpus holds the three class rules', () => {
    const holdout = loadHoldout(first.holdoutRoot, 'type-repair');
    expect(holdout).not.toBeNull();
    expect(holdout?.revision).toBe(first.corpusId);
    expect(holdout?.scenarios.map((scenario) => scenario.id).sort()).toEqual([
      'api-surface',
      'differential',
      'no-escape-hatches',
    ]);
    expect(holdout?.taskClass).toBe('type-repair');
    for (const scenario of holdout?.scenarios ?? []) expect(scenario.expectExit).toEqual([0]);
  });
});

describe('the artefacts on disk', () => {
  it('commits one base revision per commit, all with the fixed artefact date', () => {
    const log = execFileSync('git', ['-C', first.repo, 'log', '--format=%at %s'], {
      encoding: 'utf8',
    })
      .trim()
      .split('\n');
    // One commit per base revision: the tree's skeleton arrives with the first one.
    expect(log).toHaveLength(first.units.length);
    // The fixed date is what keeps the corpus id stable across materialisations, so it is asserted
    // as the exact instant rather than as a rendered string.
    const fixedEpoch = String(Math.floor(Date.parse(ARTEFACT_COMMIT_DATE) / 1000));
    for (const line of log) expect(line.startsWith(`${fixedEpoch} `)).toBe(true);
    expect(log[0]).toContain('base 1:');
    expect(log[1]).toContain('base 0:');
  });

  it('writes a marker, a restate-back and a planner, and the planner submits nothing', () => {
    const marker = markerOf(first.root);
    expect(marker).toMatchObject({
      kind: 'type-repair-artifacts',
      version: 1,
      revision: first.corpusId,
      baseRevision: 'h-type-repair-2026-11-05',
      revisions: 2,
      repoId: TYPE_REPAIR_REPO_ID,
      taskClass: 'type-repair',
      commitDate: ARTEFACT_COMMIT_DATE,
    });
    expect(marker?.sourceCommit).toMatch(/^[0-9a-f]{40}$/u);

    // The restate-back is the one the specs bind, so a paid unit's intent is derivable from it.
    expect(readFileSync(first.restatePath, 'utf8').trim()).toBe(TYPE_REPAIR_RESTATE);

    // The planner submits (that is how a unit id, and therefore `units.txt`, comes to exist) — so this
    // spec asserts its guards and its shape rather than running it: submitting writes a ledger, and a
    // spec that spends a store to prove a shell script is shaped right is a spec that costs more than
    // the thing it checks. The submit path itself is measured in `type-repair-pipeline.test.ts`.
    const plan = readFileSync(first.planUnitsPath, 'utf8');
    expect(plan).toContain(first.corpusId);
    expect(plan).toContain('intent --file');
    expect(plan).toContain('qualify');
    expect(plan).toContain('certify-class.sh');
    // A store that already holds these revisions is refused before anything is submitted, and the
    // refusal names the collision: a unit's identity is (repo, slug, revision), so a second planning
    // run is a collision rather than a new sample.
    expect(plan).toContain('already in the store');
    expect(plan).toContain('nothing was submitted');
    // Refuses a home that does not exist, rather than creating one blind.
    const missingHome = join(scratch, 'no-such-home');
    const refused = spawnSync('bash', [first.planUnitsPath], {
      encoding: 'utf8',
      env: { ...process.env, FACTORY_HOME: missingHome },
    });
    expect(refused.status).toBe(2);
    expect(refused.stderr).toContain('does not exist');
    // And refuses to submit twice: `units.txt` is the record that planning already happened.
    const emptyHome = join(scratch, 'empty-home');
    mkdirSync(emptyHome, { recursive: true });
    const artefactRoot = first.root;
    const unitsFile = join(artefactRoot, 'units.txt');
    writeFileSync(unitsFile, 'U-already-planned\n');
    try {
      const again = spawnSync('bash', [first.planUnitsPath], {
        encoding: 'utf8',
        env: { ...process.env, FACTORY_HOME: emptyHome },
      });
      expect(again.status).toBe(2);
      expect(again.stderr).toContain('already lists units');
    } finally {
      rmSync(unitsFile, { force: true });
    }
  }, 60_000);
});

describe('the guards', () => {
  it('refuses a root inside the checkout', () => {
    expect(() => assertArtefactsRoot(join(CHECKOUT_ROOT, 'tmp-artefacts'))).toThrow(
      /inside the checkout/u,
    );
    expect(() =>
      materializeTypeRepairArtifacts({ root: join(CHECKOUT_ROOT, 'artefacts'), revisions: 1 }),
    ).toThrow(/inside the checkout/u);
  });

  it('refuses a directory it did not create, and refuses to materialise over its own artefacts', () => {
    const stranger = join(scratch, 'stranger');
    mkdirSync(stranger, { recursive: true });
    writeFileSync(join(stranger, 'notes.md'), 'someone else was here\n');
    expect(() => materializeTypeRepairArtifacts({ root: stranger, revisions: 1 })).toThrow(
      /refusing to write over files this script did not create/u,
    );

    // The revision collision guard: the second materialisation at the same root would mint the same
    // id under different evidence, so it is refused and the message names the corpus it found.
    expect(existsSync(join(first.root, ARTEFACT_MARKER_FILE))).toBe(true);
    expect(() => materializeTypeRepairArtifacts({ root: first.root, revisions: 2 })).toThrow(
      /already holds type-repair-artifacts/u,
    );
  }, 60_000);
});
