#!/usr/bin/env bash
set -euo pipefail
ROOT="$(cd "$(dirname "$0")" && pwd)"
cd "$ROOT"

VENV="$ROOT/tools/jlink_flasher/.venv"
VENV_PY="$VENV/bin/python"

if [[ ! -x "$VENV_PY" ]]; then
  echo "Creating virtual environment..."
  if command -v python3 >/dev/null 2>&1; then
    PY=python3
  elif command -v python >/dev/null 2>&1; then
    PY=python
  else
    echo "Python 3 is not installed or not on PATH."
    echo "Install Python 3 then run this again."
    echo "SEGGER J-Link software is also required: https://www.segger.com/downloads/jlink/"
    exit 1
  fi
  "$PY" -m venv "$VENV"
fi

echo "Installing J-Link flasher dependencies..."
"$VENV_PY" -m pip install -q -r tools/jlink_flasher/requirements.txt
exec "$VENV_PY" -m tools.jlink_flasher "$@"
