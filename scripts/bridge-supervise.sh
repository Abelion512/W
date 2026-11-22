#!/usr/bin/env bash
# SPDX-License-Identifier: GPL-3.0-or-later
# Minimal supervisor for bridge.py on hosts without systemd. Keeps the bridge
# alive across crashes; it does NOT retry a config error forever (three fast
# exits in a row stop the loop with a clear message).
set -u

REPO_DIR="$(cd -- "$(dirname "$0")/.." && pwd)"
cd -- "$REPO_DIR" || exit 1

PYTHON_BIN="${PYTHON_BIN:-python3}"
command -v "$PYTHON_BIN" >/dev/null 2>&1 || PYTHON_BIN=python
MAX_FAST_EXITS=3
FAILURES=0
RESTART_DELAY="${ZS_BRIDGE_RESTART_DELAY:-2}"

while true; do
    "$PYTHON_BIN" bridge.py
    code=$?
    if [[ "$code" -eq 0 ]]; then
        echo "bridge exited cleanly; stopping supervisor" >&2
        exit 0
    fi
    FAILURES=$((FAILURES + 1))
    echo "bridge exited with $code (fast exits: $FAILURES); restarting in ${RESTART_DELAY}s" >&2
    if [[ "$FAILURES" -ge "$MAX_FAST_EXITS" ]]; then
        echo "bridge failed $MAX_FAST_EXITS times in a row. Check logs/start.log and config, then run this script again." >&2
        exit "$code"
    fi
    sleep "$RESTART_DELAY"
done
