# Changelog

What changed for someone using this repository, in order. Not a file-by-file diff — the commits say
that. The branch holds twelve commits: four change behaviour, the rest change documents (the audit,
status tables, the README). This log covers the four.

## Unreleased — the audit's findings, closed

- **`501da5d` — feat: dark software factory on DSH — planning set + implementation.**
  The repository starts existing as a working factory. `factory intent` takes an intent, `qualify`
  routes it dark or to a person by deterministic policy, `run` dispatches and records evidence,
  `status` answers "what needs me", and three human gates (promotion signing, budget envelope,
  credentialed access) refuse rather than warn. Eight packages and two apps ship with it, plus the
  read-only status page. The four controls the design rests on are proven by tests, not asserted: a
  sabotage that passes its own suite is rejected, `unknown` never satisfies a gate, recovery never
  re-dispatches, an unsigned promotion writes no file. `bash scripts/verify.sh` reports 6 passed,
  1 skipped (live-model, no key), 0 failed. **What this changes for you:** you can clone, run the
  gates offline, and drive a unit end to end without a model key or the DSH binary installed.

- **`c75dd05` — feat: real verdict path, e2e suites, and the gates that were only declared.**
  `run` now reaches a verdict: clone a pristine mirror, launch the worker, take the receipt, evaluate
  it with the wall's local runner, record the verdict. Before this the wall was a well-tested package
  nothing called, so "the verifier is generator-blind" was a property of code no operator surface
  could reach. Three wiring bugs fell out of that, each a correct check whose caller never invoked it
  — including `promote --signature <path>`, which passed the _path_ to the verifier as if it were the
  signature, so no real promotion could ever have succeeded. **What this changes for you:**
  `factory run` produces a verdict you can act on, `factory promote` accepts a signature from a file,
  and a kill -9 mid-run now leaves an `ambiguous` unit instead of a silent gap (5 real-wall specs,
  11 seam specs, 41 browser specs for the panel).

- **`b92f5cc` — fix(evidence): one receipt identity, and the spec that proved the sabotage is
  caught.**
  A receipt had two identities: `Verdict.receiptSha` (the decision projection, without the agent's
  narrative) and `receipts.receipt_sha` (the stored body). They differed, so any receipt with a
  narrative could not be joined to the verdict that judged it — and the CLI hid it by stamping the
  stored hash onto the verdict. Now one function, `receiptShaFor()`, computes it everywhere. **What
  this changes for you:** an agent can no longer mint new evidence by rewriting its narrative, and a
  verdict provably cites the receipt the wall actually read. The spec that proves the central claim —
  a change whose own suite is green, whose receipt is faithful, and which still fails the holdout is
  rejected with `holdout_failed`, an anonymised failing scenario, a measured Δ and no promotion
  artifact even under a valid signature — lands here.

- **`bf24f6a` — fix(outbox): the effect that was written and never settled, and the flag that lied.**
  Every dispatch committed a `launch` effect and then performed the launch inline without ever
  settling it, so each run left a permanent pending row and the promise that `recover` could retry a
  crashed launch described a path no code implemented. Now there is a settlement vocabulary —
  `applied` (the worker started, including the ambiguous case), `retryable` (nothing started),
  `exhausted` (a decision refused it, for good) — and `run` claims the effect before anything
  happens, settles it after, and `recover` performs pending launches under five guards, the lease
  among them. `--no-wait` was also dead: the code read an option name commander never sets, so
  "dispatch and return" quietly ran the whole pipeline to a verdict. **What this changes for you:**
  `factory status` reports the outbox honestly instead of claiming the store cannot count it,
  `--no-wait` does what it says, and a crash between commit and launch is recoverable without risking
  a second worker.

## Notes

- Nothing here is a "1.0". v1 deliberately refuses to build the scheduler, the credential proxy, the
  budget _enforcement_, and the off-host anchor; the audit
  ([`docs/planning/dark-factory-dsh/phase-13-audit.md`](docs/planning/dark-factory-dsh/phase-13-audit.md))
  records which promises those gaps leave open, and [`docs/handover.md`](docs/handover.md) lists them
  alongside the four decisions that only a human may close.
- No pass rate is certified. The wall reports a measured Δ and names the operating point as
  undecided (ND1).
