// Talks to the Chrome extension through the native host's local socket.
import net from 'node:net';
import { SOCKET_PATH } from '../paths.js';

export function extensionRequest(msg, { timeoutMs = 20_000, socketPath = SOCKET_PATH } = {}) {
  return new Promise((resolve, reject) => {
    const sock = net.createConnection(socketPath);
    let buf = '';
    const timer = setTimeout(() => { sock.destroy(); reject(new Error('Chrome extension did not answer in time')); }, timeoutMs);
    const done = (fn, v) => { clearTimeout(timer); sock.end(); fn(v); };
    sock.on('error', (e) => {
      clearTimeout(timer);
      reject(new Error(
        e.code === 'ENOENT' || e.code === 'ECONNREFUSED'
          ? 'Chrome extension is not connected: open Chrome with the Agent Autofill extension enabled (run `agent-autofill doctor`)'
          : `extension bridge: ${e.message}`,
      ));
    });
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

export async function chromeTarget(target) {
  return extensionRequest({ op: 'resolve_tab', tab_id: target.tab_id, url_contains: target.url_contains });
}

export async function chromeFill(tab, req) {
  return extensionRequest({ op: 'fill', tab_id: tab.tab_id, expected_origin: req.expectedOrigin, fields: req.fields, submit: req.submit, mode: req.mode, allow_visible_secrets: req.allowVisibleSecrets });
}
