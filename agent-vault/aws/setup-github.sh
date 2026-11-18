#!/bin/bash
# One-time: let GitHub Actions in your (private) ops repo deploy with short-lived AWS credentials
# (OIDC, no stored keys), and store the repo variables the workflows need.
# Needs: admin AWS credentials and `gh auth login` with access to the repo.
# Usage: ./setup-github.sh [alert-email-for-$5-budget]
set -euo pipefail
cd "$(dirname "$0")"; source lib.sh
REPO=${GITHUB_REPO:?set GITHUB_REPO=owner/repo in agent-vault/local.env (the repo whose workflows deploy)}
ACCOUNT=$(aws sts get-caller-identity --query Account --output text)
./bootstrap.sh
PROVIDER=$(aws iam list-open-id-connect-providers --query "OpenIDConnectProviderList[?ends_with(Arn, 'token.actions.githubusercontent.com')].Arn | [0]" --output text | grep -v '^None$' || true)
# GitHub may send an immutable subject (repo:org@id/repo@id); trust exactly what it sends.
SUB=$(gh api "repos/$REPO/actions/oidc/customization/sub" --jq 'if .use_immutable_subject then .sub_claim_prefix else empty end' 2>/dev/null || true)
SUB=${SUB:-repo:$REPO}; echo "GitHub OIDC subject: $SUB:ref:refs/heads/main"
CTX=(-c githubRepo="$REPO" -c githubSubPrefix="$SUB"); [ -n "$PROVIDER" ] && { echo "Reusing GitHub OIDC provider $PROVIDER"; CTX+=(-c oidcProviderArn="$PROVIDER"); }
CDK_DEFAULT_ACCOUNT=$ACCOUNT npx cdk deploy AgentVaultGithub "${CTX[@]}"
ROLE=$(out AgentVaultGithub RoleArn)
gh variable set AWS_ROLE_ARN --repo "$REPO" --body "$ROLE"
gh variable set AWS_ZONE_ID --repo "$REPO" --body "$(zone_id)"
[ -n "${1:-}" ] && gh variable set ALERT_EMAIL --repo "$REPO" --body "$1"
gh variable set VAULT_DOMAIN --repo "$REPO" --body "$VAULT_DOMAIN"
gh variable set ZONE_NAME --repo "$REPO" --body "$ZONE_NAME"
echo "GitHub Actions in $REPO can now use $ROLE. Add the caller workflows from agent-vault/ops-template/ to it."
