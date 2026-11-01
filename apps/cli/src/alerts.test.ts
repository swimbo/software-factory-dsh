/**
 * `factory alerts` — the monitor for the two controls that exit 9 on expired evidence.
 *
 * The properties worth a spec are the ones a reader of a log would get wrong by trusting a green run:
 *
 * - a clean factory prints `no alerts` and exits **0** — genuinely clean, because each source says
 *   `missing` explicitly instead of being silent;
 * - an **unreachable** anchor is exit **8**, never 0 and never `missing`: a transport failure is an
 *   environment fault, and reporting it as "fine" is the worst possible monitor;
 * - a `rollback` outranks `stale`, because a ledger that was replaced is not merely old;
 * - an empty certificate history is `CERT_NEVER` at exit 9 — the same rule `audit --certifications`
 *   refuses to break;
 * - `--json` prints exactly one object, and a usage error exits 2.
 *
 * The decision is a pure function (`decideAlerts`) tested against facts, not against the store; the
 * CLI-level specs then prove the same answers come out of the real binary.
 */
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { currentPolicyVersion } from '@factory/qualifier';
import { openStore } from '@factory/store';
import type { CertificateRecency } from '@factory/wall';

import { EXIT } from './exit.ts';
import { decideAlerts, type AlertFacts, type AnchorProbe } from './verbs/alerts.ts';
import { baseSpec, jsonOf, runCli, seedUnit, tempHome } from './testing.ts';

const FRESH: AnchorProbe = {
  state: 'fresh',
  scope: 'off-host',
  ageHours: 1.5,
  transport: 'ssh hermes-control:/var/lib/factory/ledger-anchors.jsonl',
  reason: 'anchored 1.5 h ago, off-host',
  record: { anchoredAt: '2026-11-01T02:00:00.000Z' },
};

const CURRENT: CertificateRecency = {
  taskClass: 'refactor-extract-helper',
  state: 'current',
  certificate: {
    taskClass: 'refactor-extract-helper',
    outcome: 'certified',
    policyVersion: currentPolicyVersion(),
    modelId: null,
    recordedAt: '2026-11-01T02:00:00.000Z',
  },
};

function facts(over: Partial<AlertFacts> = {}): AlertFacts {
  return {
    anchor: FRESH,
    certificates: [CURRENT],
    quarantined: null,
    budgetCeiling: { crossed: false, at: null },
    ...over,
  };
}

