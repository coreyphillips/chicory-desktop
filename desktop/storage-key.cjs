'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { randomBytes, timingSafeEqual } = require('node:crypto');

const ENVELOPE_NAME = 'storage-key.json';
const ENVELOPE_VERSION = 1;
const LINUX_BACKENDS = new Set(['gnome_libsecret', 'kwallet', 'kwallet5', 'kwallet6']);
const MAX_ENVELOPE_BYTES = 64 * 1024;
const MAX_INSPECTED_FILES = 100000;

function failure(code, message) {
  return Object.assign(new Error(message), { code });
}

function inspect(file) {
  try { return fs.lstatSync(file); }
  catch (error) { if (error.code === 'ENOENT') return null; throw error; }
}

function readPrivateFile(file, limit) {
  const descriptor = fs.openSync(file, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0));
  try {
    const stat = fs.fstatSync(descriptor);
    if (!stat.isFile() || stat.size > limit)
      throw failure('STORAGE_KEY_INVALID', 'The protected storage key file is invalid. Existing wallet data was preserved.');
    return fs.readFileSync(descriptor);
  } finally { fs.closeSync(descriptor); }
}

/** A missing key must never turn an existing profile into a new wallet. */
function hasWalletData(profile) {
  const directory = path.join(profile, 'wallets');
  const root = inspect(directory);
  if (!root) return false;
  if (!root.isDirectory() || root.isSymbolicLink())
    throw failure('STORAGE_LAYOUT_UNSAFE', 'The wallet storage directory cannot be inspected safely. No new key was created.');
  const directories = [directory];
  let inspected = 0;
  while (directories.length) {
    const current = directories.pop();
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      if (++inspected > MAX_INSPECTED_FILES)
        throw failure('STORAGE_LAYOUT_UNSAFE', 'Wallet storage is too large to inspect safely. No new key was created.');
      const file = path.join(current, entry.name);
      if (entry.isSymbolicLink())
        throw failure('STORAGE_LAYOUT_UNSAFE', 'Wallet storage contains a symbolic link. No new key was created.');
      if (entry.isDirectory()) { directories.push(file); continue; }
      if (!entry.isFile())
        throw failure('STORAGE_LAYOUT_UNSAFE', 'Wallet storage contains an unsupported entry. No new key was created.');
      return true;
    }
  }
  return false;
}

async function requireProtection(safeStorage, platform) {
  if (!safeStorage || typeof safeStorage.isAsyncEncryptionAvailable !== 'function' ||
      typeof safeStorage.encryptStringAsync !== 'function' || typeof safeStorage.decryptStringAsync !== 'function')
    throw failure('STORAGE_PROTECTION_UNAVAILABLE', 'This build cannot use the operating system secure store. Wallet storage stays closed.');
  let available;
  try { available = await safeStorage.isAsyncEncryptionAvailable(); }
  catch { available = false; }
  if (!available)
    throw failure('STORAGE_PROTECTION_UNAVAILABLE', 'The operating system secure store is unavailable. Unlock it and reopen Chicory.');
  if (platform === 'linux') {
    let backend;
    try { backend = safeStorage.getSelectedStorageBackend?.(); } catch {}
    if (!LINUX_BACKENDS.has(backend))
      throw failure('STORAGE_PROTECTION_UNAVAILABLE', 'A supported system keyring is required. Plaintext key storage is not allowed.');
  } else if (platform !== 'darwin' && platform !== 'win32') {
    throw failure('STORAGE_PROTECTION_UNAVAILABLE', 'This operating system has no supported wallet key protection.');
  }
}

function decodeEnvelope(bytes) {
  let envelope;
  try { envelope = JSON.parse(bytes.toString('utf8')); } catch {}
  if (!envelope || envelope.version !== ENVELOPE_VERSION || envelope.provider !== 'electron.safeStorage' ||
      typeof envelope.ciphertext !== 'string' || !envelope.ciphertext ||
      !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(envelope.ciphertext))
    throw failure('STORAGE_KEY_INVALID', 'The protected storage key is damaged or unsupported. Existing wallet data was preserved.');
  const ciphertext = Buffer.from(envelope.ciphertext, 'base64');
  if (!ciphertext.length || ciphertext.toString('base64') !== envelope.ciphertext)
    throw failure('STORAGE_KEY_INVALID', 'The protected storage key is invalid. Existing wallet data was preserved.');
  return ciphertext;
}

async function unwrap(safeStorage, ciphertext) {
  let opened;
  try { opened = await safeStorage.decryptStringAsync(ciphertext); }
  catch {
    throw failure('STORAGE_KEY_UNAVAILABLE', 'The protected wallet key could not be opened by this OS account. Existing wallet data was preserved.');
  }
  if (!opened || typeof opened.result !== 'string' || !/^[a-f0-9]{64}$/.test(opened.result))
    throw failure('STORAGE_KEY_INVALID', 'The protected wallet key has an invalid length or format. Existing wallet data was preserved.');
  return { key: Buffer.from(opened.result, 'hex'), shouldReEncrypt: opened.shouldReEncrypt === true };
}

