# Runbook — certifying a task class (`docs-typo-fix`) at `m = 20, k = 18`

**Symptom.** `factory alerts` reports `CERT_NEVER` for every class, and `factory audit
--certifications` exits `9` with `never-certified`. That is not a bug: nothing has been measured.
A class certificate cannot be asserted, signed or inserted — it is written by `recordVerdict` when
the wall has judged `m` attempts of one class and `k` of them passed. The only way out of
`CERT_NEVER` is to run the class.

This runbook is the loop that spends the minimum and stops the moment the certificate becomes
impossible. The driver lives at [`../../scripts/certify-class.sh`](../../scripts/certify-class.sh);
the corpus layout is described in §4.

**What a class certificate is.** One row in `class_certificates`, written inside the same
transaction as the verdict that produced it: `task class`, `m`, `k`, `p0`, α, `samples`, `passes`,
`outcome`, the `policyVersion` and the `modelId`. The ratified point is `m = 20`, `k = 18`,
`p0 = 0.95`, α = 0.07548367378849634297. `outcome` is `certified` when `samples >= m` **and**
`passes >= k`; `insufficient` when `samples < m`; `not-certified` otherwise. `insufficient` is not
"probably fine" and `not-certified` is not "a warning".

**What it does not mean.** Read this before quoting a certificate upward.

| The certificate says      | What is actually true                                                                                                                                                                                                                                                                        |
| ------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `certified` at α = 0.0755 | _If_ this class truly passes `p0 = 0.95`, about one honest class in thirteen fails certification. α is a property of the operating point, identical for every class; it is **not** a measurement of this class and says nothing about production.                                            |
| `certified`               | Nothing about the probability of certifying a class that _regresses_. That is β, and **β is not measured**: there is no known-bad corpus to measure it against.                                                                                                                              |
| The holdout agreed        | The holdout is five rules its author wrote. It can only measure what that author thought of. A green certificate is a floor on class quality, not a proof of correctness — and an operator who controls the holdout store can write a weak-but-discriminating corpus the wall cannot detect. |
| Current                   | Current _under this policy version and this model id_. Change either and `certificateRecency` reports `stale` (`re-certify: …`); the old row is still true about the old world.                                                                                                              |
| Certified once            | Certified until the policy or the model changes. A later failing unit does **not** revoke it: `passes` never decreases, so once `passes >= k` the class stays certified in that store. A regression after certification is caught by the unit walls, not by the certificate.                 |
| `samples = 20`            | Twenty attempts were **accumulated**, not twenty consecutive units of the current tree. The row describes the measurement history, not today's code.                                                                                                                                         |

The offline proof below was run with a **scripted executor**: no model call, no network, no spend.
Nothing in this runbook was executed against a paid model in this tree's history, and the numbers
for a live run are labelled as estimates.

## 1. What you need before the loop

```bash
export PATH="$HOME/.nvm/versions/node/v$(cat .nvmrc)/bin:$PATH"   # 26.12.1, or preflight refuses
export FACTORY_HOME="$PWD/.factory-certification"                # the store that will hold the evidence
export FACTORY_HOLDOUT_ROOT="/path/outside/the/repo/holdout"     # the class corpus (§4)
export FACTORY_HOLDOUT_TASK_CLASS="docs-typo-fix"
export FACTORY_PRISTINE_REPO="/path/to/your-docs.git"            # a mirror git can clone from
export FACTORY_REPO="your-docs"
export FACTORY_MODEL_ID="<the model id the attempts run under>"
export FACTORY_LIVE_MODEL=1                                       # the consent switch: this run may spend
export FACTORY_PROXY_BASE_URL="https://…/openai/v1"
export DSH_BIN="/Applications/DeepSeek Harness.app/Contents/Resources/runtime/cli/bin/dsh"
```

`FACTORY_HOLDOUT_ROOT` must be **outside** the repository and outside every attempt clone
(`assertHoldoutOutsideRepo` enforces the first). The driver refuses to start without the corpus, the
class, and a `FACTORY_HOME` that already exists: a loop that cannot name what it is certifying is a
loop that will spend twenty units learning nothing.

