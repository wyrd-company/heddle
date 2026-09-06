#!/usr/bin/env bash

set -euo pipefail

# ---
# relationships:
#   implements: heddle
# ---

destination="${1:?usage: install-prerequisites.sh DESTINATION}"
kanban_repository="https://github.com/wyrd-company/kanban-md.git"
kanban_branch="source/0.37.0-fork-b9fc380"
kanban_commit="b9fc380c3f97f41c9aa11077b858c75dad6ec0ee"
kanban_version="0.37.0-fork+b9fc380"
gitpr_version="0.4.0"
gitpr_archive="gitpr_${gitpr_version}_linux_x86_64.tar.gz"
gitpr_checksum="a92933afd9459074cdffb217cd02f87b29105d4ba45557290fdcd71d340cbd1a"

mkdir -p "${destination}"
working_directory="$(mktemp -d)"
cleanup() {
    rm -rf "${working_directory}"
}
trap cleanup EXIT

git clone --quiet --branch "${kanban_branch}" --single-branch --no-checkout \
    "${kanban_repository}" "${working_directory}/kanban-md"
git -C "${working_directory}/kanban-md" checkout --quiet --detach "${kanban_commit}"
test "$(git -C "${working_directory}/kanban-md" rev-parse HEAD)" = "${kanban_commit}"
go -C "${working_directory}/kanban-md" build -trimpath \
    -ldflags "-X github.com/antopolskiy/kanban-md/cmd.version=${kanban_version}" \
    -o "${destination}/kanban-md" \
    ./cmd/kanban-md

curl --fail --location --proto '=https' --silent --show-error \
    --output "${working_directory}/${gitpr_archive}" \
    "https://github.com/wyrd-company/gitpr/releases/download/${gitpr_version}/${gitpr_archive}"
printf '%s  %s\n' "${gitpr_checksum}" "${working_directory}/${gitpr_archive}" \
    | sha256sum --check --status
tar --extract --gzip --file "${working_directory}/${gitpr_archive}" \
    --directory "${destination}" gitpr
chmod 0755 "${destination}/kanban-md" "${destination}/gitpr"

test "$("${destination}/kanban-md" --version)" = \
    "kanban-md version ${kanban_version}"
test "$("${destination}/gitpr" --version)" = "gitpr version ${gitpr_version}"
