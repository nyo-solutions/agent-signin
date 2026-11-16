// Logins from environment variables, for CI and headless runs:
//   <PREFIX><NAME>_USERNAME, <PREFIX><NAME>_PASSWORD, <PREFIX><NAME>_TOTP_SECRET (base32 or otpauth://),
//   <PREFIX><NAME>_URL (optional, shown as the login's site). Default prefix AGENT_AUTOFILL_.
import { totp } from '../totp.js';

export function create(cfg) {
  const prefix = cfg.prefix || 'AGENT_AUTOFILL_';
  const names = () => {
    const set = new Set();
    for (const k of Object.keys(process.env)) {
      const m = k.startsWith(prefix) && /^(.+)_(USERNAME|PASSWORD|TOTP_SECRET)$/.exec(k.slice(prefix.length));
      if (m) set.add(m[1]);
    }
    return [...set];
  };
  const v = (n, s) => process.env[`${prefix}${n}_${s}`];
  return {
    type: 'env',
    scope: `env ${prefix}*`,
    async list() {
      return names().map((n) => ({
        id: n.toLowerCase(),
        name: n.toLowerCase(),
        uris: v(n, 'URL') ? [v(n, 'URL')] : [],
        hasUsername: Boolean(v(n, 'USERNAME')),
        hasPassword: Boolean(v(n, 'PASSWORD')),
        hasTotp: Boolean(v(n, 'TOTP_SECRET')),
      }));
    },
    async find(ref) {
      return (await this.list()).find((i) => i.id === ref.toLowerCase());
    },
    async secrets(id, kinds) {
      const n = names().find((x) => x.toLowerCase() === id);
      if (!n) throw new Error('env: login not found');
      return {
        ...(kinds.includes('username') && { username: v(n, 'USERNAME') }),
        ...(kinds.includes('password') && { password: v(n, 'PASSWORD') }),
        ...(kinds.includes('totp') && { totp: v(n, 'TOTP_SECRET') ? totp(v(n, 'TOTP_SECRET')) : undefined }),
      };
    },
  };
}
