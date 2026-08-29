# Shared helpers for the T3 headless spike. Source this file.
# Requires: curl, jq, uuidgen. Token file produced by 01-auth.sh.

SPIKE_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
SCRATCH="$SPIKE_ROOT/.spike-scratch"
T3_URL="${T3_URL:-http://127.0.0.1:3801}"
TOKEN_FILE="$SCRATCH/token.txt"

tok() { cat "$TOKEN_FILE"; }

now() { date -u +%Y-%m-%dT%H:%M:%S.000Z; }

# dispatch <json-command>
dispatch() {
  curl -s -X POST "$T3_URL/api/orchestration/dispatch" \
    -H "Authorization: Bearer $(tok)" \
    -H 'Content-Type: application/json' \
    -d "$1"
}

shell_snapshot() {
  curl -s "$T3_URL/api/orchestration/shell" -H "Authorization: Bearer $(tok)"
}

thread_snapshot() {
  curl -s "$T3_URL/api/orchestration/threads/$1" -H "Authorization: Bearer $(tok)"
}

# awareness_phase <threadId> — reimplementation of
# packages/shared/src/agentAwareness.ts resolveThreadAwarenessPhase over the
# polled shell snapshot. Prints one of: waiting_for_approval, waiting_for_input,
# failed, starting, running, completed, none.
awareness_phase() {
  shell_snapshot | jq -r --arg tid "$1" '
    ([.threads[] | select(.id == $tid)][0]) as $t
    | if $t == null then "no-thread"
      elif $t.hasPendingApprovals then "waiting_for_approval"
      elif $t.hasPendingUserInput then "waiting_for_input"
      elif ($t.session.status == "error") or ($t.latestTurn.state == "error") then "failed"
      elif $t.session.status == "starting" then "starting"
      elif ($t.session.status == "running") or ($t.latestTurn.state == "running") then "running"
      elif $t.latestTurn.state == "completed" then "completed"
      elif ($t.latestTurn.state == "interrupted") and ($t.latestTurn.completedAt != null) then "completed"
      elif ($t.session.status == "ready") or ($t.session.status == "idle") then "completed"
      else "none"
      end'
}

# wait_phase <threadId> <phase> [timeout-seconds]
wait_phase() {
  local tid="$1" want="$2" timeout="${3:-120}" i=0 p
  while [ "$i" -lt "$timeout" ]; do
    p="$(awareness_phase "$tid")"
    echo "  [$i s] phase=$p" >&2
    [ "$p" = "$want" ] && return 0
    sleep 3; i=$((i+3))
  done
  echo "timeout waiting for phase=$want (last=$p)" >&2
  return 1
}
