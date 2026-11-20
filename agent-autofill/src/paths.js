import os from 'node:os';
import path from 'node:path';

export const HOME = process.env.AGENT_AUTOFILL_HOME || path.join(os.homedir(), '.config', 'agent-autofill');
export const POLICY_PATH = process.env.AGENT_AUTOFILL_POLICY || path.join(HOME, 'policy.yaml');
export const RUN_DIR = path.join(HOME, 'run');
// One socket per Chrome profile: run/bridge-<profile id>.sock
export const socketFor = (profileId) => path.join(RUN_DIR, `bridge-${String(profileId).replace(/[^A-Za-z0-9_-]/g, '').slice(0, 40) || 'unknown'}.sock`);
export const AUDIT_PATH = path.join(HOME, 'audit.log');
export const NATIVE_HOST_NAME = 'solutions.nyo.agent_autofill';
