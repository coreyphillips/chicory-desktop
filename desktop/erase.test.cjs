'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { test } = require('node:test');
const { ERASE_MARKER, ProfileEraser, eraseProfileData, hasPendingErase } = require('./erase.cjs');
const { AppLock } = require('./app-lock.cjs');

function temporary(t, prefix = 'chicory-erase-') {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  return directory;
}

function write(root, relative, text = 'x') {
  fs.mkdirSync(path.dirname(path.join(root, relative)), { recursive: true });
  fs.writeFileSync(path.join(root, relative), text);
}

/** A profile holding wallets on several networks, with everything an erase must leave alone. */
function populated(t) {
  const profile = temporary(t);
  write(profile, 'storage-key.json', '{"version":1}');
  for (const id of ['mainnet-a', 'mainnet-b', 'testnet-c', 'regtest-d']) {
    write(profile, `wallets/wallets/${id}/secrets/mnemonic`, 'encrypted');
    write(profile, `wallets/wallets/${id}/data/node.db`, 'encrypted');
    write(profile, `wallets/wallets/${id}/data/node.db-journal`, 'encrypted');
  }
  write(profile, 'wallets/registry.json', 'encrypted');
  write(profile, 'wallets/settings.json', 'encrypted');
  write(profile, 'wallets/.vault-v1', '{"version":1}');
  write(profile, 'tor/cached-microdescs', 'cache');
  write(profile, 'updates/Chicory-0.3.0-mac-arm64.dmg.partial', 'partial');
  write(profile, 'app-lock.json', '{"version":1,"enabled":true}');
  write(profile, 'diagnostics.json', '{}');
  write(profile, 'window-state.json', '{}');
  return profile;
}

function eraser(profile, overrides = {}) {
  const calls = [];
  const log = [];
  const instance = new ProfileEraser({
    profile,
    authorize: () => true,
    stopService: async () => { calls.push('stopService'); return 'exited'; },
    stopTor: async () => { calls.push('stopTor'); },
    clearRendererState: async () => { calls.push('clearRendererState'); },
    startOver: async () => { calls.push('startOver'); },
    record: line => log.push(line),
    ...overrides,
  });
  return { instance, calls, log };
}

test('erase removes every wallet, the storage key, Tor state and staged updates, and nothing else', async t => {
  const profile = populated(t);
  const { instance, calls } = eraser(profile);
  const result = await instance.erase();
  assert.equal(result.ok, true);
  for (const gone of ['storage-key.json', 'wallets', 'tor', 'updates', ERASE_MARKER])
    assert.equal(fs.existsSync(path.join(profile, gone)), false, gone);
  for (const kept of ['app-lock.json', 'diagnostics.json', 'window-state.json'])
    assert.equal(fs.existsSync(path.join(profile, kept)), true, kept);
  assert.deepEqual(calls, ['stopService', 'stopTor', 'clearRendererState', 'startOver']);
});

test('symbolic links are removed as links and never followed out of the profile', async t => {
  const profile = temporary(t);
  const outside = temporary(t, 'chicory-outside-');
  write(outside, 'mobile/wallet.db', 'not ours');
  write(outside, 'umbrel/registry.json', 'not ours');
  write(outside, 'backup.chicory', 'an external backup');
  fs.symlinkSync(path.join(outside, 'mobile'), path.join(profile, 'wallets'));
  fs.mkdirSync(path.join(profile, 'tor'));
  fs.symlinkSync(path.join(outside, 'umbrel'), path.join(profile, 'tor', 'linked'));
  fs.symlinkSync(path.join(outside, 'backup.chicory'), path.join(profile, 'storage-key.json'));
  const { removed, failed } = eraseProfileData(profile);
  assert.deepEqual(failed, []);
  assert.deepEqual(removed.sort(), ['storage-key.json', 'tor', 'wallets']);
  assert.equal(fs.readFileSync(path.join(outside, 'mobile/wallet.db'), 'utf8'), 'not ours');
  assert.equal(fs.readFileSync(path.join(outside, 'umbrel/registry.json'), 'utf8'), 'not ours');
  assert.equal(fs.readFileSync(path.join(outside, 'backup.chicory'), 'utf8'), 'an external backup');
});

test('a failed deletion keeps the marker, says so, and does not start over', async t => {
  const profile = populated(t);
  const io = { ...fs, rmSync(target, options) {
    if (path.basename(target) === 'wallets') throw Object.assign(new Error('busy'), { code: 'EBUSY' });
    return fs.rmSync(target, options);
  } };
  const { instance, calls } = eraser(profile, { io });
  const result = await instance.erase();
  assert.equal(result.ok, false);
  assert.equal(result.code, 'ERASE_INCOMPLETE');
  assert.deepEqual(result.failed, [{ entry: 'wallets', code: 'EBUSY' }]);
  assert.match(result.error, /did not finish/);
  assert.equal(fs.existsSync(path.join(profile, 'storage-key.json')), false, 'the key is gone first, so what is left is unreadable');
  assert.equal(hasPendingErase(profile), true, 'the next launch finishes the erase before opening anything');
  assert.deepEqual(calls, ['stopService', 'stopTor'], 'renderer state and a fresh wallet service wait for a complete erase');

  // The retry, or the next launch, completes it.
  const retry = eraser(profile);
  assert.equal((await retry.instance.erase()).ok, true);
  assert.equal(fs.existsSync(path.join(profile, 'wallets')), false);
  assert.equal(hasPendingErase(profile), false);
});

