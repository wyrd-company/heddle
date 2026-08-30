#!/usr/bin/env bash

set -euo pipefail

# ---
# relationships:
#   verifies: heddle
# ---

repository="$(git rev-parse --show-toplevel)"
accepted_head="$(git rev-parse HEAD)"
configuration="${repository}/.devcontainer/qualification/devcontainer.json"
scratch_root="${HEDDLE_QUALIFICATION_SCRATCH_ROOT:-/workspaces/mnt}"
state_directory=""
board_directory=""
tools_directory=""
config_directory=""
blueprints_origin_directory=""
container_id=""
qualification_label="heddle-$(printf '%s' "${accepted_head}" | cut -c1-12)-$$"

cleanup() {
    local scratch_container
    local -a scratch_containers
    mapfile -t scratch_containers < <(
        docker ps --all --quiet \
            --filter "label=heddle.qualification=${qualification_label}" \
            2>/dev/null || true
    )
    for scratch_container in "${scratch_containers[@]}"; do
        docker rm --force "${scratch_container}" >/dev/null 2>&1 || true
    done
    [ -z "${state_directory}" ] || rm -rf "${state_directory}"
    [ -z "${board_directory}" ] || rm -rf "${board_directory}"
    [ -z "${tools_directory}" ] || rm -rf "${tools_directory}"
    [ -z "${config_directory}" ] || rm -rf "${config_directory}"
    [ -z "${blueprints_origin_directory}" ] || rm -rf "${blueprints_origin_directory}"
}
trap cleanup EXIT

allocate_scratch_directory() {
    local kind="$1"
    if [ "${HEDDLE_QUALIFICATION_FAIL_ALLOCATION:-}" = "${kind}" ]; then
        echo "Injected ${kind} scratch allocation failure." >&2
        return 1
    fi
    mktemp -d "${scratch_root}/heddle-qualification-${kind}.XXXXXX"
}

state_directory="$(allocate_scratch_directory state)"
board_directory="$(allocate_scratch_directory board)"
tools_directory="$(allocate_scratch_directory tools)"
config_directory="$(allocate_scratch_directory config)"
blueprints_origin_directory="$(allocate_scratch_directory blueprints-origin)"

install -m 0755 "$(command -v kanban-md)" "${tools_directory}/kanban-md"

git init --bare --initial-branch=main "${blueprints_origin_directory}" >/dev/null
git clone "${blueprints_origin_directory}" "${config_directory}/blueprints" >/dev/null
git -C "${config_directory}/blueprints" config user.name "Qualification Fixture"
git -C "${config_directory}/blueprints" config user.email "fixture@example.invalid"
printf '# Qualification blueprint repository\n' \
    >"${config_directory}/blueprints/README.md"
git -C "${config_directory}/blueprints" add -- README.md
git -C "${config_directory}/blueprints" commit -m "Initialize qualification repository" >/dev/null
git -C "${config_directory}/blueprints" push --set-upstream origin main >/dev/null

printf 'n\n' | kanban-md init \
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
cat >"${config_directory}/config.yml" <<'EOF'
adHocProject:
  name: Shared records
  projectId: shared-project
  workspaceRoot: /workspaces/heddle
boardDirectory: /workspaces/kanban
cadenceMilliseconds: 60000
observationThresholds:
  endedMilliseconds: 60000
  failedMilliseconds: 60000
  stalledMilliseconds: 60000
pacing:
  defaultProvider: cursor
  maxConcurrentSessions: 1
  providerBudgets: {}
  subagents:
    maxDepth: 1
    maxFanOut: 1
  usageWindowHours: 5
products:
  - name: Sample collection
    repos:
      - name: sample-repository
        repositoryRoot: /workspaces/heddle
pushover:
  apiUrl: http://127.0.0.1:9/messages
  applicationToken: sample-application-token
  consoleBaseUrl: https://console.example.invalid/
  userKey: sample-user-key
server:
  host: 127.0.0.1
  port: 4317
session:
  baseRef: main
  cliVersion: 2026.08.25-3e8eec8
  driver: cursor
  interactionMode: default
  model: sample-model
  runtimeMode: auto
  skillPointer: skill://sample
stageThresholds:
  inspect: 60000
stateDirectory: /var/lib/heddle
stopTimeoutMilliseconds: 1000
t3:
  accessToken: sample-access-token
  baseUrl: http://127.0.0.1:9
EOF
chmod 0600 "${config_directory}/config.yml"

assert_head() {
    local observed
    observed="$(git -C "${repository}" rev-parse HEAD)"
    [ "${observed}" = "${accepted_head}" ] || {
        echo "Repository head moved: expected ${accepted_head}, observed ${observed}." >&2
        exit 1
    }
    git -C "${repository}" diff --quiet \
        && git -C "${repository}" diff --cached --quiet || {
        echo "Repository has tracked changes at accepted head ${accepted_head}." >&2
        exit 1
    }
}

up() {
    local log_file
    local -a container_ids
    log_file="$(mktemp)"
    if ! HEDDLE_QUALIFICATION_STATE="${state_directory}" \
        HEDDLE_QUALIFICATION_BOARD="${board_directory}" \
        HEDDLE_QUALIFICATION_KANBAN="${tools_directory}/kanban-md" \
        HEDDLE_QUALIFICATION_CONFIG="${config_directory}" \
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
        HEDDLE_QUALIFICATION_KANBAN="${tools_directory}/kanban-md" \
        HEDDLE_QUALIFICATION_CONFIG="${config_directory}" \
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

inside env HEDDLE_QUALIFICATION_TASK_ID="${qualification_task_id}" bash -lc '
set -euo pipefail
test "$(/command/s6-rc -a list | awk '\''$1 == "heddle" { count += 1 } END { print count + 0 }'\'')" -eq 1
test "$(kanban-md --version)" = "kanban-md version 0.37.0-fork+b9fc380"
for attempt in $(seq 1 100); do
    if curl --fail --silent http://127.0.0.1:4317/ >/tmp/heddle-console.html; then break; fi
    [ "${attempt}" -lt 100 ] || exit 1
    sleep 0.1
done
grep -q "<title>Heddle Console</title>" /tmp/heddle-console.html
projection="$(curl --fail --silent http://127.0.0.1:4317/api/projection)"
printf "%s" "${projection}" | jq -e --arg task_id "${HEDDLE_QUALIFICATION_TASK_ID}" '\''[.columns[].tasks[]] == [{blocked:false,dependencies:[],id:($task_id | tonumber),priority:"medium",status:"in-progress",tags:[],title:"Sample Record"}]'\'' >/dev/null
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
  flowcraftContext: {
    awaitingNodeIds: ["inspect"],
    blueprintBlobHash: "qualification-blueprint-hash",
    blueprintPath: "blueprints/qualification.json",
    completedOperations: {},
    executionIds: [],
    nextTransitionNumber: 1,
    pendingAttentions: [],
    pendingTransition: null,
    serializedContext: null,
    status: "waiting",
  },
  handoffs: [],
  todoState: null,
});
persistence.writeReconcilerRuntime({
  boardStatus: "in-progress",
  instanceId: `task-${process.env.HEDDLE_QUALIFICATION_TASK_ID}`,
  stageId: "inspect",
  state: "waiting",
  taskId: Number(process.env.HEDDLE_QUALIFICATION_TASK_ID),
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
