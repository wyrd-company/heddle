#!/usr/bin/env bash
# Step 0: install latest released t3 locally and start an isolated server.
# Never touches the global t3 install or ~/.t3.
set -euo pipefail
source "$(dirname "$0")/lib.sh"

mkdir -p "$SCRATCH/t3-local"
cd "$SCRATCH/t3-local"
[ -f package.json ] || npm init -y >/dev/null
npm install t3@0.0.35
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

echo "Start the server with:"
echo "  T3CODE_HOME=$SCRATCH/t3-home $SCRATCH/t3-local/node_modules/.bin/t3 serve \\"
echo "    --port 3799 --host 127.0.0.1 --base-dir $SCRATCH/t3-home $SCRATCH/target-repo"
