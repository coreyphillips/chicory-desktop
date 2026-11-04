'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { after, test } = require('node:test');
const { AppLock, installLockIpc, LOCK_FILE, REVEAL_GRANT_MS } = require('./app-lock.cjs');

const directories = [];
after(() => { for (const directory of directories) fs.rmSync(directory, { recursive: true, force: true }); });
function profile() {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'chicory-lock-'));
  directories.push(directory);
  return directory;
}

function authenticator(answers = [], kind = 'fingerprint') {
  const calls = [];
  return {
    calls,
    kind,
    async availability() { return { kind: this.kind }; },
    async authenticate(purpose) {
      calls.push(purpose);
      const answer = answers.length ? answers.shift() : { ok: true };
      return typeof answer === 'function' ? answer() : answer;
    },
  };
}

function harness({ answers, kind, enabled, raw, graceMs = 30000 } = {}) {
  const directory = profile();
  if (enabled !== undefined) fs.writeFileSync(path.join(directory, LOCK_FILE), JSON.stringify({ version: 1, enabled }));
  if (raw !== undefined) fs.writeFileSync(path.join(directory, LOCK_FILE), raw);
  let clock = 1000;
  const events = [];
  const auth = authenticator(answers, kind);
  const lock = new AppLock({ profile: directory, authenticator: auth, now: () => clock, graceMs, settleMs: 0,
    onEvent: (name, value) => events.push([name, value]), timers: { setTimeout: () => {}, clearTimeout: () => {} } });
  return { lock, auth, events, directory, advance: ms => { clock += ms; }, saved: () => {
    try { return JSON.parse(fs.readFileSync(path.join(directory, LOCK_FILE), 'utf8')); } catch { return null; }
  } };
}

test('enabling persists only after system authentication succeeds', async () => {
  const cancelled = harness({ answers: [{ ok: false, reason: 'cancelled' }] });
  const refused = await cancelled.lock.setEnabled(true);
  assert.equal(refused.ok, false);
  assert.match(refused.error, /cancelled.*not changed/);
  assert.equal(cancelled.saved(), null, 'a cancelled prompt writes nothing');
  assert.equal(cancelled.lock.enabled, false);

  const turnedOff = harness({ enabled: false, answers: [{ ok: false, reason: 'failed' }] });
  assert.equal((await turnedOff.lock.setEnabled(true)).ok, false);
  assert.deepEqual(turnedOff.saved(), { version: 1, enabled: false }, 'a failed prompt keeps the previous setting');

  const accepted = harness();
  assert.deepEqual(await accepted.lock.setEnabled(true), { ok: true });
  assert.deepEqual(accepted.auth.calls, ['enable']);
  assert.deepEqual(accepted.saved(), { version: 1, enabled: true });
  assert.equal(accepted.lock.required(), false, 'the person who just authenticated stays in');
  assert.deepEqual(accepted.events.at(-1), ['changed', true]);
});

test('a cold launch with the lock on admits no wallet route until authentication succeeds', async () => {
  const { lock, auth } = harness({ enabled: true, answers: [{ ok: false, reason: 'cancelled' }, { ok: true }] });
  assert.equal(lock.required(), true);
  for (const route of ['/api/wallets', '/api/wallets/a/start', '/wallets/a/api/send', '/api/settings'])
    assert.equal(lock.admit(route).ok, false, route);
  assert.deepEqual(lock.admit('/assets/index.js'), { ok: true, ticket: null }, 'the interface itself still loads');
  const cancelled = await lock.unlock();
  assert.equal(cancelled.reason, 'cancelled');
  assert.match(cancelled.error, /stays locked/);
  assert.equal(lock.admit('/api/wallets').ok, false);
  assert.deepEqual(await lock.unlock(), { ok: true });
  assert.equal(lock.admit('/api/wallets').ok, true);
  assert.deepEqual(auth.calls, ['unlock', 'unlock']);
});

