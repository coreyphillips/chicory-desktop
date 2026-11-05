'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { once } = require('node:events');
const net = require('node:net');
const tls = require('node:tls');
const { createInterface } = require('node:readline');
const { createHash } = require('node:crypto');
const { openWalletBridge } = require('./floresta-wallet-bridge');
const { walletElectrum } = require('./floresta-wallet-electrum');
const { Transaction, script, opcodes } = require('bitcoinjs-lib');
const digest = s => createHash('sha256').update(s).digest();
const header = '00'.repeat(80);
const tipHash = digest(digest(Buffer.from(header, 'hex'))).reverse().toString('hex');
const scope = { tipHash, tipHeight: 101 };
const scriptHash = 'aa'.repeat(32);
const id = 'bb'.repeat(32);
function fixtures() {
  const signal = new AbortController();
  const state = { network: 'regtest', phase: 'running', height: 101, validatedHeight: 101, tipHash, tipSynced: true, historicalVerification: 'verified' };
  const observed = { ...scope, scope: 'observed-pending', coverageComplete: false, revision: 1, rows: [] };
  const tx = new Transaction(); tx.addInput(Buffer.alloc(32, 2), 3); tx.addOutput(script.compile([opcodes.OP_TRUE]), 50000);
  const proof = { ...scope, txid: tx.getId(), wtxid: tx.getId(), header, hex: tx.toHex(), scope: 'confirmed-only', height: 100,
    blockHash: id, confirmations: 2, position: 1, merkle: [scriptHash] };
  const rows = [{ height: 100, position: 1, txid: tx.getId(), vout: 2, value: 50000 }];
  const close = () => {};
  const backend = { qualification: true, network: 'regtest', signal: signal.signal, status: () => state, readHeader: async () => header,
    pending: { observations: async h => h === scriptHash ? observed : null, close, transaction: async () => null },
    confirmed: { close, history: async () => ({ ...scope, scope: 'confirmed-only', rows }),
      unspent: async () => ({ ...scope, scope: 'confirmed-only', rows }), transaction: async t => t === tx.getId() ? proof : null,
      merkle: async (t, h) => t === tx.getId() && h === 100 ? proof : null } };
  return { backend, signal, state, observed, tx };
}
function connect(endpoint, identity = 'chicory-wallet-1', secret = endpoint.psk) {
  return tls.connect({ host: endpoint.host, port: endpoint.port, minVersion: 'TLSv1.2', maxVersion: 'TLSv1.2',
    ciphers: 'PSK-AES128-GCM-SHA256', rejectUnauthorized: false, pskCallback: () => ({ identity, psk: Buffer.from(secret, 'hex') }) });
}

test('only one exact TLS PSK can open the wallet; the listener rejects plaintext, bounds half-open clients and revokes its socket', async t => {
  const f = fixtures();
  const bridge = await openWalletBridge(f.backend);
  t.after(bridge.close);
  async function rejected(socket) {
    socket.on('error', () => {});
    await assert.rejects(once(socket, 'secureConnect'));
  }
  await rejected(connect(bridge.endpoint, 'foreign'));
  await rejected(connect(bridge.endpoint, 'chicory-wallet-1', '12'.repeat(32)));
  const plain = net.connect(bridge.endpoint.port, bridge.endpoint.host);
  plain.on('error', () => {});
  const end = once(plain, 'close');
  plain.write('{"id":1,"method":"server.features","params":[]}\n');
  await end;
  const waiting = Array.from({ length: 4 }, () => net.connect(bridge.endpoint.port, bridge.endpoint.host));
  await Promise.all(waiting.map(s => once(s, 'connect')));
  const extra = net.connect(bridge.endpoint.port, bridge.endpoint.host);
  await once(extra, 'close');
  await Promise.all(waiting.map(s => { const end = once(s, 'close'); s.destroy(); return end; }));
  const socket = connect(bridge.endpoint);
  await once(socket, 'secureConnect');
  const lines = createInterface({ input: socket })[Symbol.asyncIterator]();
  socket.write('{"id":1,"method":"server.version","params":["beignet","1.4"]}\n');
  assert.equal(JSON.parse((await lines.next()).value).result[1], '1.4');
  await rejected(connect(bridge.endpoint));
  socket.write(JSON.stringify([{ id: 2, method: 'blockchain.scripthash.get_balance', params: [scriptHash] },
    { id: 3, method: 'blockchain.scripthash.get_balance', params: [id] }]) + '\n');
  const batch = JSON.parse((await lines.next()).value);
  assert.deepEqual(batch[0].result, { confirmed: 50000, unconfirmed: 0 });
  assert.ok(batch[1].error);
  const ended = once(socket, 'close'); f.signal.abort(); await ended;
});

