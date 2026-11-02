# Dark software factory on DeepSeek Harness

An agent takes an intent, and the machine decides whether the change is good enough to be
merge-ready — **without a human reading the diff**. The human appears exactly three times:
to deploy to production, to widen the budget envelope, and to grant a privileged credential.

Nothing here is "safe". What this repo actually claims is narrower and testable: the verifier is
**generator-blind** (the agent never sees the holdout that judges it), **deterministic where
possible**, **adversarially tested against itself** (a sabotage that passes its own suite is
rejected), and **audited by a person on a schedule**. No pass rate is certified — see
[`architecture.md` §11](docs/planning/dark-factory-dsh/architecture.md) for the arithmetic that
makes "2-of-3 runs" a weaker claim than it looks.

## The three laws

|        | Law                                           | Where it is enforced                                                                                                                                                              |
| ------ | --------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **L1** | An agent report is not evidence               | `packages/contracts/src/receipt.ts` — `DecisionReceipt` excludes `narrative` at the type level; `receiptShaFor()` hashes the decision projection, so prose cannot change identity |
| **L2** | Deterministic controls enforce; models advise | `packages/wall` (holdout + Δ), `packages/gates` (budget, credentials, signing), exit codes — no model sits on a gate path                                                         |
| **L3** | Unknown is not pass                           | `unknown` never satisfies a gate: promotion refuses it, the qualifier routes it to a person, the panel paints it in the unknown token                                             |

## What runs today

```bash
export PATH="$HOME/.nvm/versions/node/v$(cat .nvmrc)/bin:$PATH"
pnpm install
pnpm run build            # tsc -p tsconfig.build.json
pnpm test                 # 1372 passed, 7 skipped (97 files; measured at 36e2ddd, docker running)
bash scripts/verify.sh    # preflight, typecheck, lint, format:check, test, build, panel, live-model(skip)
bash scripts/provision-topology.sh   # report which topology this host can honour (--apply on Linux)
factory ledger verify     # is the ledger head anchored off-host, and is the anchor fresh?
```

