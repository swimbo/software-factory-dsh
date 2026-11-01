/**
 * `factory alerts` — the one place that asks the two expiry questions and answers in an exit code.
 *
 * Everything here is **read-only**: it opens the store, reads the anchor head, judges, prints and
 * exits. It never anchors, never re-certifies, never writes an event. That is what makes it safe to
 * run from a timer on a quarantined store.
 *
 * Two rules shape the design, and both exist because a monitor that lies is worse than no monitor:
 *
 *  - **It does not re-derive the judgements.** `verifyAnchor` from `@factory/anchor` decides whether
 *    the anchor is fresh, stale, missing or a rollback; `certificatesRecency` from `@factory/wall`
 *    decides whether a class certificate is current. This verb only *collects* their answers and
 *    turns them into alerts, because a second copy of those rules is how two surfaces start
 *    disagreeing a release later.
 *  - **Unreachable is not missing.** A transport failure means nobody looked (`exit 8`); a missing
 *    anchor means someone looked and there is nothing there (`ANCHOR_MISSING`, `exit 9`). Collapsing
 *    the two would either page a person for an ssh key or tell them the anchor is gone when it is
 *    not.
 */
import { spawnSync } from 'node:child_process';

import {
  AlertsV1,
  type Alert,
  type AlertCode,
  type AlertSeverity,
  type AlertsV1 as AlertsDocument,
} from '@factory/contracts';
import {
  DEFAULT_MAX_AGE_HOURS,
  fileTransport,
  lastValidRecord,
  verifyAnchor,
} from '@factory/anchor';
import {
  certificatesRecency,
  type CertificateRecency,
  type StoredCertificate,
} from '@factory/wall';

import { EXIT, UsageError } from '../exit.ts';
import { field } from '../render/format.ts';
import type { VerbInput, VerbSpec } from './types.ts';

/** What the anchor probe found, before it is turned into alerts. */
export type AnchorProbe =
  | {
      readonly state: 'fresh' | 'stale' | 'missing' | 'rollback';
      readonly scope: 'off-host' | 'local';
      readonly ageHours: number | null;
      readonly transport: string;
      readonly reason: string;
      readonly record: { readonly anchoredAt: string } | null;
    }
  | {
      readonly state: 'unreachable' | 'unconfigured';
      readonly scope: 'unknown';
      readonly ageHours: null;
      readonly transport: string;
      readonly reason: string;
      readonly record: null;
    };

/** The facts the decision needs. Pure data: no store, no clock, no transport. */
export interface AlertFacts {
  readonly anchor: AnchorProbe;
  /** `null` when the store has no certificate projection at all (pre-v3 store). */
  readonly certificates: readonly CertificateRecency[] | null;
  readonly quarantined: string | null;
  readonly budgetCeiling: { readonly crossed: boolean; readonly at: string | null };
}

export interface AlertDecision {
  readonly alerts: readonly Alert[];
  /** `8` when the anchor could not be reached, `9` for integrity alerts, `0` otherwise. */
  readonly exitCode: number;
}

function count(alerts: readonly Alert[]): AlertsDocument['counts'] {
  return {
    total: alerts.length,
    bySeverity: {
      integrity: alerts.filter((alert) => alert.severity === 'integrity').length,
      warning: alerts.filter((alert) => alert.severity === 'warning').length,
    },
  };
}

/**
 * The decision, separated from every I/O so it can be tested exhaustively.
 *
 * `unreachable` short-circuits the exit code to 8 but does **not** suppress the other alerts: a
 * person reading the log still wants to know the certificate is stale while the anchor is down.
 */
