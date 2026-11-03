'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { execFileSync } = require('node:child_process');
const {
  openEncryptedDatabase, verifyDatabase,
  isDatabaseFile, isDatabaseSidecar, isPlaintextDatabase,
} = require('./engine-storage.cjs');

const runtime = path.resolve(__dirname, '../.runtime');
const driverRoot = path.join(runtime, 'engine/node_modules/better-sqlite3-multiple-ciphers');
const nativeBinding = path.join(driverRoot, 'build/Release/better_sqlite3.node');
// This suite runs against the same bundled native driver shipped in the app.
// CI provisions it with runtime:prepare before running storage tests.
const available = fs.existsSync(nativeBinding);
const options = { driverRoot };
const key = crypto.randomBytes(32).toString('hex');
const wrongKey = crypto.randomBytes(32).toString('hex');
const secret = 'private-wallet-channel-and-seed-metadata-563b8d0a';
const header = Buffer.from('SQLite format 3\0');

function folder(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'chicory-engine-storage-test-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return root;
}
function plain(file) { return new (require(driverRoot))(file, { nativeBinding }); }
function encryptedOnDisk(file) {
  const bytes = fs.readFileSync(file);
  assert.equal(bytes.subarray(0, 16).equals(header), false);
  assert.equal(bytes.includes(Buffer.from(secret)), false);
}
function failsSafely(fn, code) {
  assert.throws(fn, (error) => {
    assert.equal(error.code, code);
    assert.equal(String(error).includes(key), false);
    assert.equal(String(error).includes(wrongKey), false);
    assert.equal(error.cause, undefined);
    return true;
  });
}

test('classifies engine databases, restore staging, guardian files and sidecars without metadata', () => {
  for (const file of ['bitcoin.db', 'regtest.db-wal', 'set.sqlite', 'testnet.db.pre-restore-123', 'bitcoin.db.pre-capsule-restore-123-shm', 'bitcoin.db.capsule-restore', 'bitcoin.db.restoring']) assert.equal(isDatabaseFile(file), true, file);
  for (const file of ['bitcoin.db.hmac', 'bitcoin.db.hmac.tmp', 'bitcoin.db.mac', 'bitcoin.db.restored', 'bitcoin.db.restored.tmp', 'channels.scb', 'index.json']) assert.equal(isDatabaseFile(file), false, file);
  assert.equal(isDatabaseSidecar('bitcoin.db-wal'), true);
  assert.equal(isDatabaseSidecar('bitcoin.db'), false);
});

test('all database pages and live WAL hide wallet metadata, and commits survive reopen', { skip: !available }, (t) => {
  const file = path.join(folder(t), 'wallet.db');
  const db = openEncryptedDatabase(file, key, options);
  t.after(() => { if (db.open) db.close(); });
  db.pragma('journal_mode=WAL');
  db.pragma('synchronous=FULL');
  db.pragma('wal_autocheckpoint=0');
  db.exec('CREATE TABLE channels(id INTEGER PRIMARY KEY, metadata TEXT, payload BLOB)');
  db.prepare('INSERT INTO channels(metadata,payload) VALUES (?,?)').run(secret, Buffer.alloc(24000, 0x53));
  assert.ok(fs.statSync(file + '-wal').size > 32);
  for (const candidate of fs.readdirSync(path.dirname(file))) encryptedOnDisk(path.join(path.dirname(file), candidate));
  db.close();
  encryptedOnDisk(file);
  assert.equal(verifyDatabase(file, key, options), true);
  const reopened = openEncryptedDatabase(file, key, options);
  assert.equal(reopened.prepare('SELECT metadata FROM channels').get().metadata, secret);
  reopened.close();
  if (process.platform !== 'win32') assert.equal(fs.statSync(file).mode & 0o777, 0o600);
});

