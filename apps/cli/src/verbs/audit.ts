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
import { existsSync } from 'node:fs';
import { join } from 'node:path';

import { contentHash, FactoryError } from '@factory/contracts';
import type { LedgerEvent } from '@factory/contracts';
import { legacyPolicyVersions } from '@factory/qualifier';
import {
  ACCEPTANCE_ALTERNATIVE_P,
  certificatesRecency,
  certificationRisk,
  DEFAULT_OPERATING_POINT,
  judgedCertificate,
  type CertificateRecency,
} from '@factory/wall';

import { EXIT, UsageError } from '../exit.ts';
import {
  parseRecertifyBudgets,
  planRecertification,
  type RecertifyDueClass,
  type RecertifyPlanEntry,
} from '../recertify-plan.ts';
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
  /**
   * The corpus the certificate names, `null` when the row predates corpus attribution (schema v5).
   * Carried, not derived: the audit must print the same corpus the judgement compared.
   */
  readonly holdoutRevision: string | null;
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
interface CertificationsReport {
  readonly judgements: readonly CertificateRecency[];
  readonly uncertifiedUnits: readonly string[];
  readonly basis: { readonly policyVersion: string; readonly modelId: string | null };
  readonly projectionPresent: boolean;
  readonly certificatesByClass: ReadonlyMap<string, readonly StoredCertificateView[]>;
}

