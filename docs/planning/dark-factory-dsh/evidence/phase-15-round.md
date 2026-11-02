# Phase 15 — the container's orphan, the expiries somebody now asks about, and the repo's account of itself

**Written:** 2026-11-02, against the tree at `edf3b1a` (+ the verification artifacts of the run below).
**What this round is:** the four commits a previous session landed after `v0.4.0` (`59a18fc` alerts,
`3c8e063` the ND3 ceiling through the real executor, `36e2ddd` the worker's container, `f362900` +
`0d916da` anchor read failures) were never released, never gathered into an evidence file, and one of
them named a gap and left it open. This round closes that: the sweep (`ec9f8e9`), two documents that
had stopped describing the tree (`70486c8`, `63141b6`), a release (`edf3b1a`), and this file — which
`docs/runbooks/worker-container.md` already cited before it existed.

**Rule applied throughout, unchanged:** a claim with no test is `UNPROVEN`, never `met`. Where the
number in this file came from a commit rather than a command I ran here, it says so.

## 0. The gate, on the released tree

| tree        | command                  | result                                                                                                                        | artifact                                  |
| ----------- | ------------------------ | ----------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------- |
| `dd518e8`   | `bash scripts/verify.sh` | **7 passed, 1 skipped, 0 failed** — `preflight`, `typecheck`, `lint`, `format:check`, `test`, `build`, `panel` PASS; `live-model` SKIPPED (no key) | `docs/verification/2026-11-02T16-46-33Z/` |
| `edf3b1a`   | `bash scripts/verify.sh` | the same result one commit earlier, on the release commit itself                                                              | `docs/verification/2026-11-02T16-44-03Z/` |

The tag `v0.5.0` points at the commit that carries these two artifacts and this file; the tree it
tags differs from the tree `dd518e8`'s run measured only by the run's own output and by this
paragraph. The summary records `dirtyPaths: 2` for that reason — both are the `docs/verification/`
directories the run was writing while it measured itself. Every other file was committed.

Test stage: **1395 passed, 7 skipped (1402) across 99 files**. The seven skips are all declared, none a
fail-by-omission: 3 `@live` (no `BIFROST_API_KEY` in this shell — C5), 3 in
`packages/wall/src/container.test.ts` (the opt-in `FACTORY_TEST_IMAGE` real-daemon round trip), and 1 in
`packages/dsh-adapter/tests/egress.test.ts` (the branch that proves the suite skips, rather than fails,
without a daemon).

The environment summary records `BIFROST_API_KEY: false` and `dsh 0.2.1-rc.5 available` — so this is an
offline run that did not spend, on a host that *could* have.

Two earlier runs of the same command are kept rather than deleted, because they are what a red gate
looks like: `docs/verification/2026-11-01T22-41-51Z/` (the previous session, red in `test`, `build` and
`panel` when it stopped mid-work) and `docs/verification/2026-11-02T16-16-14Z/` (this session's first
run, red **only** in `panel`, because every Playwright browser had been removed from this host's cache;
`npx playwright install chromium` restored `chromium-1248` and the stage went green). A gate that can
only be recorded green is not a gate.

## 1. The recover-side sweep (`ec9f8e9`, `fa560ce`) — the gap `36e2ddd` named

`--rm` is a promise about the **docker client's** lifetime. A `SIGKILL`ed control plane executes none of
its exit paths, so its `docker run` client is orphaned and the container labelled
`org.factory.attempt=<attemptId>` outlives the attempt. `factory recover` never swept it; README and
`docs/runbooks/worker-container.md` both said **not built**.

What `recover` does now, and the four rules that are the whole design:

