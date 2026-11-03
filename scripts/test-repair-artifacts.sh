#!/usr/bin/env bash
#
# Build the *persistent* certification artefacts for the task class `test-repair`: a twenty-commit
# fixture repository (one small ES module with one genuine defect per commit, the test that fails
# because of it, and the expectation data that test reads), the bare mirror the wall clones, the
# two-rule holdout corpus (hidden behaviour + instrument untouched), twenty unit specs, and a
# planner that submits them.
#
#   bash scripts/test-repair-artifacts.sh [--root <dir>] [--revisions <n>] [--source <checkout>]
#
# `--root` defaults to `~/.factory/certification-test-repair`; `--source` defaults to the checkout
# this script lives in. It refuses a root inside the checkout (the holdout would be reachable by the
# worker), a non-empty directory that is not previous artefacts (it rebuilds by deleting), and it
# refuses to finish if a revision stops discriminating — a repair that fails its own visible test, a
# base revision that passes it, or a hidden probe that passes on the defect. The wall's
# discrimination criterion is `maxNonDiscriminating = 0`, so one such revision would make every
# attempt unmeasurable.
#
# It never calls a model, never reads a credential and never writes the store. The unit planner is
# *emitted* as `<root>/plan-units.sh`, not executed, because submitting a unit writes the ledger and
# building artefacts has to stay a free, repeatable operation.
#
set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
SOURCE_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
ARTEFACT_ROOT="${HOME}/.factory/certification-test-repair"
REVISIONS=""

usage() {
  echo "USAGE: bash scripts/test-repair-artifacts.sh [--root <dir>] [--revisions <n>] [--source <checkout>]" >&2
}

while [ "$#" -gt 0 ]; do
  case "$1" in
    --root)
      if [ "$#" -lt 2 ]; then
        usage
        exit 2
      fi
      ARTEFACT_ROOT="$2"
      shift 2
      ;;
    --root=*)
      ARTEFACT_ROOT="${1#*=}"
      shift
      ;;
    --revisions)
      if [ "$#" -lt 2 ]; then
        usage
        exit 2
      fi
      REVISIONS="$2"
      shift 2
      ;;
    --revisions=*)
      REVISIONS="${1#*=}"
      shift
      ;;
    --source)
      if [ "$#" -lt 2 ]; then
        usage
        exit 2
      fi
      SOURCE_ROOT="$2"
      shift 2
      ;;
    --source=*)
      SOURCE_ROOT="${1#*=}"
      shift
      ;;
    -h|--help)
      sed -n '3,/^set -uo pipefail$/p' "${BASH_SOURCE[0]}" | sed '$d' | sed 's/^# \{0,1\}//'
      exit 0
      ;;
    *)
      echo "test-repair-artifacts: unknown argument: $1 (see --help)" >&2
      exit 2
      ;;
  esac
done

if [ -z "${ARTEFACT_ROOT}" ]; then
  echo "test-repair-artifacts: --root must not be empty" >&2
  exit 2
fi
if [ -z "${REVISIONS}" ]; then
  REVISIONS=20
fi
case "${REVISIONS}" in
  ''|*[!0-9]*)
    echo "test-repair-artifacts: --revisions must be a positive integer, got ${REVISIONS}" >&2
    exit 2
    ;;
esac
if [ ! -d "${SOURCE_ROOT}" ]; then
  echo "test-repair-artifacts: --source ${SOURCE_ROOT} is not a directory" >&2
  exit 2
fi
if [ ! -f "${SOURCE_ROOT}/e2e/certification/test-repair-artifacts-main.ts" ]; then
  echo "test-repair-artifacts: ${SOURCE_ROOT} is not a DSH checkout (no e2e/certification/test-repair-artifacts-main.ts)" >&2
  exit 2
fi

NODE_BIN="$(command -v node || true)"
if [ -z "${NODE_BIN}" ]; then
  echo "test-repair-artifacts: node is not on PATH (pin it: export PATH=\"\$HOME/.nvm/versions/node/\$(cat .nvmrc)/bin:\$PATH\")" >&2
  exit 2
fi
if ! command -v git >/dev/null 2>&1; then
  echo "test-repair-artifacts: git is not on PATH" >&2
  exit 2
fi

CREATED_AT="$(date -u +%Y-%m-%dT%H:%M:%SZ)"

"${NODE_BIN}" "${SOURCE_ROOT}/e2e/certification/test-repair-artifacts-main.ts" \
  --root "${ARTEFACT_ROOT}" \
  --source "${SOURCE_ROOT}" \
  --revisions "${REVISIONS}" \
  --created-at "${CREATED_AT}"
