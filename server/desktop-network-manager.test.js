'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { EventEmitter } = require('node:events');
const cp = require('node:child_process');
const spawned = [];
let ipcFailure = false;
cp.spawn = (cmd, args, options) => {
  const captured = { cmd, args, options }; spawned.push(captured);
  const child = new EventEmitter();
  child.stdout = new EventEmitter(); child.stderr = new EventEmitter();
  child.kill = signal => { captured.killed = signal; return true; };
  child.send = (message, callback) => {
    assert.ok(child.listenerCount('error') > 0, 'the error listener exists before private initialization');
    captured.initialization = message;
    callback(ipcFailure ? new Error('fixture IPC failure') : null);
  };
  return child;
};
const { WalletManager } = require('./wallet-manager');
const { configureDesktopNetwork } = require('./desktop-network');

const onion = 'a'.repeat(56) + '.onion';
const tick = () => new Promise(resolve => setImmediate(resolve));
function harness(t, overrides = {}) {
  const previous = process.env.DESKTOP_TOR_MANAGED; process.env.DESKTOP_TOR_MANAGED = '1';
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'chicory-desktop-network-'));
  fs.writeFileSync(path.join(base, 'mnemonic'), 'fixture only');
  const channel = new EventEmitter(); channel.connected = true; channel.sent = [];
  channel.send = (message, callback) => { channel.sent.push(message); callback?.(); };
  const network = configureDesktopNetwork({ transport: channel, timeoutMs: 1000 });
  const rec = { id: 'w1', name: 'Fixture', network: 'regtest',
    electrum: { host: 'electrum.example', port: 50002, tls: true },
    networkMode: 'hybrid', running: false, port: 3001, ...overrides };
  const records = new Map([[rec.id, rec]]);
  const manager = Object.create(WalletManager.prototype);
  manager.runtime = new Map(); manager.probes = []; manager.guards = [];
  manager.registry = { get: id => records.get(id), list: () => [...records.values()], upsert: row => records.set(row.id, row) };
  manager.paths = () => ({ home: base, data: base, secrets: base,
    mnemonicFile: path.join(base, 'mnemonic'), tokenFile: path.join(base, 'token') });
  manager._log = () => {};
  manager.token = () => 'fixture';
  manager._clearStaleInstanceLock = () => {};
  // Host port probing has its own tests; these are about Tor and IPC.
  manager._busyPort = async () => null;
  manager._portsFree = async () => true;
  manager._startEvents = () => {};
  manager._stopEvents = () => {};
  manager._startDfWatch = () => {};
  manager._pollHealth = async () => {};
  manager._probeElectrum = async server => { manager.probes.push(server); return true; };
  manager._refuseWrongChain = async server => { manager.guards.push(server); };
  manager._daemonEnv = row => ({ BEIGNET_ELECTRUM_HOST: row.electrum.host,
    BEIGNET_ELECTRUM_PORT: String(row.electrum.port), BEIGNET_ELECTRUM_TLS: String(row.electrum.tls) });
  manager.publicRecord = id => ({ ...records.get(id), status: manager.runtimeState(id).status });
  const beforeSpawns = spawned.length;
  const reply = (request, result = { host: '127.0.0.1', port: 19050 }, error) =>
    channel.emit('message', { type: 'tor:result', requestId: request.requestId, result, error });
  t.after(async () => {
    network.close();
    for (const runtime of manager.runtime.values()) {
      if (runtime.startTask) await runtime.startTask;
      clearInterval(runtime.chainWatch); clearInterval(runtime.lfbwWatch); clearTimeout(runtime.electrumWait);
    }
    fs.rmSync(base, { recursive: true, force: true });
    if (previous === undefined) delete process.env.DESKTOP_TOR_MANAGED; else process.env.DESKTOP_TOR_MANAGED = previous;
  });
  return { manager, rec, channel, reply, spawns: () => spawned.slice(beforeSpawns) };
}

