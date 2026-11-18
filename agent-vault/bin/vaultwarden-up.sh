#!/bin/bash
# (Re)create the Vaultwarden container. Usage: vaultwarden-up.sh [--signups]
# Signups are OFF by default; pass --signups only while creating your account.
set -euo pipefail
source "$(dirname "$0")/../env.sh"
SIGNUPS=false; [ "${1:-}" = "--signups" ] && SIGNUPS=true
docker rm -f vaultwarden >/dev/null 2>&1 || true
docker run -d --name vaultwarden --restart unless-stopped \
  -v "$VW_DATA":/data \
  -p "$VW_IP":443:80 \
  -e SIGNUPS_ALLOWED=$SIGNUPS \
  -e DOMAIN="$VW_URL" \
  -e ROCKET_TLS='{certs="/data/ssl/vw.crt",key="/data/ssl/vw.key"}' \
  vaultwarden/server:latest >/dev/null
for _ in $(seq 1 30); do
  curl -fs --resolve $VW_HOST:443:$VW_IP --cacert "$VW_CA" "$VW_URL/alive" >/dev/null 2>&1 && { echo "Vaultwarden up at $VW_URL (signups=$SIGNUPS)"; exit 0; }
  sleep 1
done
echo "Vaultwarden did not become healthy" >&2; exit 1
