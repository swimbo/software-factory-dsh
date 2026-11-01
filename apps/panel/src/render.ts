/**
 * The page, as one server-rendered HTML string.
 *
 * No client-side JavaScript, no external asset, no framework: the document is
 * assembled from the validated `status.v1` object and nothing else. Two rendering
 * rules are load-bearing rather than stylistic:
 *
 *  - **A state is always a word.** Every glyph (`[✓]`, `[?]`, `[—]`) is followed by
 *    its word, and the glyph is `aria-hidden` — colour and shape are redundant
 *    channels, never the only one.
 *  - **`unknown` is never dressed as a pass.** An unmeasured number prints the
 *    literal word `unknown` (never `—`, never `0`, never blank), an unmeasured
 *    budget prints a gap plus `spend understated`, and an uncertified verdict
 *    prints `not a pass` next to its reason.
 */
import type {
  StatusV1,
  UnitStatus,
  UnitStatusState,
  VerdictStatus,
  WaitingOnPerson,
} from '@factory/contracts';

import { NO_RECEIPT_ID, formatUsd } from './status.ts';
import { stylesheet } from './tokens.ts';

type Tone = 'ok' | 'warn' | 'danger' | 'unknown' | 'muted';

interface Pill {
  readonly glyph: string;
  readonly word: string;
  readonly tone: Tone;
}

/** Unit state → pill. The word is the source of truth; the glyph only echoes it. */
const UNIT_PILLS: Readonly<Record<UnitStatusState, Pill>> = {
  queued: { glyph: '[·]', word: 'QUEUED', tone: 'muted' },
  dispatched: { glyph: '[~]', word: 'DISPATCHED', tone: 'muted' },
  running: { glyph: '[~]', word: 'RUNNING', tone: 'muted' },
  verifying: { glyph: '[~]', word: 'VERIFYING', tone: 'muted' },
  verified: { glyph: '[·]', word: 'VERIFIED', tone: 'muted' },
  promoted: { glyph: '[✓]', word: 'PROMOTED', tone: 'ok' },
  failed: { glyph: '[×]', word: 'FAILED', tone: 'danger' },
  rejected: { glyph: '[—]', word: 'REJECTED', tone: 'danger' },
  unknown: { glyph: '[?]', word: 'UNKNOWN', tone: 'unknown' },
  ambiguous: { glyph: '[?]', word: 'AMBIGUOUS', tone: 'unknown' },
  aborted: { glyph: '[×]', word: 'ABORTED', tone: 'danger' },
  lit_parked: { glyph: '[■]', word: 'NEEDS YOU', tone: 'warn' },
};

const VERDICT_PILLS: Readonly<Record<VerdictStatus['state'], Pill>> = {
  passed: { glyph: '[✓]', word: 'PASSED', tone: 'ok' },
  failed: { glyph: '[×]', word: 'FAILED', tone: 'danger' },
  unknown: { glyph: '[?]', word: 'UNKNOWN', tone: 'unknown' },
};

const HEALTH_LABELS = {
  store: 'STORE',
  controlPlane: 'CONTROL PLANE',
  executor: 'EXECUTOR',
  wall: 'WALL',
  outbox: 'OUTBOX',
  dshVersion: 'DSH VERSION',
} as const;

const KIND_PILLS: Readonly<Record<WaitingOnPerson['kind'], Pill>> = {
  budget_envelope_raise: { glyph: '[■]', word: 'BUDGET ENVELOPE', tone: 'warn' },
  initial_production_deploy: { glyph: '[■]', word: 'FIRST DEPLOY', tone: 'warn' },
  privileged_credential_issuance: { glyph: '[■]', word: 'CREDENTIAL', tone: 'warn' },
  lit_unit: { glyph: '[■]', word: 'LIT UNIT', tone: 'warn' },
  ambiguous_attempt: { glyph: '[?]', word: 'AMBIGUOUS ATTEMPT', tone: 'unknown' },
  unknown_verdict: { glyph: '[?]', word: 'UNKNOWN VERDICT', tone: 'unknown' },
  escape_rate_review: { glyph: '[■]', word: 'ESCAPE REVIEW', tone: 'warn' },
};

