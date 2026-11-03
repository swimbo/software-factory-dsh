/**
 * `factory audit` — traceability, one screen, and the escape-rate sample.
 *
 * Two different audits live behind one verb, deliberately separated by flag
 * (`ux-plan.md` §3.8): the trace of a unit (event → receipt → verdict → policy)
 * and the escape-rate sample ("we are wrong about how wrong we are"). The trace
 * is read-only and works on a quarantined store; the escape-rate sample asks the
 * operator for something and therefore exits 5 while re-validation is outstanding.
 *
 * The `WHAT THIS VERDICT DOES NOT CLAIM` block is printed verbatim with any
 * verdict: the honest-claim discipline is not a footnote, and a CLI that omits it
 * is claiming more than the wall measured.
 */
import { contentHash, FactoryError } from '@factory/contracts';
import type { LedgerEvent } from '@factory/contracts';
import { certificatesRecency, type CertificateRecency } from '@factory/wall';

import { EXIT, UsageError } from '../exit.ts';
import { field } from '../render/format.ts';
import { boolOption, numberOption, textOption, type VerbInput, type VerbSpec } from './types.ts';

const NOT_CLAIMED = [
  'WHAT THIS VERDICT DOES NOT CLAIM',
  '  It is independent, deterministic where possible, adversarially tested and audited.',
  '  It is not "safe". It does not judge taste. Nothing in this system can.',
  '  A wall approving a bad change is the accepted residual risk (architecture.md §9.1).',
];

function unitIdOf(event: LedgerEvent): string | null {
  const payload = event.payload as { unitId?: unknown };
  return typeof payload.unitId === 'string' ? payload.unitId : null;
}

function eventSummary(event: LedgerEvent): string {
  const payload = event.payload as Record<string, unknown>;
  const interesting = [
    'lane',
    'attemptId',
    'receiptSha',
    'verdictId',
    'outcome',
    'reason',
    'state',
    'amountUsd',
  ];
  const parts: string[] = [];
  for (const key of interesting) {
    const value = payload[key];
    if (value === undefined || value === null) continue;
    if (typeof value === 'number') parts.push(`${key} ${value}`);
    else if (typeof value === 'string')
      parts.push(`${key} ${value.length > 24 ? `${value.slice(0, 21)}…` : value}`);
  }
  return parts.join('  ');
}

/** The certificate as the audit needs it: the store's row, narrowed to what is judged. */
interface StoredCertificateView {
  readonly taskClass: string;
  readonly outcome: 'certified' | 'not-certified' | 'insufficient';
  readonly samples: number;
  readonly m: number;
  readonly alpha: number;
  readonly policyVersion: string;
  readonly modelId: string | null;
  readonly recordedAt: string;
}

/**
 * Read the certificates and judge each class against the *running* policy and model.
 *
 * Two surfaces, because a store can be wrong in two directions:
 *
 *  - classes with a certificate — current or stale;
 *  - verified/promoted units whose verdict carried **no** certificate — a pass with no class
 *    judgement behind it. Reporting only the rows that exist would make that absence invisible,
 *    which is the exact failure L3 names.
 */
function certificateReport(ctx: VerbInput['ctx']): {
  readonly judgements: readonly CertificateRecency[];
  readonly uncertifiedUnits: readonly string[];
  readonly basis: { readonly policyVersion: string; readonly modelId: string | null };
  readonly projectionPresent: boolean;
  readonly certificatesByClass: ReadonlyMap<string, readonly StoredCertificateView[]>;
} {
  const rows = ctx.store.classCertificates?.();
  const groups = new Map<string, StoredCertificateView[]>();
  for (const row of rows ?? []) {
    const bucket = groups.get(row.taskClass) ?? [];
    bucket.push({
      taskClass: row.taskClass,
      outcome: row.outcome,
      samples: row.samples,
      m: row.m,
      alpha: row.alpha,
      policyVersion: row.policyVersion,
      modelId: row.modelId,
      recordedAt: row.recordedAt,
    });
    groups.set(row.taskClass, bucket);
  }
  const running = {
    policyVersion: ctx.policyVersion,
    modelId: (ctx.env['FACTORY_MODEL_ID'] ?? '').trim() || null,
  };
  // The projection is the only place a certificate exists. `mapVerdict` deliberately strips
  // `certification`/`modelId` from the verdict body (the promotion signature is computed over that
  // object, so its shape must not grow), which means asking the *verdict* whether it carried a
  // certificate answered "no" for every unit ever promoted — after an honest certification the
  // report still said "STALE OR NEVER CERTIFIED 20 of 21 entries" and `audit --certifications`
  // exited 9 forever. The question is asked of the projection instead: did this verdict leave a
  // certificate row behind?
  const certifiedVerdicts = new Set<string>();
  for (const row of rows ?? []) certifiedVerdicts.add(row.verdictId);
  const uncertifiedUnits: string[] = [];
  for (const state of ['verified', 'promoted'] as const) {
    for (const unit of ctx.store.listUnits({ state })) {
      const verdict = ctx.store.latestVerdictForUnit(unit.unitId);
      // No verdict at all is the stronger version of the same fact: a verified unit whose
      // evidence the store cannot produce has no certificate either.
      if (verdict === null || !certifiedVerdicts.has(verdict.verdictId)) {
        uncertifiedUnits.push(unit.unitId);
      }
    }
  }
  return {
    judgements: certificatesRecency({ byClass: groups, running }),
    uncertifiedUnits,
    basis: running,
    projectionPresent: rows !== undefined,
    certificatesByClass: groups,
  };
}

