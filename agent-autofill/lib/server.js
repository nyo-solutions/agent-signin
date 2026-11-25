// Server entry point: fill vault logins from a Node process that drives its own
// headless browser (Playwright, Puppeteer), with no Chrome extension, MCP server,
// approval dialog or policy file. The calling service decides which sites each
// login may be filled on and passes them in; this library enforces them.
//
//   import { createAutofill, unlockBitwarden } from 'agent-autofill/server';
//
// Guarantees (same as the MCP tools):
//   - the page's origin is read from the browser, never taken from the caller, and must
//     match one of the allowed origins before any secret is read from the vault;
//   - the fill runs in an isolated world and re-checks the origin inside the page;
//   - results contain field names only, never values;
//   - every fill, allowed or refused, goes to the audit sink (no values in events).
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fillPage } from '../extension/fill-page.js';
import { audit as fileAudit } from '../src/audit.js';
import { cdpFill, cdpTarget } from '../src/channels/cdp.js';
import { normalizeOrigin, originMatches, parsePattern } from '../src/policy.js';
import * as bitwarden from '../src/vaults/bitwarden.js';
import * as env from '../src/vaults/env.js';

const run = promisify(execFile);
const LOGIN_KINDS = ['username', 'password', 'totp'];

function checkOrigins(origins) {
  if (!Array.isArray(origins) || !origins.length) throw new Error('origins: pass the sites this login may be filled on');
  for (const o of origins) {
    const p = parsePattern(o); // throws on a malformed pattern
    if (p.any || p.host === '*') throw new Error(`origins: "${o}" would allow any site; name the sites`);
  }
  return origins;
}

function openAdapter(vault) {
  if (!vault) throw new Error('vault: pass { type: "bitwarden", ... }, { type: "env", ... } or an adapter object');
  if (typeof vault.find === 'function' && typeof vault.secrets === 'function') return vault;
  if (vault.type === 'bitwarden') return bitwarden.create(vault);
  if (vault.type === 'env') return env.create(vault);
  throw new Error(`vault: unknown type "${vault.type}" (bitwarden, env)`);
}

// A CDP session on one page: Playwright's page.context().newCDPSession(page),
// Puppeteer's page.createCDPSession(), or anything with send(method, params).
async function sessionOrigin(session) {
  const { frameTree } = await session.send('Page.getFrameTree');
  return { url: frameTree.frame.url, frameId: frameTree.frame.id };
}

async function sessionFill(session, req) {
  const { frameTree } = await session.send('Page.getFrameTree');
  if (new URL(frameTree.frame.url).origin !== req.expectedOrigin) {
    throw new Error(`page origin is ${new URL(frameTree.frame.url).origin}, expected ${req.expectedOrigin}`);
  }
  const { executionContextId } = await session.send('Page.createIsolatedWorld', { frameId: frameTree.frame.id, worldName: 'agent-autofill' });
  const { result, exceptionDetails } = await session.send('Runtime.callFunctionOn', {
    functionDeclaration: fillPage.toString(), executionContextId, arguments: [{ value: req }], returnByValue: true, awaitPromise: true,
  });
  if (exceptionDetails) throw new Error(`fill script failed: ${exceptionDetails.exception?.description?.split('\n')[0] || exceptionDetails.text}`);
  return result.value;
}

/**
 * @param {object} opts
 * @param {object} opts.vault  { type: 'bitwarden', bw_bin?, folders? | collections? | organizations?, item_types?,
 *                             exclude_fields?, session: string | () => string|Promise<string>, appdata_dir? }
 *                             or { type: 'env', prefix? } or a custom adapter (see src/vaults/index.js).
 * @param {(event: object) => void} [opts.audit]  receives one event per fill; default appends to
 *                             $AGENT_AUTOFILL_HOME/audit.log. Events never contain secret values.
 * @param {string[]} [opts.cdpAllowedHosts]  hosts a `cdp.endpoint` may point at (default loopback only).
 */
