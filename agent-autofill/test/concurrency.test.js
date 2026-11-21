// Several agent sessions at once: each runs its own MCP server process, all
// sharing the allow-list, the bw CLI data and the run/ folder.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import YAML from 'yaml';
import { withLock } from '../src/lock.js';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const N = 8;
const runAll = (n, mk) => Promise.all(Array.from({ length: n }, (_, i) => new Promise((resolve) => {
  const { cmd, args, env } = mk(i);
  const p = spawn(cmd, args, { env: { ...process.env, ...env }, stdio: ['ignore', 'pipe', 'pipe'] });
  let out = '';
  p.stdout.on('data', (d) => (out += d)); p.stderr.on('data', (d) => (out += d));
  p.on('close', (code) => resolve({ code, out }));
})));

test(`${N} sessions approving at the same moment: no approval is lost`, async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'aaf-conc-'));
  fs.writeFileSync(path.join(home, 'policy.yaml'), 'vaults:\n  ci:\n    type: env\ngrants: []\n');
  const res = await runAll(N, (i) => ({
    cmd: path.join(REPO, 'bin/agent-autofill'),
    args: ['allow', 'demo', `https://site${i}.test`],
    env: { AGENT_AUTOFILL_HOME: home, AGENT_AUTOFILL_DEMO_PASSWORD: 'x' },
  }));
  assert.ok(res.every((r) => r.code === 0), res.map((r) => r.out).join('\n'));
  const policy = YAML.parse(fs.readFileSync(path.join(home, 'policy.yaml'), 'utf8'));
  const origins = policy.grants.flatMap((g) => g.origins).sort();
  assert.deepEqual(origins, Array.from({ length: N }, (_, i) => `https://site${i}.test`).sort());
  assert.ok(!fs.readdirSync(path.join(home, 'run')).some((f) => f.endsWith('.lock')), 'no lock left behind');
});

test(`${N} sessions saving to the vault at once: every write lands (bw calls are serialized)`, async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'aaf-conc-'));
  const vault = path.join(home, 'vault.json');
  fs.copyFileSync(path.join(REPO, 'test/fixtures/vault.json'), vault);
  const script = `
    import { create } from ${JSON.stringify(path.join(REPO, 'src/vaults/bitwarden.js'))};
    const v = create({ type: 'bitwarden', bw_bin: ${JSON.stringify(path.join(REPO, 'test/fixtures/fake-bw.mjs'))}, folders: ['ai'] });
    const i = process.env.N;
    await v.saveField({ create: true, item_name: 'parallel-' + i, uris: ['https://p.test'], field_kind: 'custom', field_name: 'API Key', value: 'v' + i });
    await v.saveField({ create: false, item: 'github.com', field_kind: 'custom', field_name: 'Field ' + i, field_type: 'text', value: 'f' + i });
    console.log('done');`;
  const res = await runAll(N, (i) => ({
    cmd: process.execPath, args: ['--input-type=module', '-e', script],
    env: { AGENT_AUTOFILL_HOME: home, FAKE_BW_VAULT: vault, BW_SESSION: 't', N: String(i) },
  }));
  assert.ok(res.every((r) => r.code === 0 && r.out.includes('done')), res.map((r) => r.out).join('\n'));
  const items = JSON.parse(fs.readFileSync(vault, 'utf8')).items;
  assert.equal(items.filter((it) => it.name.startsWith('parallel-')).length, N, 'every created item is there');
  const gh = items.find((it) => it.id === 'i1');
  assert.equal(gh.fields.filter((f) => f.name.startsWith('Field ')).length, N, 'every edit of the same item is there');
});

test('a lock left by a crashed session is taken over', async () => {
  const runDir = fs.mkdtempSync(path.join(os.tmpdir(), 'aaf-lock-'));
  fs.writeFileSync(path.join(runDir, 'policy.lock'), '999999'); // no such process
  const t = Date.now();
  assert.equal(await withLock('policy', () => 'ok', { runDir, timeoutMs: 2000 }), 'ok');
  assert.ok(Date.now() - t < 1000);
  fs.writeFileSync(path.join(runDir, 'policy.lock'), String(process.ppid)); // alive owner
  await assert.rejects(withLock('policy', () => 'x', { runDir, timeoutMs: 300 }), /another agent session holds the policy lock/);
});

test('locks serialize work inside one process too', async () => {
  const runDir = fs.mkdtempSync(path.join(os.tmpdir(), 'aaf-lock-'));
  let inside = 0, max = 0;
  await Promise.all(Array.from({ length: 10 }, () => withLock('x', async () => {
    inside++; max = Math.max(max, inside); await new Promise((r) => setTimeout(r, 5)); inside--;
  }, { runDir })));
  assert.equal(max, 1);
});