test('missing keys never create a file and wrong keys never reset stored data', { skip: !available }, (t) => {
  const file = path.join(folder(t), 'wallet.db');
  failsSafely(() => openEncryptedDatabase(file, undefined, options), 'WALLET_STORAGE_KEY_REQUIRED');
  assert.equal(fs.existsSync(file), false);
  const db = openEncryptedDatabase(file, key, options);
  db.exec('CREATE TABLE secret(value TEXT)');
  db.prepare('INSERT INTO secret VALUES (?)').run(secret);
  db.close();
  const before = fs.readFileSync(file);
  failsSafely(() => openEncryptedDatabase(file, wrongKey, options), 'WALLET_STORAGE_LOCKED');
  failsSafely(() => verifyDatabase(file, wrongKey, options), 'WALLET_STORAGE_LOCKED');
  assert.deepEqual(fs.readFileSync(file), before);
  assert.equal(verifyDatabase(file, key, options), true);
});

test('existing plaintext is refused without changing its contents', { skip: !available }, (t) => {
  const file = path.join(folder(t), 'plaintext.db');
  const db = plain(file);
  db.exec('CREATE TABLE metadata(value TEXT)');
  db.prepare('INSERT INTO metadata VALUES (?)').run(secret);
  db.close();
  const before = fs.readFileSync(file);
  assert.equal(isPlaintextDatabase(file), true);
  failsSafely(() => openEncryptedDatabase(file, key, options), 'WALLET_STORAGE_PLAINTEXT_REFUSED');
  failsSafely(() => verifyDatabase(file, key, options), 'WALLET_STORAGE_LOCKED');
  assert.deepEqual(fs.readFileSync(file), before);
});

test('backups stay encrypted while the source is live, reopen correctly and reject unsafe destinations', { skip: !available }, async (t) => {
  const root = folder(t), file = path.join(root, 'wallet.db'), backup = path.join(root, 'backup.sqlite');
  const db = openEncryptedDatabase(file, key, options);
  t.after(() => { if (db.open) db.close(); });
  db.pragma('journal_mode=WAL');
  db.exec('CREATE TABLE channels(value TEXT)');
  db.prepare('INSERT INTO channels VALUES (?)').run(secret);
  const result = await db.backup(backup);
  assert.equal(result.remainingPages, 0);
  encryptedOnDisk(backup);
  const copied = openEncryptedDatabase(backup, key, options);
  assert.equal(copied.prepare('SELECT value FROM channels').get().value, secret);
  copied.close();
  failsSafely(() => verifyDatabase(backup, wrongKey, options), 'WALLET_STORAGE_LOCKED');
  const before = fs.readFileSync(backup);
  fs.writeFileSync(backup + '-wal', 'occupied');
  await assert.rejects(db.backup(backup), { code: 'WALLET_STORAGE_BACKUP_FAILED' });
  assert.deepEqual(fs.readFileSync(backup), before);
  fs.unlinkSync(backup + '-wal');
  await assert.rejects(db.backup(file), { code: 'WALLET_STORAGE_BACKUP_FAILED' });
  await assert.rejects(db.backup(path.join(root, 'unknown.extension')), { code: 'WALLET_STORAGE_BACKUP_FAILED' });
  assert.equal(fs.existsSync(path.join(root, 'unknown.extension')), false);
});

test('tampering with an encrypted page fails closed', { skip: !available }, (t) => {
  const file = path.join(folder(t), 'wallet.db');
  const db = openEncryptedDatabase(file, key, options);
  db.exec('CREATE TABLE metadata(value TEXT)');
  db.prepare('INSERT INTO metadata VALUES (?)').run(secret);
  db.close();
  const bytes = fs.readFileSync(file);
  bytes[4096 + 70] ^= 0x80;
  fs.writeFileSync(file, bytes);
  failsSafely(() => verifyDatabase(file, key, options), 'WALLET_STORAGE_LOCKED');
  assert.deepEqual(fs.readFileSync(file), bytes);
});


