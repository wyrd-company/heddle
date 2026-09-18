#!/usr/bin/env bash

set -e

# shellcheck disable=SC1091
source dev-container-features-test-lib

check "Heddle command exists globally" test -x /usr/local/bin/heddle
check "packed Heddle command prints help" /usr/local/bin/heddle --help
check "service launcher is executable" test -x /usr/local/bin/heddle-service
check "s6 service is a longrun" grep -qx longrun /etc/s6-overlay/s6-rc.d/heddle/type
check "s6 service depends on base" test -f /etc/s6-overlay/s6-rc.d/heddle/dependencies.d/base
check "s6 service is in the user bundle" test -f /etc/s6-overlay/user-bundles.d/user/contents.d/heddle
check "launcher runs heddle start" grep -q '^exec /usr/local/bin/heddle start' /usr/local/bin/heddle-service
check "launcher carries config path" grep -q -- '--config /etc/heddle/config.yml' /usr/local/bin/heddle-service
check "launcher carries state path" grep -q -- '--state /var/lib/heddle' /usr/local/bin/heddle-service
check "launcher carries GitHub credential path" grep -q -- '--github-app-credentials /run/secrets/heddle-github-app.yml' /usr/local/bin/heddle-service
check "launcher carries T3 token path" grep -q -- '--t3-token /run/secrets/heddle-t3-token' /usr/local/bin/heddle-service
check "launcher carries webhook secret path" grep -q -- '--webhook-secret /run/secrets/heddle-webhook-secret' /usr/local/bin/heddle-service
check "default service configuration exists" test -r /etc/heddle/config.yml
check "s6 longrun stays up, stops cleanly, and restarts" ./check-longrun.sh

reportResults
