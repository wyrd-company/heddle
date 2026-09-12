#!/usr/bin/env bash

set -euo pipefail

# ---
# relationships:
#   verifies: heddle
# ---

repository="$(git rev-parse --show-toplevel)"
accepted_head="$(git rev-parse HEAD)"
source_configuration="${repository}/.devcontainer/qualification/devcontainer.json"
published_feature_reference="ghcr.io/wyrd-company/heddle/heddle:1"
registry_image="registry:2.8.3@sha256:a3d8aaa63ed8681a604f1dea0aa03f100d5895b6a58ace528858a7b332415373"
configuration=""
scratch_root="${HEDDLE_QUALIFICATION_SCRATCH_ROOT:-/workspaces/mnt}"
state_directory=""
board_directory=""
tools_directory=""
config_directory=""
publication_directory=""
container_id=""
registry_container_id=""
qualification_base_image=""
t3_mock_error=""
t3_mock_log=""
t3_mock_pid=""
t3_mock_port=""
qualification_label="heddle-$(printf '%s' "${accepted_head}" | cut -c1-12)-$$"

remove_owned_container() {
    local container_reference="$1"
    local label_key="$2"
    local full_id
    local identity
    local label_value

    full_id="$(docker inspect --format '{{.Id}}' "${container_reference}" 2>/dev/null)" \
        || return 0
    label_value="$(
        docker inspect \
            --format "{{ index .Config.Labels \"${label_key}\" }}" \
            "${full_id}"
    )"
    if [ "${label_value}" != "${qualification_label}" ]; then
        echo "Refusing to remove container ${full_id}: ${label_key} does not match ${qualification_label}." >&2
        return 1
    fi
    identity="$(
        docker inspect \
            --format '{{.Id}} name={{.Name}} image={{.Config.Image}}' \
            "${full_id}"
    )"
    printf 'Removing verified qualification container %s label=%s=%s\n' \
        "${identity}" "${label_key}" "${label_value}" >&2
    docker rm --force "${full_id}" >/dev/null
}