export function createAutofill({ vault, audit = fileAudit, cdpAllowedHosts = ['127.0.0.1', 'localhost', '::1'] } = {}) {
  const v = openAdapter(vault);
  const vaultLabel = vault.type || v.type || 'custom';
  const record = (e) => { try { audit({ ts: new Date().toISOString(), vault: vaultLabel, ...e }); } catch {} };

  return {
    /** Logins in the vault scope: names, sites and which fields exist. No values. */
    async listLogins() {
      return (await v.list()).map((i) => ({
        id: i.id, name: i.name, sites: i.uris || [],
        has: [i.hasUsername && 'username', i.hasPassword && 'password', i.hasTotp && 'totp'].filter(Boolean),
        custom_fields: (i.custom || []).map((f) => ({ name: f.name, type: f.type })),
      }));
    },

    /**
     * Fill a login into the page.
     * @param {object} a
     * @param {string} a.login  vault item id or exact name
     * @param {string[]} a.origins  sites this login may be filled on, e.g. ['https://staging.example.com']
     *                  (exact origins or "https://*.example.com"; "*" and "https://*" are refused)
     * @param {object} [a.session]  a CDP session on the page (Playwright: await page.context().newCDPSession(page))
     * @param {object} [a.cdp]  or { endpoint: 'http://127.0.0.1:9222', target_id? | url_contains? }
     * @param {object} [a.fields]  { username?, password?, totp? }: 'auto' or a CSS selector; default username + password
     * @param {object} [a.custom]  { "<custom field name>": 'auto' | selector }
     * @param {boolean} [a.submit]  submit the form after filling
     * @param {object} [a.context]  extra fields for the audit event (e.g. { run_id, connection_id }); no secrets
     * @returns {Promise<{ ok: true, login: string, origin: string, filled: string[], submitted: boolean }>}
     */
    async fillLogin({ login, origins, session, cdp, fields, custom, submit = false, context = {} }) {
      checkOrigins(origins);
      if (!session === !cdp) throw new Error('pass exactly one of session (a CDP session on the page) or cdp ({ endpoint, ... })');
      const item = await v.find(login);
      if (!item) throw new Error(`login "${login}" is not in the vault scope`);

      // 1. Where is the page really? Ask the browser.
      const resolved = session ? await sessionOrigin(session) : await cdpTarget(cdp, cdpAllowedHosts);
      const origin = normalizeOrigin(resolved.url);
      const base = { action: 'fill', login: item.name, origin, channel: session ? 'cdp-session' : 'cdp', ...context };

      // 2. Is it one of the allowed sites?
      if (!origins.some((p) => originMatches(p, origin))) {
        record({ ...base, result: 'not-allowed' });
        throw new Error(`"${item.name}" may not be filled on ${origin} (allowed: ${origins.join(', ')})`);
      }

      const customNames = Object.keys(custom || {});
      const wanted = fields && Object.keys(fields).length ? fields : customNames.length ? {} : { username: 'auto', password: 'auto' };
      const kinds = Object.keys(wanted).filter((k) => LOGIN_KINDS.includes(k));
      const unknown = Object.keys(wanted).filter((k) => !LOGIN_KINDS.includes(k));
      if (unknown.length) throw new Error(`fields: unknown ${unknown.join(', ')} (username, password, totp)`);
      if (!kinds.length && !customNames.length) throw new Error('fields must name username, password and/or totp, or pass custom');
      const meta = Object.fromEntries((item.custom || []).map((f) => [f.name, f]));
      const unknownCustom = customNames.filter((n) => !meta[n]);
      if (unknownCustom.length) throw new Error(`"${item.name}" has no custom field ${unknownCustom.map((n) => `"${n}"`).join(', ')}`);

      // 3. Read the secrets and hand them straight to the page.
      const secrets = await v.secrets(item.id, kinds, customNames);
      const missing = [...kinds.filter((k) => !secrets[k]), ...customNames.filter((n) => secrets.custom?.[n] === undefined)];
      if (missing.length) {
        record({ ...base, result: 'missing-fields', fields: missing });
        throw new Error(`"${item.name}" has no ${missing.join(', ')} in the vault`);
      }
      const req = {
        expectedOrigin: origin,
        allowVisibleSecrets: false,
        fields: [
          ...kinds.map((k) => ({ kind: k, selector: wanted[k], value: secrets[k] })),
          ...customNames.map((n) => ({ kind: 'custom', name: n, ctype: meta[n].type, selector: custom[n], value: secrets.custom[n] })),
        ],
        submit,
      };
      for (const k of Object.keys(secrets)) secrets[k] = undefined;
      let result;
      try {
        result = session ? await sessionFill(session, req) : await cdpFill(cdp, resolved, req, cdpAllowedHosts);
      } catch (e) {
        result = { ok: false, error: e.message };
      } finally {
        for (const f of req.fields) f.value = undefined;
      }
      record({ ...base, result: result?.ok ? 'filled' : 'failed', fields: result?.filled, submitted: result?.submitted });
      if (!result?.ok) throw new Error(result?.error || 'fill failed');
      return { ok: true, login: item.name, origin, filled: result.filled, submitted: Boolean(result.submitted) };
    },
  };
}

