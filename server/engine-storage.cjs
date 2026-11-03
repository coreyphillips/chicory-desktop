'use strict';

// This module intentionally uses the real filesystem. The manager's encrypted
// file facade must leave SQLite files and their page-encrypted sidecars alone.
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { pathToFileURL } = require('node:url');
const { Worker, isMainThread, parentPort, workerData } = require('node:worker_threads');

const SQLITE_HEADER = Buffer.from('SQLite format 3\0');
const DRIVER_VERSION = '13.0.3';
const drivers = new Map();
let daemonKey;

function storageError(code, message) {
  // Do not retain the original error: SQLite can include the key-bearing
  // VACUUM URI in an error. Neither logs nor IPC may contain that URI.
  const error = new Error(message);
  error.code = code;
  return error;
}

function checkedKey(key) {
  if (typeof key !== 'string' || !/^[0-9a-f]{64}$/i.test(key)) {
    throw storageError('WALLET_STORAGE_KEY_REQUIRED', 'The wallet storage key is unavailable. Unlock the desktop wallet before opening its data.');
  }
  return key.toLowerCase();
}

function environmentKey() {
  if (!daemonKey) {
    const value = process.env.CHICORY_DATABASE_KEY;
    delete process.env.CHICORY_DATABASE_KEY;
    daemonKey = checkedKey(value);
  }
  return daemonKey;
}

function driverRoot(options = {}) {
  if (options.driverRoot) return path.resolve(options.driverRoot);
  try { return path.dirname(require.resolve('better-sqlite3-multiple-ciphers/package.json')); } catch {}
  const candidates = [
    path.resolve(__dirname, '../.runtime/engine/node_modules/better-sqlite3-multiple-ciphers'),
    path.resolve(__dirname, '../runtime/engine/node_modules/better-sqlite3-multiple-ciphers'),
  ];
  if (process.env.BEIGNET_BIN) {
    candidates.unshift(path.resolve(path.dirname(process.env.BEIGNET_BIN), '../../../better-sqlite3-multiple-ciphers'));
  }
  const found = candidates.find((candidate) => fs.existsSync(path.join(candidate, 'package.json')));
  if (!found) throw storageError('WALLET_STORAGE_DRIVER_MISSING', 'The encrypted wallet storage driver is unavailable. Reinstall the desktop app.');
  return found;
}

function loadDriver(options = {}) {
  const root = driverRoot(options);
  if (drivers.has(root)) return drivers.get(root);
  try {
    if (require(path.join(root, 'package.json')).version !== DRIVER_VERSION) throw new Error();
    const Database = require(root);
    // The upstream loader prefers its prebuilds. Always select the reviewed
    // build with URI support, which is required to encrypt exports at creation.
    const nativeBinding = path.join(root, 'build/Release/better_sqlite3.node');
    const probe = new Database(':memory:', { nativeBinding });
    try {
      const flags = probe.pragma('compile_options').map((row) => row.compile_options);
      if (!flags.includes('USE_URI') || !flags.includes('TEMP_STORE=3')) throw new Error();
    } finally { probe.close(); }
    const driver = { Database, nativeBinding, root };
    drivers.set(root, driver);
    return driver;
  } catch {
    throw storageError('WALLET_STORAGE_DRIVER_MISSING', 'The encrypted wallet storage driver failed verification. Reinstall the desktop app.');
  }
}

/** Includes engine backup/restore staging and SQLite sidecars, but not metadata. */
function isDatabaseFile(filename) {
  const name = path.basename(String(filename));
  if (/\.(?:hmac|mac|restored)(?:[.-]|$)/i.test(name)) return false;
  return /\.(?:db|sqlite)(?:$|[.-])/i.test(name);
}

function isDatabaseSidecar(filename) {
  return isDatabaseFile(filename) && /-(?:wal|shm|journal)$/i.test(filename);
}

