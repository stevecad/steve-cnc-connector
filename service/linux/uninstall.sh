#!/bin/sh
# Stops the STEVE CNC connector service and removes it. Its folder, config and data (its key) stay.
set -e
UNITNAME="steve-cnc-connector"
sudo systemctl disable --now "$UNITNAME" 2>/dev/null || true
sudo rm -f "/etc/systemd/system/$UNITNAME.service"
sudo systemctl daemon-reload
echo "Removed $UNITNAME."
