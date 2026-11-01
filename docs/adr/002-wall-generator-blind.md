# ADR-002 — The wall is generator-blind, and the holdout is the only oracle

**Status:** accepted (Phase 3 debate, Phase 9c implementation)
**Context:** [architecture.md](../planning/dark-factory-dsh/architecture.md) §6, [debate-transcript.md](../planning/dark-factory-dsh/debate-transcript.md)
**Proven by:** `packages/wall` (135 tests, 3 skipped `@docker`), `e2e/cli/default/09-holdout-sabotage.test.ts`, `packages/contracts/src/receipt.ts`

## Context

The whole product is one claim: a machine can decide that a change is merge-ready without a person
reading the diff. The tempting design is to let the agent grade itself — run the agent's own tests,
read its summary, trust the report. That design is defeated by a single behaviour: an agent that
makes its visible tests pass can be wrong in exactly the ways that matter, and it is the one actor
with both the motive and the opportunity to make them pass by editing them.

The debate's framing: _what can a verifier see that the generator cannot influence?_ The answer has
to be an artifact the generator never sees, judged by a procedure that does not ask the generator
anything.

## Decision

Two rules, both structural:

1. **The wall is generator-blind.** It is handed a _decision receipt_ — mechanical facts
   (commands, exit codes, artifact hashes, the pinned suite's output) — and re-executes. It never
   reads the agent's narrative: `packages/contracts/src/receipt.ts` defines `DecisionReceipt` as
   `WorkerReceipt` **without** `narrative`, and `toDecisionReceipt()` is the only path into
   evaluation. The narrative exists in the raw receipt for a human; it is not evidence.
2. **The holdout is the only oracle that decides.** The holdout corpus lives outside the worktree
   and outside the worker's reach (`FACTORY_HOLDOUT_ROOT` + `FACTORY_HOLDOUT_TASK_CLASS`, resolved
   in `apps/cli/src/wall.ts`; materialised and validated in `packages/wall/src/holdout.ts`). A
   verdict is `passed` only when the pinned suite re-executes and the holdout scenarios pass the
   declared quorum; Δ (visible pass rate − holdout pass rate) is recorded as a measurement.

The visible suite is **not** evidence. It is a necessary precondition (a change that cannot pass
its own suite is not worth measuring) and it is what the Δ is measured _against_, but it never
converts to a pass on its own. This is why the wall can reject a change whose visible tests are all
green, and why that rejection is the product working rather than the product misbehaving.

## Alternatives rejected

- **Trust the agent's own test run (visible suite as oracle).** Rejected because it is exactly the
  attack the product exists to survive: `e2e/cli/default/09-holdout-sabotage.test.ts` submits a
  change that passes its visible suite while sabotaging behaviour, and the wall rejects it. If the
  visible suite decided, that spec would have to pass the unit — the spec would be impossible to
  write.
- **Ask the generator for a self-assessment and require it to agree with the holdout.** Rejected
  twice: it puts a model on the decision path (violates L2), and it creates a signal the generator
  can tune (an agent that learns the question can learn the answer). It also has no failure mode
  that a person can audit — "the model said it was probably fine" is not evidence.
- **Randomised or adversarial prompt variants instead of a held-out corpus.** Rejected because it
  is unverifiable: two runs of a randomised verifier are not comparable, so Δ cannot be measured
  and a pass rate cannot even be estimated. The holdout is fixed, versioned and revision-tagged
  precisely so that a verdict is reproducible.
- **Let the wall see the whole worktree including the tests it just wrote.** Rejected as the
  narrow version of the same mistake: a generator-writable oracle is an oracle the generator owns.

## Consequences

**Good.** Sabotage that passes its own suite is caught through the real pipeline
(`e2e/cli/default/09-holdout-sabotage.test.ts` — the wall rejects it, no artifact is written, and
the verdict's reasons name the holdout scenario family). Δ per task class is a real measurement, so
"is the wall doing anything?" is answerable from the store (`health.taskClasses[]`). The narrative
is free-form and unconstrained in the raw receipt — it never has to be machine-checkable, because
it never decides anything.

**Bad.** The wall needs a pinned suite and a holdout corpus to exist for the task class, so a cold
factory routes nothing dark (`factory status` says `no task-class history` until a class is
certified from measured samples). Local evaluation is slower and heavier than reading a report: the
`@docker` runner is the intended production path and is skipped here
(`packages/wall/src/container.test.ts` — no image ships in v1). And the generator-blind rule costs
the wall information that would sometimes be useful: the wall cannot ask _why_ a change was made,
only what it mechanically did.

**Not built.** Three things this ADR implies are absent, not merely unfinished:
(a) the holdout corpus in this repository is a fixture set, not a published certification corpus,
so **no pass rate is certified** — `phase-13-audit.md` §2 (Phase 9c) records that E2E-29 was
unproven at the audited commit and landed later as `09-holdout-sabotage.test.ts`;
(b) `wall revalidate` does not exist — `packages/wall/src/cli.ts` accepts only `self-test`;
(c) the container runner is not exercised in CI (`@docker` skipped), so "the wall runs in a separate
trust domain" is a design property, not a measured one (ND2).