cleanup() {
    local cleanup_failed=0
    local scratch_container
    local -a scratch_containers
    if [ -n "${t3_mock_pid}" ]; then
        kill "${t3_mock_pid}" 2>/dev/null || true
        wait "${t3_mock_pid}" 2>/dev/null || true
    fi
    mapfile -t scratch_containers < <(
        docker ps --all --quiet \
            --filter "label=heddle.qualification=${qualification_label}" \
            2>/dev/null || true
    )
    for scratch_container in "${scratch_containers[@]}"; do
        remove_owned_container \
            "${scratch_container}" \
            heddle.qualification \
            || cleanup_failed=1
    done
    if [ -n "${registry_container_id}" ]; then
        remove_owned_container \
            "${registry_container_id}" \
            heddle.dry-publish \
            || cleanup_failed=1
    fi
    if [ -n "${qualification_base_image}" ] \
        && docker image inspect "${qualification_base_image}" >/dev/null 2>&1; then
        base_label="$(docker image inspect --format '{{index .Config.Labels "heddle.qualification"}}' "${qualification_base_image}")"
        if [ "${base_label}" != "${qualification_label}" ]; then
            echo "Refusing to remove image ${qualification_base_image}: heddle.qualification does not match ${qualification_label}." >&2
            cleanup_failed=1
        else
            docker image rm "${qualification_base_image}" >/dev/null || cleanup_failed=1
        fi
    fi
    [ -z "${state_directory}" ] || rm -rf "${state_directory}"
    [ -z "${board_directory}" ] || rm -rf "${board_directory}"
    [ -z "${tools_directory}" ] || rm -rf "${tools_directory}"
    [ -z "${config_directory}" ] || rm -rf "${config_directory}"
    [ -z "${publication_directory}" ] || rm -rf "${publication_directory}"
    [ -z "${t3_mock_log}" ] || rm -f "${t3_mock_log}"
    [ -z "${t3_mock_error}" ] || rm -f "${t3_mock_error}"
    return "${cleanup_failed}"
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
publication_directory="$(allocate_scratch_directory publication)"
configuration="${publication_directory}/devcontainer.json"
t3_mock_log="$(mktemp)"
t3_mock_error="$(mktemp)"
node "${repository}/scripts/deployment/qualification-t3.mjs" \
    >"${t3_mock_log}" 2>"${t3_mock_error}" &
t3_mock_pid="$!"
for attempt in $(seq 1 100); do
    t3_mock_port="$(sed -n '1p' "${t3_mock_log}")"
    if [[ "${t3_mock_port}" =~ ^[0-9]+$ ]]; then break; fi
    if ! kill -0 "${t3_mock_pid}" 2>/dev/null; then
        cat "${t3_mock_error}" >&2
        exit 1
    fi
    [ "${attempt}" -lt 100 ] || {
        echo "The qualification T3 catalog did not become ready." >&2
        exit 1
    }
    sleep 0.1
done

install -m 0755 "$(command -v kanban-md)" "${tools_directory}/kanban-md"

git init --bare --initial-branch=main "${config_directory}/blueprints-origin.git" >/dev/null
git clone "${config_directory}/blueprints-origin.git" "${config_directory}/blueprints" >/dev/null
git -C "${config_directory}/blueprints" remote set-url origin ../blueprints-origin.git
git -C "${config_directory}/blueprints" config user.name "Qualification Fixture"
git -C "${config_directory}/blueprints" config user.email "fixture@example.invalid"
install -d -m 0755 "${config_directory}/blueprints/blueprints"
install -d -m 0755 "${config_directory}/blueprints/themes"
printf '# Qualification blueprint repository\n' \
    >"${config_directory}/blueprints/README.md"
cat >"${config_directory}/blueprints/themes/sample-team.yml" <<'EOF'
$schema: https://wyrd.company/heddle/agent-name-theme.schema.json
relationships:
  implements: heddle
kind: team
leader: sample-lead
companions: [sample-companion]
allies: [sample-ally]
antagonists: [sample-antagonist]
neutrals: [sample-neutral]
EOF
git -C "${config_directory}/blueprints" add -- README.md themes
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
incident:
  approvalSeverityThreshold: high
  failureThreshold: 3
  githubIssueRepository: sample-owner/sample-repository
  immediateEscalationCodes: []
  retryDelayMilliseconds: 60000
  workspaceRoot: /workspaces/heddle
observationThresholds:
  endedMilliseconds: 60000
  failedMilliseconds: 60000
  stalledMilliseconds: 60000
pacing:
  maxConcurrentSessions: 1
  providerBudgets: {}
  subagents:
    maxDepth: 1
    maxFanOut: 1
  usageWindowHours: 5
providerAliases:
  default:
    providerDisplayName: Workbench Alpha
    model: sample-model
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
  defaultProviderAlias: default
  defaultRuntimeMode: auto
  interactionMode: default
  skillPointer: skill://sample
stageThresholds:
  inspect: 60000
stateDirectory: /var/lib/heddle
stopTimeoutMilliseconds: 1000
t3:
  accessToken: sample-access-token
  baseUrl: http://t3.qualification:T3_MOCK_PORT
EOF
sed -i "s/T3_MOCK_PORT/${t3_mock_port}/" "${config_directory}/config.yml"
chmod 0600 "${config_directory}/config.yml"
node --input-type=module - "${config_directory}" <<'EOF'
import { GitAgentNameThemeCatalog } from "./dist/agent-names/index.js";
import { loadDeploymentConfiguration } from "./dist/deployment/configuration.js";

const loaded = await loadDeploymentConfiguration(process.argv[2]);
const themeCatalog = new GitAgentNameThemeCatalog(
  loaded.blueprintsRepositoryRoot,
  "HEAD",
);
await themeCatalog.validateCurrent();
EOF

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
        DOCKER_CONFIG="${docker_config}" \
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
        DOCKER_CONFIG="${docker_config}" \
        devcontainer exec \
        --workspace-folder "${repository}" \
        --config "${configuration}" \
        --id-label "heddle.qualification=${qualification_label}" \
        "$@"
}

assert_head
task -d "${repository}" deployment:package
assert_head

package_version="$(jq -er '.version' "${repository}/package.json")"
npm pack --silent \
    --pack-destination "${publication_directory}" \
    "${repository}" >/dev/null
package_path="${publication_directory}/heddle-${package_version}.tgz"
[ -f "${package_path}" ] || {
    echo "npm pack did not produce ${package_path}." >&2
    exit 1
}
package_contents="${publication_directory}/package-contents.txt"
tar -tf "${package_path}" >"${package_contents}"
grep -qx package/assets/console-viewer/lifecycle.js "${package_contents}" || {
    echo "The qualification package is missing assets/console-viewer/lifecycle.js." >&2
    exit 1
}
package_digest="$(sha256sum "${package_path}" | cut -d ' ' -f 1)"
base_context="${publication_directory}/base-image"
install -d -m 0755 "${base_context}"
cp -- "${package_path}" "${base_context}/heddle-package.tgz"
base_source="$(jq -er '.image' "${source_configuration}")"
cat >"${base_context}/Dockerfile" <<EOF
FROM ${base_source}
COPY heddle-package.tgz /opt/heddle-package.tgz
LABEL heddle.qualification=${qualification_label}
EOF
qualification_base_image="heddle-qualification-base:${accepted_head}-$$"
docker build --tag "${qualification_base_image}" "${base_context}" >/dev/null

