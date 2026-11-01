# ADR-003 — `unknown` is a first-class outcome that never satisfies a gate

**Status:** accepted (Phase 1, enforced on every surface since)
**Context:** [ux-plan.md](../planning/dark-factory-dsh/ux-plan.md) §5.1 (exit codes), [findings.md](../planning/dark-factory-dsh/findings.md) (ux-plan A-1)
**Proven by:** `e2e/cli/default/07-seams.test.ts` (`VERDICT_UNKNOWN` with a correctly signed promotion), `packages/contracts/src/verdict.ts`, `apps/panel` (117 tests), `e2e/panel`

## Context

Three-valued logic is where this kind of system usually lies. The wall cannot always decide: the
holdout may be unavailable, the receipt may not re-execute, the container may not start, the store
may be quarantined. The pressure is always to collapse that third case — "we couldn't measure it,
so treat it as fine" (a silent pass) or "we couldn't measure it, so treat it as a failure" (a false
red). The first promotes unverified work; the second teaches operators to ignore red.

The debate's rule: **not measured is a fact, and facts do not get rounded.** A verification result
has exactly three outcomes, and the third one is not a flavour of the other two.

## Decision

`unknown` is a stored, first-class verdict state (`packages/contracts/src/verdict.ts`:
`passed | failed | unknown`), and it **never satisfies a gate**:

- **Promotion refuses it.** `factory promote` on an unknown verdict exits `5` (`VERDICT_UNKNOWN`
  after the refusal is recorded, or `PROMOTION_UNSIGNED` before). There is no `--force`, no
  override, and `-y`/`--yes`/`-f`/`--assume-yes` are usage errors (exit `2`).
- **The qualifier routes it to a person.** `deriveLane` only returns `dark` when **every** signal
  passed and the score clears the threshold (`packages/qualifier/src/qualify.ts`), so a single
  `unknown` signal yields `lit` — parked for an operator — and never `dark`. The weight for
  `unknown` is half rather than zero on purpose: zero would make "nobody has run this task class"
  arithmetically identical to "this class has escaped twice".
- **The status surfaces count it separately.** The CLI's one-liner and the panel's aggregate line
  read `N in flight · M need you · K unknown (not a pass)` — the word "unknown" is always followed by
  "not a pass", in both surfaces.
- **It is rendered in its own colour token**, not in the ok token, and the card says the literal
  words "not a pass" plus the wall's `unknownReason`.

The exit-code map follows from the same rule (`apps/cli/src/exit.ts`):

| code | meaning                 | example                                                                  |
| ---- | ----------------------- | ------------------------------------------------------------------------ |
| 0    | ok                      | a verdict was recorded and it is a pass                                  |
| 1    | internal                | a bug: a contract the code believed was impossible was violated          |
| 2    | usage                   | unknown verb/flag, `-y`, a missing required option                       |
| 3    | policy                  | lane not dark, mandate expired, an illegal transition                    |
| 4    | **unknown / ambiguous** | `run` produced no verdict; a stale attempt was reconciled to `ambiguous` |
| 5    | gate                    | unsigned promotion, `unknown` verdict, a gate awaiting a person          |
| 6    | budget                  | the envelope cannot cover the estimate                                   |
| 7    | conflict                | lease held, duplicate unit, receipt conflict                             |
| 8    | environment             | no `dsh`, no container, wrong DSH version, unusable mirror               |
| 9    | integrity               | quarantined store, ledger divergence                                     |

`4` and `5` are deliberately different codes: "the machine could not measure it" is not "a person
has to sign something".

## Alternatives rejected

- **Two-valued verdicts, with unknown mapped to `failed`.** Rejected because it destroys the
  operator's ability to triage: a run that never reached the wall would look like a run the wall
  judged and condemned, and the remedy differs (`re-run/observe` versus `fix the change`). It also
  makes `status` unable to answer "how much of my backlog is unmeasured?".
- **Two-valued verdicts, with unknown mapped to `passed` (or "passed with a warning").** Rejected
  outright: it is the silent pass this repository exists to prevent, and it makes the sabotage spec
  meaningless (every unmeasured sabotage would promote).
- **A boolean `measured: true|false` alongside `passed: true|false`.** Rejected in
  `ui-plan.md` §5.3's spirit: a second axis invites renderers to drop it, and one enum is harder to
  ignore than a flag. `packages/contracts` refines the schema so `unknownReason` is non-null **iff**
  the state is `unknown` — the reason cannot be omitted.
- **Treating `unknown` as retryable automatically.** Rejected: an automatic retry of an unmeasured
  attempt is a second worker launch, which is exactly the double-launch this system forbids
  (ADR-005). Re-measuring is an explicit act: `factory run <unitId> --verify-only`.

## Consequences

**Good.** Every unknown is a decision a person can see with a reason attached, and the store can
answer "what is unmeasured?" without inference. The panel cannot paint an unknown green — the
colour comes from the `unknown` token and there is a browser spec asserting that the pill's computed
background is the `--unknown` token and not `--ok` (`e2e/panel/unknown-not-pass.spec.ts`). Scripts
can switch on exit `4`/`5` alone.

**Bad.** There are more states to render, and every new surface must remember the third one — the
audit's ux-plan A-1 finding is precisely a surface that forgot (a status line that said "0 need
you" while an unknown verdict existed). Operators get a second class of red to learn; runbooks have
to distinguish "the machine could not measure" from "the machine measured a failure".

**Not built.** `unknown` is stored and blocks every existing gate, but the _gate that would consume
a measured pass rate_ does not exist: ND1 (the certification operating point) is undecided, so the
wall reports Δ and names the operating point as undecided rather than claiming certification
(`docs/handover.md`, `phase-13-audit.md` §7).
