# Changelog

## v0.8.0 — 2026-11-03

A task class was certified live for the first time — and earning it exposed, and then fixed, four
places where a certificate could not be earned or could not be believed.

- **`docs-typo-fix` is certified: `samples=20 passes=19 outcome=certified`** in the operator's store,
  `m=20 k=18 α=0.0755`, measured against a real git repository built from this project's own markdown
  (20 revisions, each carrying the class's five defects) under a hidden five-rule holdout corpus. The
  wall judged every attempt, the criteria log accumulated them, and the certificate flipped at the
  twentieth revision. One non-pass is an `unknown` verdict from an operator configuration error, kept
  as a non-pass rather than rounded. Evidence: `docs/planning/dark-factory-dsh/evidence/phase-18-certification.md`.
- **The wall now passes its criteria log to `evaluate`.** The CLI built the wall without a
  `criteriaLog` port, so every verdict counted as the class's first sample; twenty measured passes
  would have produced twenty `samples=1 … insufficient` rows and no certificate. The package tests were
  green because they construct the port directly. Fixed in `apps/cli/src/wall.ts`, pinned by the
  20-run certification spec.
- **`audit --certifications` reads the projection, not the stripped verdict.** `certificateReport`
  asked each verdict's `certification` field, which `mapVerdict` removes on purpose, so every verified
  unit was listed as uncertified forever (exit 9 after an honest certification). It now asks whether
  the verdict left a `class_certificates` row, and the certification suite asserts exit 0,
  `uncertifiedUnits: []`, and no `STALE OR NEVER CERTIFIED` line.
- **A dispatch ceiling is no longer part of the policy identity.** `maxConcurrentAttempts` /
  `maxConcurrentWalls` were fields of `QualifierPolicy` and hashed into `currentPolicyVersion`, so
  raising the ceiling to run the loop invalidated the certificate it produced (`CERT_STALE` every
  morning). They now live in a separate `OperatorLimits`; the rules alone hash, and a bounded
  `legacyPolicyVersions()` recognition bridge keeps the pre-split certificate `current` without
  recomputing it.
- **A certificate can no longer borrow another policy's history.** `CriteriaLogEntry` carried no
  policy or model identity and `countClassAttempts` filtered on class + holdout revision only, so one
  attempt under a new policy could count twenty revisions measured under the old one. Entries now
  record `policyVersion` and `modelId`, both the class count and the Δ-sample count filter on them, and
  pre-identity lines are reported as `legacyLines` — never counted, and not corrupt.
- **The certification driver no longer measures one unit out of twenty.** The loop's stdin is the
  units file, and both `ssh` (the per-run key read) and the worker consumed it; both now get
  `</dev/null`. The whole substrate — artefacts generator, hidden corpus, driver, offline 20-run proof —
  lives under `e2e/certification/` and is part of the offline gate.

**Verified:** `bash scripts/verify.sh` → 7 passed, 1 skipped, 0 failed; test stage **1559 passed | 8
skipped**.

## v0.7.0 — 2026-11-02

An assertion became a measurement, a reason code stopped over-claiming without breaking the verdicts
already on disk, two unattended HTTP reads got bounds, and the gateway key got a second, better place
to live.

- **The container + live-model refusal is now pinned by a spec, and the answer is "not on this
  host".** `e2e/cli/docker/10-internal-bridge.test.ts` measures both directions of the transport that
  was supposed to fix the conflict — docker `--internal` bridge, credential proxy bound to the
  gateway: an internal network has no default route (`ENETUNREACH` towards the internet, asserted as an
  error _kind_, not "refused"), the bridge gateway is not an address macOS can bind
  (`EADDRNOTAVAIL`, and absent from `os.networkInterfaces()`), while a container-to-container
  connection on the same network still succeeds and the loopback proxy still answers a real
  scoped-token request from a normal bridge. The spec is a **platform pin**: green means docker still
  behaves as the runbook says, not that the combination works. Its native-Linux half is `skipIf` with
  the measured reason — UNPROVEN on this machine. `packages/credential-proxy` gained the `bindAddress`
  seam (`boundAddress` reported from the kernel, `EADDRNOTAVAIL` refused by name) that any future
  transport needs, with the loopback default byte-for-byte unchanged.
- **`privileged_replay_refused` is additive, so stored evidence keeps parsing.** The old code read as
  "the operation was never approved" when what the wall observed is "I refuse to replay it". Renaming
  was never available (`WALL_REASON_CODES` is a closed zod enum; stored verdicts would fail to parse),
  so the enum gained a member, the refusal site emits it, and `packages/wall/src/verdict-compat.test.ts`
  pins the old string against a **literal** stored verdict rather than an object built from today's
  types.
- **Both webhook reads are bounded.** `postAlerts` and the Discord attempt drained responses with no
  size bound in a job that runs at 04:00; both now stop at 64 KiB, cancel the stream, and name the
  truncation in the detail line (`body truncated at 65536 bytes`) instead of hiding it. A truncated
  `429`/`400` still decides from its status; a truncated `2xx` is still a delivery.
- **The model key can live in a `0600` file.** `$FACTORY_HOME/secrets/bifrost-key`, read through the
  same `apps/cli/src/secrets.ts` rule as the alert webhook (open, `fstat` the descriptor, refuse rather
  than warn, name `chmod 600`). The environment still wins when set. New runbook
  `docs/runbooks/live-model.md` covers the key, `FACTORY_PROXY_BASE_URL`, `DSH_BIN`, cost, and the
  honest note that certifying a task class is a shell loop today because a batch driver is not built.

**Verified:** `bash scripts/verify.sh` → 7 passed, 1 skipped, 0 failed; test stage **1524 passed | 8
skipped**. Details in `docs/planning/dark-factory-dsh/evidence/phase-17-round.md`.

## v0.6.1 — 2026-11-02

The alert channel is real: `factory alerts --notify` now delivers to a Discord channel, and the
webhook secret lives in a file rather than in a launch agent.

- **Discord is a first-class transport.** A `discord.com`/`discordapp.com` `/api/webhooks/` URL gets a
  Discord-shaped body — one-line `content`, one embed per alert (title = the code, description = the
  meaning and the literal `next:` command), red for integrity, amber for "the anchor host could not be
  reached" — instead of the raw `alerts.v1` document that Discord would reject. Any other URL keeps
  the raw POST, byte for byte. `allowed_mentions: {parse: []}` is unconditional: a message cannot ping
  a role or `@here` whatever it contains. Limits are enforced as data, not hope — 2,000-char content,
  10 embeds, 6,000-char body — and a truncated page says `…and N more, see ~/.factory/alerts.log`
  rather than dropping alerts.
- **204 and 429 are handled as Discord means them.** `204 No Content` is a success (there is no body
  to parse); `429` is retried once after `retry_after`, fractional seconds honoured and the wait capped
  at 5 s because this runs in a timer job; `400` quotes Discord's own `message` and is not retried;
  redirects stay refused; a failed delivery still cannot change the exit code.
- **The webhook is a credential, so it is a `0600` file.** Resolution:
  `FACTORY_ALERTS_WEBHOOK_URL` (one-offs and tests) → `FACTORY_ALERTS_WEBHOOK_URL_FILE` →
  `$FACTORY_HOME/secrets/alerts-webhook`. The file is `fstat`ed on its open descriptor before a byte is
  read, and a group- or world-readable file is refused with the `chmod 600` line instead of being used
  — a token in a backed-up plist is a token in a backup. The launch agent's own comment now says this
  rather than recommending the env var, and the repo's plists are well-formed XML again (a comment
  containing `--notify` is legal to `plutil` and illegal to a strict parser).
