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
container_id=""
qualification_label="heddle-$(printf '%s' "${accepted_head}" | cut -c1-12)-$$"

cleanup() {
    if [ -n "${container_id}" ] && docker inspect "${container_id}" >/dev/null 2>&1; then
        docker rm --force "${container_id}" >/dev/null
    fi
    rm -rf "${state_directory}"
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
    local output
    output="$(
        HEDDLE_QUALIFICATION_STATE="${state_directory}" \
            devcontainer up \
            --workspace-folder "${repository}" \
            --config "${configuration}" \
            --id-label "heddle.qualification=${qualification_label}" \
            --log-level error
    )"
    container_id="$(printf '%s\n' "${output}" | tail -n 1 | jq -er '.containerId')"
    docker inspect "${container_id}" >/dev/null
}

inside() {
    HEDDLE_QUALIFICATION_STATE="${state_directory}" \
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
test "$(s6-rc -a list | awk '\''$1 == "heddle" { count += 1 } END { print count + 0 }'\'')" -eq 1
for attempt in $(seq 1 100); do
    if curl --fail --silent http://127.0.0.1:4317/ >/tmp/heddle-console.html; then break; fi
    [ "${attempt}" -lt 100 ] || exit 1
    sleep 0.1
done
grep -q "<h1>Heddle</h1>" /tmp/heddle-console.html
test "$(curl --silent --output /tmp/heddle-mcp.json --write-out "%{http_code}" --request POST http://127.0.0.1:4317/mcp)" = 401
grep -q "Unauthorized" /tmp/heddle-mcp.json
for attempt in $(seq 1 100); do
    if curl --insecure --fail --silent https://heddle.localhost/ >/tmp/heddle-caddy.html; then break; fi
    [ "${attempt}" -lt 100 ] || exit 1
    sleep 0.1
done
grep -q "<h1>Heddle</h1>" /tmp/heddle-caddy.html
'

inside node --input-type=module -e '
import { SqlitePersistence } from "/usr/local/lib/node_modules/heddle/dist/persistence/index.js";
const persistence = new SqlitePersistence({ stateDirectory: "/var/lib/heddle" });
persistence.createInstance("sample-record", {
  correlationTokens: {},
  flowcraftContext: { category: "inventory" },
  handoffs: [],
  todoState: null,
});
persistence.close();
'

docker rm --force "${container_id}" >/dev/null
container_id=""
assert_head
up
inside bash -lc '
set -euo pipefail
for attempt in $(seq 1 100); do
    response="$(curl --fail --silent http://127.0.0.1:4317/api/instances || true)"
    if printf "%s" "${response}" | jq -e '\''.instances == [{instanceId:"sample-record",state:{correlationTokens:{},flowcraftContext:{category:"inventory"},handoffs:[],todoState:null},version:1}]'\'' >/dev/null; then
        exit 0
    fi
    sleep 0.1
done
exit 1
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
