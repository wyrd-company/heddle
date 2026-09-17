#!/usr/bin/env bash

set -euo pipefail

# ---
# relationships:
#   implements:
#     - engine-and-run-model
#     - github-binding-and-intake
# ---

# shellcheck disable=SC1091
source "$(dirname "$0")/common.sh"

require_root
check_debian_family
ensure_s6_overlay

validate_absolute_path configFile "${CONFIGFILE}"
validate_absolute_path stateDirectory "${STATEDIRECTORY}"
validate_absolute_path githubAppCredentialsFile "${GITHUBAPPCREDENTIALSFILE}"
validate_absolute_path t3CodeTokenFile "${T3CODETOKENFILE}"
validate_absolute_path webhookSecretFile "${WEBHOOKSECRETFILE}"

service_user="$(pick_service_user "${SERVICEUSER}")"
service_group="$(id -gn "${service_user}")"

install -d -m 0755 "$(dirname "${CONFIGFILE}")"
install -d -m 0750 -o "${service_user}" -g "${service_group}" "${STATEDIRECTORY}"
install -d -m 0755 "$(dirname "${GITHUBAPPCREDENTIALSFILE}")"
install -d -m 0755 "$(dirname "${T3CODETOKENFILE}")"
install -d -m 0755 "$(dirname "${WEBHOOKSECRETFILE}")"

feature_directory="$(dirname "$0")"
package_path="$(find_single_package "${feature_directory}")"

install_log="$(mktemp)"
cleanup() {
    rm -f "${install_log}"
}
trap cleanup EXIT

log "Installing the packed Heddle package"
if ! env \
    NPM_CONFIG_ENGINE_STRICT=true \
    NPM_CONFIG_UPDATE_NOTIFIER=false \
    npm install --global --prefix /usr/local --ignore-scripts \
        --no-audit --no-fund "${package_path}" >"${install_log}" 2>&1; then
    cat "${install_log}" >&2
    err "Heddle package installation failed."
fi
[ -x /usr/local/bin/heddle ] \
    || err "Heddle was not installed at /usr/local/bin/heddle."

printf -v quoted_config '%q' "${CONFIGFILE}"
printf -v quoted_state '%q' "${STATEDIRECTORY}"
printf -v quoted_github_credentials '%q' "${GITHUBAPPCREDENTIALSFILE}"
printf -v quoted_t3_token '%q' "${T3CODETOKENFILE}"
printf -v quoted_webhook_secret '%q' "${WEBHOOKSECRETFILE}"

cat >/usr/local/bin/heddle-service <<EOF
#!/usr/bin/env bash
set -euo pipefail

exec /usr/local/bin/heddle start \\
    --config ${quoted_config} \\
    --state ${quoted_state} \\
    --github-app-credentials ${quoted_github_credentials} \\
    --t3-token ${quoted_t3_token} \\
    --webhook-secret ${quoted_webhook_secret}
EOF
chmod 0755 /usr/local/bin/heddle-service

service_directory=/etc/s6-overlay/s6-rc.d/heddle
install -d -m 0755 "${service_directory}/dependencies.d"
printf 'longrun\n' >"${service_directory}/type"
touch "${service_directory}/dependencies.d/base"
printf -v quoted_user '%q' "${service_user}"
cat >"${service_directory}/run" <<EOF
#!/command/with-contenv bash
exec s6-setuidgid ${quoted_user} /usr/local/bin/heddle-service
EOF
chmod 0755 "${service_directory}/run"
touch /etc/s6-overlay/user-bundles.d/user/contents.d/heddle

/usr/local/bin/heddle --help >/dev/null
log "Installed Heddle for ${service_user}."
