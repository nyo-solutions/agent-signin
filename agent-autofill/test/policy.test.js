import assert from 'node:assert/strict';
import test from 'node:test';
import { findGrant, originMatches, parsePattern } from '../src/policy.js';
import { totp } from '../src/totp.js';

test('origin patterns', () => {
  const t = (p, o) => originMatches(p, o);
  assert.ok(t('*', 'https://evil.example'));
  assert.ok(t('*', 'http://localhost:3000'));
  assert.ok(t('https://*', 'https://a.b.c'));
  assert.ok(t('https://*', 'https://a.b.c:8443'));
  assert.ok(!t('https://*', 'http://a.b.c'));
  assert.ok(t('https://github.com', 'https://github.com'));
  assert.ok(!t('https://github.com', 'https://github.com.evil.io'));
  assert.ok(!t('https://github.com', 'https://gist.github.com'));
  assert.ok(!t('https://github.com', 'https://github.com:8443'));
  assert.ok(t('https://*.example.com', 'https://example.com'));
  assert.ok(t('https://*.example.com', 'https://a.b.example.com'));
  assert.ok(!t('https://*.example.com', 'https://badexample.com'));
  assert.ok(!t('https://*.example.com', 'https://example.com.evil.io'));
  assert.ok(t('http://localhost:*', 'http://localhost:5173'));
  assert.ok(!t('http://localhost:*', 'http://127.0.0.1:5173'));
  assert.ok(t('http://localhost:3000', 'http://localhost:3000'));
  assert.ok(!t('http://localhost:3000', 'http://localhost:3001'));
  assert.ok(t('*://*.test', 'http://app.test'));
  assert.throws(() => parsePattern('github.com'));
  assert.throws(() => parsePattern('https://git*hub.com'));
});

test('grants: item wildcard, expiry', () => {
  const now = Date.now();
  const policy = { grants: [
    { vault: 'v', item: '*', origins: ['https://*.corp.test'], allow_submit: true },
    { vault: 'v', item: 'a', origins: ['https://a.test'], allow_submit: true, expires_at: new Date(now - 1000).toISOString() },
  ] };
  assert.ok(findGrant(policy, { vault: 'v', itemId: 'anything', origin: 'https://x.corp.test' }));
  assert.ok(!findGrant(policy, { vault: 'other', itemId: 'anything', origin: 'https://x.corp.test' }));
  assert.ok(!findGrant(policy, { vault: 'v', itemId: 'a', origin: 'https://a.test' }), 'expired grant ignored');
});

test('totp RFC 6238 vector', () => {
  const secret = 'GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ';
  assert.equal(totp(secret, 59_000), '287082');
  assert.equal(totp(`otpauth://totp/x?secret=${secret}&digits=8`, 59_000), '94287082');
});
