#!/usr/bin/env bash

set -euo pipefail

# ---
# relationships:
#   implements: heddle
# ---

repository="$(git rev-parse --show-toplevel)"
scratch="$(mktemp -d)"
cleanup() {
    rm -rf "${scratch}"
}
trap cleanup EXIT

collection="${scratch}/features"
output="${scratch}/output"
extracted="${scratch}/extracted"
"${repository}/scripts/deployment/stage-feature.sh" "${collection}"
devcontainer features package "${collection}" \
    --output-folder "${output}" \
    --force-clean-output-folder

archive="${output}/devcontainer-feature-heddle.tgz"
[ -f "${archive}" ] || {
    echo "The Dev Container CLI did not produce ${archive}." >&2
    exit 1
}

contents="${scratch}/contents"
tar -tf "${archive}" >"${contents}"
for path in \
    ./devcontainer-feature.json \
    ./install.sh \
    ./verify-feature-source.sh \
    ./resolve-package-source.mjs; do
    grep -qx "${path}" "${contents}"
done
if grep -Eq '^\./heddle-source(/|$)|^\./heddle-[^/]*\.tgz$' "${contents}"; then
    echo "The published Feature contains Heddle source or a Heddle package tarball." >&2
    exit 1
fi

install -d -m 0755 "${extracted}"
tar -xf "${archive}" -C "${extracted}"
"${extracted}/verify-feature-source.sh" "${extracted}"
printf 'Packaged devcontainer-feature-heddle.tgz (%s)\n' \
    "$(sha256sum "${archive}" | cut -d ' ' -f 1)"
