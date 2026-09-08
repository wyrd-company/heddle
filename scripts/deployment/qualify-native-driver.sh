#!/usr/bin/env bash
# ---
# relationships:
#   verifies: heddle
#   references: t3-headless
# ---

set -euo pipefail

driver="${1:-}"
case "${driver}" in
    claude-code | codex | cursor | grok | opencode) ;;
    *)
        echo "Usage: $0 {claude-code|codex|cursor|grok|opencode}" >&2
        exit 2
        ;;
esac

repository="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
configuration="${repository}/.devcontainer/driver-qualification/${driver}/devcontainer.json"
kanban_binary="${HEDDLE_DRIVER_KANBAN:-$(command -v kanban-md)}"
label_name="heddle.native-driver-qualification"
label_value="${driver}-$(tr -d '-' </proc/sys/kernel/random/uuid)"
container_id=""

if [ ! -x "${kanban_binary}" ]; then
    echo "kanban-md is not executable: ${kanban_binary}" >&2
    exit 1
fi

lookup_owned_container() {
    local -a candidates
    mapfile -t candidates < <(
        docker ps --all --quiet --no-trunc \
            --filter "label=${label_name}=${label_value}"
    )
    if [ "${#candidates[@]}" -eq 1 ]; then
        container_id="${candidates[0]}"
    fi
}

owned_label() {
    docker inspect \
        --format "{{ index .Config.Labels \"${label_name}\" }}" \
        "$1" 2>/dev/null
}

cleanup() {
    local status=$?
    local observed_label
    trap - EXIT

    if [ -z "${container_id}" ]; then
        lookup_owned_container
    fi
    if [ -n "${container_id}" ]; then
        observed_label="$(owned_label "${container_id}" || true)"
        if [ "${observed_label}" != "${label_value}" ]; then
            echo "Refusing to remove container ${container_id}: ownership label mismatch." >&2
            status=1
        elif ! docker rm --force "${container_id}" >/dev/null; then
            echo "Failed to remove native qualification container ${container_id}." >&2
            status=1
        fi
    fi
    exit "${status}"
}

trap cleanup EXIT
trap 'exit 129' HUP
trap 'exit 130' INT
trap 'exit 143' TERM

set +e
up_output="$({
    HEDDLE_DRIVER_KANBAN="${kanban_binary}" devcontainer up \
        --workspace-folder "${repository}" \
        --config "${configuration}" \
        --id-label "${label_name}=${label_value}" \
        --log-format json
} 2>&1)"
up_status=$?
set -e

container_id="$(
    printf '%s\n' "${up_output}" \
        | jq -Rr 'fromjson? | select(type == "object" and .outcome == "success") | .containerId // empty' \
        | tail -n 1
)"
if [[ ! "${container_id}" =~ ^[0-9a-f]{64}$ ]]; then
    container_id=""
    lookup_owned_container
fi
if [ "${up_status}" -ne 0 ]; then
    printf '%s\n' "${up_output}" >&2
    exit "${up_status}"
fi
if [[ ! "${container_id}" =~ ^[0-9a-f]{64}$ ]]; then
    echo "devcontainer up did not return one exact container identity." >&2
    exit 1
fi
if [ "$(owned_label "${container_id}" || true)" != "${label_value}" ]; then
    echo "Created container ${container_id} does not carry the ownership label." >&2
    exit 1
fi

HEDDLE_DRIVER_KANBAN="${kanban_binary}" devcontainer exec \
    --workspace-folder "${repository}" \
    --config "${configuration}" \
    --id-label "${label_name}=${label_value}" \
    bash -lc '
        set -eu
        driver="$1"
        scratch=$(mktemp -d /tmp/heddle-native-driver.XXXXXX)
        trap '\''find "$scratch" -depth -delete'\'' EXIT
        npm install --global --no-audit --no-fund --prefix "$scratch/t3" \
            "$(node -p '\''require("./deployment/supported-versions.json").t3PackageSource'\'')"
        env -u FORCE_COLOR -u NO_COLOR \
            HEDDLE_T3_INTEGRATION_BINARY="$scratch/t3/bin/t3" \
            HEDDLE_NATIVE_DRIVER_QUALIFICATION=1 \
            HEDDLE_NATIVE_DRIVER_ALIAS="$driver" \
            npx vitest run src/production/native-driver.integration.test.ts \
                --maxWorkers=1
    ' bash "${driver}"
