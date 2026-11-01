/**
 * The `LIMITS` section every verb prints in `--help` (`ux-plan.md` §7, "bait and
 * switch"): a command that only says what it does is a command that lets the
 * operator discover the boundary by hitting it.
 *
 * Two rules for the text below: it names a *concrete* non-capability ("v1 does not
 * push, deploy or open a pull request"), and it never apologises or hedges. The
 * absence is part of the design (the wall, not the agent, caps throughput), so it
 * is stated the way a fact is stated.
 */
export const VERBS = [
  'intent',
  'qualify',
  'run',
  'status',
  'receipts',
  'audit',
  'recover',
  'abort',
  'promote',
  'budget',
  'credential',
  'version',
] as const;

export type Verb = (typeof VERBS)[number];

/** True for every verb: no model call, no network, no bypass flag, one gate per invocation. */
const COMMON = [
  'No model calls and no network calls: this command is deterministic I/O on the local store.',
  'No gate can be bypassed: -y, --yes, --force, -f and --assume-yes are usage errors (exit 2).',
  'One gate per invocation. Answering a gate never implies answering the next one.',
];

const SPECIFIC: Readonly<Record<Verb, readonly string[]>> = {
  intent: [
    'v1 does not push, deploy, open a pull request or call an agent. `intent` writes one unit row.',
    'The spec file is JSON, not YAML: v1 ships no YAML parser, and a silent half-parse of a',
    '  spec is worse than a refusal naming the line and column.',
    'The restate-back is compared to the spec text as supplied; the CLI never rewrites your intent.',
  ],
  qualify: [
    '`qualify` never dispatches and never edits the spec. It scores, stores the decision and prints it.',
    'The CLI cannot make a unit dark: the lane is derived by deterministic policy, not requested.',
    'No threshold flag exists — the policy version, not the operator, owns the number.',
    'Dark routing normally requires measured task-class history; a cold factory routes nothing dark',
    '  until an operator enables cold start (--cold-start or FACTORY_POLICY_ALLOW_COLD_START=1),',
    '  which changes the policy version and is visible on every decision it produced.',
  ],
  run: [
    'v1 does not push, deploy or apply anything. A run produces a receipt, then a wall verdict.',
    'A lit unit is refused (exit 3). There is no verb, flag or override that runs a lit unit.',
    'Dark routing normally requires measured task-class history; a cold factory routes nothing dark',
    '  until an operator enables cold start (--cold-start on `qualify`, or',
    '  FACTORY_POLICY_ALLOW_COLD_START=1), which changes the policy version and is visible on every',
    '  decision it produced.',
    'An ambiguous attempt is never retried automatically; `--retry` requires --reason, as a decision.',
    'Without the pinned dsh binary and a docker daemon this exits 8 (EXECUTOR_UNAVAILABLE),',
    '  and nothing is dispatched and no budget is reserved.',
  ],
  status: [
    '`status` is read-only. It never reconciles, retries or dispatches anything.',
    '`unknown` is reported as needing a person; it is never folded into an ok line.',
    'Spend is an estimate derived from usage, never a charge: every amount is marked `estimated`.',
  ],
  receipts: [
    '`receipts` prints mechanical facts and a path. It never prints a diff.',
    'The narrative the model produced is not stored in the decision receipt and cannot be shown.',
    'Receipts are append-only: this command never edits, merges or overwrites one.',
  ],
  audit: [
    '`audit` is read-only and works on a quarantined store.',
    'The escape-rate sample asks you to re-validate; it never re-validates for you.',
    'Printing the trace says nothing about safety — see the block this command prints verbatim.',
  ],
  recover: [
    '`recover` never re-dispatches, never retries and never deletes. It reconciles and reports.',
    'It is idempotent: running it twice prints the same facts and changes nothing the second time.',
    'An ambiguous attempt stays ambiguous; only `--observe` can resolve it, and only with evidence.',
  ],
  abort: [
    '`abort` ends a unit; it does not roll anything back. The worktree is left for inspection.',
    'It is terminal: a second abort refuses (exit 3). Resubmit a new revision instead.',
    '--reason is required: an abort with no recorded reason is an unauditable decision.',
  ],
  promote: [
    'v1 does not push, deploy, tag or create a pull request. It writes a patch and a signed record.',
    'Applying the change is your action, outside this tool — there is no apply verb.',
    'The signature cannot be synthesized: no flag, key or environment variable mints one for you.',
    'An unsigned promotion writes nothing at all, not even a draft artifact.',
  ],
  budget: [
    'A raise is a human gate: the typed phrase names the amount, and nothing is applied on a mismatch.',
    'The daily envelope is a second, separate gate. Raising the per-unit ceiling does not raise it.',
    'Lowering a ceiling is not a gate, but it still needs --reason and is recorded forever.',
    'v1 measures nothing: every amount here is an estimate, and the CLI never says otherwise.',
  ],
  credential: [
    'The secret value is never printed, never logged and never in --json: only a token id and expiry.',
    'Unscoped credentials do not exist: --repo is required and --ttl must be at most 1h.',
    'The worker container receives an opaque proxy token, never this credential.',
    'v1 cannot widen a scope after issuance; issue a new credential instead.',
  ],
  version: [
    'Prints the versions this build expects and what it can see. It changes nothing.',
    'A dsh version mismatch is refused at startup (exit 8), never downgraded to a warning.',
  ],
};

/** The `LIMITS` block for one verb: specific limits first, then the invariants that always hold. */
export function limitsFor(verb: Verb): string {
  const lines = [
    'LIMITS',
    ...SPECIFIC[verb].map((line) => `  ${line}`),
    '',
    ...COMMON.map((line) => `  ${line}`),
  ];
  return `\n${lines.join('\n')}\n`;
}
