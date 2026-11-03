# Phase 18 — the first class certificate, earned live

**Date:** 2026-11-03 (03:43–04:12Z). **Store:** `/Users/bo/.factory`. **Class:** `docs-typo-fix`.
**Outcome:** `class_certificates` row `cert:V-c81459fcb68a` — `samples=20 passes=19 outcome=certified`,
`policyVersion sha256:1f052e46…`, `modelId auto`, `alpha 0.07548367378849634`, `m 20`, `k 18`.

Every morning until today the operator's job reported `CERT_NEVER` and exited 9. That was not a
bug: no class had ever been measured. This round measured one, with a live model, against a real
git repository, and found five defects on the way — three of which made a certificate impossible
to earn, and two of which would have made one dishonest to believe.

## 1. What was measured

| stage                                     | what ran                                                                                                                         |
| ----------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------- |
| artefacts (`~/.factory/certification`)     | `docs/` — 21 commits built from this repository's own markdown, 20 of them carrying the class's five defects; `docs.git` mirror; hidden five-rule corpus `h-docs-typo-real-2026-11-02` |
| plan (`plan-units.sh`)                    | 20 units submitted (`intent`) and qualified dark (`qualify --cold-start`), one per base revision                                |
| loop (`scripts/certify-class.sh`)         | one live `factory run` per unit, stop at the third failure                                                                      |
| wall                                      | holdout + pinned visible check + receipt re-execution, per attempt                                                              |

The progression is the evidence, not the last row. From the store, in order:

| verdict             | samples | passes | outcome      |
| ------------------- | ------- | ------ | ------------ |
| `V-a3747b34ca8e`    | 1       | 0      | insufficient |
| `V-f865dab02337`    | 2       | 1      | insufficient |
| …                   | …       | …      | …            |
| `V-5911878b9843`    | 19      | 18     | insufficient |
| `V-c81459fcb68a`    | 20      | 19     | **certified** |

Seventeen consecutive passes in one driver invocation (04:00–04:04Z), then two more units on base
revisions the log had never seen, to reach the operating point. The one non-pass is
`V-a3747b34ca8e`: an `unknown` verdict caused by my own configuration error (§4.5), which counts as
a sample and not as a pass — the honest arithmetic, not a rounding of it.

A certificate needs `samples >= m` (20) **and** `passes >= k` (18). `m` counts *distinct base
revisions judged*, not attempts launched: four units that reused an already-measured base revision
were judged, passed, and moved the count by zero. That is why the last two units had to be built on
revisions the log had never seen.

## 2. Why this could not have been earned before this round

Three defects, all in code paths the offline suite covered with a fixture that supplied the missing
piece directly.

### 2.1 The wall never passed its criteria log (`apps/cli/src/wall.ts`, fixed `193bbff`)

`evaluateReceipt()` called `evaluate()` without a `criteriaLog` port. The package tests construct
that port themselves (`packages/wall/src/evaluate.test.ts`), so the whole suite was green while
every real verdict counted as the class's first sample. Measured, before the fix: two successful
units of one class in one store produced **two** rows of `samples=1 passes=1 insufficient`. Twenty
paid units would have produced twenty such rows and no certificate.

### 2.2 `factory audit --certifications` could never go green (`apps/cli/src/verbs/audit.ts`, fixed `1f96260`)

`certificateReport()` decided "this verdict carried a certificate" by reading
`verdict.verdict.certification` — a field `mapVerdict` strips on purpose, because the promotion
signature is computed over that object. Every verified unit was therefore reported as uncertified
forever. Measured on the first 20-run store: `STALE OR NEVER CERTIFIED 20 of 21 entries`, exit 9,
while the class row itself said `certified`. The question now goes to the projection that holds the
answer (the verdict ids the `class_certificates` rows were written from), and
`e2e/certification/certification.test.ts` pins it end to end; reverting the line reddens that spec
with the same 18-of-19 line.

### 2.3 The driver measured one unit out of twenty, twice (`scripts/certify-class.sh`, fixed `a35f74f`)

The loop reads the units file on stdin. Two children inherited that descriptor: the per-run
credential read (`ssh` reads stdin) and the worker launch (`dsh` read the rest of the plan). Each
live invocation therefore ran exactly one unit and reported `units-exhausted` with eighteen lines
still in the file — a stop reason that reads like an exhausted plan and was in fact an eaten one.
Both children now get `</dev/null`, with the reason in a comment next to the line. The offline proof
could not catch this: its stub key command and scripted executor read nothing.

## 3. The certificate is honest, and **current** after this round's two fixes

> Written live and then amended: §3 and §6 as first recorded described two open defects. Both are
> now fixed (owner `certifier`), gated, and the acceptance command `FACTORY_HOME=/Users/bo/.factory
> node apps/cli/src/main.ts audit --certifications` prints `docs-typo-fix current` and exits 0 with
> no `FACTORY_MAX_CONCURRENT_ATTEMPTS` set.

### 3.1 Dispatch ceilings are no longer part of the policy identity (fixed)


