# Runbooks

Seven 2am procedures. Each one is written for the person who did not build the thing: the symptom,
what the factory will refuse to do, the exact commands, what "fixed" looks like, and what to do when
it does not work. Every command here was run against this tree; every limit that is real is labelled
**not built** rather than described as a plan.

| Runbook                                                  | When to open it                                                  | Exit codes         |
| -------------------------------------------------------- | ---------------------------------------------------------------- | ------------------ |
| [ambiguous-attempt.md](ambiguous-attempt.md)             | a unit is `ambiguous` and `status` says it needs you             | `4`, `5`           |
| [outbox-effect-stuck.md](outbox-effect-stuck.md)         | `status` shows the outbox degraded, or `recover` keeps deferring | `8`, `6`, `7`, `3` |
| [store-quarantine.md](store-quarantine.md)               | every write is refused with "the ledger integrity check failed"  | `9`, `8`           |
| [budget-envelope-refusal.md](budget-envelope-refusal.md) | `run` refuses with `BUDGET_EXCEEDED` before anything starts      | `6`, `5`           |
| [rotate-operator-key.md](rotate-operator-key.md)         | every promotion is refused with `PROMOTION_UNSIGNED`             | `5`                |
| [ledger-anchor.md](ledger-anchor.md)                     | `ledger verify` says the anchor is stale, missing or behind      | `9`, `8`           |
| [certificate-expired.md](certificate-expired.md)         | `audit --certifications` says a class certificate is stale       | `9`, `8`           |

Common ground, so no runbook has to repeat it:

- `FACTORY_HOME` is the CLI's home (default `$HOME/.factory`); the store lives at
  `$FACTORY_HOME/state` (override with `FACTORY_STATE_DIR`), keys at `$FACTORY_HOME/keys`.
- The pinned runtime is in `.nvmrc` (26.12.1): `export PATH="$HOME/.nvm/versions/node/v$(cat .nvmrc)/bin:$PATH"`
  in every shell, or the preflight stage refuses.
- `factory` is a pnpm script (`node apps/cli/src/main.ts`). `pnpm run factory <verb>` works from the
  repo root; a `factory` shim on `PATH` is optional.
- Every verb takes `--json`. In a runbook, prefer the human surfaces — they carry the reasons.
- **Nothing in this system is fixed by deleting evidence.** No runbook asks you to edit, reset,
  re-initialise or remove the ledger, and none of them can be completed by doing so.
- The full argument behind each refusal is in [`../adr/`](../adr/) and the audit that decided what
  is real is [`../planning/dark-factory-dsh/phase-13-audit.md`](../planning/dark-factory-dsh/phase-13-audit.md).
