#!/usr/bin/env bash

set -euo pipefail

# ---
# relationships:
#   implements: heddle
# ---

repository="$(git rev-parse --show-toplevel)"
feature_directory="${repository}/.devcontainer/features/heddle"

find "${feature_directory}" -maxdepth 1 -type f -name 'heddle-*.tgz' -delete
npm pack --silent --pack-destination "${feature_directory}" "${repository}" >/dev/null

shopt -s nullglob
packages=("${feature_directory}"/heddle-*.tgz)
shopt -u nullglob
[ "${#packages[@]}" -eq 1 ] || {
    echo "Expected one packaged Heddle release; found ${#packages[@]}." >&2
    exit 1
}

contents="$(mktemp)"
trap 'rm -f "${contents}"' EXIT
tar -tzf "${packages[0]}" >"${contents}"
grep -qx 'package/dist/control-plane/t3-control-plane-client.js' "${contents}"
grep -qx 'package/dist/deployment/server.js' "${contents}"
grep -qx 'package/bin/heddle-server.mjs' "${contents}"
grep -qx 'package/assets/console-viewer/lifecycle.js' "${contents}"
grep -qx 'package/assets/console-viewer/lifecycle.css' "${contents}"
printf 'Packaged %s\n' "$(basename "${packages[0]}")"