- **Installed and proven on this host.** The 04:00 agent was reinstalled with `--notify` and
  kickstarted: `NOTIFY  DELIVERED — https://discord.com accepted the Discord message (HTTP 204, 1
attempt)`, exit 9 for the honest reason (`CERT_NEVER`). The previous plist is backed up beside
  `~/.factory/`.

**Verified:** `bash scripts/verify.sh` → 7 passed, 1 skipped, 0 failed, test stage **1501 passed |
7 skipped (1508)** across 100 files with every `@docker` spec run; `apps/cli/src` alone is 263 passed
across 16 files, 29 of them new. Details, the one live delivery, and a hazard worth knowing — the gate
goes green with the eleven `@docker` specs skipped when the Docker daemon happens to be stopped, so
"0 failed" is not "the container layer ran" — are in
`docs/planning/dark-factory-dsh/evidence/phase-16-round.md` §8.

## v0.6.0 — 2026-11-02

R5's dead end is closed, and two controls stop being write-only. The broker could refuse a
privileged operation but nothing could approve one; `factory alerts` could answer "expired" but only
to a log; and the container's isolation could not be combined with a live model, which failed a
worker start later as an unexplained 401.

- **`factory gate request|decide|list|show`: a person can approve one operation, verifiably.**
  `request` is read-only and prints the normalised operation, its `sha256`, the exact payload to sign
  and a copy-pasteable `decide` line with **both timestamps pinned** — they are inside the signed
  content, so a payload signed at T and re-dated later fails closed (exit 5). `decide` verifies the
  operator's ed25519 signature against the same public keys `factory promote` uses
  (`FACTORY_OPERATOR_KEY`, then `$FACTORY_HOME/keys/{operator.pub.pem,operator.ed25519.pub}`) and
  persists the decision as the `gates/<id>.json` artifact **and** one `privileged.decided` event. The
  tool never holds, derives or writes a private key; `--signed-by` is an echo checked against the key
  id, never a name hashed into evidence (L1); a malformed `--expires-in` is exit 2 rather than a guess.
