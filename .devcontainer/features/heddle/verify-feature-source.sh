#!/usr/bin/env bash

set -euo pipefail

# ---
# relationships:
#   implements: heddle
# ---

feature_directory="${1:?Feature directory is required.}"

fail() {
    printf '[heddle] ERROR: %s\n' "$1" >&2
    exit 1
}

feature_manifest="${feature_directory}/devcontainer-feature.json"
jq -e '.id == "heddle" and (.version | type == "string" and length > 0)' \
    "${feature_manifest}" >/dev/null \
    || fail "The published Feature manifest identity is invalid."

[ ! -e "${feature_directory}/heddle-source" ] \
    || fail "The published Feature must not contain a Heddle source tree."

if find "${feature_directory}" -maxdepth 1 -type f -name 'heddle-*.tgz' -print -quit \
    | grep -q .; then
    fail "The published Feature must not contain a Heddle package tarball."
fi