async function wrap(safeStorage, key) {
  let ciphertext;
  try { ciphertext = await safeStorage.encryptStringAsync(key.toString('hex')); }
  catch { throw failure('STORAGE_KEY_UNAVAILABLE', 'The operating system could not protect the wallet key. No wallet was opened.'); }
  if (!Buffer.isBuffer(ciphertext) || !ciphertext.length || ciphertext.length > MAX_ENVELOPE_BYTES / 2)
    throw failure('STORAGE_KEY_INVALID', 'The secure store returned an invalid protected key. No wallet was opened.');
  // Prove the wrapper can be read before publishing a key that wallet writes
  // would depend on. This check does not expose the master key to the renderer.
  const confirmed = await unwrap(safeStorage, ciphertext);
  try {
    if (!timingSafeEqual(confirmed.key, key))
      throw failure('STORAGE_KEY_INVALID', 'The secure store could not verify the wallet key. No wallet was opened.');
  } finally { confirmed.key.fill(0); }
  return Buffer.from(JSON.stringify({ version: ENVELOPE_VERSION, provider: 'electron.safeStorage', ciphertext: ciphertext.toString('base64') }) + '\n');
}

function persistEnvelope(profile, bytes, { replace = false, platform }) {
  fs.mkdirSync(profile, { recursive: true, mode: 0o700 });
  const file = path.join(profile, ENVELOPE_NAME);
  const temporary = path.join(profile, `.storage-key-${process.pid}-${randomBytes(12).toString('hex')}.tmp`);
  let descriptor;
  try {
    descriptor = fs.openSync(temporary, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | (fs.constants.O_NOFOLLOW || 0), 0o600);
    fs.writeFileSync(descriptor, bytes);
    fs.fsyncSync(descriptor);
    fs.closeSync(descriptor); descriptor = undefined;
    if (replace) {
      const current = inspect(file);
      if (!current?.isFile() || current.isSymbolicLink())
        throw failure('STORAGE_LAYOUT_UNSAFE', 'The protected key file changed during rotation. Wallet storage stays closed.');
      fs.renameSync(temporary, file);
    } else {
      // A hard-link publication is atomic and refuses an existing destination.
      // A second opener cannot replace the key another opener just committed.
      fs.linkSync(temporary, file);
      fs.unlinkSync(temporary);
    }
    const committed = fs.openSync(platform === 'win32' ? file : profile, platform === 'win32' ? 'r+' : 'r');
    try { fs.fsyncSync(committed); } finally { fs.closeSync(committed); }
  } finally {
    if (descriptor !== undefined) fs.closeSync(descriptor);
    try { fs.unlinkSync(temporary); } catch (error) { if (error.code !== 'ENOENT') throw error; }
  }
}

/**
 * Main-process only. Call after app.ready; pass only the resulting key through
 * the manager's private bootstrap channel, never through renderer IPC or env.
 *
 * Electron's async safeStorage uses the OS key provider. DPAPI protects other
 * Windows users, not another app running as this user. macOS Keychain access
 * continuity also requires a consistent signing identity across releases.
 * https://www.electronjs.org/docs/latest/api/safe-storage
 */
async function loadStorageKey({ profile, safeStorage, platform = process.platform }) {
  if (typeof profile !== 'string' || !path.isAbsolute(profile))
    throw failure('STORAGE_LAYOUT_UNSAFE', 'Wallet storage requires an absolute profile directory.');
  await requireProtection(safeStorage, platform);
  const file = path.join(profile, ENVELOPE_NAME);
  const stat = inspect(file);
  if (stat) {
    if (!stat.isFile() || stat.isSymbolicLink())
      throw failure('STORAGE_LAYOUT_UNSAFE', 'The protected wallet key file cannot be opened safely.');
    const opened = await unwrap(safeStorage, decodeEnvelope(readPrivateFile(file, MAX_ENVELOPE_BYTES)));
    try {
      if (opened.shouldReEncrypt) persistEnvelope(profile, await wrap(safeStorage, opened.key), { replace: true, platform });
      return opened.key;
    } catch (error) { opened.key.fill(0); throw error; }
  }
  if (hasWalletData(profile))
    throw failure('STORAGE_KEY_MISSING', 'Wallet data exists but its protected key is missing. No new key or wallet was created.');
  const key = randomBytes(32);
  try {
    persistEnvelope(profile, await wrap(safeStorage, key), { platform });
    return key;
  } catch (error) { key.fill(0); throw error; }
}

module.exports = { loadStorageKey, ENVELOPE_VERSION };
