// Vault adapters. Each adapter implements:
//   list()               -> [{ id, name, uris: [string], hasUsername, hasPassword, hasTotp }]  (no secrets)
//   find(ref)            -> one of list() by id or exact name, or undefined
//   secrets(id, kinds, customNames?) -> { username?, password?, totp?, custom?: { name: value } }  (totp = current code)
//   list() items also carry custom: [{ name, type: 'text'|'hidden'|'boolean' }]  (names only)
//   listIdentities()     -> [{ id, name, has: [field] }]  (no values)
//   findIdentity(ref)    -> one of listIdentities() by id or exact name
//   identity(id)         -> { first_name, last_name, full_name, email, username, phone, company,
//                             address1, address2, city, state, postal_code, country }
//   listCards() / findCard(ref) -> [{ id, name, brand, has: [field] }]   (optional; only with item_types card)
//   card(id)             -> { cardholder_name, number, exp_month (MM), exp_year (YYYY), code, brand }
//   createLogin({ name, username, password, uris, notes }) -> { id, name }   (optional)
// Only items an adapter lists are fillable, so scope adapters narrowly (e.g. one folder).
// To add a vendor: write a module exporting create(config) and register it below.
import * as bitwarden from './bitwarden.js';
import * as env from './env.js';

const ADAPTERS = { bitwarden, env };
const cache = new Map();

export function openVault(name, config) {
  const key = `${name}:${JSON.stringify(config)}`;
  if (!cache.has(key)) {
    const mod = ADAPTERS[config.type];
    if (!mod) throw new Error(`vault "${name}": unknown type "${config.type}" (known: ${Object.keys(ADAPTERS).join(', ')})`);
    cache.set(key, mod.create(config));
  }
  return cache.get(key);
}
