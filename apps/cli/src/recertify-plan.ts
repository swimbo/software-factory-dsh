/**
 * What re-certifying a class would cost, and whether anything is allowed to spend it.
 *
 * This is the free half of "scheduled re-certification". The detection half has shipped for a while —
 * `factory alerts` emits `CERT_STALE`/`CERT_NEVER` every night and names the driver — but the nightly
 * job can only *tell* a person. A job that also spent would be the first component in this system to
 * spend without one, so the spend is gated on a number the operator sets **per class**: the measured
 * cost of the same-shaped classes differs 10× (186,787 tokens for `docs-typo-fix` against 1,944,675
 * for `type-repair`), and a single global cap would either starve the cheap class or let the
 * expensive one run unbounded.
 *
 * ## L3 applies to the budget too
 *
 * An estimate that cannot be measured is `unknown`, and `unknown` never authorises a spend. So a
 * class with no measured attempts behind it is refused (`refused-unknown-estimate`) rather than
 * spent against a guess — the same rule as every other gate in this system, applied to money.
 *
 * ## The decisions, named
 *
 * - `not-due` — the class is current; nothing to do.
 * - `would-spend` — due, a budget covers the measured projection, and (when a units file is
 *   required) one exists. This is the only decision that permits a spend.
 * - `refused-no-budget` — due, but no budget was set for this class. The default state: the job
 *   reports and exits 9, and nothing is spent.
 * - `refused-unknown-estimate` — due, but no measured attempt gives a cost. A guess is not a budget.
 * - `refused-over-budget` — the measured projection exceeds the class budget.
 * - `refused-no-units` — a budget exists but the pre-submitted unit list the driver needs does not.
 */

/** One class's re-certification state, as `factory audit --certifications` reports it. */
export interface RecertifyDueClass {
  readonly taskClass: string;
  /** `current` classes are not due; the two others are. */
  readonly state: 'current' | 'stale' | 'never-certified';
  /** Judged attempts behind the newest certificate, or `0` when no certificate exists. */
  readonly samples: number;
  readonly m: number;
}

export type RecertifyDecision =
  | 'not-due'
  | 'would-spend'
  | 'refused-no-budget'
  | 'refused-unknown-estimate'
  | 'refused-over-budget'
  | 'refused-no-units';

export interface RecertifyPlanEntry {
  readonly taskClass: string;
  readonly state: RecertifyDueClass['state'];
  readonly samples: number;
  readonly m: number;
  /** Judged attempts still needed to reach `m`. */
  readonly remaining: number;
  /** Where the per-attempt cost came from, and what it was. */
  readonly estimate: {
    readonly basis: 'measured' | 'unknown';
    readonly medianTokensPerAttempt: number | null;
    readonly measuredAttempts: number;
    readonly projectedTokens: number | null;
  };
  readonly budgetTokens: number | null;
  readonly unitsFile: string | null;
  readonly decision: RecertifyDecision;
  readonly reason: string;
}

/**
 * Parse `FACTORY_RECERTIFY_BUDGET_TOKENS` — `class=tokens` pairs, comma- or whitespace-separated.
 *
 * A malformed entry is a usage error rather than a silently dropped budget: a typo that quietly
 * removes a cap is a budget that lets a class spend. Callers get `null` for "not configured" and a
 * `FactoryError` for "configured wrongly"; there is no third state that means "spend anyway".
 */
export function parseRecertifyBudgets(
  raw: string | undefined,
  fail: (message: string) => never,
): Map<string, number> {
  const budgets = new Map<string, number>();
  const text = (raw ?? '').trim();
  if (text === '') return budgets;
  for (const part of text.split(/[\s,]+/).filter((item) => item !== '')) {
    const match = /^([^=]+)=([0-9]+)$/.exec(part);
    if (match === null) {
      fail(
        `FACTORY_RECERTIFY_BUDGET_TOKENS entry "${part}" is not <task-class>=<tokens>; ` +
          'a malformed cap would silently drop a budget, so this is refused rather than skipped',
      );
    }
    const taskClass = (match[1] ?? '').trim();
    const tokens = Number(match[2] ?? '');
    if (taskClass === '' || !Number.isSafeInteger(tokens) || tokens <= 0) {
      fail(
        `FACTORY_RECERTIFY_BUDGET_TOKENS entry "${part}" must name a class and a positive integer ` +
          'token budget',
      );
    }
    budgets.set(taskClass, tokens);
  }
  return budgets;
}

