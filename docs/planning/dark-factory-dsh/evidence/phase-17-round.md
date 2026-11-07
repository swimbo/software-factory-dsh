# Round 17 — a measurement instead of an assertion, and four defects the round exposed

Started from the previous round's queue: the transport that was supposed to make container isolation
and a live model compatible, the reason code that over-claimed, the unbounded HTTP reads behind the
04:00 alert job, and a place for the gateway key that is not a launch agent.

Everything below was run on this tree, on this host (macOS 26, OrbStack `29.8.2` — a docker daemon
inside a Linux VM), except where a line says otherwise.

## 1. The bridge cannot exist on this host, and now the repository knows that

The refusal for `FACTORY_WORKER_ISOLATION=container` + `FACTORY_LIVE_MODEL=1` rested on a comment:
"the worker has no network and the proxy is on this host". Nobody had measured the design that would
fix it — a docker `--internal` bridge, the credential proxy bound to the gateway, the worker attached
to it. `e2e/cli/docker/10-internal-bridge.test.ts` (581 lines, 6 specs) is that measurement, and on
this host the answer is **no**:

| probe | result |
| --- | --- |
| `docker network inspect` of an `--internal` network | `Internal: true`, subnet `192.168.107.0/24`, gateway `192.168.107.1` |
| `/proc/net/route` inside a container on it | one route, `192.168.107.0/24` — **no default route** |
| container → `1.1.1.1:443`, `8.8.8.8:53` | `ENETUNREACH` (the error **kind**, not "refused") |
| control: same probe from the default bridge | `CONNECTED` |
| control: container → container on the internal network | `CONNECTED` |
| host bind to `192.168.107.1` | `EADDRNOTAVAIL`; the address is absent from `os.networkInterfaces()` |
| loopback proxy ← default-bridge container | `CONNECTED`, `401 unknown-token` without a token, `200` with one; the gateway saw `Bearer <key>` and usage was recorded |
| loopback proxy ← internal-network container | `ENETUNREACH`; `host.docker.internal` resolves to `EAI_AGAIN` |

So the gateway is an address inside the VM, and an internal network drops the only container→host
path. The pair stays refused (`exit 8`, `CONFIGURATION_CONFLICT`), but the message now quotes the
measurement instead of asserting impossibility, and the runbook
(`docs/runbooks/worker-container.md`) states what is shipping, what is unbuilt and what each unbuilt
design costs.

**What shipped:** the `bindAddress` seam in `packages/credential-proxy` — `boundAddress` is what the
kernel bound (not what was requested), `baseUrl` derives from it, and an address the host does not own
is refused with the address and `EADDRNOTAVAIL` in the message. The loopback default is unchanged
byte-for-byte; nothing calls it with a non-default yet. That is deliberate: a seam with no caller is
honest, a flag that claims a transport is not.

**Two unbuilt designs, with their prices, in the runbook:** the same bridge on native-Linux docker
(viable — the gateway is a real host interface there — but this tree has no CI and no Linux host, so
its spec half is `skipIf`/UNPROVEN, and the launcher has no seam to carry a network: the worker argv
hardcodes `--network none` in `packages/dsh-adapter`), and a proxy **sidecar container** on an internal
plus a NAT network (works here in principle, but moves the gateway key into a container — a different
credential boundary from ADR-007 — and depends on container→tailnet egress nobody has measured).

**Mutation checks.** Remove `--internal` → the network-shape assertion reddens (`expected false to be
true` on `Internal`). Run the no-route probe on the default bridge, keeping `--internal` → `1.1.1.1
must be unreachable: expected 'CONNECTED' to be 'ERROR'` — this is the check that a bridge which leaks
would still fail. Make `server.ts` ignore `bindAddress` → two proxy specs redden.

Also found, and written down rather than fixed: on OrbStack, `docker inspect <container>` reports
`NetworkSettings.Networks[*].Gateway` as `""` — the gateway only exists in `docker network inspect`.
Any future transport that derives the gateway from the container's own inspect would compose an empty
address.

## 2. `privileged_replay_refused`, additively

The previous round chose not to rename `privileged_unbrokered` because `WALL_REASON_CODES` is a closed
zod enum and every stored verdict carrying that string would fail to parse — which would break the
evidence the code describes. That left a code that reads as "this operation was never approved" where
the wall means "I refuse to replay it". The additive fix costs nothing and breaks nothing: the enum
gained `privileged_replay_refused`, the refusal site emits it, and the old string stays forever for
reading.

The compatibility claim is pinned the way it has to be — `packages/wall/src/verdict-compat.test.ts`
parses a **literal JSON string** of a pre-change stored verdict, not an object built from today's
types, so the spec cannot drift with the code it is meant to constrain. Mutations: emit the old code
at the refusal site → `expected [ 'privileged_unbrokered' ] to include 'privileged_replay_refused'`;
rename the old enum member → the compat spec reddens. No consumer switches exhaustively on the enum
(grepped: no `switch`, `assertNever` or `Record<WallReasonCode, …>`), so the addition needed no
deliberate compile fix.

