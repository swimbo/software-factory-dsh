# Debate Transcript — Dark Software Factory on DSH (Phase 5, Mode A)

**Record of:** a research-backed adversarial consensus debate over [`architecture.md`](architecture.md)
**Date:** 2026-11-01 · **Rounds run:** 3 research phases (briefs), 1 evidence ledger, 1 position-paper round, **1 debate round**, then final synthesis
**Outputs:** [`consensus-plan.md`](consensus-plan.md) · [`evidence-ledger.md`](evidence-ledger.md)
**Artifact frozen at:** `sha256 96d05c49…aaa53`, 252 lines, mtime `2026-11-01T08:51:03-05:00`
**Late drift (disclosed):** `architecture.md` changed again at `09:11:21` to 24,026 B / 252 L, `sha256 5c1cedb7…a48d0`, **not by this debate**. All 70 cited anchors were re-checked against it at `09:12` and resolve identically; the byte delta is unattributed. See [`evidence-ledger.md` §0](evidence-ledger.md).

> Citation convention: link targets are relative to this file's directory. Line numbers are resolved against the frozen artifact; see [`evidence-ledger.md` §0](evidence-ledger.md) for the three earlier snapshots.

---

## 1. Why this debate, and what it was asked to decide

The artefact is not a feature spec. It is a 252-line architecture whose central claim is a _negative_ one — that a change can be merged **without a human reading the diff** — resting on five separate load-bearing mechanisms (durable effect ledger, container boundary, holdout wall, qualifier, spend ceiling). Each is independently falsifiable, and three of them are asserted in prose with no test. That is exactly the shape that a single reviewer passes and a system later disproves in production.

**Scope: Complex (5 personas).** Multi-phase AND multi-domain, > 2,000 words, with live external dependencies (SQLite semantics, Docker network behaviour on macOS, arXiv threat research, a container-escape advisory). The selection heuristic in the skill's persona catalogue calls for the maximum persona count at this complexity.