function isPlaintextDatabase(filename) {
  let fd;
  try {
    fd = fs.openSync(filename, 'r');
    const header = Buffer.alloc(SQLITE_HEADER.length);
    return fs.readSync(fd, header, 0, header.length, 0) === header.length && header.equals(SQLITE_HEADER);
  } finally { if (fd !== undefined) fs.closeSync(fd); }
}

function rawDatabase(filename, options = {}) {
  const driver = loadDriver(options);
  return new driver.Database(filename, {
    nativeBinding: driver.nativeBinding,
    readonly: options.readonly === true,
    fileMustExist: options.fileMustExist === true,
    timeout: options.timeout ?? 5000,
  });
}

function applyKey(database, key) {
  database.pragma("cipher='sqlcipher'");
  database.pragma('legacy=4');
  database.pragma(`key="x'${key}'"`);
  database.pragma('temp_store=MEMORY');
  database.pragma('secure_delete=ON');
  // Setting the key alone does not authenticate it. Force a schema read now.
  database.prepare('SELECT count(*) FROM sqlite_schema').get();
}

function keyedDatabase(filename, key, options = {}) {
  let database;
  try {
    database = rawDatabase(filename, options);
    if (filename === ':memory:') {
      // Beignet uses scratch databases while validating recovery state. SQLite
      // rejects encryption keys on these connections, which never create files.
      database.pragma('temp_store=MEMORY');
      database.pragma('secure_delete=ON');
    } else {
      applyKey(database, key);
    }
    return database;
  } catch {
    if (database?.open) database.close();
    throw storageError('WALLET_STORAGE_LOCKED', 'Wallet data could not be unlocked or failed its integrity check. No wallet data was reset.');
  }
}

function checkIntegrity(database) {
  const result = database.pragma('integrity_check');
  if (result.length !== 1 || result[0].integrity_check !== 'ok') throw new Error();
}

function verifyDatabase(filename, inputKey, options = {}) {
  const key = checkedKey(inputKey);
  let database;
  try {
    if (fs.statSync(filename).size < 16 || isPlaintextDatabase(filename)) throw new Error();
    database = keyedDatabase(filename, key, { ...options, readonly: true, fileMustExist: true });
    checkIntegrity(database);
    return true;
  } catch {
    throw storageError('WALLET_STORAGE_LOCKED', 'Wallet data could not be unlocked or failed its integrity check. No wallet data was reset.');
  } finally { if (database?.open) database.close(); }
}

