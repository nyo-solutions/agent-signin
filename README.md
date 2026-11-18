# agent-signin

**Let AI agents sign in and sign up for you without ever seeing your passwords.**

AI agents that drive a browser keep stopping at login forms, and for good reason: handing an agent a
plaintext password means the secret sits in its context, its logs and its tool calls. agent-signin
removes that hand-off. The agent asks for *a login by name*; a local tool reads the secret from your own
vault, checks that the page really is a site you approved, and types it into the page itself. The agent
only learns which fields were filled.

```
 AI agent ──fill_login("github.com", tab 123)──▶ agent-autofill (MCP) ──▶ Chrome extension ──▶ page
    ◀──────── { filled: [username, password] } ──┘   reads vault · checks allow-list · audits
```

| Folder | What it is |
|---|---|
| [`agent-autofill/`](agent-autofill) | MCP server + Chrome extension. Tools: `list_logins`, `request_authorization` (a dialog on *your* screen writes the allow-list), `fill_login` (username, password, TOTP), `fill_signup` (registration forms from a vault identity, with a generated password saved to the vault first). Works with your everyday Chrome or a headless Chromium (Playwright/Puppeteer via CDP). |
| [`agent-vault/`](agent-vault) | Self-hosted [Vaultwarden](https://github.com/dani-garcia/vaultwarden) on AWS Lambda + EFS (CDK), about $0–1/month, with backups, restore and Touch ID unlock on macOS. Optional: agent-autofill works with any Bitwarden-compatible vault, or environment variables in CI. |

## Highlights

- Secrets never enter the agent's context; tests assert that no tool result contains a password,
  username or personal detail.
- The page's origin is checked by the browser, not taken from the agent, so a prompt-injected agent
  can't fill your login into a look-alike site.
- Approvals are yours: exact sites or wildcards (`https://*.example.com`, `http://localhost:*`, `*`),
  per login or identity, permanent or for one hour.
- Passwords only go into password fields; fills run in an isolated JavaScript world; every action is
  logged without values.
- Pluggable vault adapters (Bitwarden/Vaultwarden, env); one file per new vendor.

## Quick start

```bash
cd agent-autofill && npm install
bin/agent-autofill install       # registers the Chrome native-messaging host
# chrome://extensions → Developer mode → Load unpacked → agent-autofill/extension
bin/agent-autofill doctor
```
Then register `agent-autofill/bin/agent-autofill-mcp` as a stdio MCP server in your agent
(Claude Code: `claude mcp add --scope user agent-autofill -- $PWD/bin/agent-autofill-mcp`).
See each folder's README for details, and [`SECURITY.md`](SECURITY.md) for the threat model.

## License

Apache License 2.0, see [`LICENSE`](LICENSE) and [`NOTICE`](NOTICE). Made by
[NYO Solutions](https://nyo.solutions).
