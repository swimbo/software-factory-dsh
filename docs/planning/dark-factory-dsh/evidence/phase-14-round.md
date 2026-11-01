# Phase 14 — the round after ratification (2026-11-01)

What v0.3.0 left as **mechanisms with nothing driving them**, and what this round made true. Every number
here was produced by running the command next to it; where a claim is still missing, it says so.

## 1. The anchor runs (ND4 finished operationally)

ADR-008's anchor existed and nothing wrote a record, so `ledger verify` correctly said `MISSING`.

| | |
| --- | --- |
| Destination | `$HOME/.factory/anchors/software-factory-dsh.jsonl` on `hermes-control`, dir `0700`, no root |
| Why not `/var/lib/factory` | it does not exist there; a root-owned anchor on a machine whose job is holding unprivileged secrets is another thing to provision for no added property |
| Scheduler | `deploy/launchd/ai.factory.anchor.plist`, daily 03:00, no retry, stdout+stderr → `~/.factory/anchor.log` |
| Installed | `launchctl bootstrap` + `kickstart` → `runs = 1, last exit code = 0` |
| Records off-host | 2 (`ssh hermes-control 'wc -l < …'`) |

```
$ factory ledger anchor    → anchored 3 events, seq 3 · scope off-host
$ factory ledger verify    → outcome FRESH · age 0.0 h · scope off-host   (exit 0)
$ factory ledger verify --max-age-hours 0
                           → outcome STALE · exit 9
```

The last line matters: the 48 h refusal was exercised against the **real** off-host transport, not only in
a spec. **Still not built:** nothing alerts when it goes stale — `ledger verify` exits 9 and a person or a
cron must run it.

## 2. A class certificate is a stored row (ND1 half two)

The gap was worse than "no job yet": the certificate existed only as prose inside a verdict's
`class-certification` scenario, so no job could have read it.

- `class_certificates` — one row per verdict, primary key `cert:V-…`, written **inside
  `insertVerdict`'s transaction** (a certificate cannot outlive its evidence), with `m, k, p0, α, samples,
  passes, outcome, policyVersion, modelId` and a digest tying it to the `wall.class_certified` event.
- Schema **v2 → v3**, additive and declared in `MIGRATIONS`; the v1 → v2 step untouched. The existing
  migration spec asserted "exactly one applied event", which baked in "exactly one step" — it now derives
  its counts from `migrationPath(1)` and checks the exact `[from, to]` pairs plus a no-op reopen.
- `packages/wall/src/certificate-recency.ts` judges `current | stale(reasons) | never-certified`. Only a
  `certified` row can ever be current; `not-certified`, `insufficient` and a `null` model id never are.
- `factory audit --certifications` exits **9** for stale, never-certified, no projection, **or an empty
  store** ("nothing to audit is not a licence"). Measured on the operator's real store:

```
$ factory audit --certifications; echo $?
CLASS CERTIFICATIONS  under sha256:6ce54b93… (model offline)
  NO CLASS CERTIFICATES  no class has been certified in this store
  Nothing to audit is not a licence: this is never-certified, not current
