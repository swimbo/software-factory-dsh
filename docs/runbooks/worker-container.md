# The worker's container: enabling it, and what a refusal means (`CONTAINER_UNAVAILABLE`, exit 8)

## Symptom

Either you asked for the worker to run inside a container and `run` refused:

```
$ FACTORY_WORKER_ISOLATION=container factory run U-…
CONTAINER_UNAVAILABLE: image factory-env:runtime-pin: Error response from daemon: No such image:
factory-env:runtime-pin. runbook: docker build --tag factory-env:rc5 docker/factory-env, then re-run
(or set FACTORY_WORKER_IMAGE to the tag you built). Nothing was dispatched and no budget was reserved.
```

or you want to turn it on and need to know what it does and does not buy.

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
- **A `SIGKILL`ed control plane can leave its container behind.** `--rm` is a promise about the
  _client's_ lifetime, and the launcher's sweep runs in the process that just died. Closing that needs
  a `recover`-side sweep, which is **not built** (the engine finding is in
  `docs/planning/dark-factory-dsh/evidence/phase-15-round.md`).

## What "fixed" looks like

```bash
factory run U-…            # exits 0, attempt completes
node -e 'const r=require(process.argv[1]); console.log(r.container)' "$FACTORY_HOME/attempts/U-…/A-…/launch.json"
#   { image: 'factory-env:rc5', imageDigest: 'sha256:…', user: '10001:10001', network: 'none', … }
docker ps -aq --filter name=factory-worker-        # empty when the attempt is over
```

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
  expires. See [ambiguous-attempt.md](ambiguous-attempt.md).
- **Want the host back?** Unset `FACTORY_WORKER_ISOLATION`. That is a deliberate act; the factory will
  never do it for you on a failed probe.