export function runAudit(input: VerbInput): number {
  const { ctx } = input;
  const wantsEscapeRate = boolOption(input.options, 'escapeRate');
  const wantsCertifications = boolOption(input.options, 'certifications');

  if (wantsCertifications) {
    if (unitIdFromArgs(input) !== null) {
      throw new UsageError('USAGE: --certifications audits classes; drop the unit id');
    }
    const report = certificateReport(ctx);
    const stale = report.judgements.filter((judgement) => judgement.state !== 'current');
    input.emit({
      kind: 'certifications',
      policyVersion: report.basis.policyVersion,
      modelId: report.basis.modelId,
      projectionPresent: report.projectionPresent,
      classes: report.judgements.map((judgement) => {
        const certificate = report.certificatesByClass.get(judgement.taskClass)?.[0] ?? null;
        return {
          taskClass: judgement.taskClass,
          state: judgement.state,
          outcome: certificate?.outcome ?? null,
          samples: certificate?.samples ?? null,
          m: certificate?.m ?? null,
          alpha: certificate?.alpha ?? null,
          // `current` and `never-certified` both mean "do not print a re-certify reason": the
          // former has none, the latter has no certificate to re-certify.
          reasons: judgement.state === 'stale' ? judgement.reasons : [],
        };
      }),
      uncertifiedUnits: report.uncertifiedUnits,
    });
    ctx.ui.err(
      `CLASS CERTIFICATIONS  under ${report.basis.policyVersion} (model ${report.basis.modelId ?? 'offline'})`,
    );
    if (!report.projectionPresent) {
      ctx.ui.err('  this store has no class certificates projection; nothing can be certified');
    }
    for (const judgement of report.judgements) {
      ctx.ui.err(`  ${judgement.taskClass}  ${judgement.state}`);
      for (const reason of judgement.state === 'stale' ? judgement.reasons : []) {
        ctx.ui.err(`    ${reason}`);
      }
    }
    for (const unitId of report.uncertifiedUnits) {
      ctx.ui.err(`  ${unitId}  unit verified with no class certificate: never certified`);
    }
    // An empty surface is not a clean one. "Nothing has been certified" and "everything is
    // current" print differently and exit differently, because an audit that passes on an empty
    // store teaches an operator to read absence as approval.
    const empty = report.judgements.length === 0 && report.uncertifiedUnits.length === 0;
    if (empty) {
      ctx.ui.err('  NO CLASS CERTIFICATES  no class has been certified in this store');
      ctx.ui.err('  Nothing to audit is not a licence: this is never-certified, not current');
      return EXIT.integrity;
    }
    const bad = stale.length + report.uncertifiedUnits.length + (report.projectionPresent ? 0 : 1);
    if (bad === 0) {
      ctx.ui.err(`  ${report.judgements.length} of ${report.judgements.length} classes current`);
      return EXIT.ok;
    }
    ctx.ui.err(
      `  STALE OR NEVER CERTIFIED  ${bad.toString()} of ${(report.judgements.length + report.uncertifiedUnits.length).toString()} entries; a stale certificate is expired evidence, not a warning`,
    );
    return EXIT.integrity;
  }

  if (wantsEscapeRate) {
    const shipped = ctx.store.listUnits({ state: 'promoted' });
    const since = textOption(input.options, 'since') ?? null;
    const sampleSize =
      textOption(input.options, 'sample') === undefined
        ? 5
        : numberOption(input.options, 'sample', '--sample <n>');
    const sample = shipped.slice(0, Math.max(1, Math.min(sampleSize, 100)));
    const reviewed = 0;
    input.emit({
      kind: 'escape-rate',
      since,
      shipped: shipped.length,
      sample: sample.map((unit) => ({
        unitId: unit.unitId,
        wallRescore: 'not re-scored in v1 (no wall port wired)',
        humanRevalidation: 'PENDING',
      })),
      revalidated: reviewed,
      awaitingReview: sample.length - reviewed,
      traceId: ctx.traceId,
    });
    ctx.ui.err(
      `ESCAPE RATE AUDIT  sample ${sample.length} of ${shipped.length} shipped units${since === null ? '' : ` since ${since}`} (fixed rate 20%)`,
    );
    for (const unit of sample) {
      ctx.ui.err(`  ${unit.unitId}  wall re-score: not run in v1   human re-validation: PENDING`);
    }
    ctx.ui.err(
      `  ESCAPE RATE  ${reviewed} / ${sample.length} re-validated so far  ${'·'}  ${sample.length - reviewed} awaiting your review`,
    );
    ctx.ui.err('  This is the "we are wrong about how wrong we are" metric. It is not optional.');
    if (unitIdFromArgs(input) !== null) {
      throw new UsageError('USAGE: --escape-rate audits a sample, not one unit; drop the unit id');
    }
    return sample.length > 0 ? 5 : 0;
  }

  const unitId = unitIdFromArgs(input);
  const limit =
    textOption(input.options, 'last') === undefined
      ? 200
      : numberOption(input.options, 'last', '--last <n>');

  if (unitId === null) {
    // `--last N` without a unit is the ledger tail, which stays readable while the
    // store is quarantined (§5.4).
    const total = ctx.store.eventCount();
    const from = Math.max(0, total - Math.max(1, Math.min(limit, 1000)));
    const events = ctx.store.eventsSince(from, limit);
    input.emit({
      kind: 'ledger-tail',
      events: events.map((event) => ({
        seq: event.seq,
        type: event.type,
        occurredAt: event.occurredAt,
        actor: event.actor,
        unitId: unitIdOf(event),
      })),
      head:
        events.length === 0
          ? null
          : contentHash(events[events.length - 1]?.payload ?? {}).slice(0, 15),
      traceId: ctx.traceId,
    });
    ctx.ui.err(`LEDGER  ${total} event(s), showing the last ${events.length}`);
    for (const event of events) {
      ctx.ui.err(
        `  ${String(event.seq).padStart(6)}  ${event.occurredAt}  ${event.type.padEnd(20)} ${eventSummary(event)}`,
      );
    }
    return 0;
  }

  const unit = ctx.store.getUnit(unitId);
  if (unit === null) {
    throw new FactoryError(
      'UNIT_NOT_FOUND',
      `UNIT_NOT_FOUND: no unit ${unitId}. See: factory status --all`,
      {
        unitId,
      },
    );
  }

  const events = ctx.store
    .eventsSince(0, Math.max(ctx.store.eventCount(), 1))
    .filter((event) => unitIdOf(event) === unitId || unitIdOf(event) === unit?.slug);
  const verdict = ctx.store.latestVerdictForUnit(unitId);

  input.emit({
    kind: 'trace',
    unitId,
    lane: unit.lane,
    state: unit.state,
    events: events.map((event) => ({
      seq: event.seq,
      type: event.type,
      occurredAt: event.occurredAt,
      actor: event.actor,
      traceId: event.traceId,
    })),
    verdict:
      verdict === null
        ? null
        : {
            verdictId: verdict.verdictId,
            outcome: verdict.outcome,
            wallVersion: verdict.wallVersion,
            holdoutRevision: verdict.holdoutRevision,
            policyVersion: verdict.policyVersion,
            delta: verdict.verdict.delta.observed,
          },
    traceId: ctx.traceId,
  });

  ctx.ui.err(`TRACE  ${unitId}   (event -> receipt -> verdict -> policy)`);
  for (const event of events) {
    const short = contentHash(event.payload).slice(0, 15);
    ctx.ui.err(`  ${event.occurredAt}  ${event.type.padEnd(20)} ${short}…  ${eventSummary(event)}`);
  }
  if (verdict !== null) {
    ctx.ui.err(
      field(
        '  verdict',
        `${verdict.verdictId}  ${verdict.outcome}  delta ${verdict.verdict.delta.observed === null ? 'unknown' : verdict.verdict.delta.observed.toFixed(2)}  ${verdict.wallVersion} ${verdict.holdoutRevision}`,
      ),
    );
    ctx.ui.err('');
    for (const line of NOT_CLAIMED) ctx.ui.err(line);
    if (verdict.outcome === 'unknown') {
      ctx.ui.err('');
      ctx.ui.err('This verdict is UNKNOWN — not measured. It is not a pass and not a failure.');
      return 4;
    }
    if (verdict.outcome === 'fail') return 3;
  }
  ctx.ui.err(
    `  ledger head ${ctx.store.eventCount()} event(s)  ${'·'}  every row above is append-only`,
  );
  return 0;
}

function unitIdFromArgs(input: VerbInput): string | null {
  const candidate = input.args[0];
  return candidate === undefined || candidate.trim().length === 0 ? null : candidate.trim();
}

export const auditVerb: VerbSpec = {
  name: 'audit',
  verb: 'audit',
  summary:
    'Print the trace of a unit, sample shipped units for the escape rate, or audit class certificates',
  arguments: ['[unitId]'],
  configure: (command) =>
    command
      .option(
        '--escape-rate',
        'sample shipped units for the escape rate (asks you for re-validation)',
      )
      .option(
        '--certifications',
        'per class: the operating point it was certified at, and whether that is still current',
      )
      .option('--since <date>', 'escape-rate window, e.g. 2026-10-01')
      .option('--sample <n>', 'how many units to sample (default 5)')
      .option('--last <n>', 'how many ledger events to show without a unit id (default 200)'),
  action: runAudit,
};