// ------------------------------------------------------------------- primitives

/** Everything dynamic goes through here. A title with `<script>` in it stays a title. */
export function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function pill(pillSpec: Pill): string {
  return (
    `<span class="pill pill--${pillSpec.tone}">` +
    `<span aria-hidden="true">${escapeHtml(pillSpec.glyph)}</span> ${escapeHtml(pillSpec.word)}</span>`
  );
}

function code(value: string): string {
  return `<code>${escapeHtml(value)}</code>`;
}

/** Money is always approximate and always says so; `estimated` follows the figure. */
function estimatedAmount(amount: number, understated: boolean): string {
  return `~${formatUsd(amount)}${understated ? '+' : ''}`;
}

function percent(fraction: number): string {
  return `${Math.round(Math.max(0, Math.min(1, fraction)) * 100)}%`;
}

function duration(seconds: number): string {
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  const rest = seconds % 60;
  if (minutes < 60)
    return rest === 0 ? `${minutes}m` : `${minutes}m${String(rest).padStart(2, '0')}s`;
  const hours = Math.floor(minutes / 60);
  return `${hours}h${String(minutes % 60).padStart(2, '0')}m`;
}

function secondsOf(fromIso: string, toIso: string): number | null {
  const from = Date.parse(fromIso);
  const to = Date.parse(toIso);
  if (Number.isNaN(from) || Number.isNaN(to)) return null;
  return Math.max(0, Math.floor((to - from) / 1000));
}

function deltaText(value: number | null): string {
  // `Δ unknown` is a literal value on the page, not a blank and not a zero.
  return value === null ? 'Δ unknown' : `Δ ${value.toFixed(2)}`;
}

function rateText(value: number | null): string {
  return value === null ? 'unknown' : value.toFixed(2);
}

// ------------------------------------------------------------------- components

function renderHeader(status: StatusV1): string {
  const needYou = status.waitingOnPerson.length;
  const working = status.units.filter(
    (unit) =>
      unit.state === 'dispatched' ||
      unit.state === 'running' ||
      unit.state === 'verifying' ||
      unit.state === 'queued',
  ).length;
  const unknown = status.units.filter((unit) => unit.state === 'unknown').length;
  const unknownClause = unknown > 0 ? ` · ${unknown} unknown (not a pass)` : '';
  return `
<header>
  <div>
    <h1>factory status</h1>
    <p class="answer">${needYou} need you · ${working} working${unknownClause}</p>
  </div>
  <p class="meta">generated ${escapeHtml(status.generatedAt)} · page refreshes every 10s</p>
</header>`;
}

function renderQuarantine(status: StatusV1): string {
  if (!status.health.store.quarantined) return '';
  return `
<aside class="banner banner--danger" aria-labelledby="quarantine-title">
  <h2 id="quarantine-title">STORE QUARANTINED — the factory is read-only</h2>
  <p>Every write is refused: intent, qualify, run, abort, promote, budget, credential. Reads still work, which is why this page still renders.</p>
  <p>Do not reset, delete or repair this store. Runbook: <code>docs/runbooks/store-quarantine.md</code></p>
</aside>`;
}

interface HealthEntry {
  readonly label: string;
  readonly state: 'ok' | 'degraded' | 'unavailable';
  readonly detail: string | null;
  readonly since: string | null;
}

