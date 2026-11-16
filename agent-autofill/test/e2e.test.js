// End-to-end: real MCP server over stdio, env vault with fake credentials,
// Playwright's Chromium, a local login page. Covers the CDP channel and the
// Chrome extension + native host channel.
import assert from 'node:assert/strict';
import { spawn, execFileSync } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { totp } from '../src/totp.js';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PW = path.join(os.homedir(), 'Library/Caches/ms-playwright');
const chromium = fs.readdirSync(PW).filter((d) => /^chromium-\d+$/.test(d)).sort().map((d) => path.join(PW, d, 'chrome-mac/Chromium.app/Contents/MacOS/Chromium')).find(fs.existsSync);
const SECRET_PW = 'S3cret-pass-XYZ!';
const TOTP_SECRET = 'JBSWY3DPEHPK3PXP';

const page = (body) => `<!doctype html><meta charset=utf-8><title>t</title>${body}`;
const LOGIN = page(`<form method=post action=/submit>
  <input id=user name=user type=email autocomplete=username>
  <input id=pass name=pass type=password autocomplete=current-password>
  <button type=submit>Sign in</button></form>`);
const OTP = page(`<form method=post action=/submit><input id=code name=code autocomplete=one-time-code><button>Go</button></form>`);
const TRAP = page(`<form><input id=user type=text><input id=pass type=text name=password></form>`);

function startSite() {
  const posts = [];
  const srv = http.createServer((req, res) => {
    if (req.method === 'POST') {
      let b = '';
      req.on('data', (d) => (b += d));
      req.on('end', () => { posts.push(Object.fromEntries(new URLSearchParams(b))); res.end(page('done')); });
      return;
    }
    res.setHeader('content-type', 'text/html');
    res.end(req.url.startsWith('/otp') ? OTP : req.url.startsWith('/trap') ? TRAP : LOGIN);
  });
  return new Promise((r) => srv.listen(0, '127.0.0.1', () => r({ srv, port: srv.address().port, posts })));
}

async function launch(dir, extra) {
  const proc = spawn(chromium, [`--user-data-dir=${dir}`, '--headless=new', '--remote-debugging-port=0', '--no-first-run', '--no-default-browser-check', ...extra, 'about:blank'], { stdio: 'ignore' });
  const f = path.join(dir, 'DevToolsActivePort');
  for (let i = 0; i < 100 && !fs.existsSync(f); i++) await new Promise((r) => setTimeout(r, 100));
  const port = fs.readFileSync(f, 'utf8').split('\n')[0];
  return { proc, endpoint: `http://127.0.0.1:${port}` };
}

// Tiny CDP helper for the test itself (open pages, read values back).
async function cdpEval(endpoint, urlPart, expr) {
  const list = await (await fetch(`${endpoint}/json/list`)).json();
  const t = list.find((x) => x.type === 'page' && x.url.includes(urlPart));
  const ws = new WebSocket(t.webSocketDebuggerUrl);
  await new Promise((r) => (ws.onopen = r));
  const out = await new Promise((r) => {
    ws.onmessage = (e) => r(JSON.parse(e.data).result.result.value);
    ws.send(JSON.stringify({ id: 1, method: 'Runtime.evaluate', params: { expression: expr, returnByValue: true } }));
  });
  ws.close();
  return out;
}
async function openPage(endpoint, url) {
  await fetch(`${endpoint}/json/new?${encodeURI(url)}`, { method: 'PUT' });
  for (let i = 0; i < 50; i++) {
    if ((await cdpEval(endpoint, url, 'document.readyState').catch(() => '')) === 'complete') return;
    await new Promise((r) => setTimeout(r, 100));
  }
}

async function mcp(home) {
  const client = new Client({ name: 'test', version: '1' });
  await client.connect(new StdioClientTransport({
    command: path.join(REPO, 'bin/agent-autofill-mcp'),
    env: { ...process.env, AGENT_AUTOFILL_HOME: home, AGENT_AUTOFILL_NO_DIALOG: '1', AGENT_AUTOFILL_DEMO_USERNAME: 'alice@example.com', AGENT_AUTOFILL_DEMO_PASSWORD: SECRET_PW, AGENT_AUTOFILL_DEMO_TOTP_SECRET: TOTP_SECRET },
  }));
  const call = async (name, args) => {
    const r = await client.callTool({ name, arguments: args });
    const text = r.content.map((c) => c.text).join('\n');
    assert.ok(!text.includes(SECRET_PW), `${name} result leaked the password`);
    assert.ok(!text.includes('alice@example.com'), `${name} result leaked the username`);
    return { error: r.isError, text, json: r.isError ? null : JSON.parse(text) };
  };
  return { client, call };
}

function writePolicy(home, origins) {
  fs.mkdirSync(home, { recursive: true });
  fs.writeFileSync(path.join(home, 'policy.yaml'), `vaults:\n  ci:\n    type: env\ngrants:\n  - vault: ci\n    item: demo\n    origins: ${JSON.stringify(origins)}\n`);
}

