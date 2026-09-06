#!/usr/bin/env bash

set -euo pipefail

# ---
# relationships:
#   implements: heddle
# ---

repository="$(git rev-parse --show-toplevel)"
accepted_head="$(git rev-parse HEAD)"
collection_directory="$(realpath -m "${1:?Feature collection directory is required.}")"
staged_feature="${collection_directory}/heddle"
staged_source="${staged_feature}/heddle-source"

case "${collection_directory}" in
    /|"${repository}"|"${repository}/.devcontainer"|"${repository}/.devcontainer/features")
        echo "Refusing to replace source directory ${collection_directory}." >&2
        exit 1
        ;;
esac

install -d -m 0755 "${collection_directory}"
rm -rf -- "${staged_feature}"
install -d -m 0755 "${staged_source}"

git -C "${repository}" archive "${accepted_head}" -- .devcontainer/features/heddle \
    | tar -C "${staged_feature}" --strip-components=3 -xf -

source_paths=(
    LICENSE
    README.md
    bin
    package-lock.json
    package.json
    schemas
    spikes/flowcraft-gate/viewer/vendor/flowcraft-tldraw
    src
    tsconfig.json
    tsconfig.viewer.json
    vite.config.ts
)
git -C "${repository}" archive "${accepted_head}" -- "${source_paths[@]}" \
    | tar -C "${staged_source}" -xf -

"${staged_feature}/verify-feature-source.sh" "${staged_feature}"
printf 'Staged Heddle Feature source at %s\n' "${staged_feature}"