The key reaches the controller, never the worker (see [live-model.md](live-model.md)): the driver
reads it **per run** — one `ssh -o BatchMode=yes hermes-control cat
/home/bo/.hermes/bifrost/program-secrets/software-factory-dsh/credential` per `factory run` — and
passes the value as `BIFROST_API_KEY` in the environment of that one child process. It is never
written to disk, never echoed, never in an argument vector, so it cannot appear in `ps` or in a
launch record. If your key is already in `$FACTORY_HOME/secrets/bifrost-key` (mode `0600`), skip the
SSH read:

```bash
export CERTIFY_KEY_COMMAND="cat $FACTORY_HOME/secrets/bifrost-key"
```

## 2. Materialise the artefacts (free, once)

Neither the corpus nor the twenty base revisions have to be written by hand. One script builds them
from this repository's own documentation, in about six seconds, with no model call and no store
write:

```bash
bash scripts/certification-artifacts.sh                                   # default root ~/.factory/certification
bash scripts/certification-artifacts.sh --root /tmp/cert --revisions 3    # a small set, for a dry run
```

It prints the `export` block to paste, and this is what it leaves behind:

| path                                        | what it is                                                                                                                                                     |
| ------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `docs/`                                     | the repository the worker edits: this repository's `docs/**/*.md` with five class violations planted into three files per commit, one commit per base revision |
| `docs.git/`                                 | a `--mirror` clone of it: the `FACTORY_PRISTINE_REPO` the wall clones                                                                                          |
| `holdout/docs-typo-fix/<revision>/`         | the corpus `loadHoldout` reads (§4), with its rule scripts and `manifest.json`                                                                                 |
| `spec-1.json … spec-<n>.json`, `restate.md` | one unit spec per base revision, and the restate-back text they bind                                                                                           |
| `plan-units.sh`                             | submits and qualifies those specs against `$FACTORY_HOME`, then writes `units.txt`                                                                             |
| `home/`                                     | an empty `FACTORY_HOME` for the loop; the store and the certificates end up here                                                                               |
| `README.md`, `certification-artifacts.json` | what each piece is, and the marker that makes the root rebuildable                                                                                             |

Three things it refuses, and each one is a certificate claim rather than tidiness:

- **a root inside the checkout** — a corpus inside the repository is a corpus the worker can read;
- **a non-empty directory it did not build** — it deletes and replaces its own root, nothing else;
- **finishing if a planted revision stops violating all five rules** — a corpus that passes a
  defective tree certifies nothing, so the build measures its own output before it returns.

Documents of this repository that already break a class rule are dropped from the copy at build time
and listed in `certification-artifacts.json`: broken relative links, `TODO` markers in prose, and
everything that links to a dropped file. At the time of writing 48 of the 81 markdown files here do
not survive that filter, and the number moves with the docs — that is a fact about these docs, not a
defect of the build. The fixture is the subset that can honestly be repaired.

The build never calls `intent` or `qualify`. A unit id only exists once the store has been written,
and materialising artefacts has to stay repeatable and free: that is what `plan-units.sh` is for, and
why it is emitted rather than run.

## 3. Plan twenty units — and only twenty

A certificate needs `m = 20` measured attempts. Each attempt is one unit whose base revision is a
different commit of the docs repository and whose touch paths are `docs/`. One unit per revision, so
that twenty attempts are twenty _different trees_ and the certificate is about the class rather than
about one file.

If you materialised the artefacts in §2, `<root>/plan-units.sh` is this section in executable form:
run it against the `FACTORY_HOME` from that root and skip to §5. What follows is the same planner
spelled out, for a corpus and a docs repository you built yourself.

