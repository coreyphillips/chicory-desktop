'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { payments, networks, Transaction } = require('bitcoinjs-lib');
const { BrowserWallet } = require('./browser-wallet');

const address = payments.p2wpkh({ hash: Buffer.alloc(20, 1), network: networks.regtest }).address;
const foreign = payments.p2wpkh({ hash: Buffer.alloc(20, 2), network: networks.regtest }).address;
const channelId = 'a'.repeat(64), previous = 'b'.repeat(64), hash = 'c'.repeat(64);
function fixture(t, overrides = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'chicory-browser-wallet-'));
  t.after(() => fs.rmSync(dir, { force: true, recursive: true }));
  const calls = [];
  const file = path.join(dir, 'browser-wallet.json');
  const call = async (method, route, body) => {
    calls.push([method, route, body]);
    if (route === '/address/new') return { address, fresh: true };
    if (route === '/channels') return [{ channelId, fundingTxid: previous, fundingOutputIndex: 0 }];
    if (route === '/channel/splice-quote') return { feeSats: 300, maxAmountSats: 100000 };
    if (route === '/channel/splice-out') return { ok: true };
    if (route.startsWith('/invoice?')) return { bolt11: 'lnbcrt-invoice', paymentHash: hash };
    if (route === '/invoice/decode') return { paymentHash: hash, amountSats: 1000, timestamp: 1700000000, expiry: 600 };
    throw new Error('Unexpected route');
  };
  const options = { record: { id: 'wallet-one', network: 'regtest' }, file, call, query: async () => [], ...overrides };
  return { store: new BrowserWallet(options), options, file, calls };
}
const body = () => ({ requestId: 'request-one', channelId, amountSats: 10000, feeratePerkw: 500, quotedFeeSats: 300, address });
const request = () => ({ id: 'receive-one', uri: `bitcoin:${address}?amount=0.00001&lightning=lnbcrt-invoice`, address, bolt11: 'lnbcrt-invoice', paymentHash: hash, amountSats: 1000, description: 'Test', feeSats: 0, expiresAt: 1700000600000, warnings: [], demo: false });

