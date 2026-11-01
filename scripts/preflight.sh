#!/usr/bin/env bash
# Preflight: fail closed on an unsupported runtime or a missing DSH binary.
# The operator's default `node` is 22.x; that is an error here, never a fallback.
set -euo pipefail

required_major_minor=(24 9)
max_major=27

node_version="$(node -v | sed 's/^v//')"
major="${node_version%%.*}"
rest="${node_version#*.}"
minor="${rest%%.*}"

if [ "$major" -lt "${required_major_minor[0]}" ] \
  || { [ "$major" -eq "${required_major_minor[0]}" ] && [ "$minor" -lt "${required_major_minor[1]}" ]; }; then
  echo "preflight: node $node_version is too old; need >=24.9 (DSH 0.2.2 floor, node:sqlite RC)" >&2
  echo "preflight: run 'nvm use' in this directory (.nvmrc pins 26.12.1)" >&2
  exit 8
fi
if [ "$major" -ge "$max_major" ]; then
  echo "preflight: node $node_version is outside the tested window (<27)" >&2
  exit 8
fi

dsh_bin="${FACTORY_DSH_BIN:-/Applications/DeepSeek Harness.app/Contents/Resources/runtime/cli/bin/dsh}"
if [ ! -x "$dsh_bin" ]; then
  echo "preflight: dsh binary not found or not executable: $dsh_bin" >&2
  echo "preflight: set FACTORY_DSH_BIN to the installed dsh" >&2
  exit 8
fi
echo "preflight: node $node_version ok"
echo "preflight: dsh $("$dsh_bin" --version 2>/dev/null || echo unknown) at $dsh_bin"
