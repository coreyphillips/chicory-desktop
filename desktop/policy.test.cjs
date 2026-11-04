'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const fs = require('node:fs');
const vm = require('node:vm');
const { EventEmitter } = require('node:events');
const {
  APP_URL, CSP, isAppURL, isPaymentLink, isExternalURL,
  staticPath, managerHeaders, windowBounds,
} = require('./policy.cjs');

test('application URLs stay within the single persistent custom origin', () => {
  for (const url of [APP_URL, 'chicory-app://wallet', 'chicory-app://wallet/assets/app.js', 'chicory-app://wallet/?demo'])
    assert.equal(isAppURL(url), true, url);
  for (const url of [
    'https://wallet/', 'http://127.0.0.1:3100', 'file:///tmp/index.html',
    'chicory-app://wallet.evil/', 'chicory-app://wallet:1234/',
    'chicory-app://name@wallet/', 'chicory-app://wallet@evil/',
    'chicory-app://wallet./', 'chicory-app:///wallet/', 'data:text/html,hello', null,
  ]) assert.equal(isAppURL(url), false, String(url));
});

test('external links accept only HTTPS destinations on the explicit allowlist', () => {
  for (const url of [
    'https://github.com/coreyphillips/chicory-desktop',
    'https://mempool.space/tx/abcdef', 'https://blockstream.info/testnet/tx/abcdef',
  ]) assert.equal(isExternalURL(url), true, url);
  for (const url of [
    'http://github.com/', 'https://github.com.evil/', 'https://evil/github.com',
    'https://github.com:8443/', 'https://user:secret@github.com/',
    'https://127.0.0.1/', 'file:///Applications/Calculator.app',
    'javascript:alert(1)', 'mailto:person@example.com', 'chicory-app://wallet/',
  ]) assert.equal(isExternalURL(url), false, url);
});

test('payment links are bounded and cannot carry control characters or other protocols', () => {
  assert.equal(isPaymentLink('bitcoin:bc1example?amount=0.001'), true);
  assert.equal(isPaymentLink('LIGHTNING:lnbcexample'), true);
  assert.equal(isPaymentLink(`bitcoin:${'a'.repeat(16376)}`), true);
  for (const value of [
    '', 'bitcoin:', 'https://example.com', 'lightning:invoice\n',
    'bitcoin:address\u0000', 'bitcoin:address\u007f', 'bitcoin:one two',
    ' bitcoin:address', `bitcoin:${'a'.repeat(16377)}`, null, {},
  ]) assert.equal(isPaymentLink(value), false, String(value));
});

test('demo assets cannot escape the generated build directory', () => {
  const root = path.resolve('/tmp/chicory-build');
  assert.equal(staticPath(root, '/'), path.join(root, 'index.html'));
  assert.equal(staticPath(root, '/assets/app.js'), path.join(root, 'assets/app.js'));
  for (const pathname of [
    '/../secret', '/%2e%2e/secret', '/%2e%2e/chicory-build-other/secret',
    '/assets/../../secret', '/%00', '/assets%5c..%5csecret', '/%zz',
  ]) assert.equal(staticPath(root, pathname), null, pathname);
});

test('manager transport discards spoofed credentials and forwarding headers', () => {
  const incoming = new Headers({
    Accept: 'application/json', 'Content-Type': 'application/json',
    Authorization: 'Bearer attacker', Cookie: 'session=attacker',
    Origin: 'https://evil.example', Host: 'evil.example',
    'X-Chicory-Session': 'attacker', 'X-Forwarded-Host': 'evil.example',
    'X-Forwarded-For': '127.0.0.1', 'Content-Length': '9999',
  });
  const headers = managerHeaders(incoming, 'private-capability', 'http://127.0.0.1:43127');
  assert.deepEqual([...headers.keys()].sort(), ['accept', 'content-type', 'origin', 'x-chicory-session']);
  assert.equal(headers.get('accept'), 'application/json');
  assert.equal(headers.get('content-type'), 'application/json');
  assert.equal(headers.get('origin'), 'http://127.0.0.1:43127');
  assert.equal(headers.get('x-chicory-session'), 'private-capability');
  assert.equal(incoming.get('x-chicory-session'), 'attacker');
});

test('content policy forbids external scripts, eval, frames and form submission', () => {
  const directives = new Map(CSP.split(';').map(part => {
    const [key, ...values] = part.trim().split(/\s+/);
    return [key, values];
  }));
  assert.deepEqual(directives.get('script-src'), ["'self'"]);
  assert.deepEqual(directives.get('connect-src'), ["'self'"]);
  for (const key of ['object-src', 'base-uri', 'frame-src', 'frame-ancestors', 'form-action'])
    assert.deepEqual(directives.get(key), ["'none'"]);
});

