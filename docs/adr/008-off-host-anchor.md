# ADR-008 — Anchor the ledger head off-host, daily, and refuse an anchor older than 48 h

**Status:** accepted 2026-11-01 (ND4, ratified by the operator)
**Context:** [ADR-004](004-store-and-ledger.md) (the append-only ledger), [architecture.md](../planning/dark-factory-dsh/architecture.md) §9, constraint "DSH never the source of truth"
**Proven by:** `packages/anchor` (17 specs: chain recomputation, four verify outcomes, transports), `apps/cli/src/ledger.test.ts` (6 specs through the real CLI)

## Context

The ledger is append-only _inside a SQLite file this host controls_. Triggers stop the factory from
rewriting it, and the audit replays it — but a host-level attacker can replace the file, restore an
older copy, or rewrite the whole database and its triggers. Every claim the factory makes (verdict,
receipt hash, budget reservation) lives in that file, so a machine that rewrites its own history makes
all of it unfalsifiable. ND4 asked how far v1 should go. The answer, ratified 2026-11-01: **not a WORM
store and not third-party timestamping — a daily off-host anchor**, because that turns "undetectable"
into "detectable within 48 hours" for minutes of work.

## Decision

Once a day, write `{schemaVersion, seq, eventCount, headHash, anchoredAt}` somewhere the factory does
not own. Every reader checks it, and **refuses** when it is missing, stale, or behind.

- **The head is recomputable by a second party.** `headHash` is a chain over the events in `seq` order,
  hashed with the contracts' canonical JSON:
  `chain₀ = sha256("factory-ledger/v1")`, `chainᵢ = sha256(chainᵢ₋₁ + contentHash(eventᵢ))`. An auditor
  with a copy of the ledger computes the same string; that is the entire mechanism, and it is why the
  chain is built from the events rather than from stored per-row hashes (a host that rewrites a row can
  rewrite its hash too).
- **Four outcomes, one of which permits a claim.** `fresh` (inside `maxAgeHours`, default 48) is the
  only one that lets a caller say the ledger is anchored. `stale`, `missing` and `rollback` all exit 9.
- **`rollback` outranks `stale`.** If the anchor says the ledger had 400 events and this database has
  380, the local file was replaced or restored. A recency-only check would call that `fresh` — the exact
  failure the anchor exists to catch.
- **A local anchor is reported as local.** `FACTORY_ANCHOR_DIR` (another directory on this disk) is
  recorded with `scope: 'local'` and `verify` says "on this machine — this detects truncation, not a host
  that rewrites both copies". Only `FACTORY_ANCHOR_SSH` produces `off-host`, and only then does the
  factory claim off-host anchoring.
- **The destination is configuration, never data.** The transport is `ssh host 'cat >> PATH'` built at
  the composition root from `FACTORY_ANCHOR_SSH`/`FACTORY_ANCHOR_PATH`. No unit spec, receipt or verdict
  field can name a command: that would be a remote shell in a config file.

## What this does not buy

- **No prevention.** A rewrite still happens; it becomes visible within the window (`maxAgeHours`), no
  sooner. The README says "detectable within 48 h", never "prevented".
- **No correctness.** The anchor proves a head existed at a time, not that the verdicts were right.
- **No protection from the anchor host being compromised too** — at that point the attacker owns both
  copies, and the honest statement is that this is a speed bump, not a boundary.
- **Nothing about the holdout corpus** (that is ND2's topology) or about spend (ND3).

## Alternatives rejected

- **A WORM bucket / third-party timestamping.** Real, and more moving parts than a single-operator v1
  needs; the daily anchor already converts the attack into a detectable one.
- **Anchoring on every write.** Cost with no added property: the window shrinks from 48 h to minutes,
  and the detection story is identical.
- **A local-only anchor presented as "anchored".** That is the claim this ADR exists to prevent — the
  code reports `local` and `verify` says so in the reason line.