function healthEntries(status: StatusV1): HealthEntry[] {
  const health = status.health;
  return [
    {
      label: HEALTH_LABELS.store,
      state: health.store.state,
      detail: health.store.detail,
      since: health.store.since ?? null,
    },
    {
      label: HEALTH_LABELS.controlPlane,
      state: health.controlPlane.state,
      detail: health.controlPlane.detail,
      since: health.controlPlane.since ?? null,
    },
    {
      label: HEALTH_LABELS.executor,
      state: health.executor.state,
      detail: health.executor.detail,
      since: health.executor.since ?? null,
    },
    {
      label: HEALTH_LABELS.wall,
      state: health.wall.state,
      detail: health.wall.detail,
      since: health.wall.since ?? null,
    },
    {
      label: HEALTH_LABELS.outbox,
      state: health.outbox.state,
      detail: health.outbox.detail,
      since: health.outbox.since ?? null,
    },
    {
      label: HEALTH_LABELS.dshVersion,
      state: health.dshVersion.state,
      detail: health.dshVersion.detail,
      since: health.dshVersion.since ?? null,
    },
  ];
}

const HEALTH_RANK: Readonly<Record<HealthEntry['state'], number>> = {
  unavailable: 0,
  degraded: 1,
  ok: 2,
};
const HEALTH_GLYPH: Readonly<Record<HealthEntry['state'], string>> = {
  unavailable: '[×]',
  degraded: '[■]',
  ok: '[✓]',
};
const HEALTH_TONE: Readonly<Record<HealthEntry['state'], Tone>> = {
  unavailable: 'danger',
  degraded: 'warn',
  ok: 'ok',
};

/**
 * The strip is silent when everything is ok — an always-on banner is how an
 * operator learns to ignore the one that matters. When it appears it is
 * worst-first, with the rest on a second line.
 */
function renderHealth(status: StatusV1): string {
  const entries = healthEntries(status);
  const notOk = entries
    .filter((entry) => entry.state !== 'ok')
    .sort((a, b) => HEALTH_RANK[a.state] - HEALTH_RANK[b.state]);
  if (notOk.length === 0) return '';
  const [first, ...rest] = notOk;
  if (!first) return '';
  const firstPill = `<span class="pill pill--${HEALTH_TONE[first.state]}"><span aria-hidden="true">${escapeHtml(
    HEALTH_GLYPH[first.state],
  )}</span> ${escapeHtml(first.label)} ${escapeHtml(first.state.toUpperCase())}</span>`;
  const firstDetail = first.detail === null ? '' : ` — ${escapeHtml(first.detail)}`;
  const firstSince = first.since === null ? '' : ` · since ${escapeHtml(first.since)}`;
  const restLine = rest
    .map(
      (entry) =>
        `${escapeHtml(entry.label)} ${escapeHtml(entry.state.toUpperCase())}` +
        (entry.since === null ? '' : ` since ${escapeHtml(entry.since)}`),
    )
    .join(' · ');
  const okLine = entries
    .filter((entry) => entry.state === 'ok')
    .map((entry) => `${escapeHtml(entry.label)} ok`)
    .join(' · ');
  return `
<aside class="health${first.state === 'unavailable' ? ' health--danger' : ''}" aria-labelledby="health-title">
  <h2 id="health-title">HEALTH</h2>
  <p>${firstPill}${firstDetail}${firstSince}</p>
  <p class="meta">${restLine.length > 0 ? `${restLine}${okLine.length > 0 ? ` · ${okLine}` : ''}` : okLine}</p>
</aside>`;
}

function renderNeedsYou(status: StatusV1): string {
  const items = status.waitingOnPerson;
  const body =
    items.length === 0
      ? '<p class="meta">nothing needs you</p>'
      : `<ul>${items.map(renderWaitingItem).join('')}</ul>`;
  return `
<section aria-labelledby="needs-you-title">
  <h2 id="needs-you-title">NEEDS YOU <span class="meta">${items.length}</span></h2>
  ${body}
</section>`;
}

