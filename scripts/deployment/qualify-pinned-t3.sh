#!/usr/bin/env bash
# ---
# relationships:
#   verifies: heddle
#   references: t3-headless
# ---

set -euo pipefail

repository="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
qualification_scratch=""

cleanup() {
    local status=$?
    trap - EXIT
    if [ -n "${qualification_scratch}" ] && ! find "${qualification_scratch}" -depth -delete; then
        status=1
    fi
    exit "${status}"
}

trap cleanup EXIT
trap 'exit 129' HUP
trap 'exit 130' INT
trap 'exit 143' TERM

if [ -z "${HEDDLE_T3_INTEGRATION_BINARY:-}" ]; then
    qualification_scratch="$(mktemp -d "${TMPDIR:-/tmp}/heddle-pinned-t3.XXXXXX")"
    npm install --global --no-audit --no-fund \
        --prefix "${qualification_scratch}/t3" \
        "$(jq -er '.t3PackageSource' "${repository}/deployment/supported-versions.json")"
    HEDDLE_T3_INTEGRATION_BINARY="${qualification_scratch}/t3/bin/t3"
    export HEDDLE_T3_INTEGRATION_BINARY
fi

if [ ! -x "${HEDDLE_T3_INTEGRATION_BINARY}" ]; then
    echo "HEDDLE_T3_INTEGRATION_BINARY must name an executable pinned T3 binary" >&2
    exit 1
fi

cd "${repository}"
env -u FORCE_COLOR -u NO_COLOR \
    npx vitest run src/production/ src/control-plane/ --maxWorkers=1
