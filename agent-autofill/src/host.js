// Native messaging host. Chrome starts one per extension connection, so one
// per Chrome profile. Each host bridges its own private unix socket
// (run/bridge-<profile>.sock, used by the agent-autofill MCP server) to its
// profile's extension. Protocol to Chrome: 4-byte little-endian length + JSON.
// Socket: JSON lines.
import fs from 'node:fs';
import net from 'node:net';
import { RUN_DIR, socketFor } from './paths.js';

const pending = new Map(); // seq -> { sock, id }
let seq = 0;
let server;
let sockPath;

function toChrome(msg) {
  const body = Buffer.from(JSON.stringify(msg));
  const head = Buffer.alloc(4);
  head.writeUInt32LE(body.length);
  process.stdout.write(Buffer.concat([head, body]));
}

function cleanup() {
  // Only remove the socket if it is still ours (a newer host for the same profile may own the path now).
  try { if (sockPath && fs.statSync(sockPath).ino === server?.ino) fs.unlinkSync(sockPath); } catch {}
  process.exit(0);
}
process.stdin.on('end', cleanup); // Chrome closed the port
process.on('SIGTERM', cleanup);
process.on('SIGINT', cleanup);

function listen(profileId) {
  if (server) return;
  fs.mkdirSync(RUN_DIR, { recursive: true, mode: 0o700 });
  fs.chmodSync(RUN_DIR, 0o700);
  sockPath = socketFor(profileId);
  try { fs.unlinkSync(sockPath); } catch {}
  server = net.createServer((sock) => {
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
  server.listen(sockPath, () => {
    fs.chmodSync(sockPath, 0o600);
    server.ino = fs.statSync(sockPath).ino;
  });
}

let inbuf = Buffer.alloc(0);
process.stdin.on('data', (chunk) => {
  inbuf = Buffer.concat([inbuf, chunk]);
  while (inbuf.length >= 4) {
    const len = inbuf.readUInt32LE(0);
    if (inbuf.length < 4 + len) break;
    const msg = JSON.parse(inbuf.subarray(4, 4 + len).toString());
    inbuf = inbuf.subarray(4 + len);
    if (msg.type === 'hello') { listen(msg.profile_id); continue; }
    const p = pending.get(msg.seq);
    if (!p) continue;
    pending.delete(msg.seq);
    if (!p.sock.destroyed) p.sock.write(JSON.stringify({ id: p.id, ok: msg.ok, result: msg.result, error: msg.error }) + '\n');
  }
});

// An extension older than 0.4 sends no hello: fall back to a per-process socket.
setTimeout(() => listen(`pid${process.pid}`), 3000).unref();
