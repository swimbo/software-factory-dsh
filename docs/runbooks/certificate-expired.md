# Runbook — `audit --certifications` says a class certificate is expired

**Symptom.** `factory audit --certifications` exits `9`. The real output looks like this:

```
CLASS CERTIFICATIONS  under sha256:6ce54b93… (model auto)
  slug-check  stale
    re-certify: policy changed (certified under policy/2026-10-01, running sha256:6ce54b93…)
  STALE OR NEVER CERTIFIED  1 of 1 entries; a stale certificate is expired evidence, not a warning
```

or, on a store where nothing has been measured:

```
CLASS CERTIFICATIONS  under sha256:6ce54b93… (model offline)
  NO CLASS CERTIFICATES  no class has been certified in this store
  Nothing to audit is not a licence: this is never-certified, not current
```

The table is written to **stderr** (every verb's human surface is), so `factory audit
--certifications > /dev/null` still shows it.

**What it means.** A class certificate is the factory's evidence that _this_ wall, at _this_
operating point, under _this_ policy and model, can tell a good change from a bad one at the
published α. The row records the point (`m`, `k`, `p0`, α) and the identity it was judged under
(policy version, model id). Change either identity and the old row is still true about the old
world — so it is **expired evidence**, reported as a refusal rather than a warning. `9` is the
integrity code; it does not mean the ledger is corrupt.

**What the factory will refuse to do.** Nothing, by itself. A stale certificate does not block
`run`; it blocks the _claim_ — `audit --certifications` is what turns the claim into an exit code
so a promotion cannot be described as certified when it isn't. Read that sentence carefully: this
is a reporting control, not a gate, and the distinction is deliberate (gating on it would let a
quietly-failing audit stop production work at 2am; the runbook exists so a person decides).

**Check what actually changed.**

```bash
export PATH="$HOME/.nvm/versions/node/v$(cat .nvmrc)/bin:$PATH"

factory status --json | jq '.factory | {policyVersion, wallVersion, holdoutRevision}'
factory audit --certifications                      # the per-class table, with the reason line
factory audit --certifications --json |
  jq '.classes[] | {taskClass, state, outcome, samples, m, alpha, reasons}'
# current:   {"taskClass":"slug-check","state":"current","outcome":"certified","samples":20,"m":20,"alpha":0.07548367378849634,"reasons":[]}
# stale:     {"taskClass":"slug-check","state":"stale","outcome":"certified","samples":20,"m":20,"alpha":0.07548367378849634,
#             "reasons":["re-certify: policy changed (certified under policy/2026-10-01, running sha256:6ce54b93…)"]}
```

Three cases, three different answers:

| The reason line says             | What changed                        | What to do                                                                                             |
| -------------------------------- | ----------------------------------- | ------------------------------------------------------------------------------------------------------ |
| `policy changed`                 | the wall's policy version moved     | re-run the class (§ below), or revert the policy — a policy change is a measurement change             |
| `model changed`                  | `FACTORY_MODEL_ID` moved            | re-run the class against the new model; a certificate is about a model's behaviour, not a model family |
| `model unknown`                  | the certificate has no model id     | the attempt ran before the model id was wired, or offline; re-run with `FACTORY_MODEL_ID` set          |
| `nothing has ever been measured` | this task class was never certified | run the class to m attempts before treating it as certifiable                                          |

**Re-certify a class** (this is the measurement, and it costs money when the model is live). The
certificate is written by the wall on every verdict, so re-certifying is just running `m` units of
that class through the normal path:

```bash
# one attempt per unit, through intent → qualify → run; each verdict writes a new certificate row
for unit in $(seq 1 20); do
  factory intent --file "units/u${unit}.json" --restate "units/u${unit}.restate.md"
  factory qualify "U-…" --json            # the id `intent` printed
  factory run "U-…" --json || true        # `unknown`/`fail` attempts still count as samples
done
factory audit --certifications; echo $?   # the newest certificate per class decides; 0 means current
```

The class is certified when at least `k` of the last `m` samples pass **and** the new row records
the running policy and model. α = 0.0755 means roughly one honest class in thirteen will fail
certification on a good day: a `not-certified` outcome is not a bug report, it is the test doing its
job. Re-running until it goes green is p-hacking the wall — if a class fails twice at m = 20, the
honest reading is that the wall cannot distinguish that class, and the fix is a better holdout, not
more attempts.

**What "fixed" looks like.**

```
$ factory audit --certifications; echo $?
CLASS CERTIFICATIONS  under sha256:6ce54b93… (model auto)
  slug-check  current
  1 of 1 classes current
0
```

**When it does not work.**

- Exit `9` with `NO CLASS CERTIFICATES` and no classes listed: nothing has been measured in this
  store at all. That is `never-certified`, and it is the correct answer for a cold start.
- Exit `9` with a `no class-certificate projection` line: the store predates schema v3. The store
  migrates additively on open, so this means an **old binary** is on `PATH` — check
  `factory --version` against the tree you think you are running. (`status --json` reports
  `schemaVersion: "status.v1"`, which is the _status document's_ version, not the store's.)
- Exit `8`: the store could not be opened at all — that is [store-quarantine.md](store-quarantine.md),
  not this runbook.
- The certificate is current but a promotion still demanded a signature: that is
  [rotate-operator-key.md](rotate-operator-key.md) (unsigned promotion), or the unit's class was
  never certifiable and `promotionRequiresHumanSignature` is doing its job.

**Not built, said plainly.** Nothing re-runs a certification automatically when the policy or model
changes, and nothing raises an alert when a certificate expires — `audit --certifications` is a
command a person or a cron job runs. The stored point and α exist so that job is a query when someone
writes it.

**Related.** [ADR-008](../adr/008-off-host-anchor.md) for the other "evidence that expires" control;
`docs/planning/dark-factory-dsh/evidence/phase-13-nd-decisions.md` for the ND1 decision this
implements.
