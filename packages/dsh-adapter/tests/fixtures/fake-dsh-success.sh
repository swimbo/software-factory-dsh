#!/bin/sh
# A successful headless run: a completed turn end, evidence of a tool call, and a
# real edit in the worktree — one modification, committed, plus one new file left
# untracked. The pair matters: a plain `git diff` would miss the new file, so the
# receipt's diff is only correct if the adapter folds untracked files in.
# Answer the adapter's version probe first: the adapter refuses to dispatch to a
# dsh that is not the pinned build, and this fixture is not one.
set -eu
if [ "${1:-}" = "--version" ]; then
  printf '%s\n' "0.2.1-rc.5"
  exit 0
fi

cat <<'EOF'
{"type":"session","sessionId":"sess-fixture-success","cwd":".","provider":"bifrost","model":"factory-worker-tier"}
{"type":"status","phase":"turn_start","turn":1}
{"type":"status","phase":"step_start","turn":1,"step":1}
{"type":"thinking","text":"considering"}
{"type":"text","text":"editing the file"}
{"type":"tool_call","callId":"c1","tool":"bash","input":{"command":"printf appended"}}
{"type":"tool_result","callId":"c1","tool":"bash","status":"ok","content":[{"type":"text","text":"appended"}]}
{"type":"status","phase":"step_end","turn":1,"step":1}
{"type":"turn_end","turn":1,"reason":{"kind":"completed"}}
{"type":"final","text":"Implemented the unit."}
EOF

# The real DSH writes its session log under $DSH_HOME, keyed by a slug of the
# process cwd: sessions/<cwd-slug>/<sessionId>/session.v4.jsonl.zstd, plus a plain
# JSON projection under storages/. Reproduce that shape (uncompressed: the adapter
# must not care) so the read-out-then-destroy path is exercised for real.
slug=$(pwd | tr '/' '-' | sed 's/^-/--/; s/-$/-/')
mkdir -p "$DSH_HOME/sessions/${slug}/sess-fixture-success"
printf '%s\n' '{"type":"usage","session":"sess-fixture-success","tokens":1234}' \
  > "$DSH_HOME/sessions/${slug}/sess-fixture-success/session.v4.jsonl"
mkdir -p "$DSH_HOME/storages/session_projcache/sessions"
printf '%s\n' '{"session":"sess-fixture-success","usage":{"total":1234}}' \
  > "$DSH_HOME/storages/session_projcache/sessions/sess-fixture-success.json"

printf 'appended by the fixture\n' >> README.md
git add README.md
git -c user.name=fixture -c user.email=fixture@example.invalid commit -q -m 'fixture change'
printf 'brand new file\n' > NEW.md
exit 0
