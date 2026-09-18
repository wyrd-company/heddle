#!/usr/bin/env bash

set -euo pipefail

service_directory="$(mktemp -d)"
supervisor_pid=
cleanup() {
    if [ -n "${supervisor_pid}" ]; then
        kill "${supervisor_pid}" 2>/dev/null || true
        wait "${supervisor_pid}" 2>/dev/null || true
    fi
}
trap cleanup EXIT

cat >"${service_directory}/run" <<EOF
#!/usr/bin/env bash
exec /usr/local/bin/heddle-service
EOF
chmod 0755 "${service_directory}/run"
/command/s6-supervise "${service_directory}" &
supervisor_pid=$!

sleep 2
/command/s6-svstat "${service_directory}" | grep -q 'up (pid'
/command/s6-svc -d "${service_directory}"
sleep 1
/command/s6-svstat "${service_directory}" | grep -q '^down '
/command/s6-svc -u "${service_directory}"
sleep 1
/command/s6-svstat "${service_directory}" | grep -q 'up (pid'
