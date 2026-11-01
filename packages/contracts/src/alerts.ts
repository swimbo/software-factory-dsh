/**
 * The `alerts.v1` document: the answer to "is evidence expired?" in one object.
 *
 * Two controls in this factory already exit 9 on expired evidence — `ledger verify` (the anchor is
 * older than 48 h) and `audit --certifications` (a class certificate is stale or absent) — and until
 * now a person had to run both and compare exit codes in their head. This document is the monitor's
 * answer, and it is deliberately a *report*, not a channel: a log nobody reads and a log nobody
 * could parse are different failures, and only the second is fixable here.
 *
 * Two rules are encoded in the schema rather than in prose:
 *
 *  - **`ok` cannot be true while an integrity alert is present.** A monitor that says "fine" next to
 *    `ANCHOR_STALE` is the failure mode this whole surface exists to prevent, so the refinement
 *    refuses the combination instead of trusting every caller to compute it the same way.
 *  - **An unreachable anchor is not an alert.** It is an *environment* failure (exit 8): there is no
 *    fact to report about the ledger, and reporting it as `ANCHOR_MISSING` would tell a reader the
 *    anchor is gone when the truth is that nobody looked. `anchor.state` carries it explicitly so a
 *    consumer cannot mistake absence of evidence for evidence of freshness.
 */
import { z } from 'zod';

/** The alert codes worth a line. An alert a reader cannot act on is noise in a log. */
export const ALERT_CODES = [
  /** The anchor exists but is older than the limit: a rewrite after it is undetectable. */
  'ANCHOR_STALE',
  /** No anchor exists at all: nothing off this machine can contradict a rewritten ledger. */
  'ANCHOR_MISSING',
  /** The anchor is ahead of the local ledger: the database was replaced or restored. */
  'ANCHOR_ROLLBACK',
  /** A class certificate's policy version or model id no longer matches the running factory. */
  'CERT_STALE',
  /** A class has no `certified` record at all — including `insufficient` and `not-certified`. */
  'CERT_NEVER',
  /** The store refuses writes; every verdict recorded from here is unverifiable. */
  'STORE_QUARANTINED',
  /** The gateway reported a spend ceiling crossing. Warning, never integrity-grade. */
  'BUDGET_CEILING_REACHED',
] as const;
export type AlertCode = (typeof ALERT_CODES)[number];

/**
 * `integrity` is the class that exits 9: evidence expired, or a control that must hold does not.
 * `warning` is printed and logged and does **not** page: spend ceilings and advisory facts stop being
 * useful the moment they drown the facts that mean "do not trust this ledger".
 */
export const ALERT_SEVERITIES = ['integrity', 'warning'] as const;
export type AlertSeverity = (typeof ALERT_SEVERITIES)[number];

export const Alert = z.object({
  code: z.enum(ALERT_CODES),
  severity: z.enum(ALERT_SEVERITIES),
  /** What the alert is about: a class name, the anchor transport, the store. */
  subject: z.string().min(1),
  /** When the fact became true, when that is known. `null` means the source cannot say. */
  at: z.string().datetime().nullable(),
  reason: z.string().min(1),
  /**
   * The literal next command. Required, because an alert whose reader has to guess what to run is a
   * line in a log, not a control.
   */
  investigation: z.string().min(1),
});
export type Alert = z.infer<typeof Alert>;

export const AlertsV1 = z
  .object({
    schema: z.literal('alerts.v1'),
    /** True only when there is nothing integrity-grade to report *and* the anchor was reached. */
    ok: z.boolean(),
    generatedAt: iso(),
    /**
     * The anchor probe's outcome, stated separately from the alerts: `unreachable` is the exit-8
     * case and must never be rendered as `missing`, which is an exit-9 verdict about the ledger.
     */
    anchor: z.object({
      state: z.enum(['fresh', 'stale', 'missing', 'rollback', 'unreachable', 'unconfigured']),
      scope: z.enum(['off-host', 'local', 'unknown']),
      ageHours: z.number().nonnegative().nullable(),
      /** The transport, safe to print: never a key, never a secret. */
      transport: z.string().min(1),
      reason: z.string().min(1),
    }),
    alerts: z.array(Alert).max(4096),
    counts: z.object({
      total: z.number().int().nonnegative(),
      bySeverity: z.object({
        integrity: z.number().int().nonnegative(),
        warning: z.number().int().nonnegative(),
      }),
    }),
  })
  .superRefine((document, ctx) => {
    const integrity = document.alerts.filter((alert) => alert.severity === 'integrity').length;
    if (integrity !== document.counts.bySeverity.integrity) {
      ctx.addIssue({
        code: 'custom',
        path: ['counts', 'bySeverity', 'integrity'],
        message: 'the integrity count must be the number of integrity alerts in the document',
      });
    }
    if (document.counts.total !== document.alerts.length) {
      ctx.addIssue({
        code: 'custom',
        path: ['counts', 'total'],
        message: 'the total must be the number of alerts in the document',
      });
    }
    // The rule this file exists to protect: a monitor that prints "fine" beside an expired fact is
    // worse than one that crashes, because a person reads it and believes it.
    const reached =
      document.anchor.state !== 'unreachable' && document.anchor.state !== 'unconfigured';
    if (document.ok && (integrity > 0 || !reached)) {
      ctx.addIssue({
        code: 'custom',
        path: ['ok'],
        message:
          'ok cannot be true with an integrity alert present or an anchor that was not reached',
      });
    }
  });
export type AlertsV1 = z.infer<typeof AlertsV1>;

function iso(): z.ZodString {
  return z.string().datetime();
}
