'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const vault = require('./vault-files');
const { createSecureStore, MAX_ENTRY_BYTES } = require('./secure-store');

const DRAFT = 'com.beignet.wallet.offline-request.wallet-1';
const SNAPSHOT = 'com.beignet.wallet.last-snapshot.wallet-1';

async function store(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'chicory-secure-store-'));
  t.after(() => { vault.clearVault(); fs.rmSync(root, { recursive: true, force: true }); });
  vault.configureVault({ root, key: crypto.randomBytes(32) });
  await vault.initializeVault();
  return { root, store: createSecureStore({ dataDir: root }) };
}

test('private app state round-trips and is encrypted at rest', async (t) => {
  const { root, store: s } = await store(t);
  const draft = JSON.stringify({ id: 'a'.repeat(20), amountSats: 4000, description: 'rent for march' });
  assert.equal(s.get(DRAFT), null);
  s.set(DRAFT, { username: 'offline-request', password: draft });
  s.set(SNAPSHOT, { username: 'beignet-snapshot', password: JSON.stringify({ version: 1, walletId: 'wallet-1', balance: 123456 }) });
  assert.deepEqual(s.get(DRAFT), { service: DRAFT, username: 'offline-request', password: draft });
  assert.deepEqual(s.list().sort(), [DRAFT, SNAPSHOT].sort());
  for (const name of fs.readdirSync(path.join(root, 'secure-store'))) {
    const bytes = fs.readFileSync(path.join(root, 'secure-store', name));
    for (const text of ['rent for march', 'wallet-1', '4000', 'offline-request']) assert.equal(bytes.includes(Buffer.from(text)), false, text);
  }
  s.remove(DRAFT);
  assert.equal(s.get(DRAFT), null);
  assert.deepEqual(s.list(), [SNAPSHOT]);
});

test('only private interface state is accepted, within a size bound', async (t) => {
  const { store: s } = await store(t);
  for (const service of ['com.beignet.wallet.haptics', 'com.beignet.wallet.mnemonic', '../registry', 'com.beignet.wallet.offline-request.', 'anything'])
    assert.throws(() => s.set(service, { username: 'x', password: 'y' }), { code: 'SECURE_STORE_REFUSED' }, service);
  assert.throws(() => s.set(DRAFT, { username: 'x' }), { code: 'SECURE_STORE_REFUSED' });
  assert.throws(() => s.set(SNAPSHOT, { username: 'x', password: 'x'.repeat(MAX_ENTRY_BYTES) }), { code: 'SECURE_STORE_TOO_LARGE' });
  for (const service of ['com.beignet.wallet.auto-pay', 'com.beignet.wallet.network-profiles', 'com.beignet.wallet.last-snapshot'])
    assert.equal(s.set(service, { username: 'x', password: '{}' }), true, service);
});

test('a damaged entry is reported, not mistaken for an empty one', async (t) => {
  const { root, store: s } = await store(t);
  s.set(DRAFT, { username: 'offline-request', password: '{}' });
  const [name] = fs.readdirSync(path.join(root, 'secure-store'));
  const file = path.join(root, 'secure-store', name);
  const bytes = fs.readFileSync(file); bytes[bytes.length - 1] ^= 1; fs.writeFileSync(file, bytes);
  assert.throws(() => s.get(DRAFT), { code: 'SECURE_STORE_UNREADABLE' }, 'an unreadable draft must surface, so no new request identity is made');
  assert.deepEqual(s.list(), []);
});

test('without encrypted storage nothing is kept', () => {
  vault.clearVault();
  const s = createSecureStore({ dataDir: os.tmpdir() });
  assert.throws(() => s.get(DRAFT), { code: 'SECURE_STORE_UNAVAILABLE' });
  assert.throws(() => s.set(DRAFT, { username: 'x', password: 'y' }), { code: 'SECURE_STORE_UNAVAILABLE' });
});
