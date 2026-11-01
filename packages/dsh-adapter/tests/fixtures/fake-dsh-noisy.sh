#!/bin/sh
# Output that never ends: the projection stream grows without bound, which is
# what the output-bytes ceiling exists for.
# Answer the adapter's version probe first: the adapter refuses to dispatch to a
# dsh that is not the pinned build, and this fixture is not one.
set -eu
if [ "${1:-}" = "--version" ]; then
  printf '%s\n' "0.2.1-rc.5"
  exit 0
fi

printf '%s\n' '{"type":"session","sessionId":"sess-fixture-noisy"}'
i=0
while [ "$i" -lt 100000 ]; do
  printf '{"type":"text","text":"%s"}\n' 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'
  i=$((i + 1))
done
