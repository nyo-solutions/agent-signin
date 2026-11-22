// The three operations behind the MCP tools. Secret values exist only inside
// fillLogin, between the vault read and the hand-off to the browser channel.
import { audit } from './audit.js';
import { askUser } from './authorize.js';
import { chromeFill, chromeRead, chromeTarget } from './channels/extension.js';
import { cdpFill, cdpRead, cdpTarget } from './channels/cdp.js';
import { addGrant, cardGrantProblem, findGrant, grantsForItem, matchingGrants, isWildcard, loadPolicy, normalizeOrigin, originMatches, parsePattern, pruneExpired, updatePolicy, vaultName } from './policy.js';
import { withLock } from './lock.js';
import { openVault } from './vaults/index.js';
import { generatePassword } from './password.js';
import { CARD_KINDS, cardFillValues } from './vaults/card-fields.js';
import { IDENTITY_FIELDS } from './vaults/identity-fields.js';

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
      const sites = (kind) => [...new Set(grantsForItem(policy, name, id.id, kind).flatMap((g) => g.origins))];
      identities.push({ identity: id.name, id: id.id, vault: name, has: id.has, approved_signup_origins: sites('signup'), approved_details_origins: [...new Set([...sites('identity'), ...sites('signup')])] });
    }
  }
  const cards = [];
  for (const [name, cfg] of Object.entries(policy.vaults)) {
    const v = openVault(name, cfg);
    if (!v.listCards) continue;
    for (const c of await v.listCards()) {
      const grants = grantsForItem(policy, name, c.id, 'card');
      cards.push({
        card: c.name, id: c.id, vault: name, ...(c.brand && { brand: c.brand }), has: c.has,
        approved_origins: [...new Set(grants.flatMap((g) => g.origins))],
        approved_frame_origins: [...new Set(grants.flatMap((g) => g.frame_origins || []))],
        can_submit: grants.some((g) => g.allow_submit),
      });
    }
  }
  return {
    logins: out,
    identities,
    ...(cards.length && { cards }),
    hint: 'Logins with approved_origins can be filled there with fill_login; identities with approved_signup_origins can be used there with fill_signup, and with approved_details_origins with fill_details; cards with approved_origins can be filled there with fill_details. For anything else call request_authorization; only the user can approve.',
  };
}

const ITEM_WORD = { login: 'login', signup: 'identity', identity: 'identity', card: 'card' };

