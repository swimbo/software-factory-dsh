# Decision Briefs — Index

Volatile decisions (anything that can change faster than the plan: model/provider, AI SDK, third-party services, datastore, framework or dependency majors, architectural patterns, auth strategy, data contracts, deploy/CI patterns, observability) get a **Mode B brief** here with a `/debate` outcome before adoption.

**Not in this INDEX:** decisions already settled by the Phase 5 (architecture) and Phase 6 (tech guide) Mode A debates. Those live in [`../consensus-plan.md`](../consensus-plan.md) and [`../debate-transcript.md`](../debate-transcript.md), with the folded outcomes in [`../architecture.md`](../architecture.md#11-debate-outcomes) and [`../tech-guide.md`](../tech-guide.md#11-debate-outcomes).

| #             | Date       | Decision                                                                                                   | Category                               | Mode                          | Outcome                                                          | Status  | Brief                                                                                 |
| ------------- | ---------- | ---------------------------------------------------------------------------------------------------------- | -------------------------------------- | ----------------------------- | ---------------------------------------------------------------- | ------- | ------------------------------------------------------------------------------------- |
| 2026-11-01-01 | 2026-11-01 | Durable store: SQLite (node:sqlite) + append-only ledger + effect outbox, instead of Temporal/Restate/DBOS | datastore, architectural pattern       | A (Phase 5 debate)            | see consensus-plan.md                                            | decided | [`../architecture.md`](../architecture.md) §2.1 / §10                                 |
| 2026-11-01-02 | 2026-11-01 | Worker seam: headless `dsh` subprocess (ACP deferred)                                                      | architectural pattern, third-party API | A (Phase 5 debate)            | see consensus-plan.md                                            | decided | [`../architecture.md`](../architecture.md) §2.2                                       |
| 2026-11-01-03 | 2026-11-01 | DeepSeek models only, via the existing Bifrost gateway                                                     | model/provider                         | user decision (constraint C1) | fixed by the user                                                | decided | [`../phased-plan.md`](../phased-plan.md#constraints-locked-user-confirmed-2026-11-01) |
| 2026-11-01-04 | 2026-11-01 | Runtime stays on Node 22.23.3 (engine window `>=22.12 <27`) rather than upgrading to 24.9+/26              | runtime version                        | A (Phase 6 debate)            | see tech-guide.md §1                                             | decided | [`../tech-guide.md`](../tech-guide.md) §1                                             |
| 2026-11-01-05 | 2026-11-01 | `node:sqlite` (RC/experimental) behind a swappable driver, `synchronous=FULL`, `busy_timeout=5000`         | datastore, dependency                  | A (Phase 6 debate)            | see tech-guide.md §10                                            | decided | [`../tech-guide.md`](../tech-guide.md) §10                                            |
| 2026-11-01-06 | 2026-11-01 | Playwright restricted to the status page; CLI e2e on vitest + `child_process`                              | test tooling                           | A (Phase 6 debate)            | see tech-guide.md §5                                             | decided | [`../tech-guide.md`](../tech-guide.md) §5                                             |
| 2026-11-01-07 | 2026-11-01 | Per-attempt `--patch` overlay decouples approval `never` from `workspace-write`                            | data contract (DSH config)             | B                             | verified with `--dump-config`; only one viable composition found | decided | [`../findings.md`](../findings.md) §D3 correction                                     |

## Template for a Mode B brief

```md
# Decision YYYY-MM-DD-NN — <title>

**Category:** <volatile category>
**Trigger:** <what forced the decision now>
**Options:** <2-4 concrete options with current versions/status>
**Evidence:** <URLs, file paths, registry versions, dates>
**Reversal cost:** <low/medium/high + what must change>
**Debate:** <personas, rounds, outcome summary>
**Decision:** <chosen option>
**Consequences:** <what becomes true / what is now forbidden>
**Revisit when:** <trigger condition>
```
