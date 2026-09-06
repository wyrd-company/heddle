#!/usr/bin/env bash

set -euo pipefail

# ---
# relationships:
#   implements: heddle
# ---

repository="$(git rev-parse --show-toplevel)"
source_feature="${repository}/.devcontainer/features/heddle"
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
find "${collection_directory}" -mindepth 1 -delete
install -d -m 0755 "${staged_source}"

for file in \
    README.md \
    check-kanban-version.sh \
    common.sh \
    devcontainer-feature.json \
    install.sh \
    verify-feature-source.sh; do
    install -m 0755 "${source_feature}/${file}" "${staged_feature}/${file}"
done
chmod 0644 \
    "${staged_feature}/README.md" \
    "${staged_feature}/devcontainer-feature.json"

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
tar -C "${repository}" -cf - "${source_paths[@]}" \
    | tar -C "${staged_source}" -xf -

"${staged_feature}/verify-feature-source.sh" "${staged_feature}"
printf 'Staged Heddle Feature source at %s\n' "${staged_feature}"
