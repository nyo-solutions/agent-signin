// Payment card fields agent-autofill can fill, only when the vault config opts in
// with item_types: [..., card]. Values never leave the tool except into the page.
export const CARD_FIELDS = ['cardholder_name', 'number', 'exp_month', 'exp_year', 'code'];

const clean = (x) => (x == null || String(x).trim() === '' ? undefined : String(x).trim());
const month = (m) => { const n = Number(clean(m)); return n >= 1 && n <= 12 ? String(n).padStart(2, '0') : undefined; };
const year = (y) => { const s = clean(y)?.replace(/\D/g, ''); if (!s) return undefined; return s.length === 2 ? `20${s}` : s.length === 4 ? s : undefined; };

// Bitwarden card JSON -> our names (also the shape env cards use, after normalising).
export function fromBitwarden(c = {}) {
  return normalizeCard({ cardholder_name: c.cardholderName, number: c.number, exp_month: c.expMonth, exp_year: c.expYear, code: c.code, brand: c.brand });
}

export function normalizeCard(c = {}) {
  return {
    cardholder_name: clean(c.cardholder_name),
    number: clean(c.number)?.replace(/[\s-]/g, ''),
    exp_month: month(c.exp_month),
    exp_year: year(c.exp_year),
    code: clean(c.code),
    brand: clean(c.brand),
  };
}

// What the page-side fill kinds get from a card.
export function cardFillValues(c) {
  return {
    card_name: c.cardholder_name,
    card_number: c.number,
    card_exp: c.exp_month && c.exp_year ? { month: c.exp_month, year: c.exp_year } : undefined,
    card_exp_month: c.exp_month,
    card_exp_year: c.exp_year,
    card_code: c.code,
  };
}
export const CARD_KINDS = ['card_name', 'card_number', 'card_exp_month', 'card_exp_year', 'card_exp', 'card_code'];
