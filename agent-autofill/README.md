# agent-autofill

Lets AI agents (Claude Code, Claude Desktop, any MCP client) sign in to sites with logins from your
vault **without the agent ever receiving the username, password or TOTP code**. The agent passes a
login name and the form fields; this tool reads the secret from the vault and types it into the page
itself, after checking with the browser that the page's real origin is one you approved.

```
agent ──fill_login("github.com", tab 123)──▶ MCP server ──secret──▶ Chrome extension ──▶ page
   ◀──── { filled: [username, password] } ────┘   ▲ reads vault, checks allow-list
```

## Tools the agent sees

| Tool | What it does |
|---|---|
| `list_logins` | login names, saved sites, approved origins. No secrets. |
| `request_authorization` | shows **you** a macOS dialog (Deny / Allow 1 hour / Always allow). Your answer is written to the allow-list. The agent cannot approve. |
| `fill_login` | fills username / password / TOTP into a page and optionally submits. Refuses unless the page's real origin is approved for that login. |

## Channels

- **`chrome`**: your everyday Chrome, via the extension in `extension/` and a native-messaging host.
  `target: { type: "chrome", tab_id }` (Claude in Chrome's tab ids), or `url_contains`, or the active tab.
- **`cdp`**: headless or automated Chromium (Playwright, Puppeteer, `--remote-debugging-port`).
  `target: { type: "cdp", endpoint: "http://127.0.0.1:9222", url_contains | target_id }`.
  Only endpoints in `cdp.allowed_hosts` are used (loopback by default), so secrets never go to a remote browser.

The Claude desktop app's built-in browser pane can't be reached from outside, so use Chrome or headless for sign-ins.

## Allow-list: `~/.config/agent-autofill/policy.yaml`

```yaml
vaults:
  bitwarden:
    type: bitwarden                 # or: env (CI)
    bw_bin: /opt/homebrew/bin/bw
    session_keychain_service: agent-vault-bw-session
    folder: ai                      # only this folder is ever fillable
default_vault: bitwarden
cdp:
  allowed_hosts: [127.0.0.1, localhost, "::1"]
grants:                             # written by the dialog or `agent-autofill allow`
  - vault: bitwarden
    item: <vault item id>             # or "*" = every login in the folder
    item_name: github.com
    origins: ["https://github.com"]
    allow_submit: true
```

Origin patterns: exact `https://app.example.com`; `https://*.example.com` (domain + subdomains);
`http://localhost:*` (any port); `https://*` (any HTTPS site); `*` (**any site**, which turns off the
anti-phishing check, so use it with care). A login can't be filled anywhere until it's in `grants`.

## Setup (once)

```bash
npm install
bin/agent-autofill install          # registers the native host for Chrome (--browsers chrome,brave,edge,chromium)
# chrome://extensions -> Developer mode -> Load unpacked -> ./extension  (ID efjfpgccejkkailhmopnddbcleklbedb)
bin/agent-autofill doctor
```
Agent registration in Claude Desktop / Claude Code is done by `agent-vault/configure-mcp-clients.py`.

## CLI (for you and CI)

```
agent-autofill list                             # approvals
agent-autofill allow github.com https://github.com [--hours 8] [--no-submit]
agent-autofill allow '*' 'http://localhost:*'   # every login, any local port
agent-autofill revoke github.com [origin]
agent-autofill doctor
```
CI / headless: use the `env` vault (`AGENT_AUTOFILL_<NAME>_USERNAME|_PASSWORD|_TOTP_SECRET`), commit or
generate a policy with grants, and set `AGENT_AUTOFILL_HOME`. No dialog is shown there.

## Safeguards

- Secrets are never in a tool result (asserted by the tests), and the audit log (`audit.log`) records login, origin and result only.
- The origin is read from the browser, both before the vault is read and again inside the page right before filling.
- Passwords only go into `type=password` inputs, so they can't end up as visible text in a screenshot.
- Fills run in an isolated JS world, so page scripts can't hook the fill function.
- Only the vault scope you configure (e.g. one folder) is reachable.

**Limits:** this protects against agents *handling* secrets and against prompt-injected fills on the wrong
site. It is not a sandbox against an agent that is hostile and has a shell: such an agent could edit
`policy.yaml`, run `agent-autofill allow`, or read a filled field's value with page JavaScript. Run agents
with permissions that fit that.

## Tests

`npm test` runs unit tests plus an end-to-end run with Playwright's Chromium: both channels, selectors,
TOTP, wildcards, wrong-origin refusal, and no secret in any tool output.

## Adding a vault vendor

Add `src/vaults/<vendor>.js` exporting `create(config)` → `{ list, find, secrets }` (see `src/vaults/index.js`), and register it there.