function fsyncFile(filename) {
  const fd = fs.openSync(filename, 'r+');
  try { fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
}

function fsyncDirectory(directory) {
  // Windows cannot open directory handles through node:fs. File contents are
  // flushed before the atomic rename on every platform.
  if (process.platform === 'win32') return;
  const fd = fs.openSync(directory, 'r');
  try { fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
}

function exportEncrypted(database, destination, key, options) {
  const uri = pathToFileURL(destination);
  uri.searchParams.set('cipher', 'sqlcipher');
  uri.searchParams.set('legacy', '4');
  uri.searchParams.set('key', `x'${key}'`);
  const fd = fs.openSync(destination, 'wx', 0o600);
  fs.closeSync(fd);
  // URI support is a pinned build requirement. Encryption is configured before
  // SQLite writes the first page. No plaintext intermediate database is made.
  database.prepare('VACUUM main INTO ?').run(uri.href);
  verifyDatabase(destination, key, options);
  fs.chmodSync(destination, 0o600);
  fsyncFile(destination);
}

function backupDatabase(source, destination, key, options = {}) {
  let database;
  const staged = `${destination}.chicory-backup-${crypto.randomUUID()}`;
  try {
    if (path.resolve(source) === path.resolve(destination)) throw new Error();
    // Refuse a destination with active SQLite sidecars rather than replacing a
    // live database and allowing its previous WAL to replay onto the backup.
    for (const suffix of ['-wal', '-shm', '-journal']) {
      if (fs.existsSync(`${destination}${suffix}`)) throw new Error();
    }
    database = keyedDatabase(source, key, { ...options, readonly: true, fileMustExist: true });
    const totalPages = database.pragma('page_count', { simple: true });
    exportEncrypted(database, staged, key, options);
    database.close();
    database = undefined;
    fs.renameSync(staged, destination);
    fsyncDirectory(path.dirname(destination));
    return { totalPages, remainingPages: 0 };
  } catch {
    throw storageError('WALLET_STORAGE_BACKUP_FAILED', 'The encrypted wallet backup could not be saved. The previous backup was retained.');
  } finally {
    if (database?.open) database.close();
    try { fs.rmSync(staged, { force: true }); } catch {}
  }
}

function openEncryptedDatabase(filename, inputKey, options = {}) {
  const key = checkedKey(inputKey);
  if (typeof filename !== 'string' || !filename || filename.startsWith('file:')) {
    throw storageError('WALLET_STORAGE_PATH_INVALID', 'Wallet storage requires a local database path.');
  }
  const memory = filename === ':memory:';
  const file = memory ? filename : path.resolve(filename);
  if (!memory && fs.existsSync(file) && fs.statSync(file).size > 0 && isPlaintextDatabase(file)) {
    throw storageError('WALLET_STORAGE_PLAINTEXT_REFUSED', 'Unencrypted wallet data cannot be opened by this desktop build.');
  }
  if (!memory && fs.existsSync(file) && fs.statSync(file).size === 0) {
    // A zero-byte file with sidecars might be a damaged database, not a new one.
    if (['-wal', '-shm', '-journal'].some((suffix) => fs.existsSync(file + suffix))) {
      throw storageError('WALLET_STORAGE_LOCKED', 'Wallet storage is incomplete. No wallet data was reset.');
    }
  }
  const database = keyedDatabase(file, key, options);
  if (!memory) fs.chmodSync(file, 0o600);
  // Never use the native backup implementation, which opens an unkeyed target.
  Object.defineProperty(database, 'backup', { value: (destination, backupOptions = {}) => {
    if (!database.open || memory || typeof destination !== 'string' || !destination ||
        !/\.(?:db|sqlite)$/i.test(destination) || destination.startsWith('file:') ||
        (backupOptions.attached && backupOptions.attached !== 'main')) {
      return Promise.reject(storageError('WALLET_STORAGE_BACKUP_FAILED', 'Encrypted wallet backups require a local file ending in .db or .sqlite.'));
    }
    const driver = loadDriver(options);
    return new Promise((resolve, reject) => {
      const worker = new Worker(__filename, {
        workerData: { kind: 'chicory-encrypted-backup-v1', source: file, destination: path.resolve(destination), key, driverRoot: driver.root },
      });
      let complete = false;
      worker.once('message', (result) => {
        complete = true;
        if (result.ok) resolve(result.progress);
        else reject(storageError('WALLET_STORAGE_BACKUP_FAILED', 'The encrypted wallet backup could not be saved. The previous backup was retained.'));
      });
      worker.once('error', () => {
        complete = true;
        reject(storageError('WALLET_STORAGE_BACKUP_FAILED', 'The encrypted wallet backup worker failed. The previous backup was retained.'));
      });
      worker.once('exit', () => {
        if (!complete) reject(storageError('WALLET_STORAGE_BACKUP_FAILED', 'The encrypted wallet backup worker stopped before completion.'));
      });
    });
  } });
  return database;
}

function isUnlockedDatabase(filename) {
  try { return verifyDatabase(filename, environmentKey()); } catch { return false; }
}

function EncryptedDatabase(filename, options) {
  return openEncryptedDatabase(filename, environmentKey(), options);
}

module.exports = {
  EncryptedDatabase, openEncryptedDatabase, verifyDatabase,
  isDatabaseFile, isDatabaseSidecar, isPlaintextDatabase, isUnlockedDatabase,
};

if (!isMainThread && workerData?.kind === 'chicory-encrypted-backup-v1') {
  try {
    const progress = backupDatabase(workerData.source, workerData.destination, checkedKey(workerData.key), { driverRoot: workerData.driverRoot });
    parentPort.postMessage({ ok: true, progress });
  } catch { parentPort.postMessage({ ok: false }); }
}