test('concurrent unlock requests share one system prompt', async () => {
  let release;
  const { lock, auth } = harness({ enabled: true, answers: [() => new Promise(resolve => { release = resolve; })] });
  const first = lock.unlock();
  const second = lock.unlock();
  await new Promise(setImmediate);
  release({ ok: true });
  assert.deepEqual(await Promise.all([first, second]), [{ ok: true }, { ok: true }]);
  assert.equal(auth.calls.length, 1);
});

test('corrupt, unreadable or linked lock metadata fails closed and is repaired by a successful unlock', async (t) => {
  for (const raw of ['{', '{"version":2,"enabled":false}', '{"version":1,"enabled":"no"}', 'x'.repeat(5000), '']) {
    const { lock, saved } = harness({ raw });
    assert.equal(lock.required(), true, `metadata ${JSON.stringify(raw.slice(0, 20))} keeps the gate shut`);
    assert.equal((await lock.state()).repair, true);
    assert.equal((await lock.setEnabled(false)).ok, false, 'locked metadata cannot be turned off from the renderer');
    assert.deepEqual(await lock.unlock(), { ok: true });
    assert.deepEqual(saved(), { version: 1, enabled: true });
  }
  if (process.platform !== 'win32') {
    const { directory } = harness();
    const target = path.join(directory, 'elsewhere.json');
    fs.writeFileSync(target, JSON.stringify({ version: 1, enabled: false }));
    fs.symlinkSync(target, path.join(directory, LOCK_FILE));
    const linked = new AppLock({ profile: directory, authenticator: authenticator() });
    assert.equal(linked.required(), true, 'a symbolic link is not trusted to turn the lock off');
  } else t.diagnostic('symbolic link case skipped on Windows');
});

test('unavailable authentication or changed enrollment never bypasses an enabled gate', async () => {
  const gone = harness({ enabled: true, kind: null, answers: [{ ok: false, reason: 'unavailable' }] });
  const result = await gone.lock.unlock();
  assert.equal(result.ok, false);
  assert.match(result.error, /unavailable.*stays locked/);
  assert.equal(gone.lock.required(), true);
  assert.deepEqual(gone.auth.calls, ['unlock'], 'the system prompt is still tried, so a password fallback can answer');

  const thrown = harness({ enabled: true, answers: [() => { throw new Error('LAContext failure'); }] });
  assert.equal((await thrown.lock.unlock()).reason, 'failed');
  assert.equal(thrown.lock.required(), true);

  // Enrollment changed between launches: the OS proves presence again with
  // the new finger or the account password, and nothing else opens it.
  const changed = harness({ enabled: true, kind: 'passcode' });
  assert.deepEqual(await changed.lock.unlock(), { ok: true });
  assert.deepEqual(changed.auth.calls, ['unlock']);

  const none = harness({ kind: null });
  assert.equal((await none.lock.state()).kind, null);
  const refused = await none.lock.setEnabled(true);
  assert.match(refused.error, /unavailable/);
  assert.deepEqual(none.auth.calls, [], 'an unsupported computer is never prompted');
});

