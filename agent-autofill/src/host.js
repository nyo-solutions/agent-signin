// Native messaging host. Chrome starts it when the extension connects; it
// bridges a private unix socket (used by the agent-autofill MCP server) to the
// extension. Protocol to Chrome: 4-byte little-endian length + JSON. Socket: JSON lines.
import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { SOCKET_PATH } from './paths.js';

const pending = new Map(); // seq -> { sock, id }
let seq = 0;

function toChrome(msg) {
  const body = Buffer.from(JSON.stringify(msg));
  const head = Buffer.alloc(4);
  head.writeUInt32LE(body.length);
  process.stdout.write(Buffer.concat([head, body]));
}

let inbuf = Buffer.alloc(0);
process.stdin.on('data', (chunk) => {
  inbuf = Buffer.concat([inbuf, chunk]);
  while (inbuf.length >= 4) {
    const len = inbuf.readUInt32LE(0);
    if (inbuf.length < 4 + len) break;
    const msg = JSON.parse(inbuf.subarray(4, 4 + len).toString());
    inbuf = inbuf.subarray(4 + len);
    const p = pending.get(msg.seq);
    if (!p) continue;
    pending.delete(msg.seq);
    if (!p.sock.destroyed) p.sock.write(JSON.stringify({ id: p.id, ok: msg.ok, result: msg.result, error: msg.error }) + '\n');
  }
});

function cleanup() {
  try { fs.unlinkSync(SOCKET_PATH); } catch {}
  process.exit(0);
}
process.stdin.on('end', cleanup); // Chrome closed the port
process.on('SIGTERM', cleanup);
process.on('SIGINT', cleanup);

fs.mkdirSync(path.dirname(SOCKET_PATH), { recursive: true, mode: 0o700 });
fs.chmodSync(path.dirname(SOCKET_PATH), 0o700);
try { fs.unlinkSync(SOCKET_PATH); } catch {}

const server = net.createServer((sock) => {
  let buf = '';
  sock.on('error', () => {});
  sock.on('data', (d) => {
    buf += d;
    let nl;
    while ((nl = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, nl);
      buf = buf.slice(nl + 1);
      let req;
      try { req = JSON.parse(line); } catch { continue; }
      const s = ++seq;
      pending.set(s, { sock, id: req.id });
      const { id, ...rest } = req;
      toChrome({ ...rest, seq: s });
    }
  });
});
server.listen(SOCKET_PATH, () => fs.chmodSync(SOCKET_PATH, 0o600));
