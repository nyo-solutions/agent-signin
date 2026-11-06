#!/bin/bash
# Copy the local vault (~/.vaultwarden-data) into the AWS vault, then switch the
# agent-vault scripts to it. Run after ./deploy.sh. Safe to re-run (replaces AWS data).
set -euo pipefail
cd "$(dirname "$0")"
source lib.sh
AV="$HOME/projects/agent-vault"; SRC="$HOME/.vaultwarden-data"
BUCKET=$(out AgentVaultData TransferBucket); MIGRATE_FN=$(out AgentVaultData MigrateFunction)
VW_FN=$(out AgentVault VaultwardenFunction); URL=$(out AgentVault Url)
[ -n "$BUCKET" ] && [ -n "$VW_FN" ] || { echo "Deploy first (./deploy.sh or the Deploy workflow)." >&2; exit 1; }

WORK=$(mktemp -d); trap 'rm -rf "$WORK"' EXIT
BK="$HOME/.vaultwarden-backups"; mkdir -p "$BK"; chmod 700 "$BK"
sqlite3 "$SRC/db.sqlite3" ".backup '$WORK/db.sqlite3'"          # consistent copy while running
sqlite3 "$WORK/db.sqlite3" "PRAGMA journal_mode=DELETE;" >/dev/null  # WAL is unsafe on EFS
cp "$SRC/rsa_key.pem" "$WORK/"
for d in attachments sends; do [ -d "$SRC/$d" ] && cp -R "$SRC/$d" "$WORK/"; done
[ "$(sqlite3 "$WORK/db.sqlite3" 'PRAGMA integrity_check;')" = ok ] || { echo "Local DB copy failed integrity check" >&2; exit 1; }
USERS=$(sqlite3 "$WORK/db.sqlite3" "select count(*) from users;")
ITEMS=$(sqlite3 "$WORK/db.sqlite3" "select count(*) from ciphers;")
SNAP="$BK/vault-pre-migrate-$(date +%Y%m%d-%H%M%S).tar.gz"
echo "Local vault: $USERS user(s), $ITEMS item(s)"
KEY="import/vault-$(date +%Y%m%d-%H%M%S).tar.gz"
(cd "$WORK" && COPYFILE_DISABLE=1 tar --no-mac-metadata -czf payload.tar.gz $(ls | grep -v payload))
cp "$WORK/payload.tar.gz" "$SNAP"; chmod 600 "$SNAP"; echo "Local backup: $SNAP"
aws s3 cp --only-show-errors --sse AES256 "$WORK/payload.tar.gz" "s3://$BUCKET/$KEY"

echo "Importing into EFS..."
aws lambda invoke --function-name "$MIGRATE_FN" --cli-binary-format raw-in-base64-out \
  --payload "{\"action\":\"import\",\"key\":\"$KEY\"}" "$WORK/out.json" >/dev/null
if jq -e '.errorMessage' "$WORK/out.json" >/dev/null; then jq . "$WORK/out.json" >&2; exit 1; fi
R_USERS=$(jq .users "$WORK/out.json"); R_ITEMS=$(jq .items "$WORK/out.json"); R_OK=$(jq -r .integrity "$WORK/out.json")
echo "AWS vault: $R_USERS user(s), $R_ITEMS item(s), integrity=$R_OK"
if [ "$R_USERS" != "$USERS" ] || [ "$R_ITEMS" != "$ITEMS" ] || [ "$R_OK" != ok ]; then
  echo "MISMATCH - not switching to AWS. Your local vault is untouched." >&2; exit 1
fi

# Recycle warm Vaultwarden instances so they reopen the new database.
ENV=$(aws lambda get-function-configuration --function-name "$VW_FN" --query Environment.Variables --output json \
  | jq -c --arg t "$(date +%s)" '{Variables: (. + {MIGRATED_AT: $t})}')
aws lambda update-function-configuration --function-name "$VW_FN" --environment "$ENV" >/dev/null
aws lambda wait function-updated --function-name "$VW_FN"
curl -fsS -o /dev/null -w "$URL/alive -> %{http_code}\n" "$URL/alive"

echo aws > "$AV/target"
echo "agent-vault scripts now target $URL."
read -rp "Stop the local Docker vault now (recommended, avoids two diverging vaults)? [y/N] " yn
if [[ "$yn" =~ ^[Yy]$ ]]; then
  docker update --restart=no vaultwarden >/dev/null && docker stop vaultwarden >/dev/null && echo "Local vault stopped (data kept in $SRC)."
fi
echo "Next: $AV/refresh-agent-session.sh --test   (logs bw in to the AWS vault)"
