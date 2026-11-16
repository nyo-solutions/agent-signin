// agent-autofill CLI for the user (and CI). Not exposed to agents as a tool.
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { extensionRequest } from './channels/extension.js';
import { addGrant, isWildcard, loadPolicy, normalizeOrigin, parsePattern, pruneExpired, savePolicy, vaultName } from './policy.js';
import { HOME, NATIVE_HOST_NAME, POLICY_PATH, SOCKET_PATH } from './paths.js';
import { openVault } from './vaults/index.js';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const EXT_DIR = path.join(REPO, 'extension');
const BROWSER_DIRS = {
  chrome: 'Google/Chrome',
  'chrome-beta': 'Google/Chrome Beta',
  chromium: 'Chromium',
  brave: 'BraveSoftware/Brave-Browser',
  edge: 'Microsoft Edge',
};

export function extensionId() {
  const { key } = JSON.parse(fs.readFileSync(path.join(EXT_DIR, 'manifest.json'), 'utf8'));
  const hash = crypto.createHash('sha256').update(Buffer.from(key, 'base64')).digest('hex').slice(0, 32);
  return [...hash].map((c) => String.fromCharCode(97 + parseInt(c, 16))).join('');
}

function flags(args) {
  const out = { _: [] };
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a.startsWith('--')) {
      const [k, v] = a.slice(2).split('=');
      out[k] = v ?? (args[i + 1] && !args[i + 1].startsWith('--') ? args[++i] : true);
    } else out._.push(a);
  }
  return out;
}

function install(f) {
  fs.mkdirSync(HOME, { recursive: true, mode: 0o700 });
  const wrapper = path.join(HOME, 'native-host.sh');
  fs.writeFileSync(wrapper, `#!/bin/sh\n# Started by the browser for the Agent Autofill extension.\nexport AGENT_AUTOFILL_HOME='${HOME}'\nexec '${process.execPath}' '${path.join(REPO, 'src', 'host.js')}' "$@"\n`, { mode: 0o700 });
  const id = extensionId();
  const manifest = { name: NATIVE_HOST_NAME, description: 'Agent Autofill bridge', path: wrapper, type: 'stdio', allowed_origins: [`chrome-extension://${id}/`] };
  const dirs = f.dir
    ? [f.dir]
    : String(f.browsers || 'chrome').split(',').map((b) => {
      if (!BROWSER_DIRS[b]) throw new Error(`unknown browser ${b} (known: ${Object.keys(BROWSER_DIRS).join(', ')})`);
      return path.join(os.homedir(), 'Library', 'Application Support', BROWSER_DIRS[b], 'NativeMessagingHosts');
    });
  for (const d of dirs) {
    fs.mkdirSync(d, { recursive: true });
    fs.writeFileSync(path.join(d, `${NATIVE_HOST_NAME}.json`), JSON.stringify(manifest, null, 2));
    console.log(`native host registered: ${path.join(d, `${NATIVE_HOST_NAME}.json`)}`);
  }
  if (!f.quiet) {
    console.log(`\nNow load the extension once:\n  1. open chrome://extensions and turn on Developer mode\n  2. Load unpacked -> ${EXT_DIR}\n  3. check the extension ID is ${id}\nThen run: agent-autofill doctor`);
  }
}