- **One decision, one operation — across processes.** Schema **v3 → v4** adds `privileged_decisions`
  (additive, applied in place to an existing store). `DecisionRegistry.consume` is now one conditional
  `INSERT … ON CONFLICT DO NOTHING` whose `changes === 1` is "this caller won", so two processes cannot
  both read "unused" — the previous per-invocation memory registry allowed a replay across runs. The
  fake executor's brokered `command` step presents the decision covering its **classified** operation
  (`liveDecisionFor` matches on the operation hash, never on raw argv) and takes the phrase from that
  verified record, never from argv, the step text or the receipt. The wall's replay site keeps
  refusing unconditionally, with the reason in the code: it measures a candidate and must not act on
  what it measures.
- **End-to-end proof of the three runs.** `e2e/cli/default/19-gate-decisions.test.ts`: refused with
  exit 5 `[broker.no-decision]` and no file written; authorised exactly once (one `attempt.receipted`,
  one `privileged.decided`, the command's effect on disk, `isDecisionConsumed` true); the same
  decision presented again → exit 5 `[broker.replayed]`, still one of each event. Runbook
  `docs/runbooks/brokered-operations.md` is the operator's transcript, captured on this tree.
- **Alerts can reach a person, opt-in.** `factory alerts --notify` raises one macOS notification
  through `osascript` (argv, never interpolated into AppleScript) plus one `NOTIFY …` line, and with
  `FACTORY_ALERTS_WEBHOOK_URL` set makes exactly one bounded POST of the same `alerts.v1` JSON, at
  most one retry, redirects refused, and the URL logged as scheme+host only (a webhook URL is a
  credential). Off by default; a delivery failure is visible and never changes the exit code — `0`/`8`/
  `9` describe the evidence, not the transport. Non-darwin is a reported no-op. The 04:00 plist runs
  `--notify`, and the runbook now says what that buys: this machine's notification centre or your own
  endpoint, no retry of a lost notification, and a host asleep at 04:00 stays quiet until it wakes.
- **A launch combination that cannot work now refuses instead of failing later.** Container isolation
  gives the worker `--network none`; the credential proxy binds `127.0.0.1` on this host. So
  `FACTORY_WORKER_ISOLATION=container` with `FACTORY_LIVE_MODEL=1` and a key is refused in the probe:
  exit 8 **`CONFIGURATION_CONFLICT`** — a new code, distinct from `CONTAINER_UNAVAILABLE` — with
  nothing reserved, no attempt directory and no usage row, naming both levers, both ways forward and
  the runbook section. `factory --help` now says exit 8 has two next actions and the code names which;
  the outbox treats the conflict as `retryable`.
- **The docker specs stop killing each other's containers.** E2E-45 discovered its container with
  `docker ps --filter name=factory-worker-` and took the first match, so under `maxWorkers: 4` it
  killed the egress spec's container, timed out at 180 s, and left its own behind — poisoning later
  runs until a human removed it. Discovery is now by `org.factory.attempt=<attemptId>` (the label the
  launcher writes and the sweep already relies on) with an ownership assertion before `docker kill`;
  the egress probe's hand-rolled container moved out of the launcher's namespace; `07-isolation`'s
  leftover net is scoped to its own suite. Proven with a deterministic decoy: the old filter kills it
  (`Exited (137)`), the new one leaves it `Running` and passes in 1.6 s.
- **Documents that had drifted.** `README.md`'s R5 paragraph said the allow path did not exist and no
  verb minted a decision — false since this commit; `docs/handover.md`'s "no way to allow a privileged
  operation end to end" and "no `gate_decisions` rows" bullets are rewritten against the tree. The
  wall's `privileged_unbrokered` reason is documented for what it is: it names what happened at
  **replay** (the wall presented no decision), not what happened to the operation. New runbook
  `docs/runbooks/brokered-operations.md`; new section in `worker-container.md` for the conflict.

**Verified:** `bash scripts/verify.sh` on the release tree — `7 passed, 1 skipped, 0 failed`, test stage
`1472 passed | 7 skipped (1479)` across 99 files with every `@docker` spec run. Run id, per-stage
output and the two deliberate red runs are in `docs/planning/dark-factory-dsh/evidence/phase-16-round.md`.

## v0.5.0 — 2026-11-02

The round the previous session started and did not finish: four mechanisms landed, then the work
stopped before its evidence, its release, or the two defects it had exposed. This entry closes the
round — including one gap the last commit named and left open, and two documents that had stopped
describing this repository.

- **The worker's turn can run inside a container, and a killed worker is ambiguous.** `FACTORY_WORKER_ISOLATION=container` executes the turn inside `docker/factory-env` (node 26.12.1 by digest, `dsh 0.2.1-rc.5`, uid 10001) with `--network none`, `--read-only`, `--tmpfs /tmp`, `--cap-drop ALL`, an explicit memory and pid ceiling, the clone and per-attempt `DSH_HOME` bind-mounted, and the attempt id as a label. `launch.json` gains an optional `container: {image, imageDigest, user, network, readOnlyRoot, memoryLimit, pidsLimit, tmpfs, mounts, mountsDenied, labels} | null` under the same `launch/1` schema — `null` means "host process", never "unknown". A request it cannot honour refuses **before** any reservation with exit 8 `CONTAINER_UNAVAILABLE` and the exact `docker build` line; it never degrades to a host run. E2E-45 is measured: `docker kill` the worker container mid-attempt ⇒ exit 4 `ATTEMPT_AMBIGUOUS`, no receipt, one attempt, no redispatch (`e2e/cli/docker/08-worker-container.test.ts`, 3 specs).
- **The sweep the launcher cannot do, done by the next process that can.** `--rm` is a promise about the _client's_ lifetime and a `SIGKILL`ed control plane runs none of its exit paths, so its container outlives the attempt. `factory recover` now sweeps the attempts _it_ reconciles to `ambiguous`: it reads that attempt's `launch.json` and removes containers labelled `org.factory.attempt=<attemptId>` — by that id alone, never by image, never by a bare label, never while the lease is live, never for a `container: null` record. `swept` + `removed: []` is only reachable when the daemon answered; everything else is `skipped`/`failed` with a reason, in the text and as `sweeps[]` in `--json`, and the exit code stays the ambiguity's. Proven from both ends: `09-recover-sweep.test.ts` SIGKILLs a real control plane, asserts the orphan is still listed, and asserts it is gone after `recover` exits 4; deleting the sweep call leaves the container behind and reddens the spec.
- **Alerts: the two expiry questions, answered in an exit code.** `factory alerts` is read-only and answers `0` clean, `9` integrity (stale/missing/rolled-back anchor, quarantined store, expired or never-certified class) or `8` when the anchor host could not be reached — a transport failure is never reported as "fine". The judgements are imported from `@factory/anchor` and `@factory/wall`, not re-derived; each alert carries the literal command to run next. `deploy/launchd/ai.factory.alerts.plist` runs it daily at 04:00 (after the 03:00 anchor) into `~/.factory/alerts.log`. On this host it exits 9 today, for the honest reason: `CERT_NEVER`.
- **ND3's ceiling, through the real executor.** A paid `@live` spec arms the spend ceiling in `launch.ts` (remaining envelope − reserved − recorded) and crosses it on one real turn: the operator's sentence, the revoked token, the `usage_records` row with `ceilingCrossed`, one attempt, and a run that ends `unknown` at exit 5 with no verdict. The crossing is real; the spend is not (the per-token price is set absurdly high in the spec). What it deliberately does not assert, and says so: the 401 on the next request, which needs the attempt token the launch record does not carry.
- **Anchor read failures stop reading as missing.** A local anchor file that cannot be read (`EACCES`, `EISDIR`) is exit 8 with the errno named, not exit 9 `MISSING`; a corrupt record is a refusal in both transports; only `ENOENT` and an empty file mean "never anchored here".
- **Two documents stop lying about the tree.** `README.md` claimed `packages/proxy` does not exist and that privileged operations are merely refused — false since the broker landed, and contradicted by the same file's ADR-007 paragraph; its package table omitted four packages and its test counts were two versions old. `docs/handover.md` described a v0.4.0-1 tree: panel "deliberately absent" from the gate (it is stage 7 and fails without a browser), `@docker` suites "always skipped" (they self-gate and run), no credential proxy, no anchor, no worker container. Both are rewritten/verified sentence by sentence, with the commands that settle them. `ADR-006`'s stale statements are marked _superseded_ rather than deleted and a 2026-11-02 amendment states what is true; `ADR-008`'s link to a never-existent ADR is fixed.
- **`factory budget`'s help stops claiming v1 measures nothing**, which the per-attempt proxy made false, and the stale "E2E-45 cannot be measured" header in the docker isolation suite is corrected.

**Verified:** `bash scripts/verify.sh` on the tagged tree — see `docs/verification/` and
`docs/planning/dark-factory-dsh/evidence/phase-15-round.md` for the run id and the numbers.

## v0.4.0 — 2026-11-01

The round after ratification: the three things v0.3.0 left as mechanisms with nothing driving them are
now driven, and two claims turned out to be stale — in one case in the factory's favour.

- **The anchor runs.** `deploy/launchd/ai.factory.anchor.plist` anchors the ledger daily at 03:00 to
  `hermes-control` (`$HOME/.factory/anchors/software-factory-dsh.jsonl`, directory `0700`, no root —
  `/var/lib/factory` does not exist there and a root-owned anchor buys nothing but another thing to
  provision). Installed, kickstarted and verified `FRESH · off-host`; two records sit on the off-host
  machine. The 48 h refusal was also exercised live (`--max-age-hours 0` → `STALE`, exit 9) rather than
  only in a spec.
- **A class certificate is a row, not a sentence.** `class_certificates` (schema **v2 → v3**, additive,
  declared in `MIGRATIONS`) — one row per verdict, written inside `insertVerdict`'s transaction, with
  `m/k/p0/α/samples/passes/outcome/policyVersion/modelId` and a digest tying the row to its
  `wall.class_certified` event. `factory audit --certifications` judges each class against the running
  policy and model and exits **9** for stale, never-certified, absent projection **or an empty store**.
  `not-certified` and `insufficient` can never read as `current`.
- **The model id reaches the wall.** v0.3.0 wrote `modelId: null` on every live certificate because
  nothing supplied one; `FACTORY_MODEL_ID` now flows to `evaluate()`, and an absent id stays absent
  rather than becoming a string. New runbook `certificate-expired.md`, written against real output.
- **An offline soak that executes the runbooks.** `scripts/soak.sh`: 50 units, six incidents on a
  schedule derived from `--seed`, and after each one the runbook's own commands are run and their exit
  codes _and_ promised sentences asserted — 27 steps, 76 s, zero paid calls. Invariants are checked
  across every home the run touched. The first version of the checker counted one home twice and
  reported a phantom redispatch; the spec now feeds each checker a fabricated row and requires a scream.
- **The panel is verified in a browser for the first time.** `chromium_headless_shell-1248` is present
  on this host now, so `npx playwright test` runs: **41 passed in 12.6 s** — measured contrast, the
  320 px rule, 200 % zoom reflow, "no green anywhere in the unknown card", and identical parsing with
  scripting disabled. The audit's oldest `UNPROVEN` bullet is closed by running it, not by assertion.
- **The `@docker` isolation suite runs on this host, and it was never skipped.** Six specs in 4.8 s
  (E2E-43/44/44b/46 + timeout/orphan + content-pin): no network (control: the host has it), writes only
  inside the work dir, cannot see a factory home/holdout/operator key, cgroup limits are the flags
  passed, a 400-fork storm is capped. Two defects found and fixed: E2E-43's host-egress control was a
  `console.warn` that could be deleted with the suite still green (now `skipIf` with the reason in its
  name), and both images ran a runtime that disagreed with the pins (now `node:26.12.1`, and
  `docker/factory-env` builds with `dsh 0.2.1-rc.5`).

**Verified with the live stage included:** `8 passed, 0 skipped, 0 failed` (`docs/verification/2026-11-01T21-58-16Z/`)
— the paid pair completing in 24.0 s and the refusal path exiting 5 in 5.3 s, the gateway reporting
`8149` and `8594` total tokens across the two turns. Offline on the committed tree: `7 passed, 1 skipped`
(`docs/verification/2026-11-01T21-56-19Z/`), 1314 passed / 6 skipped across 92 files, 41 panel specs in
a real browser.

**Still not built, unchanged by this round:** the _worker's_ container (E2E-45 stays `UNKNOWN` — there
is no worker container to kill; the `ambiguous`/`recover` invariant is proven at process level), alerts
on a stale anchor or an expired certificate, scheduled re-certification, ND3's ceiling through the real
executor, and ND2 on the Linux target rather than in a container.

