// The server notices an extension that Chrome still runs from older files:
// it reloads it when the extension supports that, and otherwise says how to.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { chromeFill, chromeTarget, older } from '../src/channels/extension.js';

const BUNDLED = JSON.parse(fs.readFileSync(new URL('../extension/manifest.json', import.meta.url), 'utf8')).version;

// A fake native-host socket for one profile.
function fakeProfile(runDir, profile, state) {
  const file = path.join(runDir, `bridge-${profile}.sock`);
  const srv = net.createServer((sock) => {
    let buf = '';
    sock.on('data', (d) => {
      buf += d;
      const nl = buf.indexOf('\n');
      if (nl < 0) return;
      const msg = JSON.parse(buf.slice(0, nl));
      state.ops.push(msg.op);
      const reply = (result) => sock.end(JSON.stringify({ id: msg.id, ok: true, result }) + '\n');
      if (msg.op === 'ping') return reply({ version: state.version, ...(state.canReload && { can_reload: true }) });
      if (msg.op === 'reload') { setTimeout(() => (state.version = BUNDLED), 300); return reply({ reloading: true }); }
      if (msg.op === 'resolve_tab') return reply({ tab_id: 7, url: 'https://shop.example/checkout', focused: true });
      sock.end(JSON.stringify({ id: msg.id, ok: false, error: `unknown op ${msg.op}` }) + '\n');
    });
  });
  return new Promise((r) => srv.listen(file, () => r(srv)));
}

test('older() compares versions', () => {
  assert.equal(older('0.5.9', '0.6.0'), true);
  assert.equal(older('0.6.0', '0.6.0'), false);
  assert.equal(older('0.10.0', '0.9.1'), false);
  assert.equal(older(undefined, '0.6.0'), true);
});

test('an old extension without reload: clear message instead of "unknown op frames"', async (t) => {
  const runDir = fs.mkdtempSync(path.join(os.tmpdir(), 'aa-ver-'));
  const state = { version: '0.5.0', ops: [] };
  const srv = await fakeProfile(runDir, 'p1', state);
  t.after(() => srv.close());
  const tab = await chromeTarget({ type: 'chrome', tab_id: 7 }, { runDir });
  assert.equal(tab.version, '0.5.0');
  assert.ok(!state.ops.includes('reload'));
  const req = { expectedOrigin: 'https://shop.example', mode: 'details', frameOrigins: { card: ['https://pay.example'] }, fields: [{ kind: 'card_number', group: 'card', selector: 'auto' }] };
  await assert.rejects(chromeFill(tab, req), /version 0\.5\.0\); filling inside payment iframes needs 0\.6\.0.*chrome:\/\/extensions/);
  assert.ok(!state.ops.includes('frames'));
});

test('an extension that can reload is reloaded to the files on disk', async (t) => {
  const runDir = fs.mkdtempSync(path.join(os.tmpdir(), 'aa-ver-'));
  const state = { version: '0.6.0', canReload: true, ops: [] };
  const srv = await fakeProfile(runDir, 'p2', state);
  t.after(() => srv.close());
  const tab = await chromeTarget({ type: 'chrome', tab_id: 7 }, { runDir });
  assert.ok(state.ops.includes('reload'));
  assert.equal(tab.version, BUNDLED);
});

test('same version number but older code: "unknown op" becomes a reload instruction', async (t) => {
  const runDir = fs.mkdtempSync(path.join(os.tmpdir(), 'aa-ver-'));
  const state = { version: '0.6.0', ops: [] };
  const srv = await fakeProfile(runDir, 'p3', state);
  t.after(() => srv.close());
  const tab = await chromeTarget({ type: 'chrome', tab_id: 7 }, { runDir });
  const req = { expectedOrigin: 'https://shop.example', mode: 'details', frameOrigins: { card: ['https://pay.example'] }, fields: [{ kind: 'card_number', group: 'card', selector: 'auto' }] };
  await assert.rejects(chromeFill(tab, req), /runs older code.*"frames" step.*chrome:\/\/extensions/);
});
