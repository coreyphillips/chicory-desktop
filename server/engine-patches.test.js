'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const vm = require('node:vm');
const { payments, networks } = require('bitcoinjs-lib');

async function fixture(t, version = '0.36.1') {
  const patch = await import('../scripts/apply-engine-patches.mjs');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'chicory-engine-patch-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  fs.mkdirSync(path.join(dir, 'dist/cli'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ name: 'beignet', version }));
  fs.writeFileSync(path.join(dir, 'dist/cli/beignet-node.js'), patch.ORIGINAL_METHOD);
  fs.writeFileSync(path.join(dir, 'dist/cli/daemon.js'), 'const address = await node.getNewAddress();\nreturn success({ address });\nreturn success({ address, bip21: uri.value });');
  return { dir, patch };
}
test('the engine patch is version-checked, shape-checked and idempotent', async t => {
  const { dir, patch } = await fixture(t);
  assert.equal(patch.patchEngine(dir).changed, true);
  assert.match(fs.readFileSync(path.join(dir, 'dist/cli/daemon.js'), 'utf8'), /fresh: true/);
  const first = fs.readFileSync(path.join(dir, 'dist/cli/beignet-node.js'), 'utf8');
  assert.equal(patch.patchEngine(dir).changed, false);
  assert.equal(fs.readFileSync(path.join(dir, 'dist/cli/beignet-node.js'), 'utf8'), first);
  const other = await fixture(t, '0.36.2');
  assert.throws(() => patch.patchEngine(other.dir), /exactly Beignet/);
  const changed = await fixture(t);
  fs.writeFileSync(path.join(changed.dir, 'dist/cli/daemon.js'), 'changed source');
  assert.throws(() => patch.patchEngine(changed.dir), /No files were changed/);
  assert.equal(fs.readFileSync(path.join(changed.dir, 'dist/cli/beignet-node.js'), 'utf8'), patch.ORIGINAL_METHOD);
  const source = await fixture(t); fs.mkdirSync(path.join(source.dir, '.git'));
  assert.throws(() => patch.patchEngine(source.dir), /source checkout/);
});
test('fresh addresses advance durably and wait for their exact subscription before acknowledgement', async () => {
  const { FRESH_METHOD } = await import('../scripts/apply-engine-patches.mjs');
  class WalletError extends Error { constructor(code, message) { super(message); this.code = code; } }
  const Node = vm.runInNewContext(`(class Node {${FRESH_METHOD}})`, { require, errors_1: { BeignetError: WalletError } });
  const node = new Node();
  const current = payments.p2wpkh({ hash: Buffer.alloc(20, 1), network: networks.regtest }).address;
  const fresh = payments.p2wpkh({ hash: Buffer.alloc(20, 2), network: networks.regtest }).address;
  const calls = []; let release;
  const subscription = new Promise(resolve => { release = resolve; });
  node.wallet = {
    fetchNextAvailableAddress: async () => ({ isErr: () => false, value: { addressIndex: { address: current } } }),
    generateNewReceiveAddress: async () => { calls.push('persisted'); return { isErr: () => false, value: { address: fresh } }; },
    electrum: { subscribeToAddresses: async value => { calls.push(value); return subscription; } },
  };
  node.getBitcoinNetwork = () => networks.regtest;
  let acknowledged = false;
  const pending = node.getFreshReceiveAddress().then(value => { acknowledged = true; return value; });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(calls[0], 'persisted'); assert.equal(calls[1].scriptHashes[0].length, 64); assert.equal(acknowledged, false);
  release({ isErr: () => false });
  assert.equal(await pending, fresh);
  node.wallet.generateNewReceiveAddress = async () => ({ isErr: () => false, value: { address: current } });
  await assert.rejects(node.getFreshReceiveAddress(), { code: 'RECEIVE_ADDRESS_LIMIT' });
});
