// Agent Autofill extension: keeps a native-messaging port to the local
// agent-autofill host and fills pages when the host asks. The host is the only
// thing that holds secret values; the AI agent never talks to this extension.
import { fillPage } from './fill-page.js';

const HOST = 'solutions.nyo.agent_autofill';
let port = null;

function connect() {
  if (port) return;
  try {
    port = chrome.runtime.connectNative(HOST);
  } catch (e) {
    port = null;
    return;
  }
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

async function handle(msg) {
  switch (msg.op) {
    case 'ping':
      return { version: chrome.runtime.getManifest().version };
    case 'resolve_tab': {
      const tab = await resolveTab(msg);
      return { tab_id: tab.id, url: tab.url || '' };
    }
    case 'fill': {
      const tab = await chrome.tabs.get(msg.tab_id);
      const origin = tab.url ? new URL(tab.url).origin : '';
      if (origin !== msg.expected_origin) {
        throw new Error(`tab origin is ${origin || 'unknown'}, expected ${msg.expected_origin}`);
      }
      const [res] = await chrome.scripting.executeScript({
        target: { tabId: msg.tab_id },
        world: 'ISOLATED',
        func: fillPage,
        args: [{ expectedOrigin: msg.expected_origin, fields: msg.fields, submit: msg.submit }],
      });
      if (!res || res.result == null) throw new Error('fill script did not run in the page');
      return res.result;
    }
    default:
      throw new Error(`unknown op ${msg.op}`);
  }
}

chrome.runtime.onStartup.addListener(connect);
chrome.runtime.onInstalled.addListener(connect);
chrome.alarms.create('reconnect', { periodInMinutes: 0.5 });
chrome.alarms.onAlarm.addListener((a) => a.name === 'reconnect' && connect());
connect();
