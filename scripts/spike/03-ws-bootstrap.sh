#!/usr/bin/env bash
# The one-call bootstrap path the analysis describes — works, but only over
# the /ws Effect-RPC socket (see ws-dispatch.mjs for the frame format).
# Creates thread + worktree + first prompt in a single dispatchCommand.
set -euo pipefail
source "$(dirname "$0")/lib.sh"

PROMPT="${1:-Create a file ws-bootstrap.txt containing the word ok and nothing else.}"
PROJECT_ID=$(cat "$SCRATCH/project-id.txt")
TID=$(uuidgen)

PAYLOAD=$(jq -n --arg cid "$(uuidgen)" --arg tid "$TID" --arg mid "$(uuidgen)" \
  --arg pid "$PROJECT_ID" --arg cwd "$SCRATCH/target-repo" \
  --arg prompt "$PROMPT" --arg br "spike/ws-$(date +%s)" --arg t "$(now)" '{
  type:"thread.turn.start", commandId:$cid, threadId:$tid,
  message:{messageId:$mid, role:"user", text:$prompt, attachments:[]},
  modelSelection:{instanceId:"claudeAgent", model:"claude-haiku-4-5"},
  titleSeed:"ws bootstrap spike",
  runtimeMode:"auto-accept-edits", interactionMode:"default",
  bootstrap:{
    createThread:{projectId:$pid, title:"ws bootstrap spike",
      modelSelection:{instanceId:"claudeAgent", model:"claude-haiku-4-5"},
      runtimeMode:"auto-accept-edits", interactionMode:"default",
      branch:"main", worktreePath:null, createdAt:$t},
    prepareWorktree:{projectCwd:$cwd, baseBranch:"main", branch:$br},
    runSetupScript:true},
  createdAt:$t}')

node "$(dirname "$0")/ws-dispatch.mjs" "${T3_WS_URL:-ws://127.0.0.1:3799/ws}" \
  "$(tok)" "orchestration.dispatchCommand" "$PAYLOAD"
echo "$TID"