function certificateReport(ctx: VerbInput['ctx']): CertificationsReport {
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
      holdoutRevision: row.holdoutRevision,
      recordedAt: row.recordedAt,
    });
    groups.set(row.taskClass, bucket);
  }
  const running = {
    policyVersion: ctx.policyVersion,
    modelId: (ctx.env['FACTORY_MODEL_ID'] ?? '').trim() || null,
    // A certificate recorded before the dispatch ceilings were moved out of the policy carries a
    // digest over the same rules plus those ceilings; recognise it as the same rules, not a change.
    acceptedPolicyVersions: legacyPolicyVersions(ctx.policy),
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

/**
 * How the audit spells a corpus, including its absence.
 *
 * `null` is never printed as "any": on a certificate it means the row predates attribution, and on the
 * newest measurement it means no measurement of this class has ever named one. Two different absences,
 * two different sentences.
 */
function describeCorpus(corpus: string | null, side: 'certificate' | 'measurement'): string {
  if (corpus !== null) return corpus;
  return side === 'certificate'
    ? 'an unnamed corpus (this certificate predates corpus attribution)'
    : 'no named corpus';
}

/**
 * What re-certifying each due class would cost, and whether a spend is permitted.
 *
 * The cost comes from the usage facts this store already holds: a certificate names its verdict, the
 * verdict names its attempt, and the attempt's metered usage is the measured number — not an estimate
 * from another class. A class with one judged attempt therefore has a real median (however thin) and a
 * class with none has `unknown`, which never authorises a spend.
 *
 * The budget is per class and comes from the environment (`FACTORY_RECERTIFY_BUDGET_TOKENS`), read
 * here because the audit is the surface the operator already looks at. Reading it does not spend
 * anything: a spend needs `scripts/recertify-due.sh --spend`, and even that only runs classes whose
 * decision is `would-spend`.
 */
function recertificationPlan(
  ctx: VerbInput['ctx'],
  report: CertificationsReport,
  unitsDir: string | null,
): readonly RecertifyPlanEntry[] {
  const tokensByTaskClass = new Map<string, number[]>();
  const certificates = ctx.store.classCertificates?.() ?? [];
  for (const certificate of certificates) {
    const verdict = ctx.store.getVerdict(certificate.verdictId);
    if (verdict === null) continue;
    const usage = ctx.store.usageForAttempt(verdict.attemptId);
    if (usage.length === 0) continue;
    let total = 0;
    for (const row of usage) total += row.tokensIn + row.tokensOut;
    const bucket = tokensByTaskClass.get(certificate.taskClass) ?? [];
    bucket.push(total);
    tokensByTaskClass.set(certificate.taskClass, bucket);
  }

  const classes: RecertifyDueClass[] = report.judgements.map((judgement) => {
    // The counts come from the same row the *judgement* came from, exactly as the JSON block does:
    // a class can hold an older `certified` row and a newer `insufficient` one, and the plan's
    // "attempts still needed" must describe the row the state describes.
    const certificate = judgedCertificate(
      report.certificatesByClass.get(judgement.taskClass) ?? [],
    );
    return {
      taskClass: judgement.taskClass,
      state: judgement.state === 'current' ? 'current' : judgement.state,
      samples: certificate?.samples ?? 0,
      m: certificate?.m ?? DEFAULT_OPERATING_POINT.m,
    };
  });

  const unitsFiles = new Map<string, string | null>();
  for (const entry of classes) {
    unitsFiles.set(
      entry.taskClass,
      unitsDir === null ? null : join(unitsDir, `${entry.taskClass}.txt`),
    );
  }
  // A units file that does not exist is `null`, not a path that fails later: the plan's job is to say
  // whether the spend can happen, and "the file is missing" is exactly the kind of no it exists for.
  for (const [taskClass, file] of unitsFiles) {
    unitsFiles.set(taskClass, file !== null && existsSync(file) ? file : null);
  }

  const budgets = parseRecertifyBudgets(ctx.env['FACTORY_RECERTIFY_BUDGET_TOKENS'], (message) => {
    throw new UsageError(`USAGE: ${message}`);
  });

  return planRecertification({ classes, budgets, tokensByTaskClass, unitsFiles });
}

/**
 * The operating point with both halves of its risk, in the shape the certifications JSON carries.
 *
 * `alphaExact` is the ratified published number — P(a class that truly passes p0 fails certification).
 * `acceptanceAt` is the half that was missing until the 2026-11-07 ruling: P(a class that truly passes
 * a worse rate is certified anyway). Both are computed here from `certificationRisk` rather than
 * quoted, so a change to the point cannot leave a stale number printed beside it.
 */
function operatingPointBlock(): {
  readonly m: number;
  readonly k: number;
  readonly p0: number;
  readonly alpha: number;
  readonly alphaExact: string;
  readonly acceptanceAt: {
    readonly p: number;
    readonly probability: number;
    readonly exact: string;
  };
} {
  const { m, k, p0 } = DEFAULT_OPERATING_POINT;
  const risk = certificationRisk({ m, k, p0 });
  const acceptance = risk.certifiedAt(ACCEPTANCE_ALTERNATIVE_P);
  return {
    m,
    k,
    p0,
    alpha: risk.alpha,
    alphaExact: risk.alphaExact,
    acceptanceAt: {
      p: ACCEPTANCE_ALTERNATIVE_P,
      probability: acceptance.value,
      exact: acceptance.exact,
    },
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
    // The units directory is where the scheduled job keeps one `<class>.txt` per class. Read as a
    // fact about the filesystem, never created here: an audit is read-only.
    const unitsDir = (ctx.env['FACTORY_RECERTIFY_UNITS_DIR'] ?? '').trim();
    const plan = recertificationPlan(ctx, report, unitsDir === '' ? null : unitsDir);
    const stale = report.judgements.filter((judgement) => judgement.state !== 'current');
    input.emit({
      kind: 'certifications',
      policyVersion: report.basis.policyVersion,
      modelId: report.basis.modelId,
      projectionPresent: report.projectionPresent,
      classes: report.judgements.map((judgement) => {
        // The counts must describe the row the *state* came from. A class can hold an older
        // `certified` row and a newer `insufficient` one (the attempt after the criteria log
        // gained its identity starts its count at 1), and printing the newer row's `samples: 1`
        // beside `state: 'current'` would read as a contradiction the operator cannot resolve.
        // `judgedCertificate` is the same rule the judgement used, so the two cannot drift.
        const certificate =
          judgedCertificate(report.certificatesByClass.get(judgement.taskClass) ?? []) ?? null;
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
          // The corpus the certificate names (the fact it was measured under), and — when the
          // judgement is stale — the corpus the latest measurement names. Both are in the JSON so a
          // scripted reader can see the disagreement without parsing English out of `reasons`.
          holdoutRevision: certificate?.holdoutRevision ?? null,
          latestHoldoutRevision:
            judgement.state === 'stale'
              ? judgement.referenceHoldoutRevision
              : (certificate?.holdoutRevision ?? null),
        };
      }),
      uncertifiedUnits: report.uncertifiedUnits,
      // The operating point a certificate was judged at, both halves of its risk, and the definition
      // of the second one. α alone was quotable as a strength; the 2026-11-07 ruling says the screen
      // half ships wherever α does (`findings.md` § DECIDED 2026-11-07).
      operatingPoint: operatingPointBlock(),
      // What re-certifying each due class would cost, from this store's own usage facts, and whether a
      // budget permits the spend. `no-budget` is the default state: the scheduled job reports and
      // spends nothing, which is why a job exists before a spender does.
      recertification: {
        budgetVariable: 'FACTORY_RECERTIFY_BUDGET_TOKENS',
        unitsVariable: 'FACTORY_RECERTIFY_UNITS_DIR',
        entries: plan,
      },
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
      // The evidence line: a re-certify reason names the consequence ("the corpus changed"), this
      // names the two facts it is drawn from. Printed for every stale class, because "policy
      // changed" beside an unattributed corpus is what the operator needs to see before deciding
      // between re-certifying and reading the old measurement as expired.
      if (judgement.state === 'stale') {
        ctx.ui.err(
          `    certified ${judgement.certificate.policyVersion} under ${describeCorpus(judgement.certificate.holdoutRevision ?? null, 'certificate')}; latest measurement under ${describeCorpus(judgement.referenceHoldoutRevision, 'measurement')}`,
        );
      }
    }
    const point = operatingPointBlock();
    ctx.ui.err(
      `  OPERATING POINT  m=${String(point.m)} k=${String(point.k)} p0=${String(point.p0)}  ` +
        `alpha=${String(point.alphaExact)} is P(a class that truly passes ${String(point.p0)} fails certification)`,
    );
    ctx.ui.err(
      `  a certificate at this point is a screen, not a test: a class that truly passes ` +
        `${String(point.acceptanceAt.p)} is certified anyway with probability ` +
        `${String(point.acceptanceAt.exact)}`,
    );
    for (const entry of plan) {
      if (entry.state === 'current') continue;
      const cost =
        entry.estimate.projectedTokens === null
          ? 'cost unknown (no measured attempt behind this class)'
          : `${entry.estimate.projectedTokens.toString()} tokens projected (` +
            `${entry.remaining.toString()} attempts × median ` +
            `${String(entry.estimate.medianTokensPerAttempt)} over ` +
            `${entry.estimate.measuredAttempts.toString()} measured)`;
      ctx.ui.err(
        `  RE-CERTIFY ${entry.taskClass}  ${entry.remaining.toString()} attempt(s) to m=${String(
          entry.m,
        )}  ${cost}  ${entry.decision}: ${entry.reason}`,
      );
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
