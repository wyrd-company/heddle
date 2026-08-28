#!/usr/bin/env bash
# Step 2 over plain HTTP — the decomposed sequence that actually works.
#
# NOTE: sending thread.turn.start WITH a bootstrap block to
# POST /api/orchestration/dispatch FAILS ("Thread ... does not exist"):
# bootstrap expansion (create thread, prepare worktree, setup script) lives in
# the WS dispatchCommand handler (apps/server/src/ws.ts), not in the engine the
# HTTP route calls. Over HTTP the caller owns worktree prep and thread.create.
#
# Usage: 02-start-turn.sh <prompt> [runtimeMode] [model]
set -euo pipefail
source "$(dirname "$0")/lib.sh"

PROMPT="$1"
RUNTIME_MODE="${2:-auto-accept-edits}"   # "auto" fails: t3 0.0.35 maps it to a
                                         # claude permissionMode "auto" that
                                         # claude CLI 2.1.250 rejects
MODEL="${3:-claude-haiku-4-5}"
INSTANCE_ID="${INSTANCE_ID:-claudeAgent}"
PROJECT_ID=$(cat "$SCRATCH/project-id.txt")

# Heddle-side worktree prep (what WS bootstrap would have done for us)
N=$(date +%s)
WT="$SCRATCH/worktrees/wt-$N"
git -C "$SCRATCH/target-repo" worktree add -b "spike/wt-$N" "$WT" main >/dev/null

TID=$(uuidgen)
dispatch "$(jq -n --arg cid "$(uuidgen)" --arg tid "$TID" --arg pid "$PROJECT_ID" \
  --arg wt "$WT" --arg br "spike/wt-$N" --arg t "$(now)" \
  --arg mode "$RUNTIME_MODE" --arg model "$MODEL" --arg iid "$INSTANCE_ID" '{
  type:"thread.create", commandId:$cid, threadId:$tid, projectId:$pid,
  title:"spike thread",
  modelSelection:{instanceId:$iid, model:$model},
  runtimeMode:$mode, interactionMode:"default",
  branch:$br, worktreePath:$wt, createdAt:$t}')" >/dev/null

dispatch "$(jq -n --arg cid "$(uuidgen)" --arg tid "$TID" --arg mid "$(uuidgen)" \
  --arg prompt "$PROMPT" --arg t "$(now)" \
  --arg mode "$RUNTIME_MODE" --arg model "$MODEL" --arg iid "$INSTANCE_ID" '{
  type:"thread.turn.start", commandId:$cid, threadId:$tid,
  message:{messageId:$mid, role:"user", text:$prompt, attachments:[]},
  modelSelection:{instanceId:$iid, model:$model},
  runtimeMode:$mode, interactionMode:"default", createdAt:$t}')" >/dev/null

echo "$TID"
