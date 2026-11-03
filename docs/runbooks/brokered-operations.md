# Brokered operations: one decision, one operation

A privileged operation — a command that escalates (`sudo`), writes outside the attempt's worktree,
or touches a credential path — is never performed on the worker's say-so. It is either **brokered
under a recorded human decision** or **refused**. This runbook is how an operator records that
decision, what the factory prints at each step, and what to do when the answer is no.

Every transcript below was captured on this tree (v0.5.0, node 26.12.1) with a throwaway
`FACTORY_HOME=/tmp/doc-capture`; the ids, hashes and timestamps are real output, not illustrations.

## The two levers

| lever                             | what it means                                                 | who sets it                  |
| --------------------------------- | ------------------------------------------------------------- | ---------------------------- |
| `FACTORY_PRIVILEGED_BROKERING=on` | the executor brokers `command` steps instead of trusting them | the policy / the test seam   |
| `factory gate`                    | the operator records a decision that authorises one operation | a person, with their own key |

Brokering defaults **off**, and an executor with brokering off does not refuse anything — it never
looked. The refusal path described here is the one that exists when brokering is on.

`factory gate` **verifies signatures; it never holds, derives or writes a private key.** There is no
`factory sign` verb and no flag that mints a signature, which is why the procedure below has a step
only you can perform.

## The four commands

| command                          | writes                                        | exit                                                               |
| -------------------------------- | --------------------------------------------- | ------------------------------------------------------------------ |
| `factory gate request <argv…>`   | nothing                                       | `0` unprivileged or already covered · `5` privileged and undecided |
| `factory gate decide …`          | the artifact + one `privileged.decided` event | `0` recorded · `2` usage · `5` the signature does not verify       |
| `factory gate list`              | nothing                                       | `0`                                                                |
| `factory gate show <decisionId>` | nothing                                       | `0` · `2` when no artifact carries that id                         |

### 1. Ask what the operation would be

```bash
factory gate request -- cp /etc/hosts /dev/null
```

```
operation  cp /etc/hosts /dev/null
operationSha sha256:872f7652c297b9fbe8e9afe910f42b40e590ca3982490e868d0e09809a5781e6
taskId     gate:872f7652  (a label for reading; a standalone decision binds an operation, not a unit)
operator key ed25519:554ecfdf

payload to sign (sha256 over the canonical content; the signature covers both timestamps):
  sha256:21d1cac3e3750acdc4728967e6d5bcbaecb062c320a80c9cf9770bebe2ede51e

no live decision covers this operation. Sign the payload above, then run:
  factory gate decide --signature <file-with-your-signature> --expires-in 15m --issued-at 2026-11-02T23:19:42.126Z --confirm "decide 872f7652" -- cp /etc/hosts /dev/null
exit=5
```

Three things to read, in this order:

1. **`operationSha`** — the normalised operation. The classifier rewrites before hashing, so
   `/usr/bin/sudo ls` and `sudo ls` are one operation while `sudo install x` and
   `sudo install x --upgrade` are two. A decision names the hash, never the raw string.
2. **`payload to sign`** — sha256 over the decision's canonical content. **Both timestamps are
   inside it.** `--issued-at` is printed rather than left to `decide`, because a payload that
   hashes a timestamp cannot be signed in one process and re-derived in another otherwise.
3. **the exit code** — `5` means "a person has to decide", and that is why the command exists. `0`
   means nobody has to: the argv is unprivileged, or a live decision already covers it.

`--` before the operation argv is **required**. Without it, commander parses the operation's own
flags as `factory gate`'s flags: `factory gate request --json cp /etc/hosts /dev/null` silently
becomes an operation with `--json` as an argument. `--json` must therefore come _before_ `--`, which
is the same trap at the shell as in a script.

### 2. Sign the payload, with your key, wherever the private half lives

The tool cannot do this step. On the operator's machine:

```bash
node --input-type=module -e '
import { readFileSync, writeFileSync } from "node:fs";
import { signPayload } from "./packages/gates/src/index.ts";
const [payload, out, key] = process.argv.slice(1);
writeFileSync(out, signPayload(payload, readFileSync(key, "utf8")));
console.log("signed", payload);
' sha256:21d1cac3e3750acdc4728967e6d5bcbaecb062c320a80c9cf9770bebe2ede51e \
  "$KEYDIR/decision.sig" "$KEYDIR/operator.ed25519.pem"
```

Key lookup when `decide` verifies, in order:

1. `FACTORY_OPERATOR_KEY` (a path),
2. `$FACTORY_HOME/keys/operator.pub.pem`,
3. `$FACTORY_HOME/keys/operator.ed25519.pub`.

That is the same order `factory promote` uses, and it is also the retirement story: a public key
that is no longer one of those files verifies nothing. See
[`rotate-operator-key.md`](rotate-operator-key.md).

### 3. Record the decision

```bash
factory gate decide \
  --signature "$KEYDIR/decision.sig" \
  --issued-at 2026-11-02T23:19:42.126Z \
  --confirm "decide 872f7652" \
  -- cp /etc/hosts /dev/null
```

