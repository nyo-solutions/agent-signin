#!/bin/bash
# One-time (and after CDK upgrades that need a newer bootstrap): prepare the account for CDK.
# Needs admin credentials, so it runs from your Mac, not GitHub. Repairs the stuck state we hit
# on 2026-11-06 (CDKToolkit UPDATE_ROLLBACK_FAILED because its version parameter was deleted).
set -euo pipefail
cd "$(dirname "$0")"; source lib.sh
ACCOUNT=$(aws sts get-caller-identity --query Account --output text)
PARAM=/cdk-bootstrap/hnb659fds/version
if stack_exists CDKToolkit; then
  status=$(aws cloudformation describe-stacks --stack-name CDKToolkit --query 'Stacks[0].StackStatus' --output text)
  if ! aws ssm get-parameter --name "$PARAM" >/dev/null 2>&1; then
    ver=$(out CDKToolkit BootstrapVersion); ver=${ver:-1}
    echo "Repairing: recreating $PARAM=$ver"
    aws ssm put-parameter --name "$PARAM" --type String --value "$ver" >/dev/null
  fi
  if [ "$status" = "UPDATE_ROLLBACK_FAILED" ]; then
    echo "Repairing: finishing stuck CDKToolkit rollback"
    aws cloudformation continue-update-rollback --stack-name CDKToolkit
    aws cloudformation wait stack-rollback-complete --stack-name CDKToolkit
  fi
fi
[ -d node_modules ] || npm ci
CDK_DEFAULT_ACCOUNT=$ACCOUNT npx cdk bootstrap "aws://$ACCOUNT/$AWS_REGION"