test('a recovery phrase needs fresh authentication for exactly one request', async () => {
  const route = '/api/wallets/abc/recovery-phrase';
  const { lock, auth, advance } = harness({ enabled: true, answers: [{ ok: true }, { ok: false, reason: 'cancelled' }] });
  assert.equal(lock.admit(route).ok, false);
  await lock.unlock();
  assert.equal(lock.admit(route).ok, false, 'being unlocked is not enough');
  assert.equal(lock.admit('/api/backup/export').ok, false, 'a full backup carries every phrase');
  assert.equal((await lock.authorizeSecret()).ok, false, 'a cancelled prompt grants nothing');
  assert.equal(lock.admit(route).ok, false);
  assert.deepEqual(await lock.authorizeSecret(), { ok: true });
  assert.equal(lock.admit(route).ok, true);
  assert.equal(lock.admit(route).ok, false, 'one grant, one request');

  await lock.authorizeSecret();
  advance(REVEAL_GRANT_MS + 1);
  assert.equal(lock.admit(route).ok, false, 'a grant expires');

  await lock.authorizeSecret();
  lock.background('blur');
  assert.equal(lock.admit(route).ok, false, 'losing the foreground voids a grant');
  assert.deepEqual(auth.calls, ['unlock', 'reveal', 'reveal', 'reveal', 'reveal']);

  for (const other of ['/api/wallets/abc/RECOVERY-PHRASE', '/api/Wallets/abc/Recovery-Phrase/', '/api/BACKUP/export',
    '/wallets/abc/api/mnemonic', '/wallets/abc/API/Mnemonic/']) {
    assert.equal(lock.admit(other).ok, false, `${other} needs a grant like the canonical route`);
    await lock.authorizeSecret();
    assert.equal(lock.admit(other).ok, true, other);
  }

  const off = harness();
  assert.equal(off.lock.admit(route).ok, true, 'with the lock off the phrase follows the existing local authorization');
  assert.deepEqual(await off.lock.authorizeSecret(), { ok: true });
  assert.deepEqual(off.auth.calls, []);
  const pending = off.lock.admit(route).ticket;
  off.lock.background('blur');
  assert.equal(pending.signal.aborted, true, 'with the lock off a phrase in flight is still dropped on blur');
  assert.equal(off.lock.current(pending), false);
});

test('a screen lock or suspend during the unlock prompt outranks its answer', async () => {
  const handlers = new Map();
  let release;
  const { lock } = harness({ enabled: true, answers: [() => new Promise(resolve => { release = resolve; })] });
  let started = 0;
  installLockIpc({ ipcMain: { handle: (channel, handler) => handlers.set(channel, handler) }, appLock: lock,
    trusted: () => true, ensureManager: async () => { started++; } });
  const unlocking = handlers.get('lock:unlock')({});
  await new Promise(setImmediate);
  lock.conceal('suspend');
  lock.relock('suspend');
  release({ ok: true });
  const result = await unlocking;
  assert.equal(result.ok, false);
  assert.match(result.error, /locked again/);
  assert.equal(lock.required(), true);
  assert.equal(started, 0, 'no key or engine is released');
});

test('payment and recovery responses that arrive after a relock are discarded', async () => {
  const { lock, events } = harness({ enabled: true });
  await lock.unlock();
  const payment = lock.admit('/wallets/abc/api/send').ticket;
  await lock.authorizeSecret();
  const phrase = lock.admit('/api/wallets/abc/recovery-phrase').ticket;
  assert.equal(lock.current(payment), true);
  lock.conceal('lock-screen');
  assert.equal(phrase.signal.aborted, true, 'a phrase in flight is cancelled when the screen is concealed');
  assert.equal(lock.current(phrase), false);
  assert.equal(lock.current(payment), true, 'concealing alone does not drop a payment');
  lock.relock('lock-screen');
  assert.equal(payment.signal.aborted, true);
  assert.equal(lock.current(payment), false);
  await lock.unlock();
  assert.equal(lock.current(payment), false, 'unlocking again does not revive an earlier response');
  assert.equal(lock.current(lock.admit('/wallets/abc/api/send').ticket), true);
  assert.deepEqual(events.filter(([name]) => name === 'locked'), [['locked', 'lock-screen']]);
});

