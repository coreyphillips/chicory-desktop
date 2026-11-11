'use strict';

/**
 * Run with: npm test (from server/).
 *
 * A full backup taken under one profile's master key restores into a fresh
 * profile under a different one, as on another computer or OS account: the
 * databases come back readable only under the new profile's keys, with the
 * engine's restore marker that holds every open channel, and every refusal
 * leaves nothing behind (issue #10).
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');

const DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'chicory-full-backup-'));
process.env.DATA_DIR = DATA_DIR;
const vault = require('./vault-files');
const storage = require('./engine-storage.cjs');
const { WalletManager } = require('./wallet-manager');
const { openPaymentNotes } = require('./payment-notes');
const { buildPayload } = require('./backup');

const driverRoot = path.resolve(__dirname, '../.runtime/engine/node_modules/better-sqlite3-multiple-ciphers');
const available = fs.existsSync(path.join(driverRoot, 'build/Release/better_sqlite3.node'));
const PASSPHRASE = 'a long and private backup passphrase';
const PHRASE = 'abandon ability able about above absent absorb abstract absurd abuse access accident';
const ID = '11111111-2222-4333-8444-555555555555';
const CHANNEL = 'channel 7a9 with peer 02ab, commitment 41';

test.after(() => { vault.clearVault(); fs.rmSync(DATA_DIR, { recursive: true, force: true }); });

/** A fresh profile: an empty data directory under its own master key. */
async function profile() {
  vault.clearVault();
  fs.rmSync(DATA_DIR, { recursive: true, force: true });
  fs.mkdirSync(DATA_DIR, { recursive: true });
  vault.configureVault({ root: DATA_DIR, key: crypto.randomBytes(32) });
  await vault.initializeVault();
  const manager = new WalletManager();
  manager.settings.load();
  manager.registry.load();
  manager._portsFree = async () => true;
  manager._log = () => {};
  return manager;
}

/** One wallet as the engine leaves it: encrypted secrets, an SQLCipher database, a channel backup and history. */
function seedWallet(manager, { id = ID, phrase = PHRASE, nodeId = '03' + 'c'.repeat(64) } = {}) {
  const p = manager.paths(id);
  for (const dir of [p.home, p.data, p.secrets]) fs.mkdirSync(dir, { recursive: true });
  vault.fs.writeFileSync(p.mnemonicFile, phrase);
  vault.fs.writeFileSync(p.tokenFile, 'ab'.repeat(32));
  const db = storage.openEncryptedDatabase(path.join(p.data, 'regtest.db'), vault.engineKeys(id).databaseKey, { driverRoot });
  db.pragma('journal_mode=WAL');
  db.exec('CREATE TABLE channels(value TEXT)');
  db.prepare('INSERT INTO channels VALUES (?)').run(CHANNEL);
  db.close();
  vault.fs.writeFileSync(path.join(p.data, 'channels.scb'), 'static channel backup');
  vault.fs.writeFileSync(path.join(p.base, 'channel-events.jsonl'), '{"kind":"opened"}\n');
  manager.registry.upsert({ id, name: 'Everyday', network: 'regtest', port: 3101, running: true, nodeId, lfbw: { enabled: true } });
}

function channels(manager, id = ID) {
  const db = storage.openEncryptedDatabase(path.join(manager.paths(id).data, 'regtest.db'), vault.engineKeys(id).databaseKey, { driverRoot, readonly: true });
  try { return db.prepare('SELECT value FROM channels').all().map(row => row.value); } finally { db.close(); }
}

test('a full backup restores into a fresh profile with a different master key, held until proven current', { skip: !available }, async () => {
  const source = await profile();
  seedWallet(source);
  openPaymentNotes(source, ID, 'regtest').save({ key: 'activity:one', note: { text: 'only on this device' } });
  const settingsArchive = buildPayload({ dataDir: DATA_DIR, walletIds: [ID] });
  assert.equal(settingsArchive.files.some(file => file.path.includes('payment-notes')), false);
  const { archive, walletCount } = await source.exportFullBackup({ passphrase: PASSPHRASE });
  assert.equal(walletCount, 1);
  assert.equal(archive.includes(Buffer.from(CHANNEL)), false);
  assert.equal(archive.includes(Buffer.from(PHRASE)), false);
  assert.equal(fs.readdirSync(DATA_DIR).some(name => name.startsWith('.full-backup-')), false, 'no staged copy is left');
  const sourceKey = vault.engineKeys(ID).databaseKey;

  const fresh = await profile();
  assert.notEqual(vault.engineKeys(ID).databaseKey, sourceKey, 'the new profile has its own keys');
  const preview = fresh.inspectFullBackup({ passphrase: PASSPHRASE, archive: archive.toString('base64') });
  assert.deepEqual(preview.wallets.map(w => [w.id, w.action, w.databases]), [[ID, 'restore', ['regtest.db']]]);
  assert.equal(fs.existsSync(fresh.paths(ID).base), false, 'inspecting writes nothing');

  const result = await fresh.restoreFullBackup({ passphrase: PASSPHRASE, archive: archive.toString('base64') });
  assert.deepEqual(result.restored.map(w => w.id), [ID]);
  assert.deepEqual(result.failed, []);
  assert.deepEqual(openPaymentNotes(fresh, ID, 'regtest').read(), [], 'the restored wallet has no device-local notes');
  assert.deepEqual(channels(fresh), [CHANNEL], 'the database reads under the new profile key');
  assert.throws(() => storage.verifyDatabase(path.join(fresh.paths(ID).data, 'regtest.db'), sourceKey, { driverRoot }));
  const marker = JSON.parse(vault.fs.readFileSync(path.join(fresh.paths(ID).data, 'regtest.db.restored'), 'utf8'));
  assert.equal(typeof marker.restoredAt, 'number', 'the engine holds every open channel on its next boot');
  assert.equal(vault.fs.readFileSync(fresh.paths(ID).mnemonicFile, 'utf8'), PHRASE);
  assert.equal(vault.fs.readFileSync(path.join(fresh.paths(ID).data, 'channels.scb'), 'utf8'), 'static channel backup');
  assert.equal(vault.fs.readFileSync(path.join(fresh.paths(ID).base, 'channel-events.jsonl'), 'utf8'), '{"kind":"opened"}\n');
  const record = fresh.registry.get(ID);
  assert.equal(record.running, false, 'restored wallets wait stopped');
  assert.equal(record.network, 'regtest');
  for (const name of fs.readdirSync(fresh.paths(ID).data)) assert.equal(name.startsWith('.chicory-import-'), false);

  const again = await fresh.restoreFullBackup({ passphrase: PASSPHRASE, archive: archive.toString('base64') });
  assert.deepEqual(again.restored, []);
  assert.deepEqual(again.skipped.map(w => w.id), [ID], 'a wallet already here is left as it is');
});

