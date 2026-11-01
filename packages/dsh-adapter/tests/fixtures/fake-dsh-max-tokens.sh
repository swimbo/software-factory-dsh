#!/bin/sh
# The context ceiling was hit: not an error object, but definitely not success.
# Answer the adapter's version probe first: the adapter refuses to dispatch to a
# dsh that is not the pinned build, and this fixture is not one.
set -eu
if [ "${1:-}" = "--version" ]; then
  printf '%s\n' "0.2.1-rc.5"
  exit 0
fi

cat <<'EOF'
{"type":"session","sessionId":"sess-fixture-max-tokens"}
{"type":"turn_end","turn":2,"reason":{"kind":"max-tokens"}}
{"type":"final","text":"I was part way through"}
EOF
exit 1
