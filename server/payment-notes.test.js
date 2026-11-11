'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { randomBytes } = require('node:crypto');
const vault = require('./vault-files');
const { WalletManager } = require('./wallet-manager');
const { startManager } = require('./index');
const { openPaymentNotes } = require('./payment-notes');

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'chicory-payment-notes-'));
  t.after(() => { vault.clearVault(); fs.rmSync(root, { recursive: true, force: true }); });
  vault.configureVault({ root, key: randomBytes(32) });
  vault.initializeVault();
  const records = new Map(['daily', 'savings'].map(id => [id, { id, network: 'regtest' }]));
  const manager = Object.assign(Object.create(WalletManager.prototype), {
    registry: { get: id => records.get(id), list: () => [...records.values()], remove: id => records.delete(id) },
    paths: id => ({ base: path.join(root, 'wallets', id) }),
    runtime: new Map(), channelLogs: new Map(), fallbackLogs: new Map(),
    async stopWallet() {}, async init() {}, async shutdown() {},
  });
  return { root, manager };
}

test('authenticated desktop note edits survive reload and reconcile without overwriting another note', async t => {
  const { root, manager } = fixture(t);
  const token = randomBytes(32).toString('hex');
  const service = await startManager({ manager, desktopSessionToken: token });
  t.after(() => service.close());
  const url = 'http://127.0.0.1:' + service.server.address().port + '/api/wallets/daily/payment-notes/regtest';
  assert.equal((await fetch(url)).status, 403);
  const call = async (method, body) => {
    const response = await fetch(url, {
      method, headers: { 'X-Chicory-Session': token, 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    assert.equal(response.status, 200);
    assert.equal(response.headers.get('cache-control'), 'no-store');
    return (await response.json()).result;
  };
  const raw = 'transaction:one';
  const key = 'activity:one';
  await call('PUT', { key: raw, note: { text: ' first ', address: 'address' } });
  await call('PUT', { key, note: { text: 'separate' } });
  const both = [[raw, { text: 'first', address: 'address' }], [key, { text: 'separate' }]];
  assert.deepEqual(await call('POST', { moves: [[raw, key]] }), both);
  await call('PUT', { key, note: { text: '  ' } });
  await call('PUT', { key: raw, note: { text: ' my local receipt ' } });
  const moved = [[key, { text: 'my local receipt', address: 'address' }]];
  assert.deepEqual(await call('POST', { moves: [[raw, key]] }), moved);
  assert.deepEqual(await call('POST', { moves: [[raw, key]] }), moved, 'retries are idempotent');
  assert.deepEqual(await call('GET'), moved);
  const bytes = fs.readFileSync(path.join(root, 'wallets/daily/payment-notes/regtest.json'));
  assert.ok(bytes.subarray(0, vault.MAGIC.length).equals(vault.MAGIC));
  assert.equal(bytes.includes(Buffer.from('my local receipt')), false);
  assert.deepEqual(openPaymentNotes(manager, 'savings', 'regtest').read(), []);
  assert.throws(() => openPaymentNotes(manager, 'daily', 'mainnet'), { statusCode: 404 });
  assert.throws(() => openPaymentNotes(manager, 'unknown', 'regtest'), { statusCode: 404 });
  const otherWalletData = path.join(root, 'wallets/daily/retain.json');
  vault.fs.writeFileSync(otherWalletData, '{}');
  await manager.deleteWallet('daily');
  assert.equal(fs.existsSync(path.join(root, 'wallets/daily/payment-notes')), false);
  assert.equal(fs.existsSync(otherWalletData), true);
});

test('damaged notes and a closed vault cannot fall back to an empty or unencrypted note file', t => {
  const { root, manager } = fixture(t);
  const notes = () => openPaymentNotes(manager, 'daily', 'regtest');
  notes().save({ key: 'activity:one', note: { text: 'private' } });
  const file = path.join(root, 'wallets/daily/payment-notes/regtest.json');
  const bytes = fs.readFileSync(file);
  bytes[bytes.length - 1] ^= 1;
  fs.writeFileSync(file, bytes);
  assert.throws(() => notes().save({ key: 'activity:two', note: { text: 'second' } }), { statusCode: 503 });
  vault.clearVault();
  assert.throws(() => notes(), { statusCode: 409 });
  assert.deepEqual(fs.readFileSync(file), bytes);
});
