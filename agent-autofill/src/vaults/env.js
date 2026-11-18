// Logins from environment variables, for CI and headless runs:
//   <PREFIX><NAME>_USERNAME, <PREFIX><NAME>_PASSWORD, <PREFIX><NAME>_TOTP_SECRET (base32 or otpauth://),
//   <PREFIX><NAME>_URL (optional, shown as the login's site). Default prefix AGENT_AUTOFILL_.
//   Custom fields: <PREFIX><NAME>_FIELD_<FIELD> (text), _SECRET_<FIELD> (hidden), _FLAG_<FIELD> (boolean, "true"); names lower-cased.
//   Identities: <PREFIX>IDENTITY_<NAME>='{"first_name":"…","email":"…",…}' (JSON, keys as in identity-fields.js).
//   createLogin keeps generated logins in memory for the life of the MCP server (ephemeral CI accounts).
import crypto from 'node:crypto';
import { totp } from '../totp.js';
import { IDENTITY_FIELDS } from './identity-fields.js';

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
  const created = new Map(); // id -> { name, username, password, uris }
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
      const mem = [...created.entries()].map(([id, c]) => ({ id, name: c.name, uris: c.uris, hasUsername: Boolean(c.username), hasPassword: true, hasTotp: false }));
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
      created.set(id, { name, username, password, uris });
      return { id, name };
    },
    async find(ref) {
      const all = await this.list();
      return all.find((i) => i.id === ref) || all.find((i) => i.name === ref) || all.find((i) => i.id === ref.toLowerCase());
    },
    async secrets(id, kinds, customNames) {
      if (created.has(id)) {
        const c = created.get(id);
        return { ...(kinds.includes('username') && { username: c.username }), ...(kinds.includes('password') && { password: c.password }) };
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