```bash
cat > restate.md <<'TEXT'
You asked for: repair the documentation — a repeated word, a broken relative link, a duplicated heading, an unclosed code fence and a leftover TODO. Not asking for: a code change or a dependency upgrade.
TEXT
: > units.txt
n=0
for rev in $(git -C /path/to/your-docs rev-list --reverse HEAD -- docs | tail -n 20); do
  n=$((n + 1))
  cat > "spec-${n}.json" <<JSON
{
  "slug": "docs-typo-fix",
  "revision": ${n},
  "repo": "your-docs",
  "baseRev": "${rev}",
  "intent": "Repair the documentation: a repeated word, a broken relative link, a duplicated heading, an unclosed code fence and a leftover TODO.",
  "restateBack": "You asked for: repair the documentation — a repeated word, a broken relative link, a duplicated heading, an unclosed code fence and a leftover TODO. Not asking for: a code change or a dependency upgrade.",
  "acceptance": [
    { "id": "docs-check", "text": "node tools/check-docs.mjs exits 0",
      "oracle": { "kind": "command", "target": "node tools/check-docs.mjs", "expect": "exit 0" } }
  ],
  "touchPaths": ["docs/"],
  "operationClasses": ["code-change"],
  "sizeBudget": { "files": 8, "lines": 200 },
  "budgetEstimateUsd": 0.05
}
JSON
  node apps/cli/src/main.ts intent --file "spec-${n}.json" --restate restate.md --json | jq -r .unitId >> units.txt
done
# qualify each unit dark. `--cold-start` is a policy decision, not a measurement: the class has no
# measured history before the first verdict, and the flag is printed as such on every decision.
while read -r unitId; do node apps/cli/src/main.ts qualify "$unitId" --cold-start --json >/dev/null; done < units.txt
wc -l units.txt    # 20
```

`revision` must be unique per `(repo, slug)` — the store's unit identity is `(repo, slug, revision)`,
so twenty attempts are revisions 1…20 of the same slug. `restate.md` must contain exactly the
`restateBack` sentence: the intent verb hashes it into the mandate and refuses a mismatch, and the
qualifier's restate-back check is a token-overlap floor of 0.5, so the restatement has to name the
same task in the same words. The
`acceptance` oracle is the _visible_ check — the wall re-runs it on the candidate. It is a subset of
the class rules: see §4 for why that gap is the point.

## 4. The corpus: five rules, outside the repo

`FACTORY_HOLDOUT_ROOT/<task-class>/<revision>/` holds a `manifest.json` (with `revisionHash`) and
one script per rule; `loadHoldout` refuses an absent, empty or corrupt store, and a refusal is
`unknown`, never `pass`. The corpus in this tree's proof is
[`../../e2e/certification/docs-substrate.ts`](../../e2e/certification/docs-substrate.ts): five rules,
each an argv plus its expected exit code —

