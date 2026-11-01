# factory-env — the only image a worker attempt ever runs in.
#
# Design rule: this image is not a sandbox and must not be described as one. DSH's
# own `workspace-write` sandbox is a guardrail against agent mistakes, not a
# security boundary (`findings.md` D3/D12). The boundary is the container, and it
# is only a boundary if the flags below are supplied by the runner — a Dockerfile
# cannot enforce `--network`, `--read-only` or `--pids-limit` on itself. Those
# flags are listed under "Required run invocation" and are part of this file's
# contract; `container.ts` is the only thing allowed to invoke the image.
#
# Everything is pinned. A worker receipt records the image digest so a re-run is
# reproducible; a floating tag would make every receipt a claim about "whatever
# was current".
#
#   docker build -t factory-env:0.2.1-rc.5 docker/factory-env
#
# The base digest is the multi-arch index as published by Docker Hub; pinning the index
# keeps one Dockerfile valid on amd64 and arm64. The tag is the exact runtime `.nvmrc`
# pins (26.12.1), not merely "some Node 26": an image that ran a different Node than the
# host refuses would make "the worker ran under the factory's runtime" a claim about a
# string in a file rather than about the process.

FROM node:26.12.1-bookworm-slim@sha256:88e480776c6149ff1d098cd304f44bf18057fb5d284a3329b78162d29821e28c

# The single source of truth for the harness build. Keep in sync with
# `PINNED_DSH_VERSION` in packages/dsh-adapter/src/executor.ts — a mismatch is a
# build failure here and a `DSH_VERSION_MISMATCH` refusal at run time.
ARG DSH_VERSION=0.2.1-rc.5

SHELL ["/bin/sh", "-ec"]