function renderWaitingItem(item: WaitingOnPerson): string {
  const pillSpec = KIND_PILLS[item.kind];
  const irreversible = item.irreversible
    ? '<p class="meta">irreversible: this cannot be undone once signed</p>'
    : '';
  return `
    <li class="record">
      <div class="record__head">
        ${pill(pillSpec)}
        ${item.unitId === null ? '' : code(item.unitId)}
        <span class="meta">since ${escapeHtml(item.since)}</span>
      </div>
      <p>${escapeHtml(item.question)}</p>
      <p class="cmd mono">→ ${escapeHtml(item.recommendedCommand)}</p>
      ${irreversible}
    </li>`;
}

function renderWorking(status: StatusV1): string {
  const units = status.units.filter(
    (unit) =>
      unit.state === 'queued' ||
      unit.state === 'dispatched' ||
      unit.state === 'running' ||
      unit.state === 'verifying',
  );
  const body =
    units.length === 0
      ? '<p class="meta">nothing in flight</p>'
      : `<ul>${units.map(renderUnitRecord).join('')}</ul>`;
  return `
<section aria-labelledby="working-title">
  <h2 id="working-title">WORKING <span class="meta">${units.length}</span></h2>
  ${body}
</section>`;
}

function renderUnitRecord(unit: UnitStatus): string {
  const attempt = unit.attempt;
  const elapsed = attempt === null ? null : secondsOf(unit.updatedAt, attempt.startedAt);
  const telemetry =
    attempt === null
      ? 'no attempt yet'
      : `attempt ${attempt.attemptNo} · ${escapeHtml(attempt.state)}${
          elapsed === null ? '' : ` · ${escapeHtml(duration(elapsed))} elapsed`
        }`;
  return `
    <li class="record">
      <div class="record__head">
        ${pill(UNIT_PILLS[unit.state])}
        ${code(unit.unitId)}
        <span class="meta">lane ${escapeHtml(unit.lane ?? 'undecided')} · ${telemetry}</span>
      </div>
      <p>${escapeHtml(unit.title)}</p>
      <p class="meta">turn ${attempt === null || attempt.turn === null ? 'unknown' : attempt.turn} · tokens unknown/unknown · wall-clock ceiling unknown · no-progress streak unknown</p>
    </li>`;
}

function renderVerdictRecord(unit: UnitStatus, verdict: VerdictStatus): string {
  const delta = deltaText(verdict.delta.value);
  const measured = verdict.delta.state === 'measured' ? '' : ' (not measured)';
  const unknown =
    verdict.state === 'unknown'
      ? `<p>not a pass — ${escapeHtml(verdict.unknownReason ?? 'no reason recorded')}</p>`
      : '';
  const receiptWord =
    verdict.receipt.receiptId === NO_RECEIPT_ID
      ? 'no receipt cited by this verdict'
      : `receipt ${verdict.receipt.receiptId}`;
  const signedWord =
    verdict.signed === null
      ? 'unknown'
      : `${verdict.signed.alg} ${verdict.signed.keyId} (${verdict.signed.verified ? 'verified' : 'unverified'})`;
  return `
    <li class="record">
      <div class="record__head">
        ${pill(VERDICT_PILLS[verdict.state])}
        ${code(unit.unitId)}
        <span class="meta">${escapeHtml(delta)}${measured} · ${escapeHtml(verdict.wallVersion)} · ${escapeHtml(
          verdict.holdoutRevision,
        )}</span>
      </div>
      <p>${escapeHtml(unit.title)}</p>
      ${unknown}
      <p class="meta">holdout ${verdict.holdout.passed}/${verdict.holdout.total} · ${
        unit.attempt === null || unit.attempt.turn === null
          ? 'turn unknown'
          : `turn ${unit.attempt.turn}`
      } · ${escapeHtml(receiptWord)} · visible pass rate ${escapeHtml(
        rateText(verdict.delta.visiblePassRate),
      )} · signed ${escapeHtml(signedWord)} · promotion: ${escapeHtml(
        verdict.promotionBlocked ?? 'signed by you, recorded in the ledger',
      )}</p>
    </li>`;
}

