// The three operations behind the MCP tools. Secret values exist only inside
// fillLogin, between the vault read and the hand-off to the browser channel.
import { audit } from './audit.js';
import { askUser } from './authorize.js';
import { chromeFill, chromeTarget } from './channels/extension.js';
import { cdpFill, cdpTarget } from './channels/cdp.js';
import { addGrant, findGrant, grantsForItem, isWildcard, loadPolicy, normalizeOrigin, originMatches, parsePattern, pruneExpired, savePolicy, vaultName } from './policy.js';
import { openVault } from './vaults/index.js';

const vaultLabel = (name, v) => `${name}, ${v.scope}`;

export async function listLogins() {
  const policy = loadPolicy();
  const out = [];
  for (const [name, cfg] of Object.entries(policy.vaults)) {
    const v = openVault(name, cfg);
    for (const item of await v.list()) {
      const grants = grantsForItem(policy, name, item.id);
      out.push({
        login: item.name,
        id: item.id,
        vault: name,
        saved_sites: item.uris,
        approved_origins: [...new Set(grants.flatMap((g) => g.origins))],
        can_submit: grants.some((g) => g.allow_submit),
        has: ['username', 'password', 'totp'].filter((k) => item[`has${k[0].toUpperCase()}${k.slice(1)}`]),
      });
    }
  }
  return {
    logins: out,
    hint: 'Logins with approved_origins can be filled there with fill_login. For anything else call request_authorization; only the user can approve.',
  };
}

export async function requestAuthorization({ login, vault, origins, allow_submit = true, reason }) {
  const policy = loadPolicy();
  const vName = vaultName(policy, vault);
  const v = openVault(vName, policy.vaults[vName]);
  const allItems = login === '*';
  const item = allItems ? null : await v.find(login);
  if (!allItems && !item) throw new Error(`login "${login}" is not in vault ${vaultLabel(vName, v)}`);
  const pats = origins.map((o) => (isWildcard(o) ? o : normalizeOrigin(o)));
  pats.forEach(parsePattern);

  if (!allItems && pats.every((p) => !isWildcard(p) && findGrant(policy, { vault: vName, itemId: item.id, origin: p }))) {
    return { approved: true, already: true, login: item.name, origins: pats };
  }
  const itemSites = item ? item.uris.map((u) => { try { return normalizeOrigin(u); } catch { return u; } }) : [];
  const siteMismatch = Boolean(item) && pats.some((p) => !isWildcard(p) && !itemSites.includes(p));

  const answer = await askUser({ itemName: item?.name, itemSites, vaultLabel: vaultLabel(vName, v), origins: pats, allItems, allowSubmit: allow_submit, reason, siteMismatch });
  audit({ action: 'authorize', vault: vName, login: item?.name ?? '*', origins: pats, answer });
  if (answer === 'deny') return { approved: false, message: 'The user denied this request. Do not retry unless the user asks you to.' };

  const fresh = loadPolicy(); // re-read: the file may have changed while the dialog was open
  pruneExpired(fresh);
  addGrant(fresh, {
    vault: vName,
    item: allItems ? '*' : item.id,
    item_name: allItems ? `ALL (${v.scope})` : item.name,
    origins: pats,
    allow_submit,
    ...(answer === 'hour' && { expires_at: new Date(Date.now() + 3600_000).toISOString() }),
    approved_at: new Date().toISOString(),
    approved_via: 'dialog',
  });
  savePolicy(fresh);
  return { approved: true, login: item?.name ?? '*', origins: pats, ...(answer === 'hour' && { expires_in: '1 hour' }) };
}

export async function fillLogin({ login, vault, target, fields, submit = false }) {
  const policy = loadPolicy();
  const vName = vaultName(policy, vault);
  const v = openVault(vName, policy.vaults[vName]);
  const item = await v.find(login);
  if (!item) throw new Error(`login "${login}" is not in vault ${vaultLabel(vName, v)}; see list_logins`);

  // 1. Where is the page really? Ask the browser, not the agent.
  let resolved;
  if (target.type === 'chrome') resolved = await chromeTarget(target);
  else if (target.type === 'cdp') resolved = await cdpTarget(target, policy.cdp.allowed_hosts);
  else throw new Error(`unknown target type ${target.type}`);
  const origin = normalizeOrigin(resolved.url);

  // 2. Is this login approved for that origin?
  const grant = findGrant(policy, { vault: vName, itemId: item.id, origin });
  if (!grant) {
    audit({ action: 'fill', vault: vName, login: item.name, origin, result: 'not-approved' });
    throw new Error(`"${item.name}" is not approved for ${origin}. Call request_authorization with login "${item.name}" and origin "${origin}"; the user decides.`);
  }
  if (submit && !grant.allow_submit) throw new Error(`the approval for "${item.name}" on ${origin} does not allow submitting; fill without submit`);

  const wanted = fields && Object.keys(fields).length ? fields : { username: 'auto', password: 'auto' };
  const kinds = Object.keys(wanted).filter((k) => ['username', 'password', 'totp'].includes(k));
  if (!kinds.length) throw new Error('fields must name username, password and/or totp');

  // 3. Read the secrets and hand them straight to the browser channel.
  const secrets = await v.secrets(item.id, kinds);
  const missing = kinds.filter((k) => !secrets[k]);
  if (missing.length) throw new Error(`"${item.name}" has no ${missing.join(', ')} in the vault`);
  const req = { expectedOrigin: origin, fields: kinds.map((k) => ({ kind: k, selector: wanted[k], value: secrets[k] })), submit };
  let result;
  try {
    result = target.type === 'chrome' ? await chromeFill(resolved, req) : await cdpFill(target, resolved, req, policy.cdp.allowed_hosts);
  } finally {
    for (const f of req.fields) f.value = undefined;
  }
  audit({ action: 'fill', vault: vName, login: item.name, origin, channel: target.type, result: result?.ok ? 'filled' : 'failed', fields: result?.filled, submitted: result?.submitted });
  if (!result?.ok) throw new Error(result?.error || 'fill failed');
  return { ...result, login: item.name, ...(resolved.tab_id != null && { tab_id: resolved.tab_id }), ...(resolved.target_id && { target_id: resolved.target_id }) };
}

export { originMatches };
