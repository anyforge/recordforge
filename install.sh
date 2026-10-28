#!/usr/bin/env bash
set -euo pipefail

# One-click install for recordforge: checks Node, installs deps, links the CLI.
# On Windows, run the equivalent manually:  npm install && npm link
#
# This script installs from a source checkout. If recordforge is published to
# npm, the one-liner is simply:   npm install -g @anyforgex/recordforge

echo "==> recordforge: one-click install"

if ! command -v node >/dev/null 2>&1; then
  echo "error: Node.js 18+ is required — install from https://nodejs.org" >&2
  exit 1
fi

NODE_MAJOR="$(node -p "process.versions.node.split('.')[0]")"
if [ "$NODE_MAJOR" -lt 18 ]; then
  echo "error: Node.js 18+ required (found $(node -v))" >&2
  exit 1
fi

cd "$(dirname "$0")"
npm install
echo ""

if npm link; then
  echo ""
  echo "==> recordforge installed. Try:  recordforge --help"
else
  echo ""
  echo "==> npm link failed (permissions?). Run it via:  node \"$(pwd)/bin/recordforge.js\" --help"
fi
