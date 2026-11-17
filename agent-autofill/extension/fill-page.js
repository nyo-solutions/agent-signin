// Runs inside the page, in an isolated world (page scripts cannot see its
// variables). Used by the Chrome extension (chrome.scripting) and by the CDP
// channel (serialised with toString()), so it must stay self-contained: no
// imports, no references to anything outside the function body.
//
// It never returns field values: only which fields were filled.
//
// mode "login"  (default): every requested field must be found, or nothing is filled.
// mode "signup": requested fields given a selector must be found; auto-detected
//                ones that the form doesn't have are skipped and reported.
export async function fillPage(req) {
  const { expectedOrigin, fields, submit, mode = 'login' } = req;
  if (location.origin !== expectedOrigin) {
    return { ok: false, error: `page origin is ${location.origin}, expected ${expectedOrigin}` };
  }

  const visible = (el) => {
    const r = el.getBoundingClientRect();
    const s = getComputedStyle(el);
    return r.width > 0 && r.height > 0 && s.visibility !== 'hidden' && s.display !== 'none';
  };
  const usable = () =>
    Array.from(document.querySelectorAll('input, select')).filter((el) => !el.disabled && !el.readOnly && visible(el));
  const textish = (el) => el instanceof HTMLInputElement && ['text', 'email', 'tel', 'search'].includes(el.type);

  const bySelector = (sel) => {
    let s = sel.trim();
    let xpath = false;
    if (s.startsWith('xpath=')) { s = s.slice(6); xpath = true; }
    else if (s.startsWith('css=')) s = s.slice(4);
    else if (s.startsWith('/') || s.startsWith('(')) xpath = true;
    try {
      if (xpath) return document.evaluate(s, document, null, XPathResult.FIRST_ORDERED_NODE_TYPE, null).singleNodeValue;
      return document.querySelector(s);
    } catch {
      throw new Error(`invalid selector: ${sel}`);
    }
  };

  // Words that describe a field: name, id, placeholder, aria-label, <label>.
  const describe = (el) => {
    const labels = el.labels ? Array.from(el.labels).map((l) => l.textContent) : [];
    return [el.name, el.id, el.getAttribute('placeholder'), el.getAttribute('aria-label'), ...labels]
      .filter(Boolean).join(' ').toLowerCase();
  };
  const ac = (el) => (el.getAttribute('autocomplete') || '').toLowerCase().split(/\s+/);

  // Signup field detection: autocomplete token first, then words.
  const HINTS = {
    first_name: [['given-name'], /first.?name|fname|given.?name|vorname|prénom/],
    last_name: [['family-name'], /last.?name|lname|surname|family.?name/],
    full_name: [['name'], /^(full.?name|your.?name|name)$|\bfull.?name\b/],
    email: [['email'], /e-?mail/],
    username: [['username'], /user.?name|login.?name|\bhandle\b|screen.?name|\buser\b|nickname/],
    phone: [['tel', 'tel-national'], /phone|mobile|\btel\b|cell/],
    company: [['organization'], /company|organi[sz]ation|business.?name|employer/],
    address1: [['address-line1', 'street-address'], /address.?(line)?.?1|street|^address$|\baddress\b(?!.*2)/],
    address2: [['address-line2'], /address.?(line)?.?2|apt|suite|unit/],
    city: [['address-level2'], /city|town|locality/],
    state: [['address-level1'], /state|province|region|county/],
    postal_code: [['postal-code'], /zip|postal|post.?code/],
    country: [['country', 'country-name'], /country/],
  };
  const TYPES = {
    username: ['text', 'email', 'tel'],
    password: ['password'],
    password_confirm: ['password'],
    totp: ['text', 'tel', 'number', 'password'],
    email: ['email', 'text'],
  };
  const allowed = (kind, el) => {
    if (el instanceof HTMLSelectElement) return ['country', 'state'].includes(kind);
    if (!(el instanceof HTMLInputElement)) return false;
    return (TYPES[kind] || ['text', 'tel', 'search']).includes(el.type);
  };

  const passwords = () => usable().filter((el) => el instanceof HTMLInputElement && el.type === 'password');
  const confirmRx = /confirm|repeat|again|retype|re-?enter|verify|password2|passwordconfirm/;
  const loginDetect = {
    password: () => passwords()[0],
    username: () => {
      const all = usable().filter(textish);
      const hinted = all.find((el) => ac(el).some((t) => t === 'username' || t === 'email')) || all.find((el) => el.type === 'email');
      if (hinted) return hinted;
      const all2 = usable();
      const pw = all2.findIndex((el) => el.type === 'password');
      const before = all2.slice(0, pw < 0 ? all2.length : pw).filter((el) => ['text', 'email', 'tel'].includes(el.type));
      return before[before.length - 1];
    },
    totp: () => {
      const all = usable().filter((el) => el instanceof HTMLInputElement);
      return all.find((el) => ac(el).includes('one-time-code')) ||
        all.find((el) => /otp|totp|2fa|mfa|code/i.test(`${el.name} ${el.id}`) && ['text', 'tel', 'number'].includes(el.type));
    },
  };
  const signupDetect = (kind, taken) => {
    const free = usable().filter((el) => !taken.has(el));
    if (kind === 'password') {
      const pws = passwords().filter((el) => !taken.has(el));
      return pws.find((el) => ac(el).includes('new-password') && !confirmRx.test(describe(el))) || pws.find((el) => !confirmRx.test(describe(el))) || pws[0];
    }
    if (kind === 'password_confirm') return passwords().find((el) => !taken.has(el));
    const [tokens, rx] = HINTS[kind] || [[], null];
    const ok = free.filter((el) => allowed(kind, el));
    return ok.find((el) => ac(el).some((t) => tokens.includes(t))) ||
      (kind === 'email' && ok.find((el) => el.type === 'email')) ||
      (kind === 'phone' && ok.find((el) => el.type === 'tel')) ||
      (rx && ok.find((el) => rx.test(describe(el)))) || undefined;
  };

  // Resolve and validate every field before touching any of them.
  // Explicit selectors first, so auto-detection doesn't take their inputs.
  const plan = [];
  const skipped = [];
  const taken = new Set();
  const ordered = [...fields.filter((f) => f.selector && f.selector !== 'auto'), ...fields.filter((f) => !f.selector || f.selector === 'auto')];
  try {
    for (const f of ordered) {
      const auto = !f.selector || f.selector === 'auto';
      const el = auto ? (mode === 'signup' ? signupDetect(f.kind, taken) : loginDetect[f.kind]()) : bySelector(f.selector);
      if (!el) {
        if (mode === 'signup' && auto) { skipped.push(f.kind); continue; }
        return { ok: false, error: `no ${f.kind} field found${auto ? ' (auto-detect)' : ` for ${f.selector}`}` };
      }
      if (!allowed(f.kind, el)) {
        const what = el instanceof HTMLInputElement ? `an input of type "${el.type}"` : `<${el.nodeName.toLowerCase()}>`;
        return { ok: false, error: `${f.kind} target is ${what}; not allowed for ${f.kind}` };
      }
      if (el.disabled || el.readOnly) return { ok: false, error: `${f.kind} field is disabled or read-only` };
      if (taken.has(el)) return { ok: false, error: `${f.kind} resolves to the same input as another field` };
      taken.add(el);
      plan.push({ kind: f.kind, el, value: f.value });
    }
  } catch (e) {
    return { ok: false, error: e.message };
  }
  if (!plan.length) return { ok: false, error: 'none of the requested fields were found on the page' };

  const inputSetter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set;
  const selectSetter = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value').set;
  const filled = [];
  for (const p of plan) {
    p.el.focus();
    if (p.el instanceof HTMLSelectElement) {
      const want = String(p.value).trim().toLowerCase();
      const opt = Array.from(p.el.options).find((o) => o.value.toLowerCase() === want || o.textContent.trim().toLowerCase() === want) ||
        Array.from(p.el.options).find((o) => want.length > 2 && o.textContent.trim().toLowerCase().startsWith(want));
      if (!opt) { skipped.push(p.kind); p.el.blur(); continue; }
      selectSetter.call(p.el, opt.value);
    } else {
      inputSetter.call(p.el, p.value); // native setter so React/Vue/Angular see the change
      p.el.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText' }));
    }
    p.el.dispatchEvent(new Event('change', { bubbles: true }));
    p.el.blur();
    filled.push(p.kind);
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
      if (form && !form.checkValidity()) {
        const bad = Array.from(form.elements).filter((el) => el.willValidate && !el.validity.valid)
          .map((el) => plan.find((p) => p.el === el)?.kind || el.name || el.id || el.type);
        submitNote = `not submitted: the form's own validation rejected ${bad.join(', ')}`;
      } else if (form) {
        form.requestSubmit ? form.requestSubmit() : form.submit();
        submitted = true;
      } else {
        const btn = Array.from(document.querySelectorAll('button[type=submit], input[type=submit]')).find(visible);
        if (btn) { btn.click(); submitted = true; } else submitNote = 'no form or submit button found; pass a submit selector';
      }
    }
  }
  return {
    ok: true, origin: location.origin, filled, submitted,
    ...(skipped.length && { skipped }),
    ...(submitNote && { note: submitNote }),
  };
}
