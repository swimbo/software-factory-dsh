#!/bin/sh
# A worker that writes to a path its own repository ignores.
#
# `git status --porcelain` reports `!! ignored.txt` only with `--ignored=matching`,
# and `git ls-files --others --ignored --exclude-standard` is the other half of
# the pair. Both are needed for the adapter to see this at all: the diff cannot
# show it (the file is not in the tree) and the untracked list hides it. This is
# the shape of a worker writing a `.env` or a proxy token somewhere it thinks
# nobody is looking.
# Answer the adapter's version probe first: the adapter refuses to dispatch to a
# dsh that is not the pinned build, and this fixture is not one.
set -eu
if [ "${1:-}" = "--version" ]; then
  printf '%s\n' "0.2.1-rc.3"
  exit 0
fi

printf 'PROXY_TOKEN=not-a-real-token\n' > ignored.txt

cat <<'EOF'
{"type":"session","sessionId":"sess-fixture-ignored"}
{"type":"status","phase":"turn_start","turn":1}
{"type":"turn_end","turn":1,"reason":{"kind":"completed"}}
{"type":"final","text":"wrote a scratch file"}
EOF
exit 0
