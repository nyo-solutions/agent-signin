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
| `list_logins` | login and identity names, saved sites, approved origins, which fields exist. No secrets or personal details. |
| `request_authorization` | shows **you** a macOS dialog (Deny / Allow 1 hour / Always allow) for a `login` (sign in) or an `identity` (sign up). Your answer is written to the allow-list. The agent cannot approve. |
| `fill_login` | fills username / password / TOTP and **custom vault fields** (API keys, client ids and secrets, certificates, checkboxes) into a page and optionally submits. Refuses unless the page's real origin is approved for that login. |
| `fill_signup` | fills a registration form from an identity (name, email, username, phone, company, address, country dropdowns) plus a password, and optionally submits. By default it generates a strong password and **saves it to the vault as a new login before typing it**, then approves that login for the site so the agent can sign in later with `fill_login`. Or it reuses an approved existing login (`credentials: { login }`). Never ticks terms/consent boxes. |

### Custom fields (API keys, secrets, ids)

Custom fields on a vault login (Bitwarden: *Custom fields* on the item) are listed by `list_logins` by
name and type only, and filled with `fill_login({ login, target, custom: { "Client Secret": "auto" } })`.
`"auto"` finds the input whose label, name, id or placeholder contains the field name; or pass a CSS /
XPath selector.

| Vault field type | Goes into |
|---|---|
| text | text-like inputs, textareas, password inputs |
| hidden | **password-type inputs only**, so it can't appear in a screenshot. Approve with "visible secrets" (`request_authorization(..., allow_visible_secrets: true)` or `agent-autofill allow ... --visible-secrets`) for sites whose key boxes are plain text |
| boolean | checkboxes (set on or off) |

In CI, use `AGENT_AUTOFILL_<NAME>_FIELD_<FIELD>` (text), `_SECRET_<FIELD>` (hidden) and `_FLAG_<FIELD>` (boolean).

### Identities (for sign-ups)

Create a Bitwarden **Identity** item in the vault folder (web vault or app → New → Identity) with the
details sites ask for: first/last name, email, username, phone, company, address, country. One item per
persona (for example "Test persona" with a `+test` email address). SSN, passport and licence numbers are
never read. In CI, use `AGENT_AUTOFILL_IDENTITY_<NAME>='{"first_name":"…","email":"…"}'` with the `env`
vault; logins generated there live in memory for the run.

If the form's own validation blocks the submit (say, a username in an email-only field), the result says
`submitted: false` and names the rejected field.

## Channels

- **`chrome`**: your everyday Chrome, via the extension in `extension/` and a native-messaging host.
  `target: { type: "chrome", tab_id }` (Claude in Chrome's tab ids), or `url_contains`, or the active tab.
  Works with several Chrome profiles at once: each profile's extension gets its own bridge socket, and
  the tool sends each request to the profile that has the tab. If a page is open in more than one
  profile, it asks for `target.profile` (the id returned by earlier results; `agent-autofill doctor`
  lists connected profiles).
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
    folders: [ai]                   # what agents may reach: folders, collections and/or organizations
    # collections: [Agents]         # organization collections (name or id)
    # organizations: [NYO]          # whole organizations
    # exclude_items: [bank.example] # never readable, even inside the scope
    # exclude_fields: [Recovery codes, phone]   # custom or identity fields never read
    # item_types: [login]           # default [login, identity]; cards, notes, SSH keys can't be enabled
    # save_folder: ai               # where fill_signup saves new logins (default: first folder)
default_vault: bitwarden
cdp:
  allowed_hosts: [127.0.0.1, localhost, "::1"]
grants:                             # written by the dialog or `agent-autofill allow`
  - vault: bitwarden
    item: <vault item id>           # or "*" = every login in the folder
    item_name: github.com
    origins: ["https://github.com"]
    allow_submit: true
  - kind: signup                    # identity may be used to sign up on these sites
    vault: bitwarden
    item: <identity item id>        # or "*"
    item_name: Test persona
    origins: ["http://localhost:*", "https://*.sara.test"]
    allow_submit: true
```

**Vault scope.** A Bitwarden vault must name what agents may reach (`folders`, `collections`,
`organizations`, or `scope: all` to opt into the whole vault). Only **logins and identities** are ever
read: credit cards, secure notes and SSH keys are not supported at all, so they can't be exposed even by
mistake, and identity government IDs (SSN, passport, licence) are never read. `exclude_items` and
`exclude_fields` carve out exceptions inside the scope. You can configure several vaults (e.g. a `test`
and a `staging` folder) and agents pick one with the `vault` parameter.

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
Agent registration in Claude Desktop / Claude Code is done by [`../agent-vault/configure-mcp-clients.py`](../agent-vault/configure-mcp-clients.py), or add `bin/agent-autofill-mcp` as a stdio MCP server in any client.

## CLI (for you and CI)

```
agent-autofill list                             # approvals
agent-autofill allow github.com https://github.com [--hours 8] [--no-submit]
agent-autofill allow '*' 'http://localhost:*'   # every login, any local port
agent-autofill allow --signup 'Test persona' 'https://*.sara.test'   # sign-ups with an identity
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
TOTP, wildcards, wrong-origin refusal, sign-up then sign-in with the saved password, form-validation
reporting, and no secret or personal detail in any tool output.

## Adding a vault vendor

Add `src/vaults/<vendor>.js` exporting `create(config)` → `{ list, find, secrets }` (plus `listIdentities`, `findIdentity`, `identity`, `createLogin` for sign-ups) (see `src/vaults/index.js`), and register it there.
