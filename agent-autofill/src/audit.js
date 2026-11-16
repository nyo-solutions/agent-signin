import fs from 'node:fs';
import path from 'node:path';
import { AUDIT_PATH } from './paths.js';

// One JSON line per action. Never pass secret values in here.
export function audit(event) {
  try {
    fs.mkdirSync(path.dirname(AUDIT_PATH), { recursive: true, mode: 0o700 });
    fs.appendFileSync(AUDIT_PATH, JSON.stringify({ ts: new Date().toISOString(), ...event }) + '\n', { mode: 0o600 });
  } catch {
    /* auditing must never break a fill */
  }
}
