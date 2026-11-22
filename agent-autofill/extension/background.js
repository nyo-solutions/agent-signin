// Agent Autofill extension: keeps a native-messaging port to the local
// agent-autofill host and fills pages when the host asks. The host is the only
// thing that holds secret values; the AI agent never talks to this extension.
import { fillPage } from './fill-page.js';
import { readPage } from './read-page.js';

const HOST = 'solutions.nyo.agent_autofill';
let port = null;

// A random id per Chrome profile (stored in this profile's extension storage), so each
// profile gets its own bridge socket and the tool can tell profiles apart.
async function profileId() {
  const { profileId: id } = await chrome.storage.local.get('profileId');
  if (id) return id;
  const fresh = crypto.randomUUID().slice(0, 8);
  await chrome.storage.local.set({ profileId: fresh });
  return fresh;
}

async function connect() {
  if (port) return;
  const id = await profileId();
  if (port) return;
  try {
    port = chrome.runtime.connectNative(HOST);
  } catch (e) {
    port = null;
    return;
  }
  port.postMessage({ type: 'hello', profile_id: id, version: chrome.runtime.getManifest().version });
  port.onMessage.addListener((msg) => {
    handle(msg).then(
      (result) => port?.postMessage({ seq: msg.seq, ok: true, result }),
      (err) => port?.postMessage({ seq: msg.seq, ok: false, error: String(err?.message || err) }),
    );
  });
  port.onDisconnect.addListener(() => {
    void chrome.runtime.lastError; // host not installed / exited; the alarm retries
    port = null;
  });
}

async function resolveTab({ tab_id, url_contains }) {
  if (tab_id != null) return chrome.tabs.get(tab_id);
  if (url_contains) {
    const tab = (await chrome.tabs.query({})).find((t) => t.url && t.url.includes(url_contains));
    if (!tab) throw new Error(`no open tab whose URL contains "${url_contains}"`);
    return tab;
  }
  const [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
  if (!tab) throw new Error('no active tab');
  return tab;
}

async function checkTab(msg) {
  const tab = await chrome.tabs.get(msg.tab_id);
  const origin = tab.url ? new URL(tab.url).origin : '';
  if (origin !== msg.expected_origin) throw new Error(`tab origin is ${origin || 'unknown'}, expected ${msg.expected_origin}`);
}

async function handle(msg) {
  switch (msg.op) {
    case 'ping':
      return { version: chrome.runtime.getManifest().version };
    case 'resolve_tab': {
      const tab = await resolveTab(msg);
      const win = await chrome.windows.get(tab.windowId).catch(() => null);
      return { tab_id: tab.id, url: tab.url || '', focused: Boolean(win?.focused && tab.active) };
    }
    case 'frames': {
      // The tab's frames and their real origins, so card fields can go into an
      // approved payment iframe (the host decides which).
      await checkTab(msg);
      const res = await chrome.scripting.executeScript({ target: { tabId: msg.tab_id, allFrames: true }, world: 'ISOLATED', func: () => location.origin });
      return res.map((r) => ({ frame_id: r.frameId, origin: r.result }));
    }
    case 'fill': {
      await checkTab(msg);
      const frame = msg.frame_id != null && msg.frame_id !== 0;
      const [res] = await chrome.scripting.executeScript({
        target: { tabId: msg.tab_id, ...(msg.frame_id != null && { frameIds: [msg.frame_id] }) },
        world: 'ISOLATED',
        func: fillPage,
        args: [{
          // In an iframe the fill script checks the frame's own origin (approved by the host).
          expectedOrigin: frame ? msg.frame_origin : msg.expected_origin,
          fields: msg.fields, submit: msg.submit, mode: msg.mode || 'login', allowVisibleSecrets: Boolean(msg.allow_visible_secrets),
          partial: Boolean(msg.partial), submitOnly: Boolean(msg.submit_only),
        }],
      });
      if (!res || res.result == null) throw new Error('fill script did not run in the page');
      return res.result;
    }
    case 'read': {
      await checkTab(msg);
      const [res] = await chrome.scripting.executeScript({
        target: { tabId: msg.tab_id },
        world: 'ISOLATED',
        func: readPage,
        args: [{ expectedOrigin: msg.expected_origin, selector: msg.selector, attribute: msg.attribute }],
      });
      if (!res || res.result == null) throw new Error('read script did not run in the page');
      return res.result;
    }
    default:
      throw new Error(`unknown op ${msg.op}`);
  }
}

chrome.runtime.onStartup.addListener(() => void connect());
chrome.runtime.onInstalled.addListener(() => void connect());
chrome.alarms.create('reconnect', { periodInMinutes: 0.5 });
chrome.alarms.onAlarm.addListener((a) => a.name === 'reconnect' && void connect());
void connect();
