/**
 * The three human gates, rendered. One question per invocation, one recommended
 * command, no default, no `-y` (§4.2, §4.4).
 *
 * The block always ends with the **exact phrase** the gate compares against, and
 * the non-interactive form of it (`--confirm "<phrase>"`), because the whole
 * point of the typed phrase is that approving a number requires typing the
 * number. A gate that prints the phrase more than once, or in two spellings, is
 * a gate that trains the operator to guess.
 */
import { field, indent, record, usd, wrap } from './format.ts';

export interface BudgetGateInput {
  readonly scope: 'unit' | 'day' | 'class';
  readonly scopeKey: string | null;
  readonly fromUsd: number;
  readonly toUsd: number;
  readonly phrase: string;
  readonly reason: string;
  readonly spentTodayUsd: number;
  readonly dailyLimitUsd: number;
}

export function renderBudgetGate(input: BudgetGateInput): string {
  const noun =
    input.scope === 'unit'
      ? 'per-unit envelope'
      : input.scope === 'day'
        ? 'daily envelope'
        : 'class envelope';
  const lines: string[] = [
    'GATE  budget-envelope-raise                    (human-only)',
    '',
    field('  ' + noun, `${usd(input.fromUsd)}  ->  ${usd(input.toUsd)}   (values ESTIMATED)`),
    field(
      '  applies to',
      input.scopeKey ?? `every ${noun.replace(' envelope', '')} from now on, until lowered`,
    ),
  ];
  if (input.scope !== 'day') {
    lines.push(
      field(
        '  today',
        `${usd(input.spentTodayUsd)} estimated of ${usd(input.dailyLimitUsd)} daily envelope`,
      ),
    );
  }
  lines.push(
    '  what this does NOT do',
    '    - it measures nothing: the price table is outside DSH and every number',
    '      here is an estimate, never a charge',
    '    - it does not raise the daily envelope; that is a second, separate gate',
    '',
    '  reason (recorded forever, attributed to you):',
    ...wrap(input.reason, 4),
    '',
    '  Sign by typing exactly:',
    `      ${input.phrase}`,
    `  non-interactive: --confirm "${input.phrase}"`,
  );
  return record(lines);
}

export interface PromotionGateInput {
  readonly unitId: string;
  readonly title: string;
  readonly lane: string;
  /** `null` when the unit has no verdict yet — the gate still renders, because the
   * operator asked and "there is nothing to sign" is the answer. */
  readonly verdictId: string | null;
  readonly verdictState: string | null;
  readonly deltaText: string;
  readonly wallVersion: string | null;
  readonly holdoutRevision: string | null;
  readonly receiptId: string | null;
  readonly artifactPath: string;
  readonly phrase: string;
  readonly firstPromotion: boolean;
}

export function renderPromotionGate(input: PromotionGateInput): string {
  const lines: string[] = [
    'GATE  initial-production-deploy                 (human-only; first promotion only)',
    '',
    field('  unit', `${input.unitId}  "${input.title}"  lane ${input.lane}`),
    field(
      '  verdict',
      input.verdictId === null
        ? 'none — this unit has no verdict, so there is nothing to sign yet'
        : `${input.verdictId}  ${String(input.verdictState)}  delta ${input.deltaText}  ${String(input.wallVersion)}  holdout ${String(input.holdoutRevision)}`,
    ),
    field('  receipt', input.receiptId ?? 'none yet'),
    field('  artifact', input.artifactPath),
    ...indent(['not written yet — a gate that refuses writes nothing at all'], 2),
    '',
    `  ${input.firstPromotion ? 'This is the FIRST promotion of this unit in this repo. It can never run dark.' : 'This unit was signed before, so the gate is informational this time.'}`,
    '  Nothing is pushed and nothing is deployed: v1 emits a patch + a signed',
    '  promotion record. Applying it is your action, outside this tool.',
    '',
    '  Sign by typing exactly:',
    `      ${input.phrase}`,
    `  non-interactive: --confirm "${input.phrase}"`,
  ];
  return record(lines);
}

export interface CredentialGateInput {
  readonly repo: string;
  readonly ttlSeconds: number;
  readonly phrase: string;
  readonly reason: string;
}

export function renderCredentialGate(input: CredentialGateInput): string {
  const minutes = Math.round(input.ttlSeconds / 60);
  const lines: string[] = [
    'GATE  privileged-credential-issuance              (human-only)',
    '',
    field('  scope', `repo:${input.repo}   ttl ${minutes}m   single-repo, task-scoped`),
    field('  holder', 'the credential proxy only - the worker container gets an opaque'),
    '           proxy token; it never sees this value, and neither will this terminal',
    field('  revoke', 'automatic at ttl, or: factory credential revoke <id>'),
    '',
    '  reason (recorded forever):',
    ...wrap(input.reason, 4),
    '',
    '  Sign by typing exactly:',
    `      ${input.phrase}`,
    `  non-interactive: --confirm "${input.phrase}"`,
  ];
  return record(lines);
}

/** The gate-refused line: nothing was applied, and the phrase is repeated once. */
export function gateRefused(phrase: string, what: string): string[] {
  return [
    `gate not signed; ${what}`,
    `  Sign by typing exactly: ${phrase}`,
    `  non-interactive: --confirm "${phrase}"`,
  ];
}
