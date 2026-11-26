// Talks to the Chrome extension(s) through the native hosts' local sockets.
// Every Chrome profile with the extension has its own host and socket
// (run/bridge-<profile>.sock); requests go to the profile that has the tab.
import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { RUN_DIR } from '../paths.js';
import { fillAcrossFrames, hasFrames } from './frames.js';

// The extension version shipped next to this server. An unpacked extension keeps
// running its old code until Chrome reloads it, so the server checks.
const BUNDLED = JSON.parse(fs.readFileSync(new URL('../../extension/manifest.json', import.meta.url), 'utf8')).version;
const parts = (v) => String(v || '0').split('.').map((n) => Number(n) || 0);
export function older(a, b) {
  const [x, y] = [parts(a), parts(b)];
  for (let i = 0; i < Math.max(x.length, y.length); i++) if ((x[i] || 0) !== (y[i] || 0)) return (x[i] || 0) < (y[i] || 0);
  return false;
}
const outdated = (profile, version, need, what) => new Error(
  `Agent Autofill in Chrome profile ${profile} is version ${version || 'unknown'}; ${what} needs ${need} or later. ` +
    'Reload it once at chrome://extensions (the circular arrow on Agent Autofill), then try again; later updates reload automatically.');

const NOT_CONNECTED = 'Chrome extension is not connected: open Chrome with the Agent Autofill extension enabled (run `agent-autofill doctor`)';

function request(socketPath, msg, timeoutMs = 20_000) {
  return new Promise((resolve, reject) => {
    const sock = net.createConnection(socketPath);
    let buf = '';
    const timer = setTimeout(() => { sock.destroy(); reject(Object.assign(new Error('Chrome extension did not answer in time'), { code: 'TIMEOUT' })); }, timeoutMs);
    const done = (fn, v) => { clearTimeout(timer); sock.end(); fn(v); };
    sock.on('error', (e) => { clearTimeout(timer); reject(e); });
    sock.on('data', (d) => {
      buf += d;
      const nl = buf.indexOf('\n');
      if (nl < 0) return;
      const reply = JSON.parse(buf.slice(0, nl));
      reply.ok ? done(resolve, reply.result) : done(reject, new Error(reply.error));
    });
    sock.write(JSON.stringify({ id: 1, ...msg }) + '\n');
  });
}

const profileOf = (socketPath) => path.basename(socketPath).replace(/^bridge-/, '').replace(/\.sock$/, '');

// Live profiles. Sockets left behind by closed profiles are removed.
export async function connectedProfiles({ runDir = RUN_DIR } = {}) {
  let names = [];
  try { names = fs.readdirSync(runDir).filter((n) => /^bridge(-.+)?\.sock$/.test(n)); } catch { return []; }
  const checks = await Promise.all(names.map(async (n) => {
    const p = path.join(runDir, n);
    try {
      const info = await request(p, { op: 'ping' }, 3000);
      return { profile: profileOf(p), socket: p, version: info.version, canReload: Boolean(info.can_reload) };
    } catch (e) {
      if (e.code === 'ECONNREFUSED' || e.code === 'ENOENT') { try { fs.unlinkSync(p); } catch {} }
      return null;
    }
  }));
  return checks.filter(Boolean);
}

export async function extensionRequest(msg, opts = {}) {
  const [first] = await connectedProfiles(opts);
  if (!first) throw new Error(NOT_CONNECTED);
  return request(first.socket, msg, opts.timeoutMs);
}

const originOf = (u) => { try { return new URL(u).origin; } catch { return 'unknown'; } };

// Find the tab across all connected profiles.
// Reload extensions whose files on disk are newer than what Chrome runs (when they can).
async function refresh(profiles, opts) {
  const stale = profiles.filter((p) => p.canReload && older(p.version, BUNDLED));
  if (!stale.length) return profiles;
  await Promise.all(stale.map((p) => request(p.socket, { op: 'reload' }, 3000).catch(() => {})));
  for (let i = 0; i < 40; i++) {
    await new Promise((r) => setTimeout(r, 250));
    const now = await connectedProfiles(opts);
    if (stale.every((p) => now.some((n) => n.profile === p.profile && !older(n.version, BUNDLED)))) return now;
  }
  return connectedProfiles(opts);
}

export async function chromeTarget(target, opts = {}) {
  let profiles = await refresh(await connectedProfiles(opts), opts);
  if (!profiles.length) throw new Error(NOT_CONNECTED);
  if (target.profile) {
    profiles = profiles.filter((p) => p.profile === target.profile);
    if (!profiles.length) throw new Error(`Chrome profile "${target.profile}" is not connected`);
  }
  const results = await Promise.all(profiles.map(async (p) => {
    try {
      const r = await request(p.socket, { op: 'resolve_tab', tab_id: target.tab_id, url_contains: target.url_contains });
      return { ...r, profile: p.profile, socket: p.socket, version: p.version };
    } catch (e) {
      return { error: e.message, profile: p.profile };
    }
  }));
  let hits = results.filter((r) => !r.error);
  if (target.tab_id != null && target.url_contains) hits = hits.filter((h) => h.url.includes(target.url_contains));
  if (hits.length > 1 && target.tab_id == null && !target.url_contains) {
    const focused = hits.filter((h) => h.focused); // "active tab": the profile window you're using
    if (focused.length) hits = focused;
  }
  if (hits.length === 1) return hits[0];
  if (!hits.length) {
    const why = [...new Set(results.map((r) => r.error))].join('; ');
    throw new Error(`no matching tab in ${profiles.length} connected Chrome profile(s): ${why}`);
  }
  throw new Error(
    `the tab matches in ${hits.length} Chrome profiles: ${hits.map((h) => `profile ${h.profile} (tab ${h.tab_id}, ${originOf(h.url)})`).join('; ')}. ` +
      'Pass target.profile, or a url_contains that only one of them matches.',
  );
}

export async function chromeRead(tab, req) {
  return request(tab.socket, { op: 'read', tab_id: tab.tab_id, expected_origin: req.expectedOrigin, selector: req.selector, attribute: req.attribute });
}

export async function chromeFill(tab, req) {
  const one = (r, frame) => request(tab.socket, {
    op: 'fill', tab_id: tab.tab_id, expected_origin: req.expectedOrigin, fields: r.fields, submit: r.submit,
    mode: r.mode, allow_visible_secrets: r.allowVisibleSecrets, partial: r.partial, submit_only: r.submitOnly,
    ...(frame && { frame_id: frame.ref, frame_origin: frame.origin }),
  });
  if (!hasFrames(req)) return one(req);
  if (older(tab.version, '0.6.0')) throw outdated(tab.profile, tab.version, '0.6.0', 'filling inside payment iframes');
  const frames = (await request(tab.socket, { op: 'frames', tab_id: tab.tab_id, expected_origin: req.expectedOrigin }))
    .map((f) => ({ ref: f.frame_id, origin: f.origin, top: f.frame_id === 0 }));
  return fillAcrossFrames(frames, (frame, r) => one(r, frame), req);
}
