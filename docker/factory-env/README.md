# factory-env — the image a worker _would_ run in

`Dockerfile` is the worker-attempt image: `node:26.12.1-bookworm-slim` (the runtime `.nvmrc`
pins), `git`/`tini`/`procps`, the published CLI at `@deepseek-ai/dsh@0.2.1-rc.5` — the same
version as `PINNED_DSH_VERSION` in `packages/dsh-adapter/src/executor.ts` — and a frozen
`factory-worker` profile seeded at `/dsh-home`, which Docker copies into the per-attempt volume
the first time it is mounted.

**It builds, and that is all it does.** Nothing in this tree dispatches into it:

- `apps/cli/src/wall.ts` wires `createLocalRunner` for the wall's scenario execution;
- `packages/dsh-adapter/src/executor.ts` launches `dsh` as a host process, with no container branch;
- the only container code that ships is `packages/wall/src/container.ts`, which runs _scenarios_,
  not workers, against `packages/wall/docker/` (a different, much smaller image).

So `E2E-45`'s "kill the worker container mid-attempt" has no container to kill. That is
**unimplemented**, not merely unverified, and it is why the id stays `UNKNOWN` in
`docs/planning/dark-factory-dsh/e2e-tests.md` while the isolation contract of the _wall's_ image
is measured by `e2e/cli/docker/07-isolation.test.ts`.

## Build and check it

```bash
docker build --tag factory-env:rc5 docker/factory-env          # ~2 min: apt, then 616 npm packages
docker run --rm --entrypoint /bin/sh factory-env:rc5 -c \
  'node -v && dsh --version && id && ls /dsh-home/profiles/factory-worker'
# v26.12.1
# 0.2.1-rc.5
# uid=10001(factory) gid=10001(factory)
# cordis.patch.yml cordis.yml package.json pnpm-workspace.yaml
docker run --rm factory-env:rc5 --version                      # the ENTRYPOINT is `tini -- dsh`
```

The `--entrypoint /bin/sh` override is not a trick: the image's entrypoint _is_ `dsh`, so
`docker run factory-env:rc5 node -v` is parsed as `dsh node -v` and errors with
`profile "node" does not exist`. Use the override for inspection.

## The audit's blocker, re-measured 2026-11-01

The phase-13 audit recorded that `docker build` "stalls pulling the pinned
`node:22.19-bookworm-slim` digest" on this host. That is not reproducible now: the digest
(`sha256:4a4884e8…`) resolves and its five layers download and verify, and the build above
completes in about two minutes. The base has been moved to `node:26.12.1-bookworm-slim` anyway,
because the old pin disagreed with `.nvmrc` (and with `PINNED_DSH_VERSION` in the same way:
`0.2.1-rc.3` while the adapter refuses anything but `0.2.1-rc.5`).

A cached `docker pull` of either base makes the _first_ build look hung: buildkit prints nothing
while it pulls, so the audit's "stall" was most likely a cold pull with no progress output. If a
build appears stuck, `docker pull <base>@<digest>` first and watch it finish.
