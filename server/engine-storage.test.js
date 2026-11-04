'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { execFileSync } = require('node:child_process');
const {
  openEncryptedDatabase, verifyDatabase, rekeyDatabase,
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

function folder(t, handles = new Set()) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'chicory-engine-storage-test-'));
  t.after(() => {
    // Windows refuses to remove an open database. Keep handle and directory
    // disposal in one hook so assertion failures cannot reverse their order.
    for (const database of handles) if (database.open) database.close();
    fs.rmSync(root, { recursive: true, force: true });
  });
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
  const handles = new Set();
  const file = path.join(folder(t, handles), 'wallet.db');
  const db = openEncryptedDatabase(file, key, options);
  handles.add(db);
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
  handles.add(reopened);
  assert.equal(reopened.prepare('SELECT metadata FROM channels').get().metadata, secret);
  reopened.close();
  if (process.platform !== 'win32') assert.equal(fs.statSync(file).mode & 0o777, 0o600);
});

test('missing keys never create a file and wrong keys never reset stored data', { skip: !available }, (t) => {
  const handles = new Set();
  const file = path.join(folder(t, handles), 'wallet.db');
  failsSafely(() => openEncryptedDatabase(file, undefined, options), 'WALLET_STORAGE_KEY_REQUIRED');
  assert.equal(fs.existsSync(file), false);
  const db = openEncryptedDatabase(file, key, options);
  handles.add(db);
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
  const handles = new Set();
  const file = path.join(folder(t, handles), 'plaintext.db');
  const db = plain(file);
  handles.add(db);
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
  const handles = new Set();
  const root = folder(t, handles), file = path.join(root, 'wallet.db'), backup = path.join(root, 'backup.sqlite');
  const db = openEncryptedDatabase(file, key, options);
  handles.add(db);
  db.pragma('journal_mode=WAL');
  db.exec('CREATE TABLE channels(value TEXT)');
  db.prepare('INSERT INTO channels VALUES (?)').run(secret);
  const result = await db.backup(backup);
  assert.equal(result.remainingPages, 0);
  encryptedOnDisk(backup);
  const copied = openEncryptedDatabase(backup, key, options);
  handles.add(copied);
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
  const handles = new Set();
  const file = path.join(folder(t, handles), 'wallet.db');
  const db = openEncryptedDatabase(file, key, options);
  handles.add(db);
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
  const handles = new Set();
  const file = path.join(folder(t, handles), 'wallet.db');
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
  handles.add(db);
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

test('a database moves to a new key with no plaintext copy, and a wrong key or occupied destination changes nothing', { skip: !available }, (t) => {
  const handles = new Set();
  const root = folder(t, handles), file = path.join(root, 'wallet.db'), moved = path.join(root, 'moved.db');
  const db = openEncryptedDatabase(file, key, options);
  handles.add(db);
  db.pragma('journal_mode=WAL');
  db.exec('CREATE TABLE channels(value TEXT)');
  db.prepare('INSERT INTO channels VALUES (?)').run(secret);
  // A live writer holds the source open with uncheckpointed WAL commits.
  db.prepare('INSERT INTO channels VALUES (?)').run('after-wal-commit');
  const newKey = crypto.randomBytes(32).toString('hex');
  rekeyDatabase(file, key, moved, newKey, options);
  encryptedOnDisk(moved);
  failsSafely(() => verifyDatabase(moved, key, options), 'WALLET_STORAGE_LOCKED');
  const reopened = openEncryptedDatabase(moved, newKey, options);
  handles.add(reopened);
  assert.deepEqual(reopened.prepare('SELECT value FROM channels ORDER BY rowid').all().map(row => row.value), [secret, 'after-wal-commit']);
  reopened.close();
  for (const name of fs.readdirSync(root)) assert.equal(name.includes('chicory-rekey'), false, 'no staged copy is left');
  failsSafely(() => rekeyDatabase(file, wrongKey, path.join(root, 'wrong.db'), newKey, options), 'WALLET_STORAGE_REKEY_FAILED');
  assert.equal(fs.existsSync(path.join(root, 'wrong.db')), false);
  const before = fs.readFileSync(moved);
  failsSafely(() => rekeyDatabase(file, key, moved, newKey, options), 'WALLET_STORAGE_REKEY_FAILED');
  assert.deepEqual(fs.readFileSync(moved), before, 'an existing destination is never replaced');
});