`factory audit --certifications` with the defaults reports:

```
docs-typo-fix  stale
  re-certify: policy changed (certified under sha256:1f052e46…, running sha256:6ce54b93…)
```

and with `FACTORY_MAX_CONCURRENT_ATTEMPTS=4` — the envelope the loop ran under, because two
abandoned attempts held live leases and the default ceiling is 1 — it reports `current`.

`resolvePolicy` used to fold the two dispatch ceilings (`maxConcurrentAttempts`,
`maxConcurrentWalls`) into the object `currentPolicyVersion()` hashes. The ceilings now live in a
separate `OperatorLimits` object (`apps/cli/src/context.ts`, `resolveLimits`), read from the same
variables and hashed into nothing; the rules alone hash to `sha256:a368cc6f…` where they used to
hash to `sha256:6ce54b93…`. Because a pure identity change cannot make a row recorded under the old
12-key object `current`, `legacyPolicyVersions()` recognises the digests the old projection could
have produced for *these rules* at any ceiling `1..64` (4096 hashes, ~11 ms, on `audit`/`alerts`
only). The live certificate (`sha256:1f052e46…`, recorded at ceiling 4) is in that set and reads
`current`. The recognition is bounded and fail-closed (a ceiling above 64 stays `stale`, and a
different rule set's digest is never recognised); it is a bridge to be deleted once no stored
certificate carries a pre-split digest.

## 4. Defects and incidents, recorded rather than smoothed

1. **`FACTORY_MODEL_API` is load-bearing and undocumented in this path.** The first paid unit
   dispatched, launched `dsh`, and the worker got `401 unknown-token`: the overlay pointed at the
   factory's own proxy, but with no model API named the provider shape did not send the scoped
   token. The recipe that works is the one the live spec uses —
   `FACTORY_MODEL_API=openai-completions`. Two units were burned learning it; the second (the
   `unknown` verdict) is the one non-pass in the certificate.
2. **A failed launch still leaves the unit `dispatched`.** `recover` refuses to reconcile a live
   lease and never re-dispatches, and a dispatched unit refuses a second run
   (`UNIT_ALREADY_TERMINAL`). Three units were lost to environment failures before the loop
   started: `U-06de2401ecd5`, `U-877113a670a2` (both `EXECUTOR_UNAVAILABLE`) and `U-792579de39f7`
   (the 401). Their launch effects stay `pending` with 45-minute leases; a `recover` after expiry
   resolves them to `ambiguous` — evidence, not a retry.
3. **`samples` counts revisions, not attempts** — discovered the expensive way, after four units
   were spent on bases the log had already measured. The driver cannot know this before the first
   verdict; a planner that reuses base revisions should say so.
4. **Cost is not measurable here.** No billing-grade telemetry: `cost_usd` is `null` on every usage
   row. What is recorded is 23 attempts, 6,419,027 input tokens and 155,692 output tokens
   (6,574,719 total; per attempt 120k–453k input). The earlier per-unit estimate of ~12.7k tokens
   (phase-9b) was a single short probe and is wrong by more than an order of magnitude for a real
   documentation task. The self-imposed ceiling was $2 per attempt and $10 for the round; I cannot
   prove either from this store, only the token counts, and saying "under budget" on the strength
   of an unmeasured price would be exactly the kind of claim this repository exists to refuse.

## 5. What the certificate does not mean

- **α = 0.0755 is not a measurement of this class.** It is the operating point's false-refusal
  risk for a class that truly passes `p0 = 0.95`: about one honest class in thirteen fails.
- **β is unmeasured.** There is no known-bad corpus, so the probability of certifying a class that
  regresses is unknown.
- **The holdout is five rules I asked for and a teammate wrote.** It can only measure what its
  author thought of, and it is not in the repository, not in the prompt, not in the launch record
  and not in the attempt clone (asserted against a real clone in
  `e2e/certification/substrate.test.ts`).
- **One class, one model id, one policy version, one corpus revision.** Change any of them and the
  row is `stale`; nothing re-certifies automatically, and a later failing unit does not revoke it.
- **The work was documentation repair on a copy of this repository's markdown**, not this
  repository's live docs. The class claim is about the kind of task, not about this tree.

## 6. What remains open, after the fixes

1. **The criteria log is now policy- and model-scoped, with a deliberate cost.** Every entry records
   `policyVersion` and `modelId`, and both the class count and the Δ-sample count read only entries
   measured under the running identity. Lines written before the field existed (240 in the live log)
   are reported as `legacyLines` and skipped — never counted, and not corrupt, because calling them
   corrupt would degrade the discrimination control to `unknown` forever. Consequence: the next
   attempt on this class counts `samples=1`, so re-certifying after this change needs twenty fresh
   attempts. The class stays `current` meanwhile because the judgement still finds the older
   `certified` row.
2. **β remains unmeasured** — there is still no known-bad corpus.
3. `docs/runbooks/certify-class.md` §7 now carries the three fixes; `live-model.md` still needs the
   `FACTORY_MODEL_API=openai-completions` requirement stated where an operator reads it.
