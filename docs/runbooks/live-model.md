# Running the live layer

Two things spend money in this repository: `factory run` on a unit whose lane is `lit` or `dark` (a
real model turn), and the `@live` specs. Everything else — the whole offline gate — is deterministic
and free (C5). This page is how to make the key available to the thing that spends, and what the first
run of a new class actually costs.

## The key, in one of two places

**A file (preferred on a workstation).** The key is read from `$FACTORY_HOME/secrets/bifrost-key`, and
the file must be mode `0600` — this CLI refuses it otherwise, rather than using a secret that any local
user (or anything that snapshots your home directory) can read:

```bash
umask 077 && mkdir -p ~/.factory/secrets
read -rs "KEY?paste the gateway key: "; echo
printf '%s' "$KEY" > ~/.factory/secrets/bifrost-key; unset KEY
ls -l ~/.factory/secrets/bifrost-key        # -rw------- is the only mode that works
```

**The environment (a one-off, or CI).** `BIFROST_API_KEY` in the controller's environment wins over
the file. It is read by the controller and injected by the credential proxy; it is never forwarded to
the worker and never appears in a launch record.

## What a live run also needs

```bash
export FACTORY_PROXY_BASE_URL="https://hermes-control.tail4296e6.ts.net/openai/v1"
export DSH_BIN="/Applications/DeepSeek Harness.app/Contents/Resources/runtime/cli/bin/dsh"
```

`FACTORY_PROXY_BASE_URL` is the gateway the credential proxy fronts. `DSH_BIN` is the installed
`dsh` the adapter drives. Both are configuration, not secrets; the base URL appears in receipts, the
key never does.

## What it costs

A live turn is one model call over one or two steps: the only measured unit on record used ~`12.7k`
tokens (see `docs/planning/dark-factory-dsh/evidence/phase-9b-live-model-probe.md`). Before spending,
set an envelope — `factory budget` prints the current one and a run that would cross it exits `6`
before any call is made.

## Certifying a task class

A class certificate is written by `recordVerdict` when a class has been measured at its operating
point (`m` attempts, `k` of them passing). It is not a thing an operator or a job may assert; there is
no `factory certify`. So the only way to stop `factory alerts` reporting `CERT_NEVER` is to run enough
real units of one class and let the verdicts accumulate.

The batch driver is built: [`../../scripts/certify-class.sh`](../../scripts/certify-class.sh) runs `m`
units of one class, reads the key per run, and stops at `m - k` failures — the third failure
for the `m = 20, k = 18` operating point — so a doomed class costs three units rather than twenty. It
refuses to start without the corpus, the class and a `FACTORY_HOME` that already exists.
[`certify-class.md`](certify-class.md) is the whole path, including
`scripts/certification-artifacts.sh`, which materialises the corpus and the twenty base revisions from
this repository's own documentation so the loop has something to run against.