```
decision   gd_21d1cac3e3750acdc4728967
operation  cp /etc/hosts /dev/null
operationSha sha256:872f7652c297b9fbe8e9afe910f42b40e590ca3982490e868d0e09809a5781e6
signed by  ed25519:554ecfdf
live until 2026-11-02T23:34:42.126Z (issued 2026-11-02T23:19:42.126Z)
artifact   /tmp/doc-capture/gates/gd_21d1cac3e3750acdc4728967.json
ledger     privileged.decided seq 1

Next, one of:
  factory gate show gd_21d1cac3e3750acdc4728967
  factory gate request -- cp /etc/hosts /dev/null   # now reports "already covered"
exit=0
```

The decision is persisted twice, because the two readers are different people: the **artifact**
(`$FACTORY_HOME/gates/<decisionId>.json`) is what a person can read without a database, and the
**`privileged.decided` event** is what an audit replays. Re-running the _same signed envelope_
re-writes the artifact but appends no second event (`alreadyRecorded: true`, `eventSeq: null`): the
id is a function of the content, so a replay is the same decision, not a second one.

Two refusals worth recognising:

```
$ factory gate decide --signature "$KEYDIR/decision.sig" --issued-at 2026-11-02T23:19:43.126Z \
    --confirm "decide 872f7652" -- cp /etc/hosts /dev/null
GATE_REQUIRED: the signature does not verify against ed25519:554ecfdf for payload sha256:643d235c….
Either it was made with a different key, or it covers a different payload — check that --issued-at
and --expires-in reproduce the timestamps `factory gate request` printed.
exit=5
```

That is the **copy-the-command-an-hour-later** case, and it fails closed on purpose: re-dating the
decision changes the signed content, so the signature no longer covers it. Re-run `gate request` and
sign _that_ payload.

```
$ factory gate decide --issued-at 2026-11-02T23:19:42.126Z --confirm "decide 872f7652" -- cp /etc/hosts /dev/null
USAGE: missing --signature. This tool verifies an operator signature; it never holds a private key,
so it cannot make one. Sign the payload `factory gate request` prints, then pass it here.
exit=2
```

`--signed-by` is an optional **echo**, never a field of the signed content: if you pass it, it must
equal the signing key id (`ed25519:…`), because a name is a string the worker could assert and the
record must not contain one (L1). Omit it and nothing changes.

### 4. Run

```bash
FACTORY_EXECUTOR=fake FACTORY_PRIVILEGED_BROKERING=on \
  factory run "$UNIT" --scenario "$FACTORY_HOME/scenario.json" --json
```

The privileged `command` step is brokered. With no decision, the run fails before the step spawns:

```
{"ok":false,"code":"GATE_REQUIRED","message":"GATE_REQUIRED: cp writes /etc/hosts, which is outside
the worktree's authority. A privileged operation needs a recorded human decision (GateDecision) for
exactly this command; none was presented. Operation hash: sha256:c68f6756…. [broker.no-decision].",
"exitCode":5,…}
exit=5
```

`[broker.no-decision]` is the rule that matched; the operation hash is the one to paste into
`gate request`.

With the decision recorded, the same shape of run reaches a receipt and the command executes once:

```
{"ok":true,…,"outcome":"unknown","receiptSha":"sha256:e19362de…",
 "reasons":["privileged_unbrokered","suite_unknown","holdout_unavailable","delta_unmeasured"],
 "needsPerson":true}
exit=5
```

Note what did **not** change: the verdict is still `unknown`, and a privileged replay is still refused
and still listed among the reasons. A decision authorises the _operation_, not the _promotion_ — the
wall has no evidence that the operation was measured against an oracle, so it will not pass the unit
on the strength of a signature. `needsPerson: true` is the honest end state; `factory status <unit>`
is where a person decides next.

The transcript above was captured at `v0.6.0` and prints `privileged_unbrokered`. From `v0.7.0` the
same run prints `privileged_replay_refused` instead: the old code read as "the operation was never
approved", while what the wall observed is "I refuse to replay it". The old string is kept in the
closed enum so that verdicts already on disk still parse, and it is not rewritten in a capture that
did happen — a transcript edited to match today's code is no longer a transcript.

A second run presenting the same decision is refused:

```
{"ok":false,"code":"GATE_REQUIRED","message":"GATE_REQUIRED: decision gd_92a32d82… has already been
used for one operation; a decision is not a session. A second privileged operation needs a second
decision. [broker.replayed].","exitCode":5,…}
exit=5
```

`[broker.replayed]` is the one-use marker doing its job. The marker is a row in the store
(`privileged_decisions`), written by one conditional `INSERT … ON CONFLICT DO NOTHING` inside one
transaction, so the second _process_ loses the race even though it never saw the first one's memory.
Two consequences an operator should expect:

- the decision is spent even if the run afterwards fails — consumption happens when the operation is
  allowed, not when the unit eventually passes;
