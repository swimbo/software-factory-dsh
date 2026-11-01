# The wall's isolation image.
#
# Deliberately minimal and entirely offline at build time: the base is pinned by digest
# and nothing is installed, so the image a verdict names cannot drift under a package
# registry's latest tag. A scenario needs a Node runtime, a shell and `/bin/sleep`; adding
# anything else to this layer widens the attack surface of the thing that is supposed to
# be measuring an adversary.
#
# The isolation itself is *not* in this file — it is in the flags the runner passes
# (`createContainerRunner`): `--network none`, `--read-only`, `--tmpfs /tmp`, `--user`,
# `--cap-drop ALL`, `--security-opt no-new-privileges`, `--memory`, `--pids-limit`. An
# image cannot grant itself isolation; it can only avoid needing exceptions to it.
FROM node:22-alpine@sha256:fe4f6d74e20370acb04ad889077d14d0f64a9c8ea6a42bc60cddf1e844699914

LABEL org.factory.layer="isolation" \
      org.factory.purpose="wall scenario execution: no network, read-only root, non-root" \
      org.factory.base="node:22-alpine@sha256:fe4f6d74e20370acb04ad889077d14d0f64a9c8ea6a42bc60cddf1e844699914"

# The runner overrides this with `--user <host uid>:<gid>`; the image sets it anyway so a
# bare `docker run` of this image is not root either.
USER 65532:65532

WORKDIR /workspace

# Nothing is copied in: the scenario driver lives outside the container (A4.4). The
# container receives argv and a mounted tree, never the expectations.
