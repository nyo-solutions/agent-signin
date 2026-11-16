// Bitwarden / Vaultwarden through the official `bw` CLI. The session key comes
// from BW_SESSION or the macOS Keychain (agent-vault stores it there).
import { execFile } from 'node:child_process';
import os from 'node:os';
import { promisify } from 'node:util';

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

  async function rawItems() {
    await sync();
    const fid = await resolveFolder();
    const items = JSON.parse(await bwJson(['list', 'items', ...(fid ? ['--folderid', fid] : [])]));
    return items.filter((i) => i.type === 1 && !i.deletedDate);
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
