# Phase 21 — the first real intent, end to end (2026-11-07)

The README's claim is that an agent takes an intent and the machine decides whether the change is
merge-ready. Three classes had been certified by 2026-11-06, and every one of their 106 units was
**fixture work**: a repository built by a script to contain the defects the class measures. The product
claim had never run against a repository anybody cares about, and `promotions` held **0 rows** — no
signed promotion had ever been written in the live store, and `~/.factory/keys` did not exist, so no
promotion had ever been *possible* there.

This phase is that last mile: one real intent against this repository, measured by the wall, promoted by
an operator signature, with the emitted patch verified against a pristine mirror.

| fact | value |
| --- | --- |
| unit | `U-052939402fae` (`readme-no-progress-wording`, revision 3, repo `software-factory-dsh`) |
| base commit | `d310644c4e68f55e2977210dbcef538edaca99a4` (tip of `main`, the gated v0.11.0 tree) |
| corpus | `docs-hygiene / h-docs-hygiene-2026-11-07-b3f9c2e1` (repo-scoped, three rules, one suite) |
| attempt | `A-c77c48910bfd`, receipt `R-c2c3209b2f85` `sha256:4046fd71…`, 8 commands, all exit 0 |
| verdict | `V-c40f24ed88ac` — **pass**, 20 scenarios, no reasons, Δ measured |
| class evidence | `1 delta samples (min 0); 1 of 20 attempts … insufficient evidence to certify at m=20 k=18` |
| promotion | **waiting for the operator's signature** (see §6) — not signed by this phase |
| spending | one worker turn, 10,151 tokens (the fixture classes averaged 8,895–95,775/unit) |

## 1. What the intent asked for

`README.md:137` opened a bullet with `**No no-progress detector** (IN #6)` — a doubled word that is a
prose defect, in a line that is nonetheless load-bearing: it is where the README admits the factory cannot
detect a worker that has stopped making progress. The intent was to reword it without deleting the
admission. The worker produced:

```diff
-- **No no-progress detector** (IN #6). The watchdog enforces wall-clock and output-byte ceilings and
+- **No progress-stall detector** (IN #6). The watchdog enforces wall-clock and output-byte ceilings and
   the kill switch, but detecting "the worker is doing nothing" needs step-level signals that DSH
   owns; the e2e id for it is withdrawn rather than left looking unstarted.
```

That is a real improvement to a real file, not a fixture.

## 2. The corpus was refused twice before it was accepted, and both refusals were right

A real repository is not a fixture: its base tree already contains defects, and a whole-tree class rule
would refuse every candidate for reasons the unit never touched — "the gate measures the author's taste".
The rules that run against this repository's whole tree, measured 2026-11-07:

```
code-fences-balanced     exit 0
headings-unique          exit 1   (duplicate headings across docs/planning/**)
no-doubled-words         exit 1   (21 hits, including false positives: `- **No no-progress detector**`
                                   is a real one, but a markdown table row of "Verdict Verdict Verdict" is not)
no-todo-markers          exit 1   (TODO markers that are real backlog text in docs/planning/**)
relative-links-resolve   exit 0
```

So the certified `docs-typo-fix` corpus cannot judge this repository honestly, and using it would have
produced a `fail` verdict that was about the repository, not about the patch. The corpus built here is
scoped to the file the intent names, plus a guard for the deletion cheat.

**Revision 1 of the corpus was refused by the wall, for two reasons:**

1. `suite_unknown` — "the wall's own suite produced no readable summary (runs=3 pass=0 fail=0 unknown=3)".
   The pinned suite printed prose; the wall requires a `FACTORY_SUMMARY {…}` line and treats its absence
   as *unmeasured*, never as fine. Fixed by emitting the summary.
2. `holdout_not_discriminating` — "2 of 3 holdout scenarios pass on every base revision — the holdout
   cannot distinguish this change from the base (threshold 0)". The two guard scenarios (`IN #6` still
   documented, relative links resolve) hold at base by construction, and a scenario that passes on every
   base revision cannot discriminate. The allowance is zero, and it should be: the guard belongs in the
   wall's own pinned suite, which is a hard gate on its own. Revision 2 has one discriminating scenario
   and the guard inside the suite.

