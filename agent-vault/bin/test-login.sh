#!/bin/bash
# Check email + master password against the current vault server WITHOUT touching
# the agents' session: uses a throw-away bw profile that is deleted afterwards.
# Usage: bin/test-login.sh [email]
source "$(dirname "$0")/../env.sh"
TMP=$(mktemp -d); trap 'BITWARDENCLI_APPDATA_DIR=$TMP "$BW_BIN" logout >/dev/null 2>&1; rm -rf "$TMP"' EXIT
export BITWARDENCLI_APPDATA_DIR="$TMP"
"$BW_BIN" config server "$VW_URL" >/dev/null 2>&1
email=${1:-}; [ -n "$email" ] || read -rp "Email: " email
read -rsp "Master password: " BW_PASSWORD; echo; export BW_PASSWORD
echo "Testing against $VW_URL (password length: ${#BW_PASSWORD} characters)"
if out=$("$BW_BIN" login "$email" --passwordenv BW_PASSWORD --raw 2>&1); then
  echo "RESULT: password is CORRECT - the server accepted it."
else
  echo "RESULT: login FAILED: $(echo "$out" | grep -v '^\s*at ' | head -2)"
fi
unset BW_PASSWORD
