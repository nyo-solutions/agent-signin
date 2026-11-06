#!/bin/bash
# Run after a reboot (or any time agents report a locked vault).
#  1. local target: makes sure Docker + Vaultwarden are up; aws: checks it answers
#  2. logs bw in (API key from Keychain, or email+password) and unlocks it
#     (master password via Touch ID if saved, else typed)
#  3. stores BW_SESSION in the macOS login Keychain (read by bin/bitwarden-mcp)
#  4. re-applies the Claude Desktop / Claude Code MCP config (idempotent)
# Flags: --test  also create/verify the "Test Automation" TOTP item
set -euo pipefail
source "$(dirname "$0")/env.sh"
TEST=false; [ "${1:-}" = "--test" ] && TEST=true
kc_get() { security find-generic-password -s "$1" -a "$USER" -w 2>/dev/null || true; }
kc_put() { security add-generic-password -U -s "$1" -a "$USER" -l "$2" -w "$3"; }

# 1. Server reachable?
if [ "$VW_TARGET" = "local" ]; then
  if ! docker info >/dev/null 2>&1; then
    echo "Starting Docker Desktop..."; open -ga Docker
    for _ in $(seq 1 90); do docker info >/dev/null 2>&1 && break; sleep 2; done
  fi
  docker inspect vaultwarden >/dev/null 2>&1 || "$AV_HOME/bin/vaultwarden-up.sh"
  docker start vaultwarden >/dev/null
  for _ in $(seq 1 30); do curl -fs --resolve $VW_HOST:443:$VW_IP ${CURL_TLS[@]+"${CURL_TLS[@]}"} "$VW_URL/alive" >/dev/null && break; sleep 1; done
fi
if ! curl -fs --max-time 20 ${CURL_TLS[@]+"${CURL_TLS[@]}"} "$VW_URL/alive" >/dev/null 2>&1; then
  if [ "$VW_TARGET" = "local" ] && ! dscacheutil -q host -a name "$VW_HOST" | grep -q ip_address; then
    echo "$VW_HOST does not resolve. Run first: $AV_HOME/install-hostname-and-ca.sh" >&2
  else
    echo "$VW_URL is not answering ($VW_TARGET vault)." >&2
  fi
  exit 1
fi
echo "Vault server OK: $VW_URL ($VW_TARGET)"

# 2a. Point bw at the right server (changing servers requires a logout).
if [ "$("$BW_BIN" config server 2>/dev/null)" != "$VW_URL" ]; then
  "$BW_BIN" logout >/dev/null 2>&1 || true
  "$BW_BIN" config server "$VW_URL" >/dev/null
  echo "bw now targets $VW_URL"
fi

existing=$(kc_get "$KC_SERVICE")
if [ -n "$existing" ] && "$BW_BIN" status --session "$existing" 2>/dev/null | grep -q '"status":"unlocked"'; then
  echo "Vault already unlocked; reusing stored session."
  BW_SESSION="$existing"
else
  # 2b. Log in if needed.
  status=$("$BW_BIN" status 2>/dev/null | sed -n 's/.*"status":"\([a-z]*\)".*/\1/p')
  if [ "$status" = "unauthenticated" ]; then
    cid=$(kc_get "$KC_CLIENTID"); csec=$(kc_get "$KC_CLIENTSECRET")
    if [ -z "$cid" ] || [ -z "$csec" ]; then
      echo "Log in with: [1] personal API key (recommended; web vault > Settings > Security > Keys)"
      echo "             [2] email + master password (+ two-factor)"
      read -rp "Choice [1]: " how
      if [ "${how:-1}" = "1" ]; then
        read -rp "client_id: " cid
        read -rsp "client_secret: " csec; echo
        kc_put "$KC_CLIENTID" "Bitwarden API key client_id (agent-vault)" "$cid"
        kc_put "$KC_CLIENTSECRET" "Bitwarden API key client_secret (agent-vault)" "$csec"
        echo "API key stored in Keychain."
      fi
    fi
    if [ -n "$cid" ] && [ -n "$csec" ]; then
      BW_CLIENTID="$cid" BW_CLIENTSECRET="$csec" "$BW_BIN" login --apikey >/dev/null
      echo "Logged in with API key."
    else
      read -rp "Vaultwarden account email: " email
      "$BW_BIN" login "$email"   # interactive: master password + two-factor prompts
    fi
    unset cid csec
  fi

  # 2c. Unlock: Touch ID first, typed password as fallback.
  BW_SESSION=""
  if [ -x "$TOUCHID" ] && "$TOUCHID" exists; then
    echo "Unlocking with Touch ID..."
    if BW_PASSWORD=$("$TOUCHID" get); then
      export BW_PASSWORD
      BW_SESSION=$("$BW_BIN" unlock --passwordenv BW_PASSWORD --raw 2>/dev/null || true)
      unset BW_PASSWORD
      [ -n "$BW_SESSION" ] || echo "Saved master password was rejected; it may have changed." >&2
    fi
  fi
  if [ -z "$BW_SESSION" ]; then
    read -rsp "Vaultwarden master password: " BW_PASSWORD; echo; export BW_PASSWORD
    BW_SESSION=$("$BW_BIN" unlock --passwordenv BW_PASSWORD --raw || true)
    [ -n "$BW_SESSION" ] || { unset BW_PASSWORD; echo "Unlock failed." >&2; exit 1; }
    if [ -x "$TOUCHID" ]; then
      read -rp "Save master password for Touch ID unlock next time? [y/N] " yn
      if [[ "$yn" =~ ^[Yy]$ ]]; then printf '%s' "$BW_PASSWORD" | "$TOUCHID" store >/dev/null && echo "Saved (Touch ID required to read it)."; fi
    fi
    unset BW_PASSWORD
  fi
  # 3. Keychain (-U updates in place)
  kc_put "$KC_SERVICE" "Bitwarden CLI session (agent-vault)" "$BW_SESSION"
  echo "Session stored in Keychain item '$KC_SERVICE'."
fi
"$BW_BIN" sync --session "$BW_SESSION" >/dev/null && echo "Vault synced."

# 4. MCP client configs
/usr/bin/python3 "$AV_HOME/configure-mcp-clients.py"

if $TEST; then
  if ! "$BW_BIN" get item "Test Automation" --session "$BW_SESSION" >/dev/null 2>&1; then
    "$BW_BIN" get template item --session "$BW_SESSION" \
      | jq '.name="Test Automation" | .login={"username":"testuser","password":"SuperSecretPassword123!","totp":"JBSWY3DPEHPK3PXP","uris":[]} | .notes=null' \
      | "$BW_BIN" encode | "$BW_BIN" create item --session "$BW_SESSION" >/dev/null
    echo "Created 'Test Automation' item."
  fi
  code=$("$BW_BIN" get totp "Test Automation" --session "$BW_SESSION")
  [[ "$code" =~ ^[0-9]{6}$ ]] && echo "TOTP OK: $code" || { echo "TOTP check failed: $code" >&2; exit 1; }
fi
echo "Done. Restart Claude Desktop if it was already running."
