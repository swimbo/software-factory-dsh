/**
 * `factory audit --certifications` — the ND1 half that makes a stale certificate a refusal.
 *
 * The properties worth a spec are the ones an operator would get wrong by trusting a green check:
 *
 * - a class certified under the running policy is **current** and the audit exits 0;
 * - a changed policy version makes it **stale** and the audit exits **9** — expired evidence, not a
 *   warning someone can scroll past;
 * - a `not-certified` or `insufficient` record is **never-certified**, whatever the policy says;
 * - a verified unit whose verdict carries no class judgement at all is reported, not skipped.
 *
 * The audit is read-only and works on a quarantined store, so everything here goes through the same
 * store the CLI opens — no fake, no `--force`.
 */
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { contentHash } from '@factory/contracts';
import { DEFAULT_POLICY, currentPolicyVersion } from '@factory/qualifier';
import { openStore } from '@factory/store';

import { EXIT } from './exit.ts';
import { FIXED_NOW, baseSpec, jsonOf, runCli, seedUnit, tempHome } from './testing.ts';

interface CertificateSeed {
  readonly taskClass: string;
  readonly outcome: 'certified' | 'not-certified' | 'insufficient';
  readonly passes: number;
  readonly samples: number;
  readonly policyVersion?: string;
  readonly modelId?: string | null;
  /**
   * Two rows for one class need two *units* — a unit may hold only one live lease, and a second
   * submission of the same slug is the same unit. A different slug is a different unit in the
   * same class, which is what the loop produces and what the projection groups on.
   */
  readonly slug?: string;
}

/**
 * Seed one unit, attempt and verdict carrying a certificate, the way the wall records them.
 *
 * The verdict outcome is `unknown` on purpose: this spec is about the certificate projection, and
 * `unknown` needs no receipt. The store writes the certificate regardless of outcome, which is
 * exactly the point — a class can be `insufficient` on a verdict that measured nothing.
 */
function seedCertificate(home: string, seed: CertificateSeed, index: number): string {
  const store = openStore({ dir: join(home, 'state') });
  const { unitId } = seedUnit(home, seed.slug === undefined ? {} : { spec: { slug: seed.slug } });
  const attemptId = `A-${index.toString()}`;
  const options = { actor: 'wall', traceId: `T-seed-${index.toString()}`, occurredAt: FIXED_NOW };
  store.acquireLease({
    leaseId: `L-${attemptId}`,
    unitId,
    owner: 'control-1',
    acquiredAt: FIXED_NOW,
    expiresAt: '2026-11-02T00:00:00.000Z',
  });
  store.insertAttempt({
    attemptId,
    unitId,
    leaseId: `L-${attemptId}`,
    state: 'planned',
    launchKey: `launch:${unitId}:${attemptId}`,
    sessionId: null,
    attemptDir: `/tmp/attempts/${attemptId}`,
    startedAt: FIXED_NOW,
    endedAt: null,
    exitCode: null,
  });
  const spec = baseSpec();
  store.insertVerdict(
    {
      verdictId: `V-${index.toString()}`,
      unitId,
      attemptId,
      receiptId: null,
      receiptSha: null,
      holdoutRevision: null,
      policyVersion: seed.policyVersion ?? currentPolicyVersion(),
      wallVersion: 'wall/0.1.0',
      outcome: 'unknown',
      evaluatedAt: FIXED_NOW,
      verdict: {
        unitId,
        attemptId,
        receiptSha: `sha256:${'a'.repeat(64)}`,
        holdoutRevision: `holdout/${index.toString()}`,
        policyVersion: seed.policyVersion ?? currentPolicyVersion(),
        wallVersion: 'wall/0.1.0',
        outcome: 'unknown',
        scenarios: [],
        delta: {
          checked: false,
          baseRate: 0,
          candidateRate: 0,
          threshold: 0,
          observed: null,
          holdoutRevision: `holdout/${index.toString()}`,
        },
        reasons: ['holdout_unavailable'],
        ...(seed.modelId === null ? {} : { modelId: seed.modelId ?? 'auto' }),
        certification: {
          taskClass: seed.taskClass,
          m: 20,
          k: 18,
          p0: 0.95,
          alpha: 0.07548367378849634,
          samples: seed.samples,
          passes: seed.passes,
          outcome: seed.outcome,
        },
        evaluatedAt: FIXED_NOW,
      },
    },
    options,
  );
  store.close();
  void spec;
  return unitId;
}