test('the background grace period relocks, and Chicory\'s own prompts do not start it', async () => {
  const { lock, events, advance, auth } = harness({ enabled: true, graceMs: 30000 });
  await lock.unlock();
  lock.background('blur');
  advance(29000);
  lock.foreground();
  assert.equal(lock.required(), false, 'a short trip away stays unlocked');
  lock.background('blur');
  advance(30001);
  lock.foreground();
  assert.equal(lock.required(), true);
  assert.deepEqual(events.filter(([name]) => name === 'locked'), [['locked', 'grace']]);

  // Only a native focus ends the time away, not an unlock call from the renderer.
  const early = harness({ enabled: true });
  await early.lock.unlock();
  early.lock.background('blur');
  early.advance(29000);
  assert.deepEqual(await early.lock.unlock(), { ok: true });
  early.advance(60000);
  early.lock.foreground();
  assert.equal(early.lock.required(), true);
  const late = harness({ enabled: true });
  await late.lock.unlock();
  late.lock.background('blur');
  late.advance(30001);
  await late.lock.unlock();
  assert.deepEqual(late.auth.calls, ['unlock', 'unlock'], 'an unlock call after the grace period prompts again');

  // A long prompt raised by Chicory blurs the window. That blur neither
  // conceals nor starts the clock, so its own focus return does not relock.
  let release;
  auth.calls.length = 0;
  const slow = harness({ enabled: true, answers: [() => new Promise(resolve => { release = resolve; })] });
  const unlocking = slow.lock.unlock();
  await new Promise(setImmediate);
  slow.lock.background('blur');
  slow.advance(120000);
  release({ ok: true });
  await unlocking;
  slow.lock.foreground();
  assert.equal(slow.lock.required(), false);
  assert.equal(slow.events.filter(([name]) => name === 'conceal').length, 0);
  assert.equal(slow.auth.calls.length, 1, 'no second prompt follows the first');

  const permission = harness({ enabled: true });
  await permission.lock.unlock();
  await permission.lock.duringPrompt(async () => { permission.lock.background('blur'); permission.advance(60000); });
  permission.lock.foreground();
  assert.equal(permission.lock.required(), false, 'a camera or clipboard prompt does not relock');
});

test('screen lock and suspend relock and conceal even inside the grace period', async () => {
  const { lock, events } = harness({ enabled: true });
  await lock.unlock();
  lock.conceal('suspend');
  lock.relock('suspend');
  assert.equal(lock.required(), true);
  assert.deepEqual(events.slice(-2), [['conceal', 'suspend'], ['locked', 'suspend']]);
  const off = harness();
  off.lock.conceal('lock-screen');
  off.lock.relock('lock-screen');
  assert.equal(off.lock.required(), false, 'with the lock off nothing relocks');
  assert.deepEqual(off.events, [['conceal', 'lock-screen']], 'shown words are still cleared');
});

test('forged renderer IPC cannot open the gate or change the setting', async () => {
  const handlers = new Map();
  const ipcMain = { handle: (channel, handler) => handlers.set(channel, handler) };
  const { lock, auth } = harness({ enabled: true, answers: [{ ok: false, reason: 'cancelled' }, { ok: true }] });
  let started = 0;
  const main = { id: 'main' };
  installLockIpc({ ipcMain, appLock: lock, trusted: event => event.frame === main, ensureManager: async () => { started++; } });
  assert.deepEqual([...handlers.keys()].sort(), ['lock:authorize', 'lock:set-enabled', 'lock:state', 'lock:unlock']);

  const forged = { frame: { id: 'subframe' } };
  for (const channel of handlers.keys()) assert.equal((await handlers.get(channel)(forged, false)).reason, 'refused', channel);
  assert.deepEqual(auth.calls, [], 'a forged sender never raises a prompt');

  const trusted = { frame: main };
  assert.equal((await handlers.get('lock:unlock')(trusted, { ok: true }, true)).ok, false, 'renderer arguments cannot claim success');
  assert.equal(started, 0, 'no key or engine is released after a cancelled prompt');
  for (const value of ['false', 0, null, undefined, { enabled: false }])
    assert.equal((await handlers.get('lock:set-enabled')(trusted, value)).ok, false);
  assert.equal(lock.enabled, true);
  assert.equal((await handlers.get('lock:set-enabled')(trusted, false)).ok, false, 'a locked app cannot turn its lock off');
  assert.equal((await handlers.get('lock:authorize')(trusted)).ok, false, 'a locked app cannot authorize a reveal');
  assert.equal(lock.admit('/api/wallets').ok, false);

  assert.deepEqual(await handlers.get('lock:unlock')(trusted), { ok: true });
  assert.equal(started, 1, 'the manager starts only after the gate opens');
  assert.deepEqual(await handlers.get('lock:state')(trusted), { enabled: true, locked: false, kind: 'fingerprint', repair: false });
});
