'use strict';

/**
 * Run with: npm test (from server/).
 *
 * A wallet on another network can reuse the recovery phrase of a wallet it
 * names, inside the local service, so the phrase never passes through the
 * page. The reference must match, the network must differ, and a source that
 * is missing or unreadable stops creation rather than making a new phrase
 * (issue #2).
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'chicory-related-'));
process.env.DATA_DIR = DATA_DIR;
const { WalletManager } = require('./wallet-manager');

const ELECTRUM = { host: '127.0.0.1', port: 60401, tls: false };
test.after(() => fs.rmSync(DATA_DIR, { recursive: true, force: true }));

function box() {
  fs.rmSync(DATA_DIR, { recursive: true, force: true });
  fs.mkdirSync(DATA_DIR, { recursive: true });
  const manager = new WalletManager();
  manager.settings.load();
  manager.registry.load();
  manager._refuseWrongChain = async () => {};
  manager.startWallet = async () => {};
  manager._portsFree = async () => true;
  manager._log = () => {};
  return manager;
}
const phraseOf = (manager, id) => fs.readFileSync(manager.paths(id).mnemonicFile, 'utf8').trim();
const create = (manager, options) => manager.createWallet({ name: 'Wallet', electrum: ELECTRUM, onchainOnly: true, ...options });
function noPhrase(code, ...phrases) {
  return (error) => {
    assert.equal(error.code, code);
    for (const phrase of phrases) {
      assert.equal(error.message.includes(phrase.split(' ')[0] + ' ' + phrase.split(' ')[1]), false);
      assert.equal(JSON.stringify(error).includes(phrase), false);
    }
    return true;
  };
}

test('a related wallet on another network reuses the named wallet\'s phrase and joins its family', async () => {
  const manager = box();
  const { record: source, mnemonic } = await create(manager, { name: 'Everyday', network: 'regtest' });
  const related = await create(manager, { name: 'Everyday testnet', network: 'testnet', seedFrom: { walletId: source.id, network: 'regtest' } });
  assert.equal(related.mnemonic, undefined, 'the phrase is not sent back: there is nothing new to save');
  assert.deepEqual(related.seedFrom, { walletId: source.id, name: 'Everyday', network: 'regtest' });
  assert.equal(phraseOf(manager, related.record.id), mnemonic);
  assert.equal(related.record.familyId, source.familyId);
  assert.equal(source.familyId, source.id, 'a wallet made with its own phrase starts its own family');
  assert.equal(phraseOf(manager, source.id), mnemonic, 'the source is left as it was');
  assert.equal(manager.registry.get(source.id).network, 'regtest', 'no existing record is retagged');

  const separate = await create(manager, { name: 'Separate', network: 'testnet' });
  assert.notEqual(phraseOf(manager, separate.record.id), mnemonic, 'an explicitly separate wallet has its own phrase');
  assert.notEqual(separate.record.familyId, source.familyId);
});

test('a missing, mismatched or same-network source stops creation and makes no phrase', async () => {
  const manager = box();
  const { record: source, mnemonic } = await create(manager, { name: 'Everyday', network: 'regtest' });
  const count = () => manager.registry.list().length;
  await assert.rejects(create(manager, { network: 'testnet', seedFrom: { walletId: 'not-here', network: 'regtest' } }), noPhrase('SEED_SOURCE_MISSING', mnemonic));
  await assert.rejects(create(manager, { network: 'testnet', seedFrom: { walletId: source.id, network: 'mainnet' } }), noPhrase('SEED_SOURCE_MISMATCH', mnemonic));
  // Once a wallet has started, its node id binds the reference too.
  manager.registry.upsert({ ...manager.registry.get(source.id), nodeId: '03' + 'b'.repeat(64) });
  await assert.rejects(create(manager, { network: 'testnet', seedFrom: { walletId: source.id, network: 'regtest', nodeId: '02' + 'a'.repeat(64) } }), noPhrase('SEED_SOURCE_MISMATCH', mnemonic));
  await assert.rejects(create(manager, { network: 'regtest', seedFrom: { walletId: source.id, network: 'regtest' } }), noPhrase('SEED_SOURCE_SAME_NETWORK', mnemonic));
  await assert.rejects(create(manager, { network: 'testnet', seedFrom: 'everyday' }), { code: 'BAD_SEED_SOURCE' });
  assert.equal(count(), 1, 'nothing was created');
});

test('an unreadable source phrase stops creation rather than making a replacement seed', async () => {
  const manager = box();
  const { record: source } = await create(manager, { name: 'Everyday', network: 'regtest' });
  fs.writeFileSync(manager.paths(source.id).mnemonicFile, 'not a valid recovery phrase at all');
  await assert.rejects(create(manager, { network: 'testnet', seedFrom: { walletId: source.id, network: 'regtest' } }), { code: 'SEED_SOURCE_UNREADABLE' });
  fs.rmSync(manager.paths(source.id).mnemonicFile);
  await assert.rejects(create(manager, { network: 'testnet', seedFrom: { walletId: source.id, network: 'regtest' } }), { code: 'SEED_SOURCE_UNREADABLE' });
  assert.equal(manager.registry.list().length, 1);
});

test('a family gets one wallet per network: a second related wallet on that network is refused', async () => {
  const manager = box();
  const { record: source, mnemonic } = await create(manager, { name: 'Everyday', network: 'regtest' });
  await create(manager, { network: 'testnet', seedFrom: { walletId: source.id, network: 'regtest' } });
  await assert.rejects(create(manager, { network: 'testnet', seedFrom: { walletId: source.id, network: 'regtest' } }), noPhrase('WALLET_ALREADY_EXISTS', mnemonic));
  assert.equal(manager.registry.list().length, 2);
});

test('concurrent related creates on one network produce exactly one wallet with the phrase', async () => {
  const manager = box();
  const { record: source } = await create(manager, { name: 'Everyday', network: 'regtest' });
  const results = await Promise.allSettled([1, 2, 3].map(() => create(manager, { network: 'testnet', seedFrom: { walletId: source.id, network: 'regtest' } })));
  assert.equal(results.filter(result => result.status === 'fulfilled').length, 1);
  assert.equal(manager.registry.list().filter(rec => rec.network === 'testnet').length, 1);
});
