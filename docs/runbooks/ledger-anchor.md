# The anchor is stale, missing, or behind (`ledger verify` exits 9)

## Symptom

`factory ledger verify` prints `MISSING`, `STALE` or `ROLLBACK` and exits **9** (`integrity`). Or you
read `README.md`'s claim "detectable within 48 h" and want to know whether it is true _right now_.

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

- **`verify` says `MISSING` after a successful `anchor`** — the transport wrote somewhere else or the
  `ssh` command failed silently. Run `ssh -o BatchMode=yes <host> 'tail -1 <path>'` by hand; the anchor
  command surfaces a non-zero exit but not a host that answers and discards.
- **No anchor target configured** — exit **8** naming both variables. Set `FACTORY_ANCHOR_SSH` (off-host)
  or accept the weaker local anchor explicitly.
- **This is not built:** rotation of the anchor file, alerting on staleness, and any automatic
  reconciliation. `verify` is the whole mechanism; a human schedules it and a human reads it.
