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
ensure_apt_packages build-essential ca-certificates jq python3

[[ "${CONFIGDIRECTORY}" = /* ]] \
    || err "configDirectory must be an absolute path."
case "${CONFIGDIRECTORY}" in
    *$'\n'*|*$'\r'*) err "configDirectory contains unsupported characters." ;;
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
install -d -m 0750 -o "${service_user}" -g "${service_group}" "${CONFIGDIRECTORY}"

shopt -s nullglob
packages=("$(dirname "$0")"/heddle-*.tgz)
shopt -u nullglob
[ "${#packages[@]}" -eq 1 ] \
    || err "The Feature must contain exactly one packaged Heddle release."

log "Installing the packaged Heddle release"
env \
    NPM_CONFIG_ENGINE_STRICT=true \
    NPM_CONFIG_UPDATE_NOTIFIER=false \
    npm install --global --prefix /usr/local \
        --allow-scripts=better-sqlite3 \
        "${packages[0]}"
[ -x /usr/local/bin/heddle-server ] \
    || err "Heddle was not installed at /usr/local/bin/heddle-server."

printf -v quoted_config '%q' "${CONFIGDIRECTORY}"
printf -v quoted_dns '%q' "${DNSNAME}"
printf -v quoted_user '%q' "${service_user}"
install -D -m 0755 \
    "$(dirname "$0")/check-kanban-version.sh" \
    /usr/local/libexec/heddle/check-kanban-version
cat >/usr/local/bin/heddle-service <<EOF
#!/usr/bin/env bash
set -euo pipefail

config_directory=${quoted_config}
dns_name=${quoted_dns}
expected_kanban_version=0.37.0-fork+b9fc380
/usr/local/libexec/heddle/check-kanban-version "\${expected_kanban_version}"
launch_settings="\$(s6-setuidgid ${quoted_user} \
    /usr/local/bin/heddle-server \
    --config "\${config_directory}" \
    --print-launch-settings)"
state_path="\$(jq -er '.stateDirectory' <<<"\${launch_settings}")"
host="\$(jq -er '.host' <<<"\${launch_settings}")"
port="\$(jq -er '.port' <<<"\${launch_settings}")"
mountpoint -q "\${state_path}" || {
    echo "[heddle] ERROR: \${state_path} must be a dedicated bind mount." >&2
    exit 1
}

if [ -n "\${dns_name}" ]; then
    caddy_temp="\$(mktemp /etc/caddy/conf.d/heddle.caddy.XXXXXX)"
    printf '%s {\n    reverse_proxy %s:%s\n}\n' \
        "\${dns_name}" "\${host}" "\${port}" >"\${caddy_temp}"
    chmod 0644 "\${caddy_temp}"
    mv "\${caddy_temp}" /etc/caddy/conf.d/heddle.caddy
    if ! timeout --signal=TERM --kill-after=1 10 \
        bash -c 'until /usr/local/bin/caddy-reload >/dev/null 2>&1; do sleep 0.1; done'; then
        echo "[heddle] ERROR: Caddy did not accept the configured Heddle endpoint." >&2
        exit 1
    fi
fi

exec s6-setuidgid ${quoted_user} \
    /usr/local/bin/heddle-server --config "\${config_directory}"
EOF
chmod 0755 /usr/local/bin/heddle-service

service_dir=/etc/s6-overlay/s6-rc.d/heddle
install -d -m 0755 "${service_dir}/dependencies.d"
printf 'longrun\n' >"${service_dir}/type"
touch "${service_dir}/dependencies.d/base"
cat >"${service_dir}/run" <<EOF
#!/command/with-contenv bash
exec /usr/local/bin/heddle-service
EOF
chmod 0755 "${service_dir}/run"
touch /etc/s6-overlay/user-bundles.d/user/contents.d/heddle

if [ -n "${DNSNAME}" ]; then
    printf '%s\n' "${DNSNAME}" >/etc/caddy/required-hosts.d/heddle.host
    chmod 0644 /etc/caddy/required-hosts.d/heddle.host
    log "Configured https://${DNSNAME} for the config.yml Heddle endpoint."
fi

runuser -u "${service_user}" -- env \
    /usr/local/bin/heddle-server --help >/dev/null 2>&1 &
smoke_pid=$!
sleep 1
kill "${smoke_pid}" >/dev/null 2>&1 || true
wait "${smoke_pid}" >/dev/null 2>&1 || true
log "Installed Heddle for ${service_user}."
