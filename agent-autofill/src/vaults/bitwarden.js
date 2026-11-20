// Bitwarden / Vaultwarden through the official `bw` CLI. The session key comes
// from BW_SESSION or the macOS Keychain (agent-vault stores it there).
import { execFile } from 'node:child_process';
import os from 'node:os';
import { spawn } from 'node:child_process';
import { promisify } from 'node:util';
import { IDENTITY_FIELDS, fromBitwarden } from './identity-fields.js';
import { describeScope, fieldAllowed, inScope, normalizeScope } from './bitwarden-scope.js';
import { applyField, newItem } from './save-field.js';

const run = promisify(execFile);

// Bitwarden custom field types: 0 text, 1 hidden, 2 boolean, 3 linked (skipped: it points at username/password).
const FIELD_TYPES = { 0: 'text', 1: 'hidden', 2: 'boolean' };
function customMeta(fields = [], scope) {
  return (fields || []).filter((f) => f.name && FIELD_TYPES[f.type] && fieldAllowed(scope, f.name)).map((f) => ({ name: f.name, type: FIELD_TYPES[f.type] }));
}

export function create(cfg) {
  const bw = cfg.bw_bin || 'bw';
  const scope = normalizeScope(cfg); // throws on a missing or unsafe scope
  let session;
  let ids; // resolved folder / collection / organization ids
  let synced = 0;

  async function getSession() {
    if (process.env.BW_SESSION) return process.env.BW_SESSION;
    if (session) return session;
    if (!cfg.session_keychain_service) throw new Error('bitwarden: no BW_SESSION and no session_keychain_service configured');
    try {
      const { stdout } = await run('/usr/bin/security', ['find-generic-password', '-s', cfg.session_keychain_service, '-a', os.userInfo().username, '-w']);
      session = stdout.trim();
      return session;
    } catch {
      throw new Error(`bitwarden: no session in Keychain item "${cfg.session_keychain_service}" (unlock the vault, e.g. agent-vault/refresh-agent-session.sh)`);
    }
  }

  async function bwJson(args) {
    const env = { ...process.env, BW_SESSION: await getSession(), BW_NOINTERACTION: 'true' };
    try {
      const { stdout } = await run(bw, [...args, '--nointeraction'], { env, maxBuffer: 32 * 1024 * 1024 });
      return stdout;
    } catch (e) {
      session = undefined; // maybe expired; re-read next time
      const msg = String(e.stderr || e.message).split('\n')[0];
      throw new Error(`bitwarden: bw ${args[0]} ${args[1] ?? ''} failed: ${msg}`);
    }
  }

  // Where new items go: save_folder, else the first collection of the scope.
  async function placement() {
    const r = await resolveIds();
    if (scope.all) return { folderId: r.saveFolderId ?? null };
    if (r.saveFolderId) return { folderId: r.saveFolderId };
    const collectionId = [...r.collectionIds][0];
    if (!collectionId) throw new Error('bitwarden: set save_folder (or a folder or collection) so new items land inside the scope');
    const organizationId = JSON.parse(await bwJson(['list', 'collections'])).find((c) => c.id === collectionId)?.organizationId ?? null;
    return { folderId: null, organizationId, collectionIds: [collectionId] };
  }

  async function sync() {
    if (Date.now() - synced < 60_000) return;
    await bwJson(['sync']).catch(() => {}); // offline is fine: use the local cache
    synced = Date.now();
  }

  async function resolveIds() {
    if (ids) return ids;
    const pick = async (what, refs) => {
      if (!refs.length) return new Map();
      const all = JSON.parse(await bwJson(['list', what]));
      return new Map(refs.map((ref) => {
        const hit = all.find((x) => x.id === ref) || all.find((x) => x.name === ref);
        if (!hit) throw new Error(`bitwarden: ${what.replace(/s$/, '')} "${ref}" not found`);
        return [ref, hit.id];
      }));
    };
    const folders = await pick('folders', scope.folders);
    const collections = await pick('collections', scope.collections);
    const orgs = await pick('organizations', scope.organizations);
    ids = {
      folderIds: new Set(folders.values()), collectionIds: new Set(collections.values()), orgIds: new Set(orgs.values()),
      saveFolderId: scope.saveFolder ? (folders.get(scope.saveFolder) ?? (await pick('folders', [scope.saveFolder])).get(scope.saveFolder)) : undefined,
    };
    return ids;
  }

  // Ask bw only for the configured folders / collections / organizations, then
  // filter again (types, exclusions) so nothing outside the scope reaches callers.
  async function allItems(force) {
    if (force) synced = 0;
    await sync();
    const r = await resolveIds();
    const queries = scope.all ? [[]] : [
      ...[...r.folderIds].map((id) => ['--folderid', id]),
      ...[...r.collectionIds].map((id) => ['--collectionid', id]),
      ...[...r.orgIds].map((id) => ['--organizationid', id]),
    ];
    const byId = new Map();
    for (const q of queries) for (const i of JSON.parse(await bwJson(['list', 'items', ...q]))) byId.set(i.id, i);
    return [...byId.values()].filter((i) => inScope(i, scope, r));
  }
  const rawItems = async () => (await allItems()).filter((i) => i.type === 1);
  const rawIdentities = async () => (await allItems()).filter((i) => i.type === 4);

  // `bw create item` / `bw edit item <id>` read base64 JSON from stdin, so
  // secrets never appear in a process argument list.
  const bwCreate = (obj) => bwWrite(['create', 'item'], obj);
  const bwEdit = (id, obj) => bwWrite(['edit', 'item', id], obj);
  function bwWrite(cmd, obj) {
    return new Promise(async (resolve, reject) => {
      let env;
      try { env = { ...process.env, BW_SESSION: await getSession(), BW_NOINTERACTION: 'true' }; } catch (e) { return reject(e); }
      const p = spawn(bw, [...cmd, '--nointeraction'], { env });
      let out = '', err = '';
      p.stdout.on('data', (d) => (out += d));
      p.stderr.on('data', (d) => (err += d));
      p.on('error', reject);
      p.on('close', (code) => {
        if (code !== 0) return reject(new Error(`bitwarden: bw ${cmd[0]} item failed: ${err.split('\n')[0]}`));
        try { const r = JSON.parse(out); resolve({ id: r.id, name: r.name }); } catch { reject(new Error(`bitwarden: unexpected output from bw ${cmd[0]} item`)); }
      });
      p.stdin.end(Buffer.from(JSON.stringify(obj)).toString('base64'));
    });
  }

  return {
    type: 'bitwarden',
    scope: describeScope(scope),
    async list() {
      // Map immediately so secret fields never leave this function.
      return (await rawItems()).map((i) => ({
        id: i.id,
        name: i.name,
        uris: (i.login?.uris || []).map((u) => u.uri).filter(Boolean),
        hasUsername: Boolean(i.login?.username),
        hasPassword: Boolean(i.login?.password),
        hasTotp: Boolean(i.login?.totp),
        custom: customMeta(i.fields, scope),
      }));
    },
    async find(ref) {
      const all = await this.list();
      return all.find((i) => i.id === ref) || all.find((i) => i.name === ref);
    },
    async listIdentities() {
      return (await rawIdentities()).map((i) => {
        const vals = fromBitwarden(i.identity);
        return { id: i.id, name: i.name, has: IDENTITY_FIELDS.filter((f) => vals[f] && fieldAllowed(scope, f)) };
      });
    },
    async findIdentity(ref) {
      const all = await this.listIdentities();
      return all.find((i) => i.id === ref) || all.find((i) => i.name === ref);
    },
    async identity(id) {
      const item = (await rawIdentities()).find((i) => i.id === id);
      if (!item) throw new Error('bitwarden: identity not found in the configured scope');
      const vals = fromBitwarden(item.identity);
      for (const f of Object.keys(vals)) if (!fieldAllowed(scope, f)) delete vals[f];
      return vals;
    },
    async createLogin({ name, username, password, uris, notes }) {
      const created = await bwCreate({
        type: 1, name, notes, favorite: false, reprompt: 0, ...(await placement()),
        login: { username, password, totp: null, uris: uris.map((uri) => ({ uri, match: null })) },
      });
      synced = 0; // make the new item visible to the next list()
      return created;
    },
    // save_from_page: create an item or merge one value into an existing one (inside the scope only).
    async saveField({ create, item_type = 'login', item, item_name, uris, field_kind, field_name, field_type, value, overwrite }) {
      if (field_kind === 'custom' && !fieldAllowed(scope, field_name)) throw new Error(`bitwarden: field "${field_name}" is excluded by exclude_fields`);
      if (!scope.types.includes(item_type)) throw new Error(`bitwarden: item_types for this vault do not include ${item_type}`);
      const pool = await (item_type === 'identity' ? rawIdentities() : rawItems());
      if (create) {
        if (!item_name) throw new Error('item_name is required when create is true');
        const dup = pool.find((i) => i.name === item_name);
        if (dup) throw new Error(`an item named "${item_name}" already exists (id ${dup.id}); use create: false with item "${dup.id}"`);
        const obj = { ...newItem({ item_type, name: item_name, uris, notes: `Created by agent-autofill save_from_page on ${new Date().toISOString()}.` }), ...(await placement()) };
        const outcome = applyField(obj, { field_kind, field_name, field_type, value, overwrite: false });
        const created = await bwCreate(obj);
        synced = 0;
        return { id: created.id, name: created.name, outcome: outcome === 'unchanged' ? 'added' : outcome, created: true };
      }
      const existing = pool.find((i) => i.id === item) || pool.find((i) => i.name === item);
      if (!existing) throw new Error(`bitwarden: ${item_type} "${item}" not found in the configured scope`);
      const obj = structuredClone(existing);
      const outcome = applyField(obj, { field_kind, field_name, field_type, value, overwrite });
      if (outcome !== 'unchanged') { await bwEdit(existing.id, obj); synced = 0; }
      return { id: existing.id, name: existing.name, outcome, created: false };
    },
    async secrets(id, kinds, customNames) {
      const item = (await rawItems()).find((i) => i.id === id); // re-checks the folder scope
      if (!item) throw new Error('bitwarden: item not found in the configured scope');
      const out = {};
      if (kinds.includes('username')) out.username = item.login?.username ?? undefined;
      if (kinds.includes('password')) out.password = item.login?.password ?? undefined;
      if (kinds.includes('totp')) out.totp = item.login?.totp ? (await bwJson(['get', 'totp', id])).trim() : undefined;
      if (customNames?.length) {
        out.custom = {};
        for (const n of customNames) {
          if (!fieldAllowed(scope, n)) continue;
          const f = (item.fields || []).find((x) => x.name === n && x.type !== 3);
          if (f) out.custom[n] = f.type === 2 ? String(f.value) === 'true' : f.value ?? '';
        }
      }
      return out;
    },
  };
}
