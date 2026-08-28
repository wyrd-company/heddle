#!/usr/bin/env bash
# Create the T3 project for the scratch repo via HTTP dispatch (works fine —
# only turn-start *bootstrap* is WS-gated, not project.create).
set -euo pipefail
source "$(dirname "$0")/lib.sh"

PID=$(uuidgen)
dispatch "$(jq -n --arg cid "$(uuidgen)" --arg pid "$PID" \
  --arg root "$SCRATCH/target-repo" --arg t "$(now)" '{
  type:"project.create", commandId:$cid, projectId:$pid,
  title:"Spike Target", workspaceRoot:$root, createdAt:$t}')"
echo "$PID" | tee "$SCRATCH/project-id.txt"
