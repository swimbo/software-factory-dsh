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
 *
 * The `--notify` half has its own three layers, and each exists because the other two cannot prove
 * the property alone:
 *
 * - `planNotification` is pure: what to notify about (one entry per code, deduplicated, the anchor
 *   summarised), including "nothing to say" and the difference between an unreachable anchor (exit 8)
 *   and expired evidence (exit 9). No clock, no process, no socket.
 * - the transports are exercised against a **loopback** HTTP listener and a **fake `osascript` on
 *   PATH**. No spec sends a real notification or reaches a non-loopback address: the notification
 *   itself and the network are the two things a test must never touch.
 * - the CLI-level specs run the real binary: the 0/8/9 contract is identical with and without the
 *   flag, a failed delivery never changes the code, and `--json` still prints exactly one object.
 */
import { spawn } from 'node:child_process';
import { chmodSync, existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import type { Server, ServerResponse } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import { AlertsV1, type Alert } from '@factory/contracts';
import { currentPolicyVersion } from '@factory/qualifier';
import { openSqlite, openStore } from '@factory/store';
import type { CertificateRecency } from '@factory/wall';

import { EXIT } from './exit.ts';
import {
  deliverNotification,
  osascriptInvocation,
  planNotification,
  postAlerts,
  WEBHOOK_ENV,
} from './notify.ts';
import { decideAlerts, type AlertFacts, type AnchorProbe } from './verbs/alerts.ts';
import {
  baseSpec,
  jsonOf,
  MAIN,
  NO_DSH_PATH,
  runCli,
  seedUnit,
  tempHome,
  type CliResult,
} from './testing.ts';

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
            referenceHoldoutRevision: 'holdout/2026-11-01',
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
    // A stale certificate is cleared by measuring the class again, so the `next:` line names the
    // class and the driver that does it — "the evidence expired" is a fact, not an instruction.
    const stale = decision.alerts.find((alert) => alert.code === 'CERT_STALE');
    expect(stale?.investigation).toContain('re-certify old-class');
    expect(stale?.investigation).toContain('scripts/certify-class.sh');
    expect(decision.exitCode).toBe(EXIT.integrity);
  });

  it('[a corpus change is a CERT_STALE whose reason names both corpora]', () => {
    // `decideAlerts` does not re-judge: the wall's reasons are the alert's reason, verbatim. What
    // this pins is that the corpus dimension reaches the operator instead of being flattened into
    // "stale".
    const decision = decideAlerts(
      facts({
        certificates: [
          {
            taskClass: 'test-repair',
            state: 'stale',
            certificate: { ...CURRENT.certificate, taskClass: 'test-repair' },
            reasons: [
              're-certify: corpus changed (certified under h-test-repair-real-2026-11-03, latest measurement under h-test-repair-real-2026-11-04)',
            ],
            referenceHoldoutRevision: 'h-test-repair-real-2026-11-04',
          },
        ],
      }),
    );
    const [alert] = decision.alerts;
    expect(alert?.code).toBe('CERT_STALE');
    expect(alert?.reason).toContain('h-test-repair-real-2026-11-03');
    expect(alert?.reason).toContain('h-test-repair-real-2026-11-04');
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

  it('reads a certificate that names no corpus as expired evidence, and says to re-certify the class', () => {
    // The row shape every pre-v5 store has: the projection is there, it is readable, and it cannot
    // prove which corpus it measured. That is stale — not a wildcard that matches the running corpus.
    const { home, anchorDir } = seededHome();
    const raw = openSqlite({ path: join(home, 'state', 'factory.db') });
    raw.prepare('UPDATE class_certificates SET holdout_revision = NULL').run();
    raw.close();

    const result = runCli(['alerts', '--json'], { home, env: { FACTORY_ANCHOR_DIR: anchorDir } });
    expect(result.status).toBe(EXIT.integrity);
    const alerts = jsonOf(result)['alerts'] as Array<{
      code: string;
      subject: string;
      reason: string;
      investigation: string;
    }>;
    const stale = alerts.find((alert) => alert.code === 'CERT_STALE');
    expect(stale?.subject).toBe('refactor-extract-helper');
    expect(stale?.reason).toContain('predates corpus attribution');
    expect(stale?.investigation).toContain('re-certify refactor-extract-helper');
    expect(stale?.investigation).toContain('scripts/certify-class.sh');
    expect(result.stderr).toContain('CERT_STALE');
    expect(result.stderr).toContain('next: re-certify refactor-extract-helper');
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

  it('exits 8 on a local anchor file it cannot read, and agrees with `ledger verify`', () => {
    const { home } = seededHome();
    const anchorDir = mkdtempSync(join(tmpdir(), 'factory-alerts-eacces-'));
    const path = join(anchorDir, 'ledger-anchors.jsonl');
    writeFileSync(path, '{"schemaVersion":1,"seq":1}\n');
    chmodSync(path, 0o000);
    const alerts = runCli(['alerts', '--json'], { home, env: { FACTORY_ANCHOR_DIR: anchorDir } });
    const ledger = runCli(['ledger', 'verify', '--json'], {
      home,
      env: { FACTORY_ANCHOR_DIR: anchorDir },
    });
    chmodSync(path, 0o644);
    expect(alerts.status).toBe(EXIT.environment);
    expect(ledger.status).toBe(EXIT.environment);
    expect(alerts.status).toBe(ledger.status);
    const payload = jsonOf(alerts);
    expect((payload['anchor'] as { state: string }).state).toBe('unreachable');
    expect(payload['ok']).toBe(false);
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

// ---------------------------------------------------------------------------
// --notify: the pure decision (what, if anything, to say)
// ---------------------------------------------------------------------------

const FRESH_FOR_DOC = {
  state: 'fresh',
  scope: 'off-host',
  ageHours: 1.5,
  transport: 'ssh hermes-control:/var/lib/factory/ledger-anchors.jsonl',
  reason: 'anchored 1.5 h ago, off-host',
} as const;

function certNever(subject = 'all task classes'): Alert {
  return {
    code: 'CERT_NEVER',
    severity: 'integrity',
    subject,
    at: null,
    reason: 'no class has ever been certified in this store; nothing to audit is not a licence',
    investigation: 'factory audit --certifications; docs/runbooks/certificate-expired.md',
  };
}

function certStale(subject: string): Alert {
  return {
    code: 'CERT_STALE',
    severity: 'integrity',
    subject,
    at: '2026-10-01T00:00:00.000Z',
    reason: 're-certify: policy changed (certified under policy/old, running policy/new)',
    investigation: 'factory audit --certifications; docs/runbooks/certificate-expired.md',
  };
}

function anchorStale(): Alert {
  return {
    code: 'ANCHOR_STALE',
    severity: 'integrity',
    subject: 'ssh hermes-control:/var/lib/factory/ledger-anchors.jsonl',
    at: '2026-10-30T02:00:00.000Z',
    reason: 'the last anchor is 49.0 h old (limit 48 h)',
    investigation: 'factory ledger verify; docs/runbooks/ledger-anchor.md',
  };
}

const ANCHOR_MISSING_ALERT: Alert = {
  code: 'ANCHOR_MISSING',
  severity: 'integrity',
  subject: 'none configured',
  at: null,
  reason: 'no anchor target is configured',
  investigation: 'factory ledger anchor; docs/runbooks/ledger-anchor.md',
};

const BUDGET_WARNING: Alert = {
  code: 'BUDGET_CEILING_REACHED',
  severity: 'warning',
  subject: 'spend',
  at: '2026-11-01T03:00:00.000Z',
  reason: 'the gateway reported a spend ceiling crossing',
  investigation: 'factory budget show',
};

/** A document that passes `alerts.v1`'s own refinement, so each spec starts from a real answer. */
function alertDocument(
  alerts: readonly Alert[],
  anchor: Partial<AlertsV1['anchor']> = {},
): AlertsV1 {
  const merged = { ...FRESH_FOR_DOC, ...anchor };
  const integrity = alerts.filter((alert) => alert.severity === 'integrity').length;
  const reached = merged.state !== 'unreachable' && merged.state !== 'unconfigured';
  return AlertsV1.parse({
    schema: 'alerts.v1',
    ok: integrity === 0 && reached,
    generatedAt: '2026-11-01T12:00:00.000Z',
    anchor: merged,
    alerts,
    counts: { total: alerts.length, bySeverity: { integrity, warning: alerts.length - integrity } },
  });
}

const UNREACHABLE_ANCHOR = {
  state: 'unreachable',
  scope: 'unknown',
  ageHours: null,
  reason: 'the anchor host could not be reached (connection refused)',
} as const;

describe('planNotification', () => {
  it('[exit 0 with no alerts: there is nothing to say]', () => {
    expect(planNotification(alertDocument([]), EXIT.ok)).toBeNull();
  });

  /**
   * `alerts.v1` says a warning is printed and logged and does **not** page. A channel that paged for a
   * spend ceiling would be muted within a week — and it would take the exit-9 pages with it.
   */
  it('[exit 0 with a warning only: still nothing to say — a warning does not page]', () => {
    const document = alertDocument([BUDGET_WARNING]);
    expect(document.ok).toBe(true);
    expect(planNotification(document, EXIT.ok)).toBeNull();
  });

  it('[one integrity alert: one entry, the anchor summarised, the exit code in the title]', () => {
    const plan = planNotification(alertDocument([certNever()]), EXIT.integrity);
    expect(plan?.title).toBe('factory alerts: integrity alert (exit 9)');
    expect(plan?.anchor).toBe('FRESH — anchored 1.5 h ago, off-host');
    expect(plan?.entries).toEqual([
      {
        code: 'CERT_NEVER',
        severity: 'integrity',
        count: 1,
        subjects: ['all task classes'],
        reason: 'no class has ever been certified in this store; nothing to audit is not a licence',
        investigation: 'factory audit --certifications; docs/runbooks/certificate-expired.md',
      },
    ]);
    // The whole body is pinned: a notification whose wording drifts is a notification nobody can
    // grep, and this is the text a person acts on from a lock screen.
    expect(plan?.body).toBe(
      [
        'evidence: EXPIRED OR UNTRUSTWORTHY (exit 9)',
        'anchor: FRESH — anchored 1.5 h ago, off-host',
        'INTEGRITY  CERT_NEVER  all task classes',
        'next: factory audit --certifications; docs/runbooks/certificate-expired.md',
      ].join('\n'),
    );
  });

  it('[the same code collapses to one entry: subjects deduplicated, the count kept]', () => {
    const plan = planNotification(
      alertDocument([certStale('old-class'), certStale('tiny-class'), certStale('old-class')]),
      EXIT.integrity,
    );
    expect(plan?.entries).toHaveLength(1);
    expect(plan?.entries[0]?.code).toBe('CERT_STALE');
    expect(plan?.entries[0]?.count).toBe(3);
    expect(plan?.entries[0]?.subjects).toEqual(['old-class', 'tiny-class']);
    expect(plan?.body).toContain('INTEGRITY  CERT_STALE ×3  old-class, tiny-class');
  });

  it('[one entry per code, in document order, with per-class alerts still named]', () => {
    const plan = planNotification(
      alertDocument([certStale('old-class'), anchorStale(), certStale('tiny-class')]),
      EXIT.integrity,
    );
    expect(plan?.entries.map((entry) => entry.code)).toEqual(['CERT_STALE', 'ANCHOR_STALE']);
    expect(plan?.entries[0]?.subjects).toEqual(['old-class', 'tiny-class']);
    expect(plan?.entries[1]?.subjects).toEqual([
      'ssh hermes-control:/var/lib/factory/ledger-anchors.jsonl',
    ]);
    expect(plan?.body.indexOf('CERT_STALE')).toBeLessThan(plan?.body.indexOf('ANCHOR_STALE') ?? -1);
  });

  it('[a long class list is summarised, not silently cut]', () => {
    const subjects = ['s1', 's2', 's3', 's4', 's5', 's6', 's7'];
    const plan = planNotification(
      alertDocument(subjects.map((subject) => certStale(subject))),
      EXIT.integrity,
    );
    // The pure entry keeps every subject; only the rendering is bounded.
    expect(plan?.entries[0]?.subjects).toHaveLength(7);
    expect(plan?.body).toContain('INTEGRITY  CERT_STALE ×7  s1, s2, s3, s4, s5 +2 more');
  });

  it('[exit 8 says nothing is known; exit 9 says the evidence expired — the two never merge]', () => {
    const unreachable = alertDocument([certNever()], UNREACHABLE_ANCHOR);
    const expired = alertDocument([certNever()], {
      state: 'stale',
      ageHours: 49,
      reason: 'the last anchor is 49.0 h old (limit 48 h)',
    });
    const environment = planNotification(unreachable, EXIT.environment);
    const integrity = planNotification(expired, EXIT.integrity);
    expect(environment).not.toBeNull();
    expect(integrity).not.toBeNull();
    expect(environment?.title).toBe('factory alerts: anchor host unreachable (exit 8)');
    expect(integrity?.title).toBe('factory alerts: integrity alert (exit 9)');
    expect(environment?.body).not.toBe(integrity?.body);
    expect(environment?.body).toContain(
      'evidence: UNKNOWN — the anchor host did not answer (exit 8)',
    );
    expect(environment?.body).not.toContain('EXPIRED');
    expect(environment?.body).toContain(
      'nothing is known about this ledger until the anchor answers',
    );
    // Unreachable is not an alert (by design), so the 8 case supplies its own next command.
    expect(environment?.body).toContain(
      'next: factory ledger verify; docs/runbooks/ledger-anchor.md',
    );
    expect(integrity?.body).toContain('evidence: EXPIRED OR UNTRUSTWORTHY (exit 9)');
    expect(integrity?.body).not.toContain('UNKNOWN');
  });

  it('[exit 8 with no anchor configured names the configuration fault, not a ledger fact]', () => {
    const document = alertDocument([ANCHOR_MISSING_ALERT], {
      state: 'unconfigured',
      scope: 'unknown',
      ageHours: null,
      reason: 'no anchor target is configured',
    });
    const plan = planNotification(document, EXIT.environment);
    expect(plan?.title).toBe('factory alerts: no anchor configured (exit 8)');
    expect(plan?.body).toContain('evidence: UNKNOWN — no anchor target is configured (exit 8)');
    expect(plan?.body).toContain('INTEGRITY  ANCHOR_MISSING  none configured');
    // The anchor alert already carries the fix; a second, generic "verify" line would be noise.
    expect(plan?.body).toContain('next: factory ledger anchor; docs/runbooks/ledger-anchor.md');
    expect(plan?.body).not.toContain('next: factory ledger verify');
  });

  it('[a warning alongside an integrity alert does not ride the page]', () => {
    const plan = planNotification(alertDocument([certNever(), BUDGET_WARNING]), EXIT.integrity);
    expect(plan?.entries.map((entry) => entry.code)).toEqual(['CERT_NEVER']);
    expect(plan?.body).not.toContain('BUDGET');
    expect(plan?.body).not.toContain('WARNING');
  });
});

// ---------------------------------------------------------------------------
// --notify: the webhook transport, against a loopback listener
// ---------------------------------------------------------------------------

interface LoopbackRecorder {
  readonly url: string;
  readonly requests: {
    readonly method: string;
    readonly path: string;
    readonly body: string;
    readonly contentType: string;
  }[];
  close(): Promise<void>;
}

/**
 * A listener on 127.0.0.1 only. Every webhook spec talks to this, never to a real endpoint: the whole
 * point of a test is that it cannot page a person or reach a service.
 */
async function loopback(
  respond: (index: number, response: ServerResponse) => void = (_index, response) => {
    response.writeHead(202, { 'content-type': 'application/json' });
    response.end('{"ok":true}');
  },
): Promise<LoopbackRecorder> {
  const requests: LoopbackRecorder['requests'] = [];
  const server: Server = createServer((request, response) => {
    const chunks: Buffer[] = [];
    request.on('data', (chunk: Buffer) => chunks.push(chunk));
    request.on('end', () => {
      requests.push({
        method: request.method ?? '',
        path: request.url ?? '',
        body: Buffer.concat(chunks).toString('utf8'),
        contentType:
          typeof request.headers['content-type'] === 'string'
            ? request.headers['content-type']
            : '',
      });
      respond(requests.length - 1, response);
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
  const address = server.address();
  if (address === null || typeof address === 'string') throw new Error('no loopback port');
  return {
    url: `http://127.0.0.1:${String(address.port)}/hook`,
    requests,
    async close() {
      server.closeAllConnections();
      await new Promise<void>((resolve, reject) => {
        server.close((error) => (error === undefined ? resolve() : reject(error)));
      });
    },
  };
}

/**
 * Every direct `deliverNotification` spec gets a throwaway factory home. The transport reads the
 * operator's webhook secret from `$FACTORY_HOME/secrets/alerts-webhook`; a spec that let that resolve to
 * the real `~/.factory` could read — or page — a real channel.
 */
function notifyHome(): string {
  return tempHome('factory-notify-home-');
}

describe('the webhook POST (loopback only)', () => {
  it('[a successful delivery is exactly one POST of the alerts.v1 document]', async () => {
    const recorder = await loopback();
    try {
      const document = alertDocument([certNever()]);
      const result = await postAlerts(recorder.url, JSON.stringify(document), 2_000);
      expect(result).toEqual({ ok: true, attempts: 1, status: 202, detail: 'HTTP 202' });
      expect(recorder.requests).toHaveLength(1);
      const request = recorder.requests[0];
      expect(request?.method).toBe('POST');
      expect(request?.contentType).toContain('application/json');
      expect(JSON.parse(request?.body ?? '{}')).toEqual(document);
    } finally {
      await recorder.close();
    }
  });

  it('[a 5xx is retried exactly once]', async () => {
    const recorder = await loopback((_index, response) => {
      response.writeHead(503, { 'content-type': 'text/plain' });
      response.end('not now');
    });
    try {
      const result = await postAlerts(recorder.url, '{}', 2_000);
      expect(result.ok).toBe(false);
      expect(result.status).toBe(503);
      expect(result.attempts).toBe(2);
      expect(recorder.requests).toHaveLength(2);
    } finally {
      await recorder.close();
    }
  });

  it('[a 4xx is not retried: the same request refused twice is noise]', async () => {
    const recorder = await loopback((_index, response) => {
      response.writeHead(401, { 'content-type': 'text/plain' });
      response.end('bad token');
    });
    try {
      const result = await postAlerts(recorder.url, '{}', 2_000);
      expect(result.ok).toBe(false);
      expect(result.status).toBe(401);
      expect(result.attempts).toBe(1);
      expect(recorder.requests).toHaveLength(1);
    } finally {
      await recorder.close();
    }
  });

  it('[a 30x is refused, not followed: the alert set is not re-POSTed somewhere else]', async () => {
    const recorder = await loopback((_index, response) => {
      response.writeHead(307, { location: '/elsewhere' });
      response.end();
    });
    try {
      const result = await postAlerts(recorder.url, '{}', 2_000);
      expect(result.ok).toBe(false);
      expect(recorder.requests.map((request) => request.path)).toEqual(['/hook', '/hook']);
      expect(recorder.requests.every((request) => request.method === 'POST')).toBe(true);
    } finally {
      await recorder.close();
    }
  });

  it('[a refused connection is a failure value, not a throw]', async () => {
    const recorder = await loopback();
    const url = recorder.url;
    await recorder.close();
    const result = await postAlerts(url, '{}', 2_000);
    expect(result.ok).toBe(false);
    expect(result.status).toBeNull();
    // A transport failure gets the one retry, because the endpoint may simply be restarting.
    expect(result.attempts).toBe(2);
    expect(result.detail).toMatch(/fetch failed|ECONNREFUSED/u);
  });

  it('[an endpoint that never answers is bounded by the timeout, twice and no more]', async () => {
    const recorder = await loopback(() => {
      // Deliberately never responds: the client's own budget has to end the attempt.
    });
    try {
      const started = performance.now();
      const result = await postAlerts(recorder.url, '{}', 60);
      const elapsed = performance.now() - started;
      expect(result.ok).toBe(false);
      expect(result.attempts).toBe(2);
      expect(elapsed).toBeLessThan(5_000);
    } finally {
      await recorder.close();
    }
  });
});

describe('deliverNotification over the webhook', () => {
  it('[delivers once, reports the origin, and never prints the path or the query]', async () => {
    const recorder = await loopback();
    try {
      const document = alertDocument([certNever()]);
      const lines: string[] = [];
      const outcome = await deliverNotification(document, EXIT.integrity, {
        home: notifyHome(),
        env: { [WEBHOOK_ENV]: `${recorder.url}?token=super-secret&channel=factory` },
        platform: 'darwin',
        warn: (line) => lines.push(line),
      });
      expect(outcome.status).toBe('delivered');
      expect(recorder.requests).toHaveLength(1);
      expect(JSON.parse(recorder.requests[0]?.body ?? '{}')).toEqual(document);
      expect(lines).toHaveLength(1);
      expect(lines[0]).toContain('NOTIFY  DELIVERED');
      expect(lines[0]).toContain(new URL(recorder.url).origin);
      expect(lines[0]).not.toContain('super-secret');
      expect(lines[0]).not.toContain('token=');
      expect(lines[0]).not.toContain('/hook');
    } finally {
      await recorder.close();
    }
  });

  it('[a refused POST is reported as a failure, after the alert lines, and never hidden]', async () => {
    const recorder = await loopback((_index, response) => {
      response.writeHead(500, { 'content-type': 'text/plain' });
      response.end('boom');
    });
    try {
      const lines: string[] = [];
      const outcome = await deliverNotification(alertDocument([certNever()]), EXIT.integrity, {
        home: notifyHome(),
        env: { [WEBHOOK_ENV]: recorder.url },
        platform: 'darwin',
        warn: (line) => lines.push(line),
        timeoutMs: 2_000,
      });
      expect(outcome.status).toBe('failed');
      expect(outcome.delivered).toBe(false);
      expect(lines).toHaveLength(1);
      expect(lines[0]).toContain('NOTIFY  FAILED');
      expect(lines[0]).toContain('HTTP 500');
      expect(lines[0]).toContain('(the exit code describes the evidence, not the transport)');
      expect(lines[0]).not.toContain('/hook');
    } finally {
      await recorder.close();
    }
  });

  it('[a configured channel that is not a URL fails loudly, with no silent local fallback]', async () => {
    const shim = osascriptShim();
    const lines: string[] = [];
    const outcome = await deliverNotification(alertDocument([certNever()]), EXIT.integrity, {
      home: notifyHome(),
      env: { [WEBHOOK_ENV]: 'ftp://example.invalid/hook?token=super-secret', PATH: shim.path },
      platform: 'darwin',
      warn: (line) => lines.push(line),
    });
    expect(outcome.status).toBe('failed');
    expect(existsSync(shim.capture)).toBe(false);
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain('NOTIFY  FAILED');
    expect(lines[0]).toContain('must be an http(s) URL');
    expect(lines[0]).not.toContain('super-secret');
  });

  it('[a channel that throws is reported, never raised: the code describes the evidence]', async () => {
    const lines: string[] = [];
    const exploding: Readonly<Record<string, string | undefined>> = {
      get [WEBHOOK_ENV](): string | undefined {
        throw new Error('channel bug');
      },
    };
    const outcome = await deliverNotification(alertDocument([certNever()]), EXIT.integrity, {
      home: notifyHome(),
      env: exploding,
      platform: 'darwin',
      warn: (line) => lines.push(line),
    });
    expect(outcome.status).toBe('failed');
    expect(outcome.detail).toContain('the notification channel threw');
    expect(outcome.detail).toContain('channel bug');
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain('NOTIFY  FAILED');
  });

  it('[a clean run sends nothing and prints nothing, even with a webhook configured]', async () => {
    const recorder = await loopback();
    try {
      const lines: string[] = [];
      const outcome = await deliverNotification(alertDocument([]), EXIT.ok, {
        home: notifyHome(),
        env: { [WEBHOOK_ENV]: recorder.url },
        platform: 'darwin',
        warn: (line) => lines.push(line),
      });
      expect(outcome).toEqual({
        planned: false,
        delivered: false,
        status: 'skipped',
        transport: 'none',
        detail: 'nothing to report',
      });
      expect(lines).toEqual([]);
      expect(recorder.requests).toEqual([]);
    } finally {
      await recorder.close();
    }
  });
});

// ---------------------------------------------------------------------------
// --notify: the local transport, against a fake `osascript` on PATH
// ---------------------------------------------------------------------------

/**
 * A fake `osascript`: it records its argv and exits as told. It is on PATH so the *production* code
 * path runs unchanged — the only thing replaced is the binary, because a test that can display a real
 * notification is a test that pages a person at 3am.
 */
function osascriptShim(options: { readonly exitCode?: number; readonly stderr?: string } = {}): {
  dir: string;
  capture: string;
  path: string;
} {
  const dir = mkdtempSync(join(tmpdir(), 'factory-osascript-'));
  const capture = join(dir, 'capture.txt');
  const lines = ['#!/bin/sh', `printf '%s\\n' "$@" > '${capture}'`];
  if (options.stderr !== undefined) lines.push(`printf '%s\\n' '${options.stderr}' >&2`);
  lines.push(`exit ${String(options.exitCode ?? 0)}`, '');
  const bin = join(dir, 'osascript');
  writeFileSync(bin, lines.join('\n'));
  chmodSync(bin, 0o755);
  return { dir, capture, path: `${dir}:/usr/bin:/bin` };
}

describe('the local transport (a fake osascript on PATH)', () => {
  it('[the AppleScript source never contains the alert text: it arrives as argv]', () => {
    const plan = planNotification(alertDocument([certNever()]), EXIT.integrity);
    if (plan === null) throw new Error('the fixture must produce a plan');
    const invocation = osascriptInvocation(plan);
    expect(invocation.command).toBe('osascript');
    expect(invocation.args).toEqual([
      '-e',
      expect.stringContaining('display notification'),
      plan.title,
      plan.body,
    ]);
    // A class name is data from a spec. Interpolating it into AppleScript would make a quote in a
    // class name executable, so the source carries none of it.
    const source = invocation.args[1] ?? '';
    expect(source).toContain('on run argv');
    expect(source).not.toContain(plan.title);
    expect(source).not.toContain('CERT_NEVER');
  });

  it('[delivers through osascript, and prints exactly one NOTIFY line]', async () => {
    const shim = osascriptShim();
    const document = alertDocument([certNever()]);
    const lines: string[] = [];
    const outcome = await deliverNotification(document, EXIT.integrity, {
      home: notifyHome(),
      env: { PATH: shim.path, [WEBHOOK_ENV]: '' },
      platform: 'darwin',
      warn: (line) => lines.push(line),
    });
    expect(outcome).toEqual({
      planned: true,
      delivered: true,
      status: 'delivered',
      transport: 'local',
      detail: 'macOS notification displayed through osascript',
    });
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain('NOTIFY  DELIVERED');
    expect(lines[0]).not.toContain('\n');
    const captured = readFileSync(shim.capture, 'utf8');
    expect(captured).toContain('on run argv');
    expect(captured).toContain('display notification (item 2 of argv) with title (item 1 of argv)');
    expect(captured).toContain('factory alerts: integrity alert (exit 9)');
    expect(captured).toContain('INTEGRITY  CERT_NEVER  all task classes');
  });

  it('[a failing osascript is one reported line, and the fact is still planned]', async () => {
    const shim = osascriptShim({ exitCode: 1, stderr: 'osascript refused: not permitted' });
    const lines: string[] = [];
    const outcome = await deliverNotification(alertDocument([certNever()]), EXIT.integrity, {
      home: notifyHome(),
      env: { PATH: shim.path, [WEBHOOK_ENV]: '' },
      platform: 'darwin',
      warn: (line) => lines.push(line),
    });
    expect(outcome.status).toBe('failed');
    expect(outcome.delivered).toBe(false);
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain('NOTIFY  FAILED');
    expect(lines[0]).toContain('osascript exited 1');
    expect(lines[0]).toContain('osascript refused: not permitted');
    expect(lines[0]).not.toContain('\n');
    expect(lines[0]).toContain('(the exit code describes the evidence, not the transport)');
  });

  it('[a missing osascript is a delivery failure with the reason, not a crash]', async () => {
    const emptyDir = mkdtempSync(join(tmpdir(), 'factory-no-osascript-'));
    const lines: string[] = [];
    const outcome = await deliverNotification(alertDocument([certNever()]), EXIT.integrity, {
      home: notifyHome(),
      env: { PATH: emptyDir, [WEBHOOK_ENV]: '' },
      platform: 'darwin',
      warn: (line) => lines.push(line),
    });
    expect(outcome.status).toBe('failed');
    expect(outcome.detail).toContain('osascript could not be run');
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain('NOTIFY  FAILED');
  });

  it('[a wedged osascript is killed at the boundary instead of wedging the 04:00 job]', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'factory-slow-osascript-'));
    const bin = join(dir, 'osascript');
    writeFileSync(bin, '#!/bin/sh\nsleep 5\n');
    chmodSync(bin, 0o755);
    const started = performance.now();
    const outcome = await deliverNotification(alertDocument([certNever()]), EXIT.integrity, {
      home: notifyHome(),
      env: { PATH: `${dir}:/usr/bin:/bin`, [WEBHOOK_ENV]: '' },
      platform: 'darwin',
      warn: () => undefined,
      localTimeoutMs: 100,
    });
    const elapsed = performance.now() - started;
    expect(outcome.status).toBe('failed');
    expect(outcome.detail).toContain('osascript could not be run');
    expect(elapsed).toBeLessThan(4_000);
  });

  it('[on a non-macOS host it is a reported no-op, and osascript is never spawned]', async () => {
    const shim = osascriptShim();
    const lines: string[] = [];
    const outcome = await deliverNotification(alertDocument([certNever()]), EXIT.integrity, {
      home: notifyHome(),
      env: { PATH: shim.path, [WEBHOOK_ENV]: '' },
      platform: 'linux',
      warn: (line) => lines.push(line),
    });
    expect(outcome).toEqual({
      planned: true,
      delivered: false,
      status: 'skipped',
      transport: 'none',
      detail: expect.stringContaining('no local notification transport on linux'),
    });
    expect(existsSync(shim.capture)).toBe(false);
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain('NOTIFY  SKIPPED');
    expect(lines[0]).toContain(WEBHOOK_ENV);
  });
});

// ---------------------------------------------------------------------------
// --notify through the real binary: the exit-code contract does not move
// ---------------------------------------------------------------------------

/** One fresh anchor record and a store with no class certificates: the exit-9 state, deterministically. */
function homeWithoutCertificates(): { home: string; anchorDir: string } {
  const home = tempHome('factory-alerts-notify-');
  const anchorDir = mkdtempSync(join(tmpdir(), 'factory-alerts-notify-anchor-'));
  writeFileSync(
    join(anchorDir, 'ledger-anchors.jsonl'),
    `${JSON.stringify({
      schemaVersion: 1,
      seq: 0,
      eventCount: 0,
      headHash: `sha256:${'d'.repeat(64)}`,
      anchoredAt: new Date().toISOString(),
    })}\n`,
    'utf8',
  );
  return { home, anchorDir };
}

/**
 * `runCli` is a `spawnSync`, which blocks this process's event loop — so the loopback listener a
 * webhook spec starts could never answer the child, and the spec would fail for the harness's reason
 * rather than the code's. This twin awaits the child instead, with the same environment rules.
 */
async function runCliAsync(
  args: readonly string[],
  options: { readonly home: string; readonly env: Readonly<Record<string, string | undefined>> },
): Promise<CliResult> {
  return await new Promise<CliResult>((resolve, reject) => {
    const child = spawn(process.execPath, [MAIN, ...args], {
      env: {
        ...process.env,
        PATH: NO_DSH_PATH,
        FACTORY_HOME: options.home,
        TERM: 'dumb',
        NO_COLOR: '1',
        ...options.env,
      },
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk: Buffer) => {
      stdout += chunk.toString();
    });
    child.stderr.on('data', (chunk: Buffer) => {
      stderr += chunk.toString();
    });
    child.on('error', reject);
    child.on('close', (code) => resolve({ status: code ?? -1, stdout, stderr }));
  });
}

describe('factory alerts --notify', () => {
  it('[delivers locally and keeps the exit code the evidence earned]', () => {
    const { home, anchorDir } = homeWithoutCertificates();
    const shim = osascriptShim();
    const result = runCli(['alerts', '--notify', '--json'], {
      home,
      env: { FACTORY_ANCHOR_DIR: anchorDir, PATH: shim.path, [WEBHOOK_ENV]: '' },
    });
    expect(result.status).toBe(EXIT.integrity);
    const payload = jsonOf(result);
    expect((payload['alerts'] as Array<{ code: string }>).map((alert) => alert.code)).toEqual([
      'CERT_NEVER',
    ]);
    // The alert is still printed above the channel line: a delivery failure or success never replaces
    // the facts.
    expect(result.stderr).toContain('INTEGRITY  CERT_NEVER  all task classes');
    const notifyLines = result.stderr.split('\n').filter((line) => line.startsWith('NOTIFY'));
    expect(notifyLines).toHaveLength(1);
    expect(notifyLines[0]).toContain('NOTIFY  DELIVERED');
    const captured = readFileSync(shim.capture, 'utf8');
    expect(captured).toContain('factory alerts: integrity alert (exit 9)');
    expect(captured).toContain('CERT_NEVER');
  });

  /**
   * The deploy-side counterpart: the plist spec below asserts the daily job passes `--notify`, and this
   * spec asserts that *without* the flag the same run only writes the log. Together they are the
   * "delete the flag and the job is log-only again" property, proven from both ends.
   */
  it('[without --notify nothing is delivered and the exit code is identical]', () => {
    const { home, anchorDir } = homeWithoutCertificates();
    const shim = osascriptShim();
    const env = { FACTORY_ANCHOR_DIR: anchorDir, PATH: shim.path, [WEBHOOK_ENV]: '' };
    const without = runCli(['alerts', '--json'], { home, env });
    const withFlag = runCli(['alerts', '--notify', '--json'], { home, env });
    expect(without.status).toBe(EXIT.integrity);
    expect(withFlag.status).toBe(without.status);
    expect(without.stderr).not.toContain('NOTIFY');
    expect(without.stderr).toContain('INTEGRITY  CERT_NEVER  all task classes');
    expect(existsSync(shim.capture)).toBe(true);
  });

  it('[0 is still 0 with --notify, and a clean run says nothing at all]', () => {
    const { home, anchorDir } = seededHome();
    const shim = osascriptShim();
    const env = { FACTORY_ANCHOR_DIR: anchorDir, PATH: shim.path, [WEBHOOK_ENV]: '' };
    const without = runCli(['alerts', '--json'], { home, env });
    const withFlag = runCli(['alerts', '--notify', '--json'], { home, env });
    expect(without.status).toBe(EXIT.ok);
    expect(withFlag.status).toBe(EXIT.ok);
    expect(jsonOf(withFlag)['alerts']).toEqual([]);
    expect(withFlag.stderr).toContain('no alerts');
    expect(withFlag.stderr).not.toContain('NOTIFY');
    expect(existsSync(shim.capture)).toBe(false);
  });

  it('[8 is still 8 with --notify, and the notification names the configuration fault]', () => {
    const { home } = seededHome();
    const shim = osascriptShim();
    const env = { PATH: shim.path, [WEBHOOK_ENV]: '' };
    const without = runCli(['alerts', '--json'], { home, env });
    const withFlag = runCli(['alerts', '--notify', '--json'], { home, env });
    expect(without.status).toBe(EXIT.environment);
    expect(withFlag.status).toBe(EXIT.environment);
    expect(withFlag.stderr).toContain('NOTIFY  DELIVERED');
    const captured = readFileSync(shim.capture, 'utf8');
    expect(captured).toContain('factory alerts: no anchor configured (exit 8)');
    expect(captured).toContain('evidence: UNKNOWN — no anchor target is configured (exit 8)');
    // The one message that must never appear for an unreachable anchor: the ledger is not expired, it
    // is unknown, and a person sent to the wrong runbook is worse than no page.
    expect(captured).not.toContain('EXPIRED');
  });

  it('[a failing osascript leaves the exit code alone and prints one visible failure]', () => {
    const { home, anchorDir } = homeWithoutCertificates();
    const shim = osascriptShim({ exitCode: 1, stderr: 'osascript refused: not permitted' });
    const result = runCli(['alerts', '--notify', '--json'], {
      home,
      env: { FACTORY_ANCHOR_DIR: anchorDir, PATH: shim.path, [WEBHOOK_ENV]: '' },
    });
    expect(result.status).toBe(EXIT.integrity);
    expect(jsonOf(result)['alerts']).toEqual([expect.objectContaining({ code: 'CERT_NEVER' })]);
    const notifyLines = result.stderr.split('\n').filter((line) => line.startsWith('NOTIFY'));
    expect(notifyLines).toHaveLength(1);
    expect(notifyLines[0]).toContain('NOTIFY  FAILED');
    expect(notifyLines[0]).toContain('osascript exited 1');
    expect(notifyLines[0]).toContain('osascript refused: not permitted');
    expect(result.stderr).toContain('INTEGRITY  CERT_NEVER');
  });

  it('[a webhook run POSTs exactly the document --json printed, and logs only the origin]', async () => {
    const { home, anchorDir } = homeWithoutCertificates();
    const recorder = await loopback();
    try {
      const result = await runCliAsync(['alerts', '--notify', '--json'], {
        home,
        env: {
          FACTORY_ANCHOR_DIR: anchorDir,
          PATH: NO_DSH_PATH,
          [WEBHOOK_ENV]: `${recorder.url}?token=super-secret&channel=factory`,
        },
      });
      expect(result.status).toBe(EXIT.integrity);
      const printed = jsonOf(result);
      expect(recorder.requests).toHaveLength(1);
      expect(JSON.parse(recorder.requests[0]?.body ?? '{}')).toEqual(printed);
      const notifyLine = result.stderr.split('\n').find((line) => line.startsWith('NOTIFY')) ?? '';
      expect(notifyLine).toContain('NOTIFY  DELIVERED');
      expect(notifyLine).toContain(new URL(recorder.url).origin);
      expect(notifyLine).not.toContain('super-secret');
      expect(notifyLine).not.toContain('token=');
      expect(notifyLine).not.toContain('/hook');
    } finally {
      await recorder.close();
    }
  });

  it('[an unreachable webhook is reported, and 9 stays 9]', async () => {
    const { home, anchorDir } = homeWithoutCertificates();
    const recorder = await loopback();
    const url = recorder.url;
    await recorder.close();
    const result = await runCliAsync(['alerts', '--notify', '--json'], {
      home,
      env: { FACTORY_ANCHOR_DIR: anchorDir, PATH: NO_DSH_PATH, [WEBHOOK_ENV]: url },
    });
    expect(result.status).toBe(EXIT.integrity);
    const notifyLine = result.stderr.split('\n').find((line) => line.startsWith('NOTIFY')) ?? '';
    expect(notifyLine).toContain('NOTIFY  FAILED');
    expect(notifyLine).toContain('did not accept the alert');
    expect(notifyLine).not.toContain('/hook');
  });

  it('[a clean run with a webhook configured sends zero requests]', async () => {
    const { home, anchorDir } = seededHome();
    const recorder = await loopback();
    try {
      const result = await runCliAsync(['alerts', '--notify', '--json'], {
        home,
        env: { FACTORY_ANCHOR_DIR: anchorDir, PATH: NO_DSH_PATH, [WEBHOOK_ENV]: recorder.url },
      });
      expect(result.status).toBe(EXIT.ok);
      expect(recorder.requests).toEqual([]);
      expect(result.stderr).not.toContain('NOTIFY');
    } finally {
      await recorder.close();
    }
  });

  it('[--help documents the opt-in flag and the variable it reads]', () => {
    const result = runCli(['alerts', '--help']);
    expect(result.status).toBe(EXIT.ok);
    expect(result.stdout).toContain('--notify');
    expect(result.stdout).toContain('FACTORY_ALERTS_WEBHOOK_URL');
  });
});

// ---------------------------------------------------------------------------
// The deploy artifact is under test too: a plist nobody asserts is a comment
// ---------------------------------------------------------------------------

describe('the launchd job that delivers', () => {
  const PLIST = fileURLToPath(
    new URL('../../../deploy/launchd/ai.factory.alerts.plist', import.meta.url),
  );
  const text = readFileSync(PLIST, 'utf8');
  const withoutComments = text.replace(/<!--[\s\S]*?-->/gu, '');

  it('[the 04:00 job runs `alerts --notify`, once, as an argument]', () => {
    // The assertion is on the ProgramArguments array, not on the whole file: the flag has to be where
    // it is executed, and a `--notify` mentioned in prose or stored in the environment would not make
    // the job deliver. Exactly once, because a second occurrence would be an unexplained second
    // channel request in a job whose whole design is one attempt per day.
    const programArguments =
      /<key>ProgramArguments<\/key>\s*<array>([\s\S]*?)<\/array>/u.exec(withoutComments)?.[1] ?? '';
    expect(programArguments).toContain('apps/cli/src/main.ts alerts --notify</string>');
    expect(programArguments.match(/--notify/gu) ?? []).toHaveLength(1);
    // And no environment variable can turn the channel on silently: the only documented one is a
    // comment above, and comments were stripped here.
    expect(withoutComments).not.toContain('FACTORY_ALERTS_WEBHOOK_URL');
  });

  it('[FACTORY_ALERTS_WEBHOOK_URL is documented and unset: an XML comment cannot open a socket]', () => {
    expect(text).toContain('FACTORY_ALERTS_WEBHOOK_URL');
    expect(withoutComments).not.toContain('FACTORY_ALERTS_WEBHOOK_URL');
  });

  it('[the schedule is still 04:00, and RunAtLoad is still false]', () => {
    // The wake-up behaviour the runbook states comes from StartCalendarInterval (launchd runs a
    // missed calendar occurrence on wake); RunAtLoad is a different key and must not be mistaken for
    // it. Pinning both is how a later "fix" gets caught.
    expect(withoutComments).toMatch(/<key>Hour<\/key>\s*<integer>4<\/integer>/u);
    expect(withoutComments).toMatch(/<key>Minute<\/key>\s*<integer>0<\/integer>/u);
    expect(withoutComments).toMatch(/<key>RunAtLoad<\/key>\s*<false\/>/u);
  });
});
