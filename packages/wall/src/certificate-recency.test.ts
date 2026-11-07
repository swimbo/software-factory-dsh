import { describe, expect, it } from 'vitest';

import {
  certificateRecency,
  certificatesRecency,
  type StoredCertificate,
} from './certificate-recency.ts';

const RUNNING = { policyVersion: 'policy/2026-11-01', modelId: 'auto' } as const;
const CORPUS = 'h-refactor-2026-11-01';

function certified(over: Partial<StoredCertificate> = {}): StoredCertificate {
  return {
    taskClass: 'refactor-extract-helper',
    outcome: 'certified',
    policyVersion: RUNNING.policyVersion,
    modelId: RUNNING.modelId,
    holdoutRevision: CORPUS,
    recordedAt: '2026-11-01T12:00:00.000Z',
    ...over,
  };
}

describe('certificate recency (ND1 half two)', () => {
  it('[a certified class under the running policy and model is current]', () => {
    const recency = certificateRecency({
      taskClass: certified().taskClass,
      certificates: [certified()],
      running: RUNNING,
    });
    expect(recency.state).toBe('current');
  });

  it('[a changed policy version makes the certificate stale, and says which versions]', () => {
    const recency = certificateRecency({
      taskClass: certified().taskClass,
      certificates: [certified({ policyVersion: 'policy/2026-10-01' })],
      running: RUNNING,
    });
    expect(recency.state).toBe('stale');
    if (recency.state !== 'stale') throw new Error('unreachable');
    expect(recency.reasons).toEqual([
      're-certify: policy changed (certified under policy/2026-10-01, running policy/2026-11-01)',
    ]);
  });

  it('[a changed model id makes the certificate stale]', () => {
    const recency = certificateRecency({
      taskClass: certified().taskClass,
      certificates: [certified({ modelId: 'old-model' })],
      running: RUNNING,
    });
    expect(recency.state).toBe('stale');
    if (recency.state !== 'stale') throw new Error('unreachable');
    expect(recency.reasons).toEqual([
      're-certify: model changed (certified under old-model, running auto)',
    ]);
  });

  it('[a certificate recorded with no model id is stale, not silently widened to cover one]', () => {
    const recency = certificateRecency({
      taskClass: certified().taskClass,
      certificates: [certified({ modelId: null })],
      running: RUNNING,
    });
    expect(recency.state).toBe('stale');
  });

  it('[a class with no certificate at all is never-certified — never current]', () => {
    const recency = certificateRecency({
      taskClass: 'refactor-extract-helper',
      certificates: [],
      running: RUNNING,
    });
    expect(recency.state).toBe('never-certified');
    expect(recency.certificate).toBeNull();
  });

  it('[insufficient and not-certified records are never current, whatever the policy]', () => {
    for (const outcome of ['insufficient', 'not-certified'] as const) {
      const recency = certificateRecency({
        taskClass: certified().taskClass,
        certificates: [certified({ outcome })],
        running: RUNNING,
      });
      expect(recency.state).toBe('never-certified');
      // The counts are still reported: the audit shows the class's evidence, it just refuses to
      // call it a certification.
      expect(recency.certificate?.outcome).toBe(outcome);
    }
  });

  /**
   * The corpus dimension. A certificate names the holdout corpus it was measured against, because
   * the corpus is a world-state input like the policy: adding a rule to a class's holdout makes
   * every earlier pass describe a weaker test. The defect this closes: bumping a corpus id left the
   * old certificate reading `current`, so a class certified against a two-rule corpus kept its
   * certificate after the corpus gained a third rule.
   */
  it('[a re-measured class under a newer corpus makes the older certificate stale, and names both]', () => {
    const recency = certificateRecency({
      taskClass: certified().taskClass,
      certificates: [
        // A newer measurement of the same class, under a corpus that gained a rule, that did not
        // reach the operating point: the `certified` row below is still the one being judged.
        certified({
          outcome: 'insufficient',
          holdoutRevision: 'h-refactor-2026-11-04',
          recordedAt: '2026-11-04T09:00:00.000Z',
        }),
        certified({ recordedAt: '2026-11-01T12:00:00.000Z' }),
      ],
      running: RUNNING,
    });
    expect(recency.state).toBe('stale');
    if (recency.state !== 'stale') throw new Error('unreachable');
    expect(recency.reasons).toEqual([
      're-certify: corpus changed (certified under h-refactor-2026-11-01, latest measurement under h-refactor-2026-11-04)',
    ]);
    expect(recency.referenceHoldoutRevision).toBe('h-refactor-2026-11-04');
  });

  it('[a certificate that names no corpus is stale, and the reason says it predates attribution]', () => {
    // Schema v5 added the column; every row written before it has `NULL` there. `NULL` is "cannot
    // prove which evidence this describes", never "matches any corpus" — a wildcard here would put
    // every historical certificate back to `current` forever, which is the bug the column exists to
    // stop.
    const recency = certificateRecency({
      taskClass: certified().taskClass,
      certificates: [certified({ holdoutRevision: null })],
      running: RUNNING,
    });
    expect(recency.state).toBe('stale');
    if (recency.state !== 'stale') throw new Error('unreachable');
    expect(recency.reasons).toEqual([
      're-certify: corpus unknown (this certificate predates corpus attribution; no measurement of this class names one)',
    ]);
    expect(recency.referenceHoldoutRevision).toBeNull();
  });

  it('[an unattributed certificate stays stale once a newer measurement names a corpus]', () => {
    // The shape the live store reaches on the first attempt after v5 lands: the pre-v5 certificate
    // names nothing, and the new measurement names the corpus it used. Reading `NULL` as a wildcard
    // would silently promote the old certificate to `current` by borrowing the new corpus — the
    // exact silent attribution this column exists to stop, and the one a "null matches anything"
    // implementation would ship.
    const recency = certificateRecency({
      taskClass: certified().taskClass,
      certificates: [
        certified({
          outcome: 'insufficient',
          holdoutRevision: 'h-refactor-2026-11-04',
          recordedAt: '2026-11-04T09:00:00.000Z',
        }),
        certified({ holdoutRevision: null, recordedAt: '2026-11-01T12:00:00.000Z' }),
      ],
      running: RUNNING,
    });
    expect(recency.state).toBe('stale');
    if (recency.state !== 'stale') throw new Error('unreachable');
    expect(recency.reasons).toEqual([
      're-certify: corpus unknown (this certificate predates corpus attribution; latest measurement under h-refactor-2026-11-04)',
    ]);
    expect(recency.referenceHoldoutRevision).toBe('h-refactor-2026-11-04');
  });

  it('[a certificate row written before the column existed parses, and reads stale]', () => {
    // The literal shape an operator's store holds today: `ClassCertificateRow` before v5 had no
    // `holdoutRevision` key at all. Absence must be readable — not a crash, and not `current`.
    const legacyRow: StoredCertificate = {
      taskClass: 'docs-typo-fix',
      outcome: 'certified',
      policyVersion: RUNNING.policyVersion,
      modelId: RUNNING.modelId,
      recordedAt: '2026-11-02T12:00:00.000Z',
    };
    expect('holdoutRevision' in legacyRow).toBe(false);
    const recency = certificateRecency({
      taskClass: legacyRow.taskClass,
      certificates: [legacyRow],
      running: RUNNING,
    });
    expect(recency.state).toBe('stale');
    if (recency.state !== 'stale') throw new Error('unreachable');
    expect(recency.reasons).toEqual([
      're-certify: corpus unknown (this certificate predates corpus attribution; no measurement of this class names one)',
    ]);
  });

  it('[an unattributed newer row does not hide the last corpus that was actually named]', () => {
    // The newest row predates attribution (or is an attempt that measured nothing), so the reference
    // corpus comes from the newest row that names one — the search is bounded, not a fallback to
    // "no corpus", because concluding "this class never named a corpus" would be false.
    const recency = certificateRecency({
      taskClass: certified().taskClass,
      certificates: [
        certified({
          outcome: 'insufficient',
          holdoutRevision: null,
          recordedAt: '2026-11-05T00:00:00.000Z',
        }),
        certified({
          outcome: 'insufficient',
          holdoutRevision: 'h-refactor-2026-11-04',
          recordedAt: '2026-11-04T00:00:00.000Z',
        }),
        certified({ recordedAt: '2026-11-01T00:00:00.000Z' }),
      ],
      running: RUNNING,
    });
    expect(recency.state).toBe('stale');
    if (recency.state !== 'stale') throw new Error('unreachable');
    expect(recency.reasons).toEqual([
      're-certify: corpus changed (certified under h-refactor-2026-11-01, latest measurement under h-refactor-2026-11-04)',
    ]);
    expect(recency.referenceHoldoutRevision).toBe('h-refactor-2026-11-04');
  });

  it('[a certificate re-earned under the newest corpus is current, not stale]', () => {
    // The other side of the rule: a class re-certified after a corpus change must go back to
    // `current`, or the dimension would be an expiry nothing can satisfy.
    const recency = certificateRecency({
      taskClass: certified().taskClass,
      certificates: [
        certified({
          holdoutRevision: 'h-refactor-2026-11-04',
          recordedAt: '2026-11-04T00:00:00.000Z',
        }),
        certified({ recordedAt: '2026-11-01T00:00:00.000Z' }),
      ],
      running: RUNNING,
    });
    expect(recency.state).toBe('current');
  });

  it('[the newest certified record decides, not the newest record of any kind]', () => {
    // A later `insufficient` observation (the class was re-measured and the attempts were
    // unmeasured) does not erase the earlier certification, and does not renew it either.
    const recency = certificateRecency({
      taskClass: certified().taskClass,
      certificates: [
        certified({ outcome: 'insufficient', recordedAt: '2026-11-02T00:00:00.000Z' }),
        certified({ recordedAt: '2026-11-01T00:00:00.000Z' }),
      ],
      running: RUNNING,
    });
    expect(recency.state).toBe('current');
  });

  it('[an offline factory compares policy only, because there is no model to compare]', () => {
    const recency = certificateRecency({
      taskClass: certified().taskClass,
      certificates: [certified({ modelId: 'some-older-model' })],
      running: { policyVersion: RUNNING.policyVersion, modelId: null },
    });
    expect(recency.state).toBe('current');
  });

  it('[every class is judged, in a stable order, from the store map]', () => {
    const byClass = new Map<string, readonly StoredCertificate[]>([
      ['z-class', [certified({ taskClass: 'z-class' })]],
      ['a-class', [certified({ taskClass: 'a-class', policyVersion: 'policy/old' })]],
    ]);
    const recency = certificatesRecency({ byClass, running: RUNNING });
    expect(recency.map((entry) => [entry.taskClass, entry.state])).toEqual([
      ['a-class', 'stale'],
      ['z-class', 'current'],
    ]);
  });
});
