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
const API_KEY = 'fake-api-key-for-tests';
const PEM = '-----BEGIN TEST-----\nZmFrZQ==\n-----END TEST-----';
const TOTP_SECRET = 'JBSWY3DPEHPK3PXP';

const page = (body) => `<!doctype html><meta charset=utf-8><title>t</title>${body}`;
const LOGIN = page(`<form method=post action=/submit>
  <input id=user name=user type=text autocomplete=username>
  <input id=pass name=pass type=password autocomplete=current-password>
  <button type=submit>Sign in</button></form>`);
const OTP = page(`<form method=post action=/submit><input id=code name=code autocomplete=one-time-code><button>Go</button></form>`);
const SIGNUP = page(`<form method=post action=/submit>
  <input id=fn name=first_name autocomplete=given-name>
  <label for=ln>Surname</label><input id=ln name=ln>
  <input type=email name=email placeholder="Email address">
  <input name=username placeholder="Choose a username">
  <select name=country><option value="">--</option><option value="IL">Israel</option><option value="US">United States</option></select>
  <input type=password name=password autocomplete=new-password>
  <input type=password name=password_confirm placeholder="Confirm password">
  <label><input type=checkbox name=terms> I agree</label>
  <button>Create account</button></form>`);
const IDENTITY = { first_name: 'Testa', last_name: 'Personovich', email: 'tester@example.com', username: 'tester1', country: 'Israel', phone: '+972500000000' };
const FORBIDDEN = [API_KEY, 'ZmFrZQ==', SECRET_PW, 'alice@example.com', IDENTITY.email, IDENTITY.last_name, IDENTITY.phone];
const APIKEYS = page(`<form method=post action=/submit>
  <label for=acct>Account ID</label><input id=acct name=account>
  <label for=key>API key</label><input id=key name=api_key type=password>
  <label for=key2>Key (plain box)</label><input id=key2 name=plain type=text>
  <label for=pem>Client certificate</label><textarea id=pem name=pem></textarea>
  <label><input type=checkbox id=sandbox name=sandbox> Sandbox</label></form>`);
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
    res.end(req.url.startsWith('/otp') ? OTP : req.url.startsWith('/trap') ? TRAP : req.url.startsWith('/signup') ? SIGNUP : req.url.startsWith('/apikeys') ? APIKEYS : req.url.startsWith('/emailonly') ? LOGIN.replace('type=text', 'type=email') : LOGIN);
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

const generated = []; // passwords the site received from signups; must never appear in tool output
async function mcp(home) {
  const client = new Client({ name: 'test', version: '1' });
  await client.connect(new StdioClientTransport({
    command: path.join(REPO, 'bin/agent-autofill-mcp'),
    env: { ...process.env, AGENT_AUTOFILL_HOME: home, AGENT_AUTOFILL_NO_DIALOG: '1', AGENT_AUTOFILL_DEMO_USERNAME: 'alice@example.com', AGENT_AUTOFILL_DEMO_PASSWORD: SECRET_PW, AGENT_AUTOFILL_DEMO_TOTP_SECRET: TOTP_SECRET, AGENT_AUTOFILL_IDENTITY_TESTER: JSON.stringify(IDENTITY),
      AGENT_AUTOFILL_DEMO_FIELD_ACCOUNT_ID: 'acct-123', AGENT_AUTOFILL_DEMO_SECRET_API_KEY: API_KEY, AGENT_AUTOFILL_DEMO_FIELD_PEM: PEM, AGENT_AUTOFILL_DEMO_FLAG_SANDBOX: 'true' },
  }));
  const call = async (name, args) => {
    const r = await client.callTool({ name, arguments: args });
    const text = r.content.map((c) => c.text).join('\n');
    for (const f of [...FORBIDDEN, ...generated]) assert.ok(!text.includes(f), `${name} result leaked a secret or personal detail`);
    return { error: r.isError, text, json: r.isError ? null : JSON.parse(text) };
  };
  return { client, call };
}

function writePolicy(home, origins, signupOrigins = ['http://127.0.0.1:*'], visible = false) {
  fs.mkdirSync(home, { recursive: true });
  fs.writeFileSync(path.join(home, 'policy.yaml'), `vaults:\n  ci:\n    type: env\ngrants:\n  - vault: ci\n    item: demo\n    origins: ${JSON.stringify(origins)}\n${visible ? '    allow_visible_secrets: true\n' : ''}  - kind: signup\n    vault: ci\n    item: tester\n    origins: ${JSON.stringify(signupOrigins)}\n`);
}

