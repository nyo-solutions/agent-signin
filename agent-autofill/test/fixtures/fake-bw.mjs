#!/usr/bin/env node
// Minimal stand-in for the Bitwarden CLI, serving test/fixtures/vault.json.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
const file = process.env.FAKE_BW_VAULT || path.join(path.dirname(fileURLToPath(import.meta.url)), 'vault.json');
const data = JSON.parse(fs.readFileSync(file, 'utf8'));
const stdinJson = () => JSON.parse(Buffer.from(fs.readFileSync(0, 'utf8').trim(), 'base64').toString('utf8'));
const persist = () => { if (!process.env.FAKE_BW_VAULT) { process.stderr.write('fake bw: read-only fixture\n'); process.exit(1); } fs.writeFileSync(file, JSON.stringify(data, null, 2)); };
const args = process.argv.slice(2).filter((a) => a !== '--nointeraction');
const flag = (n) => { const i = args.indexOf(n); return i >= 0 ? args[i + 1] : undefined; };
const out = (v) => process.stdout.write(typeof v === 'string' ? v : JSON.stringify(v));
if (!process.env.BW_SESSION) { process.stderr.write('Vault is locked.\n'); process.exit(1); }
const [cmd, what] = args;
if (cmd === 'sync') out('Syncing complete.');
else if (cmd === 'list' && ['folders', 'collections', 'organizations'].includes(what)) out(data[what]);
else if (cmd === 'list' && what === 'items') {
  let items = data.items;
  if (flag('--folderid')) items = items.filter((i) => i.folderId === flag('--folderid'));
  if (flag('--collectionid')) items = items.filter((i) => (i.collectionIds || []).includes(flag('--collectionid')));
  if (flag('--organizationid')) items = items.filter((i) => i.organizationId === flag('--organizationid'));
  out(items);
} else if (cmd === 'get' && what === 'totp') out('123456');
else if (cmd === 'create' && what === 'item') {
  const item = { ...stdinJson(), id: `new-${data.items.length + 1}` };
  data.items.push(item); persist(); out(item);
} else if (cmd === 'edit' && what === 'item') {
  const id = args[2]; const i = data.items.findIndex((x) => x.id === id);
  if (i < 0) { process.stderr.write('Not found.\n'); process.exit(1); }
  data.items[i] = { ...stdinJson(), id }; persist(); out(data.items[i]);
}
else { process.stderr.write(`fake bw: unsupported ${args.join(' ')}\n`); process.exit(1); }