describe('decideAlerts', () => {
  it('[fresh anchor and a current certificate: no alerts, exit 0]', () => {
    const decision = decideAlerts(facts());
    expect(decision.alerts).toEqual([]);
    expect(decision.exitCode).toBe(EXIT.ok);
  });

  it('[a stale anchor is ANCHOR_STALE at exit 9]', () => {
    const decision = decideAlerts(
      facts({
        anchor: {
          ...FRESH,
          state: 'stale',
          ageHours: 49,
          reason: 'the last anchor is 49.0 h old (limit 48 h)',
        },
      }),
    );
    expect(decision.alerts.map((alert) => alert.code)).toEqual(['ANCHOR_STALE']);
    expect(decision.alerts[0]?.investigation).toBe(
      'factory ledger verify; docs/runbooks/ledger-anchor.md',
    );
    expect(decision.exitCode).toBe(EXIT.integrity);
  });

  it('[an unreachable anchor is exit 8, never 0, and never reported as missing]', () => {
    const decision = decideAlerts(
      facts({
        anchor: {
          state: 'unreachable',
          scope: 'unknown',
          ageHours: null,
          transport: 'ssh hermes-control:/var/lib/factory/ledger-anchors.jsonl',
          reason: 'the anchor host could not be reached (connection refused)',
          record: null,
        },
      }),
    );
    expect(decision.exitCode).toBe(EXIT.environment);
    expect(decision.exitCode).not.toBe(EXIT.ok);
    // A transport failure says nothing about the ledger, so it must not claim the anchor is missing.
    expect(decision.alerts.map((alert) => alert.code)).not.toContain('ANCHOR_MISSING');
  });

  it('[an unconfigured anchor is exit 8 and still reports ANCHOR_MISSING]', () => {
    const decision = decideAlerts(
      facts({
        anchor: {
          state: 'unconfigured',
          scope: 'unknown',
          ageHours: null,
          transport: 'none configured',
          reason: 'no anchor target is configured',
          record: null,
        },
      }),
    );
    expect(decision.exitCode).toBe(EXIT.environment);
    expect(decision.alerts.map((alert) => alert.code)).toEqual(['ANCHOR_MISSING']);
  });

  it('[a rollback outranks a stale anchor: a replaced ledger is not merely old]', () => {
    const decision = decideAlerts(
      facts({
        anchor: {
          ...FRESH,
          state: 'rollback',
          ageHours: 60,
          reason: 'the anchor has 120 events and this ledger has 40',
        },
      }),
    );
    expect(decision.alerts.map((alert) => alert.code)).toEqual(['ANCHOR_ROLLBACK']);
    expect(decision.alerts[0]?.severity).toBe('integrity');
    expect(decision.alerts[0]?.investigation).toContain('factory ledger verify');
    expect(decision.exitCode).toBe(EXIT.integrity);
  });

  it('[a quarantined store is an integrity alert at exit 9]', () => {
    const decision = decideAlerts(
      facts({ quarantined: 'the store is quarantined; writes are refused' }),
    );
    expect(decision.alerts.map((alert) => alert.code)).toContain('STORE_QUARANTINED');
    expect(decision.exitCode).toBe(EXIT.integrity);
  });

  it('[an empty certificate history is CERT_NEVER at exit 9: nothing to audit is not a licence]', () => {
    const decision = decideAlerts(facts({ certificates: [] }));
    expect(decision.alerts.map((alert) => alert.code)).toEqual(['CERT_NEVER']);
    expect(decision.alerts[0]?.subject).toBe('all task classes');
    expect(decision.exitCode).toBe(EXIT.integrity);
  });

  it('[no certificate projection at all is also CERT_NEVER, never silence]', () => {
    const decision = decideAlerts(facts({ certificates: null }));
    expect(decision.alerts.map((alert) => alert.code)).toEqual(['CERT_NEVER']);
    expect(decision.exitCode).toBe(EXIT.integrity);
  });

  it('[stale and never-certified classes are per-class alerts, each with its investigation]', () => {
    const decision = decideAlerts(
      facts({
        certificates: [
          CURRENT,
          {
            taskClass: 'old-class',
            state: 'stale',
            certificate: { ...CURRENT.certificate, taskClass: 'old-class' },
            reasons: [
              're-certify: policy changed (certified under policy/old, running policy/new)',
            ],
          },
          { taskClass: 'tiny-class', state: 'never-certified', certificate: null },
        ],
      }),
    );
    expect(decision.alerts.map((alert) => [alert.code, alert.subject])).toEqual([
      ['CERT_STALE', 'old-class'],
      ['CERT_NEVER', 'tiny-class'],
    ]);
    for (const alert of decision.alerts) {
      // A path or command that does not exist is worse than no pointer: both were checked against
      // the tree (`docs/runbooks/ledger-anchor.md`, `certificate-expired.md`).
      expect(alert.investigation).toContain('factory audit --certifications');
    }
    expect(decision.exitCode).toBe(EXIT.integrity);
  });

  it('[a budget ceiling crossing is a warning: printed, logged, and not a page]', () => {
    const decision = decideAlerts(
      facts({ budgetCeiling: { crossed: true, at: '2026-11-01T03:00:00.000Z' } }),
    );
    expect(decision.alerts.map((alert) => [alert.code, alert.severity])).toEqual([
      ['BUDGET_CEILING_REACHED', 'warning'],
    ]);
    // Warning severity does not page: the exit code stays 0, and the line is still emitted.
    expect(decision.exitCode).toBe(EXIT.ok);
  });

  it('[a warning does not mask an integrity alert]', () => {
    const decision = decideAlerts(
      facts({
        certificates: [],
        budgetCeiling: { crossed: true, at: '2026-11-01T03:00:00.000Z' },
      }),
    );
    expect(decision.exitCode).toBe(EXIT.integrity);
  });
});

/** One fresh anchor file, and one certified class, in a throwaway home. */
function seededHome(): { home: string; anchorDir: string } {
  const home = tempHome('factory-alerts-');
  const anchorDir = mkdtempSync(join(tmpdir(), 'factory-alerts-anchor-'));
  const store = openStore({ dir: join(home, 'state') });
  const { unitId } = seedUnit(home, {});
  store.acquireLease({
    leaseId: 'L-A1',
    unitId,
    owner: 'control-1',
    acquiredAt: '2026-11-01T00:00:00.000Z',
    expiresAt: '2026-11-02T00:00:00.000Z',
  });
  store.insertAttempt({
    attemptId: 'A-1',
    unitId,
    leaseId: 'L-A1',
    state: 'planned',
    launchKey: `launch:${unitId}:A-1`,
    sessionId: null,
    attemptDir: `/tmp/attempts/A-1`,
    startedAt: '2026-11-01T00:00:00.000Z',
    endedAt: null,
    exitCode: null,
  });
  store.insertVerdict(
    {
      verdictId: 'V-1',
      unitId,
      attemptId: 'A-1',
      receiptId: null,
      receiptSha: null,
      holdoutRevision: null,
      policyVersion: currentPolicyVersion(),
      wallVersion: 'wall/0.1.0',
      outcome: 'unknown',
      evaluatedAt: '2026-11-01T00:00:00.000Z',
      verdict: {
        unitId,
        attemptId: 'A-1',
        receiptSha: `sha256:${'a'.repeat(64)}`,
        holdoutRevision: 'holdout/1',
        policyVersion: currentPolicyVersion(),
        wallVersion: 'wall/0.1.0',
        outcome: 'unknown',
        scenarios: [],
        delta: {
          checked: false,
          baseRate: 0,
          candidateRate: 0,
          threshold: 0,
          observed: null,
          holdoutRevision: 'holdout/1',
        },
        reasons: ['holdout_unavailable'],
        certification: {
          taskClass: 'refactor-extract-helper',
          m: 20,
          k: 18,
          p0: 0.95,
          alpha: 0.07548367378849634,
          samples: 20,
          passes: 18,
          outcome: 'certified',
        },
        evaluatedAt: '2026-11-01T00:00:00.000Z',
      },
    },
    { actor: 'wall', traceId: 'T-seed', occurredAt: '2026-11-01T00:00:00.000Z' },
  );
  const events = store.eventCount();
  store.close();
  writeFileSync(
    join(anchorDir, 'ledger-anchors.jsonl'),
    `${JSON.stringify({
      schemaVersion: 1,
      seq: events,
      eventCount: events,
      headHash: `sha256:${'b'.repeat(64)}`,
      anchoredAt: new Date(Date.now() - 60 * 60 * 1000).toISOString(),
    })}\n`,
    'utf8',
  );
  void baseSpec();
  return { home, anchorDir };
}