test('encrypted commits survive abrupt process exit with an uncheckpointed WAL', { skip: !available }, (t) => {
  const file = path.join(folder(t), 'wallet.db');
  execFileSync(process.execPath, ['-e', `
    const fs = require('node:fs');
    const { openEncryptedDatabase } = require(process.argv[1]);
    const key = JSON.parse(fs.readFileSync(0, 'utf8')).key;
    const db = openEncryptedDatabase(process.argv[2], key, {driverRoot:process.argv[3]});
    db.pragma('journal_mode=WAL'); db.pragma('synchronous=FULL'); db.pragma('wal_autocheckpoint=0');
    db.exec('CREATE TABLE metadata(value TEXT)');
    db.prepare('INSERT INTO metadata VALUES (?)').run(process.argv[4]);
    process.exit(0);
  `, path.join(__dirname, 'engine-storage.cjs'), file, driverRoot, secret], { input: JSON.stringify({ key }) });
  assert.ok(fs.statSync(file + '-wal').size > 0);
  for (const candidate of fs.readdirSync(path.dirname(file))) encryptedOnDisk(path.join(path.dirname(file), candidate));
  const db = openEncryptedDatabase(file, key, options);
  assert.equal(db.prepare('SELECT value FROM metadata').get().value, secret);
  db.close();
  assert.equal(verifyDatabase(file, key, options), true);
});

test('the installed engine encrypts its full wallet and guardian schemas and consumes the bootstrap key', { skip: !available }, (t) => {
  const directory = folder(t);
  const engine = path.join(runtime, 'engine/node_modules/beignet');
  const output = execFileSync(process.execPath, ['-e', `
    const fs=require('node:fs'), path=require('node:path'), crypto=require('node:crypto');
    const root=process.argv[1], dir=process.argv[2];
    const key=crypto.randomBytes(32).toString('hex');
    process.env.CHICORY_DATABASE_KEY=key;
    const {SqliteStorage}=require(path.join(root,'dist/lightning/storage/sqlite-storage.js'));
    const {GuardianStore}=require(path.join(root,'dist/lightning/recovery/guardian-store.js'));
    const {verifyDatabase,isUnlockedDatabase}=require(path.join(root,'dist/lightning/storage/engine-storage.cjs'));
    (async()=>{
      const scratch=new SqliteStorage(':memory:');
      scratch.open(); scratch.saveMetadata('scratch', 'ephemeral');
      if(scratch.loadMetadata('scratch') !== 'ephemeral') throw new Error('In-memory recovery validation failed.');
      scratch.close();
      const store=new SqliteStorage(path.join(dir,'bitcoin.db'));
      store.open(); store.saveMetadata('private-key-label', 'synthetic-wallet-metadata');
      if(process.env.CHICORY_DATABASE_KEY !== undefined) throw new Error('Bootstrap key was retained in the environment.');
      await store.backup(path.join(dir,'backup.db'));
      if(store.loadMetadata('private-key-label') !== 'synthetic-wallet-metadata') throw new Error('Wallet metadata did not round trip.');
      store.close();
      const {writeBackupMac}=require(path.join(root,'dist/cli/backup-mac.js'));
      const {restoreDbFile,isSqliteFile}=require(path.join(root,'dist/cli/restore.js'));
      const macKey=crypto.randomBytes(32);
      await writeBackupMac(macKey,path.join(dir,'backup.db'));
      if(!isSqliteFile(path.join(dir,'backup.db'))) throw new Error('Patched restore guard rejected an encrypted database.');
      await restoreDbFile(path.join(dir,'backup.db'),path.join(dir,'restored.db'),{macKey});
      verifyDatabase(path.join(dir,'restored.db'),key);
      const guardian=new GuardianStore(path.join(dir,'guardian.sqlite')); guardian.close();
      for(const file of ['bitcoin.db','backup.db','guardian.sqlite']) {
        verifyDatabase(path.join(dir,file),key);
        const bytes=fs.readFileSync(path.join(dir,file));
        if(bytes.includes(Buffer.from('synthetic-wallet-metadata')) || bytes.subarray(0,16).equals(Buffer.from('SQLite format 3\\0'))) throw new Error('Plaintext persisted.');
      }
      if(!isUnlockedDatabase(path.join(dir,'backup.db'))) throw new Error('Encrypted restore guard rejected a valid backup.');
      console.log('verified');
    })().catch(()=>{ console.error('Installed wallet storage verification failed.'); process.exitCode=1; });
  `, engine, directory], { encoding: 'utf8', timeout: 30000 });
  assert.equal(output.trim(), 'verified');
});
