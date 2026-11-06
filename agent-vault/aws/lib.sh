# Shared helpers for aws/*.sh and the GitHub workflows (sourced).
export AWS_REGION=us-east-1 AWS_DEFAULT_REGION=us-east-1
ZONE_NAME=example.com
# Stack output: out <stack> <key>  (empty if stack/output missing)
out() { aws cloudformation describe-stacks --stack-name "$1" --query "Stacks[0].Outputs[?OutputKey=='$2'].OutputValue | [0]" --output text 2>/dev/null | grep -v '^None$' || true; }
stack_exists() { aws cloudformation describe-stacks --stack-name "$1" >/dev/null 2>&1; }
zone_id() {
  [ -n "${ZONE_ID:-}" ] && { echo "$ZONE_ID"; return; }
  aws route53 list-hosted-zones-by-name --dns-name "$ZONE_NAME." \
    --query "HostedZones[?Name=='$ZONE_NAME.' && Config.PrivateZone==\`false\`].Id | [0]" --output text | sed 's#/hostedzone/##'
}
