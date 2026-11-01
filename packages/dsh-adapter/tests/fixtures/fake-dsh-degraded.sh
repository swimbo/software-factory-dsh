#!/bin/sh
# A degraded profile: the overlay composed, but one entry did not activate, so
# the permission service is running on defaults. DSH warns on stderr and carries
# on with exit 0 — the dangerous shape, because the run looks healthy.
# Answer the adapter's version probe first: the adapter refuses to dispatch to a
# dsh that is not the pinned build, and this fixture is not one.
set -eu
if [ "${1:-}" = "--version" ]; then
  printf '%s\n' "0.2.1-rc.3"
  exit 0
fi

printf '%s\n' 'dsh: warning: 1 entry did not activate' >&2
cat <<'EOF'
{"type":"session","sessionId":"sess-fixture-degraded"}
{"type":"turn_end","turn":1,"reason":{"kind":"completed"}}
{"type":"final","text":"done, allegedly"}
EOF
exit 0
