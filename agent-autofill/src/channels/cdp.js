// Headless / automated runs: fills through the Chrome DevTools Protocol of a
// Chromium the automation started (Playwright, Puppeteer, --remote-debugging-port).
import { fillPage } from '../../extension/fill-page.js';
import { readPage } from '../../extension/read-page.js';

function hostAllowed(hostname, allowed) {
  const h = hostname.replace(/^\[|\]$/g, '').toLowerCase();
  return allowed.map((a) => a.toLowerCase()).includes(h);
}

async function browserWsUrl(endpoint, allowedHosts) {
  const u = new URL(endpoint);
  if (!hostAllowed(u.hostname, allowedHosts)) {
    throw new Error(`CDP endpoint host ${u.hostname} is not in cdp.allowed_hosts (${allowedHosts.join(', ')})`);
  }
  let ws = endpoint;
  if (u.protocol === 'http:' || u.protocol === 'https:') {
    const res = await fetch(new URL('/json/version', u));
    if (!res.ok) throw new Error(`CDP endpoint ${endpoint}: HTTP ${res.status}`);
    ws = (await res.json()).webSocketDebuggerUrl;
  } else if (u.protocol !== 'ws:' && u.protocol !== 'wss:') {
    throw new Error('CDP endpoint must be http(s):// or ws(s)://');
  }
  if (!hostAllowed(new URL(ws).hostname, allowedHosts)) throw new Error('CDP endpoint redirected to a host that is not allowed');
  return ws;
}

class Cdp {
  static async connect(url) {
    const c = new Cdp();
    c.ws = new WebSocket(url);
    c.seq = 0;
    c.pending = new Map();
    await new Promise((res, rej) => {
      c.ws.onopen = res;
      c.ws.onerror = () => rej(new Error(`cannot connect to CDP at ${url}`));
    });
    c.ws.onmessage = (e) => {
      const m = JSON.parse(e.data);
      const p = m.id && c.pending.get(m.id);
      if (!p) return;
      c.pending.delete(m.id);
      m.error ? p.rej(new Error(`CDP ${p.method}: ${m.error.message}`)) : p.res(m.result);
    };
    return c;
  }
  send(method, params = {}, sessionId) {
    const id = ++this.seq;
    this.ws.send(JSON.stringify({ id, method, params, ...(sessionId && { sessionId }) }));
    return new Promise((res, rej) => this.pending.set(id, { res, rej, method }));
  }
  close() { try { this.ws.close(); } catch {} }
}

async function pickTarget(cdp, target) {
  const { targetInfos } = await cdp.send('Target.getTargets');
  const pages = targetInfos.filter((t) => t.type === 'page');
  let t;
  if (target.target_id) t = pages.find((p) => p.targetId === target.target_id);
  else if (target.url_contains) t = pages.find((p) => p.url.includes(target.url_contains));
  else if (pages.length === 1) t = pages[0];
  if (!t) {
    throw new Error(`no matching page; open pages: ${pages.map((p) => `${p.targetId} ${p.url}`).join(' | ') || 'none'} (pass target_id or url_contains)`);
  }
  return t;
}

export async function cdpTarget(target, allowedHosts) {
  const cdp = await Cdp.connect(await browserWsUrl(target.endpoint, allowedHosts));
  try {
    const t = await pickTarget(cdp, target);
    return { target_id: t.targetId, url: t.url };
  } finally {
    cdp.close();
  }
}

export const cdpFill = (target, resolved, req, allowedHosts) => cdpRun(fillPage, 'fill', target, resolved, req, allowedHosts);
export const cdpRead = (target, resolved, req, allowedHosts) => cdpRun(readPage, 'read', target, resolved, req, allowedHosts);

async function cdpRun(fn, what, target, resolved, req, allowedHosts) {
  const cdp = await Cdp.connect(await browserWsUrl(target.endpoint, allowedHosts));
  try {
    const { sessionId } = await cdp.send('Target.attachToTarget', { targetId: resolved.target_id, flatten: true });
    const { frameTree } = await cdp.send('Page.getFrameTree', {}, sessionId);
    if (new URL(frameTree.frame.url).origin !== req.expectedOrigin) {
      throw new Error(`page origin is ${new URL(frameTree.frame.url).origin}, expected ${req.expectedOrigin}`);
    }
    // Isolated world: the page's own scripts cannot hook the fill function.
    const { executionContextId } = await cdp.send('Page.createIsolatedWorld', { frameId: frameTree.frame.id, worldName: 'agent-autofill' }, sessionId);
    const { result, exceptionDetails } = await cdp.send('Runtime.callFunctionOn', {
      functionDeclaration: fn.toString(),
      executionContextId,
      arguments: [{ value: req }],
      returnByValue: true,
      awaitPromise: true,
    }, sessionId);
    if (exceptionDetails) throw new Error(`${what} script failed: ${exceptionDetails.exception?.description?.split('\n')[0] || exceptionDetails.text}`);
    await cdp.send('Target.detachFromTarget', { sessionId }).catch(() => {});
    return result.value;
  } finally {
    cdp.close();
  }
}