## v0.3.0 — 2026-11-01

The operator ratified all four `NEEDS_HUMAN_DECISION` answers on 2026-11-01
(`docs/planning/dark-factory-dsh/findings.md` § DECIDED). This release is what "ratified" means in code,
and each item ends where the claim ends. Evidence: `evidence/phase-13-nd-decisions.md`.

**Verified with the live stage included:** `8 passed, 0 skipped, 0 failed` on 2026-11-01
(`docs/verification/2026-11-01T21-09-39Z/`), the paid pair taking 19.7 s with the gateway reporting
`8247` total tokens and the refusal path exiting 5 in 4.6 s. The proxy now reads those numbers instead of
discarding them, which is what ND3 bought.

- **ND1 — a published certification operating point.** Certification is per **task class** at
  **m = 20 attempts / k = 18 passes**, and the number published is
  **α = 0.0755** — the probability a class that truly passes 95 % of the time fails certification —
  computed in exact rational arithmetic (`packages/wall/src/operating-point.ts`), never a global pass
  rate. `insufficient` evidence keeps `requiresHuman: true`. β stays unmeasured and unpublished, because
  it needs a known-bad corpus nobody has. The planning record's old "α ≈ 0.882 / 0.687" figures were
  wrong under their own definition and are corrected, with the correction visible.
