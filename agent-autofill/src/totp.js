import crypto from 'node:crypto';

function base32(s) {
  const alpha = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
  const clean = s.toUpperCase().replace(/[\s=-]/g, '');
  let bits = '';
  for (const c of clean) {
    const v = alpha.indexOf(c);
    if (v < 0) throw new Error('TOTP secret is not valid base32');
    bits += v.toString(2).padStart(5, '0');
  }
  const bytes = [];
  for (let i = 0; i + 8 <= bits.length; i += 8) bytes.push(parseInt(bits.slice(i, i + 8), 2));
  return Buffer.from(bytes);
}

// RFC 6238 code from a base32 secret or an otpauth:// URI.
export function totp(secretOrUri, now = Date.now()) {
  let secret = secretOrUri, digits = 6, period = 30, algo = 'sha1';
  if (secretOrUri.startsWith('otpauth://')) {
    const u = new URL(secretOrUri);
    secret = u.searchParams.get('secret') || '';
    digits = Number(u.searchParams.get('digits') || 6);
    period = Number(u.searchParams.get('period') || 30);
    algo = (u.searchParams.get('algorithm') || 'SHA1').toLowerCase();
  }
  const counter = Buffer.alloc(8);
  counter.writeBigUInt64BE(BigInt(Math.floor(now / 1000 / period)));
  const h = crypto.createHmac(algo, base32(secret)).update(counter).digest();
  const o = h[h.length - 1] & 0xf;
  const n = ((h[o] & 0x7f) << 24) | (h[o + 1] << 16) | (h[o + 2] << 8) | h[o + 3];
  return String(n % 10 ** digits).padStart(digits, '0');
}
