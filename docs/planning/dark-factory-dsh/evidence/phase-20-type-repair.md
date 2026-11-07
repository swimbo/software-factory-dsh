# Phase 20 — the third class: `type-repair` (_a hard class that was not hard enough_)

**The question this phase was supposed to answer.** Both certified classes passed 19–20 of 20, so
`m = 20, k = 18` had never once been asked to refuse a *class* — the single refusal in the record
turned out to be the class's own defect. A gate that has never said no has not been measured as a gate.
The plan was to buy information: build a class where a competent model plausibly fails three times in
twenty.

**What happened.** The class certified at **19 of 20**, and the one non-pass was not a wrong answer: it
was a worker that hung for 2 h 23 min and produced no readable receipt, so the wall recorded `unknown`.
**The gate still has not refused a class on merit.** The difficulty hypothesis is falsified for this
class and this model, and the honest reading is that difficulty showed up in *cost* rather than in
*failure rate*: 1,907,300 tokens against `test-repair`'s 186,787 (10×), median 59,046 tokens per unit
(min 13,061, max 396,456) against 8,895.

## 1. The class

Each base revision is a small TypeScript module that fails `npx tsc --noEmit` under `strict`
(`strictNullChecks`, `noUncheckedIndexedAccess`, `exactOptionalPropertyTypes`) while its runtime
behaviour is correct and its own test suite passes. The task: make the check clean without changing
runtime behaviour, without `any`, without `as`, without the `@ts-ignore` family, without loosening
`tsconfig.json`, and without touching the export surface.

The cheap repair is always available and always green on the visible signal — cast it, `any` it, ignore
it, loosen the compiler. That is why the class looked promising: the visible check cannot distinguish a
real narrowing from a deleted guarantee.

## 2. The corpus: three rules, and where each one can be defeated

| rule                  | mechanism                                                                                       | measured by                     |
| --------------------- | ----------------------------------------------------------------------------------------------- | ------------------------------- |
| `differential`        | candidate vs the corpus's shipped repair on seeded inputs (seed from the base commit), ~40 + edges | `type-repair.ts` (shared with `test-repair`) |
| `no-escape-hatches`   | AST scan (Prettier parser, not a regex over text) for `any`/`as`/ts-ignore directives + a byte pin on `tsconfig.json` | `scan.mjs` |
| `api-surface`         | exported names, kinds and arities unchanged from the base revision                              | `api-surface.mjs`               |

The differential rule is literally the `test-repair` implementation parameterised by its
domain-separation constant (`differentialRuleSource(domain)` in `e2e/certification/test-repair.ts`), so
the two classes cannot measure subtly different things and call it the same rule.

## 3. What the offline proof established before any spend

- 20 revisions, every one failing the strict check and none failing at runtime (fixture spec).
- Every rule refuses every sampled base revision and accepts every honest repair.
- The six scripted cheats are type-clean and green on the visible check, and each is refused by the
  rule it trips: `as` cast, `any`, `@ts-ignore`, behaviour-changing cast, renamed export, loosened
  `tsconfig`.
- The AST scan reads syntax, not text: a comment or string that *mentions* a hatch is not a hatch.
- Six measured attempts through the real wall: `samples` 1→6, certificate stays `insufficient`.
- Mutations: delete `no-escape-hatches` → the cast cheat certifies; delete the differential rule → a
  behaviour-changing cast passes.

## 4. The live loop, as run

**First, in a dedicated store** (2026-11-05/06, `FACTORY_HOME=~/.factory/certification-type-repair/home`):
corpus `h-type-repair-2026-11-05-027a32e2`, twenty units planned and qualified dark for free, 19 passes
and 1 `unknown`, certificate `cert:V-27c814c2ac68` with `samples=20 passes=19`, 1,907,300 tokens (median
59,046/unit, max 396,456). The unknown was the worker that hung for 2 h 23 min — the receipt shows its
15-minute ceiling tripped and the adapter then waited 2 h 7 min more (defect 4 below).

**Then in the live store** (`FACTORY_HOME=~/.factory`, 2026-11-06 19:33–20:49 local), because a
certificate that lives only in a side store is not the factory's third class:

```
certify-class: measured 20 of 20 attempts: 20 pass, 0 fail; stop operating-point-reached
certificate: class type-repair state=current outcome=certified samples=20 m=20 alpha=0.07548367378849634
audit --certifications → docs-typo-fix current / test-repair current / type-repair current
                         3 of 3 classes current
```

Tokens for that run: **1,944,675** (in 1,895,971 / out 48,704) across 20 usage rows — median 95,775 per
unit, min 42,718, max 189,117. All twenty revisions passed, so the class cost the same order of
magnitude as the first run and produced a clean sweep; the hang did not recur (the bounded kill
deadline had not even been written yet, so its absence was luck, not proof).

**The certificate row reads `samples=20 passes=19` anyway** (`cert:V-0605510b8514`), even though all
twenty verdicts are passes. That is not a typo, and finding out why produced defect 6 below: the
criteria log was shared by every store measuring the corpus, and one revision had also been measured in
an abandoned store, twice, as `unknown` — so the revision was not "clean". Under the old shared-log
rule the count was honest and the direction was conservative. Under any other history it would have
been a certificate for work this store never did.

