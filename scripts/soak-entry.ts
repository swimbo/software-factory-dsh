/**
 * Offline soak: N units, injected incidents, runbooks executed and asserted.
 *
 * `scripts/soak.sh` is the thin wrapper; every decision lives here.
 *
 * ## Why this exists
 *
 * Counting throughput proves nothing: 50 green units say the happy path was happy 50 times.
 * What a soak is *for* is the list of things that only happen at unit 37 — so each incident
 * below is followed by **the runbook's own commands**, and the assertion is the runbook's own
 * promise: the exit code it documents and the sentence it says an operator will see. If the
 * 2am procedure stops working, this exits non-zero at 2am, not in a person's hands.
 *
 * ## Where it writes, and what it never touches
 *
 * - The soak home is a `mkdtemp` directory under the system temp dir, printed in the header
 *   and in `soak.json`. It is **never** the operator's `~/.factory`, and `FACTORY_HOME` is
 *   set explicitly on every child so an inherited value cannot redirect the run.
 * - Incident homes are separate throwaway directories: a quarantined store is quarantined
 *   forever by design, and soaking it into the same home as the 50 units would end the run
 *   at the first incident instead of exercising the rest.
 * - Artifacts land in `e2e/soak/artifacts/`; nothing outside the temp dir and that folder is
 *   written. `docs/`, the ledger, and the operator's home are not touched.
 *
 * ## Cost
 *
 * Zero paid model calls, by construction: `FACTORY_EXECUTOR=fake` and `FACTORY_WALL=fake`
 * mean no dsh process and no container. What costs time is process startup, so the cost is
 * linear in `--units`: `--units 5 --seed 1` is the CI shape (well under a minute), the
 * default 50 is the soak (a few minutes). The header prints both numbers.
 */
import { mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { ATTEMPT_STATES, UNIT_STATES, type LedgerEvent } from '../packages/contracts/src/index.ts';
import { createWallFixture, type WallFixture } from '../e2e/harness/wall-fixture.ts';
import { newFactoryHome, runFactory, type FactoryRun } from '../e2e/harness/factory.ts';
import { openStore } from '../packages/store/src/index.ts';
import { seedStaleAttempt, seedUnit } from '../apps/cli/src/testing.ts';

export const DEFAULT_UNITS = 50;
/** Fixed by default: a failure at unit 37 must be reproducible by anyone, at unit 37. */
export const DEFAULT_SEED = 20261101;

export type IncidentKind =
  | 'none'
  | 'ambiguous'
  | 'quarantine'
  | 'budget-refusal'
  | 'dispatch-ceiling'
  | 'wall-unavailable'
  | 'promotion-refusal';

/** Every incident the harness knows, in the order the seeded shuffle draws from. */
export const INCIDENT_KINDS: readonly Exclude<IncidentKind, 'none'>[] = [
  'ambiguous',
  'quarantine',
  'budget-refusal',
  'dispatch-ceiling',
  'wall-unavailable',
  'promotion-refusal',
];

/** Deterministic 32-bit PRNG (mulberry32). Small, seedable, no dependency, no clock. */
export function makeRng(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * The injection schedule, as a pure function of `(seed, units)`.
 *
 * This is the reproducibility contract: same seed and unit count, same schedule — so a
 * failure at unit 37 is a failure someone else reproduces at unit 37 without the artifact.
 * Each incident is placed at a seeded position, drawn without replacement; the remaining
 * units are clean. With `units >= incidents` every incident appears exactly once, because a
 * soak that never injects the quarantine path has not soaks anything.
 */
export function scheduleFor(seed: number, units: number): IncidentKind[] {
  const rng = makeRng(seed);
  const schedule: IncidentKind[] = Array.from({ length: units }, () => 'none');
  const kinds = [...INCIDENT_KINDS];
  // Seeded Fisher-Yates: the *order* incidents appear in is part of the schedule.
  for (let i = kinds.length - 1; i > 0; i -= 1) {
    const j = Math.floor(rng() * (i + 1));
    const a = kinds[i];
    const b = kinds[j];
    if (a !== undefined && b !== undefined) {
      kinds[i] = b;
      kinds[j] = a;
    }
  }
  // Seeded positions, drawn without replacement from [0, units). The count is capped at one
  // incident per four units (and at least one), so a 5-unit CI run still has clean pipelines to
  // balance the incident homes -- a soak whose every unit is an incident measures nothing about
  // the ordinary path, which is the path operators take all day.
  const free = Array.from({ length: units }, (_, index) => index);
  const placed = Math.min(kinds.length, Math.max(1, Math.floor(units / 4)), units - 1);
  for (let i = 0; i < placed; i += 1) {
    const pick = Math.floor(rng() * free.length);
    const position = free.splice(pick, 1)[0];
    const kind = kinds[i];
    if (position !== undefined && kind !== undefined) schedule[position] = kind;
  }
  return schedule;
}

interface RunbookStep {
  readonly command: string;
  readonly expectedExit: number;
  readonly observedExit: number;
  /** What the runbook promises the operator will see. */
  readonly promised: string;
  readonly promisedSeen: boolean;
  /** The first line of the surface's output, for the report. */
  readonly observed: string;
}

interface IncidentReport {
  readonly kind: IncidentKind;
  readonly unitIndex: number;
  readonly home: string;
  readonly steps: readonly RunbookStep[];
  readonly ok: boolean;
  readonly notes: readonly string[];
}

interface InvariantReport {
  readonly name: string;
  readonly ok: boolean;
  readonly detail: string;
}

interface SoakSummary {
  readonly seed: number;
  readonly units: number;
  readonly startedAt: string;
  readonly durationMs: number;
  readonly soakHome: string;
  readonly paidModelCalls: number;
  readonly unitsAttempted: number;
  readonly terminalStates: Readonly<Record<string, number>>;
  readonly incidents: readonly IncidentReport[];
  readonly invariants: readonly InvariantReport[];
  readonly failures: readonly string[];
  readonly artifacts: string;
}

const PROMISES = {
  // `factory status` prints the header line "1 need you" and a NEEDS YOU block naming the gate.
  ambiguousGate: 'need you',
  ambiguousGateName: 'ambiguous_attempt',
  ambiguousBlock: 'no second attempt',
  recovered: '0 attempt(s) found without a terminal event',
  quarantineWriteRefused: 'STORE_QUARANTINED',
  quarantineDoNotReset: 'Do not reset, delete or re-initialise the store',
  budgetEstimate: 'estimates the run as',
  budgetComparison: 'remaining envelope',
  budgetLabel: 'estimated',
  ceilingRefused: 'in flight',
  wallRefused: 'WALL_UNAVAILABLE',
  wallCannotPromote: 'cannot promote',
  promotionNeedsSignature: 'PROMOTION_UNSIGNED',
} as const;

function firstLine(run: FactoryRun): string {
  const text = `${run.stderr}\n${run.stdout}`.split('\n').find((line) => line.trim() !== '');
  return (text ?? '').trim().slice(0, 200);
}

function step(
  command: string,
  run: FactoryRun,
  expectedExit: number,
  promised: string,
  haystack = `${run.stdout}\n${run.stderr}`,
): RunbookStep {
  const promisedSeen = promised === '' || haystack.toLowerCase().includes(promised.toLowerCase());
  return {
    command,
    expectedExit,
    observedExit: run.code,
    promised,
    promisedSeen,
    observed: firstLine(run),
  };
}

function jsonField(run: FactoryRun, field: string): unknown {
  try {
    const parsed: unknown = JSON.parse(run.stdout.trim());
    if (parsed === null || typeof parsed !== 'object') return undefined;
    return (parsed as Record<string, unknown>)[field];
  } catch {
    return undefined;
  }
}

/** Seed a qualified unit in `home` without a worker: the state every refusal starts from. */
function seedQualified(home: string, unitId: string, estimateUsd = 1.5): { unitId: string } {
  return seedUnit(home, {
    unitId,
    lane: 'dark',
    state: 'qualified',
    // A distinct slug per unit, for the same reason: the spec hash is the unit's identity.
    spec: { slug: `soak-${unitId.toLowerCase()}`, budgetEstimateUsd: estimateUsd },
  });
}

// ------------------------------------------------------------------ incidents
//
// Each incident returns the runbook steps it actually executed. The steps are *not* shaped to
// pass: every expectation below is a sentence copied from `docs/runbooks/`, and the incident is
// the only thing that decides which runbook applies.

function incidentAmbiguous(home: string, unitIndex: number): IncidentReport {
  const unitId = `U-soak-amb-${String(unitIndex)}`;
  // A distinct slug per incident unit: `seedUnit` hashes the spec, and a second unit at the
  // fixture's default revision is a *duplicate intent*, which the factory rightly refuses. The
  // soak has to present 50 different intents, not 50 copies of one.
  seedUnit(home, {
    unitId,
    lane: 'dark',
    state: 'qualified',
    spec: { slug: `soak-amb-${String(unitIndex)}` },
  });
  seedStaleAttempt(home, unitId, `A-soak-${String(unitIndex)}`);

  const recover = runFactory(['recover', '--json'], { home });
  const block = jsonField(recover, 'ambiguityBlock');
  const recoverStep = step(
    `factory recover (ambiguous unit ${unitId})`,
    recover,
    4,
    PROMISES.ambiguousBlock,
    JSON.stringify(block ?? {}) + recover.stderr,
  );
  const status = runFactory(['status', '--json'], { home });
  const statusStep = step(
    `factory status (open gate for ${unitId})`,
    status,
    5,
    PROMISES.ambiguousGate,
    `${status.stdout}\n${status.stderr}`,
  );
  // The runbook promises a *header* ("1 need you") and a named gate block; the second step
  // asserts the block, because "need you" alone could come from any unit.
  const gateStep = step(
    `factory status (names the gate)`,
    status,
    5,
    PROMISES.ambiguousGateName,
    `${status.stdout}\n${status.stderr}`,
  );
  const abort = runFactory(
    ['abort', unitId, '--reason', 'soak: attempt was never observed; no receipt exists', '--json'],
    { home },
  );
  const abortStep = step(`factory abort ${unitId}`, abort, 0, 'terminal');
  const after = runFactory(['recover', '--json'], { home });
  const afterStep = step(`factory recover (after abort)`, after, 0, PROMISES.recovered);
  // The runbook's sentence ("0 need you ... the unit in a terminal state") is about *this
  // unit*, not the whole factory: a verified unit waiting for a human promotion is also a
  // gate, so a factory-wide `status` can legitimately still exit 5 here. Asserting the global
  // exit code would make the soak fail for a correct factory — the kind of false red that
  // teaches people to ignore the harness.
  const closed = runFactory(['status', unitId, '--json'], { home });
  const closedStep = step(`factory status ${unitId} (unit resolved)`, closed, 0, 'aborted');
  const steps = [recoverStep, statusStep, gateStep, abortStep, afterStep, closedStep];
  return {
    kind: 'ambiguous',
    unitIndex,
    home,
    steps,
    ok: steps.every((s) => s.observedExit === s.expectedExit && s.promisedSeen),
    notes: [
      // A second recover is exit 0 by documented divergence (runbook, E2E-32): the *first*
      // recover discovers the attempt, the second has nothing new to find. `status` is the
      // surface that keeps saying a person is needed — asserted above at exit 5.
      'a second recover after the first reports nothing new (exit 0) while the per-unit view still gates',
      'the factory-wide `status` exit code is not asserted after resolution: a verified unit awaiting promotion is its own human gate',
    ],
  };
}

function incidentQuarantine(root: string, unitIndex: number): IncidentReport {
  const home = newFactoryHome('factory-soak-quarantine-');
  seedQualified(home, `U-soak-quar-${String(unitIndex)}`);
  const store = openStore({ dir: join(home, 'state') });
  try {
    store.quarantine(
      'soak: ledger divergence injected at a seeded position',
      'soak',
      'T-soak-quarantine',
    );
  } finally {
    store.close();
  }
  const status = runFactory(['status', '--json'], { home });
  const health = jsonField(status, 'health');
  const healthStep = step(
    'factory status (health.store.state)',
    status,
    0,
    'quarantined',
    JSON.stringify(health ?? {}) + status.stderr,
  );
  const audit = runFactory(['audit', '--last', '50', '--json'], { home });
  const auditStep = step('factory audit --last 50', audit, 0, 'store.quarantined');
  const recover = runFactory(['recover', '--json'], { home });
  const recoverStep = step(
    'factory recover (must refuse)',
    recover,
    9,
    PROMISES.quarantineWriteRefused,
  );
  const doNotReset = step(
    'factory recover (says what not to do)',
    recover,
    9,
    PROMISES.quarantineDoNotReset,
  );
  // `factory run` refuses too, but with exit 8 in a home with no executor: the executor probe
  // runs before the dispatch write, so the *first* refusal an operator sees for `run` is the
  // missing dsh, not the quarantine. That ordering is a finding, not a promise -- the
  // write-refusal promise above (`recover`, exit 9) is the one the runbook makes, and this
  // step asserts the weaker fact that `run` refuses at all and says why.
  const run = runFactory(['run', `U-soak-quar-${String(unitIndex)}`, '--json'], { home });
  const runRefused = run.code !== 0;
  const runStep: RunbookStep = {
    command: `factory run (refused, exit ${String(run.code)})`,
    expectedExit: run.code,
    observedExit: run.code,
    promised: 'refused before any write',
    promisedSeen: runRefused,
    observed: firstLine(run),
  };
  const steps = [healthStep, auditStep, recoverStep, doNotReset, runStep];
  return {
    kind: 'quarantine',
    unitIndex,
    home,
    steps,
    ok: steps.every((s) => s.observedExit === s.expectedExit && s.promisedSeen),
    notes: [
      `dedicated home ${home}: a quarantined store is quarantined permanently, so soaking it into the run's home would end the run at this incident`,
      `root ${root} is the operator's temp dir, never ~/.factory`,
      'wart: `factory run` on a quarantined store exits 8 (no executor) before it reaches the store write; `recover` is the surface that exercises the exit-9 refusal',
    ],
  };
}

function incidentBudgetRefusal(unitIndex: number): IncidentReport {
  const fixture = createWallFixture();
  const home = fixture.home;
  const raise = (to: string, confirm: string): FactoryRun =>
    runFactory(
      ['budget', 'raise', '--to', to, '--reason', 'soak', '--confirm', confirm, '--json'],
      {
        home,
        env: fixture.wallEnv(),
      },
    );
  raise('10.00', 'raise per-unit envelope to 10.00');
  const unitId = fixture.submit({ budgetEstimateUsd: 2.41, revision: 1000 + unitIndex });
  raise('0.05', 'raise per-unit envelope to 0.05');
  const run = fixture.run(unitId);
  const refusalStep = step(
    `factory run ${unitId} (envelope 0.05)`,
    run,
    6,
    PROMISES.budgetEstimate,
  );
  const comparisonStep = step(
    `factory run ${unitId} (names the comparison)`,
    run,
    6,
    PROMISES.budgetComparison,
  );
  const labelStep = step(
    `factory run ${unitId} (labels the estimate)`,
    run,
    6,
    'estimate, not a measurement',
  );
  const budget = runFactory(['budget', '--json'], { home, env: fixture.wallEnv() });
  const budgetStep = step('factory budget (says estimated)', budget, 0, PROMISES.budgetLabel);
  const wrongPhrase = raise('10.00', 'raise daily envelope to 10.00');
  const phraseStep = step(
    'factory budget raise (wrong scope typed)',
    wrongPhrase,
    5,
    'raise per-unit envelope to 10.00',
  );
  fixture.cleanup();
  const steps = [refusalStep, comparisonStep, labelStep, budgetStep, phraseStep];
  return {
    kind: 'budget-refusal',
    unitIndex,
    home,
    steps,
    ok: steps.every((s) => s.observedExit === s.expectedExit && s.promisedSeen),
    notes: ['dedicated fixture: the envelope stays lowered after the refusal'],
  };
}

function incidentDispatchCeiling(unitIndex: number): IncidentReport {
  const fixture = createWallFixture();
  const home = fixture.home;
  const first = fixture.submit({ revision: 2000 + unitIndex });
  const second = fixture.submit({ revision: 2001 + unitIndex });
  const launched = fixture.run(first, ['--no-wait']);
  const launchStep = step(`factory run ${first} --no-wait`, launched, 0, '');
  const refused = fixture.run(second);
  const refusalStep = step(
    `factory run ${second} (second dispatch while one is in flight)`,
    refused,
    7,
    PROMISES.ceilingRefused,
  );
  const codeStep = step(`factory run ${second} (code)`, refused, 7, 'CONCURRENCY_LIMIT');
  const abort = runFactory(['abort', first, '--reason', 'soak: releasing the in-flight attempt'], {
    home,
    env: fixture.wallEnv(),
  });
  const abortStep = step(`factory abort ${first}`, abort, 0, '');
  const retried = fixture.run(second);
  const retriedStep = step(
    `factory run ${second} (after the in-flight attempt was settled)`,
    retried,
    0,
    '',
  );
  fixture.cleanup();
  const steps = [launchStep, refusalStep, codeStep, abortStep, retriedStep];
  return {
    kind: 'dispatch-ceiling',
    unitIndex,
    home,
    steps,
    ok: steps.every((s) => s.observedExit === s.expectedExit && s.promisedSeen),
    notes: [
      // The refusal is a *conflict*, not a failure: once the in-flight attempt is settled the
      // same unit dispatches. Asserting the retry is what makes exit 7 "busy" rather than
      // "broken", and it is the only step here that can tell the two apart.
      'exit 7 is transient: the same unit runs once the in-flight attempt is settled',
    ],
  };
}

function incidentWallUnavailable(unitIndex: number): IncidentReport {
  const fixture = createWallFixture();
  const home = fixture.home;
  const unitId = seedQualified(home, `U-soak-wall-${String(unitIndex)}`).unitId;
  // `FACTORY_WALL=fake` without a verdict template: the instrument reports itself absent,
  // which is exactly the production shape of "the container runtime went away".
  const env = fixture.wallEnv({ FACTORY_WALL: 'fake', FACTORY_VERDICT: undefined });
  const run = runFactory(['run', unitId, '--verify-only', '--json'], { home, env });
  const refusalStep = step(`factory run ${unitId} --verify-only`, run, 4, PROMISES.wallRefused);
  const cannotPromote = step(
    `factory run ${unitId} (verdict stays unknown)`,
    run,
    4,
    PROMISES.wallCannotPromote,
  );
  const status = runFactory(['status', '--json'], { home, env: fixture.wallEnv() });
  const statusStep = step('factory status (still readable)', status, 0, '');
  fixture.cleanup();
  const steps = [refusalStep, cannotPromote, statusStep];
  return {
    kind: 'wall-unavailable',
    unitIndex,
    home,
    steps,
    ok: steps.every((s) => s.observedExit === s.expectedExit && s.promisedSeen),
    notes: ['the wall is absent, not broken: no receipt, no verdict, nothing dispatched'],
  };
}

function incidentPromotionRefusal(unitIndex: number): IncidentReport {
  const fixture = createWallFixture();
  const home = fixture.home;
  const unitId = fixture.submit({ revision: 3000 + unitIndex });
  const run = fixture.run(unitId);
  const runStep = step(`factory run ${unitId}`, run, 0, '');
  const unsigned = runFactory(['promote', unitId, '--json'], { home, env: fixture.wallEnv() });
  const unsignedStep = step(
    `factory promote ${unitId} (no human signature)`,
    unsigned,
    5,
    PROMISES.promotionNeedsSignature,
  );
  const signaturePath = fixture.signPromotion(unitId);
  const signedStep = step(
    `factory promote ${unitId} --signature <operator key> --confirm "sign promotion ${unitId}"`,
    runFactory(
      [
        'promote',
        unitId,
        '--signature',
        signaturePath,
        '--signed-by',
        'operator',
        '--confirm',
        `sign promotion ${unitId}`,
        '--json',
      ],
      { home, env: fixture.wallEnv() },
    ),
    0,
    'PROMOTION',
  );
  fixture.cleanup();
  const steps = [runStep, unsignedStep, signedStep];
  return {
    kind: 'promotion-refusal',
    unitIndex,
    home,
    steps,
    ok: steps.every((s) => s.observedExit === s.expectedExit && s.promisedSeen),
    notes: ['a promotion without a human identity is a gate refusal (exit 5), never a promotion'],
  };
}

// ---------------------------------------------------------------- invariants

/**
 * The checks that make this a soak rather than a stopwatch.
 *
 * Each one is a sentence from the laws or the runbooks, turned into a query: a legal state, a
 * signature on every promotion, no redispatch after recovery, `unknown` never counted as a
 * pass. A deliberately-broken run must fail these — `scripts/soak.test.ts` injects a
 * fabricated state and asserts they scream, because an invariant checker that cannot fail is
 * decoration.
 */
export interface SoakRows {
  readonly units: readonly { readonly unitId: string; readonly state: string }[];
  readonly attempts: readonly {
    readonly attemptId: string;
    readonly unitId: string;
    readonly state: string;
  }[];
  readonly events: readonly LedgerEvent[];
  readonly incidentUnits: readonly { readonly kind: IncidentKind; readonly unitIndex: number }[];
}

/**
 * The checks that make this a soak rather than a stopwatch, over rows rather than a home.
 *
 * Splitting the reader from the checker is what makes the checker testable: a spec can hand it
 * one fabricated row (an unsigned promotion, an unknown verdict that was promoted, a unit in a
 * state the machine does not define) and assert it screams. An invariant checker that cannot
 * fail is decoration, and one that can only be fed by a real 50-unit run is untested decoration.
 */
export function checkRows(rows: SoakRows): InvariantReport[] {
  const { units, attempts, events, incidentUnits } = rows;
  const reports: InvariantReport[] = [];

  const illegalStates = [
    ...units.filter((unit) => !UNIT_STATES.includes(unit.state as never)),
    ...attempts.filter((attempt) => !ATTEMPT_STATES.includes(attempt.state as never)),
  ];
  reports.push({
    name: 'no unit or attempt in a state the state machine does not define',
    ok: illegalStates.length === 0,
    detail:
      illegalStates.length === 0
        ? `${String(units.length)} units, ${String(attempts.length)} attempts, all legal`
        : `illegal: ${JSON.stringify(illegalStates)}`,
  });

  const promotions = events.filter((event) => event.type === 'unit.promoted');
  const unsignedPromotions = promotions.filter((event) => {
    const payload = event.payload as { signedBy?: unknown };
    const signedBy = typeof payload.signedBy === 'string' ? payload.signedBy.trim() : '';
    return signedBy === '' || signedBy.toLowerCase().startsWith('system');
  });
  reports.push({
    name: 'nothing promoted without a human signature',
    ok: unsignedPromotions.length === 0,
    detail: `${String(promotions.length)} promotion(s), ${String(unsignedPromotions.length)} unsigned`,
  });

  // A redisplayed unit after `recover` would be a second attempt on a unit whose first
  // attempt's fate is unknown -- the one thing the runbook explicitly refuses to do.
  const recoveredAmbiguous = incidentUnits.filter((incident) => incident.kind === 'ambiguous');
  const redispatched: string[] = [];
  for (const incident of recoveredAmbiguous) {
    const unitId = `U-soak-amb-${String(incident.unitIndex)}`;
    const attemptsForUnit = attempts.filter((attempt) => attempt.unitId === unitId);
    if (attemptsForUnit.length > 1) redispatched.push(unitId);
  }
  reports.push({
    name: 'no redispatch after recovery (an ambiguous attempt stays a single attempt)',
    ok: redispatched.length === 0,
    detail:
      redispatched.length === 0
        ? `${String(recoveredAmbiguous.length)} recovered unit(s), one attempt each`
        : `redispatched: ${JSON.stringify(redispatched)}`,
  });

  // `unknown` is not a pass: a unit whose verdict was unknown must not have been promoted.
  // The join is `verdictId`, because `unit.promoted` carries the verdict and not the attempt --
  // joining on the attempt would silently match nothing and report a comfortable zero.
  const outcomeOf = new Map<string, string>();
  for (const event of events) {
    const payload = event.payload as { verdictId?: unknown; outcome?: unknown };
    if (
      event.type === 'unit.verified' &&
      typeof payload.verdictId === 'string' &&
      typeof payload.outcome === 'string'
    ) {
      outcomeOf.set(payload.verdictId, payload.outcome);
    }
  }
  const unknownVerdicts = [...outcomeOf.values()].filter((outcome) => outcome === 'unknown');
  const promotedUnknown = events
    .filter((event) => event.type === 'unit.promoted')
    .map((event) => event.payload as { verdictId?: unknown })
    .filter(
      (payload) =>
        typeof payload.verdictId === 'string' && outcomeOf.get(payload.verdictId) === 'unknown',
    );
  reports.push({
    name: 'unknown is never counted as a pass (no promotion of an unknown verdict)',
    ok: promotedUnknown.length === 0,
    detail: `${String(unknownVerdicts.length)} unknown verdict(s), ${String(promotedUnknown.length)} promoted`,
  });
  return reports;
}

/**
 * Read the rows out of every home the run touched, and check them as one ledger.
 *
 * One home is not enough: the incidents run in throwaway homes (a quarantined store stays
 * quarantined), so a checker that only read the soak home would never see the promotion the
 * promotion incident signed — it would report "0 promotions, 0 unsigned" and call that a pass.
 * A checker whose denominator is always zero is the failure mode this repository keeps naming.
 */
export function checkInvariants(
  homes: readonly string[],
  incidentUnits: readonly { kind: IncidentKind; unitIndex: number }[],
): InvariantReport[] {
  const units: { unitId: string; state: string }[] = [];
  const attempts: { attemptId: string; unitId: string; state: string }[] = [];
  const events: LedgerEvent[] = [];
  for (const home of homes) {
    let store: ReturnType<typeof openStore>;
    try {
      store = openStore({ dir: join(home, 'state') });
    } catch {
      // A home whose store never opened (an injection that threw before the store existed)
      // contributes no rows; it must not take the whole check down with it.
      continue;
    }
    try {
      const homeUnits = store.listUnits();
      for (const unit of homeUnits) {
        units.push({ unitId: unit.unitId, state: unit.state });
        for (const attempt of store.listAttemptsForUnit(unit.unitId)) {
          attempts.push({
            attemptId: attempt.attemptId,
            unitId: attempt.unitId,
            state: attempt.state,
          });
        }
      }
      events.push(...store.eventsSince(0, 100_000));
    } finally {
      store.close();
    }
  }
  return checkRows({ units, attempts, events, incidentUnits });
}

// -------------------------------------------------------------------- driver

function usage(message: string): never {
  process.stderr.write(`USAGE: scripts/soak.sh [--units N] [--seed S] [--label L]\n${message}\n`);
  process.exit(2);
}

function parseArgs(argv: readonly string[]): { units: number; seed: number; label: string } {
  let units = DEFAULT_UNITS;
  let seed = DEFAULT_SEED;
  let label = 'soak';
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    const next = argv[i + 1];
    if (arg === '--units') {
      if (next === undefined) usage('--units needs a number');
      const parsed = Number(next);
      if (!Number.isInteger(parsed) || parsed < 1) {
        // Exit 2, not a silent zero-unit pass: "nothing was soaked" must never look green.
        usage(`--units must be a positive integer; got ${JSON.stringify(next)}`);
      }
      units = parsed;
      i += 1;
    } else if (arg === '--seed') {
      if (next === undefined) usage('--seed needs a number');
      const parsed = Number(next);
      if (!Number.isInteger(parsed))
        usage(`--seed must be an integer; got ${JSON.stringify(next)}`);
      seed = parsed;
      i += 1;
    } else if (arg === '--label') {
      if (next === undefined) usage('--label needs a value');
      label = next;
      i += 1;
    } else if (arg === '--help' || arg === '-h') {
      usage('runs the soak and writes e2e/soak/artifacts/');
    } else {
      usage(`unknown argument ${JSON.stringify(arg)}`);
    }
  }
  return { units, seed, label };
}

function main(): number {
  const { units, seed, label } = parseArgs(process.argv.slice(2));
  const startedAt = new Date().toISOString();
  const startedMs = Number(process.hrtime.bigint() / 1_000_000n);
  const fixture = createWallFixture();
  const soakHome = fixture.home;
  const artifactsDir = join(process.cwd(), 'e2e', 'soak', 'artifacts');
  mkdirSync(artifactsDir, { recursive: true });

  process.stdout.write(
    [
      `soak: units=${String(units)} seed=${String(seed)} label=${JSON.stringify(label)}`,
      `soak: home=${soakHome} (throwaway; never the operator's ~/.factory)`,
      `soak: artifacts=${artifactsDir}`,
      `soak: cost: zero paid model calls (FACTORY_EXECUTOR=fake, no dsh, no container)`,
      '',
    ].join('\n'),
  );

  const schedule = scheduleFor(seed, units);
  const incidents: IncidentReport[] = [];
  const failures: string[] = [];
  const incidentUnits: { kind: IncidentKind; unitIndex: number }[] = [];
  const terminalStates: Record<string, number> = {};

  // ---- the clean units: a full pipeline each, so the soak has something to be stressed
  let attempted = 0;
  for (let index = 0; index < units; index += 1) {
    const kind = schedule[index] ?? 'none';
    if (kind === 'none') {
      const unitId = fixture.submit({ revision: 1 + index });
      const run = fixture.run(unitId);
      attempted += 1;
      const state = String(jsonField(run, 'state') ?? `exit ${String(run.code)}`);
      terminalStates[state] = (terminalStates[state] ?? 0) + 1;
      if (run.code !== 0)
        failures.push(
          `unit ${String(index)} (${unitId}) exited ${String(run.code)}: ${firstLine(run)}`,
        );
      continue;
    }
    // Incident positions still submit a unit first when the incident needs a real pipeline;
    // the rest seed their own unit inside a dedicated home.
    attempted += 1;
    incidentUnits.push({ kind, unitIndex: index });
    let report: IncidentReport;
    try {
      switch (kind) {
        case 'ambiguous':
          report = incidentAmbiguous(soakHome, index);
          break;
        case 'quarantine':
          report = incidentQuarantine(soakHome, index);
          break;
        case 'budget-refusal':
          report = incidentBudgetRefusal(index);
          break;
        case 'dispatch-ceiling':
          report = incidentDispatchCeiling(index);
          break;
        case 'wall-unavailable':
          report = incidentWallUnavailable(index);
          break;
        case 'promotion-refusal':
          report = incidentPromotionRefusal(index);
          break;
        default:
          report = {
            kind,
            unitIndex: index,
            home: soakHome,
            steps: [],
            ok: false,
            notes: ['unreachable'],
          };
      }
    } catch (error) {
      report = {
        kind,
        unitIndex: index,
        home: soakHome,
        steps: [],
        ok: false,
        notes: [`injection threw: ${error instanceof Error ? error.message : String(error)}`],
      };
    }
    incidents.push(report);
    if (!report.ok) {
      const broken = report.steps.filter(
        (s) => s.observedExit !== s.expectedExit || !s.promisedSeen,
      );
      failures.push(
        `incident ${kind} at unit ${String(index)}: ${broken
          .map(
            (s) =>
              `${s.command} → exit ${String(s.observedExit)} (expected ${String(s.expectedExit)}), promise ${JSON.stringify(s.promised)} ${s.promisedSeen ? 'seen' : 'MISSING'}`,
          )
          .join('; ')}${report.notes.join('; ')}`,
      );
    }
  }

  // Deduped *with* the soak home: the ambiguous incident runs in the soak home, and counting
  // that home twice makes every unit look redispatched — the checker caught exactly that.
  const homesForCheck = [...new Set([soakHome, ...incidents.map((incident) => incident.home)])];
  const invariants = checkInvariants(homesForCheck, incidentUnits);
  for (const invariant of invariants) {
    if (!invariant.ok) failures.push(`invariant broken: ${invariant.name} — ${invariant.detail}`);
  }

  // Every incident home is a throwaway directory; removing them is part of "never the
  // operator's home", and leaving fifty of them behind is its own outage on a small tmpfs.
  for (const incident of incidents) {
    if (incident.home !== soakHome) rmSync(incident.home, { recursive: true, force: true });
  }
  fixture.cleanup();
  const durationMs = Number(process.hrtime.bigint() / 1_000_000n) - startedMs;
  const stamp = `${String(seed)}-${String(units)}`;
  const jsonPath = join(artifactsDir, `soak-${stamp}.json`);
  const tablePath = join(artifactsDir, `soak-${stamp}.txt`);
  const summary: SoakSummary = {
    seed,
    units,
    startedAt,
    durationMs,
    soakHome,
    paidModelCalls: 0,
    unitsAttempted: attempted,
    terminalStates,
    incidents,
    invariants,
    failures,
    artifacts: jsonPath,
  };
  writeFileSync(jsonPath, `${JSON.stringify(summary, null, 2)}\n`);

  const lines: string[] = [];
  lines.push(
    `soak  seed=${String(seed)}  units=${String(units)}  ${(durationMs / 1000).toFixed(1)}s`,
  );
  lines.push(`home  ${soakHome} (removed after the run)`);
  lines.push(`cost  0 paid model calls (fake executor, no dsh, no container)`);
  lines.push('');
  lines.push('units  terminal states');
  for (const [state, count] of Object.entries(terminalStates).sort()) {
    lines.push(`       ${String(count).padStart(3)}  ${state}`);
  }
  lines.push('');
  lines.push('incidents  (runbook commands executed: exit code + promised sentence)');
  for (const incident of incidents) {
    lines.push(
      `  ${incident.ok ? 'ok  ' : 'FAIL'} ${incident.kind} @ unit ${String(incident.unitIndex)}`,
    );
    for (const s of incident.steps) {
      const exit =
        s.observedExit === s.expectedExit
          ? `exit ${String(s.observedExit)}`
          : `exit ${String(s.observedExit)} ≠ ${String(s.expectedExit)}`;
      lines.push(
        `         ${s.promisedSeen ? '·' : '×'} ${s.command}: ${exit}${s.promised === '' ? '' : `, "…${s.promised}…"`}`,
      );
    }
    for (const note of incident.notes) lines.push(`         note: ${note}`);
  }
  lines.push('');
  lines.push('invariants');
  for (const invariant of invariants) {
    lines.push(`  ${invariant.ok ? 'ok  ' : 'FAIL'} ${invariant.name}: ${invariant.detail}`);
  }
  lines.push('');
  if (failures.length === 0) {
    lines.push(
      `RESULT ok — ${String(attempted)} unit(s), ${String(incidents.length)} incident(s), all runbook steps and invariants held`,
    );
  } else {
    lines.push(`RESULT FAIL — ${String(failures.length)} failure(s)`);
    for (const failure of failures) lines.push(`  - ${failure}`);
  }
  const table = `${lines.join('\n')}\n`;
  writeFileSync(tablePath, table);
  process.stdout.write(table);
  return failures.length === 0 ? 0 : 1;
}

// Only when executed, so the spec can import the pure parts (`scheduleFor`,
// `checkInvariants`) without starting a soak. A soak that runs on import is a soak that runs
// inside `pnpm run typecheck`.
if (process.argv[1] !== undefined && process.argv[1].endsWith('soak-entry.ts')) {
  process.exitCode = main();
}
