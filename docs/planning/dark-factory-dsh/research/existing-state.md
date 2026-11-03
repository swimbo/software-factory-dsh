# `existing-state.md` — deleted, and what that means for the citations that point here

This file was the research record of the **predecessor factory** (the Path-A tree). It was deleted
deliberately in commit `e538fdf` — *"chore: delete the prior system, so one repository means one
factory"* — together with that system's source, its plan set and its CI receipts.

It is not restored here, and it should not be. Resurrecting a description of a system this repository
no longer contains is exactly the "one repository, two factories" confusion the deletion was for.

**What this file being gone means.** 66 citations in the historical planning set
(`architecture.md`, `consensus-plan.md`, `findings.md`, the phase plans, the debate transcript) point
at `research/existing-state.md#L…` with line anchors into a 559-line file that no longer exists. Those
anchors cannot resolve, and the claims they support cannot be checked from this repository:

- They are **UNPROVEN here**. Not false — unverifiable. A claim of the form "the prior factory had
  `reserve() → {new, unknown, completed}`" may well have been true of that code; nothing in this tree
  can confirm or refute it, and the code it described is gone from the history by design.
- The planning set is a **historical record** (`AGENTS.md`: it is not to be edited or ticked). The
  citations are left in place rather than rewritten, because rewriting them would claim the planning
  round knew something it did not.
- Where a decision actually depends on one of those claims, the decision must rest on evidence that
  lives in this repository — a spec, a measurement, or a document under `docs/runbooks/`. Several
  already do: CP-7 and CP-9 in `consensus-plan.md` cite this file for *why the signal was added*, but
  the behaviour they describe is pinned by tests here.

**The rule this file exists to state.** A citation is a pointer to evidence, and evidence that has
been deliberately destroyed is not evidence. If a future round needs the prior factory's behaviour, it
needs a fresh measurement in this tree, not a link into a deleted document.

Recorded 2026-11-03 (round 11) after a reader following `architecture.md`'s research-basis line
reached a 404.