9
```

**Still not built:** nothing re-runs the measurement on a policy or model change. The audit tells you the
certificate expired; a person decides to re-measure. Runbook: `docs/runbooks/certificate-expired.md`.

## 3. The model id reaches the wall

v0.3.0 wrote `modelId: null` on every live certificate because no caller supplied one, so a real operator
would have seen `re-certify: model unknown` on a class that was genuinely current — fail-closed and still a
false alarm. `FACTORY_MODEL_ID` now flows through the single `evaluate()` call site, and the e2e spec
asserts the certificate row carries `modelId: 'auto'`, `m: 20`, `k: 18` for a unit that passed.

One thing that is deliberately *not* projected: `mapVerdict` reconstructs a verdict from its columns so the
promotion-signature payload cannot grow silently. `certification` and `modelId` therefore live only in
`class_certificates`, and the mapper says so in a comment.

## 4. An offline soak that executes the runbooks

`scripts/soak.sh` — seeds are pure functions of `--seed`, so a failure at unit 37 reproduces at unit 37.

| run | wall | units | incidents | runbook steps | failures | paid calls |
| --- | --- | --- | --- | --- | --- | --- |
| `bash scripts/soak.sh` | 76 s | 50 (44 clean + 6) | 6 | 27 | 0 | 0 |
| `--units 5 --seed 1` | 8.7 s | 5 | 1 | 3 | 0 | 0 |

Exit codes asserted, not just printed: `4` recover/wall-unavailable, `5` status-gate/unsigned/wrong-scope
phrase, `6` budget refusal, `7` concurrency, `9` quarantined-store writes, `0` on the recovery paths.
Invariants checked **across every home the run touched** (legal states, nothing promoted without a
signature, no redispatch after recovery, no promotion of `unknown`); the spec feeds each checker a
fabricated row and requires a scream — which caught a real bug in the checker itself (the ambiguous
incident shares the soak home, so one unit was counted twice and reported a phantom redispatch).

Three runbook sentences it disagreed with, now corrected in the runbooks:

1. `run` on a quarantined store exits **8** (no executor) before reaching the exit-9 write refusal; the
   exit-9 path is reachable through `recover`/`status`/`audit`.
2. factory-wide `status` legitimately stays exit **5** after an ambiguous unit resolves, because every
   `verified` unit awaiting first promotion is its own gate — `status <unitId>` is the "is this closed"
   answer.
3. "requires a human signature" has a **third** cause: a signed promotion also needs `--signed-by` and
   `--confirm "sign promotion <id>"`, and omitting either is the same exit 5 and the same sentence.

**Not covered:** killing a worker mid-turn in the production path needs a live executor — the soak covers
the *recovery* half of that incident, not the kill half.

## 5. The panel is verified in a browser (for the first time)

`chromium_headless_shell-1248` is now in `~/Library/Caches/ms-playwright`, which was the audit's oldest
`UNPROVEN` bullet.

```
$ npx playwright test --reporter=line
41 passed (12.6s)
```

Measured contrast, the 320 px rule, 200 % zoom reflow, "no green anywhere in the unknown card", and
identical parsing with scripting disabled — in a browser, not at unit level.

## 6. The `@docker` isolation suite runs — and it was never skipped

| Before (README/audit) | Measured |
| --- | --- |
| "the 4 `@docker` specs are tagged and skipped" | **6 passed, 4.8 s**, zero leftover containers |
| "the specs are placeholders" | rewritten into six real specs in `bb250ca`, before this round |
| "`docker build` stalls loading the pinned digest" | the digest resolves and pulls; a cold **cross-platform** pull hangs (`DeadlineExceeded`, >7 min), which is what "stalled" looked like |

Now covering E2E-43 (no network; control: the host reaches it), E2E-44 (writes only inside the work dir),
E2E-44 (b) (cannot see a factory home, holdout or operator key), E2E-46 (cgroup limits are the flags
passed, 400-fork storm capped), plus timeout/orphan and content-pin specs.

Two real defects fixed:

- **E2E-43's host-egress control was a `console.warn`** — deleting it left the suite 6/6 green, exactly
  the "deleting the probe makes it greener" failure the file's header forbids. It is `skipIf` with the
  reason in the test name now: removing the control yields `5 passed, 1 skipped`.
- **Both images disagreed with the pins.** The wall image ran node 22; `docker/factory-env` ran node 22
  *and* `DSH_VERSION=0.2.1-rc.3` against `PINNED_DSH_VERSION = '0.2.1-rc.5'`. Both now run
  `node:26.12.1`; the worker image builds (`EXIT=0`, ~2 min, `dsh --version` → `0.2.1-rc.5`).

**Still `UNKNOWN`, and docker cannot fix it:** E2E-45 — kill the *worker* container mid-attempt. The
worker has no container: `apps/cli/src/wall.ts` wires `createLocalRunner` and the executor launches `dsh`
on the host. The `ambiguous`/`recover` invariant is proven at process level (E2E-21/30/31/32). E2E-44's
proxy-token clauses likewise (no credential-proxy container ships).

## 7. Gates

| tree | command | result |
| --- | --- | --- |
| committed `6a398cc` | `FACTORY_TAGS=docker bash scripts/verify.sh` | **7 passed, 1 skipped, 0 failed** — `docs/verification/2026-11-01T21-56-19Z/` |
| same, live stage included | `FACTORY_VERIFY_LIVE=1 … bash scripts/verify.sh` | **8 passed, 0 skipped, 0 failed** — `docs/verification/2026-11-01T21-58-16Z/` |
| tagged `v0.4.0` | `bash scripts/verify.sh` | **7 passed, 1 skipped, 0 failed** — `docs/verification/2026-11-01T22-02-27Z/` |

Suite: **1314 passed, 6 skipped (92 files)**; panel **41 passed (12.7 s)**; live pair 24.0 s with the
refusal path exiting 5 in 5.3 s, the gateway reporting **8149** and **8594** total tokens across the two
turns.

## 8. What is still not built, in one place

- **E2E-45 / the worker's container.** No container isolation for the worker; a candidate that escapes the
  DSH sandbox is not fenced in. This is the biggest remaining gap between the claim and the machine.
- **Alerts.** A stale anchor and an expired certificate both exit 9; nothing pages anyone.
- **Scheduled re-certification.** The certificate is queryable; the measurement is not automatic.
- **ND3's ceiling through the real executor.** Proven at the socket; no paid spec crosses the ceiling.
- **ND2 on the Linux target.** Proven in a container, not on the host with systemd and `/var/lib/factory`.
- **β.** Unmeasured, unpublished, and it will stay that way without a known-bad corpus.