test('an interrupted erase is finished from the marker without a running service', async t => {
  const profile = populated(t);
  fs.writeFileSync(path.join(profile, ERASE_MARKER), 'interrupted, possibly half written');
  assert.equal(hasPendingErase(profile), true);
  const { instance, calls } = eraser(profile);
  const result = await instance.resume();
  assert.equal(result.ok, true);
  assert.equal(fs.existsSync(path.join(profile, 'wallets')), false);
  assert.equal(hasPendingErase(profile), false);
  assert.deepEqual(calls, ['clearRendererState'], 'startup goes on to open a fresh profile itself');
});

test('nothing is deleted when an engine did not stop cleanly', async t => {
  for (const outcome of ['timeout', 'failed']) {
    const profile = populated(t);
    const { instance, calls } = eraser(profile, { stopService: async () => { calls.push('stopService'); return outcome; } });
    const result = await instance.erase();
    assert.equal(result.code, 'ERASE_ENGINES', outcome);
    assert.equal(fs.existsSync(path.join(profile, 'storage-key.json')), true);
    assert.equal(fs.existsSync(path.join(profile, 'wallets/registry.json')), true);
    assert.equal(hasPendingErase(profile), false, 'no marker, so nothing claims an erase that did not begin');
    assert.deepEqual(calls, ['stopService']);
  }
});

test('erase needs the lock grant and an idle storage gate before it touches anything', async t => {
  const profile = populated(t);
  const refused = eraser(profile, { authorize: () => false });
  assert.equal((await refused.instance.erase()).code, 'ERASE_LOCKED');
  const busy = eraser(profile, { busy: () => true });
  assert.equal((await busy.instance.erase()).code, 'ERASE_BUSY');
  assert.deepEqual([...refused.calls, ...busy.calls], []);
  assert.equal(fs.existsSync(path.join(profile, 'storage-key.json')), true);
});

test('the erase holds the storage gate, and starts over only once it is released', async t => {
  const profile = populated(t);
  let held = false;
  const order = [];
  const { instance } = eraser(profile, {
    exclusive: async task => { held = true; order.push('gate taken'); try { return await task(); } finally { held = false; order.push('gate released'); } },
    stopService: async () => { order.push(`stop while held=${held}`); return 'exited'; },
    startOver: async () => { order.push(`start over while held=${held}`); },
  });
  assert.equal((await instance.erase()).ok, true);
  assert.deepEqual(order, ['gate taken', 'stop while held=true', 'gate released', 'start over while held=false']);
});

test('concurrent erase requests share one run', async t => {
  const profile = populated(t);
  let release;
  const { instance, calls } = eraser(profile, { stopService: () => new Promise(resolve => { calls.push('stopService'); release = resolve; }) });
  const first = instance.erase();
  const second = instance.erase();
  assert.equal(first, second);
  await new Promise(setImmediate);
  release('exited');
  assert.equal((await first).ok, true);
  assert.equal(calls.filter(call => call === 'stopService').length, 1);
});

test('renderer storage that cannot be cleared keeps the erase pending', async t => {
  const profile = populated(t);
  const { instance, calls } = eraser(profile, { clearRendererState: async () => { throw new Error('session busy'); } });
  const result = await instance.erase();
  assert.equal(result.code, 'ERASE_INCOMPLETE');
  assert.equal(hasPendingErase(profile), true);
  assert.equal(calls.includes('startOver'), false);
});

test('a failure while starting over does not turn a finished erase into a failure', async t => {
  const profile = populated(t);
  const { instance, log } = eraser(profile, { startOver: async () => { throw new Error('key store unavailable'); } });
  assert.equal((await instance.erase()).ok, true);
  assert.equal(fs.existsSync(path.join(profile, 'wallets')), false);
  assert.ok(log.includes('start over after erase failed'));
});

test('the lock grant for an erase is one-shot and refused while locked', async t => {
  const profile = temporary(t);
  fs.writeFileSync(path.join(profile, 'app-lock.json'), JSON.stringify({ version: 1, enabled: true }));
  let clock = 1000;
  const lock = new AppLock({ profile, now: () => clock, settleMs: 0,
    authenticator: { availability: async () => ({ kind: 'fingerprint' }), authenticate: async () => ({ ok: true }) },
    timers: { setTimeout: () => {}, clearTimeout: () => {} } });
  assert.equal(lock.takeGrant(), false, 'locked');
  await lock.unlock();
  assert.equal(lock.takeGrant(), false, 'being unlocked is not a fresh confirmation');
  await lock.authorizeSecret();
  assert.equal(lock.takeGrant(), true);
  assert.equal(lock.takeGrant(), false, 'one grant, one erase');
  await lock.authorizeSecret();
  clock += 61000;
  assert.equal(lock.takeGrant(), false, 'a grant expires');
  const off = new AppLock({ profile: temporary(t), authenticator: { availability: async () => ({ kind: null }) } });
  assert.equal(off.takeGrant(), true, 'with the lock off the in-app confirmation is the gate');
});
