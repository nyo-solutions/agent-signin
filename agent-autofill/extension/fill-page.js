// Runs inside the login page, in an isolated world (page scripts cannot see
// its variables). Used by the Chrome extension (chrome.scripting) and by the
// CDP channel (serialised with toString()), so it must stay self-contained:
// no imports, no references to anything outside the function body.
//
// It never returns field values: only which fields were filled.
export async function fillPage(req) {
  const { expectedOrigin, fields, submit } = req;
  if (location.origin !== expectedOrigin) {
    return { ok: false, error: `page origin is ${location.origin}, expected ${expectedOrigin}` };
  }

  const visible = (el) => {
    const r = el.getBoundingClientRect();
    const s = getComputedStyle(el);
    return r.width > 0 && r.height > 0 && s.visibility !== 'hidden' && s.display !== 'none';
  };
  const usable = () =>
    Array.from(document.querySelectorAll('input')).filter((el) => !el.disabled && !el.readOnly && visible(el));

  const bySelector = (sel) => {
    let s = sel.trim();
    let xpath = false;
    if (s.startsWith('xpath=')) { s = s.slice(6); xpath = true; }
    else if (s.startsWith('css=')) s = s.slice(4);
    else if (s.startsWith('/') || s.startsWith('(')) xpath = true;
    try {
      if (xpath) {
        return document.evaluate(s, document, null, XPathResult.FIRST_ORDERED_NODE_TYPE, null).singleNodeValue;
      }
      return document.querySelector(s);
    } catch {
      throw new Error(`invalid selector: ${sel}`);
    }
  };

  const detect = {
    password: () => usable().find((el) => el.type === 'password'),
    username: () => {
      const all = usable();
      const hinted = all.find((el) => /\b(username|email)\b/.test(el.autocomplete)) || all.find((el) => el.type === 'email');
      if (hinted) return hinted;
      const pw = all.findIndex((el) => el.type === 'password');
      const before = all.slice(0, pw < 0 ? all.length : pw).filter((el) => ['text', 'email', 'tel'].includes(el.type));
      return before[before.length - 1];
    },
    totp: () => {
      const all = usable();
      return (
        all.find((el) => el.autocomplete === 'one-time-code') ||
        all.find((el) => /otp|totp|2fa|mfa|code/i.test(`${el.name} ${el.id}`) && ['text', 'tel', 'number'].includes(el.type))
      );
    },
  };
  // A password only ever goes into a masked field, so it cannot end up as
  // visible text in a screenshot the agent takes.
  const allowedTypes = { username: ['text', 'email', 'tel'], password: ['password'], totp: ['text', 'tel', 'number', 'password'] };

  // Resolve and validate every field before touching any of them.
  const plan = [];
  try {
    for (const f of fields) {
      const el = !f.selector || f.selector === 'auto' ? detect[f.kind]() : bySelector(f.selector);
      if (!el) return { ok: false, error: `no ${f.kind} field found${f.selector && f.selector !== 'auto' ? ` for ${f.selector}` : ' (auto-detect)'}` };
      if (!(el instanceof HTMLInputElement)) return { ok: false, error: `${f.kind} target is <${el.nodeName.toLowerCase()}>, not an input` };
      if (!allowedTypes[f.kind].includes(el.type)) return { ok: false, error: `${f.kind} target is an input of type "${el.type}", allowed: ${allowedTypes[f.kind].join(', ')}` };
      if (el.disabled || el.readOnly) return { ok: false, error: `${f.kind} field is disabled or read-only` };
      if (plan.some((p) => p.el === el)) return { ok: false, error: `${f.kind} resolves to the same input as another field` };
      plan.push({ kind: f.kind, el, value: f.value });
    }
  } catch (e) {
    return { ok: false, error: e.message };
  }

  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set;
  for (const p of plan) {
    p.el.focus();
    setter.call(p.el, p.value); // native setter so React/Vue/Angular see the change
    p.el.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText' }));
    p.el.dispatchEvent(new Event('change', { bubbles: true }));
    p.el.blur();
  }

  let submitted = false;
  let submitNote;
  if (submit) {
    await new Promise((r) => setTimeout(r, 80)); // let frameworks flush state
    if (typeof submit === 'string') {
      const btn = bySelector(submit);
      if (btn) { btn.click(); submitted = true; } else submitNote = `submit selector not found: ${submit}`;
    } else {
      const form = plan.map((p) => p.el.form).find(Boolean);
      if (form) {
        form.requestSubmit ? form.requestSubmit() : form.submit();
        submitted = true;
      } else {
        const btn = Array.from(document.querySelectorAll('button[type=submit], input[type=submit]')).find(visible);
        if (btn) { btn.click(); submitted = true; } else submitNote = 'no form or submit button found; pass a submit selector';
      }
    }
  }
  return { ok: true, origin: location.origin, filled: plan.map((p) => p.kind), submitted, ...(submitNote && { note: submitNote }) };
}
