#!/bin/sh
# Runs the STEVE CNC connector as a systemd service that starts at boot (no login needed), as the user who runs
# this script, restarting it if it stops. Needs sudo for /etc/systemd/system.
#   ./service/linux/install.sh [config.json] [data]
# Logs: journalctl -u steve-cnc-connector -f   (and <data>/connector.log)
# Remove: ./service/linux/uninstall.sh
set -e
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
CONFIG="${1:-config.json}"
DATA="${2:-data}"
UNITNAME="steve-cnc-connector"
NODE="$(command -v node)" || { echo "node not found on PATH"; exit 1; }
"$NODE" -e 'const [a, b] = process.versions.node.split(".").map(Number); process.exit(a > 22 || (a === 22 && b >= 12) ? 0 : 1)' ||
  { echo "Node $("$NODE" -v) is too old: the remote screen needs Node 22.12 or later"; exit 1; }
[ -f "$ROOT/$CONFIG" ] || { echo "No $CONFIG in $ROOT: copy config.example.json and fill it in."; exit 1; }
[ -f "$ROOT/$DATA/state.json" ] || { echo "Not paired yet. Run 'node connector.js --pair <CODE>' once first."; exit 1; }
[ -d "$ROOT/node_modules/rfb2" ] || { echo "Run 'npm ci --omit=dev' in $ROOT first."; exit 1; }
RUNAS="$(id -un)"
# systemd unit quoting: wrap each argument in double quotes, escape \ and ", and double % (systemd specifiers).
q() { printf '"%s"' "$(printf '%s' "$1" | sed -e 's/\\/\\\\/g' -e 's/"/\\"/g' -e 's/%/%%/g')"; }
# WorkingDirectory= takes the rest of the line as the path, unquoted (systemd 245 refuses quotes there).
p() { printf '%s' "$1" | sed -e 's/%/%%/g'; }
TMP="$(mktemp)"
cat > "$TMP" <<UNIT
[Unit]
Description=STEVE connector for the shop's CNC machines
Wants=network-online.target
After=network-online.target

[Service]
User=$RUNAS
WorkingDirectory=$(p "$ROOT")
Environment=$(q "PATH=$(dirname "$NODE"):/usr/local/bin:/usr/bin:/bin")
Environment=$(q "HOME=$HOME")
ExecStart=$(q "$NODE") $(q "$ROOT/connector.js") --config $(q "$CONFIG") --data $(q "$DATA")
Restart=always
RestartSec=10
NoNewPrivileges=true
PrivateTmp=true
ProtectSystem=full

[Install]
WantedBy=multi-user.target
UNIT
sudo install -m 644 "$TMP" "/etc/systemd/system/$UNITNAME.service"
rm -f "$TMP"
sudo systemctl daemon-reload
sudo systemctl enable --now "$UNITNAME"
echo "Installed and started $UNITNAME (as $RUNAS). Logs: journalctl -u $UNITNAME -f (and $ROOT/$DATA/connector.log)"