- **ND3 — spend is metered from the response and enforced by revocation.** The proxy tees (never
  buffers) the upstream body, folds every SSE `usage` chunk, and records
  `{tokensIn, tokensOut, costUsd, gatewayRequestId, signedAt}` per attempt into an append-only
  `usage_records` table plus a `usage.recorded` ledger event carrying the same digest. A response with no
  usage block is `unknown`, never `$0.00`. Crossing the attempt's remaining authority **revokes the
  token**: the crossing request is served, the next is `401 token-revoked`, and nothing redispatches it.
  `factory budget reconcile --usage-file` compares against the gateway's own export and can say
  `unknown` (exit 6, `USAGE_UNRECONCILED`) — a missing export is not "0 mismatches".
- **ND4 — the ledger head is anchored off-host daily.** New `packages/anchor` and
  `factory ledger <anchor|verify>`: a chain hash over the events that a second party can recompute, four
  outcomes (`fresh | stale | missing | rollback`), a refusal at exit 9 for anything but `fresh`, and a
  local anchor reported as **local** rather than dressed up as off-host (ADR-008, runbook
  `docs/runbooks/ledger-anchor.md`). Claim: **detectable within 48 h**, never "prevented".
- **ND2 — the wall is a separate principal where the platform allows it.** The topology decision is
  computed, reported by `factory status`, and provisioned by `scripts/provision-topology.sh`; on this
  macOS host it reports `single-uid` with the reason, because a separate process is not a separate
  principal.