RUN apt-get update \
 && apt-get install --yes --no-install-recommends \
      ca-certificates \
      git \
      tini \
      procps \
 && rm -rf /var/lib/apt/lists/*

# The published CLI is `@deepseek-ai/dsh` (bin: `dsh`). `--ignore-scripts` keeps a
# dependency's postinstall from running arbitrary code as root at build time.
RUN npm install --global --ignore-scripts "@deepseek-ai/dsh@${DSH_VERSION}" \
 && npm cache clean --force \
 && rm -rf /root/.npm \
 && test "$(dsh --version)" = "${DSH_VERSION}"

# A fixed non-root identity, so a receipt can name the uid the diff was produced
# under and a mount can be owned predictably.
RUN groupadd --gid 10001 factory \
 && useradd --uid 10001 --gid 10001 --create-home --shell /usr/sbin/nologin factory

# One ENV per line, each with the reason above it: a comment inside a line
# continuation is not reliably stripped and would silently become part of the
# value.
ENV HOME=/home/factory
ENV NODE_ENV=production

# No shell history, ever. An agent's `bash` tool must not leave a record of what
# it ran: that record would be a second, unverified account of the attempt
# competing with the receipt.
ENV HISTFILE=/dev/null
ENV HISTSIZE=0
ENV HISTFILESIZE=0

# No system git config and no global identity inherited from the host. Identity is
# the attempt clone's own repo config, written by whoever created the clone.
ENV GIT_CONFIG_NOSYSTEM=1

# Product telemetry posts to an external collector. A worker may talk to the
# credential proxy and nothing else.
ENV DSH_TELEMETRY_DISABLED=1

# The harness home is this container's own path. At run time it is a **named
# volume**, one per attempt (amendment A3.4): mounted at this path, seeded from
# the image content below, read out by the adapter after receipt capture, then
# destroyed. A path inside the *attempt* directory would be visible in the patch;
# a path under the operator's `~/.factory` would put the holdout one `..` away.
ENV DSH_HOME=/dsh-home

# The harness profile, frozen at build time.
#
# `--from-default-profile headless` materialises a copy of the shipped headless
# profile under $DSH_HOME/profiles, so a later DSH release cannot silently change
# how a worker runs. It is paired with `--dump-config` because the same flag also
# *boots* the app, and a headless boot with no task exits 1 — the build must fail
# on a broken profile, not on a missing prompt.
#
# This layer is also the volume seed: Docker copies the image's content at a
# volume's mount point into the volume the first time it is mounted. That is the
# "seeded read-only from a template" half of A3.4 — the image layer is immutable,
# the volume is the attempt's own copy, and no attempt's session log ever becomes
# another attempt's starting state.
RUN install -d -o factory -g factory -m 0755 /dsh-home \
 && DSH_HOME=/dsh-home dsh --profile factory-worker \
      --from-default-profile headless --dump-config > /dev/null \
 && test -f /dsh-home/profiles/factory-worker/package.json \
 && chown -R factory:factory /dsh-home

# No WORKDIR on purpose: the attempt directory is bind-mounted at its **identical
# absolute path** (A3.2), and the runner passes `-w <attemptDir>`. A fixed
# `WORKDIR /work` would put the process somewhere the host never describes, and
# DSH keys its session log by cwd — the same cwd on both sides is what makes
# `--session-id` adoption work after a control-plane restart.
USER 10001:10001

# `tini` is PID 1 so that signals reach dsh and orphaned grandchildren are reaped.
# Without it a killed container can leave a tree of `sleep`-like children behind —
# the 2.88M-token incident shape the adapter's process-group kill exists for.
ENTRYPOINT ["/usr/bin/tini", "--", "dsh"]
CMD ["--version"]

# ---------------------------------------------------------------------------
# Required run invocation
#
# The runner (`container.ts`) must supply every flag below. Anything omitted is a
# missing boundary, not a tuning knob.
#
#   docker network create --internal factory-egress-<attemptId>
#   docker run --rm --name factory-worker-<attemptId> \
#     --network factory-egress-<attemptId> \
#     --read-only --tmpfs /tmp:rw,noexec,nosuid,size=256m \
#     --mount type=volume,src=factory-home-<unitId>-<attemptNo>,dst=/dsh-home \
#     --mount type=bind,src=<attemptDir>,dst=<attemptDir> \
#     -w <attemptDir> \
#     --cap-drop=ALL --security-opt=no-new-privileges \
#     --pids-limit=512 --memory=4g --memory-swap=4g --cpus=2 \
#     factory-env@sha256:<digest> \
#     --profile factory-worker --patch /dsh-home/factory-overlay.yml --json "<task>"
#
# Egress is a topology, not an intention (A3.3). A container on the default bridge
# reaches the whole internet and the operator's loopback — verified on this host
# against `host.docker.internal:65107`, the DSH GUI. So:
#
#   * the attempt's network is `--internal`, and has **exactly two members**: the
#     worker and the credential proxy, addressed by container name;
#   * the proxy is dual-homed (internal + egress) and is the only member with a
#     route off the segment;
#   * `host.docker.internal`, DNS, public IPv4 and IPv6 literals and
#     `169.254.169.254` are all unreachable from the worker, and
#     `packages/dsh-adapter/tests/egress.test.ts` asserts each one is closed.
#
# Two mounts, both deliberate:
#
#   * `<attemptDir>` — a self-contained `git clone` with `.git` as a *directory*,
#     mounted at the same absolute path on both sides (A3.2). A linked worktree
#     would put a `.git` file with a host path in here and git would resolve
#     nothing inside the container.
#   * `factory-home-<unitId>-<attemptNo>` — a per-attempt **named volume**, not a
#     bind mount (A3.4). A shared home lets attempt N configure attempt N+1
#     through `$DSH_HOME/cordis.patch.yml`, which composes into every profile;
#     a bind mount of the parent would put `~/.factory/holdout/` one `..` from a
#     path the worker can reach. Nothing under `~/.factory` is mounted.
#
# The overlay is delivered at `/dsh-home/factory-overlay.yml` — inside the
# attempt's own volume, so it is readable by dsh, invisible to the patch, and
# reachable without a third mount.
#
# No `-e BIFROST_API_KEY`: the proxy injects the real header, so the worker has no
# credential to leak. No `$HOME` mount and no operator `DSH_HOME` mount.
#
# One seam this file cannot close: the host-mode adapter builds the child
# environment from an allowlist (`PATH`, `DSH_*`, `FACTORY_*`). In container mode
# the image ENV is authoritative instead, and `buildChildEnv`'s `dshHome` argument
# is passed as the **container** path (`/dsh-home`), never the host path. That is
# the one thing `container.ts` must decide.
# ---------------------------------------------------------------------------