test('a wrong passphrase, a changed byte or a short passphrase writes nothing', { skip: !available }, async () => {
  const source = await profile();
  seedWallet(source);
  await assert.rejects(source.exportFullBackup({ passphrase: 'too short' }), { code: 'PASSPHRASE_TOO_SHORT' });
  const { archive } = await source.exportFullBackup({ passphrase: PASSPHRASE });
  const fresh = await profile();
  await assert.rejects(fresh.restoreFullBackup({ passphrase: 'not the right passphrase', archive }), { code: 'BAD_PASSPHRASE' });
  const changed = Buffer.from(archive);
  changed[changed.length - 40] ^= 1;
  await assert.rejects(fresh.restoreFullBackup({ passphrase: PASSPHRASE, archive: changed }), { code: 'BAD_ARCHIVE' });
  await assert.rejects(fresh.restoreFullBackup({ passphrase: PASSPHRASE, archive: archive.subarray(0, 100) }), { code: 'BAD_ARCHIVE' });
  assert.equal(fs.existsSync(fresh.paths(ID).base), false);
  assert.deepEqual(fresh.registry.list(), []);
});

test('a node already here under another record is refused, so its channel state is never doubled', { skip: !available }, async () => {
  const source = await profile();
  seedWallet(source);
  const { archive } = await source.exportFullBackup({ passphrase: PASSPHRASE });
  const fresh = await profile();
  seedWallet(fresh, { id: '99999999-2222-4333-8444-555555555555' });
  await assert.rejects(fresh.restoreFullBackup({ passphrase: PASSPHRASE, archive }), (error) => {
    assert.equal(error.code, 'DUPLICATE_NODE_ID');
    assert.match(error.message, /nothing was restored/);
    return true;
  });
  assert.equal(fs.existsSync(fresh.paths(ID).base), false);
  assert.deepEqual(fresh.registry.list().map(w => w.id), ['99999999-2222-4333-8444-555555555555']);
});

test('a failure part way through removes the wallet it was writing and reports it', { skip: !available }, async () => {
  const source = await profile();
  seedWallet(source);
  const { archive } = await source.exportFullBackup({ passphrase: PASSPHRASE });
  const fresh = await profile();
  // An interrupted earlier attempt left a directory with no record.
  fs.mkdirSync(path.join(fresh.paths(ID).data), { recursive: true });
  fs.writeFileSync(path.join(fresh.paths(ID).data, 'leftover'), 'partial');
  const original = storage.rekeyDatabase;
  storage.rekeyDatabase = () => { throw Object.assign(new Error('no space left on device'), { code: 'ENOSPC' }); };
  try {
    const result = await fresh.restoreFullBackup({ passphrase: PASSPHRASE, archive });
    assert.deepEqual(result.restored, []);
    assert.deepEqual(result.failed.map(w => [w.id, w.code, w.message]), [[ID, 'ENOSPC', 'The disk is full.']]);
  } finally { storage.rekeyDatabase = original; }
  assert.equal(fs.existsSync(fresh.paths(ID).base), false, 'nothing half-written is left to open');
  assert.equal(fresh.registry.get(ID), undefined);
  const retry = await fresh.restoreFullBackup({ passphrase: PASSPHRASE, archive });
  assert.deepEqual(retry.restored.map(w => w.id), [ID], 'a retry restores it');
  assert.deepEqual(channels(fresh), [CHANNEL]);
});

test('without encrypted desktop storage a full backup is refused plainly', async () => {
  vault.clearVault();
  const manager = Object.create(WalletManager.prototype);
  await assert.rejects(manager.exportFullBackup({ passphrase: PASSPHRASE }), { code: 'FULL_BACKUP_UNAVAILABLE' });
});