- a decision covers **one operation**. A unit that needs two privileged commands needs two decisions,
  or one decision covering a single argv that does both.

## Reading the record

```
$ factory gate list
gd_21d1cac3e3750acdc4728967  live  ed25519:554ecfdf  until 2026-11-02T23:34:42.126Z
  sha256:872f7652c297b9fbe8e9afe910f42b40e590ca3982490e868d0e09809a5781e6
exit=0

$ factory gate show gd_21d1cac3e3750acdc4728967
decision   gd_21d1cac3e3750acdc4728967
taskId     gate:872f7652
operator   ed25519:554ecfdf (active)
signature  verifies
operationSha sha256:872f7652c297b9fbe8e9afe910f42b40e590ca3982490e868d0e09809a5781e6
payload    sha256:21d1cac3e3750acdc4728967e6d5bcbaecb062c320a80c9cf9770bebe2ede51e
issued     2026-11-02T23:19:42.126Z
live until 2026-11-02T23:34:42.126Z
consumed   no
artifact   /tmp/doc-capture/gates/gd_21d1cac3e3750acdc4728967.json
exit=0
```

- **`consumed`** is the durable answer, not a per-invocation one: it is the `privileged_decisions`
  row, so it survives restarts and is shared by every process using this `FACTORY_HOME`.
- **`keyActive` / `signature verifies`** are recomputed from the key published _now_. A decision
  signed with a key that has since been rotated away lists `NOT ACTIVE — retired or unknown` and
  does not verify, which is the intended effect of rotation.
- **`taskId gate:<sha8>`** is a label for reading a standalone decision. It is derived from the
  operation hash and is **not** a unit: nothing was submitted, nothing will be dispatched under it.
- The artifact deliberately records `phraseSha`, not the phrase. `show` recovers the phrase from the
  signed operation (`decide <sha8>`) and checks it against that hash, which is why it can print the
  phrase without the artifact handing a reader a string they could reuse.

`gate list` exits `3` when an artifact under `$FACTORY_HOME/gates/` cannot be read as a decision
(edited, half-written, or a typo), and prints the path and the reason. Such a file is **ignored** by
`run`, which logs `WARN gate: ignoring <path>` once per launch rather than failing the launch on
someone else's bad edit.

## When something is refused

| symptom                                                       | cause                                                       | what to do                                                       |
| ------------------------------------------------------------- | ----------------------------------------------------------- | ---------------------------------------------------------------- |
| `[broker.no-decision]`                                        | no live decision covers this exact operation                | `factory gate request -- <argv…>`, sign, `decide`                |
| `[broker.replayed]`                                           | the decision was already used                               | ask a person for a second decision; a decision is not a session  |
| `[broker.expired]`                                            | `expiresAt` has passed                                      | request and decide again; the window is 15m by default           |
| `[broker.phrase-mismatch]` / `[broker.phrase-missing]`        | the presented phrase is not the one the record committed to | this is not operator-fixable: re-record the decision             |
| `the signature does not verify` (exit 5)                      | signed a different payload, or the key rotated              | re-run `request`, sign _its_ payload and `--issued-at` exactly   |
| `USAGE: missing --signature` (exit 2)                         | nothing to verify                                           | sign the payload; the tool cannot                                |
| `USAGE: --confirm must be exactly "decide <sha8>"` (exit 2)   | wrong phrase                                                | the phrase is derived from the operation; copy it from `request` |
| `USAGE: --expires-in expects a duration with a unit` (exit 2) | `--expires-in 15`                                           | use `15m`, `30s`, `2h` — a bare number is not guessed at         |
| `not privileged: …` (exit 0)                                  | the classifier sees no brokered operation                   | nothing to decide; the step was never gated                      |

## What is deliberately not built

- **`factory gate revoke`.** There is no way to un-decide. To stop a decision, let it expire or
  rotate the key; a consumed decision cannot be returned. Deleting the artifact does not un-consume
  the marker, and deleting the marker would be editing the ledger, which this project does not do.
- **A key registry in the store.** The active keys are the files above. Retirement is replacement,
  not a database update.
- **A per-unit decision list.** `taskId` on a standalone decision is a reading label; there is no
  query that returns "the decisions for unit X", because a decision is about an operation.
- **Signing.** The tool is a verifier. If you find yourself wanting `factory gate decide` to work
  without a signature, the answer is the operator's key, not a flag.

## Related

- [`rotate-operator-key.md`](rotate-operator-key.md) — the key pair, and what rotation does to
  existing signatures.
- [`worker-container.md`](worker-container.md) — the isolation the worker runs under, and
  [§"When the two settings cannot both be honoured"](worker-container.md#when-the-two-settings-cannot-both-be-honoured):
  `FACTORY_WORKER_ISOLATION=container` together with a live model is refused at probe time with exit 8
  `CONFIGURATION_CONFLICT` — deliberately not `CONTAINER_UNAVAILABLE`, because the daemon and the
  image are fine and the operator's next action is to unset one lever, not to build anything.
