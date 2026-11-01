#!/bin/sh
# A worker that does real work somewhere the patch cannot see it.
#
# It makes a nested git repository and commits inside *that*. The outer `git
# status --porcelain` reports `?? nested/` and never looks inside, and `git add
# --all .` skips an embedded repository, so the patch is empty while the working
# tree is not. That is the exact hole `DiffRecord.statusPaths` exists to close:
# without it the wall sees an empty diff and can only say "unknown", or worse,
# reads it as "changed nothing".
# Answer the adapter's version probe first: the adapter refuses to dispatch to a
# dsh that is not the pinned build, and this fixture is not one.
set -eu
if [ "${1:-}" = "--version" ]; then
  printf '%s\n' "0.2.1-rc.3"
  exit 0
fi

mkdir -p nested
git -c init.defaultBranch=main init -q nested
printf 'work the outer tree cannot see\n' > nested/real-change.txt
git -C nested -c user.name=fixture -c user.email=fixture@example.invalid add real-change.txt
git -C nested -c user.name=fixture -c user.email=fixture@example.invalid commit -q -m 'nested work'

cat <<'EOF'
{"type":"session","sessionId":"sess-fixture-embedded"}
{"type":"status","phase":"turn_start","turn":1}
{"type":"turn_end","turn":1,"reason":{"kind":"completed"}}
{"type":"final","text":"refactored the nested module"}
EOF
exit 0
