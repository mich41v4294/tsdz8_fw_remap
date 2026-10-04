#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/webapp"
PORT="${PORT:-8080}"

if command -v python3 >/dev/null 2>&1; then
  PY=python3
elif command -v python >/dev/null 2>&1; then
  PY=python
else
  echo "Python 3 is required. Install it from https://www.python.org" >&2
  exit 1
fi

URL="http://localhost:${PORT}"
echo "Opening ${URL}"
if command -v open >/dev/null 2>&1; then
  open "$URL" || true
elif command -v xdg-open >/dev/null 2>&1; then
  xdg-open "$URL" || true
fi
echo "Starting the patcher. Leave this terminal open. Ctrl+C to stop."
export PORT
exec "$PY" serve.py