/** The middle value, or the mean of the two middle values — the same median the evidence files quote. */
export function median(values: readonly number[]): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  if (sorted.length % 2 === 1) return sorted[middle] ?? null;
  const lower = sorted[middle - 1] ?? 0;
  const upper = sorted[middle] ?? 0;
  return Math.round((lower + upper) / 2);
}

/**
 * Plan re-certification for every class.
 *
 * `tokensByTaskClass` is what the store actually measured: one total (in + out) per judged attempt,
 * drawn from the usage facts behind that class's certificates. `unitsFiles` maps a class to the
 * pre-submitted unit list the driver would run, or `null` when none exists.
 */
export function planRecertification(input: {
  readonly classes: readonly RecertifyDueClass[];
  readonly budgets: ReadonlyMap<string, number>;
  readonly tokensByTaskClass: ReadonlyMap<string, readonly number[]>;
  readonly unitsFiles: ReadonlyMap<string, string | null>;
}): readonly RecertifyPlanEntry[] {
  return input.classes.map((entry) => {
    const remaining = Math.max(0, entry.m - entry.samples);
    const measured = input.tokensByTaskClass.get(entry.taskClass) ?? [];
    const medianTokensPerAttempt = median(measured);
    const projectedTokens =
      medianTokensPerAttempt === null ? null : medianTokensPerAttempt * remaining;
    const budgetTokens = input.budgets.get(entry.taskClass) ?? null;
    const unitsFile = input.unitsFiles.get(entry.taskClass) ?? null;
    const estimate = {
      basis: (medianTokensPerAttempt === null ? 'unknown' : 'measured') as 'measured' | 'unknown',
      medianTokensPerAttempt,
      measuredAttempts: measured.length,
      projectedTokens,
    } as const;
    const base = {
      taskClass: entry.taskClass,
      state: entry.state,
      samples: entry.samples,
      m: entry.m,
      remaining,
      estimate,
      budgetTokens,
      unitsFile,
    } as const;

    if (entry.state === 'current') {
      return {
        ...base,
        decision: 'not-due' as const,
        reason: 'newest certificate is current under the running policy and model',
      };
    }
    if (projectedTokens === null) {
      return {
        ...base,
        decision: 'refused-unknown-estimate' as const,
        reason:
          'no measured attempt behind this class, so its cost is unknown; an unknown estimate ' +
          'never authorises a spend',
      };
    }
    if (budgetTokens === null) {
      return {
        ...base,
        decision: 'refused-no-budget' as const,
        reason:
          `no budget for ${entry.taskClass}; set FACTORY_RECERTIFY_BUDGET_TOKENS=` +
          `${entry.taskClass}=<tokens> to allow a spend`,
      };
    }
    if (projectedTokens > budgetTokens) {
      return {
        ...base,
        decision: 'refused-over-budget' as const,
        reason:
          `measured projection ${projectedTokens.toString()} tokens exceeds the ` +
          `${budgetTokens.toString()}-token budget for ${entry.taskClass}`,
      };
    }
    if (unitsFile === null) {
      return {
        ...base,
        decision: 'refused-no-units' as const,
        reason:
          'a budget covers the projection, but no pre-submitted unit list exists; the driver ' +
          'will not invent specs',
      };
    }
    return {
      ...base,
      decision: 'would-spend' as const,
      reason:
        `projected ${projectedTokens.toString()} tokens (${remaining.toString()} attempts × ` +
        `median ${String(medianTokensPerAttempt)} measured over ${measured.length.toString()} ` +
        `attempt(s)) fits the ${budgetTokens.toString()}-token budget`,
    };
  });
}
