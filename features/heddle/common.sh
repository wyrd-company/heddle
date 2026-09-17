#!/usr/bin/env bash

# ---
# relationships:
#   implements: github-binding-and-intake
# ---

log() {
    printf '[heddle] %s\n' "$*"
}

err() {
    printf '[heddle] ERROR: %s\n' "$*" >&2
    exit 1
}

require_root() {
    [ "$(id -u)" -eq 0 ] || err "This Feature must run as root."
}

check_debian_family() {
    [ -r /etc/os-release ] || err "Unable to detect Linux distribution."
    local identity
    # shellcheck disable=SC1091
    identity="$(. /etc/os-release; printf '%s %s' "${ID:-}" "${ID_LIKE:-}")"
    case "${identity}" in
        *debian*|*ubuntu*) ;;
        *) err "This Feature supports Debian/Ubuntu-based images." ;;
    esac
}

ensure_s6_overlay() {
    local required_path
    for required_path in \
        /init \
        /command/s6-rc \
        /etc/s6-overlay/s6-rc.d \
        /etc/s6-overlay/user-bundles.d/user/contents.d; do
        [ -e "${required_path}" ] \
            || err "This Feature requires an s6-overlay 3 image with /init as PID 1."
    done
}

pick_service_user() {
    local requested="${1:-automatic}"
    local candidate
    if [ -n "${requested}" ] && [ "${requested}" != automatic ] && [ "${requested}" != auto ]; then
        id -u "${requested}" >/dev/null 2>&1 \
            || err "Requested service user '${requested}' does not exist."
        printf '%s\n' "${requested}"
        return
    fi
    for candidate in "${_REMOTE_USER:-}" "${_CONTAINER_USER:-}" vscode root; do
        if [ -n "${candidate}" ] && id -u "${candidate}" >/dev/null 2>&1; then
            printf '%s\n' "${candidate}"
            return
        fi
    done
    err "Unable to resolve a service user."
}

validate_absolute_path() {
    local option_name="$1"
    local path="$2"
    [[ "${path}" = /* ]] || err "${option_name} must be an absolute path."
    case "${path}" in
        *$'\n'*|*$'\r'*) err "${option_name} contains unsupported characters." ;;
    esac
}
