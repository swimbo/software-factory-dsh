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
- **No live DSH turn in CI.** The `@live` specs skip without a key; the DSH integration is proven
  by adapter tests and one recorded probe (`evidence/phase-9b-dsh-integration-probe.md`).
- **No container isolation on this host.** The 4 `@docker` specs are tagged and skipped; the local
  runner measures behaviour, not containment.
- **DSH's sandbox is not a security boundary**, and is not treated as one anywhere.

## Documents

`docs/planning/dark-factory-dsh/` holds the planning set: `phased-plan.md`, `architecture.md` (with
the debate outcomes and the amendments they forced), `findings.md`, `decisions/`, `evidence/`, the
user stories, UX/UI plans, `data-map.md`, `e2e-tests.md`, and `phase-13-audit.md` — the audit of
what this repo claims against what it contains.

Read `phase-13-audit.md` first if you are deciding whether to trust this project: it is the document
that lists where the claims came up short.
