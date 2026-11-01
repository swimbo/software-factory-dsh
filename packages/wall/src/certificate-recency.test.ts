import { describe, expect, it } from 'vitest';

import {
  certificateRecency,
  certificatesRecency,
  type StoredCertificate,
} from './certificate-recency.ts';

const RUNNING = { policyVersion: 'policy/2026-11-01', modelId: 'auto' } as const;

function certified(over: Partial<StoredCertificate> = {}): StoredCertificate {
  return {
    taskClass: 'refactor-extract-helper',
    outcome: 'certified',
    policyVersion: RUNNING.policyVersion,
    modelId: RUNNING.modelId,
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