test('desktop start responds during cold Tor bootstrap and fails without a direct dial', async t => {
  const { manager, rec, channel, reply, spawns } = harness(t, { networkMode: 'tor' });
  await manager.startWallet(rec.id);
  const runtime = manager.runtimeState(rec.id); const task = runtime.startTask;
  assert.equal(runtime.status, 'starting'); assert.equal(rec.running, true);
  assert.equal(channel.sent[0].type, 'tor:ensure'); assert.equal(manager.probes.length, 0);
  reply(channel.sent[0], undefined, 'Tor is unavailable.'); await task;
  assert.equal(runtime.status, 'error'); assert.match(runtime.lastStartError.message, /Tor is unavailable/);
  assert.equal(manager.probes.length, 0); assert.equal(spawns().length, 0);
});

test('missing parent IPC prevents a Tor wallet daemon from starting', async t => {
  const { manager, rec, channel, spawns } = harness(t, { networkMode: 'tor' });
  channel.connected = false;
  await manager.startWallet(rec.id); await tick();
  assert.equal(manager.runtimeState(rec.id).status, 'error');
  assert.equal(manager.probes.length, 0); assert.equal(spawns().length, 0);
});

test('an onion Electrum daemon uses only its private runtime bridge and preserves the record', async t => {
  const { manager, rec, channel, reply, spawns } = harness(t, { electrum: { host: onion, port: 50001, tls: true } });
  await manager.startWallet(rec.id); const task = manager.runtimeState(rec.id).startTask;
  reply(channel.sent[0]); await tick();
  assert.equal(channel.sent[1].type, 'tor:bridge'); assert.equal(channel.sent[1].host, onion);
  reply(channel.sent[1], { host: '127.0.0.1', port: 19432 }); await task;
  assert.equal(manager.probes[0].host, '127.0.0.1');
  assert.equal(spawns()[0].options.env.BEIGNET_ELECTRUM_HOST, '127.0.0.1');
  assert.equal(spawns()[0].options.env.BEIGNET_ELECTRUM_PORT, '19432');
  assert.equal(spawns()[0].options.env.BEIGNET_ELECTRUM_TLS, 'false');
  assert.equal(rec.electrum.host, onion); assert.equal(rec.electrum.tls, true);
});

test('a stop during Tor bootstrap prevents later probe or spawn', async t => {
  const { manager, rec, channel, reply, spawns } = harness(t, { networkMode: 'tor' });
  await manager.startWallet(rec.id); const task = manager.runtimeState(rec.id).startTask;
  await manager.stopWallet(rec.id);
  reply(channel.sent[0]); await task;
  assert.equal(rec.running, false); assert.equal(manager.runtimeState(rec.id).status, 'stopped');
  assert.equal(manager.probes.length, 0); assert.equal(spawns().length, 0);
});

test('cold onion creation returns the record and phrase before its guarded background start', async t => {
  const { manager, channel, reply, spawns } = harness(t);
  manager._validateNetwork = value => value;
  manager._resolveElectrum = value => value;
  manager._normalizeRecovery = () => ({ mode: 'off' });
  manager._normalizeFfor = () => null; manager._normalizeGuardianServe = () => false;
  manager._allocatePort = () => 3002;
  const created = await manager._provision({ name: 'Cold onion fixture', network: 'regtest',
    electrum: { host: onion, port: 50001, tls: false }, onchainOnly: true, mnemonic: 'fixture recovery phrase' });
  assert.equal(created.mnemonic, 'fixture recovery phrase'); assert.equal(created.record.status, 'starting');
  assert.deepEqual(manager.registry.get(created.record.id).pendingChainGuard, { allow: false });
  assert.equal(manager.guards.length, 0);
  const runtime = manager.runtimeState(created.record.id); const task = runtime.startTask;
  manager._refuseWrongChain = async () => { throw new Error('Electrum serves a different chain.'); };
  reply(channel.sent[0]); await task;
  assert.equal(runtime.status, 'error'); assert.match(runtime.lastStartError.message, /different chain/);
  assert.deepEqual(manager.registry.get(created.record.id).pendingChainGuard, { allow: false });
  assert.equal(spawns().length, 0); assert.equal(manager.probes.length, 0);
});

