# The anchor is stale, missing, or behind (`ledger verify` exits 9)

## Symptom

`factory ledger verify` prints `MISSING`, `STALE` or `ROLLBACK` and exits **9** (`integrity`). It exits
**8** (`ANCHOR_UNAVAILABLE`) when it could not look at all — no target configured, or the host did not
answer. **That difference is the point:** `9` is a fact about the ledger, `8` is a fact about your
network, and `8` must never be mistaken for `MISSING`. Or you read `README.md`'s claim "detectable within
48 h" and want to know whether it is true _right now_.

```
$ factory ledger verify
outcome           STALE
age               73.4 h
scope             off-host
reason            the last anchor is 73.4 h old (limit 48 h); a rewrite after that point is
                  undetectable until the next anchor
```

## What the factory will refuse to do

- It will **not** call the ledger anchored because an anchor file exists. Existence is not freshness.
- It will **not** accept a local anchor as off-host. `FACTORY_ANCHOR_DIR` is reported as
  `LOCAL (not off-host)` — it detects truncation, not a host that rewrites both copies.
- It will **not** rewrite or repair the anchor from this machine. If the anchor says the ledger had
  more events than the ledger now has, that is a **fact to investigate**, not a sync to perform.

## The commands

```bash
export PATH="$HOME/.nvm/versions/node/v$(cat .nvmrc)/bin:$PATH"

factory ledger verify                 # what the factory believes, with the reason
factory ledger anchor                 # write today's anchor to the configured target
factory ledger anchor --json          # the record it wrote (seq, eventCount, headHash)
```

Configuration (composition root, never data):

| Variable              | Meaning                                                             | Scope reported |
| --------------------- | ------------------------------------------------------------------- | -------------- |
| `FACTORY_ANCHOR_SSH`  | host to append the anchor on, over `ssh -o BatchMode`               | `off-host`     |
| `FACTORY_ANCHOR_PATH` | path on that host (default `/var/lib/factory/ledger-anchors.jsonl`) | `off-host`     |
| `FACTORY_ANCHOR_DIR`  | local directory, used only when no host is configured               | `LOCAL`        |

### Installing the daily write

**macOS (what this host runs).** The job template lives in the repo at
`deploy/launchd/ai.factory.anchor.plist`; render it and load it:

```bash
cd /path/to/software-factory-dsh
NODE_DIR="$HOME/.nvm/versions/node/v$(cat .nvmrc)/bin"
sed -e "s|@REPO@|$PWD|g" -e "s|@NODE_BIN@|$NODE_DIR/node|g" -e "s|@NODE_BIN_DIR@|$NODE_DIR|g" \
  deploy/launchd/ai.factory.anchor.plist > ~/Library/LaunchAgents/ai.factory.anchor.plist
plutil -lint ~/Library/LaunchAgents/ai.factory.anchor.plist   # must print OK
launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/ai.factory.anchor.plist
launchctl kickstart -k gui/$(id -u)/ai.factory.anchor          # run it once, now
tail -6 ~/.factory/anchor.log                                  # "scope off-host" is the line that matters
```

`launchctl print gui/$(id -u)/ai.factory.anchor | grep 'last exit code'` says whether the last run
worked; the job does not retry, because a scheduled job retrying into a broken transport only fills the
log. Both paths and the node binary are absolute in the plist on purpose: launchd does not read your
shell profile, and a relative path here fails at 03:00 and nowhere else.

**Linux (cron).**

```bash
0 3 * * *  cd /path/to/software-factory-dsh && PATH="$HOME/.nvm/versions/node/v$(cat .nvmrc)/bin:$PATH" \
  FACTORY_ANCHOR_SSH=hermes-control FACTORY_ANCHOR_PATH='$HOME/.factory/anchors/software-factory-dsh.jsonl' \
  node apps/cli/src/main.ts ledger anchor >>"$HOME/.factory/anchor.log" 2>&1
```

The destination used on this deployment is `$HOME/.factory/anchors/software-factory-dsh.jsonl` on
`hermes-control` (mode `0700` on the directory, no root needed, same tailnet). It was chosen over
`/var/lib/factory` because that path does not exist there and a root-owned anchor on a machine whose
whole purpose is to hold unprivileged secrets buys nothing but another thing to provision.

## What "fixed" looks like

