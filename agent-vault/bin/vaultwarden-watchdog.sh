#!/bin/bash
# Run by launchd every 5 min: make sure Docker Desktop and the container are up.
source "$(dirname "$0")/../env.sh"
if [ "$VW_TARGET" = "local" ]; then
if ! docker info >/dev/null 2>&1; then
  pgrep -xq "Docker Desktop" || open -ga Docker
  exit 0   # next tick will handle the container
fi
state=$(docker inspect -f '{{.State.Status}}' vaultwarden 2>/dev/null || echo missing)
case "$state" in
  running)
    bound=$(docker inspect -f '{{(index (index .HostConfig.PortBindings "80/tcp") 0).HostIp}}' vaultwarden)
    [ "$bound" = "$VW_IP" ] || { echo "$(date) rebinding $bound -> $VW_IP"; "$AV_HOME/bin/vaultwarden-up.sh"; } ;;
  missing) echo "$(date) container missing; recreating"; "$AV_HOME/bin/vaultwarden-up.sh" ;;
  *)       echo "$(date) container $state; starting"; docker start vaultwarden >/dev/null ;;
esac
fi

# Re-assert MCP entries (Claude Desktop sometimes rewrites its config file).
/usr/bin/python3 "$AV_HOME/configure-mcp-clients.py" | grep -v "already configured" || true