test('e2e', { skip: !chromium && 'Playwright Chromium not installed', timeout: 120_000 }, async (t) => {
  const site = await startSite();
  const base = `http://127.0.0.1:${site.port}`;
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'aaf-'));
  const home = path.join(tmp, 'h');
  writePolicy(home, ['http://127.0.0.1:*']);
  const { client, call } = await mcp(home);

  t.after(async () => { await client.close(); site.srv.close(); });

  await t.test('tools list is exactly the four tools', async () => {
    const { tools } = await client.listTools();
    assert.deepEqual(tools.map((x) => x.name).sort(), ['fill_login', 'fill_signup', 'list_logins', 'request_authorization']);
  });

  await t.test('list_logins shows approvals, not secrets', async () => {
    const r = await call('list_logins', {});
    assert.equal(r.json.logins[0].login, 'demo');
    assert.deepEqual(r.json.logins[0].approved_origins, ['http://127.0.0.1:*']);
    assert.deepEqual(r.json.logins.find((l) => l.login === 'demo').custom_fields.sort((a, b) => a.name.localeCompare(b.name)),
      [{ name: 'account_id', type: 'text' }, { name: 'api_key', type: 'hidden' }, { name: 'pem', type: 'text' }, { name: 'sandbox', type: 'boolean' }]);
    assert.equal(r.json.identities[0].identity, 'tester');
    assert.deepEqual(r.json.identities[0].approved_signup_origins, ['http://127.0.0.1:*']);
    assert.ok(r.json.identities[0].has.includes('email'));
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

    // Custom fields: text, hidden (masked input), textarea, checkbox; auto-detected by label
    await openPage(b.endpoint, `${base}/apikeys`);
    const apiTarget = { type: 'cdp', endpoint: b.endpoint, url_contains: '/apikeys' };
    r = await call('fill_login', { login: 'demo', target: apiTarget, custom: { account_id: 'auto', api_key: 'auto', pem: 'auto', sandbox: 'auto' } });
    assert.ok(!r.error, r.text);
    assert.deepEqual(r.json.filled, ['custom:account_id', 'custom:api_key', 'custom:pem', 'custom:sandbox']);
    const val = (sel) => cdpEval(b.endpoint, '/apikeys', `(() => { const e = document.querySelector('${sel}'); return e.type === 'checkbox' ? e.checked : e.value; })()`);
    assert.equal(await val('#acct'), 'acct-123');
    assert.equal(await val('#key'), API_KEY);
    assert.equal(await val('#pem'), PEM);
    assert.equal(await val('#sandbox'), true);
    assert.equal(await val('#key2'), '', 'username/password not filled when only custom is given');

    // Hidden field refused into a visible text box, unless the approval allows visible secrets
    await openPage(b.endpoint, `${base}/apikeys?2`);
    const apiTarget2 = { type: 'cdp', endpoint: b.endpoint, url_contains: '/apikeys?2' };
    r = await call('fill_login', { login: 'demo', target: apiTarget2, custom: { api_key: '#key2' } });
    assert.ok(r.error && /masked inputs/.test(r.text), r.text);
    assert.equal(await cdpEval(b.endpoint, '/apikeys?2', 'document.querySelector("#key2").value'), '');
    r = await call('fill_login', { login: 'demo', target: apiTarget2, custom: { nope: 'auto' } });
    assert.ok(r.error && /no custom field "nope".*"api_key"/.test(r.text), r.text);
    writePolicy(home, ['http://127.0.0.1:*'], undefined, true);
    r = await call('fill_login', { login: 'demo', target: apiTarget2, custom: { api_key: '#key2' } });
    assert.ok(!r.error, r.text);
    assert.equal(await cdpEval(b.endpoint, '/apikeys?2', 'document.querySelector("#key2").value'), API_KEY);
    writePolicy(home, ['http://127.0.0.1:*']);

    // Signup with a generated password, then sign in with the saved login
    await openPage(b.endpoint, `${base}/signup`);
    r = await call('fill_signup', { identity: 'tester', target: { type: 'cdp', endpoint: b.endpoint, url_contains: '/signup' }, submit: true });
    assert.ok(!r.error, r.text);
    assert.equal(r.json.saved_login, '127.0.0.1');
    assert.deepEqual(r.json.skipped, ['phone']);
    assert.deepEqual(r.json.filled.sort(), ['country', 'email', 'first_name', 'last_name', 'password', 'password_confirm', 'username']);
    await new Promise((res) => setTimeout(res, 500));
    const signup = site.posts.pop();
    assert.equal(signup.first_name, 'Testa');
    assert.equal(signup.ln, 'Personovich');
    assert.equal(signup.email, 'tester@example.com');
    assert.equal(signup.username, 'tester1');
    assert.equal(signup.country, 'IL');
    assert.equal(signup.password.length, 20);
    assert.equal(signup.password, signup.password_confirm);
    assert.ok(!('terms' in signup), 'terms checkbox must stay unticked');
    generated.push(signup.password);

    r = await call('list_logins', {});
    assert.deepEqual(r.json.logins.find((l) => l.login === '127.0.0.1').approved_origins, [base]);
    await openPage(b.endpoint, `${base}/login?after-signup`);
    r = await call('fill_login', { login: '127.0.0.1', target: { type: 'cdp', endpoint: b.endpoint, url_contains: 'after-signup' }, submit: true });
    assert.ok(!r.error, r.text);
    await new Promise((res) => setTimeout(res, 500));
    assert.deepEqual(site.posts.pop(), { user: 'tester1', pass: signup.password }, 'sign-in uses the password saved at signup');

    // Browser validation blocks submit (username is not an email) and is reported, not hidden
    await openPage(b.endpoint, `${base}/emailonly`);
    r = await call('fill_login', { login: '127.0.0.1', target: { type: 'cdp', endpoint: b.endpoint, url_contains: 'emailonly' }, submit: true });
    assert.ok(!r.error, r.text);
    assert.equal(r.json.submitted, false);
    assert.match(r.json.note, /validation rejected username/);

    // Signup reusing an approved existing login; explicit selectors
    await openPage(b.endpoint, `${base}/signup?reuse`);
    r = await call('fill_signup', { identity: 'tester', credentials: { login: 'demo' }, fields: { email: 'input[name=email]', password: 'auto', password_confirm: 'auto' }, target: { type: 'cdp', endpoint: b.endpoint, url_contains: 'reuse' } });
    assert.ok(!r.error, r.text);
    assert.equal(r.json.used_login, 'demo');
    assert.equal(await cdpEval(b.endpoint, 'reuse', 'document.querySelector("[name=password_confirm]").value'), SECRET_PW);
    assert.equal(await cdpEval(b.endpoint, 'reuse', 'document.querySelector("[name=email]").value'), IDENTITY.email);
    assert.equal(await cdpEval(b.endpoint, 'reuse', 'document.querySelector("[name=username]").value'), '', 'only requested fields filled');

    // Signup refused where the identity is not approved
    await openPage(b.endpoint, `http://localhost:${site.port}/signup`);
    r = await call('fill_signup', { identity: 'tester', target: { type: 'cdp', endpoint: b.endpoint, url_contains: 'localhost:' + site.port + '/signup' } });
    assert.ok(r.error && /not approved for signing up on http:\/\/localhost/.test(r.text), r.text);

    // request_authorization needs exactly one of login / identity
    r = await call('request_authorization', { origins: ['https://x.test'] });
    assert.ok(r.error && /exactly one/.test(r.text));

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
    const sockets = () => { try { return fs.readdirSync(path.join(home, 'run')).filter((n) => /^bridge-.+\.sock$/.test(n)); } catch { return []; } };
    const waitSockets = async (n) => { for (let i = 0; i < 100 && sockets().length < n; i++) await new Promise((r) => setTimeout(r, 100)); return sockets(); };
    assert.equal((await waitSockets(1)).length, 1, 'extension connected to the native host with a per-profile socket');
    await openPage(b.endpoint, `${base}/login?ext`);

    let r = await call('fill_login', { login: 'demo', target: { type: 'chrome', url_contains: '/login?ext' }, submit: true });
    assert.ok(!r.error, r.text);
    assert.equal(typeof r.json.tab_id, 'number');
    await new Promise((res) => setTimeout(res, 500));
    assert.deepEqual(site.posts.pop(), { user: 'alice@example.com', pass: SECRET_PW });

    // Signup through the extension
    await openPage(b.endpoint, `${base}/signup?ext`);
    r = await call('fill_signup', { identity: 'tester', target: { type: 'chrome', url_contains: '/signup?ext' }, login_name: 'ext-signup', submit: true });
    assert.ok(!r.error, r.text);
    assert.equal(r.json.saved_login, 'ext-signup');
    await new Promise((res) => setTimeout(res, 500));
    const s2 = site.posts.pop();
    assert.equal(s2.country, 'IL');
    assert.equal(s2.password, s2.password_confirm);
    generated.push(s2.password);

    // Custom fields through the extension
    await openPage(b.endpoint, `${base}/apikeys?ext`);
    r = await call('fill_login', { login: 'demo', target: { type: 'chrome', url_contains: '/apikeys?ext' }, custom: { api_key: 'auto', sandbox: 'auto' } });
    assert.ok(!r.error, r.text);
    assert.equal(await cdpEval(b.endpoint, '/apikeys?ext', 'document.querySelector("#key").value'), API_KEY);
    assert.equal(await cdpEval(b.endpoint, '/apikeys?ext', 'document.querySelector("#sandbox").checked'), true);

    // A second Chrome profile with the extension: each gets its own socket, fills are routed
    const prof2 = path.join(tmp, 'ext2');
    execFileSync(path.join(REPO, 'bin/agent-autofill'), ['install', '--dir', path.join(prof2, 'NativeMessagingHosts'), '--quiet'], { env: { ...process.env, AGENT_AUTOFILL_HOME: home } });
    const b2 = await launch(prof2, [`--disable-extensions-except=${ext}`, `--load-extension=${ext}`]);
    assert.equal((await waitSockets(2)).length, 2, 'two profiles, two sockets');
    await openPage(b.endpoint, `${base}/login?profileA`);
    await openPage(b2.endpoint, `${base}/login?profileB`);
    const rA = await call('fill_login', { login: 'demo', target: { type: 'chrome', url_contains: 'profileA' } });
    const rB = await call('fill_login', { login: 'demo', target: { type: 'chrome', url_contains: 'profileB' } });
    assert.ok(!rA.error && !rB.error, rA.text + rB.text);
    assert.notEqual(rA.json.profile, rB.json.profile);
    assert.equal(await cdpEval(b.endpoint, 'profileA', 'document.querySelector("#pass").value'), SECRET_PW);
    assert.equal(await cdpEval(b2.endpoint, 'profileB', 'document.querySelector("#pass").value'), SECRET_PW);
    // The same page open in both profiles is ambiguous until a profile is named
    await openPage(b.endpoint, `${base}/login?both`);
    await openPage(b2.endpoint, `${base}/login?both`);
    r = await call('fill_login', { login: 'demo', target: { type: 'chrome', url_contains: '?both' } });
    assert.ok(r.error && /matches in 2 Chrome profiles/.test(r.text), r.text);
    assert.ok(!r.text.includes('/login?both'), 'ambiguity message shows origins, not full URLs');
    r = await call('fill_login', { login: 'demo', target: { type: 'chrome', url_contains: '?both', profile: rB.json.profile } });
    assert.ok(!r.error, r.text);
    assert.equal(await cdpEval(b2.endpoint, '?both', 'document.querySelector("#pass").value'), SECRET_PW);
    assert.equal(await cdpEval(b.endpoint, '?both', 'document.querySelector("#pass").value'), '', 'the other profile was not touched');
    // Closing a profile removes its socket (or the next request cleans it up)
    b2.proc.kill('SIGKILL');
    await new Promise((res) => setTimeout(res, 1500));
    r = await call('fill_login', { login: 'demo', target: { type: 'chrome', url_contains: 'profileA' } });
    assert.ok(!r.error, r.text);
    assert.equal(sockets().length, 1, 'stale socket of the closed profile is gone');

    // By tab id, wrong origin refused
    await openPage(b.endpoint, `http://localhost:${site.port}/login?ext2`);
    r = await call('fill_login', { login: 'demo', target: { type: 'chrome', url_contains: 'ext2' } });
    assert.ok(r.error && /not approved/.test(r.text), r.text);
  });
});
