#!/bin/bash
# Install (or move) the 5-minute watchdog LaunchAgent for this checkout.
set -euo pipefail
source "$(dirname "$0")/../env.sh"
PL="$HOME/Library/LaunchAgents/com.agent-vault.watchdog.plist"
mkdir -p "$HOME/Library/LaunchAgents"
sed -e "s#__AV_HOME__#$AV_HOME#g" -e "s#__HOME__#$HOME#g" "$AV_HOME/launchd/com.agent-vault.watchdog.plist" > "$PL"
launchctl bootout "gui/$(id -u)" "$PL" 2>/dev/null || true
launchctl bootstrap "gui/$(id -u)" "$PL"
echo "watchdog installed: $PL -> $AV_HOME/bin/vaultwarden-watchdog.sh"
