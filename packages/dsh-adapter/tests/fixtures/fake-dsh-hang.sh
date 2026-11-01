#!/bin/sh
# A runaway attempt: it opens a session, leaves a grandchild behind, and never
# stops. The grandchild is the point — a kill of the parent alone leaves it
# running and it keeps holding the proxy connection.
# Answer the adapter's version probe first: the adapter refuses to dispatch to a
# dsh that is not the pinned build, and this fixture is not one.
set -eu
if [ "${1:-}" = "--version" ]; then
  printf '%s\n' "0.2.1-rc.3"
  exit 0
fi

printf '%s\n' '{"type":"session","sessionId":"sess-fixture-hang"}'
printf '%s\n' '{"type":"status","phase":"turn_start","turn":1}'

sh -c 'sleep 300' &
echo $! > "$FACTORY_FAKE_GRANDCHILD"

sleep 300