describe('factory alerts', () => {
  it('prints exactly one JSON object and exits 0 when nothing expired', () => {
    const { home, anchorDir } = seededHome();
    const result = runCli(['alerts', '--json'], { home, env: { FACTORY_ANCHOR_DIR: anchorDir } });
    expect(result.status).toBe(EXIT.ok);
    const payload = jsonOf(result);
    expect(payload['schema']).toBe('alerts.v1');
    expect(payload['ok']).toBe(true);
    expect(payload['alerts']).toEqual([]);
    expect(result.stderr).toContain('no alerts');
  });

  it('exits 8 and says so when no anchor target is configured', () => {
    const { home } = seededHome();
    const result = runCli(['alerts', '--json'], { home, env: {} });
    expect(result.status).toBe(EXIT.environment);
    const payload = jsonOf(result);
    expect(payload['ok']).toBe(false);
    expect((payload['anchor'] as { state: string }).state).toBe('unconfigured');
  });

  it('exits 9 when the store has no certificates, and never calls that clean', () => {
    const home = tempHome('factory-alerts-empty-');
    const anchorDir = mkdtempSync(join(tmpdir(), 'factory-alerts-anchor-'));
    writeFileSync(
      join(anchorDir, 'ledger-anchors.jsonl'),
      `${JSON.stringify({
        schemaVersion: 1,
        seq: 0,
        eventCount: 0,
        headHash: `sha256:${'c'.repeat(64)}`,
        anchoredAt: new Date().toISOString(),
      })}\n`,
      'utf8',
    );
    const result = runCli(['alerts', '--json'], { home, env: { FACTORY_ANCHOR_DIR: anchorDir } });
    expect(result.status).toBe(EXIT.integrity);
    const payload = jsonOf(result);
    expect(payload['ok']).toBe(false);
    const alerts = payload['alerts'] as Array<{ code: string }>;
    expect(alerts.map((alert) => alert.code)).toEqual(['CERT_NEVER']);
    expect(result.stderr).not.toContain('no alerts');
  });

  /**
   * The parity the shared transport buys: `alerts` and `ledger verify` must classify the same
   * configuration the same way. Before `anchorTargetFrom` existed, `alerts` carried its own probe and
   * the two surfaces could disagree about an unreachable host while each looked correct alone.
   */
  it('classifies an unreachable host as exit 8, exactly as `ledger verify` does', () => {
    const { home } = seededHome();
    const env = { FACTORY_ANCHOR_SSH: '127.0.0.1', FACTORY_ANCHOR_PATH: '/tmp/anchors.jsonl' };
    const alerts = runCli(['alerts', '--json'], { home, env });
    const ledger = runCli(['ledger', 'verify', '--json'], { home, env });
    expect(alerts.status).toBe(EXIT.environment);
    expect(ledger.status).toBe(EXIT.environment);
    expect(alerts.status).toBe(ledger.status);
    const payload = jsonOf(alerts);
    expect((payload['anchor'] as { state: string }).state).toBe('unreachable');
    expect(payload['ok']).toBe(false);
    expect(alerts.stderr).toContain('could not be read');
  });

  it('refuses a positional argument with exit 2', () => {
    const { home, anchorDir } = seededHome();
    const result = runCli(['alerts', 'U-7f3a9c'], { home, env: { FACTORY_ANCHOR_DIR: anchorDir } });
    expect(result.status).toBe(EXIT.usage);
    // Commander refuses the extra positional before the verb runs; the verb refuses it again in case
    // a future caller reaches `runAlerts` directly. Either way it is a usage error, never a silent
    // audit of the wrong thing.
    expect(result.stderr.toLowerCase()).toContain('argument');
  });

  it('writes nothing: the ledger event count is identical before and after', () => {
    const { home, anchorDir } = seededHome();
    const store = openStore({ dir: join(home, 'state') });
    const before = store.eventCount();
    store.close();
    runCli(['alerts'], { home, env: { FACTORY_ANCHOR_DIR: anchorDir } });
    const reopened = openStore({ dir: join(home, 'state') });
    expect(reopened.eventCount()).toBe(before);
    expect(reopened.classCertificates?.() ?? []).toHaveLength(1);
    reopened.close();
  });
});
