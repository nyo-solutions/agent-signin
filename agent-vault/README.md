# agent-vault

Self-hosted [Vaultwarden](https://github.com/dani-garcia/vaultwarden) for you and your AI agents.
Agents (Claude Desktop, Claude Code) sign in through [agent-autofill](../agent-autofill): it fills
approved logins from one vault folder straight into the browser, so agents never receive passwords or
TOTP codes.

- **Vault:** your own domain (`VAULT_DOMAIN`), AWS Lambda + EFS in us-east-1, ~$0–1/month
- **Clients:** Bitwarden browser extension, desktop app, mobile apps → "Self-hosted" → your vault URL
- **Agents:** session key lives in the macOS Keychain; nothing secret is in any config file or in this repo

## Settings

Copy `local.env.example` to `local.env` (gitignored) and set `VAULT_DOMAIN`, `ZONE_NAME` (a Route 53
public hosted zone you own) and `GITHUB_REPO` (the private ops repo that may deploy, see below).

## GitHub Actions (in your private ops repo)

The workflows in this repository's `.github/workflows/vault-*.yml` are **reusable**. Call them from a
small private repo so run logs, which contain AWS stack output, are never public:
[`ops-template/`](ops-template) has the caller workflows to copy. Account id, domain and zone id are also
masked in logs.

| Workflow | When | What |
|---|---|---|
| **Deploy** | manually | builds the image, deploys `AgentVaultData` + `AgentVault`, smoke-tests the URL. Tick **signups** to allow creating an account, then run it again unticked |
| **Backup** | Sundays 03:00 UTC, or manually | consistent export to the transfer bucket (`exports/`, kept 30 days) |
| **Restore backup** | manually (type `restore`) | safety export, then replaces vault data with a chosen export |
| **Take vault offline (keep data)** | manually (type `destroy`) | backup, then removes the public endpoint/Lambda/cert/DNS. Data stays; **Deploy** brings it back |
| **Remove vault (DELETES DATA)** | manually (type `delete <your vault domain>`) | deletes both stacks, the EFS data, the transfer bucket, optionally the AWS Backup snapshots |

Besides the weekly export, EFS has automatic **daily AWS Backup snapshots kept 35 days**.
Before *Remove vault*, also take an encrypted export from the web vault (Tools → Export vault).

Workflows authenticate to AWS with GitHub OIDC (role `agent-vault-github`, trusted only for `main`
of your ops repo); no AWS keys are stored in GitHub.

## Stacks (`aws/`, CDK TypeScript)

| Stack | Contents | Destroyed by |
|---|---|---|
| `AgentVaultData` | VPC (no NAT/egress), EFS (encrypted, retained), backups, transfer bucket, migrate/backup function | Remove vault only |
| `AgentVault` | CloudFront (custom domain) → S3 for the web vault's `*.js`/`*.wasm` (too big for Lambda's 6 MB limit) and → HTTP API (throttled 20 rps) → Vaultwarden Lambda (Web Adapter, arm64) for everything else; ACM cert, Route 53 record, optional $5 budget | Take offline / Remove vault |
| `AgentVaultGithub` | GitHub OIDC provider + deploy role | manual (`npx cdk destroy AgentVaultGithub`) |

## One-time setup (from your Mac, needs admin AWS credentials)

```bash
cd aws
./setup-github.sh [budget-alert-email]   # bootstrap CDK, create the GitHub deploy role, set repo variables
```
Then run **Deploy** in GitHub (or `./deploy.sh` locally), then move your data and log the agents in:
```bash
./migrate.sh                              # local backup → copy to EFS → verify counts → switch scripts to AWS
../refresh-agent-session.sh --test        # API-key login, unlock, save for Touch ID, TOTP check
```

## Repeat from your Mac when needed

| Task | Command | When |
|---|---|---|
| Unlock the vault for agents | `./refresh-agent-session.sh` | after every reboot (one Touch ID tap) |
| Re-bootstrap CDK | `aws/bootstrap.sh` | if a CDK upgrade asks for it; also repairs a broken `CDKToolkit` automatically |
| Rebuild the Touch ID helper | `touchid/build.sh`, then unlock once with the password and choose *save* | after changing `touchid/main.swift` |
| Rotate the API key | web vault → Settings → Security → Keys → rotate; then `security delete-generic-password -s agent-vault-bw-clientid` (and `-clientsecret`) and run the refresh script | if the key may have leaked |

These stay local on purpose: they need your master password, Touch ID, your Mac's Keychain or admin AWS rights.

## Local scripts

| File | Purpose |
|---|---|
| `env.sh` | shared settings; `target` file picks `local` or `aws` (written by `migrate.sh`) |
| `refresh-agent-session.sh` | login (API key) + unlock (Touch ID) → `BW_SESSION` into Keychain |
| `bin/vault-touchid` (built from `touchid/`) | master password in Keychain, readable only by this binary after Touch ID |
| `configure-mcp-clients.py` | idempotently registers agent-autofill in Claude Desktop and Claude Code and removes the retired `bitwarden` server |
| `bin/vaultwarden-watchdog.sh` + `launchd/` | every 5 min: keeps the local container up and re-asserts MCP config; install with `bin/install-watchdog.sh` |
| `bin/vaultwarden-up.sh`, `install-hostname-and-ca.sh` | the original local Docker vault at https://passman.internal |

## Keychain items (login keychain)

`agent-vault-bw-session` (session) · `agent-vault-bw-clientid` / `agent-vault-bw-clientsecret` (API key) ·
`agent-vault-master-password` (Touch ID helper only)

## Local backups

`~/.vaultwarden-backups/` — taken automatically by `migrate.sh`. Contains the encrypted vault database
and the server's signing key; keep it private.