test('owner observations produce consistent status, spent outputs, decoded transactions and confirmed proofs', async () => {
  const { backend, observed, tx, state } = fixtures();
  const view = walletElectrum(backend);
  assert.equal((await view.call('server.features', [])).chicory.pendingCoverage, 'observed-only');
  for (const blocks of [2, 6, 24, 144]) assert.equal(await view.call('blockchain.estimatefee', [blocks]), -1);
  const previous = await view.call('blockchain.scripthash.subscribe', [scriptHash]);
  observed.rows.push({ txid: id, height: 0, fee: 510, spent: [{ txid: tx.getId(), vout: 2, value: 50000 }], created: [{ vout: 1, value: 4000 }] });
  assert.deepEqual(await view.call('blockchain.scripthash.get_balance', [scriptHash]), { confirmed: 50000, unconfirmed: -46000 });
  assert.deepEqual(await view.call('blockchain.scripthash.listunspent', [scriptHash]), [{ tx_hash: id, tx_pos: 1, height: 0, value: 4000 }]);
  const history = await view.call('blockchain.scripthash.get_history', [scriptHash]);
  const expected = digest(history.map(e => `${e.tx_hash}:${e.height}:`).join('')).toString('hex');
  assert.notEqual(previous, expected);
  const notices = [];
  await view.refresh((method, params) => notices.push({ method, params }));
  assert.deepEqual(notices, [{ method: 'blockchain.scripthash.subscribe', params: [scriptHash, expected] }]);
  assert.equal((await view.call('blockchain.transaction.get', [tx.getId(), true])).vout[0].value, 0.0005);
  assert.deepEqual(await view.call('blockchain.transaction.get_merkle', [tx.getId(), 100]), { pos: 1, block_height: 100, merkle: [scriptHash] });
  await assert.rejects(view.call('blockchain.transaction.get', [id, true]));
  await assert.rejects(view.call('blockchain.transaction.get_merkle', [id, 100]));
  state.historicalVerification = 'verifying';
  await assert.rejects(view.call('blockchain.scripthash.get_history', [scriptHash]));
});

test('production networks and missing qualification opt-in refuse a bridge before reading wallet data or dialing', async () => {
  const { grantWalletBridge } = require('../desktop/floresta-wallet-bridge.cjs');
  const { installBridgeControl } = require('./floresta-bridge-control');
  const { EventEmitter } = require('node:events');
  for (const network of ['mainnet', 'testnet']) {
    const f = fixtures();
    await assert.rejects(openWalletBridge({ ...f.backend, network, status: assert.fail }), /regtest/);
    await assert.rejects(grantWalletBridge({ qualification: true, manager: { connected: true, send: assert.fail }, owner: id,
      node: { status: () => ({ network }), openConfirmedWallet: assert.fail }, signal: f.signal.signal }));
    const parent = Object.assign(new EventEmitter(), { send: assert.fail, connected: true });
    const stop = installBridgeControl(parent, { qualification: true });
    parent.emit('message', { type: 'floresta:bridge-open', id: 'feeefeee-feee-4eee-aeee-feeefeeefeee', network });
    stop();
  }
  await assert.rejects(openWalletBridge({ ...fixtures().backend, qualification: false }), /regtest/);
});
test('script reads discard pending revision changes during confirmed reads and preserve unconfirmed dependency height', async () => {
  const { backend, observed } = fixtures();
  const view = walletElectrum(backend);
  observed.rows.push({ txid: id, height: -1, fee: 0, spent: [], created: [{ vout: 2, value: 2000 }] });
  assert.equal((await view.call('blockchain.scripthash.listunspent', [scriptHash])).at(-1).height, -1);
  let revision = 0;
  backend.pending.observations = async () => ({ ...observed, revision: ++revision });
  await assert.rejects(view.call('blockchain.scripthash.subscribe', [scriptHash]));
});