export async function requestAuthorization({ login, identity, card, identity_use = 'signup', vault, origins, frame_origins = [], allow_submit, allow_visible_secrets = false, reason }) {
  if ([login, identity, card].filter(Boolean).length !== 1) throw new Error('pass exactly one of login (to sign in), identity (to sign up or fill details) or card (to fill a payment card)');
  if (!['signup', 'details'].includes(identity_use)) throw new Error('identity_use must be "signup" or "details"');
  const kind = login ? 'login' : card ? 'card' : identity_use === 'details' ? 'identity' : 'signup';
  const word = ITEM_WORD[kind];
  if (frame_origins.length && !['identity', 'card'].includes(kind)) throw new Error('frame_origins only applies to identity details (identity_use "details") and cards');
  if (allow_visible_secrets && kind !== 'login') throw new Error('allow_visible_secrets only applies to logins');
  allow_submit ??= kind !== 'card'; // submitting a card form can complete a payment: off unless asked for
  const ref = login || identity || card;
  const policy = loadPolicy();
  const vName = vaultName(policy, vault);
  const v = openVault(vName, policy.vaults[vName]);
  if (word === 'identity' && !v.findIdentity) throw new Error(`vault ${vName} has no identities`);
  if (kind === 'card' && !v.findCard) throw new Error(`vault ${vName} has no cards`);
  const allItems = ref === '*';
  const item = allItems ? null : word === 'identity' ? await v.findIdentity(ref) : kind === 'card' ? await v.findCard(ref) : await v.find(ref);
  if (!allItems && !item) {
    const hint = kind === 'card' ? ' (cards need item_types: [login, identity, card] in the vault config)' : '';
    throw new Error(`${word} "${ref}" is not in vault ${vaultLabel(vName, v)}${hint}`);
  }
  const pats = origins.map((o) => (isWildcard(o) ? o : normalizeOrigin(o)));
  pats.forEach(parsePattern);
  const frames = frame_origins.map((o) => { if (isWildcard(o)) throw new Error(`frame_origins must be exact origins, not "${o}"`); return normalizeOrigin(o); });
  if (kind === 'card') {
    const problem = cardGrantProblem({ item: allItems ? '*' : item.id, origins: pats });
    if (problem) throw new Error(`${problem}: ask for one card and the exact checkout site(s)`);
  }

  const covered = (pol, p) => {
    const gs = matchingGrants(pol, { vault: vName, itemId: item.id, origin: p, kind });
    return gs.some((g) => (!allow_visible_secrets || g.allow_visible_secrets) && (!allow_submit || g.allow_submit) && frames.every((f) => (g.frame_origins || []).includes(f)));
  };
  const already = (pol) => !allItems && pats.every((p) => !isWildcard(p) && covered(pol, p));
  const alreadyResult = () => ({ approved: true, already: true, [word]: item.name, origins: pats });
  if (already(policy)) return alreadyResult();
  const itemSites = item?.uris ? item.uris.map((u) => { try { return normalizeOrigin(u); } catch { return u; } }) : [];
  const siteMismatch = Boolean(item?.uris) && pats.some((p) => !isWildcard(p) && !itemSites.includes(p));

  // One dialog at a time across all agent sessions. While waiting, another session's
  // request may have been approved already: re-check, so the user isn't asked twice.
  return withLock('dialog', async () => {
  if (already(loadPolicy())) return alreadyResult();
  const answer = await askUser({ purpose: kind, frameOrigins: frames, allowVisibleSecrets: allow_visible_secrets, itemName: item?.name, itemSites, vaultLabel: vaultLabel(vName, v), origins: pats, allItems, allowSubmit: allow_submit, reason, siteMismatch });
  audit({ action: 'authorize', kind, vault: vName, item: item?.name ?? '*', origins: pats, answer });
  if (answer === 'deny') return { approved: false, message: 'The user denied this request. Do not retry unless the user asks you to.' };

  await updatePolicy((fresh) => {
  pruneExpired(fresh);
  addGrant(fresh, {
    ...(kind !== 'login' && { kind }),
    vault: vName,
    item: allItems ? '*' : item.id,
    item_name: allItems ? `ALL (${v.scope})` : item.name,
    origins: pats,
    ...(frames.length && { frame_origins: frames }),
    allow_submit,
    ...(allow_visible_secrets && { allow_visible_secrets: true }),
    ...(answer === 'hour' && { expires_at: new Date(Date.now() + 3600_000).toISOString() }),
    approved_at: new Date().toISOString(),
    approved_via: 'dialog',
  });
  });
  return { approved: true, [word]: item?.name ?? '*', origins: pats, ...(frames.length && { frame_origins: frames }), allow_submit, ...(answer === 'hour' && { expires_in: '1 hour' }) };
  }, { timeoutMs: 15 * 60_000, staleMs: 5 * 60_000 });
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
    await updatePolicy((fresh) => {
      addGrant(fresh, { vault: vName, item: saved.id, item_name: saved.name, origins: [origin], allow_submit: true, approved_at: new Date().toISOString(), approved_via: `signup approval for ${idItem.name}` });
    });
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

// fill_details: identity details (contact, shipping, billing address) and/or a payment card.
// Card values go into the page only; the card approval names exact sites and, for payment
// iframes, the exact frame origins. Card fields are filled before identity fields so a
// "Name on card" box is not mistaken for the identity's name.
export const DETAIL_KINDS = [...CARD_KINDS, ...IDENTITY_FIELDS];
const AUTO_SKIP = new Set(['username']); // only filled when a selector asks for it

export async function fillDetails({ identity, card, vault, target, fields, submit = false }) {
  if (!identity && !card) throw new Error('pass identity, card, or both');
  const policy = loadPolicy();
  const vName = vaultName(policy, vault);
  const v = openVault(vName, policy.vaults[vName]);
  const idItem = identity ? await v.findIdentity?.(identity) : null;
  if (identity && !idItem) throw new Error(`identity "${identity}" is not in vault ${vaultLabel(vName, v)}; see list_logins`);
  const cardItem = card ? await v.findCard?.(card) : null;
  if (card && !cardItem) throw new Error(`card "${card}" is not in vault ${vaultLabel(vName, v)}; see list_logins (cards need item_types including card in the vault config)`);

  const explicit = fields && Object.keys(fields).length ? fields : null;
  const unknown = explicit ? Object.keys(explicit).filter((k) => !DETAIL_KINDS.includes(k)) : [];
  if (unknown.length) throw new Error(`unknown field(s): ${unknown.join(', ')} (known: ${DETAIL_KINDS.join(', ')})`);
  if (explicit && !card && Object.keys(explicit).some((k) => CARD_KINDS.includes(k))) throw new Error('card fields were given but no card');
  if (explicit && !identity && Object.keys(explicit).some((k) => IDENTITY_FIELDS.includes(k))) throw new Error('identity fields were given but no identity');

  // 1. Real page origin, and the user's approvals for it.
  const resolved = await resolveTarget(target, policy);
  const origin = normalizeOrigin(resolved.url);
  const idGrants = idItem ? [...matchingGrants(policy, { vault: vName, itemId: idItem.id, origin, kind: 'identity' }), ...matchingGrants(policy, { vault: vName, itemId: idItem.id, origin, kind: 'signup' })] : [];
  const cardGrants = cardItem ? matchingGrants(policy, { vault: vName, itemId: cardItem.id, origin, kind: 'card' }) : [];
  const refuse = (what, name, extra) => {
    audit({ action: 'details', vault: vName, [what]: name, origin, result: 'not-approved' });
    throw new Error(`${what} "${name}" is not approved for ${origin}. Call request_authorization with ${what} "${name}"${extra} and origin "${origin}"; the user decides.`);
  };
  if (idItem && !idGrants.length) refuse('identity', idItem.name, ', identity_use "details"');
  if (cardItem && !cardGrants.length) refuse('card', cardItem.name, '');
  if (submit && ((idItem && !idGrants.some((g) => g.allow_submit)) || (cardItem && !cardGrants.some((g) => g.allow_submit)))) {
    throw new Error(`the approval${cardItem ? ` for card "${cardItem.name}"` : ''} on ${origin} does not allow submitting; fill without submit (the user can submit), or ask for allow_submit`);
  }

  // 2. Values, straight from the vault to the browser channel.
  const vals = {
    ...(cardItem && cardFillValues(await v.card(cardItem.id))),
    ...(idItem && await v.identity(idItem.id)),
  };
  const groupOf = (k) => (CARD_KINDS.includes(k) ? 'card' : 'identity');
  let kinds;
  if (explicit) {
    kinds = DETAIL_KINDS.filter((k) => k in explicit);
    const missing = kinds.filter((k) => !vals[k]);
    if (missing.length) throw new Error(`the ${missing.map((k) => (groupOf(k) === 'card' ? `card has no ${k}` : `identity has no ${k}`)).join(', ')}`);
  } else {
    kinds = DETAIL_KINDS.filter((k) => vals[k] && !AUTO_SKIP.has(k));
  }
  const frameOrigins = {
    identity: [...new Set(idGrants.flatMap((g) => g.frame_origins || []))],
    card: [...new Set(cardGrants.flatMap((g) => g.frame_origins || []))],
  };
  const req = {
    mode: 'details', expectedOrigin: origin, frameOrigins, submit,
    fields: kinds.map((k) => ({ kind: k, group: groupOf(k), selector: explicit?.[k], value: vals[k] })),
  };
  for (const k of Object.keys(vals)) vals[k] = undefined;
  let result;
  try {
    result = await sendFill(target, resolved, req, policy);
  } finally {
    for (const f of req.fields) f.value = undefined;
  }
  audit({ action: 'details', vault: vName, identity: idItem?.name, card: cardItem?.name, origin, channel: target.type, result: result?.ok ? 'filled' : 'failed', fields: result?.filled, skipped: result?.skipped, frames: result?.filled_in_frames, submitted: result?.submitted });
  if (!result?.ok) throw new Error(result?.error || 'fill failed');
  return {
    ...result, ...(idItem && { identity: idItem.name }), ...(cardItem && { card: cardItem.name }),
    ...(resolved.tab_id != null && { tab_id: resolved.tab_id, profile: resolved.profile }), ...(resolved.target_id && { target_id: resolved.target_id }),
  };
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
