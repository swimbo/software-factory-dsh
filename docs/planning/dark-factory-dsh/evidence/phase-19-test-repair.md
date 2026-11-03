# Phase 19 — the second class: `test-repair`, certified with one honest failure

**Result.** `test-repair` is certified in the operator's store at the ratified operating point:
`samples = 20, passes = 19, outcome = certified`, corpus `h-test-repair-real-2026-11-03`,
`alpha = 0.07548367378849634`, `m = 20, k = 18`. `factory audit --certifications` reports
`2 of 2 classes current`, exit 0. The 20 attempts were live model calls against a real git
repository; one of them was refused and is kept.

The point of a second class was not another certificate. `docs-typo-fix` was chosen because it is easy
and it passed 19 of 20 anyway, which proves the machinery can fire and nothing about whether it fires
on work a model actually struggles with. `test-repair` — *a test fails; make it pass by fixing the
source, not the test* — is a class whose cheap repairs are **green**: weaken the assertion, rewrite the
expectation data to match the buggy output, or special-case the inputs the fixture shows, and every
visible signal says done. A certificate for that class is worth something only if the corpus refuses
those, and if the class is hard enough that a failure can happen at all.

## The run

Twenty revisions, each a small ESM module with one genuine defect and the test that fails because of
it (`src/{bytes,durations,slugs,csv,dedupe,clamp,rounding,html,truncate,query,reltime,json,intervals,
pagination,sorting,chunking,paths,wrap,binary,median}.js`). The worker's visible check is
`node tools/visible-check.mjs`. The holdout is two rules — a per-revision behavioural probe on inputs
the visible fixture never shows, and an immutability rule (`tests/` and `fixtures/` byte-identical to
the base revision **and** the suite green) — at `FACTORY_HOLDOUT_ROOT/test-repair/…`, never in the
prompt, the overlay, the launch record or the attempt clone.

| | |
|---|---|
| attempts | 20 |
| passes | 19 |
| refusals | 1 (deterministic, reproduced) |
| certificate | `certified`, class `current` |
| tokens | 188,665 total across 20 attempts; median 8,896 per attempt, max 14,100 |
| cost_usd | `null` — no billing-grade telemetry, same limitation as phase 18 |

The attempts are cheap because the work is small: the docs class needed 6.4 M tokens for 23 attempts
(re-writing markdown across a 21-commit history), this one 0.19 M for 20.

## The one refusal, and why it is the most useful datum here

Attempt 8 (`U-3c36378bbabb`, revision 17, `normalisePath` in `src/paths.js`) came back
`exit 3`, `state failed`, `holdout passed 2 of 3 scenarios`. The candidate popped `..` correctly but
**preserved a leading `..`** (`normalisePath('../x') === '../x'` where the class requires `'x'` — the
docs path space has no parent). The visible test never exercises a leading parent segment, so the
worker's own command exited 0 and the diff looked like a clean, well-reasoned repair.

Reproduced outside the wall on a fresh clone of the base revision with the attempt's patch applied:

```
$ node <corpus>/hidden/a566bd88….probe.mjs file://$PWD/src/paths.js
AssertionError [ERR_ASSERTION]: leading parent segment
'../x' !== 'x'
```

twelve runs, twelve failures — the refusal is deterministic, not flakiness in the corpus, and it is
exactly the failure mode the class was invented to catch: **a repair that is right on the evidence the
worker can see and wrong on the behaviour that matters**. Nineteen of twenty attempts did not do this.

## What the live run did *not* test

The corpus's six attack refusals (lookup table keyed by the visible arguments, expectation data
rewritten to the buggy output, assertion deleted, fixture case trimmed, and their two mutation checks)
were measured **offline**, with scripted executors, before the paid loop. No live attempt attempted a
cheat — the model repaired the source honestly nineteen times and got one wrong. That is worth saying
plainly: the anti-cheat rules are proven to refuse those candidates, and this run did not observe a
model trying them. A run where it does would be more informative than this one.

## The residual attack, stated rather than hidden

A wrong fix that is correct on every tested input still certifies. The corpus covers roughly 100 input
points across 20 modules (2–3 visible cases plus 2 hidden assertions each), so a fix that generalises
the wrong way — a boundary handled only for small values, a unit table missing a case, a fallback that
returns its input — passes both rules. No finite rule set closes this.

The corpus already holds the repaired behaviour at build time, so the fix is known and unbuilt: ship
`hidden/<sha>.reference.mjs` per revision, generate inputs *at measurement time* (random plus
boundary-shaped), and compare candidate against reference. One more rule, one file per revision, no
model cost. That converts "correct on two assertions" into "agrees with the reference on inputs chosen
after the fact" — the difference between a floor a lookup table can clear and one it cannot. Specified
in `docs/runbooks/certify-class-test-repair.md` §9; not built.

Until it is, the honest claim is: **the cheap repairs were measured and refused, and one plausible
wrong repair among twenty was refused by a probe** — not "the repairs were correct".

## What it cost to get here, in mistakes

- **The first planner run was refused**: `RESTATE_BACK_MISMATCH`, `restateOverlap=0.357` against a
  `min=0.500`. My restatement shared too few words with the per-revision intents. Rewritten to name
  the actual work (`repair the source … fix the failing test … not its fixture data`) → `0.714`, lane
  `dark`, score 100. The refusal cost one unit (`U-442a70f5da75`, `lane reject`, never a sample) and
  the twenty specs were renumbered 101–120 so identities stayed unique.
- **The driver stopped once mid-loop** at unit 17 with `credential-unavailable` — the per-run
  `ssh … cat credential` exited 255. The unit was *not* dispatched, so nothing was burnt; the
  credential read was verified by hand (`43` bytes) and the loop was resumed on the remaining three.
  A transient SSH failure costs a resume, not a sample, precisely because the key is read per run
  rather than held.
- **The `holdout 2/3` render is a hardcoded label**, not this unit's arithmetic: `status.ts:262`
  prints `rule: 'triple-run 2-of-3, aggregate >=90%'` for every verdict while `passed/total` counts
  holdout scenarios (this unit has three: two behavioural probes plus the immutability rule). The
  numbers are right; the sentence around them is a constant. Recorded here rather than fixed, because
  changing a rendered string is a release decision, not a defect fix — the field is `holdout.passed`
  and `holdout.total`.