test('e2e', { skip: !chromium && 'Playwright Chromium not installed', timeout: 120_000 }, async (t) => {
  const site = await startSite();
  const base = `http://127.0.0.1:${site.port}`;
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'aaf-'));
  const home = path.join(tmp, 'h');
  writePolicy(home, ['http://127.0.0.1:*']);
  const { client, call } = await mcp(home);

  t.after(async () => { await client.close(); site.srv.close(); });

  await t.test('tools list is exactly the three tools', async () => {
    const { tools } = await client.listTools();
    assert.deepEqual(tools.map((x) => x.name).sort(), ['fill_login', 'list_logins', 'request_authorization']);
  });

  await t.test('list_logins shows approvals, not secrets', async () => {
    const r = await call('list_logins', {});
    assert.equal(r.json.logins[0].login, 'demo');
    assert.deepEqual(r.json.logins[0].approved_origins, ['http://127.0.0.1:*']);
  });

  await t.test('request_authorization without a screen tells the agent to ask the user', async () => {
    const r = await call('request_authorization', { login: 'demo', origins: ['https://example.com'] });
    assert.ok(r.error && /agent-autofill allow/.test(r.text));
  });

  await t.test('CDP channel', async (t2) => {
    const b = await launch(path.join(tmp, 'cdp'), []);
    t2.after(() => b.proc.kill());
    await openPage(b.endpoint, `${base}/login`);

    let r = await call('fill_login', { login: 'demo', target: { type: 'cdp', endpoint: b.endpoint, url_contains: '/login' }, submit: true });
    assert.ok(!r.error, r.text);
    assert.deepEqual(r.json.filled, ['username', 'password']);
    assert.equal(r.json.submitted, true);
    await new Promise((res) => setTimeout(res, 500));
    assert.deepEqual(site.posts.pop(), { user: 'alice@example.com', pass: SECRET_PW }, 'site received the real credentials');

    // Explicit XPath / CSS selectors, no submit
    await openPage(b.endpoint, `${base}/login?2`);
    r = await call('fill_login', { login: 'demo', target: { type: 'cdp', endpoint: b.endpoint, url_contains: '/login?2' }, fields: { username: '//input[@id="user"]', password: 'css=#pass' } });
    assert.ok(!r.error, r.text);
    assert.equal(await cdpEval(b.endpoint, '/login?2', 'document.querySelector("#pass").value'), SECRET_PW);

    // TOTP step
    await openPage(b.endpoint, `${base}/otp`);
    r = await call('fill_login', { login: 'demo', target: { type: 'cdp', endpoint: b.endpoint, url_contains: '/otp' }, fields: { totp: 'auto' } });
    assert.ok(!r.error, r.text);
    const code = await cdpEval(b.endpoint, '/otp', 'document.querySelector("#code").value');
    assert.ok([totp(TOTP_SECRET), totp(TOTP_SECRET, Date.now() - 30_000)].includes(code));

    // Password refused into a visible text field
    await openPage(b.endpoint, `${base}/trap`);
    r = await call('fill_login', { login: 'demo', target: { type: 'cdp', endpoint: b.endpoint, url_contains: '/trap' }, fields: { password: '#pass' } });
    assert.ok(r.error && /type "text"/.test(r.text), r.text);

    // Origin not approved (localhost is a different origin from 127.0.0.1)
    await openPage(b.endpoint, `http://localhost:${site.port}/login`);
    r = await call('fill_login', { login: 'demo', target: { type: 'cdp', endpoint: b.endpoint, url_contains: 'localhost' } });
    assert.ok(r.error && /not approved for http:\/\/localhost/.test(r.text), r.text);
    assert.equal(await cdpEval(b.endpoint, 'localhost', 'document.querySelector("#pass").value'), '');

    // Non-loopback CDP endpoint refused
    r = await call('fill_login', { login: 'demo', target: { type: 'cdp', endpoint: 'http://10.1.2.3:9222' } });
    assert.ok(r.error && /allowed_hosts/.test(r.text));

    // Wildcard "*" approval allows any site
    writePolicy(home, ['*']);
    r = await call('fill_login', { login: 'demo', target: { type: 'cdp', endpoint: b.endpoint, url_contains: 'localhost' } });
    assert.ok(!r.error, r.text);
    writePolicy(home, ['http://127.0.0.1:*']);
  });

  await t.test('Chrome extension channel', async (t2) => {
    const prof = path.join(tmp, 'ext');
    execFileSync(path.join(REPO, 'bin/agent-autofill'), ['install', '--dir', path.join(prof, 'NativeMessagingHosts'), '--quiet'], { env: { ...process.env, AGENT_AUTOFILL_HOME: home } });
    const ext = path.join(REPO, 'extension');
    const b = await launch(prof, [`--disable-extensions-except=${ext}`, `--load-extension=${ext}`]);
    t2.after(() => b.proc.kill());
    const sock = path.join(home, 'run/bridge.sock');
    for (let i = 0; i < 100 && !fs.existsSync(sock); i++) await new Promise((r) => setTimeout(r, 100));
    assert.ok(fs.existsSync(sock), 'extension connected to the native host');
    await openPage(b.endpoint, `${base}/login?ext`);

    let r = await call('fill_login', { login: 'demo', target: { type: 'chrome', url_contains: '/login?ext' }, submit: true });
    assert.ok(!r.error, r.text);
    assert.equal(typeof r.json.tab_id, 'number');
    await new Promise((res) => setTimeout(res, 500));
    assert.deepEqual(site.posts.pop(), { user: 'alice@example.com', pass: SECRET_PW });

    // By tab id, wrong origin refused
    await openPage(b.endpoint, `http://localhost:${site.port}/login?ext2`);
    r = await call('fill_login', { login: 'demo', target: { type: 'chrome', url_contains: 'ext2' } });
    assert.ok(r.error && /not approved/.test(r.text), r.text);
  });
});
