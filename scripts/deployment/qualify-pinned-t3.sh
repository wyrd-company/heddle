#!/usr/bin/env bash
# ---
# relationships:
#   verifies: heddle
#   references: t3-headless
# ---

set -euo pipefail

if [ -z "${HEDDLE_T3_INTEGRATION_BINARY:-}" ] || [ ! -x "${HEDDLE_T3_INTEGRATION_BINARY}" ]; then
    echo "HEDDLE_T3_INTEGRATION_BINARY must name an executable pinned T3 binary" >&2
    exit 1
fi

exec env -u FORCE_COLOR -u NO_COLOR \
    npx vitest run src/production/ src/control-plane/ --maxWorkers=1
