#!/usr/bin/env bash

set -e

# shellcheck disable=SC1091
source dev-container-features-test-lib

check "custom config path is preserved" grep -q -- '--config /mnt/config/service.yml' /usr/local/bin/heddle-service
check "custom state path is preserved" grep -q -- '--state /mnt/state' /usr/local/bin/heddle-service
check "custom GitHub credential path is preserved" grep -q -- '--github-app-credentials /mnt/secrets/github-app.yml' /usr/local/bin/heddle-service
check "custom T3 token path is preserved" grep -q -- '--t3-token /mnt/secrets/t3-token' /usr/local/bin/heddle-service
check "custom webhook secret path is preserved" grep -q -- '--webhook-secret /mnt/secrets/webhook-secret' /usr/local/bin/heddle-service
check "custom state directory is owned by the non-root service user" test "$(stat -c '%U' /mnt/state)" = vscode
check "s6 launches as the non-root service user" grep -q '^exec s6-setuidgid vscode ' /etc/s6-overlay/s6-rc.d/heddle/run
check "custom-path longrun remains up" bash -c 'sleep 2; s6-svstat /run/service/heddle | grep -q "up (pid"'

reportResults
