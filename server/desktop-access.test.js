'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { createDesktopAccessGuard, SESSION_HEADER } = require('./desktop-access');

const token = 'a'.repeat(64);
const guard = createDesktopAccessGuard(token);

function request(overrides = {}, socket = {}) {
  let accepted = false;
  const result = { statusCode: 200, headers: {}, body: null };
  const res = {
    status(code) { result.statusCode = code; return this; },
    json(body) { result.body = body; return this; },
    setHeader(name, value) { result.headers[name] = value; },
  };
  guard({
    headers: { host: '127.0.0.1:43127', [SESSION_HEADER]: token, ...overrides },
    socket: { localPort: 43127, ...socket },
  }, res, () => { accepted = true; });
  return { ...result, accepted };
}

test('desktop requests require their launch capability even on loopback', () => {
  for (const value of [undefined, '', 'a'.repeat(63), 'b'.repeat(64), [token, token]]) {
    const result = request({ [SESSION_HEADER]: value });
    assert.equal(result.statusCode, 403);
    assert.equal(result.accepted, false);
    assert.equal(JSON.stringify(result).includes(token), false);
  }
  assert.throws(() => createDesktopAccessGuard(''), /strong desktop session token/);
  assert.throws(() => createDesktopAccessGuard('weak'), /strong desktop session token/);
});

test('desktop requests reject DNS rebinding, unrelated origins and cross-site requests', () => {
  for (const host of ['localhost:43127', 'attacker.example:43127', '127.0.0.1:80', undefined])
    assert.equal(request({ host }).statusCode, 403);
  for (const origin of ['null', 'https://attacker.example', 'http://127.0.0.1:43128'])
    assert.equal(request({ origin }).statusCode, 403);
  assert.equal(request({ 'sec-fetch-site': 'cross-site' }).statusCode, 403);
  assert.equal(request({ host: 'attacker.example', 'x-forwarded-host': '127.0.0.1:43127' }).statusCode, 403);
});

test('authorized requests receive an isolated content policy and no caching', () => {
  for (const origin of [undefined, 'http://127.0.0.1:43127']) {
    const result = request({ origin });
    assert.equal(result.accepted, true);
    assert.equal(result.headers['Cache-Control'], 'no-store');
    assert.match(result.headers['Content-Security-Policy'], /script-src 'self';/);
    assert.match(result.headers['Content-Security-Policy'], /connect-src 'self';/);
    assert.match(result.headers['Content-Security-Policy'], /frame-ancestors 'none'/);
    assert.equal(result.headers['X-Content-Type-Options'], 'nosniff');
    assert.equal(result.headers['Referrer-Policy'], 'no-referrer');
  }
});