- **Breaking (schema v1 → v2), with a real migration instead of a reset.** The new `usage_records` table
  changes `SCHEMA_SQL`, so `packages/store` now declares additive `MIGRATIONS` and applies them on open;
  each applied step appends a `store.migrated` ledger event, and a version with no declared path is still
  refused. Deleting `FACTORY_HOME` was never an allowed repair, so "upgrade or refuse" is the only
  honest pair of options.
- **Two hazards found by this round's own gate, both fixed:** two `verify.sh` runs started in the same
  UTC second shared one output directory and truncated each other's log (now suffixed `-2`, `-3`, …);
  and a ledger that a second process had already migrated could not be re-opened (`migrationsApplied`
  reported the same event twice) — covered by a spec.

## v0.2.0 — 2026-11-01

- **The live path no longer hands the worker the gateway key.** `packages/credential-proxy` mints a
  per-attempt token — bounded to a localhost socket, the attempt's lease, one upstream prefix, and
  revoked before the verdict is written — and writes the `Authorization` header itself. The launch
  record now says `credentialsForwarded: []` with `credentialProxy: { token: 'scoped' }` (ADR-007).
  `FACTORY_LIVE_MODEL=1` is only a consent switch now. 26 specs cover it (17 proxy, 9 wiring).
- **Fixed: the factory could finish a verified unit and then never exit.** The proxy piped the
  gateway's response into the worker but never destroyed the _upstream_ leg when the worker left, so
  a finished turn left an SSE stream running into an unread socket. It cost a live run: `outcome:
pass`, tokens counted, receipt written — and the process killed at its 300 s guard. The proxy now
  tears the upstream leg down on client close and on its own close, and a spawned-child spec asserts
  the process exits (it hung 5/5 before the fix).
