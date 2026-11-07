#!/usr/bin/env bash
# provision-topology.sh — provision, or report, the topology the wall runs under.
#
# The decision (findings.md § DECIDED 2026-11-01, ND2): on the Linux target the wall is a
# separate *principal* — `factory-wall` owns the verdict store, the holdout corpus and the
# operator key (`0750`, group `factory-wall`) and the worker runs as `factory-worker`. On a host
# with no second uid the same factory runs single-uid, and the claim it may make is "the wall is
# a separate process, not a separate principal". `factory status` prints whichever one this
# process actually found, so the two cannot drift.
#
# This wrapper is thin on purpose. Every decision — which topology this platform can honour, the
# modes, the exact `groupadd`/`useradd` lines, and the verification that the modes were really
# applied — lives in `packages/store/src/topology.ts`, which is also what the status page reads.
# A shell `if uname` would be a second implementation of the same decision, sitting on a host
# that cannot test the other branch.
#
# It never creates a system account. Missing accounts are a refusal with the commands printed and
# exit 8 (the environment class); provisioning a factory must not mint users on a typo.
#
# Usage:
#   scripts/provision-topology.sh [--root DIR] [--corpus DIR] [--apply] [--json]
#
#   --root DIR     FACTORY_HOME to provision (default: $FACTORY_HOME or ~/.factory)
#   --corpus DIR   holdout corpus root (default: $FACTORY_HOLDOUT_ROOT or ~/.factory/holdout)
#   --apply        execute the planned install/chown/chmod lines and write the marker
#   --json         machine-readable report (for a runbook or a pipeline)
#
# Exit codes: 0 the topology is what this host can honour; 8 the environment cannot support the
# two-uid layout (missing accounts, a failed apply, or a mode that did not verify); 2 usage.

set -euo pipefail

readonly HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
readonly ENTRY="$HERE/topology-entry.ts"

if ! command -v node >/dev/null 2>&1; then
  printf '%s\n' \
    'provision-topology: error: node is not on PATH' \
    '  This script runs the TypeScript decision the factory itself uses, so it needs node' \
    '  (the repository pins one in .nvmrc). Run it from a shell with the pin:' \
    '    export PATH="$HOME/.nvm/versions/node/$(cat .nvmrc)/bin:$PATH"' >&2
  exit 8
fi

if [ ! -f "$ENTRY" ]; then
  printf 'provision-topology: error: %s is missing\n' "$ENTRY" >&2
  exit 8
fi

exec node "$ENTRY" "$@"
