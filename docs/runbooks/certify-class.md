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

| The certificate says      | What is actually true                                                                                                                                                                                                                                                                                                                                                                 |
| ------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `certified` at α = 0.0755 | _If_ this class truly passes `p0 = 0.95`, about one honest class in thirteen fails certification. α is a property of the operating point, identical for every class; it is **not** a measurement of this class and says nothing about production.                                                                                                                                     |
| `certified`               | Nothing about how often a class that _would regress_ is certified in general — that rate is still unmeasured. β(p), the chance that a class whose true pass rate is `p` is certified, **is** computable (`P(Binomial(m, p) ≥ k)`; table in §6), and the corpus's detection of planted regressions is counted there too: 5 of 5 single-rule, 3 of them invisible to the visible check. |
| The holdout agreed        | The holdout is five rules its author wrote. It can only measure what that author thought of. A green certificate is a floor on class quality, not a proof of correctness — and an operator who controls the holdout store can write a weak-but-discriminating corpus the wall cannot detect.                                                                                          |
| Current                   | Current _under this policy version, this model id and this corpus_. Change any of the three and `certificateRecency` reports `stale` (`re-certify: …`); the old row is still true about the old world.                                                                                                                                                                                |
| Certified once            | Certified until the policy, the model or the class's corpus changes. A later failing unit does **not** revoke it: `passes` never decreases, so once `passes >= k` the class stays certified in that store. A regression after certification is caught by the unit walls, not by the certificate.                                                                                      |
| `samples = 20`            | Twenty attempts were **accumulated**, not twenty consecutive units of the current tree. The row describes the measurement history, not today's code.                                                                                                                                                                                                                                  |

**What a certificate names.** A `class_certificates` row is the statement "this class, at this
operating point (`m`, `k`, `p0`, α), under this policy version, this model id and this holdout corpus,
met k of m". The identity is stored (`policy_version`, `model_id`, `holdout_revision`) and all three
world-state inputs are re-checked by `certificateRecency`:

| The reason line says | What changed                                                                                                                                                                                                                          |
| -------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `policy changed`     | the wall's rules or operating point moved — the digest of the policy the certificate was minted under is not the running one                                                                                                          |
| `model changed`      | `FACTORY_MODEL_ID` moved; the certificate describes one model's behaviour                                                                                                                                                             |
| `model unknown`      | the row never recorded a model id (offline, or before the wiring); `null` is unknown, never "unchanged"                                                                                                                               |
| `corpus changed`     | the class was re-measured under a different holdout corpus: the certificate is compared with the newest measurement of the class that names one                                                                                       |
| `corpus unknown`     | the certificate names no corpus and its verdict names none either — it predates schema v5 and the migration had nothing to copy. It cannot prove which evidence it describes, so it is stale by definition, never current by wildcard |

`audit --certifications` prints the two facts a corpus reason is drawn from, for every stale class:

```
  test-repair  stale
    re-certify: corpus changed (certified under h-test-repair-real-2026-11-03, latest measurement under h-test-repair-real-2026-11-04)
    certified sha256:a368cc6f… under h-test-repair-real-2026-11-03; latest measurement under h-test-repair-real-2026-11-04
```

The ids above are from the run before the corpora were content-addressed; a rebuild now appends the
`-<8hex>` digest suffix to the corpus name, so the same reason line will show the suffixed form (§4 of
[certify-class-test-repair.md](certify-class-test-repair.md) says why the suffix is an identity and the
date is not).

`corpus unknown` prints `under an unnamed corpus (this certificate predates corpus attribution);
latest measurement under no named corpus` when nothing of the class has ever named one. The store
never infers the corpus: a `NULL` is not a wildcard, and the row — not the verdict it points at — is
what the audit judges, because the row is what the certificate claims.

**Where a pre-v5 row's corpus comes from.** The column was added in schema v5 and **backfilled from
the verdict each certificate names** (`cert.verdict_id → verdicts.holdout_revision`, an exact join
onto the row that produced the certificate — the same bounded bridge as `legacyPolicyVersions()` for
pre-split policy digests). So a certificate written before the column existed is attributed when its
verdict names a corpus, and is **not** declared stale merely because a column was added. The bound is
strict: the fill reads that verdict and nothing else — never the class's newest verdict, never a
default — and a certificate whose verdict names no corpus, or is not in the table at all, stays
`NULL` and reads stale. **Delete the backfill statement** (`CLASS_CERTIFICATES_CORPUS_BACKFILL` in
`packages/store/src/schema.ts`) once no readable row predates v5; it is a bridge, not part of the
schema's steady state.

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
export FACTORY_MODEL_API="openai-completions"                     # the proxy's wire shape; see below
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

