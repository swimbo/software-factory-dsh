# Runbook — certifying a task class (`docs-typo-fix`) at `m = 20, k = 18`

**Symptom.** `factory alerts` reports `CERT_NEVER` for every class, and `factory audit
--certifications` exits `9` with `never-certified`. That is not a bug: nothing has been measured.
A class certificate cannot be asserted, signed or inserted — it is written by `recordVerdict` when
the wall has judged `m` attempts of one class and `k` of them passed. The only way out of
`CERT_NEVER` is to run the class.

This runbook is the loop that spends the minimum and stops the moment the certificate becomes
impossible. The driver lives at [`../../scripts/certify-class.sh`](../../scripts/certify-class.sh);
the corpus layout is described in §3.

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
export FACTORY_HOLDOUT_ROOT="/path/outside/the/repo/holdout"     # the class corpus (§3)
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

## 2. Plan twenty units — and only twenty

A certificate needs `m = 20` measured attempts. Each attempt is one unit whose base revision is a
different commit of the docs repository and whose touch paths are `docs/`. One unit per revision, so
that twenty attempts are twenty _different trees_ and the certificate is about the class rather than
about one file.

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
the class rules: see §3 for why that gap is the point.

## 3. The corpus: five rules, outside the repo

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

## 4. Run the loop

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
| `9`  | not returned by the driver; `audit` uses it for "stale or never certified" | read `classes[].state` in the JSON (see §6)                       |

Named stop reasons: `failure-budget-exhausted`, `budget-refusal`, `environment-refusal`,
`unmeasured-attempt`, `terminal-error`, `operating-point-reached`, `units-exhausted`,
`credential-unavailable`.

## 5. What "fixed" looks like

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

## 6. What is dishonest or unattainable in this path

- **`audit --certifications` exits `9` even after an honest certification.** Its
  `uncertifiedUnits` list (in `apps/cli/src/verbs/audit.ts`, `certificateReport`) counts every
  verified/promoted unit whose _re-read_ verdict has no `certification` field — but `mapVerdict` in
  `packages/store/src/store.ts` deliberately does not persist that field ("read them with
  `classCertificates()` / `certificatesForClass()`"). So a verified unit can never satisfy the
  check, and the verb stays red while the class is `current`. **Read `classes[].state` in the JSON,
  not the exit code**, and treat `uncertifiedUnits` as a list of units whose verdict predates the
  certificate. The driver does exactly that. Reported, not patched, because the audit belongs to
  another package.
- **β is not measured.** Certifying a class that would regress is possible and unquantified.
- **α is a property of the point, not of the class.** 0.0755 says "an honest class is refused about
  one time in thirteen"; it says nothing about how often a bad class is accepted.
- **The corpus is written by the same side that is being certified.** It can only measure what its
  author thought of. A weaker but still discriminating corpus certifies a worse class.
- **Staleness is the only expiry.** Nothing re-runs a certification when the policy or model moves,
  and nothing raises an alert before a certificate goes stale — `audit --certifications` and
  `alerts` are commands someone has to run. **Not built**: a scheduled re-certification job.
- **`docs/runbooks/live-model.md` still says the batch driver is not built.** It is now built; that
  paragraph is out of date and should point here.
- **The offline proof measured the scripted executor.** The wall, store, criteria log, verdict and
  certificate path are real; the worker is not. The live path differs in exactly one way — a model
  makes the edits — and that is the part this suite cannot prove without spending.
- **A unit must be qualified dark before the loop.** The driver does not re-check the lane; a lit
  unit's `factory run` refuses with `LANE_NOT_DARK`, which the driver classifies as a terminal error
  and stops.

## 7. Per-unit cost model

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

## 8. The proof that this works, as measured

| Step                                | Command                                                             | Result                                                                                                                                                |
| ----------------------------------- | ------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------- |
| corpus loads, rules are class rules | `pnpm exec vitest run e2e/certification/substrate.test.ts`          | 4 passed — five rules fail every broken tree and pass every repaired tree; the corpus is outside the repo, absent from the prompt/launch record/clone |
| pass, reject, and accumulation      | `pnpm exec vitest run e2e/certification/pipeline.test.ts`           | 3 passed — `samples` 1 → 2 → 3 across three revisions; the almost-fixed patch is `holdout_failed` with a green visible suite                          |
| driver stop conditions              | `pnpm exec vitest run e2e/certification/driver.test.ts`             | 7 passed — including the mutation check: with the budget widened to `m - k + 1` the same plan runs past the third failure                             |
| the driver over real verdicts       | `pnpm exec vitest run e2e/certification/driver-integration.test.ts` | 1 passed — four dispatches, third failure, fifth unit has no attempt; the substituted credential's sentinel is in no stream and no file               |
| the certificate flips               | `pnpm exec vitest run e2e/certification/certification.test.ts`      | 2 passed — 20 real runs: `samples=19 passes=17 insufficient` → `samples=20 passes=18 certified`; `alerts` no longer reports `CERT_NEVER`              |

Before the `criteriaLog` wiring in `apps/cli/src/wall.ts` was fixed, the same loop produced one row
per run with `samples: 1` — the criteria log was created and discarded per evaluation, so
`countClassAttempts` only ever saw the live revision and no number of paid attempts could reach
`m`. The `1 → 2 → 3` sequence in the pipeline spec is that bug's regression test.

## Related

- [live-model.md](live-model.md) — the key, the gateway and the cost of a live turn.
- [certificate-expired.md](certificate-expired.md) — a certificate that exists but is stale.
- [budget-envelope-refusal.md](budget-envelope-refusal.md) — exit `6` from the loop.
- [evidence-expiry.md](evidence-expiry.md) — the morning check that reads `alerts`.
