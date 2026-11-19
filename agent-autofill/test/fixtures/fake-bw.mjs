#!/usr/bin/env node
// Minimal stand-in for the Bitwarden CLI, serving test/fixtures/vault.json.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
const data = JSON.parse(fs.readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), 'vault.json'), 'utf8'));
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
else { process.stderr.write(`fake bw: unsupported ${args.join(' ')}\n`); process.exit(1); }