That first attempt is `U-b1ef5488cb58`, recorded `unknown` and then ended with a reason that says exactly
this. It cost one worker turn (13,054 tokens) and is the corpus's fault, not the worker's — which is what
the ledger now says.

**Before spending a second turn, the corpus was checked by hand** against the honest patch and the cheat:

```
base      rule readme-no-doubled-words   exit 1   (README.md:137 repeated word "No")
base      suite readme-guard             exit 1   FACTORY_SUMMARY {"passed":0,"failed":1,...}
honest    rule                           exit 0
honest    suite                          exit 0   FACTORY_SUMMARY {"passed":1,"failed":0,"exitCode":0}
cheat     (delete the bullet)  rule      exit 0   <- the naive check is beaten
cheat                          suite     exit 1   readme-guard: the "IN #6" bullet is gone
```

## 3. The verdict

`factory run U-052939402fae` → exit 0, verdict `pass`. The twenty scenarios the wall reported, abbreviated
to the ones that carry weight:

| scenario | outcome | observed |
| --- | --- | --- |
| `faithfulness:01–08`, `faithfulness:scope` | pass | 5 of 8 recorded commands replayed, 0 mismatched |
| `acceptance:readme-no-doubled-word` | pass | oracle satisfied (runs=2 pass=2) |
| `suite` | pass | the wall's own suite passed (runs=2 pass=2) |
| `holdout:01` | pass | scenario passed (runs=2 pass=2) |
| `delta` | pass | holdout pass rate did not regress against the base |
| `holdout:quality` | pass | 1 of 1 holdout scenarios distinguish the change from the base (max non-discriminating 0) |
| `scope`, `diff`, `test-surface`, `tests-weakened`, `irreversible` | pass | 1 changed path, inside `README.md`, no test surface, nothing irreversible |
| `class-certification` | pass | `1 delta samples; 1 of 20 attempts … insufficient evidence to certify at m=20 k=18 … so promotion requires a human signature` |

The last row is the honest part: the class `docs-hygiene` is not certified, this corpus has one
measurement, and the wall says so on every verdict it produces instead of claiming coverage. Promotion
therefore rests on the signature, which is the v1 design (`ADR-003`).

## 4. The patch applies, and the patch is what the corpus was checked against

Independent of the store, against a fresh clone of the mirror at the base revision:

```
git clone ~/.factory/real-intent-2026-11-07/mirror.git /tmp/ri-check2
git checkout d310644c4e68f55e2977210dbcef538edaca99a4
git apply --stat attempt.patch   → README.md | 2 +-   1 file changed, 1 insertion(+), 1 deletion(-)
git apply attempt.patch          → clean
node <corpus>/rules/readme-no-doubled-words.mjs → exit 0
node <corpus>/suite/readme-guard.mjs            → exit 0, FACTORY_SUMMARY {"passed":1,"failed":0}
npx prettier --check /tmp/ri-check2/README.md   → "All matched files use Prettier code style!"
```

The last line is a check the corpus does *not* contain: `pnpm run format:check` is a repository gate and
nothing in the wall runs it. It passes here, so the omission did not matter for this unit — it is recorded
because a corpus that cannot see the repository's own formatter will eventually pass a patch the repository
refuses.

## 5. Defect 7 and defect 8 — the verdict outlived its unit

The triage in §7 exposed a defect that had been in `status` since the beginning, and it is the reason the
backlog number never moved.

`apps/cli/src/render/status.ts` derived two things from the latest **verdict** row with no check on the
unit's state:

- the `initial_production_deploy` prompt (`verdictRow.outcome === 'pass' && promotionRow === null`), so a
  unit ended after a measured pass kept asking for a signature forever;
- the page state (`verdictRow.outcome === 'unknown' → pageState = 'unknown'`), so an ended unit with an
  unknown verdict kept counting as `unknown` in the one-line aggregate.

Evidence: ending 101 retired fixture units left `status` reading `105 need you · 2 unknown (not a pass)`
where the truth was `2 need you · 0 unknown`. After the fix (both derivations gated on `isTerminal()`,
with `lit_parked` exempt because it is a chore by definition) the same store reads:

```
0 in flight · 2 need you · 0 unknown (not a pass) · wall ok · store ok · principals single-uid ·
today $0.00/$20.00 default estimated · dispatch 0/1 attempt(s) default, 0/1 wall run(s) default
```

The gate on this tree: `bash scripts/verify.sh` → 7 passed, 1 skipped, 0 failed
(`docs/verification/2026-11-07T03-05-36Z/`, `117 passed | 2 skipped` test files, `1656 passed | 8 skipped`
tests). Two e2e specs assert the pair, and both were checked against the unfixed renderer: the promotion spec
fails (the gate is still there), the unknown-verdict spec fails with
`AssertionError: expected 'unknown' to be 'aborted'`. The panel already had both guards; only the CLI had
drifted, which is what a second implementation of the same projection does.

## 6. The promotion is the operator's step, and it is not done

The keypair exists (`~/.factory-operator-keys/`, private half `0600`, created 2026-11-07) and the public
half is published at `~/.factory/keys/operator.pub.pem` — the first published operator key in this store's
history, which is why no promotion was possible before it. What is **not** done is the signature:

```bash
bash ~/.factory/real-intent-2026-11-07/sign-and-promote.sh U-052939402fae
```

That script reads the latest verdict from the store, rebuilds the payload the gate asks for
(`contentHash({ unitId, verdictSha, approvedBy })`), prints it, signs it with the private key, and then runs

```
factory promote U-052939402fae --signature <sig> --signed-by operator --confirm "sign promotion U-052939402fae"
```