test('the manager fork can read only through its own live supervisor grant and drops it across child replacement', async t => {
  const { grantWalletBridge } = require('../desktop/floresta-wallet-bridge.cjs');
  const { installBridgeControl } = require('./floresta-bridge-control');
  const { EventEmitter } = require('node:events');
  const parent = Object.assign(new EventEmitter(), { connected: true });
  const manager = Object.assign(new EventEmitter(), { connected: true });
  const messages = [];
  for (const [channel, peer] of [[manager, parent], [parent, manager]]) channel.send = (msg, cb) => {
    messages.push(msg); queueMicrotask(() => { peer.emit('message', msg); cb?.(); });
  };
  const stop = installBridgeControl(parent, { qualification: true }); t.after(stop);
  const fixture = fixtures();
  const offers = [];
  const node = { watch: { active: true, walletOffersActive: true, async request(command) { offers.push(command); return command.txid; } }, status: fixture.backend.status, openConfirmedWallet: o => {
    assert.equal(o, id); return fixture.backend.confirmed;
  }, openPendingWallet: o => { assert.equal(o, id); return fixture.backend.pending; }, readHeader: fixture.backend.readHeader };
  const lease = await grantWalletBridge({ qualification: true, manager, node, owner: id, signal: fixture.signal.signal }); t.after(lease.close);
  const socket = connect(lease.endpoint);
  await once(socket, 'secureConnect');
  const lines = createInterface({ input: socket })[Symbol.asyncIterator]();
  const send = (method, params = []) => socket.write(JSON.stringify({ id: 1, method, params }) + '\n');
  send('server.version', ['test', '1.4']); await lines.next();
  send('blockchain.scripthash.get_balance', [scriptHash]);
  assert.deepEqual(JSON.parse((await lines.next()).value).result, { confirmed: 50000, unconfirmed: 0 });
  async function offer(tx) {
    send('blockchain.transaction.broadcast', [tx.toHex()]);
    return JSON.parse((await lines.next()).value);
  }
  const signed = fixture.tx.clone();
  signed.setWitness(0, [Buffer.from([1])]);
  const txid = signed.getId();
  const wtxid = digest(digest(signed.toBuffer())).reverse().toString('hex');
  assert.notEqual(txid, wtxid);
  assert.ok((await offer(signed)).error);
  assert.throws(() => lease.authorizeBroadcast(txid));
  lease.authorizeBroadcast(txid, wtxid);
  assert.throws(() => lease.authorizeBroadcast(txid, wtxid));
  const wrongWitness = signed.clone();
  wrongWitness.setWitness(0, [Buffer.from([2])]);
  assert.equal(wrongWitness.getId(), txid);
  assert.ok((await offer(wrongWitness)).error);
  fixture.state.tipHash = scriptHash;
  assert.ok((await offer(signed)).error);
  fixture.state.tipHash = tipHash;
  assert.deepEqual(offers, []);
  assert.equal((await offer(signed)).result, txid);
  assert.ok((await offer(signed)).error);
  assert.deepEqual(offers, [{ action: 'broadcast', owner: id, txid, offer: { tip: tipHash, hex: signed.toHex() } }]);
  assert.equal(messages.filter(m => m.type === 'floresta:bridge-read').some(m => JSON.stringify(m).includes(lease.endpoint.psk)), false);
  node.watch = { active: true };
  const revoked = once(socket, 'close'); send('blockchain.scripthash.get_balance', [scriptHash]); await revoked;
});

