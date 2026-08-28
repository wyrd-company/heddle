#!/usr/bin/env bash
# Steps 4-6 building blocks: steer, approval respond, interrupt, session stop.
# All plain HTTP against POST /api/orchestration/dispatch.
# Usage:
#   04-steer-approve-lifecycle.sh steer <threadId> <text>
#   04-steer-approve-lifecycle.sh approve <threadId> [decision]   # latest pending request
#   04-steer-approve-lifecycle.sh interrupt <threadId>
#   04-steer-approve-lifecycle.sh stop <threadId>
#   04-steer-approve-lifecycle.sh phase <threadId>
set -euo pipefail
source "$(dirname "$0")/lib.sh"

ACTION="$1"; TID="$2"

case "$ACTION" in
  steer)
    # A second thread.turn.start on a running thread, no bootstrap: queues the
    # text into the running turn as an extra user message.
    dispatch "$(jq -n --arg cid "$(uuidgen)" --arg tid "$TID" --arg mid "$(uuidgen)" \
      --arg text "$3" --arg t "$(now)" '{
      type:"thread.turn.start", commandId:$cid, threadId:$tid,
      message:{messageId:$mid, role:"user", text:$text, attachments:[]},
      runtimeMode:"auto-accept-edits", interactionMode:"default", createdAt:$t}')"
    ;;
  approve)
    RID=$(thread_snapshot "$TID" |
      jq -r '[.thread.activities[] | select(.kind=="approval.requested")][-1].payload.requestId')
    dispatch "$(jq -n --arg cid "$(uuidgen)" --arg tid "$TID" --arg rid "$RID" \
      --arg d "${3:-accept}" --arg t "$(now)" '{
      type:"thread.approval.respond", commandId:$cid, threadId:$tid,
      requestId:$rid, decision:$d, createdAt:$t}')"
    ;;
  interrupt)
    dispatch "$(jq -n --arg cid "$(uuidgen)" --arg tid "$TID" --arg t "$(now)" \
      '{type:"thread.turn.interrupt", commandId:$cid, threadId:$tid, createdAt:$t}')"
    ;;
  stop)
    dispatch "$(jq -n --arg cid "$(uuidgen)" --arg tid "$TID" --arg t "$(now)" \
      '{type:"thread.session.stop", commandId:$cid, threadId:$tid, createdAt:$t}')"
    ;;
  phase)
    awareness_phase "$TID"
    ;;
  *) echo "unknown action $ACTION" >&2; exit 2 ;;
esac
