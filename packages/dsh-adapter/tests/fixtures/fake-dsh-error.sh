#!/bin/sh
# A failed turn: `turn_end` carries an error reason and DSH still writes a
# terminal `final` with empty text. Any adapter that reads "we saw a final" as
# success reports this as a completed attempt.
# Answer the adapter's version probe first: the adapter refuses to dispatch to a
# dsh that is not the pinned build, and this fixture is not one.
set -eu
if [ "${1:-}" = "--version" ]; then
  printf '%s\n' "0.2.1-rc.3"
  exit 0
fi

cat <<'EOF'
{"type":"session","sessionId":"sess-fixture-error"}
{"type":"status","phase":"turn_start","turn":1}
{"type":"status","phase":"step_start","turn":1,"step":1}
{"type":"turn_end","turn":1,"reason":{"kind":"error","error":{"message":"upstream refused the request","code":"PROVIDER_ERROR"}}}
{"type":"final","text":""}
EOF
printf 'dsh: PROVIDER_ERROR: upstream refused the request\n' >&2
exit 1