- **The DSH pin moved to `0.2.1-rc.5`** because the installed desktop app auto-updated and `rc.3` is
  no longer on disk. Re-verified rather than assumed: provisioning, profile boot with
  `MISSING_CREDENTIAL` fail-closed, overlay activation, and a real live pair (`19.7 s`, `outcome
pass`). The adapter still refuses any version that is not the pin.

What changed for someone using this repository, in order. Not a file-by-file diff — the commits say
that. Releases are tagged; entries below them are the commits that carried them.

## v0.1.0 — 2026-11-01

The first release that does the thing the repository exists for: **a dark unit was verified end to
end by the wall, on a real model turn.** Attempt `A-e507950c0625`-era on 2026-11-01: `outcome: pass`,
`reasons: []`, the wall's faithfulness replay reporting `replayed 5 of 8 recorded commands; 0
mismatched`, a discriminating holdout (1 of 1), a real wall (`wall/0.1.0+local`, `fakeWall: false`),
CLI exit `0`, and the gate green with the live stage included. The other six measurements were
green in the same verdict: suite, holdout, delta, scope, diff, tests-weakened.

**What is verified.** `factory intent` → `qualify` → `run` → verdict → `promote`, with the four
controls that the design rests on proven by specs rather than asserted: a sabotage that passes its
own suite is rejected on the holdout; `unknown` never satisfies a gate; recovery never re-dispatches;
an unsigned promotion writes no file. The live layer is opt-in and gated on `BIFROST_API_KEY` **and**
`DSH_BIN`, so the offline gate costs nothing and needs neither; when it runs it forwards exactly one
credential name (`FACTORY_LIVE_MODEL=1` → `credentialsForwarded: ['BIFROST_API_KEY']`, the name, never
the value). The gate now has a `panel` stage — the 41 browser specs are run by `scripts/verify.sh`,
not merely described as passing — and reports 7 passed, 1 skipped, 0 failed offline.

**What is fenced** (unchanged from `README.md`, which is the source of truth): no container
isolation on this host; no model-call budget of the factory's own; DSH's sandbox is not a security
boundary; no ACP worker; the live path is the one path where the worker process can hold the gateway
key, because v1 has no credential proxy container (ADR-006 records the amendment).

**Known `UNKNOWN` layers** — measured as unknown, not as working: the `@docker` worker path (4 specs
tagged and skipped; containment is unmeasured here), E2E-48's credential-proxy clauses (no proxy
container exists in v1), and the ACP path (seam exists behind the `Executor` port, implementation
does not). A skipped check is `UNKNOWN` in this repository's vocabulary, never a pass.

## Unreleased — the audit's findings, closed

- **`501da5d` — feat: dark software factory on DSH — planning set + implementation.**
  The repository starts existing as a working factory. `factory intent` takes an intent, `qualify`
  routes it dark or to a person by deterministic policy, `run` dispatches and records evidence,
  `status` answers "what needs me", and three human gates (promotion signing, budget envelope,
  credentialed access) refuse rather than warn. Eight packages and two apps ship with it, plus the
  read-only status page. The four controls the design rests on are proven by tests, not asserted: a
  sabotage that passes its own suite is rejected, `unknown` never satisfies a gate, recovery never
  re-dispatches, an unsigned promotion writes no file. `bash scripts/verify.sh` reports 6 passed,
  1 skipped (live-model, no key), 0 failed. **What this changes for you:** you can clone, run the
  gates offline, and drive a unit end to end without a model key or the DSH binary installed.

- **`c75dd05` — feat: real verdict path, e2e suites, and the gates that were only declared.**
  `run` now reaches a verdict: clone a pristine mirror, launch the worker, take the receipt, evaluate
  it with the wall's local runner, record the verdict. Before this the wall was a well-tested package
  nothing called, so "the verifier is generator-blind" was a property of code no operator surface
  could reach. Three wiring bugs fell out of that, each a correct check whose caller never invoked it
  — including `promote --signature <path>`, which passed the _path_ to the verifier as if it were the
  signature, so no real promotion could ever have succeeded. **What this changes for you:**
  `factory run` produces a verdict you can act on, `factory promote` accepts a signature from a file,
  and a kill -9 mid-run now leaves an `ambiguous` unit instead of a silent gap (5 real-wall specs,
  11 seam specs, 41 browser specs for the panel).

- **`b92f5cc` — fix(evidence): one receipt identity, and the spec that proved the sabotage is
  caught.**
  A receipt had two identities: `Verdict.receiptSha` (the decision projection, without the agent's
  narrative) and `receipts.receipt_sha` (the stored body). They differed, so any receipt with a
  narrative could not be joined to the verdict that judged it — and the CLI hid it by stamping the
  stored hash onto the verdict. Now one function, `receiptShaFor()`, computes it everywhere. **What
  this changes for you:** an agent can no longer mint new evidence by rewriting its narrative, and a
  verdict provably cites the receipt the wall actually read. The spec that proves the central claim —
  a change whose own suite is green, whose receipt is faithful, and which still fails the holdout is
  rejected with `holdout_failed`, an anonymised failing scenario, a measured Δ and no promotion
  artifact even under a valid signature — lands here.

- **`bf24f6a` — fix(outbox): the effect that was written and never settled, and the flag that lied.**
  Every dispatch committed a `launch` effect and then performed the launch inline without ever
  settling it, so each run left a permanent pending row and the promise that `recover` could retry a
  crashed launch described a path no code implemented. Now there is a settlement vocabulary —
  `applied` (the worker started, including the ambiguous case), `retryable` (nothing started),
  `exhausted` (a decision refused it, for good) — and `run` claims the effect before anything
  happens, settles it after, and `recover` performs pending launches under five guards, the lease
  among them. `--no-wait` was also dead: the code read an option name commander never sets, so
  "dispatch and return" quietly ran the whole pipeline to a verdict. **What this changes for you:**
  `factory status` reports the outbox honestly instead of claiming the store cannot count it,
  `--no-wait` does what it says, and a crash between commit and launch is recoverable without risking
  a second worker.

## Notes

- Nothing here is a "1.0". v1 deliberately refuses to build the scheduler, the credential proxy, the
  budget _enforcement_, and the off-host anchor; the audit
  ([`docs/planning/dark-factory-dsh/phase-13-audit.md`](docs/planning/dark-factory-dsh/phase-13-audit.md))
  records which promises those gaps leave open, and [`docs/handover.md`](docs/handover.md) lists them
  alongside the four decisions that only a human may close.
- No pass rate is certified. The wall reports a measured Δ and names the operating point as
  undecided (ND1).
