import crypto from 'node:crypto';

const SETS = { lower: 'abcdefghijkmnopqrstuvwxyz', upper: 'ABCDEFGHJKLMNPQRSTUVWXYZ', digits: '23456789', symbols: '!@#$%^&*-_=+?' };

// Strong random password with at least one character from every enabled class.
export function generatePassword({ length = 20, digits = true, symbols = true, symbol_set } = {}) {
  const len = Math.min(Math.max(Number(length) || 20, 12), 128);
  const classes = [SETS.lower, SETS.upper, ...(digits ? [SETS.digits] : []), ...(symbols ? [symbol_set || SETS.symbols] : [])];
  const all = classes.join('');
  const chars = classes.map((c) => c[crypto.randomInt(c.length)]);
  while (chars.length < len) chars.push(all[crypto.randomInt(all.length)]);
  for (let i = chars.length - 1; i > 0; i--) {
    const j = crypto.randomInt(i + 1);
    [chars[i], chars[j]] = [chars[j], chars[i]];
  }
  return chars.join('');
}
