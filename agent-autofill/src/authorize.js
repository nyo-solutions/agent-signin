// Asks the user, on their own screen, to approve a login for a site. This is
// the only way an agent-initiated approval reaches the allow-list.
import { execFile } from 'node:child_process';

let queue = Promise.resolve(); // one dialog at a time

export function askUser({ purpose = 'login', frameOrigins = [], allowVisibleSecrets = false, itemName, itemSites, vaultLabel, origins, allItems, allowSubmit, reason, siteMismatch }) {
  if (process.platform !== 'darwin' || process.env.AGENT_AUTOFILL_NO_DIALOG) {
    return Promise.reject(new Error(
      'no interactive approval is available here (headless/CI). Ask the user to run: agent-autofill allow <login> <origin>',
    ));
  }
  const signup = purpose === 'signup';
  const card = purpose === 'card';
  const details = purpose === 'identity';
  const word = card ? 'card' : signup || details ? 'identity' : 'login';
  const headline = {
    login: 'An AI agent asks to sign in with a saved login.',
    signup: 'An AI agent asks to CREATE AN ACCOUNT (sign up) using a saved identity.',
    identity: 'An AI agent asks to fill your saved details (name, email, phone, address) into a form.',
    card: 'An AI agent asks to FILL A PAYMENT CARD into a checkout form.',
  }[purpose];
  const lines = [
    headline,
    '',
    `${word[0].toUpperCase()}${word.slice(1)}:  ${allItems ? `ALL ${word === 'identity' ? 'identities' : `${word}s`} in ${vaultLabel}` : `${itemName}  (${vaultLabel})`}`,
    `Site${origins.length > 1 ? 's' : ''}:  ${origins.join(', ')}`,
    ...(frameOrigins.length ? [`Also inside these frames on the site: ${frameOrigins.join(', ')}`] : []),
    `May submit the form: ${allowSubmit ? (card ? 'YES (this can complete a payment)' : 'yes') : 'no'}`,
    ...(allowVisibleSecrets ? ['Hidden fields (API keys, secrets) may go into visible text boxes: YES'] : []),
  ];
  if (signup) lines.push('', 'The identity\'s name, email, phone and address may be filled. A new password is generated and saved to the vault (or a login you approved is reused).');
  if (card) lines.push('', 'The card number, expiry date, security code and cardholder name may be filled.');
  const warn = [];
  if (origins.includes('*')) warn.push('ANY SITE: the login can be filled into any page, including phishing pages.');
  else if (origins.some((o) => o.includes('*'))) warn.push('Wildcard site pattern: every matching site is approved.');
  if (allowVisibleSecrets) warn.push('Hidden vault fields may be typed into visible text boxes, where a screenshot taken by the agent could show them.');
  if (allItems) warn.push(`Every ${word === 'identity' ? 'identity' : word} in this vault scope is approved, including ones added later.`);
  if (card) warn.push('Card details are shown in the page once filled, so the agent\'s screenshots or page reading can see them. Approve only checkout pages you trust.');
  if (card && allowSubmit) warn.push('The agent may submit the payment form without you.');
  if (siteMismatch) warn.push(`This site is not one of the login's saved websites${itemSites.length ? ` (${itemSites.join(', ')})` : ''}.`);
  if (warn.length) lines.push('', ...warn.map((w) => `⚠️ ${w}`));
  lines.push('', `The tool never gives the ${card ? 'card details' : signup ? 'details or password' : details ? 'details' : 'password'} to the agent: Agent Autofill types them into the page.`);
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
