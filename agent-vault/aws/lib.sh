# Shared helpers for aws/*.sh and the GitHub workflows (sourced).
export AWS_REGION=us-east-1 AWS_DEFAULT_REGION=us-east-1
# Domain settings come from the environment (workflows) or ../local.env (your Mac).
[ -f "$(dirname "${BASH_SOURCE[0]}")/../local.env" ] && source "$(dirname "${BASH_SOURCE[0]}")/../local.env"
ZONE_NAME=${ZONE_NAME:-}
export VAULT_DOMAIN ZONE_NAME
# Stack output: out <stack> <key>  (empty if stack/output missing)
out() { aws cloudformation describe-stacks --stack-name "$1" --query "Stacks[0].Outputs[?OutputKey=='$2'].OutputValue | [0]" --output text 2>/dev/null | grep -v '^None$' || true; }
stack_exists() { aws cloudformation describe-stacks --stack-name "$1" >/dev/null 2>&1; }
zone_id() {
  [ -n "${ZONE_ID:-}" ] && { echo "$ZONE_ID"; return; }
  [ -n "$ZONE_NAME" ] || { echo "ZONE_NAME is not set (agent-vault/local.env)" >&2; return 1; }
  aws route53 list-hosted-zones-by-name --dns-name "$ZONE_NAME." \
    --query "HostedZones[?Name=='$ZONE_NAME.' && Config.PrivateZone==\`false\`].Id | [0]" --output text | sed 's#/hostedzone/##'
}
