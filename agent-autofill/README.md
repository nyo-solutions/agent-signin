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
| `save_from_page` | saves a value shown on a page (API key, client secret, generated password, 2FA secret) straight into the vault: the agent points at the element, the value never passes through it. Creates an item or adds to an existing one; replacing a different value needs `overwrite_allowed` (default configurable). No approval needed. |
| `fill_signup` | fills a registration form from an identity (name, email, username, phone, company, address, country dropdowns) plus a password, and optionally submits. By default it generates a strong password and **saves it to the vault as a new login before typing it**, then approves that login for the site so the agent can sign in later with `fill_login`. Or it reuses an approved existing login (`credentials: { login }`). Never ticks terms/consent boxes. |

### Saving values from a page (`save_from_page`)

When a site shows a new credential (an API key "shown once", a client secret behind a copy button, a 2FA
setup secret), the agent points at the element instead of copying the value:

```js
save_from_page({
  target: { type: "chrome", tab_id: 123, profile: "a629754e" },   // element locator
  xpath: "//code[@id='api-key']",          // or a CSS selector; attribute: "data-clipboard-text" for copy buttons
  create: false, item: "hubspot",          // vault locator: existing item (id or name)...
  // create: true, item_name: "hubspot",   // ...or a new item (its website = this page's origin)
  item_type: "login",                      // login (default) or identity
  field_kind: "custom", field_name: "API Key", field_type: "hidden",   // or field_kind username | password | totp
  overwrite_allowed: false,                // replace a different existing value? default from config
})
```

The tool checks the page's real origin, reads the element inside the page (input value, otherwise its
text, or the given attribute) and writes it to the vault. The agent gets back only where it went and the
outcome: `added`, `replaced` or `unchanged`.

- **No approval dialog**: saving only brings data into the vault, inside the configured scope (new items
  go to `save_folder`). Filling a new item on a site later still needs approval. Every save is in the audit log.
- **Overwriting** a different existing value needs `overwrite_allowed: true`. Default when the agent
  doesn't say: `save.overwrite_default` (or a vault's own `overwrite_default`), `false` out of the box.
  The replaced value of a password or hidden field is kept in the item's notes (last 5), so a good key
  is never lost; agents never see notes.

```yaml
save:
  overwrite_default: false     # true: agents may replace values unless they pass overwrite_allowed: false
vaults:
  bitwarden:
    overwrite_default: true    # optional per-vault override
```

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

## Several agent sessions at once

Every agent session runs its own MCP server; they all share the allow-list, the vault CLI's data and the
Chrome bridge, and can work at the same time:

- changes to the allow-list (approvals, revokes, signup logins) are locked read-change-writes, so one
  session never overwrites another's approvals;
- vault commands that change data (sync, create, edit) run one at a time across sessions, a save holds
  that lock for its whole read-change-write, and sessions share one sync per minute; reads run in parallel;
- approval dialogs are queued, one on screen at a time, and a request already covered by another
  session's answer doesn't ask again;
- each Chrome profile has its own bridge socket that any number of sessions can use at once.

Locks are files in `~/.config/agent-autofill/run/`; a lock left by a crashed session is taken over.

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
