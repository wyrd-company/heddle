#!/usr/bin/env bash

set -euo pipefail

# ---
# relationships:
#   implements: heddle
#   references: t3-headless
# ---

# shellcheck disable=SC1091
source "$(dirname "$0")/common.sh"

require_root
check_debian_family
ensure_s6_overlay

[[ "${PORT}" =~ ^[0-9]+$ ]] \
    || err "port must be an integer between 1 and 65535."
[ "${#PORT}" -le 5 ] \
    || err "port must be an integer between 1 and 65535."
((10#${PORT} >= 1 && 10#${PORT} <= 65535)) \
    || err "port must be an integer between 1 and 65535."

[[ "${STATEPATH}" = /* ]] || err "statePath must be an absolute path."
case "${STATEPATH}" in
    *$'\n'*|*$'\r'*) err "statePath contains unsupported characters." ;;
esac

if [ -n "${DNSNAME}" ]; then
    [ "${#DNSNAME}" -le 253 ] \
        || err "dnsName exceeds the 253-character DNS limit."
    IFS=. read -r -a dns_labels <<<"${DNSNAME}"
    [ "${#dns_labels[@]}" -ge 2 ] \
        || err "dnsName must be a fully qualified DNS name."
    for label in "${dns_labels[@]}"; do
        [[ "${label}" =~ ^[A-Za-z0-9]([A-Za-z0-9-]{0,61}[A-Za-z0-9])?$ ]] \
            || err "dnsName contains an invalid DNS label: '${label}'."
    done
    [ -d /etc/caddy/conf.d ] \
        || err "dnsName requires the Caddy Feature."
    [ -d /etc/caddy/required-hosts.d ] \
        || err "dnsName requires Caddy DNS readiness support."
fi

service_user="$(pick_service_user "${SERVICEUSER}")"
service_group="$(id -gn "${service_user}")"
install -d -m 0750 -o "${service_user}" -g "${service_group}" "${STATEPATH}"

shopt -s nullglob
packages=("$(dirname "$0")"/heddle-*.tgz)
shopt -u nullglob
[ "${#packages[@]}" -eq 1 ] \
    || err "The Feature must contain exactly one packaged Heddle release."

log "Installing the packaged Heddle release"
env \
    NPM_CONFIG_ENGINE_STRICT=true \
    NPM_CONFIG_UPDATE_NOTIFIER=false \
    npm install --global --prefix /usr/local "${packages[0]}"
[ -x /usr/local/bin/heddle-server ] \
    || err "Heddle was not installed at /usr/local/bin/heddle-server."

printf -v quoted_state '%q' "${STATEPATH}"
printf -v quoted_port '%q' "${PORT}"
cat >/usr/local/bin/heddle-service <<EOF
#!/usr/bin/env bash
set -euo pipefail

state_path=${quoted_state}
mountpoint -q "\${state_path}" || {
    echo "[heddle] ERROR: \${state_path} must be a dedicated bind mount." >&2
    exit 1
}

export HEDDLE_STATE_PATH="\${state_path}"
export HEDDLE_HOST=127.0.0.1
export HEDDLE_PORT=${quoted_port}
exec /usr/local/bin/heddle-server
EOF
chmod 0755 /usr/local/bin/heddle-service

service_dir=/etc/s6-overlay/s6-rc.d/heddle
install -d -m 0755 "${service_dir}/dependencies.d"
printf 'longrun\n' >"${service_dir}/type"
touch "${service_dir}/dependencies.d/base"
printf -v quoted_user '%q' "${service_user}"
cat >"${service_dir}/run" <<EOF
#!/command/with-contenv bash
exec s6-setuidgid ${quoted_user} /usr/local/bin/heddle-service
EOF
chmod 0755 "${service_dir}/run"
touch /etc/s6-overlay/user-bundles.d/user/contents.d/heddle

if [ -n "${DNSNAME}" ]; then
    cat >/etc/caddy/conf.d/heddle.caddy <<EOF
${DNSNAME} {
    reverse_proxy 127.0.0.1:${PORT}
}
EOF
    chmod 0644 /etc/caddy/conf.d/heddle.caddy
    printf '%s\n' "${DNSNAME}" >/etc/caddy/required-hosts.d/heddle.host
    chmod 0644 /etc/caddy/required-hosts.d/heddle.host
    log "Configured https://${DNSNAME} for Heddle on 127.0.0.1:${PORT}."
fi

runuser -u "${service_user}" -- env \
    HEDDLE_STATE_PATH="${STATEPATH}" \
    HEDDLE_PORT=0 \
    /usr/local/bin/heddle-server --help >/dev/null 2>&1 &
smoke_pid=$!
sleep 1
kill "${smoke_pid}" >/dev/null 2>&1 || true
wait "${smoke_pid}" >/dev/null 2>&1 || true
log "Installed Heddle for ${service_user}."
