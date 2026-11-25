// The server library (lib/server.js): fills through a CDP endpoint and through a
// page-level CDP session (what Playwright's newCDPSession returns), enforces the
// caller's allowed origins before reading the vault, audits, never returns values.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { createAutofill, unlockBitwarden } from '../lib/server.js';

const PW = path.join(os.homedir(), 'Library/Caches/ms-playwright');
const chromium = fs.existsSync(PW) && fs.readdirSync(PW).filter((d) => /^chromium-\d+$/.test(d)).sort()
  .map((d) => path.join(PW, d, 'chrome-mac/Chromium.app/Contents/MacOS/Chromium')).find(fs.existsSync);
const USER = 'lib-user@example.com';
const PASS = 'Lib-S3cret-pass!';
const LOGIN = `<!doctype html><meta charset=utf-8><title>t</title><form method=post action=/submit>
  <input id=user name=user type=text autocomplete=username>
  <input id=pass name=pass type=password autocomplete=current-password>
  <button type=submit>Sign in</button></form>`;

function startSite() {
  const srv = http.createServer((req, res) => { res.setHeader('content-type', 'text/html'); res.end(LOGIN); });
  return new Promise((r) => srv.listen(0, '127.0.0.1', () => r({ srv, url: `http://127.0.0.1:${srv.address().port}` })));
}

async function launch(dir) {
  const proc = spawn(chromium, [`--user-data-dir=${dir}`, '--headless=new', '--remote-debugging-port=0', '--no-first-run', 'about:blank'], { stdio: 'ignore' });
  const f = path.join(dir, 'DevToolsActivePort');
  for (let i = 0; i < 100 && !fs.existsSync(f); i++) await new Promise((r) => setTimeout(r, 100));
  return { proc, endpoint: `http://127.0.0.1:${fs.readFileSync(f, 'utf8').split('\n')[0]}` };
}

// A page-level CDP session with Playwright's shape: send(method, params) -> Promise.
async function pageSession(endpoint, urlPart) {
  const list = await (await fetch(`${endpoint}/json/list`)).json();
  const t = list.find((x) => x.type === 'page' && x.url.includes(urlPart));
  const ws = new WebSocket(t.webSocketDebuggerUrl);
  await new Promise((r) => (ws.onopen = r));
  let seq = 0;
  const pending = new Map();
  ws.onmessage = (e) => {
    const m = JSON.parse(e.data);
    const p = m.id && pending.get(m.id);
    if (p) { pending.delete(m.id); m.error ? p.rej(new Error(m.error.message)) : p.res(m.result); }
  };
  return {
    send(method, params = {}) { const id = ++seq; ws.send(JSON.stringify({ id, method, params })); return new Promise((res, rej) => pending.set(id, { res, rej })); },
    eval: async function (expression) { return (await this.send('Runtime.evaluate', { expression, returnByValue: true })).result.value; },
    close: () => ws.close(),
  };
}

async function openPage(endpoint, url) {
  await fetch(`${endpoint}/json/new?${encodeURI(url)}`, { method: 'PUT' });
  for (let i = 0; i < 50; i++) {
    const s = await pageSession(endpoint, url).catch(() => null);
    const ready = s && (await s.eval('document.readyState').catch(() => '')) === 'complete';
    s?.close();
    if (ready) return;
    await new Promise((r) => setTimeout(r, 100));
  }
}

const noSecrets = (x) => { const s = JSON.stringify(x); assert.ok(!s.includes(PASS) && !s.includes(USER), `secret leaked: ${s}`); };

test('origins: refuses missing or any-site patterns', async () => {
  const af = createAutofill({ vault: { type: 'env', prefix: 'LIBTEST_NONE_' }, audit: () => {} });
  for (const origins of [undefined, [], ['*'], ['https://*'], ['*://*']]) {
    await assert.rejects(af.fillLogin({ login: 'x', origins, cdp: { endpoint: 'http://127.0.0.1:1' } }), /origins/);
  }
});

