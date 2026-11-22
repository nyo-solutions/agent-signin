// What part of a Bitwarden vault agent-autofill may read. Pure functions, so the
// rules are testable without a vault.
//
// vaults:
//   bitwarden:
//     type: bitwarden
//     folders: [ai, ai-staging]          # by name or id   (legacy: folder: ai)
//     collections: [Agents]              # organization collections, by name or id
//     organizations: [NYO]               # whole organizations, by name or id
//     scope: all                         # instead of the three above: the whole vault (not recommended)
//     item_types: [login, identity]      # default; add card to let agents fill payment cards (opt-in)
//     exclude_items: ["github.com", "<item id>"]
//     exclude_fields: ["Recovery codes", "phone"]   # custom fields and identity fields, never read
//     save_folder: ai                    # where fill_signup saves new logins (default: first folder)

// Bitwarden item types: 1 login, 2 secure note, 3 card, 4 identity, 5 SSH key.
// Logins and identities by default; cards only when listed in item_types. Notes and keys never.
export const TYPE_IDS = { login: 1, identity: 4, card: 3 };
const NEVER = { note: 2, secure_note: 2, ssh_key: 5 };

export function normalizeScope(cfg = {}) {
  const list = (x) => (x == null ? [] : Array.isArray(x) ? x.map(String) : [String(x)]);
  const folders = [...list(cfg.folders), ...list(cfg.folder)];
  const collections = list(cfg.collections);
  const organizations = [...list(cfg.organizations), ...list(cfg.organization)];
  const all = cfg.scope === 'all';
  if (cfg.scope != null && !all) throw new Error(`bitwarden vault: scope must be "all" or omitted, not "${cfg.scope}"`);
  if (all && (folders.length || collections.length || organizations.length)) {
    throw new Error('bitwarden vault: use either scope: all or folders/collections/organizations, not both');
  }
  if (!all && !folders.length && !collections.length && !organizations.length) {
    throw new Error('bitwarden vault: set folders, collections or organizations (or scope: all) so agents only reach what you choose');
  }
  const types = list(cfg.item_types ?? ['login', 'identity']).map((t) => t.toLowerCase());
  for (const t of types) {
    if (NEVER[t]) throw new Error(`bitwarden vault: item_types "${t}" can never be enabled; supported: login, identity, card`);
    if (!TYPE_IDS[t]) throw new Error(`bitwarden vault: unknown item_types "${t}" (supported: login, identity, card)`);
  }
  return {
    all, folders, collections, organizations, types,
    excludeItems: list(cfg.exclude_items),
    excludeFields: list(cfg.exclude_fields).map((f) => f.toLowerCase()),
    saveFolder: cfg.save_folder != null ? String(cfg.save_folder) : folders[0],
  };
}

export function describeScope(s) {
  if (s.all) return 'whole vault';
  const q = (xs) => xs.map((x) => `"${x}"`).join(', ');
  const parts = [];
  if (s.folders.length) parts.push(`folder${s.folders.length > 1 ? 's' : ''} ${q(s.folders)}`);
  if (s.collections.length) parts.push(`collection${s.collections.length > 1 ? 's' : ''} ${q(s.collections)}`);
  if (s.organizations.length) parts.push(`organization${s.organizations.length > 1 ? 's' : ''} ${q(s.organizations)}`);
  if (s.excludeItems.length) parts.push(`minus ${s.excludeItems.length} excluded item(s)`);
  return parts.join(', ');
}

// ids: { folderIds: Set, collectionIds: Set, orgIds: Set } resolved from the names above.
export function inScope(item, s, ids) {
  if (!item || item.deletedDate) return false;
  if (!s.types.some((t) => TYPE_IDS[t] === item.type)) return false;
  if (s.excludeItems.includes(item.id) || s.excludeItems.includes(item.name)) return false;
  if (s.all) return true;
  return ids.folderIds.has(item.folderId) ||
    (item.collectionIds || []).some((c) => ids.collectionIds.has(c)) ||
    (item.organizationId != null && ids.orgIds.has(item.organizationId));
}

export const fieldAllowed = (s, name) => !s.excludeFields.includes(String(name).toLowerCase());
