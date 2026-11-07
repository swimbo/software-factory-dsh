#!/usr/bin/env bash
# Offline soak — thin wrapper. Every decision lives in scripts/soak-entry.ts.
#
#   scripts/soak.sh                     # the soak: 50 units, fixed seed
#   scripts/soak.sh --units 5 --seed 1  # the CI shape, well under a minute
#
# Writes only a mkdtemp FACTORY_HOME (printed in the header) and
# e2e/soak/artifacts/soak-<seed>-<units>.{json,txt}. It never touches ~/.factory.
set -euo pipefail
export PATH="$HOME/.nvm/versions/node/v$(cat "$(dirname "$0")/../.nvmrc")/bin:$PATH"
exec node "$(dirname "$0")/soak-entry.ts" "$@"