test('window placement rejects disconnected displays and keeps valid negative coordinates', () => {
  const displays = [
    { workArea: { x: 0, y: 24, width: 1920, height: 1056 } },
    { workArea: { x: -1920, y: 24, width: 1920, height: 1056 } },
  ];
  assert.deepEqual(windowBounds({ x: -1800, y: 40, width: 1200, height: 800 }, displays),
    { x: -1800, y: 40, width: 1200, height: 800 });
  const defaults = windowBounds(null, displays);
  assert.deepEqual(windowBounds({ x: 9000, y: 40, width: 1200, height: 800 }, displays), defaults);
  assert.deepEqual(windowBounds({ x: NaN, y: 40, width: 1200, height: 800 }, displays), defaults);
  assert.deepEqual(windowBounds({ x: 1800, y: 900, width: 1800, height: 1000 }, displays),
    { x: 120, y: 80, width: 1800, height: 1000 });
});

test('initial and restored windows fit small display work areas', () => {
  const displays = [{ workArea: { x: 0, y: 24, width: 800, height: 576 } }];
  assert.deepEqual(windowBounds(null, displays), { width: 800, height: 576 });
  assert.deepEqual(windowBounds({ x: 100, y: 40, width: 1320, height: 860 }, displays),
    { x: 0, y: 24, width: 800, height: 576 });
  assert.deepEqual(windowBounds({ x: 100, y: 40, width: -1, height: 860 }, displays),
    { width: 800, height: 576 });
  const laptop = [{ workArea: { x: 0, y: 24, width: 1280, height: 696 } }];
  assert.deepEqual(windowBounds(null, laptop), { width: 1280, height: 696 });
});

test('preload exposes only window commands, the lock bridge, and strips IPC events from subscriptions', () => {
  const emitter = new EventEmitter();
  const sent = [];
  let api;
  const ipc = Object.assign(emitter, { send: (...args) => sent.push(args) });
  const context = {
    process: { platform: 'darwin' },
    require(name) {
      assert.equal(name, 'electron');
      return {
        ipcRenderer: ipc,
        contextBridge: { exposeInMainWorld(name, value) {
          assert.equal(name, 'chicoryDesktop'); api = value;
        } },
      };
    },
  };
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, 'preload.cjs'), 'utf8'), context);
  assert.deepEqual(Object.keys(api).sort(), ['close', 'lock', 'minimize', 'onCommand', 'platform', 'toggleMaximize', 'version']);
  assert.equal(Object.isFrozen(api), true);
  api.minimize(); api.toggleMaximize(); api.close();
  assert.deepEqual(sent, [['window:minimize'], ['window:maximize'], ['window:close']]);
  const received = [];
  const unsubscribe = api.onCommand((...args) => received.push(args));
  const privilegedEvent = { sender: { secret: 'not-for-renderer' } };
  emitter.emit('desktop:command', privilegedEvent, 'payment-link', 'lightning:invoice');
  emitter.emit('desktop:command', privilegedEvent, 'arbitrary-command', 'ignored');
  emitter.emit('desktop:command', privilegedEvent, 'home', privilegedEvent);
  assert.deepEqual(received, [['payment-link', 'lightning:invoice'], ['home', undefined]]);
  unsubscribe();
  emitter.emit('desktop:command', privilegedEvent, 'send');
  assert.equal(received.length, 2);
  assert.equal(emitter.listenerCount('desktop:command'), 0);

  // The lock bridge can only ask the main process to prompt.
  const invoked = [];
  ipc.invoke = async (...args) => { invoked.push(args); return { ok: false }; };
  assert.deepEqual(Object.keys(api.lock).sort(), ['authorize', 'onEvent', 'setEnabled', 'state', 'unlock']);
  assert.equal(Object.isFrozen(api.lock), true);
  api.lock.state(); api.lock.unlock({ ok: true }); api.lock.authorize('anything');
  api.lock.setEnabled('false'); api.lock.setEnabled({ enabled: true }); api.lock.setEnabled(true);
  assert.deepEqual(invoked, [['lock:state'], ['lock:unlock'], ['lock:authorize'],
    ['lock:set-enabled', false], ['lock:set-enabled', false], ['lock:set-enabled', true]]);
  const lockEvents = [];
  const stop = api.lock.onEvent((...args) => lockEvents.push(args));
  emitter.emit('desktop:lock', privilegedEvent, 'locked', 'suspend');
  emitter.emit('desktop:lock', privilegedEvent, 'unlock-now', true);
  emitter.emit('desktop:lock', privilegedEvent, 'conceal', privilegedEvent);
  assert.deepEqual(lockEvents, [['locked', 'suspend'], ['conceal', undefined]]);
  stop();
  assert.equal(emitter.listenerCount('desktop:lock'), 0);
});
