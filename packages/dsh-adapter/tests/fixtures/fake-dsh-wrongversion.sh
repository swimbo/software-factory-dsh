#!/bin/sh
# A dsh that is not the pinned build. The adapter must refuse to dispatch at all:
# a run against an unverified harness produces a receipt nobody can trust.
set -eu

if [ "${1:-}" = "--version" ]; then
  printf '%s\n' '0.2.1-rc.4'
  exit 0
fi

# The canary: if the adapter dispatched anyway, this file appears.
: > "$FACTORY_FAKE_DISPATCHED"
cat <<'EOF'
{"type":"session","sessionId":"sess-fixture-wrongversion"}
{"type":"turn_end","turn":1,"reason":{"kind":"completed"}}
{"type":"final","text":"should never run"}
EOF
exit 0
