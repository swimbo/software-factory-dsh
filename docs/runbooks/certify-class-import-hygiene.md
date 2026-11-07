# Certifying the `import-hygiene` class

The class asks whether a change makes a TypeScript tree that **node can load**: relative imports carry
their `.ts` extension, type-only symbols use `import type`, and no `enum`/`export =` remains. `tsc`
accepts all three violations, so this class is the one that catches "compiles, does not run".

The general loop, the credential, the operating point and what to do when an attempt comes back `unknown`
are in [certify-class.md](certify-class.md). This file is only what is specific to this class, plus the
record of the run that certified it.

## 1. What is specific here

- **`FACTORY_TEST_ROOT="tools"`, not `src`.** The wall restores this root from the base revision before
  it runs the pinned suite, so a candidate cannot weaken the visible check by editing it. Pointing it at
  `src` restores the _broken code_ and makes every repaired tree look unrepaired — that mistake cost one
  debugging round and is why the fixture's `tools/` directory exists at all.
- **The visible check is a subset of the class.** `node tools/check-imports.mjs` checks the extension rule
  only. A worker that fixes exactly what it prints passes acceptance and the pinned suite and is still
  refused by the holdout (`holdout_failed`, exit 3, unit `rejected`). That is the class working, not a
  flake.
- **node erases `import type` before resolving anything**, so the extension rule has to be measured with a
  _value_ import. An extensionless type import never reaches the resolver; a rule that claimed otherwise
  would be measuring `tsc`.
- **`runtime-resolve` is a dynamic oracle.** It imports every `src/**/*.ts` and records the load error. It
  reddens whenever the static rules do, which is honest: the static rules are the cheap explanation, the
  dynamic one is the fact.

## 2. Building the artefacts (free)

```bash
bash scripts/import-hygiene-artifacts.sh --root ~/.factory/certification-import --revisions 20
```

Twenty commits of a source repository, its `--mirror` clone, the four-rule corpus, twenty unit specs, a
`repair/` tree and an _emitted_ `plan-units.sh`. It refuses a root inside the checkout, a directory it did
not build, and a base revision that stops breaking all four rules. Then:

```bash
FACTORY_HOME=~/.factory FACTORY_REPO=import-fixture bash ~/.factory/certification-import/plan-units.sh
```

Submits and qualifies the twenty units dark — no model, no spend, no ledger write beyond the units.

## 3. The live loop

```bash
export FACTORY_HOME="$HOME/.factory"                       # the live store, not a side store
export FACTORY_HOLDOUT_ROOT="$HOME/.factory/certification-import/holdout"
export FACTORY_HOLDOUT_TASK_CLASS="import-hygiene"
export FACTORY_PRISTINE_REPO="$HOME/.factory/certification-import/repo.git"
export FACTORY_REPO="import-fixture"
export FACTORY_TEST_ROOT="tools"
export FACTORY_WALL_SUITE="node tools/check-imports.mjs"
export FACTORY_MODEL_ID="auto"
export FACTORY_MODEL_API="openai-completions"              # the proxy's wire shape; see live-model.md
export FACTORY_LIVE_MODEL=1                                # the consent switch: this run may spend
export FACTORY_PROXY_BASE_URL="https://hermes-control.tail4296e6.ts.net/openai/v1"
export DSH_BIN="/Applications/DeepSeek Harness.app/Contents/Resources/runtime/cli/bin/dsh"

bash scripts/certify-class.sh --units-file ~/.factory/certification-import/units.txt
```

Afterwards, the twenty fixture units are `verified`, and twenty verified units are twenty entries in
`status` — which is the wallpaper the operator objected to. Abort them with the reason that says what they
were:

```bash
factory abort <unitId> --reason "import-hygiene certification fixture: the class certificate is the deliverable (cert:…), no promotion intended"
```

## 4. The run that certified it (2026-11-07)

Measured, in the live store: 20 attempts, 20 pass, 0 fail, **1,443,304 tokens** (in 1,388,406 / out
54,898), median 64,709 per unit, min 42,234, max 163,661 — against the ~2 M estimate. Certificate
`cert:V-09f28117f026`, `samples=20 passes=20 m=20 k=18`, `holdoutRevision=h-import-hygiene-2026-11-07`,
`modelId=auto`, `state=current`.

All twenty passed, so the operating point's failure budget was never touched and the loop's stop reason was
`units-exhausted` rather than `operating-point-reached` — the first attempt was run by hand to catch an
environment mistake cheaply, and the driver was handed the nineteen that remained. A class that passes
every attempt tells you the class is not too hard for the model; it does not tell you the class is hard.
