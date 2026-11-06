#!/bin/bash
# One-time admin step (asks for your macOS password via sudo). Safe to re-run.
#  1. adds loopback alias 127.0.0.8 now + at every boot (LaunchDaemon)
#  2. maps $VW_HOST -> 127.0.0.8 in /etc/hosts (drops older passman.* entries)
#  3. trusts the current name-constrained local CA system-wide and removes
#     earlier agent-vault CAs. The CA can only vouch for $VW_HOST, localhost,
#     127.0.0.1 and 127.0.0.8.
#  4. (re)starts Vaultwarden on 127.0.0.8:443
set -euo pipefail
source "$(dirname "$0")/env.sh"
SYS=/Library/Keychains/System.keychain
PL=/Library/LaunchDaemons/com.agent-vault.lo0-alias.plist
sudo cp "$AV_HOME/launchd/com.agent-vault.lo0-alias.plist" "$PL"
sudo chown root:wheel "$PL"; sudo chmod 644 "$PL"
sudo launchctl bootout system "$PL" 2>/dev/null || true
sudo launchctl bootstrap system "$PL"
sleep 1; /sbin/ifconfig lo0 | grep -q "inet 127.0.0.8 " && echo "lo0 alias 127.0.0.8 active"

sudo sed -i '' -E '/[[:space:]]passman\.(test|local|internal)$/d' /etc/hosts
echo "127.0.0.8 $VW_HOST" | sudo tee -a /etc/hosts >/dev/null
sudo dscacheutil -flushcache; sudo killall -HUP mDNSResponder || true
echo "/etc/hosts: 127.0.0.8 $VW_HOST"

new_sha=$(openssl x509 -in "$VW_CA" -noout -fingerprint -sha1 | cut -d= -f2 | tr -d :)
for sha in $(security find-certificate -a -c "Agent Vault Local CA" -Z "$SYS" 2>/dev/null | awk '/SHA-1 hash:/{print $3}'); do
  [ "$sha" = "$new_sha" ] || { sudo security delete-certificate -Z "$sha" "$SYS" && echo "removed old CA $sha"; }
done
sudo security add-trusted-cert -d -r trustRoot -k "$SYS" "$VW_CA"
echo "trusted CA $new_sha"

"$AV_HOME/bin/vaultwarden-up.sh"
curl -fsS -o /dev/null -w "$VW_URL OK (%{http_code}) with system trust\n" "$VW_URL/alive"