function audit(
  home: string,
  env: Record<string, string | undefined> = {},
): ReturnType<typeof runCli> {
  return runCli(['audit', '--certifications', '--json'], { home, env });
}

describe('factory audit --certifications', () => {
  it('exits 0 when every class certified under the running policy and model', () => {
    const home = tempHome();
    seedCertificate(
      home,
      { taskClass: 'refactor-extract-helper', outcome: 'certified', passes: 18, samples: 20 },
      1,
    );
    const result = audit(home, { FACTORY_MODEL_ID: 'auto' });
    expect(result.status).toBe(EXIT.ok);
    const payload = jsonOf(result);
    expect(payload['kind']).toBe('certifications');
    const classes = payload['classes'] as Array<Record<string, unknown>>;
    expect(classes).toHaveLength(1);
    expect(classes[0]).toMatchObject({
      taskClass: 'refactor-extract-helper',
      state: 'current',
      outcome: 'certified',
      samples: 20,
      m: 20,
      alpha: 0.07548367378849634,
    });
    expect(result.stderr).toContain('1 of 1 classes current');
  });

  it('exits 9 when the policy version changed, and says which versions', () => {
    const home = tempHome();
    seedCertificate(
      home,
      {
        taskClass: 'refactor-extract-helper',
        outcome: 'certified',
        passes: 18,
        samples: 20,
        policyVersion: 'policy/2026-10-01',
      },
      1,
    );
    const result = audit(home, { FACTORY_MODEL_ID: 'auto' });
    expect(result.status).toBe(EXIT.integrity);
    const payload = jsonOf(result);
    const classes = payload['classes'] as Array<Record<string, unknown>>;
    expect(classes[0]?.['state']).toBe('stale');
    expect(classes[0]?.['reasons']).toContainEqual(
      expect.stringContaining('re-certify: policy changed'),
    );
    expect(result.stderr).toContain('re-certify: policy changed');
    expect(result.stderr).toContain('expired evidence, not a warning');
  });

  it('exits 9 for insufficient evidence, and never calls it current', () => {
    const home = tempHome();
    seedCertificate(
      home,
      { taskClass: 'tiny-class', outcome: 'insufficient', passes: 3, samples: 3 },
      1,
    );
    const result = audit(home, { FACTORY_MODEL_ID: 'auto' });
    expect(result.status).toBe(EXIT.integrity);
    const classes = jsonOf(result)['classes'] as Array<Record<string, unknown>>;
    expect(classes[0]).toMatchObject({ taskClass: 'tiny-class', state: 'never-certified' });
    expect(result.stderr).toContain('tiny-class  never-certified');
    // The word the audit must never print for this class.
    expect(result.stderr).not.toContain('tiny-class  current');
  });

  it('exits 9 for not-certified, even under the running policy', () => {
    const home = tempHome();
    seedCertificate(
      home,
      { taskClass: 'flaky-class', outcome: 'not-certified', passes: 17, samples: 20 },
      1,
    );
    const result = audit(home, { FACTORY_MODEL_ID: 'auto' });
    expect(result.status).toBe(EXIT.integrity);
    const classes = jsonOf(result)['classes'] as Array<Record<string, unknown>>;
    expect(classes[0]).toMatchObject({ state: 'never-certified', outcome: 'not-certified' });
  });

  it('exits 9 when no class has ever been certified', () => {
    const home = tempHome();
    seedUnit(home, { lane: 'dark' });
    const result = audit(home, { FACTORY_MODEL_ID: 'auto' });
    expect(result.status).toBe(EXIT.integrity);
    expect(jsonOf(result)['classes']).toEqual([]);
  });

  it('refuses a unit id with --certifications, because it audits classes', () => {
    const home = tempHome();
    const result = runCli(['audit', '--certifications', 'U-7f3a9c'], { home });
    expect(result.status).toBe(EXIT.usage);
    expect(result.stderr).toContain('audits classes');
  });

  /**
   * Defect A: a dispatch ceiling is not part of what a pass means.
   *
   * `maxConcurrentAttempts`/`maxConcurrentWalls` used to be fields of `QualifierPolicy`, so they
   * were folded into `currentPolicyVersion`. A loop that had to raise the attempt ceiling minted
   * its certificate under a digest the default environment could never reproduce, and every
   * morning's `audit --certifications` called a perfectly-current certificate stale.
   */
  it('reports the same policy version whether or not the dispatch ceiling is raised', () => {
    const home = tempHome();
    const shipped = jsonOf(audit(home, { FACTORY_MODEL_ID: 'auto' }));
    const raised = jsonOf(
      audit(home, {
        FACTORY_MODEL_ID: 'auto',
        FACTORY_MAX_CONCURRENT_ATTEMPTS: '4',
        FACTORY_MAX_CONCURRENT_WALLS: '2',
      }),
    );
    expect(raised['policyVersion']).toBe(shipped['policyVersion']);
    expect(String(shipped['policyVersion'])).toMatch(/^sha256:/);
  });

  it('treats a certificate recorded under a different dispatch ceiling as current, not stale', () => {
    // The certificate the live loop earned: 20 attempts, 19 passes, recorded while the attempt
    // ceiling was 4 (two abandoned attempts held live leases). Its digest is the *pre-split*
    // projection — rules + ceilings — so it can only be recognised, never recomputed.
    const home = tempHome();
    const legacyPolicyVersion = contentHash({
      ...DEFAULT_POLICY,
      maxConcurrentAttempts: 4,
      maxConcurrentWalls: 1,
    });
    expect(legacyPolicyVersion).not.toBe(currentPolicyVersion());
    seedCertificate(
      home,
      {
        taskClass: 'docs-typo-fix',
        outcome: 'certified',
        passes: 19,
        samples: 20,
        policyVersion: legacyPolicyVersion,
      },
      1,
    );

    const defaultCeiling = audit(home, { FACTORY_MODEL_ID: 'auto' });
    expect(defaultCeiling.status).toBe(EXIT.ok);
    expect(jsonOf(defaultCeiling)['classes']).toEqual([
      expect.objectContaining({ taskClass: 'docs-typo-fix', state: 'current' }),
    ]);
    expect(defaultCeiling.stderr).toContain('1 of 1 classes current');
    expect(defaultCeiling.stderr).not.toContain('re-certify');

    // …and it stays current if the operator runs the audit under the ceiling they certified at.
    const raised = audit(home, {
      FACTORY_MODEL_ID: 'auto',
      FACTORY_MAX_CONCURRENT_ATTEMPTS: '4',
    });
    expect(raised.status).toBe(EXIT.ok);
  });

  it('still calls a certificate stale when the rules themselves changed', () => {
    // The recognition is "same rules, different limits", not "any old digest is fine": a digest
    // produced by the pre-split projection of a *different* rule set must stay stale.
    const home = tempHome();
    const differentRules = contentHash({
      ...DEFAULT_POLICY,
      darkThreshold: 95,
      maxConcurrentAttempts: 4,
      maxConcurrentWalls: 1,
    });
    seedCertificate(
      home,
      {
        taskClass: 'docs-typo-fix',
        outcome: 'certified',
        passes: 19,
        samples: 20,
        policyVersion: differentRules,
      },
      1,
    );
    const result = audit(home, { FACTORY_MODEL_ID: 'auto' });
    expect(result.status).toBe(EXIT.integrity);
    const classes = jsonOf(result)['classes'] as Array<Record<string, unknown>>;
    expect(classes[0]?.['state']).toBe('stale');
  });

  it('prints the counts of the certificate the state came from, not a newer insufficient attempt', () => {
    // The sequence the live store is about to see: the pre-change certificate is `certified` at
    // 20/20, and the first attempt after the criteria log gained its identity starts its own
    // count at 1, so it writes an `insufficient` row. The class is still `current` — the certified
    // row is found by the judgement — and the numbers printed beside it must be *its* numbers:
    // `state: current` next to `samples: 1, outcome: insufficient` reads as a contradiction.
    const home = tempHome();
    const legacyPolicyVersion = contentHash({
      ...DEFAULT_POLICY,
      maxConcurrentAttempts: 4,
      maxConcurrentWalls: 1,
    });
    seedCertificate(
      home,
      {
        taskClass: 'docs-typo-fix',
        outcome: 'certified',
        passes: 19,
        samples: 20,
        policyVersion: legacyPolicyVersion,
      },
      1,
    );
    seedCertificate(
      home,
      {
        taskClass: 'docs-typo-fix',
        outcome: 'insufficient',
        passes: 1,
        samples: 1,
        slug: 'slug-check-next-attempt',
      },
      2,
    );

    const result = audit(home, { FACTORY_MODEL_ID: 'auto' });
    expect(result.status).toBe(EXIT.ok);
    expect(jsonOf(result)['classes']).toEqual([
      expect.objectContaining({
        taskClass: 'docs-typo-fix',
        state: 'current',
        outcome: 'certified',
        samples: 20,
        m: 20,
      }),
    ]);
  });
});