**`FACTORY_MODEL_API=openai-completions` is not optional.** The credential proxy fronts a gateway
that speaks OpenAI-completions, and the worker's overlay defaults to `anthropic-messages` when the
variable is absent or misspelt — so leaving it out does not pick a default that happens to work, it
picks the wrong wire shape. The proxy refuses the request (`401 unknown-token`), the turn comes back
failed, and the attempt is recorded `unknown`. That is a spent unit: the verdict is kept as evidence,
but the unit stays `receipted`, `factory run` will not dispatch it again and the exit is
`factory abort` (§5); `samples` moves by one and `passes` does not, and three such units
(`m − k + 1`) end the loop. The first live certificate was earned with two units lost this way and
reads `samples=20 passes=19` because of it. The full account, and the rest of a live run's
environment, is in [live-model.md](live-model.md#what-a-live-run-also-needs).

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

**`samples` counts distinct base revisions, not runs.** The class count keys every observation by the
attempt's base commit (`revision: receipt.diff.baseRev`, `packages/wall/src/evaluate.ts`), so two
units cut from the same commit are one sample however many times they run: reusing a base revision
moves `samples` by zero. That is why §2 materialises one commit per revision — twenty attempts have to
be twenty trees or the certificate never reaches `m`. The same key is why an `unknown` verdict is
expensive: the revision was judged, so it occupies its sample as a non-pass, and resubmitting the
same commit cannot turn it into a pass.

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
| `no-todo-markers`        | a leftover `TODO` marker                         |

Each rule fails on **every** base revision and passes on the repair, which is what the wall's
`maxNonDiscriminating = 0` requires: a scenario that passes the base revision proves nothing about
the change. The visible check in the repository (`tools/check-docs.mjs`) covers two of the five; a
candidate that satisfies it and leaves the link broken is a `holdout_failed` verdict with a green
visible suite, and that is asserted in
[`../../e2e/certification/pipeline.test.ts`](../../e2e/certification/pipeline.test.ts).

The detection count — how many planted, visible-green regressions the corpus refuses — is measured in
[`../../e2e/certification/regressions.test.ts`](../../e2e/certification/regressions.test.ts): five
planted single-rule regressions, all refused, three of them with a green visible check; two rules
broken at once, refused with two failing holdout scenarios; and a genuinely clean repair, passed.
Deleting a rule from the corpus makes that rule's regression pass and the spec go red.

The corpus is never in the prompt, the launch record or the attempt clone, and the verdict
anonymises the scenario ids (`holdout:01` … `holdout:05`). That is asserted against a real clone in
[`../../e2e/certification/substrate.test.ts`](../../e2e/certification/substrate.test.ts) — the worker
cannot read the measurement.

**Known weakness: this class's corpus id is a label, not an identity.** The directory is
`h-docs-typo-real-2026-11-02` — a fixed string with no digest in it
([`../../e2e/certification/artifacts.ts`](../../e2e/certification/artifacts.ts),
`ARTEFACT_HOLDOUT_REVISION`), so every rebuild reuses the same name whatever the corpus contains.
`certificateRecency` compares ids, so if a rule or a hidden expectation in this corpus changed, the
next measurement would be recorded under the same id as the old one: the existing certificate would
keep reading `current` while naming evidence it was never measured against, and the alert that should
fire (`re-certify: corpus changed`) would not. That is the defect the `test-repair` generator fixed by
content-addressing its id — `<label>-<8 hex>` over the corpus tree, see §4 of
[certify-class-test-repair.md](certify-class-test-repair.md) and `corpusRevisionId` in
[`../../e2e/certification/test-repair.ts`](../../e2e/certification/test-repair.ts).

It is deliberately **not** fixed here yet: this corpus is unchanged and its certificate
(`h-docs-typo-real-2026-11-02`, samples `m = 20`) is valid, and applying the change now would mint a
new id and expire roughly 6.4 M tokens of evidence for a naming improvement. The fix has to be applied
to the docs-class generator **before the next rebuild of this corpus, or when this class is next
re-measured — whichever comes first**, together with the two specs the test-repair generator now
carries (same content → same id; one changed hidden expectation → new id). Until then: do not rebuild
the docs corpus as a free experiment without expecting the certificate to be read against evidence it
no longer describes.

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

**A launch that fails leaves the unit `dispatched`, never `rejected`.** `dispatched` is committed
before the executor is called, so nothing about a dead worker looks like a verdict. Two shapes, and
the difference matters:

- _The launch never happened_ — the controller died between commit and launch, or the executor
  refused. The unit stays `dispatched` with a pending launch effect and an expired lease, and
  `factory recover` performs the launch; that is what the outbox exists for.
- _The worker started and died._ The attempt is `running`, and `factory recover` defers it to a person
  (`a worker may already have run under it … nothing is relaunched`) because retrying could run it a
  second time.

`factory run` refuses the unit in both shapes (`UNIT_ALREADY_TERMINAL: … only a qualified unit can be
dispatched`). The way out of the second is `factory abort <unitId> --reason "<what happened>"`: it
releases the lease, marks the in-flight attempt `aborted`, and makes the unit terminal. An aborted
unit wrote no verdict, so it is not a sample and `samples` does not move; the same base revision can
be submitted again as a new unit. Do not delete the unit row to "re-clean" it — that deletes the
record of a crash.

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

### The other side of the risk: β(p)

α is the chance an honest class is refused. The other error is β(p): the chance that a class whose
_true_ pass rate is `p` is certified. For `m = 20, k = 18` it is exactly `P(X ≥ 18)` for
`X ~ Binomial(20, p)` — arithmetic, not a corpus, computed by `certificationRisk()` in
[`../../packages/wall/src/operating-point.ts`](../../packages/wall/src/operating-point.ts):

| true pass rate `p` | `certifiedAt(p)`       | `refusedAt(p)`         | reading                                                  |
| ------------------ | ---------------------- | ---------------------- | -------------------------------------------------------- |
| 0.80               | 0.20608471894847389696 | 0.79391528105152610304 | certified about once in five                             |
| 0.85               | 0.40489627800743543384 | 0.59510372199256456615 | certified about two times in five                        |
| 0.90               | 0.67692680518946603571 | 0.32307319481053396429 | certified about 68 times in 100 — the curve is not steep |
| 0.93               | 0.83899711726135142049 | 0.16100288273864857950 | certified about 84 times in 100                          |
| 0.95               | 0.92451632621150365702 | 0.07548367378849634297 | the calibrated truth; refused = α, digit for digit       |
| 0.97               | 0.97899164362165711488 | 0.02100835637834288511 | certified about 98 times in 100                          |

The two columns are each truncated to 20 places, so they can differ from 1 in the last printed digit;
at `p = p0` the refused column is the published α exactly. Reproduce the table — do not retype it —
with:

```bash
node --input-type=module <<'JS'
import { certificationRisk } from './packages/wall/src/operating-point.ts';
const risk = certificationRisk();
for (const p of [0.8, 0.85, 0.9, 0.93, 0.95, 0.97]) {
  console.log(p, risk.certifiedAt(p).exact, risk.refusedAt(p).exact);
}
JS
```

Every digit above is asserted in `packages/wall/src/operating-point.test.ts`, so the table cannot
drift from the code. Two readings the arithmetic forces, and neither is what an operator expects:

- **The operating point is a floor on class quality, not a filter against mediocre classes.** A class
  that truly passes 9 attempts in 10 is still certified about two times in three. `m = 20, k = 18`
  does not buy "certified means good"; it buys "certified means unlikely to be a 95 %-class fluke".
- **`k = m` would not remove false refusals.** Requiring all twenty attempts to pass gives
  α = `1 − 0.95²⁰` = 0.64151407759145776564, because a truly-95 % class fails at least one of twenty
  attempts about 64 % of the time. α = 0 needs `p0 = 1`, not `k = m`; at `k = m` the gate is stricter,
  not safer.

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
- **β is half computed, half counted — and neither half is a rate for classes in general.** β(p), the
  chance that a class whose _true_ pass rate is `p` is certified, is arithmetic — `P(Binomial(m, p) ≥ k)`,
  the table under §6. It says a class that truly fails two attempts in twenty is still certified about
  68 times in 100, so the operating point is a floor on class quality rather than a filter against
  mediocre classes. The other half — given a patch that is _actually wrong_ (visible check green, one
  holdout rule violated), does the wall refuse it? — is a property of the corpus with no closed form,
  so it is reported as a **count** over planted regressions, never as a rate: 5 of 5 planted single-rule
  regressions refused (3 of them with a green visible check, so only the holdout could have caught
  them), 1 of 1 two-rule regression refused, 1 of 1 clean repair passed, in
  [`../../e2e/certification/regressions.test.ts`](../../e2e/certification/regressions.test.ts).
  Deleting a rule from the corpus makes its regression pass and that spec go red, which is what makes
  the count mean something. What remains unmeasured and unmeasurable from one corpus is the detection
  _rate_ for classes in general.
- **α is a property of the point, not of the class.** 0.0755 says "an honest class is refused about
  one time in thirteen"; it says nothing about how often a bad class is accepted.
- **The corpus is written by the same side that is being certified.** It can only measure what its
  author thought of. A weaker but still discriminating corpus certifies a worse class.
- **Staleness is the only expiry, and it now has a corpus dimension.** Schema v5 stores
  `class_certificates.holdout_revision`, so a class re-measured under a stricter corpus expires its
  old certificate as soon as the first new row lands (the `alerts` `CERT_STALE` `next:` line names
  the class to re-certify). What is still absent is anything that _notices_ without being asked:
  nothing re-runs a certification when the policy, the model or the corpus moves, and nothing raises
  an alert before a certificate goes stale — `audit --certifications` and `alerts` are commands
  someone has to run. **Not built**: a scheduled re-certification job, and a corpus-identity check
  in preflight.
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
| the wall's detection, as a count    | `pnpm exec vitest run e2e/certification/regressions.test.ts`        | 8 passed — 5 of 5 planted single-rule regressions refused (3 with a green visible check), 1 of 1 two-rule refused, 1 of 1 clean repair passed; deleting a rule from the corpus reddens it                |
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

## 10. Doing it on a schedule (and the one number that permits a spend)

A certificate expires: the corpus moves, the policy digest changes, or the model changes under it. The
nightly `factory alerts` job already says so (`CERT_STALE` / `CERT_NEVER`), but it can only tell a person,
and the runbook above is a person-shaped loop. `deploy/launchd/ai.factory.recertify.plist` is the
scheduled half: at 05:00 (after the anchor at 03:00 and the alerts at 04:00) it runs

```bash
FACTORY_HOME=~/.factory bash scripts/recertify-due.sh --spend
```

which asks `factory audit --certifications --json` for a plan, and runs `scripts/certify-class.sh` for a
class **only** when the plan's decision is `would-spend`.

**The plan, per class** (`factory audit --certifications`, human and JSON):

| decision                   | when                                                                      | spends? |
| -------------------------- | ------------------------------------------------------------------------- | ------- |
| `not-due`                  | the newest certificate is current under the running policy and model      | no      |
| `would-spend`              | due, a measured projection fits the class budget, and a units file exists | **yes** |
| `refused-no-budget`        | due, and no budget was set for this class (the default)                   | no      |
| `refused-unknown-estimate` | due, and no measured attempt behind the class — the cost is `unknown`     | no      |
| `refused-over-budget`      | the measured projection exceeds the class budget                          | no      |
| `refused-no-units`         | a budget fits, but no `<class>.txt` of pre-submitted units exists         | no      |

The projection is this store's own measurement: a certificate names its verdict, the verdict its
attempt, the attempt's metered usage is the cost, and the class median × attempts still needed is the
projection. On 2026-11-07 the live store reported `docs-hygiene`: 19 attempts to `m=20`, median 76,494
tokens over 2 measured attempts, **1,453,386 tokens projected**, `refused-no-budget`.

**The one number that permits a spend** is the class budget, and it is per class on purpose:

```bash
# ~/.factory/recertify.env, or the EnvironmentVariables block in the plist
FACTORY_RECERTIFY_BUDGET_TOKENS="docs-hygiene=2000000,type-repair=2500000"
FACTORY_RECERTIFY_UNITS_DIR="$HOME/.factory/recertify-units"
```

Unset is the shipped state and means **no class may spend** — a job can exist before a spender does, and
turning auto-spend on is one line rather than a code change. It is per class because a full certificate
costs 186,787 tokens for `docs-typo-fix` and 1,944,675 for `type-repair`: a single global cap would either
starve the cheap class or let the expensive one run unbounded. A malformed entry is a usage error (exit
`2`), because a typo that silently drops a cap is a budget that lets a class spend.

**What the job will not do:** retry a failed driver run (the next night is the retry), invent units
(`refused-no-units`), or spend on an unmeasurable class (`refused-unknown-estimate` — an unknown estimate
never authorises a spend). After a spend it raises the same notification path every other alert uses, so
there is one transport and one log: `~/.factory/recertify.log`.

**Dry run, always safe:** `bash scripts/recertify-due.sh` without `--spend` prints the plan and spends
nothing.

## Related

- [certify-class-test-repair.md](certify-class-test-repair.md) — the second class (`test-repair`):
  a class whose cheap repair is _green_, and the corpus that refuses it.
- [live-model.md](live-model.md) — the key, the gateway and the cost of a live turn.
- [certificate-expired.md](certificate-expired.md) — a certificate that exists but is stale.
- [budget-envelope-refusal.md](budget-envelope-refusal.md) — exit `6` from the loop.
- [evidence-expiry.md](evidence-expiry.md) — the morning check that reads `alerts`.
