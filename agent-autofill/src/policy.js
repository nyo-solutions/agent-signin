// The allow-list. Only the user writes approvals into it: through the
// request_authorization dialog, or the `agent-autofill allow` CLI.
import fs from 'node:fs';
import path from 'node:path';
import YAML from 'yaml';
import { POLICY_PATH } from './paths.js';

const DEFAULTS = { vaults: {}, default_vault: undefined, cdp: { allowed_hosts: ['127.0.0.1', 'localhost', '::1'] }, grants: [] };

export function loadPolicy(file = POLICY_PATH) {
  if (!fs.existsSync(file)) return structuredClone(DEFAULTS);
  const doc = YAML.parse(fs.readFileSync(file, 'utf8')) || {};
  const p = { ...structuredClone(DEFAULTS), ...doc };
  p.cdp = { ...DEFAULTS.cdp, ...(doc.cdp || {}) };
  p.grants = (doc.grants || []).map((g) => ({ allow_submit: true, ...g, origins: (g.origins || []).map(String) }));
  for (const g of p.grants) g.origins.forEach(parsePattern); // fail fast on a typo
  return p;
}

export function savePolicy(policy, file = POLICY_PATH) {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const header = '# agent-autofill allow-list. Approvals are added by the request_authorization dialog\n# or `agent-autofill allow`. Origin wildcards: "*" any site, "https://*" any HTTPS site,\n# "https://*.example.com" domain + subdomains, "http://localhost:*" any port. item "*" = every item in the vault folder.\n# kind: signup grants let fill_signup use an identity (item) on those sites.\n';
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, header + YAML.stringify(policy), { mode: 0o600 });
  fs.renameSync(tmp, file);
}

export function vaultName(policy, name) {
  const v = name || policy.default_vault || Object.keys(policy.vaults)[0];
  if (!v || !policy.vaults[v]) throw new Error(`vault "${v ?? ''}" is not configured in ${POLICY_PATH}`);
  return v;
}

// Origin patterns: "*", "<scheme>://*", "<scheme>://host[:port|:*]", "<scheme>://*.domain[:port|:*]".
const RX = /^(\*|[a-z][a-z0-9+.-]*):\/\/(\*|\*\.[^:/\s]+|\[[^\]]+\]|[^:/\s*]+)(?::(\d+|\*))?\/?$/i;

export function parsePattern(pattern) {
  if (pattern === '*') return { any: true };
  const m = RX.exec(pattern);
  if (!m) throw new Error(`invalid origin pattern "${pattern}"`);
  return { scheme: m[1].toLowerCase(), host: m[2].toLowerCase(), port: m[3] };
}

export function normalizeOrigin(urlOrOrigin) {
  const o = new URL(urlOrOrigin).origin;
  if (o === 'null') throw new Error(`"${urlOrOrigin}" has no web origin`);
  return o;
}

export function originMatches(pattern, origin) {
  const p = parsePattern(pattern);
  if (p.any) return true;
  const u = new URL(origin);
  const scheme = u.protocol.slice(0, -1);
  if (p.scheme !== '*' && p.scheme !== scheme) return false;
  const host = u.hostname.toLowerCase();
  if (p.host !== '*') {
    if (p.host.startsWith('*.')) {
      const base = p.host.slice(2);
      if (host !== base && !host.endsWith(`.${base}`)) return false;
    } else if (p.host !== host) return false;
  }
  if (p.port === '*') return true;
  if (p.port) return u.port === p.port;
  return u.port === '' || p.host === '*';
}

export function isWildcard(pattern) {
  return pattern.includes('*');
}

const live = (g, now) => !g.expires_at || new Date(g.expires_at).getTime() > now;

// kind "login" (default; grants without a kind are login grants) or "signup" (item = identity).
const kindOf = (g) => g.kind || 'login';

export function findGrant(policy, { vault, itemId, origin, kind = 'login', now = Date.now() }) {
  return policy.grants.find(
    (g) => kindOf(g) === kind && g.vault === vault && (g.item === '*' || g.item === itemId) && live(g, now) && g.origins.some((p) => originMatches(p, origin)),
  );
}

export function grantsForItem(policy, vault, itemId, kind = 'login', now = Date.now()) {
  return policy.grants.filter((g) => kindOf(g) === kind && g.vault === vault && (g.item === '*' || g.item === itemId) && live(g, now));
}

export function addGrant(policy, grant) {
  // Merge into an existing grant for the same item/submit/expiry so the file stays readable.
  const same = policy.grants.find(
    (g) => kindOf(g) === kindOf(grant) && g.vault === grant.vault && g.item === grant.item && !g.expires_at && !grant.expires_at && g.allow_submit === grant.allow_submit,
  );
  if (same) {
    for (const o of grant.origins) if (!same.origins.includes(o)) same.origins.push(o);
    same.approved_at = grant.approved_at;
    return same;
  }
  policy.grants.push(grant);
  return grant;
}

export function pruneExpired(policy, now = Date.now()) {
  policy.grants = policy.grants.filter((g) => live(g, now));
}
