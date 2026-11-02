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
  'alerts',
  'recover',
  'abort',
  'promote',
  'budget',
  'credential',
  'gate',
  'ledger',
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
    '--scenario and --verdict belong to the two test seams (FACTORY_EXECUTOR=fake, FACTORY_WALL=fake):',
    '  they replay a declared scenario and a declared verdict, are refused under NODE_ENV=production,',
    '  print `executor: FAKE` / `wall: FAKE` on every command that uses them, and stamp every artifact',
    '  they produce (`sessionId: fake-…`, `wallVersion: …-fake`) so no fake run can read as a real one.',
    'The attempt is a clone of FACTORY_PRISTINE_REPO at spec.baseRev (FACTORY_REPO names the repo the',
    '  unit was submitted against). Without both keys, or with a mirror that is not a git repository,',
    '  this exits 8 (EXECUTOR_UNAVAILABLE) before dispatch: nothing is reserved and no attempt exists.',
    'The wall runs `evaluate()` from @factory/wall over the receipt, using its local runner: it measures',
    '  behaviour and nothing else, so every verdict it produces is labelled `+local` (no containment,',
    '  no network isolation) and a scenario that requires a container is refused, never downgraded.',
    'The wall needs an oracle of its own: FACTORY_WALL_SUITE names the pinned suite whose',
    '  FACTORY_SUMMARY line is read (a JSON array or a whitespace-split argv), and FACTORY_HOLDOUT_ROOT',
    '  + FACTORY_HOLDOUT_TASK_CLASS name the holdout corpus Δ is measured on. Without them the verdict is',
    '  `unknown` (exit 5) — never a pass the wall did not measure.',
    'An `unknown` verdict is recorded and the unit does not move: exit 5, because a person decides. Exit 4',
    '  is reserved for an attempt whose ambiguity is unresolved (nothing to decide about yet).',
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
  ledger: [
    '`ledger anchor` is the only command that talks to another machine, and the destination comes from',
    '  configuration (FACTORY_ANCHOR_SSH / FACTORY_ANCHOR_PATH), never from a unit spec or a receipt.',
    'A local anchor is reported as LOCAL and never described as off-host: it detects truncation, not a',
    '  host that rewrites both copies.',
    '`ledger verify` exits 9 unless the anchor is fresh; `stale`, `missing` and `rollback` are all',
    '  refusals, because an anchor nobody checked is an anchor that proves nothing.',
  ],
  audit: [
    '`audit` is read-only and works on a quarantined store.',
    'The escape-rate sample asks you to re-validate; it never re-validates for you.',
    'Printing the trace says nothing about safety — see the block this command prints verbatim.',
  ],
  alerts: [
    'Read-only: `alerts` never anchors, never re-certifies and never writes to the store or ledger.',
    'It runs the same judgements as `ledger verify` and `audit --certifications`, not a second copy.',
    'An unreachable anchor is exit 8 (environment), never 0: a monitor that calls a transport failure',
    '  "fine" is worse than no monitor at all.',
    'By default it prints and logs and tells nobody. With `--notify` it also tells an operator who',
    '  opted in: one macOS notification on this machine, or — when FACTORY_ALERTS_WEBHOOK_URL is set —',
    '  exactly one POST of the same alerts.v1 JSON. That POST is the one exception to the no-network',
    '  line above: opt-in, bounded, retried at most once, and never able to change the exit code.',
    'Nothing retries a lost notification: the next scheduled run is the retry. A warning-severity alert',
    '  is logged and never notified — paging for a spend ceiling is how exit-9 pages stop being read.',
  ],
  recover: [
    '`recover` never re-dispatches, never retries and never deletes evidence. It reconciles and reports.',
    'It sweeps a leaked worker container — only for an attempt this invocation reconciled to',
    '  ambiguous, only by that attempt’s org.factory.attempt=<attemptId> label, and never while the',
    '  lease is live. A docker it cannot reach is reported as failed, never as a clean sweep.',
    'It is idempotent: running it twice prints the same facts and changes nothing the second time.',
    'An ambiguous attempt stays ambiguous: resolution needs evidence, and this build has no command for it.',
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
    'A verdict that is not evidence cannot promote even when correctly signed: a pass carrying',
    '  fake_verdict_not_measured (or any other unmeasured code), or a fake-wall `-fake` version, is',
    '  refused with exit 5. Signing proves who approved it, never that anything was measured.',
  ],
  budget: [
    'A raise is a human gate: the typed phrase names the amount, and nothing is applied on a mismatch.',
    'The daily envelope is a second, separate gate. Raising the per-unit ceiling does not raise it.',
    'Lowering a ceiling is not a gate, but it still needs --reason and is recorded forever.',
    'The amounts `budget show` prints are estimates — the reservation recorded at dispatch and the',
    '  price table — never a charge; the gateway export is the only billing-grade source.',
    'Worker usage is observed, not estimated: tokens, cost and request id are read from',
    '  the response the gateway itself sent and recorded as a usage row when the turn returns. A',
    '  response that prices nothing is recorded with cost null — unknown, never a fabricated zero —',
    '  and a turn that reports no usage at all leaves no row rather than a zero row.',
    'The credential proxy revokes the attempt token when observed spend crosses the ceiling: the',
    '  limit is enforced by revocation, not by trusting the worker to stop.',
    '`budget reconcile` is the best-effort invoice check against the gateway export; with no export',
    '  it exits 6 USAGE_UNRECONCILED, because unknown is not a pass.',
  ],
  gate: [
    '`gate` verifies an operator signature; it never holds or generates a private key, and no flag',
    '  mints one. The signing step is yours, run wherever your private key already lives.',
    '`request` and `list`/`show` are read-only: they never write the store and never move the ledger.',
    '`request` exits 5 when the operation is privileged and no live decision covers it — that is why',
    '  the caller is there — and 0 when the argv is unprivileged or already covered.',
    'A decision binds exactly one normalised operation and expires: it is not a session, and a second',
    '  use of the same decision is refused (exit 5). The signature covers both timestamps, so the',
    '  payload must be signed with the exact --issued-at `request` printed; a re-run later fails closed.',
    'A standalone decision carries taskId gate:<sha8> — a label for reading, never a claim that a unit',
    '  with that id exists.',
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
