# The wall's isolation image.
#
# Deliberately minimal and entirely offline at build time: the base is pinned by digest
# and nothing is installed, so the image a verdict names cannot drift under a package
# registry's latest tag. A scenario needs a Node runtime, a shell and `/bin/sleep`; adding
# anything else to this layer widens the attack surface of the thing that is supposed to
# be measuring an adversary.
#
# The base is the runtime `.nvmrc` pins (`26.12.1`), not merely a Node image: a container that
# ran a different Node than the host refuses would make "the scenario ran under the factory's
# runtime" a claim that reads well and means nothing. `node:26.12.1-alpine` is the exact patch
# release, so `docker run factory-env node -v` and `cat .nvmrc` are the same string.
#
# The isolation itself is *not* in this file — it is in the flags the runner passes
# (`createContainerRunner`): `--network none`, `--read-only`, `--tmpfs /tmp`, `--user`,
# `--cap-drop ALL`, `--security-opt no-new-privileges`, `--memory`, `--pids-limit`. An
# image cannot grant itself isolation; it can only avoid needing exceptions to it.
FROM node:26.12.1-alpine@sha256:40cd011b55415bc894e45b02fdd5a5dfde056921b7d23a64c74f80497af48797

LABEL org.factory.layer="isolation" \
      org.factory.purpose="wall scenario execution: no network, read-only root, non-root" \
      org.factory.runtime="node 26.12.1 (matches .nvmrc)" \
      org.factory.base="node:26.12.1-alpine@sha256:40cd011b55415bc894e45b02fdd5a5dfde056921b7d23a64c74f80497af48797"

# The runner overrides this with `--user <host uid>:<gid>`; the image sets it anyway so a
# bare `docker run` of this image is not root either.
USER 65532:65532

WORKDIR /workspace

# Nothing is copied in: the scenario driver lives outside the container (A4.4). The
# container receives argv and a mounted tree, never the expectations.
