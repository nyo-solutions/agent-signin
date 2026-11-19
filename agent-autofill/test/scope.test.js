// The vault scope rules, unit-level and through the real Bitwarden adapter
// against a fake `bw` (test/fixtures/fake-bw.mjs serving fixtures/vault.json).
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { normalizeScope } from '../src/vaults/bitwarden-scope.js';
import { create } from '../src/vaults/bitwarden.js';

const FAKE_BW = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures', 'fake-bw.mjs');
const VAULT = fs.readFileSync(path.join(path.dirname(FAKE_BW), 'vault.json'), 'utf8');
process.env.BW_SESSION = 'test-session';
const vault = (cfg) => create({ type: 'bitwarden', bw_bin: FAKE_BW, ...cfg });

test('a scope is required and only logins/identities can be enabled', () => {
  assert.throws(() => normalizeScope({}), /set folders, collections or organizations/);
  assert.throws(() => normalizeScope({ scope: 'everything' }), /scope must be "all"/);
  assert.throws(() => normalizeScope({ scope: 'all', folders: ['ai'] }), /not both/);
  for (const t of ['card', 'note', 'secure_note', 'ssh_key']) assert.throws(() => normalizeScope({ folder: 'ai', item_types: [t] }), /can never be enabled/);
  assert.throws(() => normalizeScope({ folder: 'ai', item_types: ['passkey'] }), /unknown item_types/);
  assert.deepEqual(normalizeScope({ folder: 'ai' }).types, ['login', 'identity']);
});

test('folder scope: cards, notes, deleted, other folders and excluded items never appear', async () => {
  const v = vault({ folders: ['ai'], exclude_items: ['bank.example'], exclude_fields: ['Recovery codes', 'phone'] });
  const logins = await v.list();
  assert.deepEqual(logins.map((i) => i.name), ['github.com']);
  assert.deepEqual(logins[0].custom, [{ name: 'API Key', type: 'hidden' }], 'excluded custom field hidden from the listing');
  assert.equal(await v.find('bank.example'), undefined);
  assert.equal(await v.find('Visa card'), undefined);
  await assert.rejects(v.secrets('i2', ['password']), /not found in the configured scope/, 'card id cannot be read directly');
  await assert.rejects(v.secrets('i4', ['password']), /not found in the configured scope/, 'excluded item cannot be read by id');
  await assert.rejects(v.secrets('i5', ['password']), /not found in the configured scope/, 'other folder cannot be read by id');
  const s = await v.secrets('i1', ['password'], ['API Key', 'Recovery codes']);
  assert.equal(s.password, 'pw-ai-github');
  assert.deepEqual(s.custom, { 'API Key': 'key-ai-github' }, 'excluded custom field is never read');
  const ids = await v.listIdentities();
  assert.deepEqual(ids, [{ id: 'i9', name: 'Test persona', has: ['first_name', 'last_name', 'full_name', 'email'] }]);
  const ident = await v.identity('i9');
  assert.equal(ident.phone, undefined, 'excluded identity field');
  assert.ok(!JSON.stringify(ident).includes('000-00-0000'), 'SSN is never read');
  assert.equal(v.scope, 'folder "ai", minus 1 excluded item(s)');
});

test('several folders, a collection, an organization, and item_types', async () => {
  const two = vault({ folders: ['ai', 'ai-extra'] });
  assert.deepEqual((await two.list()).map((i) => i.name).sort(), ['bank.example', 'github.com', 'staging']);
  const coll = vault({ collections: ['Agents'] });
  assert.deepEqual((await coll.list()).map((i) => i.name), ['shared deploy'], 'only the Agents collection, not Finance');
  const org = vault({ organizations: ['NYO'] });
  assert.deepEqual((await org.list()).map((i) => i.name).sort(), ['payroll', 'shared deploy']);
  const loginsOnly = vault({ folder: 'ai', item_types: ['login'] });
  assert.deepEqual(await loginsOnly.listIdentities(), []);
  await assert.rejects(vault({ folders: ['nope'] }).list(), /folder "nope" not found/);
});

test('scope: all still never exposes cards or notes', async () => {
  const v = vault({ scope: 'all' });
  const names = (await v.list()).map((i) => i.name);
  assert.ok(!names.includes('Visa card') && !names.includes('Private note') && !names.includes('deleted'));
  assert.equal(names.length, 6);
});

test('fixture sanity: the fake vault really contains the things we hide', () => {
  for (const s of ['4111111111111111', 'note-should-never-leak', 'rc-should-never-leak']) assert.ok(VAULT.includes(s));
});