1. **Only the attempts this invocation reconciled** to `ambiguous` (`activeBefore` snapshot minus the
   engine's result). A second `recover` sweeps nothing — an attempt that was already ambiguous may be
   under a person's inspection.
2. **Only by `org.factory.attempt=<attemptId>`**, and only after reading that attempt's `launch.json`
   and confirming it names the same attempt. Never by image, never by a bare label; a record that
   disagrees is a refusal, not a licence to guess.
3. **A live lease is never swept**, so the property is the sweep's rather than an assumption about its
   caller.
4. **Fail soft, never clean.** Docker absent, the daemon down, an unparseable record, `rm` refused, or a
   survivor are all `skipped`/`failed` with a reason and a `checkCommand`. `swept` with `removed: []`
   is reachable **only** when the daemon answered. A failed sweep does not change the exit code
   (4 for the ambiguity it produced, 8 for a quarantined store) — it is a hole to look at, not a verdict
   about the attempt.

Proof, from both ends:

```
$ npx vitest run e2e/cli/docker/09-recover-sweep.test.ts
 ✓ [@docker] E2E-45 (orphan sweep): a SIGKILLed control plane orphans its container, and recover
   sweeps it by attempt label
 ✓ [@docker] … a host child (`container: null`) is never swept, and no docker client is spawned
 Test Files  1 passed (1) · Tests  2 passed (2)
```

The positive control matters more than the assertion: the spec asserts the container is **still
listed** after the kill, so "gone at the end" cannot be explained by the container never existing.
Mutation check, run by the implementer and re-checked here: deleting the `sweepReconciledAttempts`
call leaves the container behind and reddens the spec —
`expected [ '389f5104b99e' ] to deeply equal []` — and the mutated file was restored byte-identically
(sha1 compared before and after).

**One deliberate difference from the plan's wording, recorded rather than smoothed:** E2E-45's
acceptance column says the orphan sweep is recorded by "session id, process group". A container is not
a process group; its identity is the attempt label. The spec asserts the label, and a follow-up commit
(`fa560ce`) corrects the id it was first filed under: E2E-46 is the **cgroup-limits** spec
(`e2e/cli/docker/07-isolation.test.ts`), so the sweep is E2E-45's **orphan-sweep clause**, not a new
number.

## 2. Alerts: two expiry questions, one exit code (`59a18fc`) — re-measured here

```
$ factory ledger verify                     # with the anchor plist's env
outcome  FRESH · age 8.3 h · scope off-host · exit 0
$ factory alerts                            # same env
anchor            FRESH — anchored 8.3 h ago, off-host
INTEGRITY  CERT_NEVER  all task classes
           no class has ever been certified in this store; nothing to audit is not a licence
           next: factory audit --certifications; docs/runbooks/certificate-expired.md
exit 9
$ factory alerts --json | jq -c '{ok, anchor: .anchor.state, codes: [.alerts[].code]}'
{"ok":false,"anchor":"fresh","codes":["CERT_NEVER"]}
```

The distinction the verb exists to keep: **8** is "the anchor host could not be reached", **9** is
"it was read, and the evidence is stale, missing, rolled back, never-certified, or the store is
quarantined". With no anchor target in the environment at all it is 8, not 9 — verified in a bare
shell, which is also why README now says a quickstart `factory ledger verify` exits 8 rather than 9
until the plist's `FACTORY_ANCHOR_SSH`/`FACTORY_ANCHOR_PATH` are exported.

`factory audit --certifications` on the operator's real store, unrun by any spec:

```
CLASS CERTIFICATIONS  under sha256:6ce54b93… (model offline)
  NO CLASS CERTIFICATES  no class has been certified in this store
  Nothing to audit is not a licence: this is never-certified, not current        → exit 9
```

**Still not built:** nothing pages anyone. The launchd job appends to `~/.factory/alerts.log`; the log
is the page. A host that stops running jobs goes quiet, not loud.

## 3. The worker's container (`36e2ddd`) — re-run here

The previous session's build of `factory-env:rc5` was gone from this host (only `factory-env:e2e`
remained), so `e2e/cli/docker/08-worker-container.test.ts` skipped all three of its specs. Building it
made the difference between "green" and "measured":

