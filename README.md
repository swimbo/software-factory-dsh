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
export PATH="$HOME/.nvm/versions/node/$(cat .nvmrc)/bin:$PATH"
pnpm install
pnpm run build            # tsc -p tsconfig.build.json
pnpm test                 # 1017 passed, 10 skipped (64 files)
bash scripts/verify.sh    # preflight, typecheck, lint, format:check, test, build, live-model(skip)
```

`verify.sh` writes `docs/verification/<run-id>/{verify.log,summary.json}`, and the summary names the
commit it measured, so a green line is reproducible rather than remembered.

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
- **No off-host anchor** (ND4), **no verdict-store split by uid** (ND2), **no proxy metering**
  (ND3), **no certification operating point** (ND1). These are open human decisions, recorded in
  `architecture.md §11` as NEEDS_HUMAN_DECISION rather than quietly defaulted.
- **The live layer is opt-in, and the worker gets a scoped token, not the gateway key.** `@live`
  specs skip unless `BIFROST_API_KEY` **and** `DSH_BIN` are set; the `live-model` gate stage runs only
  with `FACTORY_VERIFY_LIVE=1`, because each run makes real, paid model calls. When a live run happens,
  a per-attempt **credential proxy** on `127.0.0.1` holds the key and hands the worker a token bounded
  to that socket, that lease, one upstream path prefix, and revoked before the verdict is written
  (ADR-007). The launch record says `credentialsForwarded: []` and `credentialProxy: { token: 'scoped' }`.
  **What this does not buy:** a root-level attacker on the host, or a second OS uid — the container path
  (E2E-44) is still the shape that adds real isolation.
- **No model-call budget of its own.** Spend is bounded by the operator's gateway route, not by the
  factory; the factory's `budget` reserves an _estimate_ per attempt and never measures tokens.
- **No container isolation on this host.** The 4 `@docker` specs are tagged and skipped; the local
  runner measures behaviour, not containment.
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