function renderRecentVerdicts(status: StatusV1): string {
  const records = status.units
    .filter((unit) => unit.verdict !== null && unit.state !== 'unknown')
    .sort((a, b) => {
      const left = a.verdict?.createdAt ?? '';
      const right = b.verdict?.createdAt ?? '';
      return left < right ? 1 : left > right ? -1 : 0;
    })
    .slice(0, 5);
  const body =
    records.length === 0
      ? '<p class="meta">no verdicts recorded</p>'
      : `<ul>${records.map((unit) => renderVerdictRecord(unit, unit.verdict as VerdictStatus)).join('')}</ul>`;
  return `
<section aria-labelledby="verdicts-title">
  <h2 id="verdicts-title">RECENT VERDICTS <span class="meta">${records.length}</span></h2>
  ${body}
</section>`;
}

function renderBudget(status: StatusV1): string {
  const budget = status.budget;
  const spent = budget.perDay.spent;
  const reserved = budget.perDay.reserved;
  const committed = (spent ?? 0) + (reserved ?? 0);
  const understated = budget.unknownCount > 0;
  const spentFigure = spent === null ? 'unknown' : estimatedAmount(spent, understated);
  const reservedFigure = reserved === null ? 'unknown' : estimatedAmount(reserved, understated);
  const fraction = budget.perDay.limit > 0 ? committed / budget.perDay.limit : 0;
  const measuredShare = spent === null ? 0 : Math.min(fraction, (spent ?? 0) / budget.perDay.limit);
  const estimatedShare =
    Math.max(0, Math.min(fraction, committed / budget.perDay.limit)) - measuredShare;
  const gap = understated ? `<span class="meter__gap" style="width: 6%"></span>` : '';
  const gapLine = understated
    ? `<p class="meta">gap: spend unknown for ${budget.unknownCount} ${budget.unknownCount === 1 ? 'unit' : 'units'} — spend understated</p>`
    : `<p class="meta">0 units unmeasured</p>`;
  return `
<section aria-labelledby="budget-title">
  <h2 id="budget-title">BUDGET</h2>
  <p><strong>today ${escapeHtml(spentFigure)} of ${formatUsd(budget.perDay.limit)}, estimated</strong></p>
  <p class="meta">per-unit ${formatUsd(budget.perUnit.limit)}, estimated · reserved ${escapeHtml(
    reservedFigure,
  )} estimated · price table ${escapeHtml(budget.priceTableVersion)} · ${escapeHtml(budget.note)}</p>
  <figure class="budget-meter">
    <div class="meter" aria-hidden="true">
      <span class="meter__measured" style="width: ${percent(measuredShare)}"></span>
      <span class="meter__estimated" style="width: ${percent(estimatedShare)}"></span>
      ${gap}
      <span class="meter__headroom"></span>
    </div>
    <figcaption class="meta">${percent(fraction)} estimated${understated ? ' · spend understated' : ''}</figcaption>
  </figure>
  ${gapLine}
</section>`;
}

function renderTaskClasses(status: StatusV1): string {
  const rows = status.health.taskClasses;
  const body =
    rows.length === 0
      ? '<p class="meta">no task class has a verdict yet</p>'
      : `
    <table>
      <thead>
        <tr><th scope="col">class</th><th scope="col">Δ</th><th scope="col">n</th><th scope="col">state</th><th scope="col">escape rate</th></tr>
      </thead>
      <tbody>
        ${rows
          .map(
            (row) => `
        <tr>
          <td>${code(row.class)}</td>
          <td class="num">${escapeHtml(deltaText(row.delta.value))}</td>
          <td class="num">${row.delta.samples}</td>
          <td class="num">${escapeHtml(
            row.delta.state === 'unstable' ? 'unstable (n<5)' : row.delta.state,
          )}</td>
          <td class="num">escape ${escapeHtml(
            row.escapeRate.value === null ? 'unknown' : row.escapeRate.value.toFixed(2),
          )}${row.escapeRate.samples === 0 ? ' (no samples)' : ''}</td>
        </tr>`,
          )
          .join('')}
      </tbody>
    </table>
    <p class="meta">one row per task class; Δ is never blended across classes.</p>`;
  return `
<section aria-labelledby="delta-title">
  <h2 id="delta-title">Δ BY TASK CLASS</h2>
  ${body}
</section>`;
}