test('unlockBitwarden: API key login, secrets only in the environment', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'aa-bw-'));
  const log = path.join(dir, 'calls.log');
  const fake = path.join(dir, 'bw');
  // Logs each call's args and whether the secrets were in its environment.
  fs.writeFileSync(fake, `#!/bin/sh
echo "$* | id=\${BW_CLIENTID:+set} secret=\${BW_CLIENTSECRET:+set} pw=\${AGENT_AUTOFILL_BW_PASSWORD:+set} dir=$BITWARDENCLI_APPDATA_DIR" >> "${log}"
case "$1" in
  status) echo '{"status":"unauthenticated","serverUrl":null}';;
  unlock) echo 'SESSION-KEY-123';;
esac
`, { mode: 0o755 });
  const session = await unlockBitwarden({ client_id: 'user.abc', client_secret: 'cs-secret-zz', password: 'mp-secret-yy', server: 'https://vault.example.test', bw_bin: fake, appdata_dir: dir });
  assert.equal(session, 'SESSION-KEY-123');
  const calls = fs.readFileSync(log, 'utf8');
  assert.ok(!calls.includes('cs-secret-zz') && !calls.includes('mp-secret-yy'), 'secret in argv');
  const cmds = calls.trim().split('\n').map((l) => l.split(' --nointeraction')[0].split(' | ')[0]);
  assert.deepEqual(cmds, ['status', 'config server https://vault.example.test', 'login --apikey', 'unlock --passwordenv AGENT_AUTOFILL_BW_PASSWORD --raw', 'sync']);
  assert.match(calls, /login --apikey --nointeraction \| id=set secret=set pw=set dir=/);
  assert.ok(calls.split('\n').every((l) => !l || l.includes(`dir=${dir}`)));
});

test('fillLogin in a real headless Chromium', { skip: !chromium && 'Playwright Chromium not installed' }, async (t) => {
  process.env.LIBTEST_APP_USERNAME = USER;
  process.env.LIBTEST_APP_PASSWORD = PASS;
  const site = await startSite();
  const b = await launch(fs.mkdtempSync(path.join(os.tmpdir(), 'aa-lib-')));
  t.after(() => { b.proc.kill(); site.srv.close(); });
  const events = [];
  const af = createAutofill({ vault: { type: 'env', prefix: 'LIBTEST_' }, audit: (e) => events.push(e) });
  await openPage(b.endpoint, `${site.url}/login`);

  await t.test('lists logins without values', async () => {
    const list = await af.listLogins();
    assert.deepEqual(list.map((l) => [l.name, l.has]), [['app', ['username', 'password']]]);
    noSecrets(list);
  });

  await t.test('through a page CDP session (Playwright shape)', async () => {
    const s = await pageSession(b.endpoint, '/login');
    try {
      const r = await af.fillLogin({ login: 'app', origins: [site.url], session: s, context: { run_id: 'r1' } });
      assert.deepEqual(r, { ok: true, login: 'app', origin: site.url, filled: ['username', 'password'], submitted: false });
      assert.equal(await s.eval('document.getElementById("user").value'), USER);
      assert.equal(await s.eval('document.getElementById("pass").value'), PASS);
      noSecrets(r);
      await s.eval('document.getElementById("user").value = ""; document.getElementById("pass").value = ""');
    } finally { s.close(); }
    assert.equal(events.at(-1).result, 'filled');
    assert.equal(events.at(-1).run_id, 'r1');
    assert.equal(events.at(-1).channel, 'cdp-session');
  });

  await t.test('through a CDP endpoint', async () => {
    const r = await af.fillLogin({ login: 'app', origins: ['http://127.0.0.1:*'], cdp: { endpoint: b.endpoint, url_contains: '/login' }, fields: { password: '#pass' } });
    assert.deepEqual(r.filled, ['password']);
    noSecrets(r);
  });

  await t.test('another site: refused before the vault is read, and audited', async () => {
    let read = false;
    const spy = createAutofill({
      vault: { find: async () => ({ id: '1', name: 'app' }), list: async () => [], secrets: async () => { read = true; return { username: USER, password: PASS }; } },
      audit: (e) => events.push(e),
    });
    const s = await pageSession(b.endpoint, '/login');
    try {
      await assert.rejects(spy.fillLogin({ login: 'app', origins: ['https://staging.example.com'], session: s }), /may not be filled on/);
    } finally { s.close(); }
    assert.equal(read, false);
    assert.equal(events.at(-1).result, 'not-allowed');
  });

  await t.test('CDP endpoint must be on an allowed host', async () => {
    const remote = createAutofill({ vault: { type: 'env', prefix: 'LIBTEST_' }, audit: () => {}, cdpAllowedHosts: ['browser.internal'] });
    await assert.rejects(remote.fillLogin({ login: 'app', origins: [site.url], cdp: { endpoint: b.endpoint } }), /allowed_hosts/);
  });

  noSecrets(events);
});
