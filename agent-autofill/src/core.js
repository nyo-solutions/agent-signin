// The three operations behind the MCP tools. Secret values exist only inside
// fillLogin, between the vault read and the hand-off to the browser channel.
import { audit } from './audit.js';
import { askUser } from './authorize.js';
import { chromeFill, chromeRead, chromeTarget } from './channels/extension.js';
import { cdpFill, cdpRead, cdpTarget } from './channels/cdp.js';
import { addGrant, findGrant, grantsForItem, matchingGrants, isWildcard, loadPolicy, normalizeOrigin, originMatches, parsePattern, pruneExpired, savePolicy, vaultName } from './policy.js';
import { openVault } from './vaults/index.js';
import { generatePassword } from './password.js';

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
        custom_fields: (item.custom || []).map((f) => ({ name: f.name, type: f.type })),
        visible_secrets_allowed: grants.some((g) => g.allow_visible_secrets),
        has: ['username', 'password', 'totp'].filter((k) => item[`has${k[0].toUpperCase()}${k.slice(1)}`]),
      });
    }
  }
  const identities = [];
  for (const [name, cfg] of Object.entries(policy.vaults)) {
    const v = openVault(name, cfg);
    if (!v.listIdentities) continue;
    for (const id of await v.listIdentities()) {
      identities.push({ identity: id.name, id: id.id, vault: name, has: id.has, approved_signup_origins: [...new Set(grantsForItem(policy, name, id.id, 'signup').flatMap((g) => g.origins))] });
    }
  }
  return {
    logins: out,
    identities,
    hint: 'Logins with approved_origins can be filled there with fill_login; identities with approved_signup_origins can be used there with fill_signup. For anything else call request_authorization; only the user can approve.',
  };
}

export async function requestAuthorization({ login, identity, vault, origins, allow_submit = true, allow_visible_secrets = false, reason }) {
  if (Boolean(login) === Boolean(identity)) throw new Error('pass exactly one of login (to sign in) or identity (to sign up)');
  const kind = identity ? 'signup' : 'login';
  const ref = login || identity;
  const policy = loadPolicy();
  const vName = vaultName(policy, vault);
  const v = openVault(vName, policy.vaults[vName]);
  if (kind === 'signup' && !v.findIdentity) throw new Error(`vault ${vName} has no identities`);
  const allItems = ref === '*';
  const item = allItems ? null : kind === 'signup' ? await v.findIdentity(ref) : await v.find(ref);
  if (!allItems && !item) throw new Error(`${kind === 'signup' ? 'identity' : 'login'} "${ref}" is not in vault ${vaultLabel(vName, v)}`);
  const pats = origins.map((o) => (isWildcard(o) ? o : normalizeOrigin(o)));
  pats.forEach(parsePattern);

  const covered = (p) => { const g = findGrant(policy, { vault: vName, itemId: item.id, origin: p, kind }); return g && (!allow_visible_secrets || g.allow_visible_secrets); };
  if (!allItems && pats.every((p) => !isWildcard(p) && covered(p))) {
    return { approved: true, already: true, [kind === 'signup' ? 'identity' : 'login']: item.name, origins: pats };
  }
  const itemSites = item?.uris ? item.uris.map((u) => { try { return normalizeOrigin(u); } catch { return u; } }) : [];
  const siteMismatch = Boolean(item?.uris) && pats.some((p) => !isWildcard(p) && !itemSites.includes(p));

  const answer = await askUser({ purpose: kind, allowVisibleSecrets: allow_visible_secrets, itemName: item?.name, itemSites, vaultLabel: vaultLabel(vName, v), origins: pats, allItems, allowSubmit: allow_submit, reason, siteMismatch });
  audit({ action: 'authorize', kind, vault: vName, item: item?.name ?? '*', origins: pats, answer });
  if (answer === 'deny') return { approved: false, message: 'The user denied this request. Do not retry unless the user asks you to.' };

  const fresh = loadPolicy(); // re-read: the file may have changed while the dialog was open
  pruneExpired(fresh);
  addGrant(fresh, {
    ...(kind === 'signup' && { kind }),
    vault: vName,
    item: allItems ? '*' : item.id,
    item_name: allItems ? `ALL (${v.scope})` : item.name,
    origins: pats,
    allow_submit,
    ...(allow_visible_secrets && { allow_visible_secrets: true }),
    ...(answer === 'hour' && { expires_at: new Date(Date.now() + 3600_000).toISOString() }),
    approved_at: new Date().toISOString(),
    approved_via: 'dialog',
  });
  savePolicy(fresh);
  return { approved: true, [kind === 'signup' ? 'identity' : 'login']: item?.name ?? '*', origins: pats, ...(answer === 'hour' && { expires_in: '1 hour' }) };
}