test('a new manager runtime must finish the durable onion chain guard before spawning', async t => {
  const { manager, rec, channel, reply, spawns } = harness(t, {
    electrum: { host: onion, port: 50001, tls: false }, pendingChainGuard: { allow: true } });
  assert.equal(manager.runtime.size, 0, 'the reopened manager has no prior runtime guard');
  let guardOptions;
  manager._refuseWrongChain = async (_server, _network, options) => { guardOptions = options; };
  await manager.startWallet(rec.id); const task = manager.runtimeState(rec.id).startTask;
  assert.deepEqual(rec.pendingChainGuard, { allow: true }); assert.equal(spawns().length, 0);
  reply(channel.sent[0]); await tick();
  assert.deepEqual(guardOptions, { allow: true }); assert.equal(rec.pendingChainGuard, undefined);
  reply(channel.sent[1], { host: '127.0.0.1', port: 19432 }); await task;
  assert.equal(spawns().length, 1);
});

test('malformed onion probes fail before TCP or DNS is attempted', async t => {
  const { manager } = harness(t);
  let dialed = false; manager._probeTcp = () => { dialed = true; };
  await assert.rejects(WalletManager.prototype._probeElectrum.call(manager, { host: 'bad.onion', port: 50001 }), /valid onion/);
  assert.equal(dialed, false);
});

function encryptedFixture(t, manager) {
  const vault = require('./vault-files');
  const original = { isActive: vault.isActive, engineKeys: vault.engineKeys, bin: process.env.BEIGNET_BIN };
  vault.isActive = () => true;
  vault.engineKeys = () => ({ filesKey: 'a'.repeat(64), databaseKey: 'b'.repeat(64), filesRoot: '/fixture/wallet' });
  process.env.BEIGNET_BIN = '/fixture/cli.js';
  manager._daemonEnv = (_rec, _paths, mnemonic, token) => ({
    BEIGNET_MNEMONIC: mnemonic, BEIGNET_API_TOKEN: token, BEIGNET_NETWORK: 'regtest',
  });
  t.after(() => {
    vault.isActive = original.isActive; vault.engineKeys = original.engineKeys; ipcFailure = false;
    if (original.bin === undefined) delete process.env.BEIGNET_BIN; else process.env.BEIGNET_BIN = original.bin;
  });
}

test('encrypted wallet secrets reach the child through private IPC rather than its launch environment', async t => {
  const { manager, rec, spawns } = harness(t); encryptedFixture(t, manager);
  await manager.startWallet(rec.id); await manager.runtimeState(rec.id).startTask;
  const captured = spawns()[0];
  assert.equal(captured.options.env.BEIGNET_MNEMONIC, undefined);
  assert.equal(captured.options.env.BEIGNET_API_TOKEN, undefined);
  assert.equal(captured.initialization.mnemonic, 'fixture only');
  assert.equal(captured.initialization.apiToken, 'fixture');
  assert.equal(captured.initialization.filesKey, 'a'.repeat(64));
  assert.equal(manager.runtimeState(rec.id).spawnedEnv.BEIGNET_MNEMONIC, 'fixture only');
});

test('encrypted child IPC failure produces a safe startup error and terminates the child', async t => {
  const { manager, rec, spawns } = harness(t); encryptedFixture(t, manager); ipcFailure = true;
  await manager.startWallet(rec.id); await manager.runtimeState(rec.id).startTask;
  assert.equal(spawns()[0].killed, 'SIGTERM');
  assert.equal(manager.runtimeState(rec.id).status, 'error');
  assert.equal(manager.runtimeState(rec.id).lastStartError.message, 'Encrypted wallet initialization could not be delivered.');
});
