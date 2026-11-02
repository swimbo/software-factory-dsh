# Runbook — the morning check (`factory alerts`)

**Symptom.** Nothing. This is the runbook you read _before_ something is wrong, or after noticing a line
in `~/.factory/alerts.log` or a notification. It is the one command that answers "did anything expire?".

```bash
factory alerts; echo $?
```

**It is read-only.** It writes nothing: no store row, no event, no anchor record. It is safe on a
quarantined store, and a spec asserts the ledger's event count is identical before and after.
`--notify` does not change that: it adds a side channel — a notification, or one POST — and still writes
nothing to the store or the ledger.

| exit | meaning                                                       | what to do                                                                                                                                                    |
| ---- | ------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `0`  | `alerts  no alerts` — anchor fresh, every certificate current | nothing                                                                                                                                                       |
| `9`  | at least one integrity alert                                  | the alert line names the next command — see the table below                                                                                                   |
| `8`  | the anchor host could not be reached, or no anchor configured | fix the transport (`FACTORY_ANCHOR_SSH`, the ssh key, `hermes-control` reachable). **This is not a clean run**: nothing is known about the ledger until it is |
| `2`  | usage error                                                   | read the message; the verb takes no arguments                                                                                                                 |

## Reading the alert lines

```
anchor            FRESH — anchored 1.0 h ago, off-host
INTEGRITY  CERT_NEVER  all task classes
           no class has ever been certified in this store; nothing to audit is not a licence
           next: factory audit --certifications; docs/runbooks/certificate-expired.md
```

| code                     | severity  | meaning                                                                                             | runbook                                          |
| ------------------------ | --------- | --------------------------------------------------------------------------------------------------- | ------------------------------------------------ |
| `ANCHOR_STALE`           | integrity | the last anchor record is older than 48 h — a rewrite since then is undetectable until the next one | [ledger-anchor.md](ledger-anchor.md)             |
| `ANCHOR_MISSING`         | integrity | there is no anchor record at all                                                                    | [ledger-anchor.md](ledger-anchor.md)             |
| `ANCHOR_ROLLBACK`        | integrity | the anchor is **ahead** of this ledger: the database was replaced or restored                       | [ledger-anchor.md](ledger-anchor.md)             |
| `CERT_STALE`             | integrity | a class certificate was measured under a different policy or model                                  | [certificate-expired.md](certificate-expired.md) |
| `CERT_NEVER`             | integrity | a class has no `certified` record (`not-certified`/`insufficient` count as never)                   | [certificate-expired.md](certificate-expired.md) |
| `STORE_QUARANTINED`      | integrity | the ledger quarantined itself; writes are refused                                                   | [store-quarantine.md](store-quarantine.md)       |
| `BUDGET_CEILING_REACHED` | warning   | an attempt's observed spend crossed its envelope and the token was revoked                          | `factory budget show`                            |

`ANCHOR_ROLLBACK` outranks staleness, and an integrity alert always outranks a warning — a warning
never masks an integrity failure.

**`ANCHOR_ROLLBACK` is the one to take seriously at 3am.** It means the off-host machine remembers a
ledger head that this database is _behind_: the file was restored from a backup, or replaced. Everything
recorded since then is untrustworthy until you know which copy is real, and the ledger's own triggers
cannot tell you, because they live inside the file that was replaced.

## Being told instead of reading (`--notify`)

The verb prints and logs and tells nobody by default: `--notify` is opt-in, so adding a channel did not
change what every existing caller does. With it, the alert set is delivered _after_ it is printed, so the
log always holds the facts even when the channel fails:

```bash
factory alerts --notify; echo $?
```

| configuration                    | channel | what happens                                                                                                                              |
| -------------------------------- | ------- | ----------------------------------------------------------------------------------------------------------------------------------------- |
| no `FACTORY_ALERTS_WEBHOOK_URL`  | local   | one macOS notification through `osascript`, plus one `NOTIFY  DELIVERED` line on stderr                                                   |
| `FACTORY_ALERTS_WEBHOOK_URL` set | webhook | one POST of the same `alerts.v1` JSON `--json` prints (5 s timeout, one retry); the `NOTIFY` line reports the status and scheme+host only |
| a host that is not macOS         | local   | a reported no-op (`NOTIFY  SKIPPED`, reason included), never an error that hides the alert                                                |

What is delivered: one line per **integrity** alert code (deduplicated — a per-class code names up to
five classes and says `+N more`), the anchor summarised, and the next command. Nothing is sent when
there is nothing to report: exit `0` is silent, and a warning-severity alert is logged but never
notified — paging for a spend ceiling is how exit-9 pages stop being read.

What is not: the exit code. `0`, `8` and `9` still describe the evidence; a failed delivery prints
`NOTIFY  FAILED — … (the exit code describes the evidence, not the transport)` and changes nothing else.
The notification line never carries a webhook's path or query string — a webhook URL is usually a
credential, so only the scheme and host are logged. The URL itself lives in the launchd plist or your
shell, never in a unit spec or the ledger.