export async function fillLogin({ login, vault, target, fields, custom, submit = false }) {
  const policy = loadPolicy();
  const vName = vaultName(policy, vault);
  const v = openVault(vName, policy.vaults[vName]);
  const item = await v.find(login);
  if (!item) throw new Error(`login "${login}" is not in vault ${vaultLabel(vName, v)}; see list_logins`);

  // 1. Where is the page really? Ask the browser, not the agent.
  const resolved = await resolveTarget(target, policy);
  const origin = normalizeOrigin(resolved.url);

  // 2. Is this login approved for that origin?
  const grant = findGrant(policy, { vault: vName, itemId: item.id, origin });
  if (!grant) {
    audit({ action: 'fill', vault: vName, login: item.name, origin, result: 'not-approved' });
    throw new Error(`"${item.name}" is not approved for ${origin}. Call request_authorization with login "${item.name}" and origin "${origin}"; the user decides.`);
  }
  const grants = matchingGrants(policy, { vault: vName, itemId: item.id, origin });
  if (submit && !grants.some((g) => g.allow_submit)) throw new Error(`the approval for "${item.name}" on ${origin} does not allow submitting; fill without submit`);

  const customNames = Object.keys(custom || {});
  const wanted = fields && Object.keys(fields).length ? fields : customNames.length ? {} : { username: 'auto', password: 'auto' };
  const kinds = Object.keys(wanted).filter((k) => ['username', 'password', 'totp'].includes(k));
  if (!kinds.length && !customNames.length) throw new Error('fields must name username, password and/or totp, or pass custom fields');
  const meta = Object.fromEntries((item.custom || []).map((f) => [f.name, f]));
  const unknownCustom = customNames.filter((n) => !meta[n]);
  if (unknownCustom.length) {
    throw new Error(`"${item.name}" has no custom field ${unknownCustom.map((n) => `"${n}"`).join(', ')}; it has: ${Object.keys(meta).map((n) => `"${n}"`).join(', ') || 'none'}`);
  }

  // 3. Read the secrets and hand them straight to the browser channel.
  const secrets = await v.secrets(item.id, kinds, customNames);
  const missing = [...kinds.filter((k) => !secrets[k]), ...customNames.filter((n) => secrets.custom?.[n] === undefined).map((n) => `custom field "${n}"`)];
  if (missing.length) throw new Error(`"${item.name}" has no ${missing.join(', ')} in the vault`);
  const req = {
    expectedOrigin: origin,
    allowVisibleSecrets: grants.some((g) => g.allow_visible_secrets),
    fields: [
      ...kinds.map((k) => ({ kind: k, selector: wanted[k], value: secrets[k] })),
      ...customNames.map((n) => ({ kind: 'custom', name: n, ctype: meta[n].type, selector: custom[n], value: secrets.custom[n] })),
    ],
    submit,
  };
  if (secrets.custom) for (const n of Object.keys(secrets.custom)) secrets.custom[n] = undefined;
  let result;
  try {
    result = await sendFill(target, resolved, req, policy);
  } finally {
    for (const f of req.fields) f.value = undefined;
  }
  audit({ action: 'fill', vault: vName, login: item.name, origin, channel: target.type, result: result?.ok ? 'filled' : 'failed', fields: result?.filled, submitted: result?.submitted });
  if (!result?.ok) throw new Error(result?.error || 'fill failed');
  return { ...result, login: item.name, ...(resolved.tab_id != null && { tab_id: resolved.tab_id, profile: resolved.profile }), ...(resolved.target_id && { target_id: resolved.target_id }) };
}

async function resolveTarget(target, policy) {
  if (target.type === 'chrome') return chromeTarget(target);
  if (target.type === 'cdp') return cdpTarget(target, policy.cdp.allowed_hosts);
  throw new Error(`unknown target type ${target.type}`);
}

function sendFill(target, resolved, req, policy) {
  return target.type === 'chrome' ? chromeFill(resolved, req) : cdpFill(target, resolved, req, policy.cdp.allowed_hosts);
}