The typed phrase is the gate. The operator delegated this one invocation explicitly on 2026-11-07
("I approve your recommendations or for you to use your best judgement for these items: The signature —
bash ~/.factory/real-intent-2026-11-07/sign-and-promote.sh U-052939402fae"). The key is theirs and the
approval is theirs; the key operation was performed by the agent under that approval, which is a
different fact from a synthesized signature and is recorded here so nobody has to guess which it was.
The runbook's rule stands: the signature cannot be *invented*.

What was checked about that step, because an operator should not discover a broken handoff at the last
moment: the refusal path runs and writes nothing (`PROMOTION_UNSIGNED`, and
`~/.factory/artifacts/U-052939402fae/` still does not exist), and the payload it names is the payload an
independent computation produces — `sha256:a8d31900d5fa8a7866fdaea52150b03d9ceb645046eaa03fb6428a5c47b8aefc`,
i.e. `contentHash({unitId, verdictSha, approvedBy})`. That message needed a fix to be true: the CLI path
printed "requires a human signature" with no hash at all, while the runbook quoted the gates layer's
message (which does print one). The CLI now computes the payload once and names it in the message and in
the error details, so the runbook's transcript is the transcript the CLI actually prints.

The keypair was also exercised end to end *without* signing a promotion: a self-test payload
(`sha256:d7649b1787528d0e…`, not a verdict) was signed with the private half and verified against the
published public half — `true` — so the handoff cannot fail on an unreadable key or a mismatched pair.
The signature over the promotion payload itself is the one thing this document does not contain.

**It ran, and it wrote the first promotion this store has ever held:**

```
$ bash ~/.factory/real-intent-2026-11-07/sign-and-promote.sh U-052939402fae
payload  sha256:a8d31900d5fa8a7866fdaea52150b03d9ceb645046eaa03fb6428a5c47b8aefc
verdict  sha256:c0bc7807a08586a02487ea0d8b8fb8432456df471afbda817e8ff1f07df99337
sig      /Users/bo/.factory-operator-keys/promotion-U-052939402fae.sig
PROMOTION P-e968069a signed · sha256:e968069a… · wrote /Users/bo/.factory/artifacts/U-052939402fae/promotion.yaml
  apply           git apply /Users/bo/.factory/attempts/U-052939402fae/A-c77c48910bfd/attempt.patch
  inspect         factory audit U-052939402fae
  gate            first-promotion-only (this was the first signing of this unit)
```

The artifact (`promotion.yaml`) carries the promotion format, the unit, the verdict sha and outcome, the
attempt, the receipt-diff sha, `approved_by: operator`, the signing key id (`ed25519:85b955eb`), the
signature-payload sha and the signature itself, over a `promotion_sha` — every field above that line is
covered by the hash. The ledger row is `unit.promoted` (`sha256:a3469de0…`, verdict `V-c40f24ed88ac`),
and `status` fell from `2 need you` to `1` because the promotion stopped being a chore and became a fact.

**The patch was applied and verified twice, in two different places.** Against a fresh clone of the
mirror at the base revision `d310644`:

```
git apply --stat attempt.patch   → README.md | 2 +-   1 file changed, 1 insertion(+), 1 deletion(-)
git apply attempt.patch          → clean
node <corpus>/rules/readme-no-doubled-words.mjs → "readme-no-doubled-words: ok", exit 0
node <corpus>/suite/readme-guard.mjs            → FACTORY_SUMMARY {"passed":1,"failed":0,…}, exit 0
npx prettier --check /tmp/ri-final/README.md    → All matched files use Prettier code style!
```

and then in this repository, as commit `f6f581a` ("README: no progress-stall detector (the first
promoted change)"), which names the unit, verdict and promotion id. The line now reads
`- **No progress-stall detector** (IN #6).` — the admission survives, the doubled word does not.

## 7. The backlog triage (the reason `status` is readable again)

The live store held 106 fixture units: 101 verified, 4 rejected, 2 already aborted, plus the receipted
unknown from §2. Every verified one produced a "sign the first promotion" prompt, because the prompt was
derived from the verdict. All 101 were ended in one pass with the same recorded reason, which is a
decision an operator can audit:

> certification fixture unit: its verdict is evidence in the class certificate and stays in the ledger; no
> promotion was ever intended for fixture work. Ended 2026-11-07 in a bulk triage so that 'needs you'
> counts real work only.

The verdict rows are untouched: `samples` in the class certificates comes from the criteria log, not from
unit state, so ending the units could not and did not move a certificate. `audit --certifications` still
reads `3 of 3 classes current`. The two remaining `unknown` units were ended individually with reasons
that name what happened to them: the superseded corpus revision (§2), and a 2026-11-03 fixture whose
attempt receipted but whose verdict was never measured.

## 8. Branch housekeeping

`main` and `feat/dark-factory-dsh` had identical trees but different tips (`main` at the gated
`d310644`, the feature branch at the PR merge `1fc3ab8`, whose tree is
`5947929a1ff020dcd9881cb35bff568e8952f330` — the hash the PR body quotes). `main` was fast-forwarded to
the merge commit and pushed, and the local feature branch was moved to the same commit, so all four refs
(`main`, `feat/dark-factory-dsh`, `origin/main`, `origin/feat/dark-factory-dsh`) are `1fc3ab8`. The
launchd jobs run from this checkout on `main`, which now carries the merge line rather than a divergence
waiting to happen.

## 9. What this does not prove

- **Promotion, application, merge.** §6 is the boundary. `promotions` is still 0 rows as this is written.
- **A certified class for real repositories.** `docs-hygiene` has one measurement, and the corpus is
  repo-scoped by construction: it names README.md, so it cannot judge a second repository or a second
  class of change. The certified classes remain fixture classes.
- **The corpus sees the repository's own gates.** `format:check`, `typecheck`, `lint` and `vitest` are not
  in the corpus; a docs patch that breaks the formatter would pass the wall. Recorded, not fixed.
- **`samples` for the class.** One unit that passed does not certify anything, which the
  `class-certification` row says in words.

## 10. The `k = 18` ruling, with the numbers it needs

ND1 ratified `m = 20, k = 18, p0 = 0.95` before any class existed. The number that was published
alongside it is α = `0.07548367378849634297` — P(a class that truly passes 95% **fails** certification).
What was never published by a decision is the other half: how often the gate accepts a class that is
*worse* than 95%. `certificationRisk` computes it exactly, and re-run for this phase:

| operating point | accepts a truly-0.99 class | accepts 0.97 | accepts 0.95 | accepts 0.90 | accepts 0.85 | refuses a truly-0.95 class (α) |
| --- | --- | --- | --- | --- | --- | --- |
| **m=20, k=18 (shipped)** | 0.999 | 0.979 | 0.925 | **0.677** | 0.405 | 0.0755 |
| m=20, k=19 | 0.983 | 0.880 | 0.736 | 0.392 | 0.176 | 0.2642 |
| m=20, k=20 | 0.996 | — | 0.358 | 0.122 | 0.012 | 0.6415 |
| m=150, k=142 | 1.000 | 0.962 | 0.664 | **0.031** | 0.000 | 0.3362 |

Read the third row of the shipped line: **a class whose true pass rate is 90% is certified about two
times in three.** Raising `k` at m=20 does not fix that — it buys discrimination by refusing good
classes (k=19 rejects a truly-95% class 26% of the time). The reason is arithmetic, not taste: separating
p0=0.95 from p1=0.90 at α=0.05 and β=0.20 needs roughly 150 samples per class, so m=20 supports a
*screen* and cannot support a *test*.

The ruling this phase puts in front of the operator, in order of honesty:

1. **Say what the shipped certificate means.** At m=20/k=18 a certificate is evidence that no run has
   yet shown the class below ~0.90; it is not evidence that the class is at 0.95. That sentence belongs
   next to α in whatever surface quotes α, and it is the cheapest correct fix: no code changes, one
   sentence, and it stops the number from being read as stronger than it is.
2. **If a certificate must mean "not a 90% class", the sample has to grow** — m≈150, k≈142 does that
   (refuses a 0.90 class 97% of the time while still certifying a 0.97 class 96% of the time). It costs
   ~1.4 M tokens per class at the `docs-typo-fix` price (186,787 tokens for 20 units), which is the
   paid item in the plan's next slot and the only version of "the gate refused a class on merit" that
   could ever be true.
3. **Raising k alone does not help** (rows 2–3): it is all producer risk and no discrimination.

**Ruled 2026-11-07: keep `m=20, k=18`, and publish the missing half.** Recorded in the ratified record
(`findings.md` § DECIDED 2026-11-07) and implemented: `ACCEPTANCE_ALTERNATIVE_P` names the alternative,
every verdict's `class-certification` scenario prints `a class that truly passes 0.9 is certified anyway
with probability 0.67692680518946603571 (this operating point is a screen, not a test)`, and
`audit --certifications` prints the same sentence plus an `operatingPoint` block in its JSON. Three specs
pin the numbers: the α, the acceptance at k=16/17/18 (which is what makes "lowering k is stricter" a
falsifiable claim rather than a preference), and the verdict text.

## 11. The certificate's first consumer (item 4a, this round)

The plan's fourth item was "dispatch that consumes a class certificate — today a certificate gates
nothing". It was true: `class_certificates` had a writer (the wall, on every verdict), two readers
(`audit --certifications`, the staleness job) and no *gate*.

**The gate that was built:** `runUnit` reads the newest certificate for the class the wall will measure
under. If it says `not-certified` — `m` attempts judged, fewer than `k` passed — the dispatch is refused
with `CLASS_NOT_CERTIFIED` (exit 3), and the refusal quotes the certificate id and its counts. It happens
before the lease and the reservation, so a refused dispatch spends nothing, writes no attempt and leaves
no launch effect. `insufficient` never refuses: every first-of-class unit is insufficient by construction
and refusing it would make the factory unable to take the first unit of any class — the failure mode the
cold-start policy exists to prevent. `certified` proceeds.

**Why not gate everything on certification:** the live store's real work (`docs-hygiene`, 1 attempt) is
`insufficient`, and it is *supposed* to be. A gate that refused `insufficient` would have blocked the
first real intent in this same session, which is the difference between a gate and a wall.

**The wiring that makes it testable and non-drifting:** `EngineDeps` gained a required
`taskClass(spec)`, wired in the CLI to `taskClassFrom` (`apps/cli/src/task-class.ts`) — the same
derivation the wall uses to file a certificate. One function, two readers: a verdict and the gate that
reads its certificate cannot disagree about which class it is.

**Six specs** (`packages/core/src/engine.test.ts`): the refusal with its counts and exit code; nothing
left behind (no lease, no attempt, no reservation, no effect, unit still `qualified`); a certified class
dispatching; an insufficient certificate dispatching; and a bad certificate for a *different* class not
refusing anything. The store's fake gained `setClassCertificate` for this — the real store deliberately
has no such method, since a certificate is what a verdict carries, never something an operator asserts.

**Not done, and still open:** the refusal is observable in the error and the ledger's absence (no dispatch
event), but the *consumed certificate id* is not yet recorded on a successful dispatch — an engine event
payload change next round would make "which certificate authorised this attempt" a ledger fact rather than
an inference. And this gate has never fired on real evidence: no class has ever been measured
`not-certified`, so its first true firing is still ahead.

## 12. Scheduled re-certification (item 4b): built, and fenced on a per-class budget

The round list asks for "scheduled re-certification (needs your call on auto-spend, since it spends
without a person)". Built in full, with the spend fenced on the number that was missing:

| half | state | where |
| --- | --- | --- |
| detects a stale or never-certified class | **built** (earlier) | `factory alerts` → `CERT_STALE` / `CERT_NEVER`, severity `integrity`, one alert per class |
| runs on a schedule | **built** (earlier) | launchd `ai.factory.alerts` at 04:00 |
| projects what re-certifying would cost | **built this round** | `factory audit --certifications`: measured usage facts → median per attempt × attempts still needed |
| decides whether a spend is permitted | **built this round** | `apps/cli/src/recertify-plan.ts`, six named decisions |
| runs the attempts itself, on a schedule | **built this round, off by default** | `scripts/recertify-due.sh --spend` + launchd `ai.factory.recertify` at 05:00 |

**The plan, on the live store (2026-11-07):**

```
$ factory audit --certifications
  docs-hygiene  never-certified
  docs-typo-fix  current
  test-repair  current
  type-repair  current
  RE-CERTIFY docs-hygiene  19 attempt(s) to m=20  1453386 tokens projected
    (19 attempts × median 76494 over 2 measured)  refused-no-budget:
    no budget for docs-hygiene; set FACTORY_RECERTIFY_BUDGET_TOKENS=docs-hygiene=<tokens> to allow a spend
```

`1,453,386 tokens projected` is a *measurement*, not an extrapolation from another class: the certificate
names its verdicts, the verdicts name their attempts, and those attempts' metered usage facts give the
median. `refused-no-budget` is the shipped state.

**The six decisions**, each with a spec in `apps/cli/src/recertify-plan.test.ts`:

| decision | when | spends |
| --- | --- | --- |
| `not-due` | newest certificate current under the running policy and model | no |
| `would-spend` | due, measured projection within the class budget, units file present | **yes** |
| `refused-no-budget` | due, no budget for this class (default) | no |
| `refused-unknown-estimate` | due, no measured attempt behind the class | no |
| `refused-over-budget` | projection exceeds the class budget | no |
| `refused-no-units` | budget fits, no `<class>.txt` of pre-submitted units | no |

`refused-unknown-estimate` is L3 applied to money: an estimate that cannot be measured never authorises
a spend, so a class with no measured attempts is refused rather than spent against a guess — the same
rule as every other gate here, which is what makes it a rule and not a mood.

**Why the budget is per class and not one number.** Measured certificates in this store cost 186,787
tokens (`docs-typo-fix`, `test-repair`) and 1,944,675 (`type-repair`) — a 10× spread. One global cap
either starves the cheap class or lets the expensive one run unbounded, so the operator's control is a
map (`FACTORY_RECERTIFY_BUDGET_TOKENS="<class>=<tokens>,…"`), and a malformed entry is a usage error
rather than a silently dropped cap.

**What is deliberately not automated:** enabling the spend. The plist ships with the variable absent, so
the job reports and refuses nightly; turning it on is one line in
`deploy/launchd/ai.factory.recertify.plist` (documented in `docs/runbooks/certify-class.md` §10). The
specs that matter are the refusals: a refused class never reaches the driver, a plan that cannot be read
exits 9 without spending, and a failing driver stops the run instead of grinding through the next class.

**Not yet true:** this job has never spent anything — no class has ever had a budget set, and the live
plan is `refused-no-budget`. Its first real spend is an operator decision, and its first *successful*
spend is a fact nobody has observed yet.
