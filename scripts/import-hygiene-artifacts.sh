#!/usr/bin/env bash
#
# Build the *persistent* certification artefacts for the task class `import-hygiene`: a twenty-commit
# source repository, the bare mirror the wall clones, the four-rule holdout corpus, twenty unit specs,
# and a planner that submits them.
#
#   bash scripts/import-hygiene-artifacts.sh [--root <dir>] [--revisions <n>] [--source <checkout>]
#
# `--root` defaults to `~/.factory/certification-import`; `--source` defaults to the checkout this
# script lives in. It refuses a root inside the checkout (the holdout would be reachable by the
# worker), a non-empty directory that is not previous artefacts (it rebuilds by deleting), and it
# refuses to finish if a single planted base revision stops breaking all four class rules — a corpus
# that passes a defective tree certifies nothing.
#
# It never calls a model, never reads a credential and never writes the store. The unit planner is
# *emitted* as `<root>/plan-units.sh`, not executed, because submitting a unit writes the ledger and
# building artefacts has to stay a free, repeatable operation.
#
set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
SOURCE_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
ARTEFACT_ROOT="${HOME}/.factory/certification-import"
REVISIONS=""

usage() {
  echo "USAGE: bash scripts/import-hygiene-artifacts.sh [--root <dir>] [--revisions <n>] [--source <checkout>]" >&2
}

while [ "$#" -gt 0 ]; do
  case "$1" in
    --root) [ "$#" -ge 2 ] || { usage; exit 2; }; ARTEFACT_ROOT="$2"; shift 2 ;;
    --root=*) ARTEFACT_ROOT="${1#*=}"; shift ;;
    --revisions) [ "$#" -ge 2 ] || { usage; exit 2; }; REVISIONS="$2"; shift 2 ;;
    --revisions=*) REVISIONS="${1#*=}"; shift ;;
    --source) [ "$#" -ge 2 ] || { usage; exit 2; }; SOURCE_ROOT="$2"; shift 2 ;;
    --source=*) SOURCE_ROOT="${1#*=}"; shift ;;
    -h|--help)
      sed -n '3,/^set -uo pipefail$/p' "${BASH_SOURCE[0]}" | sed '$d' | sed 's/^# \{0,1\}//'
      exit 0
      ;;
    *) echo "import-hygiene-artifacts: unknown argument: $1 (see --help)" >&2; exit 2 ;;
  esac
done

[ -n "${ARTEFACT_ROOT}" ] || { echo "import-hygiene-artifacts: --root must not be empty" >&2; exit 2; }
if [ -z "${REVISIONS}" ]; then REVISIONS=20; fi
case "${REVISIONS}" in
  ''|*[!0-9]*) echo "import-hygiene-artifacts: --revisions must be a positive integer, got ${REVISIONS}" >&2; exit 2 ;;
esac
[ -d "${SOURCE_ROOT}" ] || { echo "import-hygiene-artifacts: --source ${SOURCE_ROOT} is not a directory" >&2; exit 2; }
[ -f "${SOURCE_ROOT}/e2e/certification/import-artifacts.ts" ] ||
  { echo "import-hygiene-artifacts: ${SOURCE_ROOT} is not a DSH checkout (no e2e/certification/import-artifacts.ts)" >&2; exit 2; }

NODE_BIN="$(command -v node || true)"
[ -n "${NODE_BIN}" ] ||
  { echo "import-hygiene-artifacts: node is not on PATH (pin it: export PATH=\"\$HOME/.nvm/versions/node/\$(cat .nvmrc)/bin:\$PATH\")" >&2; exit 2; }
command -v git >/dev/null 2>&1 || { echo "import-hygiene-artifacts: git is not on PATH" >&2; exit 2; }

"${NODE_BIN}" "${SOURCE_ROOT}/e2e/certification/import-artifacts-main.ts" \
  --root "${ARTEFACT_ROOT}" \
  --source "${SOURCE_ROOT}" \
  --revisions "${REVISIONS}" \
  --created-at "$(date -u +%Y-%m-%dT%H:%M:%SZ)"
