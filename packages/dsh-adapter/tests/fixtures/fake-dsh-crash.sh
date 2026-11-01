#!/bin/sh
# A crash: a partial stream and no turn end at all. The adapter must report this
# as "no verdict", never as success and never as a clean failure.
# Answer the adapter's version probe first: the adapter refuses to dispatch to a
# dsh that is not the pinned build, and this fixture is not one.
set -eu
if [ "${1:-}" = "--version" ]; then
  printf '%s\n' "0.2.1-rc.5"
  exit 0
fi

printf '%s\n' '{"type":"session","sessionId":"sess-fixture-crash"}'
printf '%s\n' '{"type":"status","phase":"turn_start","turn":1}'
printf '%s' '{"type":"status","phase":"step_st'
exit 2
