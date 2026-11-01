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

Schedule the daily write where the machine already has a scheduler:

```bash
# launchd (macOS) / cron (Linux): one line, no output on success
0 3 * * *  cd /path/to/software-factory-dsh && PATH="$HOME/.nvm/versions/node/v$(cat .nvmrc)/bin:$PATH" FACTORY_ANCHOR_SSH=hermes-control factory ledger anchor >>"$HOME/.factory/anchor.log" 2>&1
```

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