test('receive links persist after a restart and retry returns the same immutable request', async t => {
  const f = fixture(t);
  await f.store.allocate({});
  const saved = await f.store.register(request());
  assert.equal(saved.bitcoinTracking, 'unique');
  assert.deepEqual(await f.store.register(request()), saved);
  assert.deepEqual(new BrowserWallet(f.options).requests(), [saved]);
  if (process.platform !== 'win32') assert.equal(fs.statSync(f.file).mode & 0o777, 0o600);
});
test('receive registration rejects foreign addresses, altered invoices and duplicate URI fields', async t => {
  const f = fixture(t); await f.store.allocate({});
  await assert.rejects(() => f.store.register({ ...request(), address: foreign }), { code: 'RECEIVE_ADDRESS_NOT_OWNED' });
  await assert.rejects(() => f.store.register({ ...request(), bolt11: 'lnbcrt-other' }), { code: 'RECEIVE_REQUEST_NOT_OWNED' });
  await assert.rejects(() => f.store.register({ ...request(), uri: request().uri + '&amount=0.00002' }), { code: 'INVALID_RECEIVE_REQUEST' });
  await f.store.register(request());
  await assert.rejects(() => f.store.register({ ...request(), description: 'Changed' }), { code: 'RECEIVE_REQUEST_CONFLICT' });
});
test('a failed durable request save does not acknowledge or retain the request', async t => {
  let fail = false;
  const f = fixture(t, { save: (file, value) => { if (fail) throw new Error('disk unavailable'); fs.writeFileSync(file, JSON.stringify(value)); } });
  await f.store.allocate({}); fail = true;
  await assert.rejects(() => f.store.register(request()), /disk unavailable/);
  assert.deepEqual(f.store.requests(), []);
});
test('unreadable metadata fails closed and is never overwritten', async t => {
  const f = fixture(t);
  fs.writeFileSync(f.file, '{broken');
  assert.throws(() => f.store.requests(), { code: 'WALLET_METADATA_UNAVAILABLE' });
  await assert.rejects(() => f.store.allocate({}), { code: 'WALLET_METADATA_UNAVAILABLE' });
  assert.equal(fs.readFileSync(f.file, 'utf8'), '{broken');
});
test('splice journal is durable before dispatch and stable request IDs never send twice across restart', async t => {
  const f = fixture(t);
  let dispatches = 0;
  const original = f.options.call;
  f.store.call = async (method, route, payload) => {
    if (route === '/channel/splice-out') {
      dispatches++;
      assert.equal(JSON.parse(fs.readFileSync(f.file)).activity[0].status, 'uncertain');
    }
    return original(method, route, payload);
  };
  const result = await f.store.submitSplice(body());
  assert.equal(result.status, 'pending');
  assert.deepEqual(await f.store.submitSplice(body()), result);
  const restored = new BrowserWallet({ ...f.options, call: f.store.call });
  assert.deepEqual(await restored.submitSplice(body()), result);
  assert.equal(dispatches, 1);
  await assert.rejects(() => restored.submitSplice({ ...body(), amountSats: 11000 }), { code: 'REQUEST_ID_CONFLICT' });
});
test('a lost engine reply leaves an uncertain durable row and a retry does not repeat dispatch', async t => {
  const f = fixture(t);
  const original = f.store.call;
  let dispatches = 0;
  f.store.call = async (method, route, payload) => {
    if (route === '/channel/splice-out') { dispatches++; throw new Error('connection lost'); }
    return original(method, route, payload);
  };
  await assert.rejects(() => f.store.submitSplice(body()), /connection lost/);
  assert.equal((await f.store.submitSplice(body())).status, 'uncertain');
  assert.equal(dispatches, 1);
  await assert.rejects(() => f.store.submitSplice({ ...body(), requestId: 'another-request' }), { code: 'PAYMENT_IN_PROGRESS' });
  assert.equal(dispatches, 1);
});
test('a failed journal write and a higher fresh fee both refuse before dispatch', async t => {
  const f = fixture(t, { save: () => { throw new Error('disk unavailable'); } });
  await assert.rejects(() => f.store.submitSplice(body()), /disk unavailable/);
  assert.equal(f.calls.filter(([, route]) => route === '/channel/splice-out').length, 0);
  const other = fixture(t);
  await assert.rejects(() => other.store.submitSplice({ ...body(), quotedFeeSats: 200 }), { code: 'QUOTE_EXPIRED' });
  assert.equal(other.calls.filter(([, route]) => route === '/channel/splice-out').length, 0);
});
test('activity verifies both the original funding input and exact recipient output before claiming completion', async t => {
  const tx = new Transaction(); tx.addInput(Buffer.from(previous, 'hex').reverse(), 0);
  tx.addOutput(payments.p2wpkh({ hash: Buffer.alloc(20, 1), network: networks.regtest }).output, 10000);
  const txid = tx.getId();
  const f = fixture(t);
  await f.store.submitSplice(body());
  f.store.call = async () => [{ channelId, fundingTxid: txid }];
  f.store.query = async method => method === 'blockchain.transaction.get' ? tx.toHex() : [{ tx_hash: txid, height: 100 }];
  const [row] = await f.store.activity();
  assert.equal(row.status, 'completed'); assert.equal(row.txid, txid);
  const wrong = new Transaction(); wrong.addInput(Buffer.from(previous, 'hex').reverse(), 0);
  wrong.addOutput(payments.p2wpkh({ hash: Buffer.alloc(20, 2), network: networks.regtest }).output, 10000);
  const g = fixture(t); await g.store.submitSplice(body());
  g.store.call = async () => [{ channelId, fundingTxid: wrong.getId() }];
  g.store.query = async method => method === 'blockchain.transaction.get' ? wrong.toHex() : [{ tx_hash: wrong.getId(), height: 100 }];
  assert.equal((await g.store.activity())[0].status, 'pending');
});
test('Bitcoin receive tracking sums only the issued address outputs and validates transaction identity', async t => {
  const tx = new Transaction(); tx.addInput(Buffer.alloc(32, 3), 0);
  tx.addOutput(payments.p2wpkh({ hash: Buffer.alloc(20, 1), network: networks.regtest }).output, 5000);
  tx.addOutput(payments.p2wpkh({ hash: Buffer.alloc(20, 2), network: networks.regtest }).output, 100000);
  const f = fixture(t); await f.store.allocate({});
  f.store.query = async method => method === 'blockchain.transaction.get' ? tx.toHex() : [{ tx_hash: tx.getId(), height: 12 }];
  assert.deepEqual(await f.store.receipts(address), { address, transactions: [{ txid: tx.getId(), amountSats: 5000, confirmed: true }] });
  await assert.rejects(() => f.store.receipts(foreign), { code: 'RECEIVE_ADDRESS_NOT_OWNED' });
  f.store.query = async method => method === 'blockchain.transaction.get' ? tx.toHex() : [{ tx_hash: 'e'.repeat(64), height: 12 }];
  await assert.rejects(() => f.store.receipts(address), { code: 'RECEIVE_LOOKUP_UNAVAILABLE' });
});
test('new requests cannot claim a previously funded address and saved-request retries stay idempotent', async t => {
  const f = fixture(t); await f.store.allocate({});
  f.store.query = async () => [{ tx_hash: 'd'.repeat(64), height: 10 }];
  await assert.rejects(() => f.store.register(request()), { code: 'RECEIVE_ADDRESS_USED' });
  assert.deepEqual(f.store.requests(), []);
  f.store.query = async () => [];
  const saved = await f.store.register(request());
  f.store.query = async () => [{ tx_hash: 'd'.repeat(64), height: 10 }];
  assert.deepEqual(await f.store.register(request()), saved);
});
test('a returned splice transaction identity is durable before the result is acknowledged', async t => {
  const f = fixture(t); const original = f.store.call; const txid = 'd'.repeat(64);
  f.store.call = async (method, route, payload) => route === '/channel/splice-out' ? { ok: true, spliceTxid: txid } : original(method, route, payload);
  await f.store.submitSplice(body());
  const row = JSON.parse(fs.readFileSync(f.file)).activity[0];
  assert.equal(row.txid, txid); assert.equal(row.reference, txid);
});
test('an unpatched host cannot silently acknowledge an ignored fresh address option', async t => {
  const f = fixture(t, { call: async () => ({ address }) });
  await assert.rejects(() => f.store.allocate({}), { code: 'FRESH_ADDRESS_UNAVAILABLE' });
  assert.deepEqual(f.store.load().addresses, []);
});
test('only the verified engine version names completed outgoing debit semantics on the wire', async t => {
  const express = require('express');
  const { mountBrowserWalletApi } = require('./browser-wallet');
  const f = fixture(t);
  const outgoing = { direction: 'OUTGOING', status: 'COMPLETED', amountSats: 1002, feeSats: 2 };
  const incoming = { ...outgoing, direction: 'INCOMING' };
  const pending = { ...outgoing, status: 'PENDING' };
  const manager = {
    registry: { get: id => id === 'wallet-one' ? f.options.record : null },
    paths: () => ({ base: path.dirname(f.file) }), engineVersion: '0.38.1',
    _daemonCall: async () => [outgoing, incoming, pending],
  };
  const app = express(); mountBrowserWalletApi(app, manager);
  const server = await new Promise(resolve => { const instance = app.listen(0, '127.0.0.1', () => resolve(instance)); });
  t.after(() => new Promise(resolve => server.close(resolve)));
  const url = `http://127.0.0.1:${server.address().port}/wallets/wallet-one/api/payments`;
  const first = await fetch(url).then(result => result.json());
  assert.equal(first.result[0].amountSemantics, 'total-debit-including-fee');
  assert.equal(first.result[0].amountSats, 1002);
  assert.equal(first.result[1].amountSemantics, undefined);
  assert.equal(first.result[2].amountSemantics, undefined);
  manager.engineVersion = '0.37.0';
  assert.deepEqual((await fetch(url).then(result => result.json())).result, [outgoing, incoming, pending]);
});