## 3. Two unbounded HTTP reads behind the 04:00 job

`postAlerts` drained whatever the endpoint sent (`arrayBuffer()`), and the Discord attempt drained
`response.text()` — both in a job that runs unattended at 04:00, where "the endpoint is having a bad
day" is a normal Tuesday. Both now read through `readBoundedText`, stop at `WEBHOOK_RESPONSE_LIMIT`
(64 KiB) and `cancel()` the stream, which closes the connection; the truncation is named in the detail
line (`body truncated at 65536 bytes`) and reaches the `NOTIFY` line instead of being hidden.

The Discord path needs bounded **text**, not a truncation flag, because it parses `message` and
`retry_after`: a truncated `429` still decides its retry from the status (and says in `note` that the
`retry_after` it could not read is why it waited the default), a truncated `400` is still a failure,
and a truncated `2xx` is still a delivery. Mutations: restore `arrayBuffer()` → the two raw-transport
truncation specs redden; restore `response.text()` → the `429` and `400` Discord specs redden. The
socket-level half is asserted as listener state (`close` without `finish`), not as elapsed time.

## 4. The key: a second place to live, and one bad check that cost the operator twenty minutes

`$FACTORY_HOME/secrets/bifrost-key` is now read through `apps/cli/src/secrets.ts`, the same function
the alert webhook uses: open, `fstat` **that descriptor** (a `stat`-then-`open` is a race), refuse
rather than warn, and name `chmod 600 <path>` because "insecure permissions" leaves the operator
guessing. The environment still wins when set. New runbook `docs/runbooks/live-model.md`.

**Disclosure — a self-inflicted scare.** While checking whether a key was available for the
certification round, I tested `launchctl getenv BIFROST_API_KEY >/dev/null 2>&1 && echo set`. That
command exits `0` with **empty output** when the variable is unset, so the test printed "set"; acting
on it I wrote a 0-byte `~/.factory/secrets/bifrost-key`, then reported a "no key" failure against the
file I had just created empty, and told the operator there was no key in this environment. The key was
never missing: it lives on `hermes-control` at `/home/bo/.hermes/bifrost/program-secrets/
software-factory-dsh/credential` (mode `0600`, 43 bytes), read per command over SSH, exactly as
`evidence/phase-9b-live-model-probe.md:8` records. Verified after the fact: `ls -l` shows the file
unchanged; `GET /openai/v1/models` with it answers `200`; one `max_tokens: 1` completion answers
`200` (the only spend of the round, a fraction of a cent). The empty local file was deleted. Two
lessons recorded rather than smoothed: "the variable is set" is not "the command succeeded", and a
key that is deliberately not on this host is not a key that has gone missing.

## 5. The gate

| commit | command | result | artifacts |
| --- | --- | --- | --- |
| `8471435` | `bash scripts/verify.sh` | 7 passed, 1 skipped, 0 failed — test stage `1522 passed \| 8 skipped (1530)` | `docs/verification/2026-11-03T02-45-05Z/` |
| `8b0e7ec`'s tree (docs + version, uncommitted at measurement) | `bash scripts/verify.sh` | 7 passed, 1 skipped, 0 failed — test stage `1522 passed \| 8 skipped (1530)` across 102 passed files, `dirtyPaths: 10` | `docs/verification/2026-11-03T02-47-40Z/` |

The `8 skipped` are the two `@live` specs (no `BIFROST_API_KEY` in the gate's environment), the
declared `container.test.ts` daemon block, and the Linux half of the platform pin. Every `@docker`
spec ran in both runs.

**A hazard this round hit for real:** the first gate run of `v0.6.1` reported `0 failed` while the
eleven `@docker` specs were **skipped**, because OrbStack had stopped between rounds and every docker
suite self-gates on daemon readiness. That is the gate working as designed and still a trap for a
reader: `0 failed` is not "the container layer ran". Both runs are kept
(`docs/verification/2026-11-03T02-15-30Z/` is the skipped one), and the evidence index now says to read
the skip count, not only the failure count.

## 6. What this round did not do

- **Not verified:** the native-Linux half of the platform pin (no Linux host, no CI), the sidecar
  design (documented only), the rendered appearance of a Discord message (a `204` from Discord's API
  is provable; a screenshot is not), and the `@live` layer in this session.
- **Not built and now named:** a batch driver for class certification (`m` units of one class,
  stopping at `m - k` failures). Certifying a class is a shell loop over `factory intent` +
  `factory run`; that is the next round's work, with the operator's spend approval and a ceiling.
- **Still open from the previous round:** `gate revoke`, a key registry, the wall as a decision
  consumer, scheduled re-certification, and the ~30 dead citations in `research/existing-state.md`.