test('the prepared Beignet Electrum transport negotiates the lease and queries a watched script over TLS', async t => {
  const path = require('node:path');
  const fs = require('node:fs');
  const { fork } = require('node:child_process');
  const pinned = path.resolve(__dirname, '../.runtime/node', process.platform === 'win32' ? 'node.exe' : 'bin/node');
  if (!fs.existsSync(pinned) || !fs.existsSync(path.resolve(__dirname, '../.runtime/engine/node_modules/beignet/package.json'))) return t.skip('Prepare pinned engine first.');
  const f = fixtures();
  const bridge = await openWalletBridge(f.backend); t.after(bridge.close);
  const engine = fork(path.resolve(__dirname, '../scripts/qualification/floresta-wallet-client.cjs'), [], {
    execPath: pinned, execArgv: [], stdio: ['ignore', 'ignore', 'ignore', 'ipc'], env: { CHICORY_FLORESTA_WALLET_LAB: '1', BEIGNET_NETWORK: 'regtest',
      CHICORY_ELECTRUM_POLICY: 'selected-only', BEIGNET_ELECTRUM_HOST: '127.0.0.1', BEIGNET_ELECTRUM_TLS: 'true',
      BEIGNET_ELECTRUM_PORT: String(bridge.endpoint.port), ...(process.platform === 'win32' && { SystemRoot: process.env.SystemRoot }) } });
  t.after(() => { if (engine.connected) engine.disconnect(); engine.kill(); });
  const ask = async message => { const reply = once(engine, 'message', { signal: AbortSignal.timeout(5000) }); engine.send(message); return (await reply)[0]; };
  assert.deepEqual(await ask({ type: 'open', id: 1, psk: bridge.endpoint.psk }), { id: 1, value: ['Chicory managed qualification', '1.4'] });
  assert.deepEqual(await ask({ type: 'read', id: 2, method: 'blockchain.scripthash.get_balance', params: [scriptHash] }),
    { id: 2, value: { confirmed: 50000, unconfirmed: 0 } });
});

test('the real Beignet wallet checks an owner-scoped socket without reading a synthetic balance', async t => {
  const path = require('node:path');
  const fs = require('node:fs');
  const { fork } = require('node:child_process');
  const pinned = path.resolve(__dirname, '../.runtime/node', process.platform === 'win32' ? 'node.exe' : 'bin/node');
  if (!fs.existsSync(pinned) || !fs.existsSync(path.resolve(__dirname, '../.runtime/engine/node_modules/beignet/package.json'))) return t.skip('Prepare pinned engine first.');
  const f = fixtures();
  let reads = 0;
  f.backend.pending.observations = async () => { reads++; return null; };
  const bridge = await openWalletBridge(f.backend); t.after(bridge.close);
  const child = fork(path.resolve(__dirname, '../scripts/qualification/floresta-sending-wallet.cjs'), [], {
    execPath: pinned, execArgv: [], stdio: ['ignore', 'ignore', 'ignore', 'ipc'], env: {
      CHICORY_FLORESTA_WALLET_LAB: '1', BEIGNET_NETWORK: 'regtest', CHICORY_ELECTRUM_POLICY: 'selected-only',
      BEIGNET_ELECTRUM_HOST: '127.0.0.1', BEIGNET_ELECTRUM_TLS: 'true', BEIGNET_ELECTRUM_PORT: String(bridge.endpoint.port),
      ...(process.platform === 'win32' && { SystemRoot: process.env.SystemRoot }) } });
  t.after(() => { if (child.connected) child.disconnect(); child.kill(); });
  let id = 0;
  async function ask(type, fields = {}) {
    const response = once(child, 'message', { signal: AbortSignal.timeout(5000) });
    child.send({ id: ++id, type, ...fields });
    const [reply] = await response;
    assert.equal(reply.id, id);
    assert.equal(reply.error, undefined);
    return reply.value;
  }
  await ask('prepare', { psk: bridge.endpoint.psk });
  assert.equal(await ask('connect'), true);
  assert.equal(await ask('liveness'), true);
  assert.equal(reads, 0);
  bridge.close();
  assert.equal(await ask('liveness'), false);
});

