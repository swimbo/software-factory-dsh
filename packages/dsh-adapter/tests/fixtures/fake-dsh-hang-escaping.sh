#!/bin/sh
# A runaway attempt whose leftovers *escape the kill*.
#
# `fake-dsh-hang.sh` leaves a grandchild in the same process group, so the adapter's group kill reaps
# it and `close` arrives immediately. This fixture is the other case, and the one that actually
# happened: the grandchild is put in its own session (`detached: true` in node is `setsid`), inherits
# this process's stdout, and therefore keeps the pipe open after the group kill takes this process and
# everything still in its group. The adapter then gets no `close` event at all — it used to wait
# forever, which is how one live attempt burned 2 h 23 min after its ceiling had already tripped.
#
# Answer the adapter's version probe first, or the adapter refuses to dispatch.
set -eu
if [ "${1:-}" = "--version" ]; then
  printf '%s\n' "0.2.1-rc.5"
  exit 0
fi

printf '%s\n' '{"type":"session","sessionId":"sess-fixture-escaping"}'
printf '%s\n' '{"type":"status","phase":"turn_start","turn":1}'

# The escapee: own session, inherited stdout, long enough to outlive the test either way.
node -e '
const { spawn } = require("node:child_process");
const child = spawn("sleep", ["120"], { detached: true, stdio: ["ignore", "inherit", "inherit"] });
process.stdout.write(String(child.pid) + "\n");
child.unref();
' > "$FACTORY_FAKE_ESCAPEE"

sleep 300
