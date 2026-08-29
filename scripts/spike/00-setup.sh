#!/usr/bin/env bash
# Step 0: install latest released t3 locally and start an isolated server.
# Never touches the global t3 install or ~/.t3.
set -euo pipefail
source "$(dirname "$0")/lib.sh"

mkdir -p "$SCRATCH/t3-local"
cd "$SCRATCH/t3-local"
[ -f package.json ] || npm init -y >/dev/null
npm install t3@0.0.36
npm rebuild node-pty   # install scripts are blocked by allowScripts; pty must be rebuilt

# Throwaway target repo with generic content
if [ ! -d "$SCRATCH/target-repo/.git" ]; then
  mkdir -p "$SCRATCH/target-repo"
  cd "$SCRATCH/target-repo"
  git init -q -b main
  echo "sample project" > README.md
  mkdir -p src && echo 'print("sample")' > src/app.py
  git add -A && git -c user.email=dev@example.com -c user.name=Dev commit -qm "initial commit"
fi

# Cursor is off by default (contracts/src/settings.ts: enabled defaults false,
# "Users opt in from Settings"). Enable it in the isolated server's settings.json
# before first start so the instance registry hydrates a "cursor" instance.
# CURSOR_BINARY lets the operator point at a wrapper that injects
# CURSOR_API_KEY (interactive login state is not visible to a headless spawn).
CURSOR_BINARY="${CURSOR_BINARY:-cursor-agent}"
mkdir -p "$SCRATCH/t3-home/userdata"
jq -n --arg bin "$CURSOR_BINARY" \
  '{providers:{cursor:{enabled:true, binaryPath:$bin}}}' \
  > "$SCRATCH/t3-home/userdata/settings.json"

echo "Start the server with:"
echo "  T3CODE_HOME=$SCRATCH/t3-home $SCRATCH/t3-local/node_modules/.bin/t3 serve \\"
echo "    --port 3801 --host 127.0.0.1 --base-dir $SCRATCH/t3-home $SCRATCH/target-repo"