export function decideAlerts(facts: AlertFacts): AlertDecision {
  const alerts: Alert[] = [];

  if (facts.anchor.state === 'stale') {
    alerts.push({
      code: 'ANCHOR_STALE',
      severity: 'integrity',
      subject: facts.anchor.transport,
      at: facts.anchor.record?.anchoredAt ?? null,
      reason: facts.anchor.reason,
      investigation: 'factory ledger verify; docs/runbooks/ledger-anchor.md',
    });
  } else if (facts.anchor.state === 'missing' || facts.anchor.state === 'unconfigured') {
    // `unconfigured` reaches the same code as `missing`: both mean "no anchor exists to compare
    // against", and a monitor that stays silent because the variable is unset is the monitor that
    // lets an unanchored ledger look audited. The exit code still distinguishes them (8 vs 9),
    // because one is a configuration fault and the other is a ledger fact.
    alerts.push({
      code: 'ANCHOR_MISSING',
      severity: 'integrity',
      subject: facts.anchor.transport,
      at: null,
      reason: facts.anchor.reason,
      investigation: 'factory ledger anchor; docs/runbooks/ledger-anchor.md',
    });
  } else if (facts.anchor.state === 'rollback') {
    alerts.push({
      code: 'ANCHOR_ROLLBACK',
      severity: 'integrity',
      subject: facts.anchor.transport,
      at: facts.anchor.record?.anchoredAt ?? null,
      reason: facts.anchor.reason,
      investigation: 'factory ledger verify; docs/runbooks/ledger-anchor.md',
    });
  }

  if (facts.quarantined !== null) {
    alerts.push({
      code: 'STORE_QUARANTINED',
      severity: 'integrity',
      subject: 'store',
      at: null,
      reason: facts.quarantined,
      investigation: 'factory recover; docs/runbooks/store-quarantine.md',
    });
  }

  if (facts.certificates === null) {
    // No projection at all (a store that predates v3): no class has ever been certified, and the
    // audit already refuses to call that clean. The monitor must agree with it.
    alerts.push({
      code: 'CERT_NEVER',
      severity: 'integrity',
      subject: 'all task classes',
      at: null,
      reason: 'this store has no class certificates projection; no class has ever been certified',
      investigation: 'factory audit --certifications; docs/runbooks/certificate-expired.md',
    });
  } else {
    if (facts.certificates.length === 0) {
      // The rule `audit --certifications` refuses to break: an empty surface is not a licence.
      alerts.push({
        code: 'CERT_NEVER',
        severity: 'integrity',
        subject: 'all task classes',
        at: null,
        reason: 'no class has ever been certified in this store; nothing to audit is not a licence',
        investigation: 'factory audit --certifications; docs/runbooks/certificate-expired.md',
      });
    }
    for (const recency of facts.certificates) {
      if (recency.state === 'current') continue;
      const at = recency.certificate?.recordedAt ?? null;
      if (recency.state === 'stale') {
        alerts.push({
          code: 'CERT_STALE',
          severity: 'integrity',
          subject: recency.taskClass,
          at,
          reason: recency.reasons.join('; '),
          investigation: 'factory audit --certifications; docs/runbooks/certificate-expired.md',
        });
      } else {
        alerts.push({
          code: 'CERT_NEVER',
          severity: 'integrity',
          subject: recency.taskClass,
          at,
          reason:
            recency.certificate === null
              ? 'no certificate exists for this class'
              : `the newest certificate is ${recency.certificate.outcome}, which is never current`,
          investigation: 'factory audit --certifications; docs/runbooks/certificate-expired.md',
        });
      }
    }
  }

  if (facts.budgetCeiling.crossed) {
    alerts.push({
      code: 'BUDGET_CEILING_REACHED',
      severity: 'warning',
      subject: 'spend',
      at: facts.budgetCeiling.at,
      reason:
        'the gateway reported a spend ceiling crossing; measured spend is at or past the configured ceiling',
      investigation: 'factory budget show',
    });
  }

  // The anchor's own reachability comes last, because it decides the code: an unreachable anchor is
  // an environment fault (8), which must never be reported as "fine" (0).
  const unreachable = facts.anchor.state === 'unreachable' || facts.anchor.state === 'unconfigured';
  const integrity = alerts.some((alert) => alert.severity === 'integrity');
  return {
    alerts,
    exitCode: unreachable ? EXIT.environment : integrity ? EXIT.integrity : EXIT.ok,
  };
}

