#!/bin/zsh
# Double-click launcher for FrameConverter (dev).
# It installs dependencies on first run, then starts `tauri:dev`.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
cd "$SCRIPT_DIR"

if ! command -v npm >/dev/null 2>&1; then
  echo "npm not found. Please install Node.js first."
  read -r "?Press Enter to exit..."
  exit 1
fi

if [[ ! -d "node_modules" ]]; then
  echo "node_modules not found. Running npm install..."
  npm install
fi

npm run tauri:dev