| rule                     | what it refuses                                  |
| ------------------------ | ------------------------------------------------ |
| `no-doubled-words`       | a word immediately repeated in prose (`the the`) |
| `relative-links-resolve` | a `./file.md` link whose target does not exist   |
| `headings-unique`        | the same heading twice in one document           |
| `code-fences-balanced`   | an unclosed ` ``` ` fence                        |
| `no-todo`                | a leftover `TODO` marker                         |

Each rule fails on **every** base revision and passes on the repair, which is what the wall's
`maxNonDiscriminating = 0` requires: a scenario that passes the base revision proves nothing about
the change. The visible check in the repository (`tools/check-docs.mjs`) covers two of the five; a
candidate that satisfies it and leaves the link broken is a `holdout_failed` verdict with a green
visible suite, and that is asserted in
[`../../e2e/certification/pipeline.test.ts`](../../e2e/certification/pipeline.test.ts).

The corpus is never in the prompt, the launch record or the attempt clone, and the verdict
anonymises the scenario ids (`holdout:01` … `holdout:05`). That is asserted against a real clone in
[`../../e2e/certification/substrate.test.ts`](../../e2e/certification/substrate.test.ts) — the worker
cannot read the measurement.

## 5. Run the loop

```bash
bash scripts/certify-class.sh --units-file units.txt
```

One `factory run` per unit, in file order. Per unit it prints the unit id, the exit code, the
outcome, and the running `passes/failures/attempts`; at the end it prints the store's own answer from
`factory audit --certifications --json`. It never passes `--force`, `-y` or any bypass (there is no
such flag: an unknown argument is exit `2`), and it never retries a unit.

The units file may only contain units that have **not** been run: a decided unit is terminal and
`factory run` refuses it (`UNIT_ALREADY_TERMINAL` — v1 has no retry path), which the driver treats as
a terminal error and stops. If you validate one unit by hand first, drop it from the file and let the
loop measure the remaining ones; the audit's `samples` counts revisions, so 1 + 19 still reaches 20.

**The stop condition is arithmetic.** `m - k = 2` failures can still be certified: 18 passes out of
20 attempts. The **third** failure makes `passes >= k` impossible — at most 17 of 20 can pass — so the
loop stops. That is `m - k + 1`, derived in the script from
`DEFAULT_OPERATING_POINT` in `packages/wall/src/operating-point.ts`, not hardcoded, so changing the
ratified point moves the stop condition with it.

| Exit | Meaning                                                                    | What to do                                                        |
| ---- | -------------------------------------------------------------------------- | ----------------------------------------------------------------- |
| `0`  | the store reports a **current** certificate for the class                  | done; record the `samples`/`alpha` you were given                 |
| `1`  | the loop ended without a certificate (impossible, or too few attempts)     | read the stop reason and the audit line; do not rerun blind       |
| `2`  | usage: missing corpus/class/home, unreadable units file, unusable manifest | fix the configuration, nothing was spent                          |
| `5`  | an attempt came back `unknown` or needing a person                         | read that unit's verdict; the driver does not guess it was a pass |
| `6`  | `factory run` refused the budget (`BUDGET_EXCEEDED`)                       | [budget-envelope-refusal.md](budget-envelope-refusal.md)          |
| `8`  | the executor, mirror or credential was unusable — nothing was dispatched   | check `dsh`, the mirror, the key command                          |
| `9`  | not returned by the driver; `audit` uses it for "stale or never certified" | read `classes[].state` in the JSON (see §7)                       |

Named stop reasons: `failure-budget-exhausted`, `budget-refusal`, `environment-refusal`,
`unmeasured-attempt`, `terminal-error`, `operating-point-reached`, `units-exhausted`,
`credential-unavailable`.

## 6. What "fixed" looks like

After twenty measured attempts (eighteen passing, two refused by the holdout):

```
certificate: class docs-typo-fix state=current outcome=certified samples=20 m=20 alpha=0.07548367378849634297
```

and `factory alerts` stops reporting `CERT_NEVER` for that class. The alerts verb reads the
projection through `certificatesRecency`; a certified row under the running policy and model makes
the class current, and the alert disappears. That is the acceptance for this runbook, and it is
asserted end-to-end (20 real runs, scripted executor) in
[`../../e2e/certification/certification.test.ts`](../../e2e/certification/certification.test.ts).

If the loop stopped with `failure-budget-exhausted`, the honest reading is that the wall cannot
distinguish this class at this operating point. The fix is a better holdout or a better task class,
not more attempts: re-running until it goes green is p-hacking the wall.

## 7. What is dishonest or unattainable in this path

- **`audit --certifications` used to exit `9` after an honest certification — fixed, and pinned.**
  Its `uncertifiedUnits` list (in `apps/cli/src/verbs/audit.ts`, `certificateReport`) asked each
  verified/promoted unit's _re-read_ verdict whether it carried a `certification` field, but
  `mapVerdict` in `packages/store/src/store.ts` deliberately strips that field, so no unit could
  ever satisfy the check and the verb said `STALE OR NEVER CERTIFIED … of … entries` forever. It now
  asks the certificate projection instead — did this verdict leave a row behind — and
  `e2e/certification/certification.test.ts` asserts the three things an operator reads: exit `0`,
  `uncertifiedUnits: []`, and no `STALE OR NEVER CERTIFIED` on stderr. Reverting that line reddens
  the spec with the old line and exit `9` (measured: `18 of 19 entries` on a store with one rejected
  unit). The driver still reads the store's `state` rather than the exit code, which stays correct
  if the report is ever wrong again. One residual: `uncertifiedUnits` now means "a verified unit
  whose verdict left no class-judgement row at all", not "a unit measured before `m` was reached" —
  every verdict leaves a row, so a store at 3 of 20 samples reports an empty unit list and is kept
  red by the class-level `never-certified` line instead. Covering both readings would mean asking
  the projection for a row with `outcome: 'certified'` under the running basis, per unit's class;
  that is a change to the audit, not to this loop.
- **A dispatch ceiling no longer changes the policy identity (fixed, pinned).**
  `maxConcurrentAttempts`/`maxConcurrentWalls` used to be fields of `QualifierPolicy`, and
  `currentPolicyVersion` hashes the whole object — so a loop that raised the attempt ceiling to run
  more than one attempt at a time minted its certificate under a digest the default environment could
  never reproduce, and `audit --certifications` called a perfectly-current certificate `stale` every
  morning. The ceilings now live in `OperatorLimits` (`apps/cli/src/context.ts`, `resolveLimits`), read
  from the same variables and hashed into nothing; the rules alone hash to `sha256:a368cc6f…` where
  they used to hash to `sha256:6ce54b93…`. The digests the old projection produced are _recognised_,
  not recomputed: `legacyPolicyVersions()` re-derives `contentHash({...rules, ceilings})` over
  `1..64 × 1..64` (4096 hashes, ~11 ms, on `audit`/`alerts` only) and a stored digest in that set is
  "these rules, different limits". The live certificate (`sha256:1f052e46…`, recorded at ceiling 4)
  therefore reads `current`, exit 0, with no re-run. Residuals: the recognition is bounded — above 64
  concurrent attempts or walls a certificate stays `stale` (fail-closed, re-certify); it accepts any
  ceiling but only these rules; and it is a bridge for evidence written before the split, to be
  deleted once no stored certificate carries a pre-split digest.
- **A certificate cannot borrow another policy's or model's measurement history (fixed, pinned).**
  `CriteriaLogEntry` recorded no policy identity, and `countClassAttempts` filtered on class +
  holdout revision only, so one attempt under a new `policyVersion` counted twenty logged revisions
  measured under the old one and could mint a `certified` row for a policy that had measured one
  attempt. Every entry now records `policyVersion` and `modelId`, and both the class count and the Δ
  sample count read only entries measured under the running identity. Lines written before the field
  existed are reported as `legacyLines` and **skipped** — never counted, and _not_ corrupt: the live
  log holds 240 of them, and treating them as corruption would degrade the discrimination control to
  `unknown`, and therefore every future verdict, forever. Consequence, deliberate: the count restarts
  at 1 on the first attempt after the change, so a class certified before it needs twenty fresh
  attempts to be re-certified — the pre-change attempts cannot be attributed to a policy, and
  `unknown` is the honest reading.
- **`audit --certifications` prints the counts of the row its state came from (fixed, pinned).**
  A class keeps every certificate row it ever wrote, and a newer `insufficient` attempt does not
  un-certify it; the verb now reports the judged row's `outcome`/`samples` (`judgedCertificate`), so
  `state: current` can never be printed beside `samples: 1`.
- **Nothing checks that the certificate was earned on a _varied_ corpus.** The artefacts script
  refuses a revision whose planted defects stop discriminating, but a weaker corpus that still
  discriminates is undetectable from the outside — see the next bullet.
- **β is not measured.** Certifying a class that would regress is possible and unquantified.
- **α is a property of the point, not of the class.** 0.0755 says "an honest class is refused about
  one time in thirteen"; it says nothing about how often a bad class is accepted.
- **The corpus is written by the same side that is being certified.** It can only measure what its
  author thought of. A weaker but still discriminating corpus certifies a worse class.
- **Staleness is the only expiry.** Nothing re-runs a certification when the policy or model moves,
  and nothing raises an alert before a certificate goes stale — `audit --certifications` and
  `alerts` are commands someone has to run. **Not built**: a scheduled re-certification job.
- **The artefacts are a snapshot of these docs, not of yours.** `scripts/certification-artifacts.sh`
  copies `docs/**/*.md` as they are on disk today; a docs change after the build makes the fixture
  and the repository disagree. Rebuild (`--root` is disposable) before a loop you intend to trust.
- **The offline proof measured the scripted executor.** The wall, store, criteria log, verdict and
  certificate path are real; the worker is not. The live path differs in exactly one way — a model
  makes the edits — and that is the part this suite cannot prove without spending.
- **A unit must be qualified dark before the loop.** The driver does not re-check the lane; a lit
  unit's `factory run` refuses with `LANE_NOT_DARK`, which the driver classifies as a terminal error
  and stops.

## 8. Per-unit cost model

One unit is one attempt: one model turn over one or two steps. The only live measurement on record
is ~12.7k tokens for one docs unit
(`docs/planning/dark-factory-dsh/evidence/phase-9b-live-model-probe.md`), so **a certificate is
roughly 254k tokens** at that rate, and the envelope is what makes it safe: each unit reserves its
`budgetEstimateUsd` before dispatch and a run that would cross the envelope exits `6` before any
call. The driver treats `6` as a stop, not a retry.

- A certificate needs **exactly 20 attempts** — `samples < m` is `insufficient` however many pass.
- A doomed class needs as few as **3** (the third failure), never more than 20.
- The offline proof's unit cost was 2.5–3.7 s of wall work per attempt (21 units in ~85 s), all of it
  free: mirror clone, attempt clone, receipt, faithfulness replay, five holdout scenarios on both
  sides, the visible suite, and the store write.

## 9. The proof that this works, as measured

| Step                                | Command                                                             | Result                                                                                                                                                                                                   |
| ----------------------------------- | ------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| corpus loads, rules are class rules | `pnpm exec vitest run e2e/certification/substrate.test.ts`          | 4 passed — five rules fail every broken tree and pass every repaired tree; the corpus is outside the repo, absent from the prompt/launch record/clone                                                    |
| pass, reject, and accumulation      | `pnpm exec vitest run e2e/certification/pipeline.test.ts`           | 3 passed — `samples` 1 → 2 → 3 across three revisions; the almost-fixed patch is `holdout_failed` with a green visible suite                                                                             |
| driver stop conditions              | `pnpm exec vitest run e2e/certification/driver.test.ts`             | 7 passed — including the mutation check: with the budget widened to `m - k + 1` the same plan runs past the third failure                                                                                |
| the driver over real verdicts       | `pnpm exec vitest run e2e/certification/driver-integration.test.ts` | 1 passed — four dispatches, third failure, fifth unit has no attempt; the substituted credential's sentinel is in no stream and no file                                                                  |
| the certificate flips               | `pnpm exec vitest run e2e/certification/certification.test.ts`      | 2 passed — 20 real runs: `samples=19 passes=17 insufficient` → `samples=20 passes=18 certified`; `audit --certifications` exits `0` with `uncertifiedUnits: []`; `alerts` no longer reports `CERT_NEVER` |
| the persistent artefacts            | `pnpm exec vitest run e2e/certification/artifacts.test.ts`          | 6 passed — three revisions built in a temp root: every base fails all five rules and the visible check, the repair target passes both, the corpus loads and is absent from the repository's history      |

Before the `criteriaLog` wiring in `apps/cli/src/wall.ts` was fixed, the same loop produced one row
per run with `samples: 1` — the criteria log was created and discarded per evaluation, so
`countClassAttempts` only ever saw the live revision and no number of paid attempts could reach
`m`. The `1 → 2 → 3` sequence in the pipeline spec is that bug's regression test. The same is true of
the audit's projection join described in §7: both were found by running the loop, and both now have a
spec that goes red when the fix is reverted.

## Related

- [live-model.md](live-model.md) — the key, the gateway and the cost of a live turn.
- [certificate-expired.md](certificate-expired.md) — a certificate that exists but is stale.
- [budget-envelope-refusal.md](budget-envelope-refusal.md) — exit `6` from the loop.
- [evidence-expiry.md](evidence-expiry.md) — the morning check that reads `alerts`.
