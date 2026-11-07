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

The typed phrase is the gate. **No machine ran this**: a signature that an agent can mint is not a human
gate, and the runbook says so (`docs/runbooks/rotate-operator-key.md`, "The signature cannot be
synthesized"). Until it runs, the honest status of this phase is: measured and verified, not promoted.

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

What follows after the signature, in the order to do it: the promotion writes
`$FACTORY_HOME/artifacts/<unit>/…/promotion.yaml` and `change.patch`; apply the patch to a clone of
`main`, run `pnpm run typecheck && pnpm run lint && pnpm run format:check` on it, and then it is a normal
one-line docs change to land.

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
