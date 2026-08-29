#!/usr/bin/env bash
# Step 4: cursor question round-trip over plain HTTP.
#   prompt -> cursor/ask_question -> hasPendingUserInput on the shell poll ->
#   thread.user-input.respond -> user-input.resolved in thread activities.
#
# Answers record shape (matches the web client, apps/web/src/pendingUserInput.ts):
#   { "<question.id>": "<option label>" }         single-select
#   { "<question.id>": ["<label>", ...] }         multiSelect
#   { "<question.id>": "<free text>" }            custom answer
#
# NOTE: as of this spike Cursor's backend does not put the AskQuestion tool in
# the session toolset, so the real agent answers in plain text and this script
# times out waiting for waiting_for_input. To prove the T3 round-trip anyway,
# start a turn whose prompt contains [SPIKE-ASK-QUESTION]: cursor-acp-shim.mjs
# then emits the byte-exact cursor/ask_question request itself and logs T3's
# response to $SPIKE_SHIM_LOG. See docs/spikes/cursor-headless.md step 4.
#
# Usage: 05-user-input.sh [answer-label]
set -euo pipefail
source "$(dirname "$0")/lib.sh"

ANSWER="${1:-Option B}"
PROMPT='Before doing anything else, use your question tool to ask me whether to proceed with option A or option B. Offer exactly two options labeled "Option A" and "Option B". After I answer, create a file named choice.txt containing only the exact label I chose, then finish.'

TID=$("$(dirname "$0")/02-start-turn.sh" "$PROMPT")
echo "threadId=$TID"

wait_phase "$TID" waiting_for_input 120

# The pending request lives in the thread snapshot activities.
REQ=$(thread_snapshot "$TID" | jq '[.thread.activities[]
  | select(.kind == "user-input.requested")][-1]')
echo "$REQ" | jq .
REQUEST_ID=$(echo "$REQ" | jq -r '.payload.requestId')
QID=$(echo "$REQ" | jq -r '.payload.questions[0].id')

dispatch "$(jq -n --arg cid "$(uuidgen)" --arg tid "$TID" --arg rid "$REQUEST_ID" \
  --arg qid "$QID" --arg ans "$ANSWER" --arg t "$(now)" '{
  type:"thread.user-input.respond", commandId:$cid, threadId:$tid,
  requestId:$rid, answers:{($qid): $ans}, createdAt:$t}')"
echo

wait_phase "$TID" completed 120

thread_snapshot "$TID" | jq '[.thread.activities[]
  | select(.kind | startswith("user-input"))
  | {kind, payload}]'
echo "$TID"
