#!/bin/sh
# Reports the environment it was actually given, so a test can assert what did
# and did not cross into the worker process.
# Answer the adapter's version probe first: the adapter refuses to dispatch to a
# dsh that is not the pinned build, and this fixture is not one.
set -eu
if [ "${1:-}" = "--version" ]; then
  printf '%s\n' "0.2.1-rc.3"
  exit 0
fi

env > "$FACTORY_FAKE_ENV_OUT"

cat <<'EOF'
{"type":"session","sessionId":"sess-fixture-env"}
{"type":"turn_end","turn":1,"reason":{"kind":"completed"}}
{"type":"final","text":"environment reported"}
EOF
exit 0