/** Read the anchor head without ever letting a transport failure read as "missing". */
export function probeAnchor(
  env: Readonly<Record<string, string | undefined>>,
  localEventCount: number,
): AnchorProbe {
  const host = (env['FACTORY_ANCHOR_SSH'] ?? '').trim();
  const remotePath = (env['FACTORY_ANCHOR_PATH'] ?? '/var/lib/factory/ledger-anchors.jsonl').trim();
  const directory = (env['FACTORY_ANCHOR_DIR'] ?? '').trim();
  const nowIso = new Date().toISOString();

  if (host === '') {
    if (directory === '') {
      return {
        state: 'unconfigured',
        scope: 'unknown',
        ageHours: null,
        transport: 'none configured',
        reason:
          'no anchor target is configured (FACTORY_ANCHOR_SSH + FACTORY_ANCHOR_PATH, or ' +
          'FACTORY_ANCHOR_DIR); an unconfigured monitor cannot say the anchor is fresh',
        record: null,
      };
    }
    const path = `${directory}/ledger-anchors.jsonl`;
    const record = readLocalAnchor(path);
    return judge(record, 'local', path, nowIso, localEventCount);
  }

  // The read is deliberately *not* wrapped in `|| true`: the ledger's own read can afford to swallow
  // a remote failure into `missing`, but a monitor cannot — an unreachable host and an absent anchor
  // are different facts, and the whole point of this verb is to keep them apart.
  const safePath = remotePath.replace(/'/gu, "'\\''");
  const command = `ssh -o BatchMode=yes -- ${host} 'tail -n 50 -- ${safePath}'`;
  const result = spawnSync('sh', ['-c', command], { encoding: 'utf8', timeout: 30_000 });
  const transport = `ssh ${host}:${remotePath}`;
  if (result.error !== undefined || result.status === 255) {
    const detail =
      result.error?.message ??
      (result.stderr ?? '').trim().split('\n').filter(Boolean).slice(-1)[0] ??
      'ssh failed';
    return {
      state: 'unreachable',
      scope: 'unknown',
      ageHours: null,
      transport,
      reason: `the anchor host could not be reached (${detail}); this is an environment failure, not a verdict about the ledger`,
      record: null,
    };
  }
  // A non-255 exit is the remote `tail` failing, which for our purposes is "the file is not there".
  const text = result.status === 0 ? (result.stdout ?? '') : '';
  return judge(lastValidRecord(text), 'off-host', transport, nowIso, localEventCount);
}

function readLocalAnchor(path: string): ReturnType<typeof lastValidRecord> {
  // A local read cannot be "unreachable": the file either parses or it does not, and the absence of
  // it is `missing` — a fact about the ledger, not about a host. `|| true` is safe here for exactly
  // that reason, and would not be safe over ssh.
  const result = spawnSync('sh', ['-c', `cat ${JSON.stringify(path)} 2>/dev/null || true`], {
    encoding: 'utf8',
    timeout: 10_000,
  });
  return lastValidRecord(result.stdout ?? '');
}

function judge(
  record: ReturnType<typeof lastValidRecord>,
  scope: 'off-host' | 'local',
  transport: string,
  nowIso: string,
  localEventCount: number,
): AnchorProbe {
  const verdict = verifyAnchor(record, {
    nowIso,
    maxAgeHours: DEFAULT_MAX_AGE_HOURS,
    scope,
    // Without the local count a rollback is invisible: an anchor ahead of this ledger is the one
    // signature of a database that was replaced or restored, and it outranks staleness.
    local: { seq: localEventCount, eventCount: localEventCount },
  });
  if (verdict.record === null) {
    return {
      state: 'missing',
      scope,
      ageHours: null,
      transport,
      reason: verdict.reason,
      record: null,
    };
  }
  return {
    state: verdict.outcome,
    scope,
    ageHours: verdict.ageHours,
    transport,
    reason: verdict.reason,
    record: { anchoredAt: verdict.record.anchoredAt },
  };
}

/** The store's certificates, grouped the way `audit --certifications` groups them. */
function certificatesFrom(ctx: VerbInput['ctx']): readonly CertificateRecency[] | null {
  const rows = ctx.store.classCertificates?.();
  if (rows === undefined) return null;
  const groups = new Map<string, StoredCertificate[]>();
  for (const row of rows) {
    const bucket = groups.get(row.taskClass) ?? [];
    bucket.push({
      taskClass: row.taskClass,
      outcome: row.outcome,
      policyVersion: row.policyVersion,
      modelId: row.modelId,
      recordedAt: row.recordedAt,
    });
    groups.set(row.taskClass, bucket);
  }
  return certificatesRecency({
    byClass: groups,
    running: {
      policyVersion: ctx.policyVersion,
      modelId: (ctx.env['FACTORY_MODEL_ID'] ?? '').trim() || null,
    },
  });
}

export function runAlerts(input: VerbInput): number {
  const { ctx } = input;
  if (input.args.length > 0) {
    throw new UsageError('USAGE: factory alerts takes no arguments');
  }
  const anchor = probeAnchor(ctx.env, ctx.store.eventCount());
  const certificates = certificatesFrom(ctx);
  const usage = ctx.store.listUsage?.() ?? [];
  const crossed = usage.filter((row) => row.ceilingCrossed);
  const decision = decideAlerts({
    anchor,
    certificates,
    quarantined: ctx.store.isQuarantined() ? 'the store is quarantined; writes are refused' : null,
    budgetCeiling: {
      crossed: crossed.length > 0,
      at: crossed.length === 0 ? null : (crossed[crossed.length - 1]?.signedAt ?? null),
    },
  });

  const document: AlertsDocument = AlertsV1.parse({
    schema: 'alerts.v1',
    ok: decision.exitCode === EXIT.ok,
    generatedAt: ctx.nowIso(),
    anchor: {
      state: anchor.state,
      scope: anchor.scope,
      ageHours: anchor.ageHours,
      transport: anchor.transport,
      reason: anchor.reason,
    },
    alerts: decision.alerts,
    counts: count(decision.alerts),
  });
  input.emit(document);

  if (decision.alerts.length === 0 && decision.exitCode === EXIT.ok) {
    ctx.ui.err(field('alerts', 'no alerts'));
  } else {
    ctx.ui.err(field('anchor', `${anchor.state.toUpperCase()} — ${anchor.reason}`));
    for (const alert of decision.alerts) {
      ctx.ui.err(
        `${alert.severity === 'integrity' ? 'INTEGRITY' : 'WARNING  '}  ${alert.code}  ${alert.subject}`,
      );
      ctx.ui.err(`           ${alert.reason}`);
      ctx.ui.err(`           next: ${alert.investigation}`);
    }
  }
  return decision.exitCode;
}

/** Severity is part of the machine-readable contract, not a rendering detail. */
export type { AlertCode, AlertSeverity };

export const alertsVerb: VerbSpec = {
  name: 'alerts',
  verb: 'alerts',
  summary: 'Report expired evidence: the anchor, class certificates, a quarantined store',
  arguments: [],
  configure: (command) => command,
  action: runAlerts,
};
