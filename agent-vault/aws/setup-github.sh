#!/bin/bash
# One-time: let GitHub Actions in nyo-solutions/agent-vault deploy with short-lived AWS credentials
# (OIDC, no stored keys), and store the repo variables the workflows need.
# Needs: admin AWS credentials and `gh auth login` with access to the repo.
# Usage: ./setup-github.sh [alert-email-for-$5-budget]
set -euo pipefail
cd "$(dirname "$0")"; source lib.sh
REPO=nyo-solutions/agent-vault
ACCOUNT=$(aws sts get-caller-identity --query Account --output text)
./bootstrap.sh
PROVIDER=$(aws iam list-open-id-connect-providers --query "OpenIDConnectProviderList[?ends_with(Arn, 'token.actions.githubusercontent.com')].Arn | [0]" --output text | grep -v '^None$' || true)
CTX=(-c githubRepo="$REPO"); [ -n "$PROVIDER" ] && { echo "Reusing GitHub OIDC provider $PROVIDER"; CTX+=(-c oidcProviderArn="$PROVIDER"); }
CDK_DEFAULT_ACCOUNT=$ACCOUNT npx cdk deploy AgentVaultGithub "${CTX[@]}"
ROLE=$(out AgentVaultGithub RoleArn)
gh variable set AWS_ROLE_ARN --repo "$REPO" --body "$ROLE"
gh variable set AWS_ZONE_ID --repo "$REPO" --body "$(zone_id)"
[ -n "${1:-}" ] && gh variable set ALERT_EMAIL --repo "$REPO" --body "$1"
echo "GitHub Actions can now use $ROLE. Run the 'Deploy' workflow, or push to main."
