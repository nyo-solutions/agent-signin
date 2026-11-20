// Merge one saved value into a vault item (Bitwarden item JSON shape). Pure, so
// the overwrite rules are the same for every adapter and easy to test.
//
// field_kind: custom (a custom field, by field_name) | username | password | totp (logins only)
// field_type: hidden | text (custom fields; default hidden for new fields, unchanged for existing ones)
// Outcomes: added (field was missing or empty), replaced (needs overwrite), unchanged (same value).
// A replaced password or hidden field is kept in the item's notes (encrypted in the vault, never
// shown to agents): the Bitwarden CLI drops passwordHistory on edit, so notes are the reliable place.

const BW_FIELD = { text: 0, hidden: 1 };
const HISTORY_MAX = 5;
const MARK = '[agent-autofill] previous';

export class FieldExistsError extends Error {}

export function applyField(item, { field_kind = 'custom', field_name, field_type, value, overwrite = false, now = new Date() }) {
  const label = field_kind === 'custom' ? `custom field "${field_name}"` : field_kind;
  const keep = (old) => {
    const lines = String(item.notes || '').split('\n').filter((l) => l !== '');
    const mine = lines.filter((l) => l.startsWith(MARK));
    const others = lines.filter((l) => !l.startsWith(MARK));
    const entry = `${MARK} ${label}, replaced ${now.toISOString()}: ${old}`;
    item.notes = [...others, ...[...mine, entry].slice(-HISTORY_MAX)].join('\n');
  };

  if (field_kind === 'custom') {
    if (!field_name) throw new Error('field_name is required for a custom field');
    item.fields = item.fields || [];
    const f = item.fields.find((x) => x.name === field_name) || item.fields.find((x) => String(x.name).toLowerCase() === field_name.toLowerCase());
    if (!f) {
      item.fields.push({ name: field_name, value, type: BW_FIELD[field_type || 'hidden'], linkedId: null });
      return 'added';
    }
    if (f.type !== 0 && f.type !== 1) throw new Error(`${label} is not a text or hidden field and cannot be saved into`);
    if (f.value === value) return 'unchanged';
    const hadValue = f.value != null && f.value !== '';
    if (hadValue) {
      if (!overwrite) throw new FieldExistsError(`${label} already has a different value; pass overwrite_allowed: true to replace it`);
      if (f.type === 1) keep(f.value);
    }
    f.value = value;
    if (field_type) f.type = BW_FIELD[field_type];
    return hadValue ? 'replaced' : 'added';
  }

  if (item.type !== 1) throw new Error(`${field_kind} can only be saved on a login item; use field_kind "custom" for identities`);
  if (!['username', 'password', 'totp'].includes(field_kind)) throw new Error(`unknown field_kind "${field_kind}"`);
  item.login = item.login || { username: null, password: null, totp: null, uris: [] };
  const old = item.login[field_kind];
  if (old === value) return 'unchanged';
  if (old != null && old !== '') {
    if (!overwrite) throw new FieldExistsError(`${label} already has a different value; pass overwrite_allowed: true to replace it`);
    if (field_kind === 'password') keep(old);
    item.login[field_kind] = value;
    return 'replaced';
  }
  item.login[field_kind] = value;
  return 'added';
}

export function newItem({ item_type, name, uris, notes }) {
  const base = { name, notes: notes ?? null, favorite: false, reprompt: 0, fields: [] };
  if (item_type === 'identity') return { ...base, type: 4, identity: {} };
  return { ...base, type: 1, login: { username: null, password: null, totp: null, uris: (uris || []).map((uri) => ({ uri, match: null })) } };
}
