#!/usr/bin/env bash

set -euo pipefail

test_root="$(mktemp -d)"
service_directories=()
supervisor_pids=()
proof_pid=

cleanup() {
    local service_directory supervisor_pid
    for service_directory in "${service_directories[@]}"; do
        /command/s6-svc -dx "${service_directory}" 2>/dev/null || true
    done
    for supervisor_pid in "${supervisor_pids[@]}"; do
        wait "${supervisor_pid}" 2>/dev/null || true
    done
    rm -rf "${test_root}"
}
trap cleanup EXIT

start_supervisor() {
    local service_directory=$1
    service_directories+=("${service_directory}")
    /command/s6-supervise "${service_directory}" &
    supervisor_pids+=("$!")
}

prove_stable_pid() {
    local service_directory=$1 label=$2 observation_delay=${3:-1}
    local first_up first_pid second_up second_pid result=1

    read -r first_up first_pid < <(
        /command/s6-svstat -o up,pid -n "${service_directory}"
    )
    sleep "${observation_delay}"
    read -r second_up second_pid < <(
        /command/s6-svstat -o up,pid -n "${service_directory}"
    )
    printf '%s supervised PID observations: %s then %s\n' \
        "${label}" "${first_pid}" "${second_pid}"

    if [ "${first_up}" = true ] &&
        [ "${second_up}" = true ] &&
        [ "${first_pid}" -gt 0 ] &&
        [ "${first_pid}" = "${second_pid}" ]; then
        result=0
    fi
    proof_pid=${second_pid}
    return "${result}"
}

prove_clean_down() {
    local service_directory=$1 label=$2
    local up pid exit_code

    read -r up pid exit_code < <(
        /command/s6-svstat -o up,pid,exitcode -n "${service_directory}"
    )
    printf '%s down observation: up=%s pid=%s exitcode=%s\n' \
        "${label}" "${up}" "${pid}" "${exit_code}"

    [ "${up}" = false ] && [ "${pid}" = -1 ] && [ "${exit_code}" = 0 ]
}

service_directory="${test_root}/heddle"
mkdir "${service_directory}"
install -m 0755 /dev/stdin "${service_directory}/run" <<'EOF'
#!/usr/bin/env bash
exec /usr/local/bin/heddle-service
EOF
start_supervisor "${service_directory}"

sleep 1
prove_stable_pid "${service_directory}" "initial Heddle process"
initial_pid=${proof_pid}
/command/s6-svc -d "${service_directory}"
sleep 1
prove_clean_down "${service_directory}" "stopped Heddle process"
/command/s6-svc -u "${service_directory}"
sleep 1
prove_stable_pid "${service_directory}" "restarted Heddle process"
[ "${proof_pid}" != "${initial_pid}" ]

restart_loop_directory="${test_root}/restart-loop"
mkdir "${restart_loop_directory}"
install -m 0755 /dev/stdin "${restart_loop_directory}/run" <<'EOF'
#!/usr/bin/env bash
sleep 2
exit 1
EOF
start_supervisor "${restart_loop_directory}"
sleep 1
if prove_stable_pid "${restart_loop_directory}" "restart-loop control" 3; then
    echo "restart-loop control unexpectedly passed the stable-PID proof" >&2
    exit 1
fi
echo "restart-loop control was rejected by the stable-PID proof"

dirty_exit_directory="${test_root}/dirty-exit"
mkdir "${dirty_exit_directory}"
install -m 0755 /dev/stdin "${dirty_exit_directory}/run" <<'EOF'
#!/usr/bin/env bash
trap 'exit 7' TERM INT
while :; do
    sleep 1
done
EOF
start_supervisor "${dirty_exit_directory}"
sleep 1
prove_stable_pid "${dirty_exit_directory}" "dirty-exit control"
/command/s6-svc -d "${dirty_exit_directory}"
sleep 2
if prove_clean_down "${dirty_exit_directory}" "dirty-exit control"; then
    echo "dirty-exit control unexpectedly passed the clean-down proof" >&2
    exit 1
fi
echo "dirty-exit control was rejected by the clean-down proof"
