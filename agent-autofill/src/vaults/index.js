// Vault adapters. Each adapter implements:
//   list()               -> [{ id, name, uris: [string], hasUsername, hasPassword, hasTotp }]  (no secrets)
//   find(ref)            -> one of list() by id or exact name, or undefined
//   secrets(id, kinds)   -> { username?, password?, totp? }  (totp = current code)
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
