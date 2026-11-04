'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'chicory-import-'));
process.env.DATA_DIR = DATA_DIR;
const { WalletManager } = require('./wallet-manager');
const SEED = 'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about';
const OTHER_SEED = 'legal winner thank year wave sausage worth useful legal winner thank yellow';
const ID = 'aaaaaaaa-0000-4000-8000-000000000001';
const ELECTRUM = { host: '127.0.0.1', port: 60401, tls: false };

test.after(() => fs.rmSync(DATA_DIR, { recursive: true, force: true }));

function box(existing = []) {
  fs.rmSync(DATA_DIR, { recursive: true, force: true });
  fs.mkdirSync(DATA_DIR, { recursive: true });
  const manager = new WalletManager();
  manager.settings.load();
  manager.registry.load();
  manager._refuseWrongChain = async () => {};
  manager.startWallet = async () => {};
  // Host port probing has its own tests; these are about seed identity.
  manager._portsFree = async () => true;
  for (const rec of existing) {
    const { mnemonic, ...record } = rec;
    manager.registry.upsert({ id: ID, port: 3101, name: 'Existing', running: false, network: 'regtest', ...record });
    const file = manager.paths(rec.id || ID).mnemonicFile;
    fs.mkdirSync(path.dirname(file), { recursive: true });
    if (mnemonic !== null) fs.writeFileSync(file, mnemonic ?? SEED, { mode: 0o600 });
  }
  return manager;
}

function restore(manager, options = {}) {
  return manager.importWallet({
    name: 'Imported', network: 'regtest', electrum: ELECTRUM,
    mnemonic: SEED, onchainOnly: true, ...options,
  });
}

function refusedWithoutSeed(code) {
  return (error) => {
    assert.equal(error.statusCode, 409);
    assert.equal(error.code, code);
    assert.doesNotMatch(error.message, /abandon|legal winner/);
    assert.doesNotMatch(JSON.stringify(error), /abandon|legal winner/);
    return true;
  };
}

test('same-seed import on the same network is refused before provisioning, including stopped wallets', async () => {
  const manager = box([{}]);
  const before = fs.readdirSync(path.join(DATA_DIR, 'wallets'));
  let probed = false;
  manager._refuseWrongChain = async () => { probed = true; };
  await assert.rejects(restore(manager), refusedWithoutSeed('WALLET_ALREADY_EXISTS'));
  assert.equal(probed, false);
  assert.equal(manager.registry.list().length, 1);
  assert.deepEqual(fs.readdirSync(path.join(DATA_DIR, 'wallets')), before);
  assert.equal(fs.readFileSync(manager.paths(ID).mnemonicFile, 'utf8'), SEED);
});

test('case and whitespace differences do not create a second identity', async () => {
  const manager = box([{ mnemonic: `  ${SEED.toUpperCase().replaceAll(' ', '\n')}  ` }]);
  await assert.rejects(restore(manager, { mnemonic: ` ${SEED.toUpperCase()} ` }), refusedWithoutSeed('WALLET_ALREADY_EXISTS'));
});

test('the same seed can be used on another network with its own wallet database', async () => {
  const manager = box([{}]);
  const result = await restore(manager, { network: 'testnet' });
  assert.equal(result.record.network, 'testnet');
  assert.notEqual(result.record.id, ID);
  assert.equal(manager.registry.list().length, 2);
  assert.equal(fs.readFileSync(manager.paths(ID).mnemonicFile, 'utf8'), SEED);
  assert.equal(fs.readFileSync(manager.paths(result.record.id).mnemonicFile, 'utf8'), SEED);
});

test('another valid seed on the same network is accepted', async () => {
  const manager = box([{}]);
  const result = await restore(manager, { mnemonic: OTHER_SEED });
  assert.equal(result.record.network, 'regtest');
  assert.equal(manager.registry.list().length, 2);
});

test('an unreadable or invalid existing identity fails closed without creating files', async () => {
  for (const mnemonic of [null, '', 'invalid seed']) {
    const manager = box([{ mnemonic }]);
    await assert.rejects(restore(manager, { mnemonic: OTHER_SEED }), refusedWithoutSeed('WALLET_IDENTITY_UNAVAILABLE'));
    assert.equal(manager.registry.list().length, 1);
    assert.deepEqual(fs.readdirSync(path.join(DATA_DIR, 'wallets')), [ID]);
  }
});

test('an unreadable registry fails closed before a new identity is allocated', async () => {
  const manager = box();
  manager.registry.loadError = { message: 'Unreadable registry' };
  await assert.rejects(restore(manager), refusedWithoutSeed('WALLET_IDENTITY_UNAVAILABLE'));
  assert.equal(manager.registry.list().length, 0);
  assert.equal(fs.existsSync(path.join(DATA_DIR, 'wallets')), false);
});

test('a new wallet is refused beside an unreadable registry before any phrase is written', async () => {
  const manager = box();
  manager.registry.loadError = { message: 'Unreadable registry' };
  let probed = false;
  manager._refuseWrongChain = async () => { probed = true; };
  await assert.rejects(
    manager.createWallet({ name: 'My wallet', network: 'regtest', electrum: ELECTRUM, onchainOnly: true }),
    (error) => error.statusCode === 409 && error.code === 'REGISTRY_UNREADABLE'
  );
  assert.equal(probed, false, 'refused before any server is dialled');
  assert.equal(manager.registry.list().length, 0);
  assert.equal(fs.existsSync(path.join(DATA_DIR, 'wallets')), false);
});

test('concurrent imports of one seed on one network produce exactly one wallet', async () => {
  const manager = box();
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  manager._refuseWrongChain = () => gate;
  const first = restore(manager);
  const second = restore(manager);
  release();
  const results = await Promise.allSettled([first, second]);
  assert.equal(results.filter((result) => result.status === 'fulfilled').length, 1);
  const rejected = results.find((result) => result.status === 'rejected');
  refusedWithoutSeed('WALLET_ALREADY_EXISTS')(rejected.reason);
  assert.equal(manager.registry.list().length, 1);
  assert.equal(fs.readdirSync(path.join(DATA_DIR, 'wallets')).length, 1);
});


test('a record with an unknown network cannot silently bypass the identity check', async () => {
  const manager = box([{ network: null }]);
  await assert.rejects(restore(manager), refusedWithoutSeed('WALLET_IDENTITY_UNAVAILABLE'));
  assert.equal(manager.registry.list().length, 1);
});
