# ADR-001 — Clean room on DeepSeek Harness: only the adapter may import DSH

**Status:** accepted (Phase 1, enforced ever since)
**Context:** [architecture.md](../planning/dark-factory-dsh/architecture.md) §2, [consensus-plan.md](../planning/dark-factory-dsh/consensus-plan.md)
**Enforced by:** `pnpm run lint` (check `no DSH package imports outside the adapter`), `packages/dsh-adapter` being the sole dependency holder

## Context

The obvious shortcut was to build the factory by extending `dsh-superagent-prototype` — the
prototype already ran an agent, had a worker loop, and understood DSH's session plumbing. Vendoring
it would have saved weeks and cost us the ability to say what the factory does.

The prototype was written to _make an agent do work_. This repository is written to _decide whether
work is good enough_. Those two goals pull the same code in opposite directions: a prototype wants
the agent to have the context it needs, a verifier wants the agent to have as little as possible.
And DSH is a moving dependency — an internal harness under active development, not a stable
platform. Every file that imports `@deepseek-ai/*` is a file that a breaking change can reach.

The decision the debate forced: the factory is a **clean-room** implementation against DSH's
_package boundaries_, and DSH is quarantined behind one seam.

## Decision

Only `packages/dsh-adapter` imports `@deepseek-ai/*` (`packages/dsh-adapter/src/overlay.ts`,
`packages/dsh-adapter/src/executor.ts`). Everything else — the state machine, the store, the
qualifier, the wall, the gates, the CLI, the panel — depends on this repository's own
`packages/contracts` vocabulary and on the adapter's narrow interface.

The boundary is enforced, not documented: `scripts/discipline-lint.sh` fails the build when a
non-adapter file imports a DSH package, with an explicit allowlist for the adapter and its tests.
The adapter also owns the per-trust-domain `DSH_HOME`, the overlay composition, the
NDJSON stream, the watchdog and the egress probe, so DSH's opinions stop at that package.

## Alternatives rejected

- **Vendor or fork the prototype.** Rejected because the code we would inherit optimises for the
  wrong goal (agent capability, not verification), and because a fork makes the audit surface
  unbounded: a stranger could not tell which behaviour was ours and which was inherited. Clean-room
  also lets the store be the only writer of evidence, which the prototype's session model fights.
- **Import DSH directly in the CLI and skip the adapter.** Rejected because it puts the moving
  dependency on the operator surface: a DSH upgrade would change CLI behaviour and exit codes.
  The adapter is also where the per-attempt `DSH_HOME`, the secret scrubber and the child-env
  allowlist live; spreading those across `apps/cli` would make the isolation claims untestable.
- **Abstract DSH behind a generic "agent" interface with a second implementation.** Rejected as
  speculative generality: only one harness exists, and a fake second implementation would be
  untested code pretending to be a portability claim. The adapter's _fake executor_ is a test
  double, not an abstraction layer.

## Consequences

**Good.** DSH upgrades land in one package with its own test suite (`packages/dsh-adapter`,
142 passing, 1 skipped). The rest of the tree is testable with no `dsh` and no network — that is why
`pnpm test` passes on a laptop with neither installed. An auditor can read the adapter and know
everything DSH touches.

**Bad.** The adapter has to re-implement things the prototype got for free (session discovery,
stream parsing, overlays), and its tests are the most environment-sensitive in the repo: the
`profile.test.ts` skips itself without a `dsh`, so the DSH-facing half is partly proven by a
recorded probe rather than continuously. There is also a real cost at the boundary: when DSH's
overlay format changes, the factory has no fallback — the adapter either adapts or the run refuses
with `EXECUTOR_UNAVAILABLE`/`DSH_VERSION_MISMATCH` (exit 8), and no verdict is recorded.

**Not built.** The clean-room line says nothing about the _worker's_ runtime isolation: the
credential proxy that would keep the gateway key out of the worker's reach does not exist
(see [phase-13-audit.md](../planning/dark-factory-dsh/phase-13-audit.md) GAP-003 and
`docs/handover.md`).