async function doctor() {
  let bad = 0;
  const line = (good, msg) => { console.log(`${good ? 'ok  ' : 'FAIL'}  ${msg}`); if (!good) bad++; };
  line(fs.existsSync(POLICY_PATH), `policy file ${POLICY_PATH}`);
  let policy;
  try { policy = loadPolicy(); line(true, `policy parses: ${Object.keys(policy.vaults).length} vault(s), ${policy.grants.length} grant(s)`); } catch (e) { line(false, `policy: ${e.message}`); }
  for (const [name, cfg] of Object.entries(policy?.vaults || {})) {
    try { const v = openVault(name, cfg); const items = await v.list(); line(true, `vault ${name} (${v.scope}): ${items.length} login(s)`); } catch (e) { line(false, `vault ${name}: ${e.message}`); }
  }
  const chromeManifest = path.join(os.homedir(), 'Library', 'Application Support', BROWSER_DIRS.chrome, 'NativeMessagingHosts', `${NATIVE_HOST_NAME}.json`);
  line(fs.existsSync(chromeManifest), `Chrome native host manifest ${chromeManifest}`);
  try { const r = await extensionRequest({ op: 'ping' }, { timeoutMs: 3000 }); line(true, `Chrome extension connected (v${r.version}, id ${extensionId()})`); } catch (e) { line(false, e.message); }
  process.exitCode = bad ? 1 : 0;
}

async function allow(f) {
  const [login, ...origins] = f._;
  if (!login || !origins.length) throw new Error('usage: agent-autofill allow <login|*> <origin...> [--vault name] [--no-submit] [--hours n]');
  const policy = loadPolicy();
  const vName = vaultName(policy, f.vault);
  const v = openVault(vName, policy.vaults[vName]);
  const item = login === '*' ? null : await v.find(login);
  if (login !== '*' && !item) throw new Error(`login "${login}" not found in vault ${vName} (${v.scope})`);
  const pats = origins.map((o) => (isWildcard(o) ? o : normalizeOrigin(o)));
  pats.forEach(parsePattern);
  pruneExpired(policy);
  addGrant(policy, {
    vault: vName,
    item: item ? item.id : '*',
    item_name: item ? item.name : `ALL (${v.scope})`,
    origins: pats,
    allow_submit: !f['no-submit'],
    ...(f.hours && { expires_at: new Date(Date.now() + Number(f.hours) * 3600_000).toISOString() }),
    approved_at: new Date().toISOString(),
    approved_via: 'cli',
  });
  savePolicy(policy);
  console.log(`approved ${item ? item.name : 'ALL logins'} for ${pats.join(', ')}${pats.includes('*') ? '  (WARNING: any site)' : ''}`);
}

function revoke(f) {
  const [login, origin] = f._;
  if (!login) throw new Error('usage: agent-autofill revoke <login|id|*> [origin-pattern]');
  const policy = loadPolicy();
  const before = JSON.stringify(policy.grants);
  policy.grants = policy.grants
    .map((g) => {
      if (g.item !== login && g.item_name !== login) return g;
      if (!origin) return null;
      return { ...g, origins: g.origins.filter((o) => o !== origin && o !== (isWildcard(origin) ? origin : normalizeOrigin(origin))) };
    })
    .filter((g) => g && g.origins.length);
  if (JSON.stringify(policy.grants) === before) return console.log('nothing matched');
  savePolicy(policy);
  console.log('revoked');
}

function list() {
  const policy = loadPolicy();
  if (!policy.grants.length) return console.log(`no approvals yet (${POLICY_PATH})`);
  for (const g of policy.grants) {
    console.log(`${g.vault}  ${g.item_name || g.item}  ->  ${g.origins.join(', ')}${g.allow_submit ? '' : '  [no submit]'}${g.expires_at ? `  [until ${g.expires_at}]` : ''}`);
  }
}

const [cmd, ...rest] = process.argv.slice(2);
const f = flags(rest);
const cmds = { install, doctor, allow, revoke, list, 'extension-id': () => console.log(extensionId()), paths: () => console.log({ HOME, POLICY_PATH, SOCKET_PATH, EXT_DIR }) };
if (!cmds[cmd]) {
  console.log('usage: agent-autofill <install [--browsers chrome,chromium,brave,edge] | doctor | list | allow <login|*> <origin...> | revoke <login> [origin] | extension-id | paths>');
  process.exitCode = cmd ? 1 : 0;
} else {
  try { await cmds[cmd](f); } catch (e) { console.error(`error: ${e.message}`); process.exitCode = 1; }
}
