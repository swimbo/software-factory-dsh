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
pnpm test                 # 1314 passed, 6 skipped (92 files)
bash scripts/verify.sh    # preflight, typecheck, lint, format:check, test, build, panel, live-model(skip)
bash scripts/provision-topology.sh   # report which topology this host can honour (--apply on Linux)
factory ledger verify     # is the ledger head anchored off-host, and is the anchor fresh?
```

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
class. Alerting works the same way — `ledger verify` exits 9 and `audit --certifications` exits 9, but
nothing pages anyone.

## Packages

| Package                | What it is                                                                                                                                                 |
| ---------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `packages/contracts`   | The pinned vocabulary: `StatusV1`, `Verdict`, `WorkerReceipt`, lane decisions, exit codes, canonical JSON hashing                                          |
| `packages/store`       | `node:sqlite` ledger — units, attempts, leases, receipts, verdicts, promotions, effects, spend; every write is one transaction that also appends the event |
| `packages/core`        | The state machine, the effect outbox, recovery, and the four never-regress rules                                                                           |
| `packages/qualifier`   | Lane routing (dark / lit / refuse) from deterministic signals                                                                                              |
| `packages/wall`        | Generator-blind holdout evaluation: pinned suite, Δ certification, three runners (container / local / fake)                                                |
| `packages/gates`       | The three human gates: promotion signing, budget envelope, credential broker                                                                               |
| `packages/dsh-adapter` | The only code that touches DeepSeek Harness (`@deepseek-ai/*`): per-trust-domain `DSH_HOME`, overlay composition, NDJSON, watchdog, egress probe           |
| `apps/cli`             | `factory` — the operator surface, `--json` everywhere                                                                                                      |
| `apps/panel`           | Read-only status page: token-gated, loopback only, no writes by construction                                                                               |

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
- **No credential proxy** (R5). `packages/proxy` does not exist; the destructive-command classifier
  is a post-hoc denylist that its own comment calls partial. Privileged operations are _refused_,
  not brokered.
- **ND1–ND4 are decided and implemented; these are the parts still missing.** The decisions themselves
  are in `findings.md` § DECIDED and the implementation record in
  `evidence/phase-13-nd-decisions.md`. The **daily anchor job is installed** on this host
  (`deploy/launchd/ai.factory.anchor.plist`, 03:00, first records written 2026-11-01 and verified
  `FRESH · off-host` against `hermes-control`). Still not built: **alerting on a stale anchor** —
  `ledger verify` exits 9, but nothing pages anyone — and **re-certification**, which is being turned
  from prose into a stored certificate now.
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
  is still a host process, so a candidate that escapes its sandbox is not fenced in. The wall's
  _scenarios_ already run in that container (E2E-43/44/46); the _worker_ does not.
- **Spend is metered, not invoiced.** The proxy records what the gateway's response says
  (`tokensIn/out`, `costUsd` when the gateway prices it) into an append-only `usage_records` table and
  revokes the attempt token at the ceiling — but a response with no usage block is `unknown`, and
  `budget reconcile` against the gateway's export is best-effort: it reports `unknown` (exit 6) rather
  than guessing. There is no billing-grade accounting and no invoice.
- **The wall's isolation layer is real and measured; the worker still has no container.** `@docker`
  E2E-43/44/46 run on this host against `packages/wall/docker/` (base `node:26.12.1-alpine`, the
  runtime `.nvmrc` pins) — six specs, ~5 s: the container reaches no network (control: the host
  does), cannot write outside its work dir while it can write inside, cannot see a factory home,
  holdout or operator key (control: the host can), and its cgroup memory and pid limits are the
  flags the runner passed, with a 400-fork storm capped. What is **not** built is the _worker's_
  container: `apps/cli/src/wall.ts` wires `createLocalRunner`, the executor launches `dsh` on the
  host, and `docker/factory-env` builds (node 26.12.1, `dsh 0.2.1-rc.5`) but nothing dispatches into
  it. So E2E-45 — kill the worker container mid-attempt ⇒ `ambiguous`, no redispatch — stays
  `UNKNOWN`: there is no worker container to kill. The `ambiguous`/`recover` invariant itself is
  proven at the process level (E2E-21/30/31/32).
- **DSH's sandbox is not a security boundary**, and is not treated as one anywhere.
- **No ACP worker.** The adapter drives `dsh --profile headless` one-shot turns and reads NDJSON;
  the agent-client-protocol path is not implemented, so "one-shot **or** ACP workers" is delivered as
  **one-shot only**. An ACP worker would need a second executor behind the same `Executor` port and
  the same launch record — the seam exists, the implementation does not.

## Running the live layer

```bash
export DSH_BIN="/Applications/DeepSeek Harness.app/Contents/Resources/runtime/cli/bin/dsh"
export BIFROST_API_KEY=…              # from the operator's secret store, never from this repo
pnpm run test:live                    # both @live specs, one paid turn each
FACTORY_VERIFY_LIVE=1 bash scripts/verify.sh   # the whole gate, live stage included
```

Measured: `verify: 7 passed, 0 skipped, 0 failed`. With the key unset the same gate is
`6 passed, 1 skipped, 0 failed` and the live row is `SKIPPED` with its reason — the offline suite
never spends (C5).

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
