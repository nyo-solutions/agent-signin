// Logins from environment variables, for CI and headless runs:
//   <PREFIX><NAME>_USERNAME, <PREFIX><NAME>_PASSWORD, <PREFIX><NAME>_TOTP_SECRET (base32 or otpauth://),
//   <PREFIX><NAME>_URL (optional, shown as the login's site). Default prefix AGENT_AUTOFILL_.
//   Custom fields: <PREFIX><NAME>_FIELD_<FIELD> (text), _SECRET_<FIELD> (hidden), _FLAG_<FIELD> (boolean, "true"); names lower-cased.
//   Identities: <PREFIX>IDENTITY_<NAME>='{"first_name":"…","email":"…",…}' (JSON, keys as in identity-fields.js).
//   Logins created by fill_signup / save_from_page live in memory for the life of the MCP server
//   (ephemeral CI accounts); env-defined logins are read-only.
import crypto from 'node:crypto';
import { totp } from '../totp.js';
import { IDENTITY_FIELDS } from './identity-fields.js';
import { applyField, newItem } from './save-field.js';

const TYPE_NAME = { 0: 'text', 1: 'hidden', 2: 'boolean' };

export function create(cfg) {
  const prefix = cfg.prefix || 'AGENT_AUTOFILL_';
  const names = () => {
    const set = new Set();
    for (const k of Object.keys(process.env)) {
      const rest = k.slice(prefix.length);
      const m = k.startsWith(prefix) && !/_(FIELD|SECRET|FLAG)_/.test(rest) && /^(.+)_(USERNAME|PASSWORD|TOTP_SECRET)$/.exec(rest);
      if (m) set.add(m[1]);
    }
    return [...set];
  };
  const v = (n, s) => process.env[`${prefix}${n}_${s}`];
  const customOf = (n) => Object.keys(process.env).flatMap((k) => {
    const m = new RegExp(`^${prefix}${n}_(FIELD|SECRET|FLAG)_(.+)$`).exec(k);
    const type = m && { FIELD: 'text', SECRET: 'hidden', FLAG: 'boolean' }[m[1]];
    return m ? [{ name: m[2].toLowerCase(), type, value: type === 'boolean' ? process.env[k] === 'true' : process.env[k] }] : [];
  });
  const created = new Map(); // id -> item in Bitwarden JSON shape
  const idPrefix = `${prefix}IDENTITY_`;
  const identities = () => Object.keys(process.env).filter((k) => k.startsWith(idPrefix)).map((k) => {
    const name = k.slice(idPrefix.length).toLowerCase();
    let vals = {};
    try { vals = JSON.parse(process.env[k]); } catch { throw new Error(`env: ${k} is not valid JSON`); }
    return { id: name, name, vals: Object.fromEntries(IDENTITY_FIELDS.filter((f) => vals[f]).map((f) => [f, String(vals[f])])) };
  });
  return {
    type: 'env',
    scope: `env ${prefix}*`,
    async list() {
      const mem = [...created.entries()].filter(([, c]) => c.type === 1).map(([id, c]) => ({
        id, name: c.name, uris: (c.login.uris || []).map((u) => u.uri),
        hasUsername: Boolean(c.login.username), hasPassword: Boolean(c.login.password), hasTotp: Boolean(c.login.totp),
        custom: (c.fields || []).map((f) => ({ name: f.name, type: TYPE_NAME[f.type] })),
      }));
      return mem.concat(names().filter((n) => !n.startsWith('IDENTITY_')).map((n) => ({
        id: n.toLowerCase(),
        name: n.toLowerCase(),
        uris: v(n, 'URL') ? [v(n, 'URL')] : [],
        hasUsername: Boolean(v(n, 'USERNAME')),
        hasPassword: Boolean(v(n, 'PASSWORD')),
        hasTotp: Boolean(v(n, 'TOTP_SECRET')),
        custom: customOf(n).map(({ name, type }) => ({ name, type })),
      })));
    },
    async listIdentities() {
      return identities().map((i) => ({ id: i.id, name: i.name, has: Object.keys(i.vals) }));
    },
    async findIdentity(ref) {
      return (await this.listIdentities()).find((i) => i.id === ref.toLowerCase());
    },
    async identity(id) {
      const i = identities().find((x) => x.id === id);
      if (!i) throw new Error('env: identity not found');
      return i.vals;
    },
    async createLogin({ name, username, password, uris }) {
      const id = `generated-${crypto.randomUUID()}`;
      const item = newItem({ item_type: 'login', name, uris });
      Object.assign(item.login, { username, password });
      created.set(id, { ...item, id });
      return { id, name };
    },
    async saveField({ create, item_type = 'login', item, item_name, uris, field_kind, field_name, field_type, value, overwrite }) {
      if (item_type !== 'login') throw new Error('env: only logins can be saved');
      if (create) {
        if (!item_name) throw new Error('item_name is required when create is true');
        if ((await this.list()).some((i) => i.name === item_name)) throw new Error(`an item named "${item_name}" already exists; use create: false`);
        const id = `saved-${crypto.randomUUID()}`;
        const obj = { ...newItem({ item_type, name: item_name, uris }), id };
        applyField(obj, { field_kind, field_name, field_type, value, overwrite: false });
        created.set(id, obj);
        return { id, name: item_name, outcome: 'added', created: true };
      }
      const hit = [...created.values()].find((c) => c.id === item || c.name === item);
      if (!hit) throw new Error(`env: "${item}" is not a login created during this run (env-defined logins are read-only)`);
      const copy = structuredClone(hit);
      const outcome = applyField(copy, { field_kind, field_name, field_type, value, overwrite });
      created.set(hit.id, copy);
      return { id: hit.id, name: hit.name, outcome, created: false };
    },
    async find(ref) {
      const all = await this.list();
      return all.find((i) => i.id === ref) || all.find((i) => i.name === ref) || all.find((i) => i.id === ref.toLowerCase());
    },
    async secrets(id, kinds, customNames) {
      if (created.has(id)) {
        const c = created.get(id);
        return {
          ...(kinds.includes('username') && { username: c.login.username ?? undefined }),
          ...(kinds.includes('password') && { password: c.login.password ?? undefined }),
          ...(kinds.includes('totp') && { totp: c.login.totp ? totp(c.login.totp) : undefined }),
          ...(customNames?.length && { custom: Object.fromEntries((c.fields || []).filter((f) => customNames.includes(f.name)).map((f) => [f.name, f.value])) }),
        };
      }
      const n = names().find((x) => x.toLowerCase() === id);
      if (!n) throw new Error('env: login not found');
      return {
        ...(kinds.includes('username') && { username: v(n, 'USERNAME') }),
        ...(kinds.includes('password') && { password: v(n, 'PASSWORD') }),
        ...(kinds.includes('totp') && { totp: v(n, 'TOTP_SECRET') ? totp(v(n, 'TOTP_SECRET')) : undefined }),
        ...(customNames?.length && { custom: Object.fromEntries(customOf(n).filter((f) => customNames.includes(f.name)).map((f) => [f.name, f.value])) }),
      };
    },
  };
}
