#!/bin/bash
# Deploy (or update) the vault from your Mac. GitHub Actions does the same via .github/workflows/deploy.yml.
# Usage: ./deploy.sh [alert-email-for-$5-budget]
set -euo pipefail
cd "$(dirname "$0")"; source lib.sh
ACCOUNT=$(aws sts get-caller-identity --query Account --output text)
ZID=$(zone_id); [ -n "$ZID" ] && [ "$ZID" != "None" ] || { echo "No public hosted zone for $ZONE_NAME" >&2; exit 1; }
echo "AWS account: $ACCOUNT  region: $AWS_REGION  zone: $ZID"
docker info >/dev/null 2>&1 || { echo "Docker must be running (the Lambda image is built locally)." >&2; exit 1; }
./bootstrap.sh
./scripts/extract-web-vault.sh
CTX=(-c zoneId="$ZID"); [ -n "${1:-}" ] && CTX+=(-c alertEmail="$1")
CDK_DEFAULT_ACCOUNT=$ACCOUNT npx cdk deploy AgentVaultData AgentVault "${CTX[@]}"
URL=$(out AgentVault Url)
echo "Waiting for $URL ..."
for _ in $(seq 1 30); do curl -fs --max-time 15 "$URL/alive" >/dev/null 2>&1 && { echo "$URL is live."; exit 0; }; sleep 10; done
echo "Deployed, but $URL is not answering yet (DNS can take a few minutes)." >&2
