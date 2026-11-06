# agent-vault

Self-hosted [Vaultwarden](https://github.com/dani-garcia/vaultwarden) for you and your AI agents.
Agents (Claude Desktop, Claude Code) read usernames, passwords and live TOTP codes through the
official [`@bitwarden/mcp-server`](https://www.npmjs.com/package/@bitwarden/mcp-server).

- **Vault:** https://vault.example.com — AWS Lambda + EFS in us-east-1, ~$0–1/month
- **Clients:** Bitwarden browser extension, desktop app, Android app → "Self-hosted" → the URL above
- **Agents:** session key lives in the macOS Keychain; nothing secret is in any config file or in this repo

## GitHub Actions (Actions tab → choose workflow → Run workflow)

| Workflow | When | What |
|---|---|---|
| **Deploy** | automatically on push to `main` touching `aws/`, or manually | builds the image, deploys `AgentVaultData` + `AgentVault`, smoke-tests the URL. Tick **signups** to allow creating an account, then run it again unticked |
| **Backup** | Sundays 03:00 UTC, or manually | consistent export to the transfer bucket (`exports/`, kept 30 days) |
| **Restore backup** | manually (type `restore`) | safety export, then replaces vault data with a chosen export |
| **Take vault offline (keep data)** | manually (type `destroy`) | backup, then removes the public endpoint/Lambda/cert/DNS. Data stays; **Deploy** brings it back |
| **Remove vault (DELETES DATA)** | manually (type `delete vault.example.com`) | deletes both stacks, the EFS data, the transfer bucket, optionally the AWS Backup snapshots |

Besides the weekly export, EFS has automatic **daily AWS Backup snapshots kept 35 days**.
Before *Remove vault*, also take an encrypted export from the web vault (Tools → Export vault).

Workflows authenticate to AWS with GitHub OIDC (role `agent-vault-github`, trusted only for `main`
of this repo) — no AWS keys are stored in GitHub.

## Stacks (`aws/`, CDK TypeScript)

| Stack | Contents | Destroyed by |
|---|---|---|
| `AgentVaultData` | VPC (no NAT/egress), EFS (encrypted, retained), backups, transfer bucket, migrate/backup function | Remove vault only |
| `AgentVault` | Vaultwarden Lambda (Web Adapter, arm64), HTTP API (throttled 20 rps), ACM cert, Route 53 record, optional $5 budget | Take offline / Remove vault |
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
| `bin/bitwarden-mcp` | MCP launcher used by Claude Desktop / Claude Code; reads the session from Keychain |
| `bin/vault-touchid` (built from `touchid/`) | master password in Keychain, readable only by this binary after Touch ID |
| `configure-mcp-clients.py` | idempotently registers the MCP server in Claude Desktop and Claude Code |
| `bin/vaultwarden-watchdog.sh` + `launchd/` | every 5 min: keeps the local container up and re-asserts MCP config |
| `bin/vaultwarden-up.sh`, `install-hostname-and-ca.sh` | the original local Docker vault at https://passman.internal |

## Keychain items (login keychain)

`agent-vault-bw-session` (session) · `agent-vault-bw-clientid` / `agent-vault-bw-clientsecret` (API key) ·
`agent-vault-master-password` (Touch ID helper only)

## Local backups

`~/.vaultwarden-backups/` — taken automatically by `migrate.sh`. Contains the encrypted vault database
and the server's signing key; keep it private.