docker_config="${publication_directory}/docker-config"
install -d -m 0700 "${docker_config}"
if ! docker image inspect "${registry_image}" >/dev/null 2>&1; then
    docker --config "${docker_config}" pull "${registry_image}"
fi
registry_container_id="$(
    docker run --detach \
        --label "heddle.dry-publish=${qualification_label}" \
        --publish 127.0.0.1::5000 \
        "${registry_image}"
)"
registry_port="$(
    docker inspect \
        --format '{{(index (index .NetworkSettings.Ports "5000/tcp") 0).HostPort}}' \
        "${registry_container_id}"
)"
for attempt in $(seq 1 100); do
    if curl --fail --silent "http://127.0.0.1:${registry_port}/v2/" >/dev/null; then
        break
    fi
    [ "${attempt}" -lt 100 ] || {
        echo "The dry-publish OCI registry did not become ready." >&2
        exit 1
    }
    sleep 0.1
done

feature_collection="${publication_directory}/features"
"${repository}/scripts/deployment/stage-feature.sh" "${feature_collection}"
publication_log="${publication_directory}/publish.log"
if ! devcontainer features publish \
    --registry "localhost:${registry_port}" \
    --namespace wyrd-company/heddle \
    "${feature_collection}" >"${publication_log}" 2>&1; then
    tail -n 100 "${publication_log}" >&2
    exit 1
fi
cat "${publication_log}"
publication_result="$(tail -n 1 "${publication_log}")"
jq -e \
    '.heddle.version == "1.0.0" and
     .heddle.publishedTags == ["1", "1.0", "1.0.0", "latest"] and
     (.heddle.digest | test("^sha256:[0-9a-f]{64}$"))' \
    <<<"${publication_result}" >/dev/null

dry_published_reference="localhost:${registry_port}/wyrd-company/heddle/heddle:1"
jq -e --arg reference "${published_feature_reference}" \
    '[.features | keys[] | select(. == $reference)] | length == 1' \
    "${source_configuration}" >/dev/null
jq \
    --arg published "${published_feature_reference}" \
    --arg dry_published "${dry_published_reference}" \
    --arg base_image "${qualification_base_image}" \
    --arg package_digest "${package_digest}" \
    '.image = $base_image |
     .features |= with_entries(
       if .key == $published then
         .key = $dry_published |
         .value += {
           packageSource: "/opt/heddle-package.tgz",
           packageSha256: $package_digest,
           version: "latest"
         }
       else . end
     )' \
    "${source_configuration}" >"${configuration}"
jq -e --arg reference "${dry_published_reference}" \
    '[.features | keys[] | select(. == $reference)] | length == 1' \
    "${configuration}" >/dev/null

printf 'Dry-published %s as %s (%s)\n' \
    "${published_feature_reference}" \
    "${dry_published_reference}" \
    "$(jq -r '.heddle.digest' <<<"${publication_result}")"
up

inside env HEDDLE_QUALIFICATION_TASK_ID="${qualification_task_id}" bash -lc '
set -euo pipefail
test "$(/command/s6-rc -a list | awk '\''$1 == "heddle" { count += 1 } END { print count + 0 }'\'')" -eq 1
test "$(kanban-md --version)" = "kanban-md version 0.37.0-fork+b9fc380"
! command -v python3 >/dev/null 2>&1
test -f /usr/local/lib/node_modules/heddle/assets/console-viewer/lifecycle.js
jq -e '\''(.dependencies | keys | sort) == [
  "@flowcraft/sqlite-history",
  "@modelcontextprotocol/server",
  "ajv",
  "better-sqlite3",
  "flowcraft",
  "nunjucks",
  "yaml",
  "zod"
]\'' /usr/local/lib/node_modules/heddle/package.json >/dev/null
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

remove_owned_container \
    "${container_id}" \
    heddle.qualification
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
t3_package_source="$(jq -er '.t3PackageSource' "${repository}/deployment/supported-versions.json")"
inside bash -lc "
set -euo pipefail
prefix=\"\$(mktemp -d /tmp/heddle-t3-install.XXXXXX)\"
trap 'rm -rf \"\${prefix}\"' EXIT
npm install --global --no-audit --no-fund --prefix \"\${prefix}\" '${t3_package_source}'
HEDDLE_EXPECTED_T3_VERSION='${expected_t3}' \\
HEDDLE_INSTALLED_PACKAGE=/usr/local/lib/node_modules/heddle \\
HEDDLE_T3_BINARY=\"\${prefix}/bin/t3\" \\
node scripts/deployment/qualify-pinned-t3.mjs
"

assert_head
printf 'Deployment qualification passed at %s\n' "${accepted_head}"
