'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { reconcileQualificationWatches } = require('./floresta-wallet-sync.cjs');

function setup() {
  const owner = '1'.repeat(64);
  const view = { status: 'observed', network: 'regtest', fromHeight: 0, generation: '2'.repeat(64),
    descriptors: [{ descriptor: 'public test descriptor', range: [0, 4200] }],
    scripts: ['0014' + '34'.repeat(20)], outpoints: [], unresolvedHashes: [] };
  const manager = Object.assign(new EventEmitter(), { connected: true, send(message) {
    queueMicrotask(() => manager.emit('message', { type: 'floresta:snapshots-result', requestId: message.requestId,
      wallets: [{ owner, snapshot: view }] }));
  } });
  const requests = [];
  const node = { status: () => ({ network: 'regtest' }), registerWatches: async batch => requests.push(batch),
    watchCoverage: async () => ({ phase: 'caught-up' }) };
  return { manager, node, requests, view };
}

test('range registration resumes at its next batch and accounts for unresolved Lightning scripts', async () => {
  const f = setup();
  const run = () => reconcileQualificationWatches({ ...f, network: 'regtest' });
  assert.equal((await run()).confirmedScansCaughtUp, 0);
  assert.equal(f.requests.length, 16);
  f.view.unresolvedHashes = ['a'.repeat(64)];
  assert.equal((await run()).confirmedScansCaughtUp, 0);
  assert.equal(f.requests.length, 18);
  assert.deepEqual(f.requests[0].descriptors[0].range, [0, 255]);
  assert.deepEqual(f.requests[16].descriptors[0].range, [4096, 4200]);
  assert.deepEqual(f.requests[17].scripts, f.view.scripts);
  f.view.unresolvedHashes = [];
  assert.deepEqual(await run(), { observedWallets: 1, confirmedScansCaughtUp: 1 });
  assert.equal(f.requests.length, 18);
  f.node.watchCoverage = async () => { throw new Error('Volume unavailable.'); };
  await assert.rejects(run(), /Volume unavailable/);
  assert.equal((await run()).confirmedScansCaughtUp, 0);
  assert.equal(f.requests.length, 34);
});

test('a stopped collection rejects a late snapshot before registering anything', async () => {
  const f = setup();
  const cancel = new AbortController();
  const pending = reconcileQualificationWatches({ ...f, network: 'regtest', signal: cancel.signal });
  cancel.abort();
  await assert.rejects(pending, /stopped/);
  assert.equal(f.manager.listenerCount('message'), 0);
  assert.deepEqual(f.requests, []);
});

test('a pending or network-mismatched wallet cannot contribute to confirmed coverage', async () => {
  const f = setup();
  const run = () => reconcileQualificationWatches({ ...f, network: 'regtest' });
  f.view.network = 'mainnet';
  assert.deepEqual(await run(), { observedWallets: 1, confirmedScansCaughtUp: 0 });
  f.view.network = 'regtest';
  f.view.status = 'recovery-pending';
  assert.deepEqual(await run(), { observedWallets: 1, confirmedScansCaughtUp: 0 });
  assert.deepEqual(f.requests, []);
});