**Decision questions put to every persona** (full text in [`evidence-ledger.md` §1](evidence-ledger.md#1-decision-questions)): the durability substrate (Q1), the trust decomposition (Q2), whether a Docker container on macOS can deliver the claimed boundary (Q3), whether the spend ceiling is an authority or an observation (Q4), whether the verification design _certifies_ (Q5), whether attempt identity suffices for adoption (Q6), and what must pass before 9a/9c commit (Q7).

---

## 2. Personas selected, and why

| Persona                                                                                                  | Domain pull from the artefact                                                                                                  | Why this one, specifically                                                                                                                                                                                           |
| -------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Principal Systems Architect** (`systems-architect`)                                                    | §2 planes, §3 components, §4 API, §5 ownership, §10 alternatives; the words "only writer", "idempotency key", "reconciliation" | The artefact's largest surface is a decomposition claim. This persona is the one that asks whether a _port_ can express the invariant written above it — the failure mode that survives review and dies in Phase 9b. |
| **Principal Application Security Architect** (`appsec`)                                                  | §7 egress/secrets/trust zones, §8 security NFR, `@docker` leak tests                                                           | The security claim is one NFR row carrying the entire "unattended" premise. Needed a reviewer who reads trust boundaries as _reachability_, not as prose, and who knows which controls are enforceable.              |
| **Distinguished Engineer** (`distinguished-engineer`)                                                    | §2.1 command-per-transaction, §7 persistence, §8 durability/idempotency, `data-map` invariants I2/I5/I7/I8                     | The durable-execution decisions (ledger+outbox vs DBOS vs Restate) are career-scale choices. Needed someone who has shipped both shapes and can price "replay-safety without a replay engine".                       |
| **Director of Quality Engineering** (`quality-director`)                                                 | §2.3 holdout gate, Δ, sabotage corpus, §9 risk 1                                                                               | The certifying mechanism is a _statistical_ instrument dressed as a threshold. Needed a reviewer who computes operating characteristics rather than accepting "≥90 %".                                               |
| **Senior Penetration Tester** (`pentester`) — **the contrarian, from outside the plan's primary domain** | Everything the worker can touch: egress, the token, the receipt, `commands[]`, the holdout                                     | The mandatory outside-domain persona. An architecture designed by people who trust their own controls needs an adversary who assumes the worker is hostile and asks what it _reaches_, not what it _should_ reach.   |

**Cost estimate given before starting:** ~5 research briefs + 5 position papers + 1 moderator synthesis + up to 3 debate rounds ≈ 15–21 agent calls. Actual: 5 + 5 + 2 moderator dispatches + 1 round (5 responses) + 1 synthesis = **19**.

**Deliberate omission.** No "product manager" or "operator experience" persona. The plan's UX surface (CLI verbs, `factory status`) is thin and already story-covered ([`user-stories.md`](user-stories.md)); adding a persona there would have produced volume without a falsifiable claim.

---

## 3. Research phase — brief summaries

Each persona researched its own domain before taking a position. The five briefs were **synthesized into one shared ledger** ([`evidence-ledger.md`](evidence-ledger.md)); what follows is a summary of what each domain contributed, derived from that ledger and from the citations in each position paper. _The per-persona briefs are not reproduced verbatim in this record_ — their content survives as the ledger's sourced facts (V1–V45) and as the papers' citations.

### 3.1 Systems Architect — durability substrate, reconciliation, port shape

Established that the effect/activity split is the textbook durable-execution skeleton and that the plan's ledger+outbox genuinely delivers replay-safety without an engine ([`research/kickoff-research.md:57`](research/kickoff-research.md#L57)); that DBOS 5.4.0 on the already-running Postgres is the cheapest alternative and is **absent from §10** ([`research/kickoff-research.md:60`](research/kickoff-research.md#L60), [:65-69](research/kickoff-research.md#L65-L69)); that Restate's shape is a single static binary, not a fleet ([`research/kickoff-research.md:62`](research/kickoff-research.md#L62)); and — by local measurement, the strongest single contribution of the round — that a **linked worktree's `.git` is a file containing an absolute host path**, so a single-mount container cannot run `git`.

### 3.2 Appsec — what is enforceable vs what is asserted

Established the enforceability chain: the session-log checksum is **XXH64 seed 0, unkeyed** ([RFC 8878 §3.1.1](https://www.rfc-editor.org/rfc/rfc8878.html)), so the spend ceiling reads a channel its subject can rewrite; `seccomp(2)` receives register values only, never argv, so "classification at the container boundary" has no syscall-filter home ([man7 seccomp(2)](https://man7.org/linux/man-pages/man2/seccomp.2.html)) — _withdrawn as decisive later, because the plan names no seccomp_; a real escape exists in the named primitive ([runc GHSA-9493-h29p-rfm2](https://github.com/opencontainers/runc/security/advisories/GHSA-9493-h29p-rfm2)); and the prior factory's proven proxy caps (1 MiB body, 1024 output tokens, request count, netns firewall) appear **zero times** in the plan set while being verified live in the predecessor ([`research/existing-state.md:54`](research/existing-state.md#L54)).

### 3.3 Distinguished Engineer — replay semantics and the meaning of a verdict

Established that `in_flight` has no exit transition and that the only drain query selects `pending`; that `kill -9` at 200 points cannot discriminate `synchronous=NORMAL` from `FULL` because process death preserves the page cache; that `receipt_id` is content-derived over a preimage that **omits identity**, so a retried attempt regenerating a byte-identical patch inherits its predecessor's evidence row; and that `verifyUnit`'s idempotency key omits `policyVersion` and the evaluator image digest, so a policy tightening never invalidates a cached verdict. Also contributed the two "successor defects that are worse than the original" reframes after withdrawing three of his own findings.

### 3.4 Quality Director — operating characteristics

Established the arithmetic: 2-of-3 quorum is a majority amplifier (`p²(3−2p)`), "≥90 % aggregate" is unanimity at every `m` the plan set specifies, the 2-of-3 gate's consumer risk jumps to ~0.88 once a failure is tolerated, and one-sided Clopper–Pearson bounds put the 95 % floor of a 5/5 result at **0.549**. Also established that `visible_pass_rate` has no stated producer, and that `ScenarioResult.outcome='error'` is aggregated into `holdout_pass_rate`'s denominator — infrastructure error scored as a defect, which is L3 read backwards.

### 3.5 Pentester — the measured attack surface

Established by **measurement, not reading**, that the plan's egress claim is false by default: on Docker 29.8.2 / macOS 26.4 arm64 a default-bridge container reached `host.docker.internal:5432`, `:11434`, **the operator's DSH GUI on `:65107`**, `1.1.1.1:443` and `example.com:443`; and that `docker network create --internal` closes all of it while a dual-homed proxy stays reachable by name. Additionally: `git status --porcelain` hides `!! ignored.txt`; the signing key has three conflicting paths, one of them inside `holdout/`; and with unlimited attempts a 2-of-3 gate is a lottery the attacker can rig ([arXiv 1506.02629](https://arxiv.org/abs/1506.02629)).

---

## 4. Evidence ledger — summary

Full ledger: [`evidence-ledger.md`](evidence-ledger.md). Grade: **ADEQUATE for the decomposition; INSUFFICIENT for the certification claim and for the security NFR.**

| Dimension          | Count                                                                     | Headline                                                                                                                                             |
| ------------------ | ------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------- |
| Decision questions | 7                                                                         | Q1–Q7                                                                                                                                                |
| Sources reviewed   | 11 in-repo + 8 primary external re-fetched + ~15 carried at persona grade | Nothing outside the four primary external documents carries a decision alone                                                                         |
| Verified facts     | V1–V45                                                                    | 25 facts in §3 carry a ✓ from the synthesis pass, plus 4 new contradictions (C13–C16) and 12 corrections to the ledger's own earlier claims (K1–K12) |
| Contradictions     | C1–C16                                                                    | 4 new in the final pass (C13–C16), all plan-set hygiene                                                                                              |
| Proof gaps         | G1–G13                                                                    | 3 new (G11 macOS uid, G12 intra-cluster ρ, G13 base rate)                                                                                            |
| Withdrawn findings | 10                                                                        | Recorded so they are not re-argued                                                                                                                   |

**The three facts that shaped every position:**

1. **`in_flight` appears exactly once in the plan set** — as a CHECK constraint ([`data-map.md:488`](data-map.md#L488)). No recovery rule; the drain selects `pending` only. §8's "zero duplicate side effects" is unestablishable.
2. **The ≥90 % aggregate is unanimity at m ≤ 9 and a lottery at m ≥ 10** — α = 0.687 at the 6-scenario design point, 0.880 at m=10, 0.882 at m=20, 0.836 at m=48.
3. **The egress claim is false by default, measured** — the worker reaches the operator's loopback and the public internet unless a topology is imposed.

---

## 5. Disagreement Brief — Round 1 (initial)

The moderator synthesized the five position papers into twelve contested decisions, each with a crux. Reproduced in decision form; the post-round status follows in §7.

| ID      | Impact | Crux as put to the panel                                                                                                        |
| ------- | ------ | ------------------------------------------------------------------------------------------------------------------------------- |
| **D1a** | HIGH   | Is "2-of-3 per scenario + ≥90 % aggregate" a certification rule at all, or a point estimate with no operating characteristic?   |
| **D1b** | HIGH   | If not, _which_ operating point — and is the trial unit a scenario or a run?                                                    |
| **D2a** | HIGH   | What are the cross-store invariants for a verdict: is the hash the join, and what must the key bind?                            |
| **D2b** | HIGH   | Single store with core as the one writer, or a wall-owned store with a signed `VerdictRef`? And is a second OS uid in v1?       |
| **D3a** | HIGH   | Can the worker container be specified so that it runs `git`, matches the recorded cwd, and cannot reach anything but the proxy? |
| **D3b** | HIGH   | What runs the candidate under holdout scenarios — the "ephemeral deployment" that names no uid, mounts or network?              |
| **D4**  | HIGH   | Should a security-relevant change ever be eligible for a dark lane?                                                             |
| **D5**  | HIGH   | Who owns the oracle — the runner, the expected values, and the visible-suite base?                                              |
| **D6**  | MEDIUM | Is there a per-command pre-execution intercept for destructive operations, or is the capability set the boundary?               |
| **D7**  | MEDIUM | Is "DB vs holdout tree" a failure domain, and what does an off-host anchor actually buy?                                        |
| **D8**  | MEDIUM | Where does Δ come from, what happens on infrastructure error, and what happens to the first unit of a class?                    |
| **D9**  | MEDIUM | Is attempt identity in the receipt preimage?                                                                                    |
| **D10** | MEDIUM | Where does the evaluator key live, given three documents disagree?                                                              |
| **D11** | LOW    | Plan-set hygiene: ten lines, one commit.                                                                                        |

**The two structural observations the moderator put to the panel before any response:**

- **The gate is not merely underpowered; the _fixed proportion_ makes it lenient.** Under `k = ceil(0.9m)`, adding scenarios does not reduce consumer risk — it stays in a ~0.84–0.88 band for all `m ≥ 10`, because the tolerated-failure count grows with `m`. _This synthesis corrects the moderator's own framing from "rises monotonically" to "a step function with a plateau" ([`evidence-ledger.md` K5](evidence-ledger.md)); the operative conclusion — "raise `m` is not a fix" — is unchanged and is what the panel was asked to accept._
- **The two principals had crossed, not converged, on D2** — each described moving to the other's Round-0 position and calling it a concession. The moderator refused to record a resolution on that basis.

---

## 6. Round 1 responses — each persona's position

Verbatim positions are in the round record; what follows is each persona's **concede / maintain / answer** structure, which is what the moderator tabulated.

### 6.1 Principal Systems Architect

**Conceded:** the second store. "On one host under one uid that buys no enforcement and costs `factory audit` its single timeline." Moved to a **signed verdict artifact** verified by the core, with one writer and no cross-store transaction; added that the enforcement behind "one writer" is a **second OS uid** owning `~/.factory/state` at 0600, not the schema.

**Maintained:** the in-flight effect defect; `Executor.adopt()`; the non-empty-diff fence.

**New positions taken this round:** self-contained clone at the identical absolute path, _rejecting_ the mirrored bare-mirror mount because it puts a shared object store writable inside the untrusted container; the D4 classifier lives in C5 and is evaluated twice (qualify, then receipt); cold start resolved by "Δ undefined or `n_samples < min_samples` ⇒ the class is not certifiable, the unit may still verify, every promotion in that class is human-signed" — bounded, not permanent, and free because the first promotion of any unit is already human-signed ([`architecture.md:144`](architecture.md#L144)).

**Corrections issued:** QD's m=20 remedy at threshold 0.90 certifies nothing (`0.05^(1/20) = 0.861`); his own "the plan chose the weaker backup procedure" was too broad — [`data-map.md:969`](data-map.md#L969) already prescribes the online API, so [`architecture.md:214`](architecture.md#L214) is the sole wrong sentence.

**Answer on D9:** rejected "commit the tree" as a collision fix — a fixed-identity commit is deterministic in tree+message+parents+time, so identical trees still collide; put `attemptId` + `baseRevision` in the preimage.

### 6.2 Principal Application Security Architect

**Conceded three:** seccomp, as decisive (the plan names none, so the citation cannot carry the conclusion — the conclusion survives on the post-hoc-only input channel); wall-as-producer as a _standalone_ recommendation (worth building only after the second uid, because a uid boundary is what makes "the wall cannot open `factory.db`" checkable); and the _scope_ of "raise m" (he verified unanimity-wearing-a-percentage but computed no OC and refused to defend a number).

**Maintained three:** the spend ceiling is an observation of worker-controlled data (first hard stance, unchanged); the candidate substrate is unnamed and E2E-46 proves a cwd string, not a boundary; the security NFR is `unknown` while E2E-44 is opt-in.

**Direct answer on the macOS uid question — the most disciplined moment in the round:** "I do not know whether Docker Desktop maps container uid to a bind-mounted host file's owner or whether virtiofs bypasses it. I will not manufacture it. My fix is written to survive either answer: holdout and key live under a second host uid **and are bind-mounted into no container at all**. If ownership is bypassed, clause one is cosmetic and clause two does the work."

**Answer on D7 that changed the majority position:** off-host backup addresses disk loss and operator rollback, **not escape** — against escape it buys nothing, because backing up compromised state preserves the compromise. Count it as disk-loss only, and write "container escape ⇒ full compromise" in §9.

### 6.3 Distinguished Engineer

**Conceded D2's store ownership to SA and AS** — "the only version whose join is a hash you can check rather than a rule you hope for" — while keeping `policyVersion` in the key because it fixes staleness, not forgery. Confirmed withdrawal of the two-writer WAL-corruption argument (patched in 3.51.3).

**Withdrew three findings and replaced each with a worse successor:** the `synchronous=NORMAL` objection became "the invariant named Durability still encodes NORMAL and its test cannot discriminate"; "the anchor was dropped" became "the anchor is not a failure domain"; the Restate misattribution became "the reason is wrong, the decision can stand".

**New finding — the documented backup is lossy, and it is the default restore path:** [`architecture.md:214`](architecture.md#L214) specifies checkpoint + file copy and [`data-map.md:22`](data-map.md#L22) backs up `factory.db` + `manifest.json` only; SQLite says the WAL file is part of persistent state and must travel with the database. **Inference:** the copy is internally consistent, so `integrity_check` passes while committed verdicts are silently absent — quiet evidence loss, not detected corruption. (This synthesis confirmed the SQLite sentence verbatim in the primary text — [`evidence-ledger.md` V2](evidence-ledger.md).)

**Maintained:** the startup assertion (`journal_mode=wal AND synchronous=2`) or the durability row is `unknown`; `attach(attemptId)`; effects resolved by observing the sink and a fencing token on every mutating command.

**Answer on D1:** the wall owns the runner; the repo may supply only a hash-attested entrypoint invocation, never the oracle; summary/exit disagreement ⇒ `unknown`, not `fail`.

### 6.4 Director of Quality Engineering

**Conceded D1 against herself, with the arithmetic that beat her own remedy:** `0.05^(1/20) = 0.861 < 0.90`, so "m ≥ 20 + LCB ≥ 0.90" certifies nothing — her two clauses never met. Corrected design: threshold = minimum acceptable _true_ per-scenario rate per class (0.85 reversible; 1.0 → pass^k for safety-critical), **but** interval acceptance at m=20 _is_ unanimity, which is what she had attacked. The honest pre-registration is a two-point OC, and under unanimity those targets are 0.039 and **0.456** — a 46 % false-fail rate on good units, which makes the factory economically pointless. Her fix: count all 3 runs as trials — 180 runs/verdict, accept ≥162/180.

**Conceded her corpus was underpowered by her own standard:** zero false-fails in 10 bounds ≤26 %, not ≤10 %; ≥29 good patches needed (`0.9^29 = 0.047`); 30/30 defects gives LCB 0.905 — adequate, zero slack.

**Resolved rather than conceded D5:** [`e2e-tests.md:61-63`](e2e-tests.md#L61-L63) already defines "visible" as the holdout's copy of the visible-suite _base_ — so the missing producer of `visible_pass_rate` had been designed and left unowned. Make it a rule: wall applies the candidate source, `git checkout <base> -- <testRoot>`, runs its own pinned runner, reads a machine-readable summary. Any diff touching the test root ⇒ `lit`.

**On D2:** DE's single store is easier to test end-to-end, but "testability must not choose the trust boundary"; if the split wins, one cross-store contract test is a release blocker (same receipt + new `policyVersion` ⇒ no promotion).

**On D8:** at 1 verdict/hour, `min_samples ≤ 8` per class or the first units are permanently `lit` — state that bootstrap.

**Also conceded:** she had inverted pass/fail in her 0.774/0.970 figure, and `visible_pass_rate` has four occurrences, not two.

### 6.5 Senior Penetration Tester

**Opened by refusing the ledger's own item:** "the ledger's own C4 ('half-resolved') is stale; the moderator's M1/M2 measurement supersedes it."

**Conceded two:** the "capability the plan says doesn't exist" phrasing was overstated rhetoric — the token is a real, unrevoked capability that _contradicts_ the "never sees a secret value" line ([`architecture.md:144`](architecture.md#L144) vs [:200](architecture.md#L200), [:216](architecture.md#L216)); and "Δ gates promotion" as written makes every class's first unit permanently `unknown`, so he accepted a pre-registered, human-signed `bootstrap` reason code — "and nothing wider".

**Maintained and sharpened:** the exposure budget (`max_attempts = 3`; **one** holdout scoring pass per `(scenario, policyVersion, unit)`; fail-once retirement; ≥20 % rotation per 10 verdicts; ≤3 certification attempts per class per `policyVersion`) — and the key arithmetic: quorum is what makes the gate expensive, so pure unanimity at **m=19** bounds α ≤ 0.05 while 2-of-3 needs **m ≥ 48** — 2.5× the corpus for the same bound. "Budgeting alone is insufficient: an adversary spending attempts against a fixed holdout adapts."

**On the network:** `--internal` removes the default route, not embedded DNS for co-attached members, so the invariant must be **exactly two members**, asserted by a test that parses `docker network inspect` and fails on a third (sidecar, replica, debug). The wall must not be co-attached.

**On D4:** a **behaviour-preserving** security-adjacent refactor goes `lit` anyway — "a passing visible test is the camouflage case, not the exemption."

**On D5:** faithfulness becomes hash equality, not judgement — the receipt commits to `{argv[], cwd, baseRevision, envDigest}`; the wall replays _its own_ pinned entrypoint over that tuple.

---

## 7. Disagreement Brief — post-Round-1 (status)

Produced by the moderator after Round 1. Verdict: **CONSENSUS NOT REACHED.** Nine of eleven decisions resolved or majority; **D1b** and **D2b** remain HIGH-impact and contested, plus **D3b** (no persona had answered the scenario half).

| ID      | Impact | Status after R1 | Winning position                                                                                                                                                                                                                                                   | Dissent / precise gap                                                                                                                                                                                          |
| ------- | ------ | --------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **D1a** | HIGH   | **RESOLVED**    | The point estimate + 2-of-3 + 90 % aggregate is not a certification rule; a pre-registered OC at a stated `(m, k, quorum)` must replace it                                                                                                                         | None — no persona defended the current rule                                                                                                                                                                    |
| **D1b** | HIGH   | **CONTESTED**   | No winner                                                                                                                                                                                                                                                          | Trial unit (scenario vs run); 90 % aggregate non-monotonic/plateauing; 2-of-3 unanimity cannot meet a two-point OC at any `m`; clustering unmeasured; 18 vs 120–180 runs/verdict; wall service time unmeasured |
| **D2a** | HIGH   | **RESOLVED**    | Signed verdict artifact; hash is the join; no transaction spans stores; key binds `policyVersion` + evaluator image digest; second uid is the only enforcement of "the wall cannot open `factory.db`"                                                              | None. DE concedes the signature fails when the wall is the compromised signer                                                                                                                                  |
| **D2b** | HIGH   | **CONTESTED**   | No winner (2–2)                                                                                                                                                                                                                                                    | Single store (SA, QD) vs wall-owned store (DE, AS-conditional). Decision rule: _is the second uid in v1?_ The artifact currently encodes single-store and would need three edits for the split                 |
| **D3a** | HIGH   | **RESOLVED**    | Self-contained clone at the identical absolute path; `--internal` two-member network; proxy by name; no holdout/key mount; canary + negative-egress tests blocking                                                                                                 | None. Cost: one clone per attempt; quantify disk                                                                                                                                                               |
| **D3b** | HIGH   | **CONTESTED**   | No winner                                                                                                                                                                                                                                                          | The "ephemeral deployment" that runs the candidate still names no uid, mounts or network. The worker spec does not cover it                                                                                    |
| **D4**  | HIGH   | **RESOLVED**    | Seventh deterministic signal: path ∪ content classifier at qualify, again over the diff at receipt; security-relevant ⇒ `lit`; rule versioned                                                                                                                      | None. Requires a state-machine hook, or the receipt-time classifier is decorative                                                                                                                              |
| **D5**  | HIGH   | **RESOLVED**    | Wall owns runner and oracle; wall applies candidate source to the holdout's copy of the visible-suite base; machine-readable summary, never `suite_output`; summary/exit disagreement ⇒ `unknown`; diff touching the test root ⇒ `lit`; `commands[]` forensic      | None on ownership. Sufficiency holes: the dependency manifest is candidate-controlled oracle code; ignored files invisible; argv capture channel unspecified                                                   |
| **D6**  | MEDIUM | **RESOLVED**    | No per-command pre-execution intercept. The pre-exec control is the container's mount/capability set; destructive classification post-hoc; a destructive-class or out-of-set command ⇒ `unknown`; US-E4-05 AC1 rewritten; the 9d "recorded human approval" deleted | None. Classifier must be workspace-scoped or normal builds become `unknown`                                                                                                                                    |
| **D7**  | MEDIUM | **MAJORITY**    | Rename "separate failure domains"; add a monotonic watermark; quarantine includes `holdout/`; state "container escape ⇒ full compromise"                                                                                                                           | AS dissents on the value of off-host backup (disk-loss only, not escape); DE's off-host substrate unspecified; a local watermark does not detect coordinated rollback                                          |
| **D8**  | MEDIUM | **MAJORITY**    | Δ measured by the wall; any errored scenario ⇒ `unknown`, no `DeltaSample`; Δ undefined or `n < min_samples` ⇒ class not certifiable, unit may verify, every promotion human-signed; one bootstrap unit per class per `policyVersion`                              | PT dissents: Δ must gate promotion outright, not only certification. Gap: block vs human-sign                                                                                                                  |
| **D9**  | MEDIUM | **RESOLVED**    | Preimage includes `{unitId, attemptId, baseRevision, …}`; `receipt_id` not content-only; `content_hash` a non-unique dedup index; `verifyUnit` key gains `attemptNo`                                                                                               | None                                                                                                                                                                                                           |
| **D10** | MEDIUM | **RESOLVED**    | Key outside `~/.factory` under the second uid; correct all three paths; test the real path                                                                                                                                                                         | None. Consequence: the wall must run as the key-owning uid, which forces a service topology (see D2b)                                                                                                          |
| **D11** | LOW    | **OPEN EDIT**   | One commit; no human decision                                                                                                                                                                                                                                      | Ten stale/contradictory lines                                                                                                                                                                                  |

### 7.1 New findings the moderator recorded as changing the picture

| #   | Finding                                                                                                                                                                                                                                                       |
| --- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| N1  | **D2 is a crossed concession, not a convergence.** Read literally, SA moved to DE's Round-0 position and DE moved to SA's. Recording it as resolved because "both principals moved" would have been a manufactured consensus.                                 |
| N2  | **The fixed-proportion gate does not tighten with `m`.** _(Framing corrected by this synthesis to "step function with a plateau" — the conclusion stands.)_                                                                                                   |
| N3  | **The trial unit is undefined.** The plan's `m` is scenarios; QD's 180 is runs; PT's 19 is single-run scenarios. The numbers are not comparable until the unit is fixed.                                                                                      |
| N4  | **The wall's cost is time, not spend.** The 180-run design adds wall-clock/CPU, not token dollars; the spend ledger cannot see it at all. The plan's capacity numbers are worker slots and receipt commits ([`data-map.md:27`](data-map.md#L27)).             |
| N5  | **The backup row is known-wrong, not unknown.** `sqlite.backup` is exported and works; `db.backup` is undefined. Confirmed by direct measurement in this synthesis ([`evidence-ledger.md` V4](evidence-ledger.md)).                                           |
| N6  | **The pair-uniqueness citation is false.** I6 is prose; no index exists. Confirmed ([`evidence-ledger.md` V25](evidence-ledger.md)).                                                                                                                          |
| N7  | **The scenario-candidate deployment is unspecified** — the second place untrusted code runs.                                                                                                                                                                  |
| N8  | **The `DSH_HOME` mount is a self-contradiction** and is now decisive: container-local loses the log (so `collect()` cannot produce `session_tree[]`); a parent bind mount puts the holdout one `..` away; a shared home lets attempt N configure attempt N+1. |
| N9  | **The dependency manifest is oracle code.** A pinned runner still installs from the candidate's manifest.                                                                                                                                                     |
| N10 | **Ignored files are invisible** to the receipt, the diff and the escape audit. Confirmed by direct measurement ([`evidence-ledger.md` V14](evidence-ledger.md)).                                                                                              |
| N11 | **The watermark signature design is circular** — `sig_by_promotion_key` either exposes the human key to the writer or requires a human per watermark.                                                                                                         |
| N12 | **The wall process topology is missing.** A second uid means the wall cannot be spawned by core; §4 has no IPC endpoint and §7 no service definition.                                                                                                         |
| N13 | **The spend ceiling is still an observation of worker-controlled data.** No persona owned it.                                                                                                                                                                 |

---

## 8. Final resolution status, per contested decision

This is the synthesis's resolution, applied after Round 1. It deliberately does **not** claim a Round 2 that never ran. Where the panel left a genuine value choice, the synthesis recorded a **decision rule plus a recommended default** and left it to the human rather than voting on the panel's behalf.

| ID      | Final status                         | Outcome                                                                                                                                                                                                                                                                                                     | Who owns it                                              |
| ------- | ------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------- |
| **D1a** | **RESOLVED** → CP-1                  | Acceptance is a pre-registered operating characteristic; the 90 % point estimate is retired as a certification authority                                                                                                                                                                                    | Architecture (§A4.6, §A12.1); numbers in `PolicyVersion` |
| **D1b** | **UNRESOLVED — §R1**                 | Four candidate operating points priced (α/β/runs/day); recommended default (b) m=40/k=40, re-ratified on measured service time. **The evidence cannot choose**: α ≤ 0.05 needs m ≥ 47.8, β ≤ 0.10 needs m ≤ 39.8 — jointly infeasible under 2-of-3 unanimity                                                | **Human.** Blocks 9c acceptance                          |
| **D2a** | **RESOLVED** → CP-3                  | Signed verdict artifact; hash is the join; key binds `policyVersion` + evaluator image digest; pair uniqueness becomes a DDL index; core never accepts an unsigned row                                                                                                                                      | Architecture (§A8); schema (9a)                          |
| **D2b** | **UNRESOLVED — §R2**                 | Decision rule written: _second uid in v1 ⇒ split store; no second uid ⇒ single store and the NFR says so._ Recommended default (a) single store for v1, because the split's only advantage is against a compromised core and that advantage requires a uid boundary whose macOS behaviour is **UNVERIFIED** | **Human.** Blocks the 9a schema freeze                   |
| **D3a** | **RESOLVED** → CP-5                  | Clone at the identical absolute path; `--internal` two members; proxy by name; no holdout/key mount; blocking canary + negative-egress tests                                                                                                                                                                | 9b (Block B)                                             |
| **D3b** | **RESOLVED by specification** → CP-6 | The candidate substrate is written down: fresh pinned-image container, non-root, read-only root, `--internal`, no `~/.factory` mount, driver outside holding the expectations. No persona dissented on substance — the gap was that nobody had answered                                                     | 9c (Block C-6)                                           |
| **D4**  | **RESOLVED** → CP-7                  | Security relevance ⇒ `lit`, always; path ∪ content classifier, versioned, evaluated twice                                                                                                                                                                                                                   | 9a/9d                                                    |
| **D5**  | **RESOLVED** → CP-8                  | Wall owns the oracle; machine-readable summary; test-root checkout of base; manifest/lockfile diff ⇒ `lit`; `commands[]` demoted with a named producer and a truncation rule                                                                                                                                | 9c                                                       |
| **D6**  | **RESOLVED** → CP-9                  | No pre-execution intercept; capability set is the boundary; post-hoc classification; destructive-class ⇒ `unknown`; AC1 rewritten; fourth gate deleted                                                                                                                                                      | 9d                                                       |
| **D7**  | **RESOLVED (majority)** → CP-10      | Rename; watermark hash-chained into the next human-signed promotion; quarantine includes `holdout/`; escape ⇒ full compromise stated in §9; off-host anchor deferred to v1.1 **with the honesty statement** (§R4)                                                                                           | 9a/9e                                                    |
| **D8**  | **RESOLVED (majority)** → CP-11      | Wall-measured Δ; errored ⇒ `unknown`, no sample; Δ-undefined ⇒ class not certifiable, promotions human-signed; one bootstrap per class per `policyVersion`. PT's stronger version (block promotion outright) rejected because it adds a de facto fourth human gate                                          | 9a/9c                                                    |
| **D9**  | **RESOLVED** → CP-12                 | Identity in the preimage; `content_hash` demoted; `attemptNo` in the verify key                                                                                                                                                                                                                             | 9a                                                       |
| **D10** | **RESOLVED** → CP-13                 | Key outside `~/.factory`; one path; leak test asserts the real path; uid clause conditional on §R2                                                                                                                                                                                                          | 9b                                                       |
| **D11** | **OPEN EDIT** → §5 (now 13 items)    | Twelve edits from the moderator plus one new (the promotion-key preimage disagreement, C13)                                                                                                                                                                                                                 | One commit                                               |

**Score: 14 resolved, 2 unresolved (HIGH), 0 left to omission.** Both unresolved items are value choices with a written decision rule and a recommended default; neither is a factual dispute that more research could settle.

---

## 9. Process notes and integrity record

### 9.1 What the debate did well

1. **Three findings were withdrawn under their own evidence.** The `synchronous=NORMAL`, `danger-full-access`, and "anchor was dropped" findings all died in Round 1, each replaced by a successor defect that was worse. A round where nobody withdraws anything is a round where nobody read.
2. **One persona refused to answer a question the evidence did not support** — AS on the macOS uid behaviour — and wrote a fix that survives either answer. This is the behaviour the plan's own L3 demands of the plan.
3. **Two arithmetic self-corrections** (QD's LCB and her inverted false-fail figure) changed a recommendation rather than decorating one.
4. **A measured fact beat a cited one.** The egress claim was closed by `docker run` on this host, not by a vendor sentence (which could not be re-verified in the primary text).

### 9.2 Where the process itself was weak — recorded, not hidden

| #   | Weakness                                                                                                                                                                                      | Consequence                                                                                                                                                                                                                                                                     |
| --- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | **The artefact moved during the debate** (four snapshots). Three findings were already remediated when their proponents argued them.                                                          | Fixed by freezing at S4 and re-resolving every line number; §0 of the ledger is the binding record                                                                                                                                                                              |
| 2   | **Only one debate round ran.** D1b and D2b were left contested by design (no Round 2 was dispatched).                                                                                         | The synthesis recorded a decision rule and a default instead of inventing a second round's consensus. The transcript says so explicitly rather than implying convergence                                                                                                        |
| 3   | **The crossing on D2 was nearly recorded as a resolution.**                                                                                                                                   | Caught by the moderator's literal reading of both texts; recorded as N1                                                                                                                                                                                                         |
| 4   | **A framing overclaim entered the moderator's brief** ("consumer risk rises monotonically with m").                                                                                           | Corrected in this synthesis with arithmetic; the conclusion survived, the wording did not ([`evidence-ledger.md` K5](evidence-ledger.md))                                                                                                                                       |
| 5   | **Two personas' numbers were not comparable** (scenario-level vs run-level trial units).                                                                                                      | Recorded as N3 and made the _first_ question in §R1                                                                                                                                                                                                                             |
| 6   | **No persona owned the spend ceiling.** AS and PT hard-stanced the direction; nobody specified the metering semantics.                                                                        | Authoring fell to the synthesis: CP-14 resolves the authority, §R3 carries the semantics as a residual                                                                                                                                                                          |
| 7   | **The D3b gap was an omission, not a disagreement** — and the moderator's "contested" label was technically right but substantively empty.                                                    | Resolved by writing the specification (CP-6), with the honest label "resolved by specification"                                                                                                                                                                                 |
| 8   | **The artefact moved a fifth time at 09:11:21**, after the debate closed and during deliverable authoring — 24,026 B, same 252 lines, `sha256 5c1cedb7…`. This debate did not make that edit. | All 70 cited anchors re-verified at 09:12 and resolve to identical content; the 289-byte delta is **unattributed** and recorded as unknown rather than guessed. The same pass caught one independent anchor error of this debate's own (the §2.3 heading is `:112`, not `:113`) |

### 9.3 Claims that remain inferences (labelled, not smuggled)

- A second uid forces the wall out of core's process tree → a service topology the plan does not budget (POSIX uid semantics, not measured here).
- Positive intra-cluster correlation makes every published α optimistic by roughly a `1+2ρ` design effect (standard clustered-binomial reasoning; ρ unmeasured).
- The clone fix costs one full clone per attempt → ~420 GB at 20 units/day, 3 attempts, 7-day retention, 1 GB repo (arithmetic on an unknown repo size).
- Multi-step trojan ASR (95.5 %) transfers from GPT-5.4/OpenClaw to DSH/DeepSeek (plausible; not measured).
- The `git`-in-container failure follows from the measured `.git`-file fact plus the one-mount contract; the failure itself was not executed.
- DE's "committing makes collision more likely" — plausible, unmeasured.

### 9.4 What this debate did **not** establish

It did not establish that a dark lane is safe, that the wall discriminates, that the security NFR holds, or that crash-safety is achieved. It established which claims are unproven, which are false, and what would settle each. Under the plan's own law L3, that is the correct output of a Phase 5 review: **`unknown` is not pass**, and the honest deliverable is a smaller set of claims with tests attached, not a larger set with adjectives attached.

---

## 10. Appendix — freeze manifest

```
96d05c49b4262a6b643b0da48e4bd730ea7b594d028138a9616f859a511aaa53  architecture.md
26954fcc898cde78d111cdc8dab48899ebd3f2c05adcb7582b4eccdae52cbf7d  data-map.md
1f2a77bb351353e07663e781e6f9a5b6103966016e428b60b16d8f0b5826b287  e2e-tests.md
a41c306b82ba25e8975f92dbef252282ac5cbc35b114bc38f3dd5a0f05304d6b  findings.md
6e130e7794e73a448187e5b3c826a4f327c1cc364751e58a319ea00e47cd445b  tech-guide.md
e7aab1e836677b342ac83db80fae1dae7e0c87a99225c6102ca7f6cb31e251e1  phase-9a-plan.md
c8c668a5a2fd200c14b6a1046447cb8b250da1cdac408d21e16001fc706dfadc  phase-9b-plan.md
cddbd575fa14684e1b3e4ad29eefa64ee5b8656111a2894c14d44d363c4cde18  phase-9c-plan.md
4a2a9c203ffabe1972b4f03d33f0219305d2a809aa5da735921985efa49dac54  phase-9d-plan.md
```

**Agent calls used:** 5 research briefs · 5 position papers · 2 moderator dispatches (initial synthesis, post-round status) · 5 round-1 responses · 1 final synthesis = **19**.
**Rounds:** 1 of a possible 3. Terminated by the synthesis because the remaining disagreements were value choices, not evidence gaps — a second round would have restated positions, not tested them.