```
$ docker build --tag factory-env:rc5 docker/factory-env          # exit 0, node 26.12.1 + dsh 0.2.1-rc.5
$ npx vitest run e2e/cli/docker/08-worker-container.test.ts
 ✓ [@docker] runs the turn in the image, and the record says what it ran inside
 ✓ [@docker] E2E-45: a killed worker container is ambiguous, dispatched once, and leaves nothing behind
 ✓ [@docker] refuses rather than degrading: a container request with no image is exit 8, not a host run
 Tests  3 passed (3)
```

The gate above includes this suite and `07-isolation` (6) and `09-recover-sweep` (2): **11 docker specs,
0 skipped**, which is the honest reading of "the @docker suites run".

**Still not built, unchanged:** the mode is opt-in rather than the default; network isolation is pinned
by the argv spec and not probed from inside (the wall's E2E-43 covers egress, with a host control); and
a container whose *sweep* fails is now visible but still needs a person.

## 4. The ND3 ceiling, through the real executor (`3c8e063`) — not re-run here

Recorded by the commit, and deliberately **not** re-run in this session because it makes a paid call:
one `@live` spec arms `launch.ts`'s ceiling (remaining envelope − reserved − recorded) and crosses it on
one real turn — the operator's sentence, the revoked token, the `usage_records` row with
`ceilingCrossed`, exactly one attempt, and a run that ends `unknown` at exit 5 with no verdict. The
gateway reports tokens and no price, so the policy table prices them; the spec sets the price absurdly
high, which makes the crossing real and the spend negligible (~1 cent). What it does not assert, and
says so: the 401 on the next request, which needs the attempt token the launch record does not carry.

Treat as **UNPROVEN in this session**; proven in `3c8e063`'s run.

## 5. Anchor read failures are not "missing" (`f362900`, `0d916da`)

`ledger verify` exits 8 with the errno named when a local anchor cannot be read (`EACCES`, `EISDIR`),
instead of 9 `MISSING`; a corrupt record is a refusal in both transports; only `ENOENT` and an empty
file mean "never anchored here". Verified by the suites and by the live pair above (`FRESH`, exit 0;
`--max-age-hours 0` → `STALE`, exit 9, exercised against the real off-host transport in the previous
round). The command-transport half was converted to a rejection inside the `close` handler after the
spec hung for 60 s — a throw there escapes the promise as an uncaught exception.

## 6. The repository's account of itself (`70486c8`, `63141b6`)

Two documents described a repository that no longer exists, and one of them understated the code.

| Document        | Was                                             | Is                                                                                                                    |
| --------------- | ----------------------------------------------- | --------------------------------------------------------------------------------------------------------------------- |
| `README.md`     | "No credential proxy (R5). `packages/proxy` does not exist; the classifier is a post-hoc denylist; privileged operations are _refused_, not brokered" — contradicted three paragraphs later by its own ADR-007 text | the broker's actual claim (post-expansion classifier, six brokered classes, `GATE_REQUIRED` 5 / `MANDATE_EXPIRED` 3, decision binding and where it persists), what it does not reach (a real `dsh` turn's tool calls), and a package table with the four packages it omitted |
| `README.md`     | test counts two versions old; "no `recover`-side sweep … not built" | 1395/7/99 at this tree; the sweep described by its four rules and both specs                                                      |
| `docs/handover.md` | panel stage "deliberately absent" from the gate; `@docker` "always skipped"; no credential proxy; no anchor; no worker container; ND1–ND4 "known-open" | rewritten against the tree, every quoted command run, ND1–ND4 as **ratified** decisions with what each does not buy, skip table with the real reasons |
| `ADR-006`       | "the credential proxy half is **not built**"; `packages/proxy` "does not exist"; "Not built: proxy metering" | stale statements marked _superseded_ in place (the 2026-11-01 belief survives verbatim) + a 2026-11-02 amendment: the key stays in the proxy, the child gets a scoped token (`credentialsForwarded: []`, `credentialProxy: {token:'scoped'}`), `FACTORY_LIVE_MODEL=1` is only a consent switch |
| `ADR-008`       | context link to `004-store-and-ledger.md`, an ADR that never existed | points at `architecture.md` §9 and `data-map.md`, and says why                                                          |
| `docs/runbooks/worker-container.md` | "a `SIGKILL`ed control plane can leave its container behind … **not built**" | what `recover` sweeps, the attempt-id-only rule, the fail-soft case, and the command that proves it                    |
| `docs/runbooks/budget-envelope-refusal.md` | "ND3 is an open human decision", "nothing meters the gateway" | ND3 decided; the proxy meters and enforces by revoking at the ceiling; what remains is billing-grade accounting          |

