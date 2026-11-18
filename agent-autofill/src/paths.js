import os from 'node:os';
import path from 'node:path';

export const HOME = process.env.AGENT_AUTOFILL_HOME || path.join(os.homedir(), '.config', 'agent-autofill');
export const POLICY_PATH = process.env.AGENT_AUTOFILL_POLICY || path.join(HOME, 'policy.yaml');
export const SOCKET_PATH = path.join(HOME, 'run', 'bridge.sock');
export const AUDIT_PATH = path.join(HOME, 'audit.log');
export const NATIVE_HOST_NAME = 'solutions.nyo.agent_autofill';
