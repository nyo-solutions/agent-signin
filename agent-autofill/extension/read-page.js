// Runs inside the page, in an isolated world, to read ONE element's value for
// save_from_page. The value goes back to the local agent-autofill tool (which
// writes it to the vault), never to the AI agent. Self-contained: it is also
// serialised with toString() for the CDP channel.
export function readPage(req) {
  const { expectedOrigin, selector, attribute } = req;
  if (location.origin !== expectedOrigin) {
    return { ok: false, error: `page origin is ${location.origin}, expected ${expectedOrigin}` };
  }
  let s = String(selector || '').trim();
  let xpath = false;
  if (s.startsWith('xpath=')) { s = s.slice(6); xpath = true; }
  else if (s.startsWith('css=')) s = s.slice(4);
  else if (s.startsWith('/') || s.startsWith('(')) xpath = true;
  let el;
  try {
    el = xpath
      ? document.evaluate(s, document, null, XPathResult.FIRST_ORDERED_NODE_TYPE, null).singleNodeValue
      : document.querySelector(s);
  } catch {
    return { ok: false, error: `invalid selector: ${selector}` };
  }
  if (!el) return { ok: false, error: `no element found for ${selector}` };
  let value;
  if (attribute) value = el.getAttribute?.(attribute);
  else if (el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement || el instanceof HTMLSelectElement) value = el.value;
  else value = el.textContent;
  value = value == null ? '' : String(value).trim();
  if (!value) return { ok: false, error: `the element ${attribute ? `attribute "${attribute}" ` : ''}is empty` };
  if (value.length > 20000) return { ok: false, error: 'the element value is too long to be a credential (over 20,000 characters)' };
  return { ok: true, value, origin: location.origin };
}