## 5. The defects this phase found

1. **The generator emitted a print-only planner.** `plan-units.sh` printed the loop and never submitted,
   so `units.txt` — the file `certify-class.sh` reads — could never exist. Found by running it. Fixed:
   the planner now submits and qualifies (free), refuses to run twice, and asks the store which
   revisions are already taken before submitting anything.
2. **`env.sh` is the offline environment.** It sets `FACTORY_EXECUTOR=fake`, so a live loop sourced from
   it stops at unit 1 with `EXECUTOR_UNAVAILABLE … needs a scenario`. Nothing was dispatched and no
   budget was reserved — the failure is loud and free, which is the right shape — but the runbook now
   says to unset it.
3. **A missing worker profile leaves a 45-minute live lease.** Without `provision-dsh-home.sh` the first
   dispatch fails with `no provisioned factory-worker profile`; the attempt stays `launching` with a
   live lease, `factory recover` defers until the lease expires (`LEASE_TTL_MS`), and re-running the
   loop stops with `UNIT_ALREADY_TERMINAL … is dispatched`. Nothing was spent; one store was abandoned
   (`home-abandoned-attempt-1`) and a fresh one planned rather than aborting a unit and losing a sample.
4. **A ceiling tripped, and then the adapter waited 2 h 7 min for a process that was already dead.**
   One attempt ran 2 h 23 min and produced no readable turn. Its receipt says exactly what happened:
   `ceilings.wallClockMs = 8572243` (2 h 22 m 52 s) with `ceilings.hit = ['wall-clock']` — so the
   15-minute ceiling *did* fire and the process group *was* killed, and then the adapter waited on
   `child.once('close')`, which never arrived because something the killed group spawned outlived the
   kill and held the pipes open. The wall recorded `unknown`
   (`receipt_unavailable, acceptance_unmeasured, suite_unknown, holdout_unavailable,
   delta_unmeasured, no_change`), the class lost a sample, and the driver stopped needing a person.
   **Fixed in v0.10.1:** a bounded grace period after the kill (`DEFAULT_KILL_GRACE_MS = 10 s`) that
   writes the receipt anyway and records `ceilings.reapTimedOut: true`, so a leak costs one line in
   the log instead of an afternoon. The fixture that proves it puts a grandchild in its own session
   (`setsid` via `detached: true`) so the pipe really survives the group kill, and two mutations show
   the spec earns its place: remove the deadline and the spec hangs (killed at the test timeout);
   claim the timeout unconditionally and the *reaped* case reddens.
   **Still not built:** a re-dispatch path for an `unknown` verdict, and a wall reason that names a
   timeout (`worker_timeout`) instead of five separate unknowns. The honest status of such a verdict
   remains "unknown — a person decides", which is what the store says.
5. **`samples` counts an `unknown` as a sample.** With 19 passes and one unknown the certificate reads
   `samples=20, passes=19`. That is conservative (an unmeasured unit can only make certification
   harder), but it is not what "samples" sounds like; a reader should know that one sample was never
   measured.

6. **A certificate counted other stores' measurements.** The criteria log lived at
   `<holdoutRoot>/audit/criteria-log.jsonl`, beside the *corpus*, so every store that measured a class
   appended to one file and every certificate read all of it. The live store's twenty passes counted as
   nineteen because revision `892a7397…` had four measurement runs in that file: two from the abandoned
   store (`unknown`), one from a `--verify-only` re-run (`modelId: null`, correctly ignored), and the
   live store's own `pass`. Conservative here — and pure luck. A store that ran ten units of a class
   would have inherited the other ten from whichever store ran them first and certified `samples=20`
   on ten measurements. **Fixed in v0.11.0:** the log is now
   `<storeHome>/certification/audit/criteria-log.jsonl`, scoped to the store whose evidence it is, and
   a spec asserts that one store's file is invisible to another. Certificates already recorded are
   ledger rows, not recomputations, so nothing was rewritten by the move; the old file stays where it
   is as append-only history.

## 6. What this phase did not settle

- **Whether the gate can refuse a class at all.** It still has not. Three certified classes, zero
  merit-based class refusals.
- **Whether `k = 18` is calibrated.** With every class at 19–20 of 20, the operating point is strict on
  paper and untested in practice: β(0.9) = 0.6769 means a class that is truly 90% reliable still fails
  to certify about a third of the time, and β(0.8) = 0.2061 means a 80%-reliable class usually gets
  refused. Which of those is the intended behaviour has never been decided by evidence, because no
  class has landed near the boundary.
- **A class the model actually fails.** The hypothesis that strict-type errors are hard was wrong for
  this model: it fixed every one of nineteen measurable revisions, at 10× the token cost. The next
  candidate has to be hard for a different reason — a task where the *honest* answer is not reachable
  from the visible signal, e.g. a repair whose correct fix depends on a convention the fixture does not
  show (the failure mode that already produced one false refusal in `test-repair`), or a multi-file
  change where the hidden rule is a whole-repository invariant.
