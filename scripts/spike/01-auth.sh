#!/usr/bin/env bash
# Step 1: obtain a bearer token headlessly, both ways.
#   a) same-machine shortcut: t3 auth session issue
#   b) service path: t3 pair -> RFC 8693 token exchange at POST /oauth/token
set -euo pipefail
source "$(dirname "$0")/lib.sh"

T3_BIN="$SCRATCH/t3-local/node_modules/.bin/t3"

echo "== a) CLI-issued admin session (writes directly to the auth store) =="
"$T3_BIN" auth session issue --base-dir "$SCRATCH/t3-home" --label spike-admin --json |
  jq '{scopes, expiresAt}'

echo "== b) pair -> /oauth/token exchange (what a long-lived service uses) =="
PAIR_TOKEN=$("$T3_BIN" pair --base-dir "$SCRATCH/t3-home" --ttl 10m --label spike 2>/dev/null |
  grep -oP 'Token: \K\S+')
curl -s -X POST "$T3_URL/oauth/token" \
  -H 'Content-Type: application/x-www-form-urlencoded' \
  --data-urlencode 'grant_type=urn:ietf:params:oauth:grant-type:token-exchange' \
  --data-urlencode "subject_token=$PAIR_TOKEN" \
  --data-urlencode 'subject_token_type=urn:t3:params:oauth:token-type:environment-bootstrap' \
  --data-urlencode 'requested_token_type=urn:ietf:params:oauth:token-type:access_token' \
  --data-urlencode 'client_label=spike-service' > "$SCRATCH/oauth-exchange.json"
jq '{token_type, expires_in, scope}' "$SCRATCH/oauth-exchange.json"
jq -r .access_token "$SCRATCH/oauth-exchange.json" > "$TOKEN_FILE"
echo "token written to $TOKEN_FILE"