test('an authenticated subscription survives an owner rescan and tip race, reports fresh status once and closes on revocation', async t => {
  const f = fixtures();
  const realObservations = f.backend.pending.observations;
  const bridge = await openWalletBridge(f.backend);
  t.after(bridge.close);
  const socket = connect(bridge.endpoint);
  await once(socket, 'secureConnect');
  const lines = createInterface({ input: socket })[Symbol.asyncIterator]();
  let id = 0;
  async function request(method, params) {
    socket.write(JSON.stringify({ id: ++id, method, params }) + '\n');
    const reply = JSON.parse((await lines.next()).value);
    assert.equal(reply.id, id, 'An unverified or duplicate notification reached the wallet.');
    return reply;
  }
  await request('server.version', ['wallet', '1.4']);
  const query = 'blockchain.scripthash.subscribe';
  const previous = (await request(query, [scriptHash])).result;
  assert.match(previous, /^[a-f0-9]{64}$/);
  f.backend.pending.observations = async () => null;
  await bridge.refresh();
  assert.ok((await request('blockchain.scripthash.get_history', [scriptHash])).error);
  f.backend.pending.observations = realObservations;
  f.state.tipSynced = false;
  await bridge.refresh();
  assert.ok((await request(query, [scriptHash])).error);
  f.state.tipSynced = true;
  f.observed.rows.push({ txid: id.toString(16).padStart(64, '0'), height: 0, fee: 100, spent: [], created: [] });
  await bridge.refresh();
  const notice = JSON.parse((await lines.next()).value);
  assert.equal(notice.method, query); assert.equal(notice.params[0], scriptHash); assert.notEqual(notice.params[1], previous);
  await bridge.refresh();
  assert.equal((await request(query, [scriptHash])).result, notice.params[1]);
  const end = once(socket, 'close');
  f.signal.abort(); await end;
  const replacement = connect(bridge.endpoint);
  replacement.on('error', () => {});
  await assert.rejects(once(replacement, 'secureConnect'));
});

test('a malformed or revoked backend still fails a subscription poll', async () => {
  const f = fixtures(), view = walletElectrum(f.backend);
  await view.call('blockchain.scripthash.subscribe', [scriptHash]);
  f.backend.pending.observations = async () => ({ ...f.observed, tipHash: 'corrupt' });
  await assert.rejects(view.refresh(() => assert.fail()));
  f.backend.pending.observations = async () => { throw new Error('Session revoked'); };
  await assert.rejects(view.refresh(() => assert.fail()), /revoked/);
});

test('one unavailable subscribed script cannot hide a verified change on a second registered script', async () => {
  const f = fixtures();
  const second = 'ce'.repeat(32);
  f.backend.pending.observations = async () => f.observed;
  const view = walletElectrum(f.backend);
  const subscribe = 'blockchain.scripthash.subscribe';
  const prior = await view.call(subscribe, [scriptHash]);
  assert.equal(await view.call(subscribe, [second]), prior);
  f.backend.pending.observations = async hash => hash === second ? f.observed : null;
  f.observed.rows.push({ txid: id, fee: 1, height: 0, spent: [], created: [] });
  const notices = [];
  await view.refresh((method, params) => notices.push({ method, params }));
  assert.equal(notices.length, 1);
  assert.equal(notices[0].params[0], second);
  assert.notEqual(notices[0].params[1], prior);
});

test('only declared chain transitions can defer a subscription', async () => {
  const transitions = [
    { phase: 'waiting-for-tip', tipSynced: null, height: null, validatedHeight: null, tipHash: null, historicalVerification: 'unknown' },
    { tipSynced: false, height: 102 }, { historicalVerification: 'pending' }, { historicalVerification: 'verifying' },
  ];
  const fatal = [
    { historicalVerification: 'error' }, { historicalVerification: 'unknown' }, { historicalVerification: 'future' },
    { height: null, tipSynced: false }, { validatedHeight: -1 }, { validatedHeight: 102 },
    { tipSynced: 'yes' }, { tipHash: 'malformed', historicalVerification: 'verifying' }, { height: 102, tipSynced: true },
    { phase: 'waiting-for-tip', historicalVerification: 'error' },
  ];
  for (const [expected, statuses] of [['transition', transitions], ['fatal', fatal]]) {
    for (const fields of statuses) {
      const f = fixtures(), view = walletElectrum(f.backend);
      await view.call('blockchain.scripthash.subscribe', [scriptHash]);
      Object.assign(f.state, fields);
      await assert.rejects(view.call('blockchain.scripthash.get_history', [scriptHash]));
      const refresh = view.refresh(() => assert.fail('An unavailable chain produced a notification.'));
      if (expected === 'transition') await refresh; else await assert.rejects(refresh);
    }
  }
});