`factory ledger verify` needs an anchor target in the environment — on this host the daily job sets
`FACTORY_ANCHOR_SSH=hermes-control`, `FACTORY_ANCHOR_PATH` and `FACTORY_HOME` in
`deploy/launchd/ai.factory.anchor.plist`, so in a bare shell it exits **8** ("no anchor target is
configured") rather than **9**. That distinction is deliberate: 8 means the check could not look,
9 means it looked and the evidence is stale or missing. `docs/runbooks/ledger-anchor.md` is the
procedure.

`verify.sh` writes `docs/verification/<run-id>/{verify.log,summary.json}`, and the summary names the
commit it measured, so a green line is reproducible rather than remembered.

### The wall's principal, not just its process

The wall is a separate **principal** where the platform allows it. On the Linux target the verdict
store, the holdout corpus and the operator key belong to `factory-wall` (`0750`, group
`factory-wall`) and the worker runs as `factory-worker`, which is not a member of that group:
`factory-worker` gets `EACCES` on the store, the corpus and the key. That is what makes "the wall is
independent" a property of the deployment rather than of a function-call boundary.

On this macOS development host there is no second uid in play, so the factory runs single-uid and
says so: **the wall is a separate process, not a separate principal.** `factory status` prints which
of the two it found — the aggregate line carries `principals two-uid` or `principals single-uid`, and
the single-uid case prints the claim and its reason beneath it — so the stronger sentence cannot leak
onto a host that cannot honour it. `scripts/provision-topology.sh` reports the same fact and refuses
to run where the accounts are missing: it prints the `groupadd`/`useradd` lines and exits 8 rather
than minting system users.

| Platform | Accounts present | The factory reports  | The claim it may make            |
| -------- | ---------------- | -------------------- | -------------------------------- |
| Linux    | yes              | `two-uid`            | the wall is a separate principal |
| Linux    | no               | `single-uid`, exit 8 | the wall is a separate process   |
| macOS    | n/a              | `single-uid`         | the wall is a separate process   |

What this does **not** buy: anything against root on the host, and no isolation at all on a
single-uid platform.

### The numbers the factory publishes about itself

| What                          | Number                                                               | Where it is computed                       |
| ----------------------------- | -------------------------------------------------------------------- | ------------------------------------------ |
| Certification operating point | **m = 20 attempts, k = 18 passes** per task class                    | `packages/wall/src/operating-point.ts`     |
| α (false-alarm rate)          | **0.0755** — P(a class that truly passes 95 % fails certification)   | same, exact rational arithmetic            |
| β (power)                     | **unmeasured** — needs a known-bad corpus nobody has                 | stated in the module header, not published |
| Anchor freshness window       | **48 h** — `ledger verify` exits 9 past it                           | `packages/anchor`, ADR-008                 |
| Spend                         | what the gateway reports per call; `unknown` when it reports nothing | `packages/credential-proxy/src/usage.ts`   |
| Class certificates            | one row per verdict; `audit --certifications` exits 9 when stale     | `class_certificates` in `packages/store`   |

A class certificate is **stored, not narrated**: each verdict's certificate is a row in
`class_certificates` (the task class, m, k, p0, α, samples, passes, outcome, the policy version and the
model id it was judged under), written inside the same transaction as the verdict, with a digest that
ties it to the `wall.class_certified` event. `factory audit --certifications` exits **9** when any
class's certificate is stale or absent against the running policy or model — expired evidence, not a
warning.

What that still is not: a **scheduled** re-certification. Nothing runs the measurement again on a
policy or model change; the audit tells you the certificate expired and a person decides to re-run the
class. **What checks it.** `factory alerts` runs both judgements in one read-only command — importing
`verifyAnchor` and `certificateRecency`, not restating them — and exits `0` clean, `9` for an integrity
alert, `8` when the anchor host is unreachable. A launchd job runs it daily at 04:00 into
`~/.factory/alerts.log`. **Still true:** nothing pages a person. There is no email, webhook or channel —
an alert is a line in a log and an exit code a timer ignores, so a host that stops running jobs goes
quiet, not loud. Expiry is _detectable_; it is not _escalated_.

## Packages

| Package                     | What it is                                                                                                                                                         |
| --------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `packages/contracts`        | The pinned vocabulary: `StatusV1`, `Verdict`, `WorkerReceipt`, lane decisions, exit codes, canonical JSON hashing                                                  |
| `packages/store`            | `node:sqlite` ledger — units, attempts, leases, receipts, verdicts, promotions, effects, spend; every write is one transaction that also appends the event         |
| `packages/core`             | The state machine, the effect outbox, recovery, and the four never-regress rules                                                                                   |
| `packages/qualifier`        | Lane routing (dark / lit / refuse) from deterministic signals                                                                                                      |
| `packages/wall`             | Generator-blind holdout evaluation: pinned suite, Δ certification, three runners (container / local / fake)                                                        |
| `packages/gates`            | The three human gates: promotion signing, budget envelope, credential broker                                                                                       |
| `packages/proxy`            | The privileged-operation broker: post-expansion classifier, brokered-operation table, signed one-operation decision, six refusals                                  |
| `packages/credential-proxy` | Per-attempt HTTP proxy that holds the gateway key: a 128-bit token bound to one attempt, one socket, one upstream prefix, revoked at settle (ADR-007)              |
| `packages/anchor`           | The off-host ledger head: append one `{seq, headHash, eventCount, anchoredAt}` a day, refuse a head with no anchor newer than 48 h (ADR-008)                       |
| `packages/effects`          | The outbox dispatcher: performs the effects the engine committed, at most once, keyed by content                                                                   |
| `packages/dsh-adapter`      | The only code that touches DeepSeek Harness (`@deepseek-ai/*`): per-trust-domain `DSH_HOME`, overlay composition, NDJSON, watchdog, egress probe, worker container |
| `apps/cli`                  | `factory` — the operator surface, `--json` everywhere                                                                                                              |
| `apps/panel`                | Read-only status page: token-gated, loopback only, no writes by construction                                                                                       |

The architecture is a **clean-room** build on DSH's package boundaries: nothing from
`dsh-superagent-prototype` is vendored, and only `packages/dsh-adapter` imports DSH.

## Models

DeepSeek only, behind the existing **Bifrost** gateway — the adapter targets a `llm-pi-ai` provider,
never a vendor SDK, and no test makes a paid call (constraint C5: the suite passes with no
`BIFROST_API_KEY` and no `dsh` on `PATH`, both proven in `packages/dsh-adapter/tests`).

## What is **not** built (read this before trusting the rest)

Mirroring the plan's OUT scope, so a fenced v1 is not mistaken for a finished product:

- **No scheduler and no queue.** IN #5 is built as a _refusal_: `maxConcurrentAttempts` and
  `maxConcurrentWalls` (both default 1) make a second dispatch exit 7 with `CONCURRENCY_LIMIT` before
  anything is reserved. There is no queueing, no fairness, no priorities and no human-priority slot —
  a queue would be a promise about _when_ work happens, and there is no scheduler to keep it.
- **No no-progress detector** (IN #6). The watchdog enforces wall-clock and output-byte ceilings and
  the kill switch, but detecting "the worker is doing nothing" needs step-level signals that DSH
  owns; the e2e id for it is withdrawn rather than left looking unstarted.
- **Privileged operations are refused or brokered, and the half that is wired can only refuse.**
  `packages/proxy` is the broker R5 asked for: classification happens **after** expansion (a shell
  `-c` string is tokenised, `env`/`xargs`/`nice`/`timeout` are unwrapped, `/usr/bin/sudo` is reduced to
  `sudo`, `~`/`$HOME` are normalised, and a dynamic word in the command position is `ambiguous` and
  therefore refused), six brokered classes (`sudo`, `container`, `ci`, `cloud`, `macos-security`,
  `path-write`) are matched against a table of normalised argv shapes rather than a word denylist, and
  the answer is `GATE_REQUIRED` (exit 5: no decision, unsigned, a retired key, not the operator's
  phrase, already used, or an explicit deny) or `MANDATE_EXPIRED` (exit 3: expired, or a decision
  granted for a different command). A `PrivilegedDecision` binds one `sha256` of the normalised
  operation, one expiry and the operator key that signed it; its persistable forms are the
  `privileged.decided` ledger event and a `FACTORY_HOME/gates/` artifact
  (`packages/proxy/src/{classify,operations,decision,broker}.ts`). It
  runs where the factory sees an argv: the wall's re-execution of a receipt's commands brokers
  unconditionally (`apps/cli/src/wall.ts`), so a receipt claiming `sudo` measures `unknown`
  (`privileged_unbrokered`), never `pass`, and the fake executor brokers its scripted steps only with
  `FACTORY_PRIVILEGED_BROKERING=on` (default `off`, `packages/qualifier/src/policy.ts`). **Still not
  built:** no verb mints a decision and neither call site passes a `DecisionSink`, so the allow path
  is exercised only by a signed decision built in `packages/wall/src/local.test.ts` — there is no
  end-to-end "a person signed, so it ran"; a real `dsh` turn's own tool calls are kept as an
  agent-reported artefact (`packages/dsh-adapter/src/executor.ts`) and never reach the broker
  (ADR-006); and there is no rule for arbitrary destructive verbs — the wall's denylist over recorded
  argv is a second, knowingly partial line (`packages/wall/src/evaluate.ts`). The worker **credential**
  is a different package: `packages/credential-proxy` holds the gateway key and hands the attempt a
  scoped, revocable token — see the live-layer bullet below.
- **ND1–ND4 are decided and implemented; these are the parts still missing.** The decisions themselves
  are in `findings.md` § DECIDED and the implementation record in
  `evidence/phase-13-nd-decisions.md`. The **daily anchor job is installed** on this host
  (`deploy/launchd/ai.factory.anchor.plist`, 03:00, first records written 2026-11-01 and verified
  `FRESH · off-host` against `hermes-control`). The daily **`factory alerts`** job (04:00,
  `~/.factory/alerts.log`) asks both expiry questions in one read-only command and answers in an exit
  code: `0` clean, `9` a stale/missing/rolled-back anchor, a quarantined store or an expired class
  certificate, `8` when the anchor host cannot be reached — a transport failure is never reported as
  "fine". Still not built: **notification** (the log is the page; nothing reaches a phone or an inbox)
  and **scheduled re-certification** (a monitor says a certificate expired; a person decides to
  re-measure the class).
  ND3's ceiling is proven **through the real executor** (a paid `@live` spec arms it and crosses it on
  one turn, ~1 cent, with the crossing recorded in `usage_records`), and ND2's two-uid path is proven
  in a `node:26-bookworm` container rather than on the Linux target itself.
- **The two-uid topology has not run on the Linux target**, only in a `node:26-bookworm` container:
  that proof covers the accounts, the modes, the marker and the worker's `EACCES` on store, corpus
  and key. It does not cover systemd, a real `/var/lib/factory`, or an operator key that already
  exists — and the macOS host you are reading this on is single-uid by construction.
- **The live layer is opt-in, and the worker gets a scoped token, not the gateway key.** `@live`
  specs skip unless `BIFROST_API_KEY` **and** `DSH_BIN` are set; the `live-model` gate stage runs only
  with `FACTORY_VERIFY_LIVE=1`, because each run makes real, paid model calls. When a live run happens,
  a per-attempt **credential proxy** on `127.0.0.1` holds the key and hands the worker a token bounded
  to that socket, that lease, one upstream path prefix, and revoked before the verdict is written
  (ADR-007). The launch record says `credentialsForwarded: []` and `credentialProxy: { token: 'scoped' }`.
  **What this does not buy:** a root-level attacker on the host, or a second OS uid — and the worker
  is a host process _unless_ `FACTORY_WORKER_ISOLATION=container` is set, in which case the turn runs
  inside `factory-env` behind the flags in the next bullet (the worker is non-root there, uid 10001,
  but it is not a second uid _on this host_). The wall's _scenarios_ and the _worker_ both have that
  container now (E2E-43/44/46 and E2E-45).
- **Spend is metered, not invoiced.** The proxy records what the gateway's response says
  (`tokensIn/out`, `costUsd` when the gateway prices it) into an append-only `usage_records` table and
  revokes the attempt token at the ceiling — but a response with no usage block is `unknown`, and
  `budget reconcile` against the gateway's export is best-effort: it reports `unknown` (exit 6) rather
  than guessing. There is no billing-grade accounting and no invoice.
- **Both containers are real and measured; the worker's is opt-in.** `@docker` E2E-43/44/46 run on
  this host against `packages/wall/docker/` (base `node:26.12.1-alpine`, the runtime `.nvmrc` pins) —
  six specs, ~5 s: the container reaches no network (control: the host does), cannot write outside its
  work dir while it can write inside, cannot see a factory home, holdout or operator key (control: the
  host can), and its cgroup memory and pid limits are the flags the runner passed, with a 400-fork
  storm capped. The _worker_ runs the same way when `FACTORY_WORKER_ISOLATION=container`: the turn
  executes inside `factory-env` (node 26.12.1, `dsh 0.2.1-rc.5`) as uid 10001, with `--network none`,
  `--read-only`, `--tmpfs /tmp`, an explicit memory and pid ceiling, the clone and its per-attempt
  `DSH_HOME` bind-mounted, the attempt record mounted read-only, and the attempt's id as a label.
  Proven from inside, not asserted from outside: the candidate's own process walks `../../..` to the
  factory root and cannot open `<factoryHome>/holdout/corpus.txt` or
  `<factoryHome>/keys/evaluator.key`, while the host reads both; `/home/factory` is not writable and
  `/var/run/docker.sock` is absent. `launch.json` records the image (tag **and** digest), uid, network
  mode, limits, labels and the paths it did _not_ get — `container: {…}`, where `null` means "host
  process" and never "unknown". E2E-45 is real: `docker kill` the worker container mid-attempt ⇒
  `ATTEMPT_AMBIGUOUS` (exit 4), no receipt, exactly one attempt, no redispatch, `recover` records it
  `ambiguous` (it defers while the lease is still live — the same rule, not a retry) and no container
  remains. E2E-45's **orphan-sweep clause** is measured too: a `SIGKILL`ed control plane executes none
  of its exit paths, so its container outlives the attempt, and for the attempts _it_ reconciles to
  `ambiguous`, `factory recover` reads that attempt's `launch.json` and removes every container
  labelled `org.factory.attempt=<attemptId>` — by that id alone, never by image, never by a bare
  label, never while the lease is live, never for a `container: null` record — reporting a sweep it
  could not perform as `skipped`/`failed` with the reason, in the text and as `sweeps[]` in
  `recover --json`, never as "swept 0", and without changing the exit code
  (`e2e/cli/docker/09-recover-sweep.test.ts` asserts the orphan is still listed after the kill and
  gone after `recover` exits 4). What is **not** built: the mode is opt-in rather than the default; a
  request that cannot be honoured refuses with exit 8 `CONTAINER_UNAVAILABLE` and the exact
  `docker build` line instead of falling back to a host process; and network isolation is pinned by
  the argv spec and not by a container-side egress probe (the wall's E2E-43 covers egress, with a
  host control).
- **DSH's sandbox is not a security boundary**, and is not treated as one anywhere.
- **No ACP worker.** The adapter drives `dsh --profile headless` one-shot turns and reads NDJSON;
  the agent-client-protocol path is not implemented, so "one-shot **or** ACP workers" is delivered as
  **one-shot only**. An ACP worker would need a second executor behind the same `Executor` port and
  the same launch record — the seam exists, the implementation does not.

## Running the live layer

```bash
export DSH_BIN="/Applications/DeepSeek Harness.app/Contents/Resources/runtime/cli/bin/dsh"
export BIFROST_API_KEY=…              # from the operator's secret store, never from this repo
pnpm run test:live                    # the whole suite with the two @live specs in it (see note)
FACTORY_VERIFY_LIVE=1 bash scripts/verify.sh   # the whole gate, live stage included
```

Measured: the last recorded live run (`docs/verification/2026-11-01T21-58-16Z/`, commit `6a398cc`)
reports `verify: 8 passed, 0 skipped, 0 failed`, `panel` and `live-model` both PASS. With the key
unset the same gate is `7 passed, 1 skipped, 0 failed` at `36e2ddd`: `preflight`, `typecheck`, `lint`,
`format:check`, `test`, `build` and `panel` pass, and the live row is `SKIPPED` with its reason — the
offline suite never spends (C5).

Note on `test:live`: the script in `package.json` is `FACTORY_TAGS=live vitest run`, and nothing in
the tree reads `FACTORY_TAGS`, so it re-runs the whole suite (the `@live` specs skip without
`BIFROST_API_KEY` and `DSH_BIN`). It is not a filter, and the live stage of `verify.sh` calls the same
script.

## What has actually been executed against a model

One real unit — not a fixture — was verified end to end on 2026-11-01: a `dsh` one-shot turn through
Bifrost (`auto` → `deepseek-v4.1-flash:1017`), receipt written, wall measured, verdict
**`pass` with no reasons**, `replayed 5 of 8 recorded commands; 0 mismatched`, holdout discriminating,
CLI exit 0, ~`12.7k` tokens over two steps (measured twice: 12,684 and 12,706). The numbers, the three defects that run exposed, and the
replay-policy decisions they forced are in
[`docs/planning/dark-factory-dsh/evidence/phase-9b-live-model-probe.md`](docs/planning/dark-factory-dsh/evidence/phase-9b-live-model-probe.md).

## Documents

`docs/planning/dark-factory-dsh/` holds the planning set: `phased-plan.md`, `architecture.md` (with
the debate outcomes and the amendments they forced), `findings.md`, `decisions/`, `evidence/`, the
user stories, UX/UI plans, `data-map.md`, `e2e-tests.md`, and `phase-13-audit.md` — the audit of
what this repo claims against what it contains.

Read `phase-13-audit.md` first if you are deciding whether to trust this project: it is the document
that lists where the claims came up short.