// Order matters for auto-detection: specific fields claim their inputs first.
const SIGNUP_ORDER = ['first_name', 'last_name', 'full_name', 'email', 'username', 'phone', 'company', 'country',
  'address1', 'address2', 'city', 'state', 'postal_code', 'password', 'password_confirm'];

async function uniqueLoginName(v, base, identityName) {
  const names = new Set((await v.list()).map((i) => i.name));
  for (const n of [base, `${base} (${identityName})`, `${base} (${identityName}, ${new Date().toISOString().slice(0, 10)})`]) {
    if (!names.has(n)) return n;
  }
  return `${base} (${identityName}, ${new Date().toISOString().replace(/[:.]/g, '-')})`;
}

export async function fillSignup({ identity, vault, target, credentials = 'generate', password_rules, login_name, fields, submit = false }) {
  const policy = loadPolicy();
  const vName = vaultName(policy, vault);
  const v = openVault(vName, policy.vaults[vName]);
  if (!v.findIdentity) throw new Error(`vault ${vName} has no identities`);
  const idItem = await v.findIdentity(identity);
  if (!idItem) throw new Error(`identity "${identity}" is not in vault ${vaultLabel(vName, v)}; see list_logins`);

  // 1. Real page origin, and the user's approval for signing up there with this identity.
  const resolved = await resolveTarget(target, policy);
  const origin = normalizeOrigin(resolved.url);
  const grant = findGrant(policy, { vault: vName, itemId: idItem.id, origin, kind: 'signup' });
  if (!grant) {
    audit({ action: 'signup', vault: vName, identity: idItem.name, origin, result: 'not-approved' });
    throw new Error(`identity "${idItem.name}" is not approved for signing up on ${origin}. Call request_authorization with identity "${idItem.name}" and origin "${origin}"; the user decides.`);
  }
  if (submit && !grant.allow_submit) throw new Error(`the signup approval for "${idItem.name}" on ${origin} does not allow submitting; fill without submit`);

  // 2. Values: identity + account credentials.
  const vals = { ...(await v.identity(idItem.id)) };
  let saved;
  let reused;
  if (credentials === 'generate') {
    if (!v.createLogin) throw new Error(`vault ${vName} cannot save new logins; pass credentials: { login: "<existing login>" }`);
    vals.username = vals.username || vals.email;
    vals.password = generatePassword(password_rules);
  } else if (credentials && typeof credentials === 'object' && credentials.login) {
    const li = await v.find(credentials.login);
    if (!li) throw new Error(`login "${credentials.login}" is not in vault ${vaultLabel(vName, v)}`);
    if (!findGrant(policy, { vault: vName, itemId: li.id, origin })) {
      throw new Error(`login "${li.name}" is not approved for ${origin}. Call request_authorization with login "${li.name}" and origin "${origin}".`);
    }
    const sec = await v.secrets(li.id, ['username', 'password']);
    if (!sec.password) throw new Error(`login "${li.name}" has no password`);
    vals.password = sec.password;
    if (sec.username) {
      vals.username = sec.username;
      if (!vals.email && sec.username.includes('@')) vals.email = sec.username;
    }
    reused = li.name;
  } else {
    throw new Error('credentials must be "generate" or { login: "<name>" }');
  }
  vals.password_confirm = vals.password;

  const explicit = fields && Object.keys(fields).length ? fields : null;
  const kinds = explicit ? SIGNUP_ORDER.filter((k) => k in explicit) : SIGNUP_ORDER.filter((k) => vals[k]);
  const unknown = explicit ? Object.keys(explicit).filter((k) => !SIGNUP_ORDER.includes(k)) : [];
  if (unknown.length) throw new Error(`unknown field(s): ${unknown.join(', ')} (known: ${SIGNUP_ORDER.join(', ')})`);
  const missing = kinds.filter((k) => !vals[k]);
  if (missing.length) throw new Error(`identity "${idItem.name}" has no ${missing.join(', ')}`);

  // 3. A generated password is saved to the vault BEFORE it is typed anywhere,
  //    so a created account can never be left without its password.
  if (credentials === 'generate') {
    const name = await uniqueLoginName(v, login_name || new URL(origin).hostname, idItem.name);
    saved = await v.createLogin({
      name,
      username: vals.username,
      password: vals.password,
      uris: [origin],
      notes: `Created by agent-autofill fill_signup on ${new Date().toISOString()} with identity "${idItem.name}". The signup itself was not confirmed by the tool.`,
    });
    const fresh = loadPolicy();
    addGrant(fresh, { vault: vName, item: saved.id, item_name: saved.name, origins: [origin], allow_submit: true, approved_at: new Date().toISOString(), approved_via: `signup approval for ${idItem.name}` });
    savePolicy(fresh);
  }

  const req = { mode: 'signup', expectedOrigin: origin, fields: kinds.map((k) => ({ kind: k, selector: explicit?.[k], value: vals[k] })), submit };
  for (const k of Object.keys(vals)) vals[k] = undefined;
  let result;
  try {
    result = await sendFill(target, resolved, req, policy);
  } finally {
    for (const f of req.fields) f.value = undefined;
  }
  audit({ action: 'signup', vault: vName, identity: idItem.name, origin, channel: target.type, result: result?.ok ? 'filled' : 'failed', fields: result?.filled, skipped: result?.skipped, submitted: result?.submitted, saved_login: saved?.name, reused_login: reused });
  const savedInfo = saved && { saved_login: saved.name, saved_login_note: `New password saved in the vault as "${saved.name}" and approved for ${origin}; sign in later with fill_login.` };
  if (!result?.ok) {
    const err = new Error(`${result?.error || 'fill failed'}${saved ? `. (The generated login "${saved.name}" is already saved in the vault.)` : ''}`);
    throw err;
  }
  return { ...result, identity: idItem.name, ...(reused && { used_login: reused }), ...savedInfo, ...(resolved.tab_id != null && { tab_id: resolved.tab_id, profile: resolved.profile }), ...(resolved.target_id && { target_id: resolved.target_id }) };
}

