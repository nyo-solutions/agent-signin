// Cross-process locks, so several agent sessions (each runs its own MCP server)
// can share the allow-list, the `bw` CLI and the approval dialog safely.
// A lock is a file created with O_EXCL in run/; it holds the owner's pid, and a
// lock whose owner died or that is older than staleMs is taken over.
import { AsyncLocalStorage } from 'node:async_hooks';
import fs from 'node:fs';
import path from 'node:path';
import { RUN_DIR } from './paths.js';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
// Locks held by the current async call chain, so nested use of the same lock
// (e.g. a save that reads, then writes) doesn't wait for itself.
const held = new AsyncLocalStorage();
const alive = (pid) => { try { process.kill(pid, 0); return true; } catch (e) { return e.code === 'EPERM'; } };

export async function withLock(name, fn, { timeoutMs = 30_000, staleMs = 60_000, runDir = RUN_DIR } = {}) {
  fs.mkdirSync(runDir, { recursive: true, mode: 0o700 });
  const file = path.join(runDir, `${name}.lock`);
  const mine = held.getStore();
  if (mine?.has(file)) return fn();
  const deadline = Date.now() + timeoutMs;
  let fd;
  for (let wait = 10; ; wait = Math.min(wait * 2, 200)) {
    try {
      fd = fs.openSync(file, 'wx', 0o600);
      fs.writeSync(fd, String(process.pid));
      break;
    } catch (e) {
      if (e.code !== 'EEXIST') throw e;
      try {
        const st = fs.statSync(file);
        const pid = Number(fs.readFileSync(file, 'utf8')) || 0;
        if ((pid && !alive(pid)) || Date.now() - st.mtimeMs > staleMs) { fs.unlinkSync(file); continue; }
      } catch { continue; } // vanished between checks: retry at once
      if (Date.now() > deadline) throw new Error(`another agent session holds the ${name} lock; try again shortly`);
      await sleep(wait + Math.random() * wait);
    }
  }
  try {
    return await held.run(new Set([...(mine || []), file]), fn);
  } finally {
    fs.closeSync(fd);
    try { if (Number(fs.readFileSync(file, 'utf8')) === process.pid) fs.unlinkSync(file); } catch {}
  }
}
