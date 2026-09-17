#!/usr/bin/env bash

set -euo pipefail

# ---
# relationships:
#   verifies: github-binding-and-intake
# ---

repository_root="$(cd "$(dirname "$0")/.." && pwd)"
staging_root="$(mktemp -d)"

cleanup() {
    rm -rf "${staging_root}"
}
trap cleanup EXIT

mkdir -p "${staging_root}/src/heddle" "${staging_root}/test/heddle"
cp -a "${repository_root}/features/heddle/." "${staging_root}/src/heddle/"
cp -a "${repository_root}/test/features/heddle/." "${staging_root}/test/heddle/"
npm pack --silent --pack-destination "${staging_root}/src/heddle" \
    "${repository_root}" >/dev/null

devcontainer features test \
    --project-folder "${staging_root}" \
    --features heddle \
    --base-image ghcr.io/wyrd-company/devcontainers/base:noble
