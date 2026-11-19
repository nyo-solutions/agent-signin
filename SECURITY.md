# Security

## Reporting a vulnerability

Please report security issues privately through GitHub's **Report a vulnerability** button on this
repository (Security tab), not in public issues. We aim to answer within a few working days.

## Threat model (agent-autofill)

**Protects against**
- An AI agent seeing, logging or leaking secrets: values stay inside the local tool and the browser;
  tool results contain only field names.
- Prompt-injected or confused agents filling a login on the wrong site: the browser reports the real
  origin, which must match an approval you gave; the check repeats inside the page right before filling.
- Secrets ending up in screenshots: passwords are only written into `type=password` inputs.
- Page scripts hooking the fill: it runs in an isolated JavaScript world.
- Sending secrets to a remote browser: CDP endpoints are limited to `cdp.allowed_hosts` (loopback by default).

**Does not protect against**
- A hostile agent with shell access as your user: it could edit the allow-list, run the CLI, read the
  vault session from the Keychain, or read a filled field with page JavaScript. Give agents only the
  permissions they need.
- A compromised site: whatever you approve for a site, that site receives.
- `"*"` approvals: these switch off the origin check for that login or identity.
- The vault scope (`folders`, `collections`, `exclude_*`) limits what *this tool* reads. The unlocked
  vault session itself can read the whole account, so an agent with shell access could bypass the tool.
  For hard isolation, give agents their **own vault account** that only receives the items you share
  with it (for example an organization collection), and keep cards and personal items in your own account.

## Deployments (agent-vault)

Run the vault workflows from a **private** ops repo (see `agent-vault/ops-template`): GitHub Actions logs
of public repositories are public, and deploy logs contain AWS stack output. The reusable workflows
also mask the account id, domain and zone id.
