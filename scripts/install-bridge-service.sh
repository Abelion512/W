#!/usr/bin/env bash
# SPDX-License-Identifier: GPL-3.0-or-later
# Install bridge.py as a systemd --user service so it starts at login and is
# restarted automatically after a crash. Uses an env file for the workspace root
# and token settings; nothing secret is written into the unit itself.
set -eu

REPO_DIR="$(cd -- "$(dirname "$0")/.." && pwd)"
UNIT_DIR="${XDG_CONFIG_HOME:-$HOME/.config}/systemd/user"
ENV_DIR="${XDG_CONFIG_HOME:-$HOME/.config}/snapgent"
UNIT="$UNIT_DIR/snapgent-bridge.service"
ENV_FILE="$ENV_DIR/bridge.env"

command -v systemctl >/dev/null 2>&1 || {
    echo "systemctl not found. Use scripts/bridge-supervise.sh on this host." >&2
    exit 1
}

PYTHON_BIN="${PYTHON_BIN:-python3}"
command -v "$PYTHON_BIN" >/dev/null 2>&1 || PYTHON_BIN=python
PYTHON_PATH="$(command -v "$PYTHON_BIN")"

mkdir -p "$UNIT_DIR" "$ENV_DIR"

if [ ! -f "$ENV_FILE" ]; then
    cat > "$ENV_FILE" <<EOF
# Workspace root the MCP server is scoped to. Change if needed.
# Workspace root is read from config.json; change it with switch-project.sh.
# Optional: pin the bridge port, A2A timeout and token file location.
# ZS_BRIDGE_PORT=17613
# ZS_A2A_TIMEOUT_MS=1800000
EOF
    echo "Created $ENV_FILE - review it before starting the service."
fi

cat > "$UNIT" <<EOF
[Unit]
Description=Snapgent Web AI bridge
After=network-online.target
Wants=network-online.target
# A bad config must not spin forever: give up after 5 restarts in 60s.
StartLimitBurst=5
StartLimitIntervalSec=60

[Service]
Type=simple
WorkingDirectory=$REPO_DIR
EnvironmentFile=-$ENV_FILE
Environment=PYTHONUNBUFFERED=1
ExecStart=$PYTHON_PATH $REPO_DIR/bridge.py
Restart=always
RestartSec=3

[Install]
WantedBy=default.target
EOF

systemctl --user daemon-reload
systemctl --user enable --now snapgent-bridge.service
echo "Installed and started snapgent-bridge.service."
echo "  status: systemctl --user status snapgent-bridge.service"
echo "  logs:   journalctl --user -u snapgent-bridge.service -f"
