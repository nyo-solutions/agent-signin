# Shared settings for agent-vault scripts (sourced, not executed).
AV_HOME="$HOME/projects/agent-vault"
BW_BIN="/opt/homebrew/bin/bw"
MCP_PKG="@bitwarden/mcp-server@2026.7.0"   # pinned; bump deliberately
KC_SERVICE="agent-vault-bw-session"         # BW_SESSION (read by bin/bitwarden-mcp)
KC_CLIENTID="agent-vault-bw-clientid"       # Bitwarden personal API key (machine login)
KC_CLIENTSECRET="agent-vault-bw-clientsecret"
TOUCHID="$AV_HOME/bin/vault-touchid"        # master password behind Touch ID
# GUI apps (Claude Desktop, launchd) get a bare PATH, so spell it out.
export PATH="/opt/homebrew/bin:/usr/local/bin:$HOME/.local/share/fnm/aliases/default/bin:/usr/bin:/bin:/usr/sbin:/sbin"

# Which vault: "local" (Docker on this Mac) or "aws" (Lambda). Set by aws/migrate.sh.
VW_TARGET="$(cat "$AV_HOME/target" 2>/dev/null || echo local)"

if [ "$VW_TARGET" = "aws" ]; then
  VW_HOST="vault.example.com"
  VW_URL="https://$VW_HOST"
  CURL_TLS=()                                # public certificate (ACM)
else
  VW_DATA="$HOME/.vaultwarden-data"
  VW_HOST="passman.internal"
  VW_URL="https://$VW_HOST"
  VW_CA="$VW_DATA/ssl/ca.crt"
  CURL_TLS=(--cacert "$VW_CA")
  export NODE_EXTRA_CA_CERTS="$VW_CA"
  VW_IP_WANTED="127.0.0.8"
  # Bind to 127.0.0.8 once the loopback alias exists (install-hostname-and-ca.sh), else 127.0.0.1.
  if /sbin/ifconfig lo0 2>/dev/null | grep -q "inet $VW_IP_WANTED "; then VW_IP="$VW_IP_WANTED"; else VW_IP="127.0.0.1"; fi
fi
