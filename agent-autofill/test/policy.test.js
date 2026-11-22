import assert from 'node:assert/strict';
import test from 'node:test';
import { findGrant, matchingGrants, originMatches, parsePattern } from '../src/policy.js';
import { totp } from '../src/totp.js';
import { generatePassword } from '../src/password.js';

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

test('generated passwords', () => {
  for (let i = 0; i < 200; i++) {
    const p = generatePassword();
    assert.equal(p.length, 20);
    assert.match(p, /[a-z]/); assert.match(p, /[A-Z]/); assert.match(p, /[0-9]/); assert.match(p, /[!@#$%^&*\-_=+?]/);
  }
  assert.doesNotMatch(generatePassword({ symbols: false, length: 30 }), /[^a-zA-Z0-9]/);
  assert.equal(generatePassword({ length: 4 }).length, 12, 'minimum length enforced');
  assert.match(generatePassword({ symbol_set: '#' }), /#/);
});

test('signup grants are separate from login grants', async () => {
  const { findGrant: fg } = await import('../src/policy.js');
  const policy = { grants: [{ vault: 'v', item: 'x', origins: ['*'] }, { kind: 'signup', vault: 'v', item: 'id1', origins: ['https://a.test'] }] };
  assert.ok(fg(policy, { vault: 'v', itemId: 'x', origin: 'https://a.test' }));
  assert.ok(!fg(policy, { vault: 'v', itemId: 'x', origin: 'https://a.test', kind: 'signup' }));
  assert.ok(fg(policy, { vault: 'v', itemId: 'id1', origin: 'https://a.test', kind: 'signup' }));
  assert.ok(!fg(policy, { vault: 'v', itemId: 'id1', origin: 'https://a.test' }));
});

test('visible-secret approvals never merge with ordinary ones', async () => {
  const { addGrant, matchingGrants } = await import('../src/policy.js');
  const policy = { grants: [] };
  addGrant(policy, { vault: 'v', item: 'x', origins: ['https://a.test'], allow_submit: true });
  addGrant(policy, { vault: 'v', item: 'x', origins: ['https://b.test'], allow_submit: true, allow_visible_secrets: true });
  addGrant(policy, { vault: 'v', item: 'x', origins: ['https://c.test'], allow_submit: true });
  assert.equal(policy.grants.length, 2);
  assert.deepEqual(policy.grants[0].origins, ['https://a.test', 'https://c.test']);
  assert.ok(!matchingGrants(policy, { vault: 'v', itemId: 'x', origin: 'https://a.test' }).some((g) => g.allow_visible_secrets));
  assert.ok(matchingGrants(policy, { vault: 'v', itemId: 'x', origin: 'https://b.test' }).some((g) => g.allow_visible_secrets));
});

test('card grants: exact sites and one card only, even when written by hand', () => {
  const policy = { grants: [
    { kind: 'card', vault: 'v', item: 'c1', origins: ['https://shop.example'], allow_submit: false },
    { kind: 'card', vault: 'v', item: 'c1', origins: ['https://*.example'], allow_submit: true },
    { kind: 'card', vault: 'v', item: '*', origins: ['https://other.example'], allow_submit: true },
    { kind: 'identity', vault: 'v', item: 'p1', origins: ['https://*.example'] },
  ] };
  assert.ok(findGrant(policy, { vault: 'v', itemId: 'c1', origin: 'https://shop.example', kind: 'card' }));
  assert.equal(matchingGrants(policy, { vault: 'v', itemId: 'c1', origin: 'https://shop.example', kind: 'card' }).length, 1, 'wildcard card grant ignored');
  assert.equal(findGrant(policy, { vault: 'v', itemId: 'c1', origin: 'https://other.example', kind: 'card' }), undefined, 'item "*" card grant ignored');
  assert.equal(findGrant(policy, { vault: 'v', itemId: 'c1', origin: 'https://shop.example' }), undefined, 'a card grant is not a login grant');
  assert.ok(findGrant(policy, { vault: 'v', itemId: 'p1', origin: 'https://a.example', kind: 'identity' }), 'identity details grants may use wildcards');
});
