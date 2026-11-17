// Bitwarden / Vaultwarden through the official `bw` CLI. The session key comes
// from BW_SESSION or the macOS Keychain (agent-vault stores it there).
import { execFile } from 'node:child_process';
import os from 'node:os';
import { spawn } from 'node:child_process';
import { promisify } from 'node:util';
import { IDENTITY_FIELDS, fromBitwarden } from './identity-fields.js';

const run = promisify(execFile);

export function create(cfg) {
  const bw = cfg.bw_bin || 'bw';
  let session;
  let folderId;
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

  async function sync() {
    if (Date.now() - synced < 60_000) return;
    await bwJson(['sync']).catch(() => {}); // offline is fine: use the local cache
    synced = Date.now();
  }

  async function resolveFolder() {
    if (!cfg.folder) return undefined;
    if (folderId) return folderId;
    const folders = JSON.parse(await bwJson(['list', 'folders']));
    const f = folders.find((x) => x.name === cfg.folder || x.id === cfg.folder);
    if (!f) throw new Error(`bitwarden: folder "${cfg.folder}" not found`);
    folderId = f.id;
    return folderId;
  }

  async function allItems(force) {
    if (force) synced = 0;
    await sync();
    const fid = await resolveFolder();
    const items = JSON.parse(await bwJson(['list', 'items', ...(fid ? ['--folderid', fid] : [])]));
    return items.filter((i) => !i.deletedDate);
  }
  const rawItems = async () => (await allItems()).filter((i) => i.type === 1);
  const rawIdentities = async () => (await allItems()).filter((i) => i.type === 4);

  // `bw create item` reads base64 JSON from stdin, so the new password never
  // appears in a process argument list.
  function bwCreate(obj) {
    return new Promise(async (resolve, reject) => {
      let env;
      try { env = { ...process.env, BW_SESSION: await getSession(), BW_NOINTERACTION: 'true' }; } catch (e) { return reject(e); }
      const p = spawn(bw, ['create', 'item', '--nointeraction'], { env });
      let out = '', err = '';
      p.stdout.on('data', (d) => (out += d));
      p.stderr.on('data', (d) => (err += d));
      p.on('error', reject);
      p.on('close', (code) => {
        if (code !== 0) return reject(new Error(`bitwarden: bw create item failed: ${err.split('\n')[0]}`));
        try { const r = JSON.parse(out); resolve({ id: r.id, name: r.name }); } catch { reject(new Error('bitwarden: unexpected output from bw create item')); }
      });
      p.stdin.end(Buffer.from(JSON.stringify(obj)).toString('base64'));
    });
  }

  return {
    type: 'bitwarden',
    scope: cfg.folder ? `folder "${cfg.folder}"` : 'whole vault',
    async list() {
      // Map immediately so secret fields never leave this function.
      return (await rawItems()).map((i) => ({
        id: i.id,
        name: i.name,
        uris: (i.login?.uris || []).map((u) => u.uri).filter(Boolean),
        hasUsername: Boolean(i.login?.username),
        hasPassword: Boolean(i.login?.password),
        hasTotp: Boolean(i.login?.totp),
      }));
    },
    async find(ref) {
      const all = await this.list();
      return all.find((i) => i.id === ref) || all.find((i) => i.name === ref);
    },
    async listIdentities() {
      return (await rawIdentities()).map((i) => {
        const vals = fromBitwarden(i.identity);
        return { id: i.id, name: i.name, has: IDENTITY_FIELDS.filter((f) => vals[f]) };
      });
    },
    async findIdentity(ref) {
      const all = await this.listIdentities();
      return all.find((i) => i.id === ref) || all.find((i) => i.name === ref);
    },
    async identity(id) {
      const item = (await rawIdentities()).find((i) => i.id === id);
      if (!item) throw new Error('bitwarden: identity not found in the configured scope');
      return fromBitwarden(item.identity);
    },
    async createLogin({ name, username, password, uris, notes }) {
      const folderId = (await resolveFolder()) ?? null;
      const created = await bwCreate({
        type: 1, name, notes, folderId, favorite: false, reprompt: 0,
        login: { username, password, totp: null, uris: uris.map((uri) => ({ uri, match: null })) },
      });
      synced = 0; // make the new item visible to the next list()
      return created;
    },
    async secrets(id, kinds) {
      const item = (await rawItems()).find((i) => i.id === id); // re-checks the folder scope
      if (!item) throw new Error('bitwarden: item not found in the configured scope');
      const out = {};
      if (kinds.includes('username')) out.username = item.login?.username ?? undefined;
      if (kinds.includes('password')) out.password = item.login?.password ?? undefined;
      if (kinds.includes('totp')) out.totp = item.login?.totp ? (await bwJson(['get', 'totp', id])).trim() : undefined;
      return out;
    },
  };
}
