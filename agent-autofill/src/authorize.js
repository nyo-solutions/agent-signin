// Asks the user, on their own screen, to approve a login for a site. This is
// the only way an agent-initiated approval reaches the allow-list.
import { execFile } from 'node:child_process';

let queue = Promise.resolve(); // one dialog at a time

export function askUser({ itemName, itemSites, vaultLabel, origins, allItems, allowSubmit, reason, siteMismatch }) {
  if (process.platform !== 'darwin' || process.env.AGENT_AUTOFILL_NO_DIALOG) {
    return Promise.reject(new Error(
      'no interactive approval is available here (headless/CI). Ask the user to run: agent-autofill allow <login> <origin>',
    ));
  }
  const lines = [
    'An AI agent asks to sign in with a saved login.',
    '',
    `Login:  ${allItems ? `ALL logins in ${vaultLabel}` : `${itemName}  (${vaultLabel})`}`,
    `Site${origins.length > 1 ? 's' : ''}:  ${origins.join(', ')}`,
    `May submit the form: ${allowSubmit ? 'yes' : 'no'}`,
  ];
  const warn = [];
  if (origins.includes('*')) warn.push('ANY SITE: the login can be filled into any page, including phishing pages.');
  else if (origins.some((o) => o.includes('*'))) warn.push('Wildcard site pattern: every matching site is approved.');
  if (allItems) warn.push('Every login in this vault scope is approved, including ones added later.');
  if (siteMismatch) warn.push(`This site is not one of the login's saved websites${itemSites.length ? ` (${itemSites.join(', ')})` : ''}.`);
  if (warn.length) lines.push('', ...warn.map((w) => `⚠️ ${w}`));
  lines.push('', 'The agent never sees the password: Agent Autofill types it into the page.');
  if (reason) lines.push('', `Agent's reason (not verified): ${String(reason).slice(0, 300)}`);

  const script = [
    'on run argv',
    'set r to display dialog (item 1 of argv) with title "Agent Autofill" buttons {"Deny", "Allow 1 hour", "Always allow"} default button "Deny" cancel button "Deny" with icon caution giving up after 180',
    'if gave up of r then return "deny"',
    'return button returned of r',
    'end run',
  ].flatMap((l) => ['-e', l]);

  const ask = () => new Promise((resolve) => {
    execFile('/usr/bin/osascript', [...script, lines.join('\n')], (err, stdout) => {
      if (err) return resolve('deny'); // Deny is the cancel button -> non-zero exit
      const b = stdout.trim();
      resolve(b === 'Always allow' ? 'always' : b === 'Allow 1 hour' ? 'hour' : 'deny');
    });
  });
  const p = queue.then(ask, ask);
  queue = p.catch(() => {});
  return p;
}
