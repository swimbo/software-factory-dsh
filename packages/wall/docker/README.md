# The wall's isolation image

`Dockerfile` builds the image the container runner launches. It is deliberately three
instructions long: `FROM` a digest-pinned base, a `LABEL`, and a `WORKDIR`. Nothing is
installed and nothing is copied in.

## Why so little

The isolation is not in this file — an image cannot grant itself isolation, it can only
avoid needing exceptions to it. The properties are flags the runner passes, and each one is
asserted by a spec that reads its effect back from inside the container
(`e2e/cli/docker/07-isolation.test.ts`):

| Flag                                  | Asserted by                                                                                            |
| ------------------------------------- | ------------------------------------------------------------------------------------------------------ |
| `--network none`                      | E2E-43: `1.1.1.1:443` refused with `ENETUNREACH`, container sees only `lo`                             |
| `--read-only`                         | E2E-44: `/pwned` is `EROFS` while `/workspace` and `/tmp` still accept writes                          |
| `--user <uid>:<gid>`                  | E2E-44: `process.getuid() !== 0`, `/root` is `EACCES`                                                  |
| `--memory`, `--pids-limit`            | E2E-46: `/sys/fs/cgroup/memory.max` and `pids.max` equal the flags, and a 400-fork storm hits `EAGAIN` |
| `--cap-drop ALL`, `no-new-privileges` | structural, `packages/wall/src/container.test.ts`                                                      |
| `--cidfile` + `docker kill`           | the timeout spec: no container from the suite outlives its run                                         |

## Building it

```bash
docker build --platform linux/amd64 --tag factory-env:e2e packages/wall/docker
docker image inspect --format '{{.Id}}' factory-env:e2e     # sha256:<64 hex>
```

The e2e suite builds it on demand when absent, and skips (with the reason in the suite name)
when docker or the base image is unavailable.

## Pinning, offline

The base is pinned by registry manifest digest in the `FROM` line, so a rebuild of this image
cannot silently move to a different Node.

The image _this_ Dockerfile produces is a local build, and a local build has no registry
manifest — `docker run factory-env:e2e@sha256:<id>` fails, because digest references resolve
through a registry. The honest offline pin is therefore the **content id**
(`docker image inspect -f '{{.Id}}'`) recorded by the caller and re-checked by
`imageContentId()` / `imageIdMatches()` before a run. A tag is mutable; a content id is not,
and the suite asserts the tag still resolves to the id it measured.

## Platform note

On arm64 hosts the base is `linux/amd64`, so the container runs under emulation. That works
(the suite passes in ~6s) and the cgroup and network assertions are unaffected, but it is
emulation: a scenario's timing under it is not a benchmark.
