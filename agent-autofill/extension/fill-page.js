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
// mode "details": like signup, for identity details and payment card fields (fill_details).
//                partial: true (used per frame when a form spans iframes) also skips
//                selector fields that are not in this frame; submitOnly: only submit.
//
// Card kinds: card_name, card_number, card_exp ({ month, year }, written as the input
// expects: MM/YY, MM/YYYY or MMYY), card_exp_month, card_exp_year, card_code.
//
// Custom vault fields: { kind: "custom", name, ctype: "text"|"hidden"|"boolean" }. Hidden ones
// (API keys, secrets) only go into masked inputs unless allowVisibleSecrets is set by the policy.
export async function fillPage(req) {
  const { expectedOrigin, fields = [], submit, mode = 'login', allowVisibleSecrets = false, partial = false, submitOnly = false } = req;
  const lenient = mode === 'signup' || mode === 'details';
  if (location.origin !== expectedOrigin) {
    return { ok: false, error: `page origin is ${location.origin}, expected ${expectedOrigin}` };
  }

  const visible = (el) => {
    const r = el.getBoundingClientRect();
    const s = getComputedStyle(el);
    return r.width > 0 && r.height > 0 && s.visibility !== 'hidden' && s.display !== 'none';
  };
  const usable = () =>
    Array.from(document.querySelectorAll('input, select, textarea')).filter((el) => !el.disabled && !el.readOnly && visible(el));
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
    card_name: [['cc-name'], /name.?on.?card|card.?holder|holder.?name|cc.?name|name.?on.?the.?card/],
    card_number: [['cc-number'], /card.?number|card.?no\b|cc.?num|credit.?card|debit.?card|\bpan\b|^card$/],
    card_exp_month: [['cc-exp-month'], /exp\w*.?month|month|\bmm\b|cc.?month/],
    card_exp_year: [['cc-exp-year'], /exp\w*.?year|year|\byy(yy)?\b|cc.?year/],
    card_exp: [['cc-exp'], /expir|\bexp\b|valid.?(thru|through|until)|mm\W*yy/],
    card_code: [['cc-csc'], /cvc|cvv|csc|cvn|security.?code|card.?code|verification/],
  };
  const CARD = ['card_name', 'card_number', 'card_exp_month', 'card_exp_year', 'card_exp', 'card_code'];
  const combinedExp = (el) => /mm\W*yy/.test(describe(el)) || ac(el).includes('cc-exp');
  const TYPES = {
    username: ['text', 'email', 'tel'],
    password: ['password'],
    password_confirm: ['password'],
    totp: ['text', 'tel', 'number', 'password'],
    email: ['email', 'text'],
    card_name: ['text'],
    card_number: ['text', 'tel', 'number', 'password'],
    card_exp: ['text', 'tel'],
    card_exp_month: ['text', 'tel', 'number'],
    card_exp_year: ['text', 'tel', 'number'],
    card_code: ['text', 'tel', 'number', 'password'],
  };
  const label = (f) => (f.kind === 'custom' ? `custom:${f.name}` : f.kind);
  const allowed = (f, el) => {
    const kind = typeof f === 'string' ? f : f.kind;
    if (kind === 'custom') {
      if (f.ctype === 'boolean') return el instanceof HTMLInputElement && el.type === 'checkbox';
      const visibleOk = f.ctype === 'text' || allowVisibleSecrets;
      if (el instanceof HTMLTextAreaElement) return visibleOk;
      if (!(el instanceof HTMLInputElement)) return false;
      if (el.type === 'password') return true;
      return visibleOk && ['text', 'search', 'url', 'email', 'tel', 'number'].includes(el.type);
    }
    if (el instanceof HTMLSelectElement) return ['country', 'state', 'card_exp_month', 'card_exp_year'].includes(kind);
    if (!(el instanceof HTMLInputElement)) return false;
    return (TYPES[kind] || ['text', 'tel', 'search']).includes(el.type);
  };
  // Custom field auto-detect: an input whose name/id/label/placeholder contains the field name.
  const norm = (x) => String(x).toLowerCase().replace(/[^a-z0-9]+/g, '');
  const customDetect = (f, taken) => {
    const want = norm(f.name);
    const all = Array.from(document.querySelectorAll('input, textarea')).filter((el) => !el.disabled && !el.readOnly && !taken.has(el) && (visible(el) || el.type === 'checkbox'));
    return all.find((el) => norm(describe(el)).includes(want) && allowed(f, el));
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
    let ok = free.filter((el) => allowed(kind, el));
    // A single "MM / YY" box is card_exp, never the month or year field.
    if (kind === 'card_exp_month' || kind === 'card_exp_year') ok = ok.filter((el) => !combinedExp(el));
    if (kind === 'card_exp') ok = ok.filter((el) => !(el instanceof HTMLSelectElement));
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
      const name = label(f);
      const el = auto
        ? (f.kind === 'custom' ? customDetect(f, taken) : lenient ? signupDetect(f.kind, taken) : loginDetect[f.kind]())
        : bySelector(f.selector);
      if (!el) {
        if ((lenient && auto) || partial) { skipped.push(name); continue; }
        return { ok: false, error: `no ${name} field found${auto ? ' (auto-detect)' : ` for ${f.selector}`}` };
      }
      if (!allowed(f, el)) {
        const what = el instanceof HTMLInputElement ? `an input of type "${el.type}"` : `<${el.nodeName.toLowerCase()}>`;
        const hint = f.kind === 'custom' && f.ctype === 'hidden' ? ' (hidden vault fields only go into masked inputs unless the approval allows visible secrets)' : '';
        return { ok: false, error: `${name} target is ${what}; not allowed for ${name}${hint}` };
      }
      if (el.disabled || el.readOnly) return { ok: false, error: `${name} field is disabled or read-only` };
      if (taken.has(el)) return { ok: false, error: `${name} resolves to the same input as another field` };
      taken.add(el);
      plan.push({ kind: name, el, value: f.value });
    }
  } catch (e) {
    return { ok: false, error: e.message };
  }
  if (!plan.length && !submitOnly) {
    if (partial) return { ok: true, origin: location.origin, filled: [], submitted: false, skipped };
    return { ok: false, error: 'none of the requested fields were found on the page' };
  }

  // Card values in the shape each input expects (2- or 4-digit year, MM/YY vs MMYY, select options).
  const two = (y) => String(y).slice(-2);
  const fmt = (p) => {
    const el = p.el;
    const ml = el.maxLength > 0 ? el.maxLength : 0;
    const hint = `${describe(el)} ${el.getAttribute('placeholder') || ''}`.toLowerCase();
    if (p.kind === 'card_number') return String(p.value).replace(/\D/g, '');
    if (p.kind === 'card_exp') {
      const { month, year } = p.value;
      if (/yyyy/.test(hint)) return `${month}/${year}`;
      if (/mm \/ yy/.test(hint)) return `${month} / ${two(year)}`;
      if (ml === 4) return `${month}${two(year)}`;
      if (/yy/.test(hint) || ml === 5) return `${month}/${two(year)}`;
      return ml >= 7 ? `${month}/${year}` : `${month}/${two(year)}`;
    }
    if (p.kind === 'card_exp_year' && !(el instanceof HTMLSelectElement)) return ml === 2 || (/\byy\b/.test(hint) && !/yyyy/.test(hint)) ? two(p.value) : String(p.value);
    return p.value;
  };
  const cardOption = (p) => {
    const opts = Array.from(p.el.options);
    if (p.kind === 'card_exp_month') {
      const n = Number(p.value);
      return opts.find((o) => o.value !== '' && Number(o.value) === n) || opts.find((o) => Number((o.textContent.match(/\d+/) || [])[0]) === n);
    }
    const y4 = String(p.value);
    return opts.find((o) => o.value === y4 || o.value === two(y4)) || opts.find((o) => o.textContent.trim() === y4 || o.textContent.trim() === two(y4));
  };

  const inputSetter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set;
  const selectSetter = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value').set;
  const textareaSetter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set;
  const filled = [];
  for (const p of plan) {
    p.el.focus();
    if (CARD.includes(p.kind)) p.value = fmt(p);
    if (p.el instanceof HTMLSelectElement && CARD.includes(p.kind)) {
      const opt = cardOption(p);
      if (!opt) { skipped.push(p.kind); p.el.blur(); continue; }
      selectSetter.call(p.el, opt.value);
    } else if (p.el instanceof HTMLSelectElement) {
      const want = String(p.value).trim().toLowerCase();
      const opt = Array.from(p.el.options).find((o) => o.value.toLowerCase() === want || o.textContent.trim().toLowerCase() === want) ||
        Array.from(p.el.options).find((o) => want.length > 2 && o.textContent.trim().toLowerCase().startsWith(want));
      if (!opt) { skipped.push(p.kind); p.el.blur(); continue; }
      selectSetter.call(p.el, opt.value);
    } else if (p.el instanceof HTMLInputElement && p.el.type === 'checkbox') {
      const want = p.value === true || String(p.value).toLowerCase() === 'true';
      if (p.el.checked !== want) p.el.click(); // click fires input/change like a user would
      filled.push(p.kind);
      continue;
    } else if (p.el instanceof HTMLTextAreaElement) {
      textareaSetter.call(p.el, p.value);
      p.el.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText' }));
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
      const form = plan.map((p) => p.el.form).find(Boolean) ||
        (submitOnly ? Array.from(document.forms).find((fm) => fm.querySelector('button, input[type=submit]')) : undefined);
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
    ...(submitOnly && !submitted && !submitNote && { note: 'nothing to submit' }),
    ...(submitNote && { note: submitNote }),
  };
}
