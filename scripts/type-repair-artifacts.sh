#!/usr/bin/env bash
#
# Build the *persistent* certification artefacts for the task class `type-repair`: a twenty-commit
# fixture repository (one small TypeScript module per commit that fails `tsc --noEmit` under `strict`
# while its runtime behaviour is correct and its own test suite passes), the bare mirror the wall
# clones, the three-rule holdout corpus (differential behaviour against the shipped repair, an
# AST-level scan for escape hatches, and the export surface), twenty unit specs, and a planner that
# submits them.
#
#   bash scripts/type-repair-artifacts.sh [--root <dir>] [--revisions <n>] [--source <checkout>]
#
# `--root` defaults to `~/.factory/certification-type-repair`; `--source` defaults to the checkout
# this script lives in. It refuses a root inside the checkout (the holdout would be reachable by the
# worker), and a non-empty directory that is not previous artefacts (it rebuilds by deleting).
#
# Before writing anything it refuses to finish if a revision stops discriminating: a revision whose
# strict check is already clean (nothing to repair), a revision that fails at runtime (the class would
# be a behaviour class, not a type class), or a shipped repair that trips one of the corpus rules (the
# reference would be refused by its own corpus).
#
# It never calls a model, never reads a credential and never writes the store. The unit planner is
# *emitted* as `<root>/plan-units.sh`, not executed, because submitting a unit writes the ledger and
# building artefacts has to stay a free, repeatable operation.
#
# The corpus id is content-addressed, not timestamped: `h-type-repair-real-<date>-<8 hex>`, where the
# suffix is a digest of every rule, the visible check, the repaired reference and base commit the wall
# reads (`corpusRevisionId` in e2e/certification/type-repair.ts). `--created-at` is recorded in the
# marker and the README, and it does not name the corpus. A rebuild that changes any of that evidence
# mints a new id, so the previous certificate goes stale by itself instead of reading `current` while
# naming a corpus it was never measured against.
#
set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
SOURCE_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
ARTEFACT_ROOT="${HOME}/.factory/certification-type-repair"
REVISIONS=""

usage() {
  echo "USAGE: bash scripts/type-repair-artifacts.sh [--root <dir>] [--revisions <n>] [--source <checkout>]" >&2
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
      echo "type-repair-artifacts: unknown argument: $1 (see --help)" >&2
      exit 2
      ;;
  esac
done

if [ -z "${ARTEFACT_ROOT}" ]; then
  echo "type-repair-artifacts: --root must not be empty" >&2
  exit 2
fi
if [ -z "${REVISIONS}" ]; then
  REVISIONS=20
fi
case "${REVISIONS}" in
  ''|*[!0-9]*)
    echo "type-repair-artifacts: --revisions must be a positive integer, got ${REVISIONS}" >&2
    exit 2
    ;;
esac
if [ ! -d "${SOURCE_ROOT}" ]; then
  echo "type-repair-artifacts: --source ${SOURCE_ROOT} is not a directory" >&2
  exit 2
fi
if [ ! -f "${SOURCE_ROOT}/e2e/certification/type-repair-artifacts-main.ts" ]; then
  echo "type-repair-artifacts: ${SOURCE_ROOT} is not a DSH checkout (no e2e/certification/type-repair-artifacts-main.ts)" >&2
  exit 2
fi

NODE_BIN="$(command -v node || true)"
if [ -z "${NODE_BIN}" ]; then
  echo "type-repair-artifacts: node is not on PATH (pin it: export PATH=\"\$HOME/.nvm/versions/node/\$(cat .nvmrc)/bin:\$PATH\")" >&2
  exit 2
fi
if ! command -v git >/dev/null 2>&1; then
  echo "type-repair-artifacts: git is not on PATH" >&2
  exit 2
fi

CREATED_AT="$(date -u +%Y-%m-%dT%H:%M:%SZ)"

"${NODE_BIN}" "${SOURCE_ROOT}/e2e/certification/type-repair-artifacts-main.ts" \
  --root "${ARTEFACT_ROOT}" \
  --source "${SOURCE_ROOT}" \
  --revisions "${REVISIONS}" \
  --created-at "${CREATED_AT}"
