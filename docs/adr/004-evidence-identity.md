# ADR-004 — Evidence identity is the decision projection

**Status:** accepted, superseding the whole-body receipt hash (`b92f5cc`)
**Context:** [data-map.md](../planning/dark-factory-dsh/data-map.md) §2 (receipt/verdict), [findings.md](../planning/dark-factory-dsh/findings.md) (item 3)
**Proven by:** `packages/contracts/src/receipt.ts`, `packages/store/src/store.ts` (`getReceiptBySha`), `packages/core/src/engine.ts` (`RECEIPT_CONFLICT`), `e2e/cli/default/09-holdout-sabotage.test.ts`

## Context

A worker run produces a receipt: the commands it ran, their exit codes, artifact hashes, the pinned
suite's output — and a free-text `narrative` in which the agent explains itself. The first
implementation hashed the **whole** receipt, narrative included, and used that hash as the receipt's
identity (`receiptId`/`receiptSha`) everywhere: the store row, the attempt's `attempt.receipted`
event, and the verdict's `receiptSha`.

That is a mint. The narrative is unconstrained text the generator writes. Hash the whole body, and
the generator can produce a _new_ receipt identity without changing a single mechanical fact — by
editing a sentence. Every store-level invariant ("one attempt, one receipt", "a verdict cites the
receipt the wall read") would then be true of the _bytes_ and false of the _evidence_. It also means
the identity of the evidence an agent is judged on changes when the agent rewrites its excuse, which
is precisely the wrong coupling: the narrative is the one part of the receipt that must not matter.

## Decision

Evidence identity is the **decision projection**: `receiptShaFor(receipt)` =
`contentHash(toDecisionReceipt(receipt))`, where `toDecisionReceipt` strips `narrative` and nothing
else. So:

- the `narrative` never enters a hash, an idempotency key, a verdict, or a store index;
- the identity of the evidence is a function of the mechanical facts only;
- the raw receipt (narrative included) is still stored and still shown to a human via
  `factory receipts <unitId>`, which never prints the diff and never treats the narrative as
  evidence;
- a verdict must cite a receipt the factory actually holds (`engine.recordVerdict` →
  `store.getReceiptBySha` → `RECEIPT_CONFLICT` if absent, or if it belongs to another attempt/unit).

## Alternatives rejected

- **Hash the whole receipt (status quo ante).** Rejected as above: narrative-editable identity.
- **Hash only the artifact SHA and drop the mechanical facts from identity.** Rejected because the
  evidence is the _commands and their outcomes_, not just the resulting tree: two different command
  sets that leave the same tree are different evidence, and the wall's faithfulness check
  (`receipt_unfaithful`) is about re-executing those commands.
- **Two identities (a body hash and a projection hash) with the store holding both.** Rejected
  because two ids for one receipt guarantees that some caller uses the wrong one — the store's
  "one attempt, one receipt" check would then have to pick a side, and the audit would inherit the
  ambiguity. One identity, computed the strict way.
- **Strip the narrative but keep the free-text `notes` fields the worker also writes.** Rejected:
  same attack surface. Only fields the wall re-executes or the store enforces are in the projection.

## Consequences

**Good.** An agent cannot mint new evidence by editing prose, so "which evidence did the wall
judge?" has one answer per attempt. The sabotage spec can assert what it needs to assert: a change
that passes its own visible suite is rejected, and no artifact is written under a valid signature.
Receipts are still human-readable; the narrative is preserved for the audit trail.

**Bad.** Every write site has to compute the projection hash, and the identity is _not_ the hash of
the bytes stored on disk — a reader who re-hashes the stored receipt body gets a different number.
That mismatch already bit once: after `b92f5cc` the panel's E2E seed harness still passed
`contentHash(receipt)` while the engine stored `receiptShaFor(receipt)`, so the browser suite failed
at seeding with `RECEIPT_CONFLICT` ("cites receipt … which is not recorded"). The fix is one call
site; the lesson is that a projection hash needs exactly one function and no local reimplementations.

**Not built.** The wall's `faithful` field is not recorded by the store (the verdict carries
`receipt.faithful: null` in the panel projection) — the projection rule makes identity honest, but
"the wall re-executed these commands and got the same result" is still a property of the wall's own
record, not a store column (`docs/handover.md`, known gaps).
