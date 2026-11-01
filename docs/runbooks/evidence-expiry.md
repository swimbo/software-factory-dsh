# Runbook — the morning check (`factory alerts`)

**Symptom.** Nothing. This is the runbook you read _before_ something is wrong, or after noticing a line
in `~/.factory/alerts.log`. It is the one command that answers "did anything expire?".

```bash
factory alerts; echo $?
```

**It is read-only.** It writes nothing: no store row, no event, no anchor record. It is safe on a
quarantined store, and a spec asserts the ledger's event count is identical before and after.

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

## The scheduled run

A launchd job runs the same check daily at **04:00** (an hour after the anchor), appending to
`~/.factory/alerts.log`. Install it once:

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

`launchctl print gui/$(id -u)/ai.factory.alerts | grep 'last exit code'` shows what the last run
answered — `9` is a normal answer, not a broken job. Uninstall with
`launchctl bootout gui/$(id -u)/ai.factory.alerts`.

Useful one-liners:

```bash
grep -c INTEGRITY ~/.factory/alerts.log   # how many mornings did something expire
tail -n 40 ~/.factory/alerts.log          # when was the last one
```

## What this does and does not fix

**Fixed:** expiry is _detectable_ in one command with a machine-readable answer, and a scheduled job
makes the answer durable in a log. An unreachable anchor host is exit `8` and never `0`.

**Not fixed:** **nothing pages a person.** There is no email, no webhook, no channel. An alert is a line
in a log and an exit code that a timer ignores, so a host that stops running jobs goes quiet rather than
loud. Until something escalates, "nothing pages anyone" is still the true sentence, and reading this file
is a human ritual rather than a control. Re-certification is likewise still manual: the monitor says a
certificate expired; a person decides to re-measure the class.

## On a fresh factory

A store with no class certificates reports `CERT_NEVER` and exits `9`. That is the monitor working: on
this host, `factory alerts` says exactly that today, because no unit has been certified in
`~/.factory` yet. Do not "fix" it by lowering the rule — the same rule is why `audit --certifications`
refuses to call an empty store clean.
