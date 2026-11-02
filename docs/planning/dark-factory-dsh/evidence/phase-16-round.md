# Phase 16 — the broker's allow path, a channel that reaches a person, and a refusal instead of a mystery

**Written:** 2026-11-02, against `57db9b5` + the release commit that carries this file and the artifacts
below.
**What this round is:** the three items the operator's "go" selected, in the order it named them — R5's
allow path (`052f63f`), container isolation by default turned into a *refusal* of the combination that
cannot work (`52f63f`/`57db9b5`), and notification delivery for `factory alerts` (`045ae5f`) — plus the
docker-spec defect the first item's gate run exposed (`57db9b5`).

**Rule applied throughout, unchanged:** a claim with no test is `UNPROVEN`, never `met`. Where a number
came from a commit or a teammate's report rather than a command I ran in this session, it says so.

## 0. The gate, on the release tree

| tree      | command                  | result                                                                                                                                                                 | artifact                                  |
| --------- | ------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------- |
| `57db9b5` | `bash scripts/verify.sh` | **7 passed, 1 skipped, 0 failed** — `preflight`, `typecheck`, `lint`, `format:check`, `test`, `build`, `panel` PASS; `live-model` SKIPPED (no key)                     | `docs/verification/2026-11-02T23-20-42Z/` |
| `052f63f` | `bash scripts/verify.sh` | **6 passed, 1 skipped, 1 failed** — `test` red: 4 `@docker` specs failed (E2E-45 timed out at 180 s; three egress specs "container is not running")                    | `docs/verification/2026-11-02T22-57-34Z/` |
| `052f63f` | `bash scripts/verify.sh` | the same tree after removing the leftover containers by hand — **7 passed, 1 skipped, 0 failed**                                                                      | `docs/verification/2026-11-02T23-06-42Z/` |
| `57db9b5` | `bash scripts/verify.sh` | **7 passed, 1 skipped, 0 failed**, with `07-isolation` (6), `08-worker-container` (3) and `09-recover-sweep` (2) all **run**, none skipped                              | `docs/verification/2026-11-02T23-17-11Z/` |
| `8a77f07` | `bash scripts/verify.sh` | **7 passed, 1 skipped, 0 failed** on the release commit itself — the run the tag carries, `dirtyPaths: 1` (this run's own directory) | `docs/verification/2026-11-02T23-23-08Z/` |

Test stage on the release run: **1472 passed | 7 skipped (1479) across 99 passed | 2 skipped files**.
The seven skips are the same declared set phase 15 recorded (3 `@live`, 3 opt-in
`FACTORY_TEST_IMAGE` daemon round-trips, 1 inverse-daemon branch), and `summary.json` again records
`BIFROST_API_KEY: false` — an offline run that did not spend, on a host that could have.

The two red runs are kept rather than deleted, and they are not incidental: the first one is how the
docker-spec collision in §3 was found. A green gate that appears on the first attempt and a green gate
that appears after a defect is fixed are different facts, and this file is where the difference is
visible.

## 1. R5's allow path — a person can approve exactly one operation, once

**Before.** `packages/proxy` could classify a privileged argv and refuse it, and its `DecisionSink` and
`DecisionRegistry` ports had one caller each, both passing `null`/a fresh in-memory map. So: no verb
minted a decision, nothing could turn "I approve this" into a record the broker accepts, and even if
something had, `createMemoryRegistry()` lived for one call, so a decision could be replayed by the next
process. README said so in its own words ("the allow path is exercised only by a signed decision built
in `packages/wall/src/local.test.ts`").

**After.** `factory gate request|decide|list|show` (`apps/cli/src/verbs/gate.ts`, `apps/cli/src/gate.ts`):

- `request` is read-only: normalised operation, `sha256`, `taskId` label, operator key id, the payload
  to sign, and a `decide` line with `--issued-at` **and** `--expires-in` filled in. Exit `5` when the
  operation is privileged and uncovered, `0` when it is not.
- `decide` verifies the operator's ed25519 signature against the promote lookup order, then writes the
  `FACTORY_HOME/gates/<id>.json` artifact and one `privileged.decided` event. It never signs; a missing
  `--signature` is exit 2 with that sentence in it.
- one-use is a row: schema **v4** `privileged_decisions`, `INSERT … ON CONFLICT DO NOTHING`,
  `changes === 1` = "this caller won". The registry is the store's, so the marker outlives the process.
- the fake executor's brokered `command` step presents the decision whose **classified** operation
  matches (`liveDecisionFor`), and takes the phrase from that verified record — never from argv, the
  step text, or the receipt.

**Proof, the three runs** (`e2e/cli/default/19-gate-decisions.test.ts`, real CLI, fresh home per spec):
refused with exit 5 `[broker.no-decision]` and the destination file absent → authorised exactly once
(1 `attempt.receipted`, 1 `privileged.decided`, the effect on disk, `isDecisionConsumed` true) → the
same decision presented by a second unit refused with exit 5 `[broker.replayed]`, still 1 of each event.

**Mutations** (each guard deleted → the named spec red, then restored): `consume` returning `true`
unconditionally → `expected [ true, true ] to have a length of 1`; `launch.ts` passing the memory double
instead of the store registry → the marker is never in the store; `decide` re-reading the clock instead
of `--issued-at` → 6 red including the T → T+1 s fail-closed case; skipping
`verifyPayloadSignature` → 3 red.

**Captured here, not only in the spec** (throwaway `FACTORY_HOME=/tmp/doc-capture`, a key generated for
the occasion):

```
$ factory gate request -- cp /etc/hosts /dev/null
operation  cp /etc/hosts /dev/null
operationSha sha256:872f7652c297b9fbe8e9afe910f42b40e590ca3982490e868d0e09809a5781e6
operator key ed25519:554ecfdf
payload to sign …   sha256:21d1cac3e3750acdc4728967e6d5bcbaecb062c320a80c9cf9770bebe2ede51e
… --issued-at 2026-11-02T23:19:42.126Z --confirm "decide 872f7652" …
exit=5
$ factory gate decide --signature … --issued-at 2026-11-02T23:19:42.126Z --expires-in 15m --confirm "decide 872f7652" -- cp /etc/hosts /dev/null
decision   gd_21d1cac3e3750acdc4728967
live until 2026-11-02T23:34:42.126Z (issued 2026-11-02T23:19:42.126Z)
ledger     privileged.decided seq 1
exit=0
$ factory gate decide --signature … --issued-at 2026-11-02T23:19:43.126Z …    # the copy-it-later case
GATE_REQUIRED: the signature does not verify against ed25519:554ecfdf for payload sha256:643d235c…
exit=5
$ factory gate decide --issued-at … --confirm "decide 872f7652" -- cp /etc/hosts /dev/null
USAGE: missing --signature. This tool verifies an operator signature; it never holds a private key…
exit=2
$ factory gate list; echo $?                                                  # with a corrupt artifact present
unreadable: /tmp/doc-capture/gates/gd_broken.json
  a decision artifact needs a string 'operationSha'
3
```

**What a decision does not buy.** The wall is not a consumer. `apps/cli/src/wall.ts` builds the local
runner with no `decision`, no `activeKeys` and no `operatorPhrase`, `WallInputs` has no field for them,
and its only call site passes none — deliberately: the receipt is the worker's own claim, and a wall
that accepted a decision *from the receipt* would be trusting its subject. So a privileged argv is
refused at replay whatever the launch held, and the verdict carries `privileged_unbrokered`. That code
names what happened **at replay**; it does not claim the operation was unapproved. I considered renaming
it and did not: `WALL_REASON_CODES` is a closed zod enum in `packages/contracts/src/verdict.ts`, so a
rename would make every stored verdict carrying the old string fail to parse — breaking the evidence it
is meant to describe. The honest record is the doc comment, the README paragraph and this section
saying which claim the code makes. Threading decisions into `WallInputs` (a verify-only registry, a new
trust surface) is a design change and its own task, not a footnote to this one.

## 2. A launch combination that cannot work now says so

Container isolation gives the worker `--network none`; the credential proxy binds `127.0.0.1` on this
host (ADR-007). `FACTORY_WORKER_ISOLATION=container` + `FACTORY_LIVE_MODEL=1` + a key therefore could
never authenticate, and the failure surfaced after the worker started as an unexplained 401 — which
reads as a model fault, not a configuration one.

The probe now refuses it: exit 8 **`CONFIGURATION_CONFLICT`**, a new code distinct from
`CONTAINER_UNAVAILABLE` ("nothing is missing and nothing needs to be built"), with nothing reserved, no
attempt directory, no `usage_records` row, both levers named, both ways forward named, and the runbook
section named. `factory --help` says exit 8 has two next actions and the code says which; the outbox
classifies the conflict `retryable`; `exit.ts` keeps one copy of the advice, used by both the probe and
`runbookFor`. Measured here (key `sk-…` supplied, nothing dispatched):

```
CONFIGURATION_CONFLICT: FACTORY_WORKER_ISOLATION=container runs the worker with `--network none`, but a live
model (FACTORY_LIVE_MODEL=1) authenticates through the credential proxy, which binds 127.0.0.1 on the host. …
Nothing was dispatched and no budget was reserved.
  runbook: docs/runbooks/worker-container.md §"When the two settings cannot both be honoured" — the daemon and
  the image are fine; unset FACTORY_WORKER_ISOLATION (drop the container) or FACTORY_LIVE_MODEL …
$ echo $?   → 8
```

**This is also the answer to "should container isolation be the default".** It cannot be, yet: with the
proxy on loopback and the worker on `--network none`, defaulting the container would make the live
layer unusable by default. What this round changed is that the trade-off is now *stated by the tool*
instead of discovered by a person at 2 am. Making the container the default needs a transport that
survives `--network none` — an `--internal` docker bridge with the proxy listening on its gateway, or a
unix-socket transport — designed and proven, not assumed.

## 3. The docker specs were killing each other's containers

The first green-gate attempt failed `test` with four `@docker` failures. The cause was not the product:
E2E-45 discovered its container with `docker ps --filter name=factory-worker-` and took the **first**
match, while `packages/dsh-adapter/tests/egress.test.ts` created containers in the same namespace. Under
`maxWorkers: 4` E2E-45 selected the egress spec's container, `docker kill`ed it, then waited out its own
180 s timeout; its own container survived, and the leftovers poisoned later runs (the second run only
went green after a human ran `docker rm -f`).

Fixed in `57db9b5`: discovery by `--filter label=org.factory.attempt=<attemptId>` — the label the
launcher writes and `recover --sweep` already relies on — plus an ownership assertion (`docker inspect`
of the label) before the kill; the egress spec's hand-rolled container renamed out of
`factory-worker-*`; `07-isolation`'s leftover net scoped to its own suite rather than `name=factory-wall-`.

Proven deterministically rather than by timing: with a foreign decoy container present and the old
filter restored, the spec killed the decoy (`Exited (137)`) and timed out at 180 s with its own container
left up; with the fix and the same decoy, the decoy stayed `Running` and the spec passed in 1.6 s. Two
consecutive concurrent runs of `08`+egress: `8 passed | 1 skipped`; two of the whole `e2e/cli/docker`
suite at `maxWorkers: 4`: `11 passed (11)`, no leftovers.

## 4. Alerts reach a person — opt-in, and never by changing the exit code

`factory alerts --notify` (`apps/cli/src/notify.ts`, off by default) delivers after the same
read-only computation: a macOS notification through `osascript` with the text passed as `argv` (never
interpolated into AppleScript) plus one `NOTIFY …` line; or, with `FACTORY_ALERTS_WEBHOOK_URL`, exactly
one bounded POST of the existing `alerts.v1` JSON, at most one retry for transport/5xx, redirects
refused, and the URL reported as scheme+host only because a webhook URL is a credential. Non-darwin is
a reported no-op. Nothing retries a lost notification; `0`/`8`/`9` still describe the evidence.

Captured on this host (throwaway home and anchor dir):

```
$ factory alerts --notify          # exit=9, CERT_NEVER
NOTIFY  DELIVERED — macOS notification displayed through osascript
$ factory alerts                  # exit=9, no NOTIFY line
$ factory alerts --notify          # exit=8, anchor unconfigured
NOTIFY  DELIVERED — macOS notification displayed through osascript
$ FACTORY_ALERTS_WEBHOOK_URL="http://127.0.0.1:17891/secret-hook?token=…" factory alerts --notify   # exit=9
NOTIFY  DELIVERED — http://127.0.0.1:17891 answered HTTP 200 (1 attempt)    # path and query absent
```

Nine mutation checks in `apps/cli/src/alerts.test.ts`'s report each turned one named spec red
(always-deliver; notify on exit 0; integrity filter removed; 4xx retried; darwin check inverted; path
leaked; channel throw swallowed; exit code replaced with 0; transport throw). The plist now runs
`--notify` and documents `FACTORY_ALERTS_WEBHOOK_URL` as a commented, unset variable; the runbook's
`RunAtLoad` comment was corrected against `launchd.plist(5)` (missed calendar occurrences are coalesced
and run on wake by `StartCalendarInterval`, not by `RunAtLoad`).

**Not verified here:** that the banner rendered (a shell cannot see the screen — `osascript` exited 0
and the line said so); that the *installed* launchd agent picks up the new plist (`launchctl list` still
shows the previous argument list; installing it is an operator action, and it changes what the machine
does at 04:00); and the non-darwin path end-to-end (unit seam only, `platform: 'linux'`).

## 5. Documents

- `README.md` — the R5 paragraph now describes the allow path, the one-use marker and what a decision
  does *not* buy; the container bullet names `CONFIGURATION_CONFLICT` and why the container cannot be
  the default yet; the alerts paragraph and the ND bullet carry the exact limits of `--notify`.
- `docs/handover.md` — the two bullets that said the allow path did not exist are rewritten, and
  `privileged_decisions` is described as a marker table rather than a decision store.
- `docs/runbooks/brokered-operations.md` (new) — the four commands, the operator's signing step, the
  `--` trap, timestamps inside the payload, one-use semantics, the wall's non-consumption, and what is
  deliberately not built (`gate revoke`, a key registry, signing).
- `docs/runbooks/worker-container.md` — new section for the configuration conflict, measured.
- `docs/runbooks/{README,evidence-expiry,ledger-anchor,outbox-effect-stuck}.md`,
  `apps/cli/src/render/limits.ts` — the "nothing pages" and "this command is deterministic" sentences
  corrected to name the one exception (`alerts --notify`), in the same words as the README.

## 6. Disclosures

- **The operator's store was migrated.** Opening the CLI from this tree applied migration v3 → v4 to
  `/Users/bo/.factory/state/factory.db` (`schema_migration` row `version: 4`,
  `applied_at 2026-11-02T23:20:27.388Z`). The migration is additive (a new table) and idempotent, and
  any later invocation of the new binary would have applied it; it is recorded here because it is a
  write to the real store and this file is where such writes are accounted for. No rows were edited,
  deleted or reset, and no evidence was touched.
- **The runbook transcript was re-spliced.** The first version of `brokered-operations.md` mixed output
  from more than one capture: its step-3 block passed `--issued-at …568Z` while its own output printed
  `issued …728Z`, which is a transcript that could not have verified. Every value in those blocks was
  replaced with a single capture made here (`/tmp/doc-capture`, key `ed25519:554ecfdf`, issued
  `23:19:42.126Z`, decision `gd_21d1cac3e3750acdc4728967`) and the two exit codes near it (`2`, `3`)
  were re-run and matched. The three-run scenario in §4 of that runbook is the teammate's capture,
  quoted as given.
- **The paid layer was not re-run** (no `BIFROST_API_KEY` in this shell). The `@live` specs remain
  SKIPPED with their reason; the last recorded live gate is still `docs/verification/2026-11-01T21-58-16Z/`.
  Nothing in this round's claims depends on a paid call.
- **Not built, and named rather than implied:** `gate revoke`; a key registry beyond the promote lookup
  order; per-unit decision listing; decisions threaded into the wall; a container-side egress probe;
  the container as the default; scheduled re-certification; the broker's reach into a real `dsh` turn's
  own tool calls (ADR-006); and the ~30 dead citations to `research/existing-state.md` across six
  planning artifacts, which are recorded in `phase-15-round.md` §8 and left unedited because the plan
  set is a historical record.

## 7. What the next round should pick up

1. **A transport that survives `--network none`** (an `--internal` docker bridge whose gateway the
   proxy listens on, or a unix-socket proxy): it is the precondition for making the container the
   default, and the only item on this list that unblocks two others.
2. **`gate revoke`** plus a decision list per unit — the two operator conveniences this round's verbs
   make conspicuous by their absence.
3. **Decisions in the wall, or a rename with a migration** — decide which claim `privileged_unbrokered`
   should make, and pay the cost of a reason-code migration if the answer is "a different one".
4. **Scheduled re-certification** — a monitor says a certificate expired; a person decides to
   re-measure, and the measurement is paid. This is the last item standing between the operator's
   alerts and an empty inbox.