function renderFooter(status: StatusV1): string {
  const factory = status.factory;
  return `
<footer>
  <p>factory ${escapeHtml(factory.version)} · wall ${escapeHtml(factory.wallVersion ?? 'unavailable')} · policy ${escapeHtml(
    factory.policyVersion,
  )} · holdout ${escapeHtml(factory.holdoutRevision ?? 'unknown')} · dsh ${escapeHtml(
    factory.dshVersionExpected,
  )} (observed ${escapeHtml(factory.dshVersionObserved ?? 'unknown')}) · ${escapeHtml(
    factory.topology.claim,
  )}</p>
  <p>read-only · loopback + token · no scripts, no external assets, no telemetry · generated ${escapeHtml(
    status.generatedAt,
  )}</p>
</footer>`;
}

// ------------------------------------------------------------------------- page

/** The complete document. Deterministic: same status in, same bytes out. */
export function renderStatusPage(status: StatusV1): string {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex">
<meta http-equiv="refresh" content="10">
<title>factory status</title>
<style>${stylesheet()}</style>
</head>
<body>
${renderHeader(status)}${renderQuarantine(status)}${renderHealth(status)}
<main>
${renderNeedsYou(status)}
${renderWorking(status)}
${renderRecentVerdicts(status)}
${renderBudget(status)}
${renderTaskClasses(status)}
</main>
${renderFooter(status)}
</body>
</html>`;
}

/** The 401 body: names the header and the query parameter, and says nothing else. */
export function renderUnauthorizedHtml(message: string): string {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex">
<title>factory status — unauthorized</title>
<style>${stylesheet()}</style>
</head>
<body>
<header><div><h1>factory status</h1><p class="answer">401 UNAUTHORIZED</p></div></header>
<main>
<section aria-labelledby="auth-title">
  <h2 id="auth-title">TOKEN REQUIRED</h2>
  <p>${escapeHtml(message)}</p>
  <p class="meta">This page is read-only, but it reads the whole factory. It is never served to an unauthenticated caller, including on loopback.</p>
</section>
</main>
</body>
</html>`;
}

/** Rendered when the status object fails `status.v1`: refuse, do not draw a guess. */
export function renderRefusalHtml(problems: readonly string[]): string {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex">
<title>factory status — refusing to render</title>
<style>${stylesheet()}</style>
</head>
<body>
<header><div><h1>factory status</h1><p class="answer">500 NOT RENDERED</p></div></header>
<main>
<section aria-labelledby="refusal-title">
  <h2 id="refusal-title">STATUS FAILED VALIDATION</h2>
  <p>This page will not draw a status object that does not satisfy <code>status.v1</code>. A half-rendered page reads as "fine", which is the one thing it must never do.</p>
  <ul>${problems.map((problem) => `<li class="mono">${escapeHtml(problem)}</li>`).join('')}</ul>
  <p class="meta">Nothing was written. Check the control plane's logs for the store read that produced this object.</p>
</section>
</main>
</body>
</html>`;
}

export function renderNotFoundHtml(path: string): string {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="robots" content="noindex">
<title>factory status — not found</title>
<style>${stylesheet()}</style>
</head>
<body>
<header><div><h1>factory status</h1><p class="answer">404 NOT FOUND</p></div></header>
<main>
<section><h2>NO SUCH ROUTE</h2><p class="mono">${escapeHtml(path)}</p><p class="meta">This surface serves <code>/</code> and <code>/api/status</code>, and nothing else exists.</p></section>
</main>
</body>
</html>`;
}