// Read one element of the page and store its value in the vault. No approval:
// saving only brings data into the vault (inside the configured scope).
// Overwriting an existing value needs overwrite_allowed (default: save.overwrite_default,
// or the vault's own overwrite_default).
export async function saveFromPage({ target, xpath, attribute, vault, create, item_type = 'login', item, item_name, field_kind = 'custom', field_name, field_type, overwrite_allowed }) {
  if (create && !item_name) throw new Error('item_name is required when create is true');
  if (!create && !item) throw new Error('item (id or exact name) is required when create is false');
  if (field_kind === 'custom' && !field_name) throw new Error('field_name is required for field_kind "custom"');
  if (field_kind !== 'custom' && item_type !== 'login') throw new Error(`field_kind "${field_kind}" needs item_type "login"`);
  if (field_kind !== 'custom' && field_type) throw new Error('field_type applies to custom fields only');
  const policy = loadPolicy();
  const vName = vaultName(policy, vault);
  const vcfg = policy.vaults[vName];
  const v = openVault(vName, vcfg);
  if (!v.saveField) throw new Error(`vault ${vName} (${v.type}) cannot save values`);
  const overwrite = overwrite_allowed ?? vcfg.overwrite_default ?? policy.save.overwrite_default;

  const resolved = await resolveTarget(target, policy);
  const origin = normalizeOrigin(resolved.url);
  const req = { expectedOrigin: origin, selector: xpath, attribute };
  const read = target.type === 'chrome' ? await chromeRead(resolved, req) : await cdpRead(target, resolved, req, policy.cdp.allowed_hosts);
  if (!read?.ok) throw new Error(read?.error || 'could not read the element');

  const label = field_kind === 'custom' ? `custom field "${field_name}"` : field_kind;
  let saved;
  try {
    saved = await v.saveField({ create, item_type, item, item_name, uris: [origin], field_kind, field_name, field_type, value: read.value, overwrite });
  } catch (e) {
    audit({ action: 'save', vault: vName, item: item_name || item, field: label, origin, result: 'failed', error: e.message });
    throw e;
  } finally {
    read.value = undefined;
  }
  audit({ action: 'save', vault: vName, item: saved.name, field: label, origin, result: saved.outcome, created: saved.created, overwrite });
  return {
    saved: saved.outcome !== 'unchanged', outcome: saved.outcome, created: saved.created, item: saved.name, item_id: saved.id, field: label, origin,
    ...(resolved.tab_id != null && { tab_id: resolved.tab_id, profile: resolved.profile }),
    ...(saved.created && item_type === 'login' && { note: `Saved. To fill it later, the user must approve "${saved.name}" for ${origin} (request_authorization).` }),
  };
}

export { originMatches };