### What a notification does and does not buy

**It buys:** when `factory alerts` finds something, a person who opted in is told — on this machine's
screen, or at an endpoint they configured. That is the whole claim. It is not an escalation path and it
is not on-call: there is nobody to escalate to, and this file does not pretend otherwise.

**It does not buy:**

- **A lost notification is lost.** There is one attempt, at most one retry for the POST, and no queue
  after the process exits. The next scheduled run is the retry.
- **A host asleep at 04:00 is quiet until it wakes.** The job is a `StartCalendarInterval`; per
  `launchd.plist(5)`, launchd runs a calendar occurrence missed while the machine was asleep the next
  time it wakes, and coalesces several missed occurrences into one run (cron would skip them). The
  plist's `RunAtLoad` is `false`, and it is a different key: it controls whether the job also runs when
  the agent is loaded, not whether missed runs are recovered. A host that is off for a week, or that
  never wakes again, says nothing at all.
- **macOS may swallow what it accepts.** No logged-in GUI session, notification permission denied, Do
  Not Disturb, or a long body that gets truncated: the local path reports a non-zero `osascript` exit
  when it can, but a notification macOS drops after accepting cannot be detected from here. The screen
  is a hint; the log is the record, and the log carries every alert line in full.
- **A 2xx is a delivery, not a receipt.** It means the endpoint accepted the POST; it says nothing about
  whether a human read it. A 4xx is reported and not retried (the same request would be refused again);
  a 5xx or a transport failure gets the one retry. What the endpoint does with the JSON — a chat message,
  a phone push, a ticket — is the endpoint's business, not something this tool can claim.
- **The plist is not a vault.** `FACTORY_ALERTS_WEBHOOK_URL` would sit in
  `~/Library/LaunchAgents/ai.factory.alerts.plist` in plain text; use a URL you are willing to have on
  this host. The log redaction protects the log, not the file.

## The scheduled run

A launchd job runs the same check daily at **04:00** (an hour after the anchor), passing `--notify`, and
appends stdout and stderr to `~/.factory/alerts.log`. Install it once, from the repository root:

```bash
cd /path/to/software-factory-dsh
NODE_DIR="$HOME/.nvm/versions/node/v$(cat .nvmrc)/bin"
sed -e "s|@REPO@|$PWD|g" -e "s|@NODE_BIN@|$NODE_DIR/node|g" -e "s|@NODE_BIN_DIR@|$NODE_DIR|g" \
  deploy/launchd/ai.factory.alerts.plist > ~/Library/LaunchAgents/ai.factory.alerts.plist
plutil -lint ~/Library/LaunchAgents/ai.factory.alerts.plist             # expect: OK
launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/ai.factory.alerts.plist
launchctl kickstart -p gui/$(id -u)/ai.factory.alerts                    # run it now
tail -n 40 ~/.factory/alerts.log
```

The job delivers to this machine's notification centre until you give it an endpoint. To use a webhook
instead, uncomment the `FACTORY_ALERTS_WEBHOOK_URL` block in `EnvironmentVariables` (it is shipped as a
comment, unset) and reload the agent; the local notification is not used as a fallback when a URL is
configured, because a channel that silently substitutes itself hides the broken configuration it was
supposed to report. To go back to log-only, delete ` --notify` from `ProgramArguments` and reload; a spec
asserts that the same run without the flag prints and logs and delivers nothing.

`launchctl print gui/$(id -u)/ai.factory.alerts | grep 'last exit code'` shows what the last run
answered — `9` is a normal answer, not a broken job (`NOTIFY  FAILED` is not the exit code, and does not
replace it). Uninstall with `launchctl bootout gui/$(id -u)/ai.factory.alerts`.

Useful one-liners:

```bash
grep -c INTEGRITY ~/.factory/alerts.log      # how many mornings did something expire
grep -c 'NOTIFY  FAILED' ~/.factory/alerts.log # how many mornings did the channel fail
tail -n 40 ~/.factory/alerts.log             # when was the last one
```

## What this does and does not fix

**Fixed:** expiry is _detectable_ in one command with a machine-readable answer; a scheduled job makes
the answer durable in a log; and with `--notify` the run can also put a summary in front of the operator
who opted in, on this machine or at an endpoint they configured. An unreachable anchor host is exit `8`
and never `0`, in the log and in the notification.

**Not fixed:** a notification is a best-effort side channel, not an escalation path. Nothing retries a
lost notification, nothing pages a phone or an inbox on its own, and nothing notices a host that stops
running jobs. "An operator who opted in can be told" is the true sentence; "alerts page you" is not.
Re-certification is likewise still manual: the monitor says a certificate expired; a person decides to
re-measure the class.

## On a fresh factory

A store with no class certificates reports `CERT_NEVER` and exits `9`. That is the monitor working: on
this host, `factory alerts` says exactly that today, because no unit has been certified in
`~/.factory` yet. Do not "fix" it by lowering the rule — the same rule is why `audit --certifications`
refuses to call an empty store clean.
