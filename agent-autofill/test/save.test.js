// save_from_page storage rules: the pure merge (applyField) and the real
// Bitwarden adapter against a fake `bw` with a writable copy of the fixture vault.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { FieldExistsError, applyField, newItem } from '../src/vaults/save-field.js';
import { create } from '../src/vaults/bitwarden.js';

const DIR = path.dirname(fileURLToPath(import.meta.url));
const FAKE_BW = path.join(DIR, 'fixtures', 'fake-bw.mjs');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'aaf-save-'));
process.env.FAKE_BW_VAULT = path.join(tmp, 'vault.json');
fs.copyFileSync(path.join(DIR, 'fixtures', 'vault.json'), process.env.FAKE_BW_VAULT);
process.env.BW_SESSION = 'test-session';
const vaultFile = () => JSON.parse(fs.readFileSync(process.env.FAKE_BW_VAULT, 'utf8'));

test('applyField: add, unchanged, refuse, replace with history', () => {
  const it = newItem({ item_type: 'login', name: 'x', uris: ['https://x.test'] });
  assert.equal(applyField(it, { field_name: 'API Key', value: 'k1' }), 'added');
  assert.deepEqual(it.fields, [{ name: 'API Key', value: 'k1', type: 1, linkedId: null }], 'new custom fields are hidden by default');
  assert.equal(applyField(it, { field_name: 'api key', value: 'k1' }), 'unchanged', 'same value, name matched case-insensitively');
  assert.throws(() => applyField(it, { field_name: 'API Key', value: 'k2' }), FieldExistsError);
  assert.equal(applyField(it, { field_name: 'API Key', value: 'k2', overwrite: true }), 'replaced');
  assert.equal(it.fields[0].value, 'k2');
  assert.match(it.notes, /\[agent-autofill\] previous custom field "API Key", replaced .*: k1$/, 'replaced hidden value kept in notes');
  assert.equal(applyField(it, { field_name: 'Account', field_type: 'text', value: 'a1' }), 'added');
  assert.equal(applyField(it, { field_name: 'Account', value: 'a2', overwrite: true }), 'replaced');
  assert.equal(it.notes.split('\n').length, 1, 'text fields are not kept');
  assert.equal(applyField(it, { field_kind: 'password', value: 'p1' }), 'added');
  assert.throws(() => applyField(it, { field_kind: 'password', value: 'p2' }), /overwrite_allowed/);
  assert.equal(applyField(it, { field_kind: 'password', value: 'p2', overwrite: true }), 'replaced');
  assert.match(it.notes.split('\n').at(-1), /previous password, replaced .*: p1$/);
  const ident = newItem({ item_type: 'identity', name: 'p' });
  assert.throws(() => applyField(ident, { field_kind: 'password', value: 'x' }), /login item/);
  assert.equal(applyField(ident, { field_name: 'Member id', value: 'm1' }), 'added');
  it.notes = 'my own note\n' + it.notes;
  for (let i = 0; i < 8; i++) applyField(it, { field_name: 'API Key', value: `r${i}`, overwrite: true });
  const lines = it.notes.split('\n');
  assert.equal(lines[0], 'my own note', "the user's own notes are kept");
  assert.equal(lines.length, 6, 'history capped at 5 entries');
});

test('bitwarden saveField: create in scope, add, refuse, overwrite, exclusions', async () => {
  const v = create({ type: 'bitwarden', bw_bin: FAKE_BW, folders: ['ai'], exclude_fields: ['Recovery codes'] });
  const c = await v.saveField({ create: true, item_type: 'login', item_name: 'newsite', uris: ['https://new.test'], field_kind: 'custom', field_name: 'API Key', value: 'secret-1' });
  assert.equal(c.created, true);
  const stored = vaultFile().items.find((i) => i.name === 'newsite');
  assert.equal(stored.folderId, 'f-ai', 'created inside the scope folder');
  assert.deepEqual(stored.login.uris, [{ uri: 'https://new.test', match: null }]);
  assert.equal(stored.fields[0].value, 'secret-1');
  await assert.rejects(v.saveField({ create: true, item_name: 'newsite', field_kind: 'custom', field_name: 'x', value: 'y' }), /already exists/);
  assert.equal((await v.saveField({ create: false, item: 'github.com', field_kind: 'custom', field_name: 'Client ID', field_type: 'text', value: 'cid' })).outcome, 'added');
  await assert.rejects(v.saveField({ create: false, item: 'github.com', field_kind: 'custom', field_name: 'API Key', value: 'other' }), /overwrite_allowed/);
  assert.equal(vaultFile().items.find((i) => i.id === 'i1').fields.find((f) => f.name === 'API Key').value, 'key-ai-github', 'refused overwrite left the vault untouched');
  assert.equal((await v.saveField({ create: false, item: 'i1', field_kind: 'custom', field_name: 'API Key', value: 'other', overwrite: true })).outcome, 'replaced');
  const gh = vaultFile().items.find((i) => i.id === 'i1');
  assert.equal(gh.fields.find((f) => f.name === 'API Key').value, 'other');
  assert.match(gh.notes, /previous custom field "API Key", replaced .*: key-ai-github/);
  assert.equal(gh.login.password, 'pw-ai-github', 'other data on the item is preserved');
  await assert.rejects(v.saveField({ create: false, item: 'i1', field_kind: 'custom', field_name: 'Recovery codes', value: 'x', overwrite: true }), /excluded/);
  await assert.rejects(v.saveField({ create: false, item: 'personal mail', field_kind: 'password', value: 'x', overwrite: true }), /not found in the configured scope/);
  await assert.rejects(v.saveField({ create: false, item: 'Visa card', field_kind: 'custom', field_name: 'x', value: 'y' }), /not found in the configured scope/);
  assert.equal((await v.saveField({ create: false, item: 'i1', field_kind: 'custom', field_name: 'API Key', value: 'other' })).outcome, 'unchanged');
});