test('an offline request keeps its offline flag, confirmed in the engine\'s offline receive journal', async t => {
  const journal = { requests: [{ id: 'job-one', kind: 'bolt11', invoice: { paymentHash: hash } }] };
  const confirmed = fixture(t);
  const base = confirmed.options.call;
  confirmed.store.call = async (method, route, body) => route === '/receive/status' ? journal : base(method, route, body);
  await confirmed.store.allocate({});
  const saved = await confirmed.store.register({ ...request(), offlineReceive: true });
  assert.equal(saved.offlineReceive, true);
  // A claim the engine does not confirm is refused rather than stored as offline.
  const unconfirmed = fixture(t);
  const other = unconfirmed.options.call;
  unconfirmed.store.call = async (method, route, body) => route === '/receive/status' ? { requests: [] } : other(method, route, body);
  await unconfirmed.store.allocate({});
  await assert.rejects(() => unconfirmed.store.register({ ...request(), offlineReceive: true }), { code: 'INVALID_RECEIVE_REQUEST' });
  // An ordinary request never asks the journal.
  const ordinary = fixture(t);
  await ordinary.store.allocate({});
  assert.equal((await ordinary.store.register(request())).offlineReceive, undefined);
  assert.equal(ordinary.calls.some(([, route]) => route === '/receive/status'), false);
});
