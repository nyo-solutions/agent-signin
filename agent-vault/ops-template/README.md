# Vault ops repo template

Keep your deployments in a small **private** repo so run logs (which include AWS stack
output) are never public. Copy `.github/` from here into it; the workflows call the
reusable ones in this repository.

1. Create a private repo, e.g. `your-org/vault-ops`, and copy `.github/` into it.
2. On your Mac, set `GITHUB_REPO=your-org/vault-ops` (plus `VAULT_DOMAIN`, `ZONE_NAME`) in
   `agent-vault/local.env`, then run `agent-vault/aws/setup-github.sh [alert-email]`.
   It creates the OIDC role trusted only by that repo's `main` branch and sets the repo
   variables `AWS_ROLE_ARN`, `AWS_ZONE_ID`, `VAULT_DOMAIN`, `ZONE_NAME` (and `ALERT_EMAIL`).
3. Run **Deploy** from the ops repo's Actions tab. **Backup** runs weekly on its own.

Pin `@main` to a tag or commit SHA if you want deployments to change only when you choose.
