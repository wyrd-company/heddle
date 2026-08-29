#!/usr/bin/env bash

set -euo pipefail

# ---
# relationships:
#   verifies: heddle
# ---

repository="$(git rev-parse --show-toplevel)"
accepted_head="$(git rev-parse HEAD)"
configuration="${repository}/.devcontainer/qualification/devcontainer.json"
state_directory="$(mktemp -d /workspaces/mnt/heddle-qualification-state.XXXXXX)"
board_directory="$(mktemp -d /workspaces/mnt/heddle-qualification-board.XXXXXX)"
container_id=""
qualification_label="heddle-$(printf '%s' "${accepted_head}" | cut -c1-12)-$$"
kanban-md init \
    --dir "${board_directory}" \
    --name "Sample Board" \
    --statuses todo,in-progress,done >/dev/null
qualification_task_id="$(
    kanban-md create \
        --dir "${board_directory}" \
        --status in-progress \
        --json \
        "Sample Record" | jq -er '.id'
)"
chmod -R a+rX "${board_directory}"

cleanup() {
    if [ -n "${container_id}" ] && docker inspect "${container_id}" >/dev/null 2>&1; then
        docker rm --force "${container_id}" >/dev/null
    fi
    rm -rf "${state_directory}"
    rm -rf "${board_directory}"
}
trap cleanup EXIT

assert_head() {
    local observed
    observed="$(git -C "${repository}" rev-parse HEAD)"
    [ "${observed}" = "${accepted_head}" ] || {
        echo "Repository head moved: expected ${accepted_head}, observed ${observed}." >&2
        exit 1
    }
}

up() {
    local log_file
    local -a container_ids
    log_file="$(mktemp)"
    if ! HEDDLE_QUALIFICATION_STATE="${state_directory}" \
        HEDDLE_QUALIFICATION_BOARD="${board_directory}" \
        devcontainer up \
        --workspace-folder "${repository}" \
        --config "${configuration}" \
        --id-label "heddle.qualification=${qualification_label}" \
        --log-level info >"${log_file}" 2>&1; then
        tail -n 100 "${log_file}" >&2
        rm -f "${log_file}"
        return 1
    fi
    rm -f "${log_file}"
    mapfile -t container_ids < <(
        docker ps --all --quiet \
            --filter "label=heddle.qualification=${qualification_label}"
    )
    [ "${#container_ids[@]}" -eq 1 ] || {
        echo "Expected one scratch container; found ${#container_ids[@]}." >&2
        return 1
    }
    container_id="${container_ids[0]}"
    docker inspect "${container_id}" >/dev/null
}

inside() {
    HEDDLE_QUALIFICATION_STATE="${state_directory}" \
        HEDDLE_QUALIFICATION_BOARD="${board_directory}" \
        devcontainer exec \
        --workspace-folder "${repository}" \
        --config "${configuration}" \
        --id-label "heddle.qualification=${qualification_label}" \
        "$@"
}

assert_head
task -d "${repository}" deployment:package
assert_head
up

inside bash -lc '
set -euo pipefail
test "$(/command/s6-rc -a list | awk '\''$1 == "heddle" { count += 1 } END { print count + 0 }'\'')" -eq 1
for attempt in $(seq 1 100); do
    if curl --fail --silent http://127.0.0.1:4317/ >/tmp/heddle-console.html; then break; fi
    [ "${attempt}" -lt 100 ] || exit 1
    sleep 0.1
done
grep -q "<title>Heddle Console</title>" /tmp/heddle-console.html
test "$(curl --silent --output /tmp/heddle-mcp.json --write-out "%{http_code}" --request POST http://127.0.0.1:4317/mcp)" = 401
grep -q "Unauthorized" /tmp/heddle-mcp.json
for attempt in $(seq 1 100); do
    if curl --insecure --fail --silent https://heddle.localhost/ >/tmp/heddle-caddy.html; then break; fi
    [ "${attempt}" -lt 100 ] || exit 1
    sleep 0.1
done
grep -q "<title>Heddle Console</title>" /tmp/heddle-caddy.html
'

inside env HEDDLE_QUALIFICATION_TASK_ID="${qualification_task_id}" \
node --input-type=module -e '
import { SqlitePersistence } from "/usr/local/lib/node_modules/heddle/dist/persistence/index.js";
const persistence = new SqlitePersistence({ stateDirectory: "/var/lib/heddle" });
persistence.createInstance(`task-${process.env.HEDDLE_QUALIFICATION_TASK_ID}`, {
  correlationTokens: {},
  flowcraftContext: { awaitingNodeIds: ["inspect"] },
  handoffs: [],
  todoState: null,
});
persistence.close();
'

docker rm --force "${container_id}" >/dev/null
container_id=""
assert_head
up
inside env HEDDLE_QUALIFICATION_TASK_ID="${qualification_task_id}" bash -lc '
set -euo pipefail
for attempt in $(seq 1 100); do
    response="$(curl --fail --silent http://127.0.0.1:4317/api/instances || true)"
    if printf "%s" "${response}" | jq -e --arg task_id "${HEDDLE_QUALIFICATION_TASK_ID}" '\''length == 1 and .[0].instanceId == ("task-" + $task_id) and .[0].taskId == ($task_id | tonumber) and .[0].stageId == "inspect"'\'' >/dev/null; then
        exit 0
    fi
    sleep 0.1
done
exit 1
'
inside env HEDDLE_QUALIFICATION_TASK_ID="${qualification_task_id}" \
node --input-type=module -e '
import { SqlitePersistence } from "/usr/local/lib/node_modules/heddle/dist/persistence/index.js";
const persistence = new SqlitePersistence({ stateDirectory: "/var/lib/heddle" });
const record = persistence.getInstance(`task-${process.env.HEDDLE_QUALIFICATION_TASK_ID}`);
if (record?.version !== 1 || record.state.flowcraftContext.awaitingNodeIds?.[0] !== "inspect") {
  throw new Error("Rebuilt service did not replay the exact persisted instance");
}
persistence.close();
'

expected_t3="$(jq -er '.t3' "${repository}/deployment/supported-versions.json")"
inside bash -lc "
set -euo pipefail
prefix=\"\$(mktemp -d /tmp/heddle-t3-install.XXXXXX)\"
trap 'rm -rf \"\${prefix}\"' EXIT
npm install --silent --no-audit --no-fund --prefix \"\${prefix}\" \"t3@${expected_t3}\"
HEDDLE_EXPECTED_T3_VERSION='${expected_t3}' \\
HEDDLE_INSTALLED_PACKAGE=/usr/local/lib/node_modules/heddle \\
HEDDLE_T3_BINARY=\"\${prefix}/node_modules/.bin/t3\" \\
node scripts/deployment/qualify-pinned-t3.mjs
"

assert_head
printf 'Deployment qualification passed at %s\n' "${accepted_head}"
