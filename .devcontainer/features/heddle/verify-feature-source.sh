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

shopt -s nullglob
legacy_packages=("${feature_directory}"/heddle-*.tgz)
shopt -u nullglob
[ "${#legacy_packages[@]}" -eq 0 ] \
    || fail "Pre-packaged Heddle tarballs are not a supported Feature source."

feature_manifest="${feature_directory}/devcontainer-feature.json"
source_manifest="${feature_directory}/heddle-source/package.json"
[ -f "${source_manifest}" ] \
    || fail "The published Feature does not contain the Heddle source."

feature_version="$(jq -er '.version' "${feature_manifest}")"
source_identity="$(jq -er '[.name, .version, .private] | @tsv' "${source_manifest}")"
expected_identity="$(printf 'heddle\t%s\ttrue' "${feature_version}")"
[ "${source_identity}" = "${expected_identity}" ] \
    || fail "The Feature and Heddle source identities do not agree."
