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

## Addendum (round 13): the refusal was the class's defect, not the model's

The section above calls attempt 8 "a plausible wrong repair", caught by a probe. Re-measured, that
reading was wrong, and the correction matters more than the certificate.

**What actually happened.** The candidate preserved a *leading* `..` (`'../x' → '../x'`), which is what
POSIX `path.normalize` does. The fixture's reference drops it, because this class's docs-path space has
no parent. Nothing the worker could see said which convention was intended: both visible cases ran with
a non-empty segment stack, where the two conventions agree. So the class refused a **defensible**
repair for disagreeing with an undiscoverable choice of its author — and then did it a second time,
with the same patch, on the same module, in the re-certification under the stricter corpus. A failure
that reproduces identically across independent runs is a property of the class, not of the model.

**The fix, and what it cost.** `e2e/certification/test-repair.ts` now audits every declared differential
edge: if the **base** revision already answers it correctly, a refusal there cannot be about the defect,
so that edge *must* appear as a visible case, and the build refuses to finish if it does not. Sixty-one
such "safe" edges were invisible across 19 of the 20 revisions — rounding-mode boundaries, fallbacks,
empty inputs, even/odd, page edges, parse shapes, HTML entities. The rule is deliberately narrow: making
*all* 118 declared edges visible let the `bytes` lookup-table cheat pass the corpus and **certify**
(measured, `test-repair-certification.test.ts` red), so the fixture may show what the base gets right
and must not show where the base is wrong.

**The third measurement.** After the fix, with the corpus content-addressed
(`h-test-repair-real-2026-11-04-ffa87379`, see below), the live loop returned **20 of 20 passes**:
`samples=20, passes=20, certified`, 186,787 tokens across the twenty attempts (median 8,895). Both
classes read `current`, `alerts` is empty, the anchor is fresh.

That result is *easier* than the previous 19/20 and it is the honest direction: the class became fairer,
not the model better. A certificate earned against a corpus that refuses defensible work measures the
author's taste; the previous round's certificate should be read as evidence of that defect, which is
why it was re-measured rather than kept.

**Second defect found on the same path: a corpus id is not an identity.** The corpus id was
date-based, so rebuilding the fixture under the same date minted different rules under the same name —
and `certificatesRecency` compares names, so the certificate would have read `current` while naming
evidence it was never measured against. This is the same defect the project fixed for policy digests,
one level down. The test-repair id is now content-addressed (`…-2026-11-04-<8hex>`, a sha256 over every
rule, probe, reference module, suite wrapper, index and manifest scenario, with the manifest's own id
fields masked), the fixture commits carry a fixed date so unchanged content cannot mint a new id, and
the build re-derives the digest from the final directory and refuses to finish if it disagrees. Proven
both ways in the gate: same content a year and a directory apart → same id; one changed probe → new id
with identical commits.

The docs class's corpus id is still a fixed label. That is recorded as a known weakness in
`docs/runbooks/certify-class.md` §4 with the fix and the condition ("before that corpus is next rebuilt
or the class next re-measured") — applying it now would expire 6.4 M tokens of evidence whose corpus
has not changed, which is the false staleness this project refuses to trade for tidiness.

**Third and fourth defects, both in the generator.** `scripts/test-repair-artifacts.sh` emitted specs
whose restatement scored `restateOverlap=0.357` against a `0.500` floor, so every regenerated spec was
refused by `qualify` and `plan-units.sh` wrote an empty `units.txt` — a generator producing artifacts its
own gate refuses. And `plan-units.sh` refused a second run without naming which revisions were taken;
it now prints the next free revision. Both are pinned by the artefacts gate spec.

**What the certificate now names.** Class, operating point, model, policy **and corpus** — schema v5
adds `class_certificates.holdout_revision`, written from the verdict that produced each certificate, and
the `4 → 5` migration backfills existing rows from the verdict each one names (an exact join, never the
class's newest corpus, never a wildcard: a row whose verdict names nothing, or no longer exists, stays
`NULL` and reads stale with the reason "predates corpus attribution"). Without the backfill both live
certificates would have flipped stale on a schema change alone — false staleness that would have
committed the project to re-spending 6.4 M tokens re-measuring an unchanged corpus. The backfill is a
bridge with a deletion condition, recorded in the migration comment and in the runbook.

Still open, named rather than hidden: the `wall.class_certified` ledger event does **not** carry the
corpus (or `p0`), so a reader that trusts only the events can prove a class was certified under a policy
and a model but not which holdout made it true. ~3 files, ~15 lines, one contract decision.