The audit's rule cuts the other way too: the repo was **understating** itself about `packages/proxy`,
and the fix states the narrower truth (the broker has no end-to-end allow path) rather than the
flattering one.

`docs/planning/dark-factory-dsh/phase-13-audit.md` is **not** rewritten. §10's addendum predates
`36e2ddd` and still records the worker container and E2E-45 as `UNKNOWN`; the handover says so in its
first paragraph, because a historical audit that gets quietly updated is no longer a record.

## 7. The soak, re-run here

```
$ bash scripts/soak.sh
 ok   quarantine @ unit 48
 invariants
  ok   no unit or attempt in a state the state machine does not define: 51 units, 48 attempts, all legal
  ok   nothing promoted without a human signature: 1 promotion(s), 0 unsigned
  ok   no redispatch after recovery (an ambiguous attempt stays a single attempt): 1 recovered unit(s), one attempt each
  ok   unknown is never counted as a pass (no promotion of an unknown verdict): 0 unknown verdict(s), 0 promoted
 RESULT ok — 50 unit(s), 6 incident(s), all runbook steps and invariants held
```

Zero paid calls. It executes the runbooks rather than describing them, and it still does not cover the
*kill* half of a live incident — that is the container spec's job now, and it lives in `09-…`.

## 8. What is still not built, in one place

- **Notification / escalation.** `factory alerts` exits 9; nothing pages a phone, an inbox or a webhook.
- **Scheduled re-certification.** A monitor says a class certificate expired; a person decides to
  re-measure it (each measurement is paid units, which is why it is not a cron line).
- **The broker's allow path.** No verb mints a `PrivilegedDecision` and neither call site passes a
  `DecisionSink`, so "a person signed, so it ran" has no end-to-end proof; a real `dsh` turn's own tool
  calls are an artefact, never brokered.
- **Container isolation by default**, and a container-side egress probe (E2E-43 measures egress from the
  wall's side, with a host control).
- **A scheduler / queue / fairness / human-priority slot** — IN #5 is a refusal (`CONCURRENCY_LIMIT`,
  exit 7), not a queue.
- **A no-progress detector** — needs step-level signals DSH owns.
- **Billing-grade accounting** (ND3's remainder) and **ND4 rotation** of the anchor.
- **ND2 on the Linux target** — the two-uid topology is proven in a `node:26-bookworm` container, not
  under systemd with `/var/lib/factory`.
- **An ACP worker** — the seam exists, the implementation does not.
- **β** — unmeasured, and it will stay that way without a known-bad corpus.
- **CI.** `.github/workflows/` is empty; a green `verify.sh` is a local artifact with a recorded commit.

## 9. What this round changed in the files a reader trusts

`README.md`, `docs/handover.md`, `docs/adr/006`, `docs/adr/008`,
`docs/runbooks/worker-container.md`, `docs/runbooks/budget-envelope-refusal.md`, `CHANGELOG.md`,
`apps/cli/src/{recover-sweep.ts,verbs/recover.ts,render/limits.ts}`,
`packages/dsh-adapter/src/{worker-container.ts,index.ts}`,
`e2e/cli/docker/{07-isolation.test.ts,09-recover-sweep.test.ts}`, plus this file and the recorded runs
above. The dead citation that pointed here now has a target.