`factory ledger verify` exits **0** and prints `outcome FRESH` with `scope off-host` and an age under
48 h. For `ROLLBACK`, "fixed" is _not_ a command: it is establishing why this database has fewer events
than an anchor that was already written, before any verdict from it is trusted.

## When it does not work

- **`verify` says `MISSING` after a successful `anchor`** — _the read succeeded_ and there is no record
  there, so the transport wrote somewhere else (`FACTORY_ANCHOR_PATH` vs the path your `ssh` reads) or
  the host answered and discarded the append. Run `ssh -o BatchMode=yes <host> 'tail -1 <path>'` by
  hand. A host that cannot be reached is no longer one of the causes: that exits **8** with ssh's own
  message (`Host key verification failed`, `Connection refused`, …).
- **The host did not answer** — exit **8**, `ANCHOR_UNAVAILABLE`, message
  `the anchor at ssh host:path could not be read (exit 255): …`. Nothing is known about the ledger until
  this is fixed, and `factory alerts` reports it as exit 8 (never 0) for the same reason. Test it in the
  context the job runs in — `ssh -o BatchMode=yes <host> true` — because launchd has no ssh-agent: a key
  with a passphrase works in your terminal and fails at 03:00.
- **`verify` exits 8 with `could not be read` or `holds no readable record`, and the anchor is local** —
  the file is there and was not usable: `EACCES` (an anchor written by one user and read by another —
  common once the job runs under launchd), a path that is a directory, a file whose lines no longer
  parse, or a record written by a schema this build does not know. This is **not** `MISSING`: `MISSING`
  means the read succeeded and there is no anchor. `factory alerts` reports the local and the off-host
  case at exit **8** for the same reason, because both transports route through one function.
- **No anchor target configured** — exit **8** naming both variables. Set `FACTORY_ANCHOR_SSH` (off-host)
  or accept the weaker local anchor explicitly.
- **Alerting is built, notification is opt-in and local:** `factory alerts` (daily 04:00 →
  `~/.factory/alerts.log`) reports a stale, missing or rolled-back anchor as exit `9` and an unreachable
  host as exit `8`. With `--notify` the daily job also raises one macOS notification on this machine,
  or POSTs the same `alerts.v1` document to an endpoint you configured with `FACTORY_ALERTS_WEBHOOK_URL`
  — see [evidence-expiry.md](evidence-expiry.md). It does not reach a phone or an inbox, nothing retries
  a lost notification, the log remains the record, and a host asleep at 04:00 stays quiet until it wakes.

### The read path: timeouts, and one retry policy

A read that never ran is not a statement about the ledger, and it is not worth waking anyone over —
but a read that never ran _for a minute_ and a read that never ran _for a second_ look identical in a
log. Both are settled in `commandTransport` (`packages/anchor/src/index.ts`):

- **Every off-host call is bounded.** The composed command carries
  `-o BatchMode=yes -o ConnectTimeout=10 -o ServerAliveInterval=5 -o ServerAliveCountMax=2`, so a dead
  route fails in ~10 s and a connection that establishes then goes silent (a laptop sleeping mid-read)
  is dropped in ~10 s. Before this, the 04:00 job sat in the kernel's TCP timeout for roughly two
  minutes before reporting `UNREACHABLE`.
- **A transport failure is retried up to 3 times**, 750 ms apart, and only then reported. This exists
  because of an observed flake: on 2026-11-05 the 04:00 job reported
  `ssh: connect to host 100.92.236.42 port 22: Operation timed out`, paged Discord, and by 14:00 the
  same read was fresh. One lost route is not evidence that the ledger is unwatched, and an alarm that
  fires on one is an alarm people learn to ignore.
- **Nothing else is retried.** A read that _succeeded_ and returned content that no longer parses is a
  fact about the file — asking again cannot change it — so it refuses immediately, and the message says
  `retried only for transport failures` by omission: it carries no `(retried N times)` suffix.
- **A persistent failure still pages**, and the message now says how hard it tried:
  `…could not be read (exit 255): ssh: connect … Operation timed out. (retried 3 times)`. `factory
alerts` reports it at exit 8 exactly as before; the retry bounds how long a transient failure can
  hide, it does not let an unreachable host report `fresh`.

- **Still not built:** rotation of the anchor file, and any automatic reconciliation. `verify` remains
  the whole verification mechanism; a human schedules it and a human reads it.
