# The worker's container: enabling it, and what a refusal means (`CONTAINER_UNAVAILABLE` / `CONFIGURATION_CONFLICT`, exit 8)

## Symptom

Either you asked for the worker to run inside a container and `run` refused with `CONTAINER_UNAVAILABLE`:

```
$ FACTORY_WORKER_ISOLATION=container factory run U-…
CONTAINER_UNAVAILABLE: image factory-env:runtime-pin: Error response from daemon: No such image:
factory-env:runtime-pin. runbook: docker build --tag factory-env:rc5 docker/factory-env, then re-run
(or set FACTORY_WORKER_IMAGE to the tag you built). Nothing was dispatched and no budget was reserved.
```

or it refused with `CONFIGURATION_CONFLICT` (the daemon is fine; two settings cannot both be
honoured — see [below](#when-the-two-settings-cannot-both-be-honoured)), or you want to turn it on
and need to know what it does and does not buy.

**`CONTAINER_UNAVAILABLE` means the turn could have run, just not where you asked it to.** The factory
never falls back to a host process: a silent fallback would make the README's isolation sentence false
while every test stayed green. So a refusal costs nothing — it happens in the executor probe, **before**
any budget is reserved and before an attempt directory exists.

## Turning it on

```bash
# 1. Build the image from the pinned runtime (node from .nvmrc, dsh 0.2.1-rc.5).
docker build --tag factory-env:rc5 docker/factory-env

# 2. Ask for the worker to run inside it.
export FACTORY_WORKER_ISOLATION=container
export FACTORY_WORKER_IMAGE=factory-env:rc5      # default: factory-env:rc5

# 3. Optional knobs, all refused (exit 8) rather than clamped when malformed:
#    FACTORY_WORKER_CONTAINER_USER=10001:10001     # must be non-root
#    FACTORY_WORKER_CONTAINER_MEMORY=2g
#    FACTORY_WORKER_CONTAINER_PIDS=512

factory run U-…
```

`FACTORY_WORKER_ISOLATION` is a **separate axis** from `FACTORY_EXECUTOR`: the executor picks _which
adapter_ (`headless`/`fake` — whether a model is reached at all), the isolation picks _where the turn
runs_. `host` is the default, so nothing about an existing setup changes until you set it.

## What it buys, and what it does not

The turn runs inside `factory-env` as uid **10001** with `--network none`, `--read-only`,
`--tmpfs /tmp`, `--cap-drop ALL`, `--security-opt no-new-privileges`, an explicit memory ceiling, an
explicit pid ceiling, the clone and a per-attempt `DSH_HOME` bind-mounted writable, the attempt record
mounted read-only, and the attempt id as a label. `launch.json` records all of it —
`container: {image, imageDigest, user, network, readOnlyRoot, memoryLimit, pidsLimit, tmpfs, mounts,
mountsDenied, labels}` — and `container: null` means "host process", never "unknown".

**Not bought:**

- **Not a second OS uid on this host.** The worker is not root _inside_ the container, but it is a
  container, not an account boundary on the machine. A root-level attacker on the host is out of scope.
- **Network isolation is pinned by the argv spec, not probed from inside.** Deleting `--network none`
  does not redden this suite; the wall's E2E-43 covers egress with a host control.
- **A `SIGKILL`ed control plane cannot clean up after itself — `factory recover` does.** `--rm` is a
  promise about the _client's_ lifetime, and the launcher's sweep runs in the process that just
  died, so the next recovery is the only later process that still knows the attempt id. For the
  attempts **this invocation** reconciles to `ambiguous`, `recover` reads that attempt's
  `launch.json`, and only when the record says the worker ran in a container does it remove every
  container labelled `org.factory.attempt=<attemptId>` — by that id and nothing else, never by
  image and never by a bare label. It never sweeps an attempt whose lease is still live (a live
  attempt may be someone's running worker), never re-sweeps an attempt an earlier recovery already
  reconciled, and does nothing at all for a `container: null` record. Docker missing, the daemon
  down, an unreadable or malformed record, and a container that survives `rm -f` are each reported
  as `skipped`/`failed` with the reason, in the text and in `recover --json`'s `sweeps[]` value —
  never as "swept 0". A sweep that cannot fail loudly is the same leak one layer down. A failed
  sweep does not change `recover`'s exit code (`4` for the ambiguity it produced, `8` for a
  quarantined store); it is a fact reported beside the ambiguity, not a verdict about it. The
  engine finding is in `docs/planning/dark-factory-dsh/evidence/phase-15-round.md`.

## What "fixed" looks like

```bash
factory run U-…            # exits 0, attempt completes
node -e 'const r=require(process.argv[1]); console.log(r.container)' "$FACTORY_HOME/attempts/U-…/A-…/launch.json"
#   { image: 'factory-env:rc5', imageDigest: 'sha256:…', user: '10001:10001', network: 'none', … }
docker ps -aq --filter label=org.factory.attempt=<attemptId>   # empty when the attempt is over
```

After a `kill -9` of the control plane the second command still says `container: {…}`, and the
third is empty only once `factory recover` has run. That path is a spec, not a promise:

```bash
npx vitest run e2e/cli/docker/09-recover-sweep.test.ts
```

It starts a worker container, `SIGKILL`s the control plane mid-turn, asserts the orphaned
container is **still listed**, then asserts `factory recover` exits `4`, records the attempt
`ambiguous`, and leaves the label filter above empty; a second `recover` is idempotent. The same
spec covers the negative case — an attempt whose record says `container: null` is not swept, and
no docker client is spawned for it. With no `factory-env:rc5` image the suite skips with its build
command rather than passing, so a green here means it ran.

## When the two settings cannot both be honoured

A **different** refusal, on the same exit code, with the opposite next action: nothing is missing.

```
$ FACTORY_WORKER_ISOLATION=container FACTORY_LIVE_MODEL=1 BIFROST_API_KEY=sk-… factory run U-…
CONFIGURATION_CONFLICT: FACTORY_WORKER_ISOLATION=container runs the worker with `--network none`,
but a live model (FACTORY_LIVE_MODEL=1) authenticates through the credential proxy, which binds
127.0.0.1 on the host. A container with no network cannot reach this host's loopback, so the model
call inside the worker could never be authenticated. Two ways forward: unset FACTORY_WORKER_ISOLATION
to drop the container and run this turn on the host (the default), or unset FACTORY_LIVE_MODEL and
run the model call on the host, outside the containerised worker. Nothing was dispatched and no
budget was reserved.
traceId T-…
  runbook: docs/runbooks/worker-container.md §"When the two settings cannot both be honoured" — the
daemon and the image are fine; unset FACTORY_WORKER_ISOLATION (drop the container) or
FACTORY_LIVE_MODEL (call the model from the host), then re-run: factory run <unitId>
$ echo $?
8
```

Why it cannot work: the container's network namespace is empty (`--network none`), and "this host's
`127.0.0.1`" is a different machine from inside that namespace — the proxy is not reachable at any
address the container has. The alternative — putting the proxy _inside_ the container — would put
the operator's credential where the worker runs, which is what the container is for.

Why it is refused **before** dispatch: the worker would otherwise start, fail to authenticate, and
die as an unexplained 401 that looks like a model fault. The probe is the last place where "nothing
was dispatched and no budget was reserved" is still true, so the refusal lives there (exit 8, no
`usage_records` row, no attempt directory).

**`CONFIGURATION_CONFLICT` is not `CONTAINER_UNAVAILABLE`, and the code says which one you have.**
If you were sent here by `docker build` advice, that is the other code and this section is the wrong
one: the daemon and the image are fine, and rebuilding them changes nothing. Pick one:

```bash
# Drop the container: run this turn on the host (the default).
unset FACTORY_WORKER_ISOLATION

# Or keep the container and call the model from the host, outside it.
unset FACTORY_LIVE_MODEL BIFROST_API_KEY
```

A factory cannot honour both at once, and it will not pick for you: "we silently ran it on the host"
is the kind of quiet downgrade that makes an isolation claim false while the tests stay green.

## When it does not work

- **`No such image`** — build it (`docker build --tag factory-env:rc5 docker/factory-env`), or point
  `FACTORY_WORKER_IMAGE` at the tag you did build. The refusal repeats the command for this reason.
- **`Cannot connect to the Docker daemon`** — the daemon is not running; `docker info` is the check.
  This is exit 8 on purpose: an environment fault, not a verdict about the unit.
- **`win32`** — unsupported, refused at probe time. The container flags this path relies on are
  Linux-container semantics.
- **`a killed container is not ambiguous`** — it is: `ATTEMPT_AMBIGUOUS` (exit 4), one attempt, no
  receipt, no redispatch. If `recover` appears to do nothing, the lease is probably still live — that
  is the intended "the lease still vouches for a worker" deferral, and it resolves when the lease
  expires. Once it does reconcile, the container the dead process left behind is swept by label;
  if that sweep cannot run, `recover` says `FAILED` with the reason and the exact `docker ps`
  command that answers "is it still there?", and its exit code is still the ambiguity's. See
  [ambiguous-attempt.md](ambiguous-attempt.md).
- **Want the host back?** Unset `FACTORY_WORKER_ISOLATION`. That is a deliberate act; the factory will
  never do it for you on a failed probe.