/**
 * Unlock a Bitwarden / Vaultwarden account with no person present and return a session key.
 * Uses a personal API key (client_id / client_secret) plus the master password. Secrets go to
 * `bw` through environment variables, never the argument list. Keep the returned key in memory.
 * @param {object} o
 * @param {string} o.client_id  'user.xxxxxxxx-...' from Account settings > Security > Keys > API key
 * @param {string} o.client_secret
 * @param {string} o.password  the account's master password
 * @param {string} [o.server]  e.g. 'https://vault.example.com' (Vaultwarden); default: keep bw's setting
 * @param {string} [o.bw_bin]  default 'bw'
 * @param {string} [o.appdata_dir]  bw data folder for this service (pass the same value to createAutofill's vault)
 * @returns {Promise<string>} the session key (pass as vault.session)
 */
export async function unlockBitwarden({ client_id, client_secret, password, server, bw_bin = 'bw', appdata_dir }) {
  if (!client_id || !client_secret || !password) throw new Error('unlockBitwarden: client_id, client_secret and password are required');
  const envVars = {
    ...process.env, BW_NOINTERACTION: 'true',
    BW_CLIENTID: client_id, BW_CLIENTSECRET: client_secret, AGENT_AUTOFILL_BW_PASSWORD: password,
    ...(appdata_dir && { BITWARDENCLI_APPDATA_DIR: appdata_dir }),
  };
  delete envVars.BW_SESSION;
  const bw = async (...args) => {
    try {
      return (await run(bw_bin, [...args, '--nointeraction'], { env: envVars, maxBuffer: 8 * 1024 * 1024 })).stdout.trim();
    } catch (e) {
      throw new Error(`unlockBitwarden: bw ${args[0]} failed: ${String(e.stderr || e.message).split('\n')[0]}`);
    }
  };
  let status = JSON.parse(await bw('status'));
  if (server && status.serverUrl !== server) {
    if (status.status !== 'unauthenticated') { await bw('logout'); status = { status: 'unauthenticated' }; }
    await bw('config', 'server', server);
  }
  if (status.status === 'unauthenticated') await bw('login', '--apikey');
  const session = await bw('unlock', '--passwordenv', 'AGENT_AUTOFILL_BW_PASSWORD', '--raw');
  if (!session) throw new Error('unlockBitwarden: bw unlock returned no session');
  await run(bw_bin, ['sync', '--nointeraction'], { env: { ...envVars, BW_SESSION: session } }).catch(() => {});
  return session;
}
