# Architecture decision records

Six decisions the plan's debate actually argued, each written as: the context that forced a choice,
the decision, the alternatives rejected **and why**, and the consequences including the bad ones.
They are the arguments behind the three laws in the [README](../../README.md), and they are the
places where "this repo behaves differently from the obvious design" is deliberate.

| ADR                                   | Decision                                                                |
| ------------------------------------- | ----------------------------------------------------------------------- |
| [001](001-clean-room-on-dsh.md)       | Clean room on DSH: only `packages/dsh-adapter` imports `@deepseek-ai/*` |
| [002](002-wall-generator-blind.md)    | The wall is generator-blind; the holdout is the only oracle             |
| [003](003-unknown-is-not-a-pass.md)   | `unknown` is first-class and never satisfies a gate (+ exit-code map)   |
| [004](004-evidence-identity.md)       | Evidence identity is the decision projection, not the receipt body      |
| [005](005-effect-outbox.md)           | The launch effect is committed before dispatch, settled after it        |
| [006](006-deepseek-behind-bifrost.md) | DeepSeek only, behind Bifrost, and no paid call in any test             |
| [007](007-scoped-credential-proxy.md) | A scoped credential behind a localhost proxy, not a key in the child    |

Where a decision implies something this tree does not contain, the ADR says **not built** and links
[phase-13-audit.md](../planning/dark-factory-dsh/phase-13-audit.md) rather than describing the plan's
intent as if it were code. ADRs are amended by superseding, never by quiet edits.
