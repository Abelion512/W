#!/usr/bin/env bash
# Refresh the model/cost catalog daily so routing never drifts to paid tiers.
set -eu
REPO_DIR="$(cd -- "$(dirname "$0")/.." && pwd)"
UNIT_DIR="${XDG_CONFIG_HOME:-$HOME/.config}/systemd/user"
mkdir -p "$UNIT_DIR"
cat > "$UNIT_DIR/snapgent-model-catalog.service" <<EOF
[Service]
Type=oneshot
WorkingDirectory=$REPO_DIR
ExecStart=/usr/bin/python3 $REPO_DIR/scripts/refresh-model-catalog.py
EOF
cat > "$UNIT_DIR/snapgent-model-catalog.timer" <<EOF
[Unit]
Description=Refresh snapgent model catalog daily
[Timer]
OnCalendar=*-*-* 03:17:00
Persistent=true
Unit=snapgent-model-catalog.service
[Install]
WantedBy=timers.target
EOF
systemctl --user daemon-reload
systemctl --user enable --now snapgent-model-catalog.timer
echo "Installed daily model-catalog timer. Next run: $(systemctl --user list-timers snapgent-model-catalog.timer --no-pager | tail -1)"
