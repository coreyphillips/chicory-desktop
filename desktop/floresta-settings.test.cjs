'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { candidateDigest, candidate, FlorestaSettings, installFlorestaIpc } = require('./floresta-settings.cjs');

const digest = 'c1'.repeat(32);
const yes = { current: () => true, confirm: async () => true };
function fixture(t) {
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'chicory-node-settings-'));
  const calls = [];
  const options = { profile, root: profile, digest, canCollect: () => true,
    setCollection: (network, value) => calls.push([network, value]),
    reconcile: async (_node, network) => { calls.push([network, 'scan']); return { observedWallets: 1, confirmedScansCaughtUp: 0 }; },
    load: () => ({}), create: ({ network }) => {
      let phase = 'stopped';
      return { status: () => ({ phase, network }), start: async () => { phase = 'running'; calls.push([network, 'start']); },
        stop: async () => { phase = 'stopped'; calls.push([network, 'stop']); } };
    } };
  const settings = new FlorestaSettings(options);
  t.after(async () => { await settings.stopAll(); fs.rmSync(profile, { recursive: true, force: true }); });
  return { settings, options, calls, profile };
}

test('only an explicit unpackaged source launch can opt in to local node controls', () => {
  for (const value of [{}, { isPackaged: true, digest }, { demo: true, digest }, { digest: '../outside' }]) {
    assert.equal(candidateDigest(value), null);
  }
  assert.equal(candidateDigest({ isPackaged: false, demo: false, digest }), digest);
  assert.throws(() => candidate('.', '../outside'), /locally prepared/);
});

test('persist consent per candidate and network, resume only on opt-in and stop collection on disable', async t => {
  const { settings, options, calls } = fixture(t);
  settings.resume();
  assert.deepEqual(calls, []);
  const cancelled = await settings.change('regtest', 'start', { ...yes, confirm: async () => false });
  assert.equal(cancelled.requested, false);
  assert.deepEqual(calls, []);
  await settings.change('regtest', 'start', yes);
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(settings.status('regtest').requested, true);
  assert.equal(settings.status('mainnet').requested, false);
  assert.deepEqual(calls, [['regtest', 'start'], ['regtest', true], ['regtest', 'scan']]);
  await settings.stopAll();
  assert.deepEqual(calls.slice(-2), [['regtest', false], ['regtest', 'stop']]);
  const upgraded = new FlorestaSettings({ ...options, digest: 'd2'.repeat(32) });
  upgraded.resume();
  assert.equal(upgraded.status('regtest').requested, false);
  const resumed = new FlorestaSettings(options);
  resumed.resume();
  assert.equal(resumed.status('regtest').requested, true);
  await new Promise(resolve => setImmediate(resolve));
  await resumed.change('regtest', 'stop', yes);
  assert.equal(resumed.status('regtest').requested, false);
  assert.deepEqual(calls.slice(-2), [['regtest', false], ['regtest', 'stop']]);
  await resumed.stopAll({ reset: true });
  assert.equal(fs.existsSync(resumed.file), false);
});

test('a relock or quit during the native confirmation prevents a late enable', async t => {
  for (const quit of [false, true]) {
    const { settings, calls } = fixture(t);
    let confirm;
    let unlocked = true;
    const pending = settings.change('regtest', 'start', { current: () => unlocked, confirm: () => new Promise(resolve => { confirm = resolve; }) });
    if (quit) await settings.stopAll();
    else unlocked = false;
    confirm(true);
    await assert.rejects(pending, /Unlock/);
    assert.equal(settings.status('regtest').requested, false);
    assert.deepEqual(calls, []);
  }
});

test('IPC requires an unlocked trusted frame and only accepts native storage picks', async t => {
  const { settings } = fixture(t);
  let handler;
  const appLock = { generation: 1, required: () => false, expire() {}, duringPrompt: fn => fn() };
  let trusted = false;
  const allowed = () => true;
  installFlorestaIpc({ ipcMain: { handle: (_name, h) => { handler = h; } }, settings, allowed, trusted: () => trusted,
    appLock, window: () => ({}), dialog: { showMessageBox: async () => ({ response: 1 }) } });
  await assert.rejects(handler({}, 'regtest', 'status'), /locked/);
  trusted = true;
  await assert.rejects(handler({}, '../outside', 'start'), /Unsupported/);
  assert.equal((await handler({}, 'regtest', 'start')).requested, false);
  await assert.rejects(handler({}, 'regtest', '/choose/custom/path'), /unavailable/);
  appLock.required = () => true;
  await assert.rejects(handler({}, 'regtest', 'start'), /locked/);
});

test('corrupt qualification preferences cannot stop the wallet opening', t => {
  const { settings, calls } = fixture(t);
  fs.writeFileSync(settings.file, 'truncated');
  assert.doesNotThrow(() => settings.resume());
  assert.deepEqual(calls, []);
  assert.throws(() => settings.status('regtest'), /could not be read/);
});
