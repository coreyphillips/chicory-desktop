"use strict";

const native = require('node:fs');
const path = require('node:path');
const { fileURLToPath } = require('node:url');
const { randomBytes, hkdfSync, createCipheriv, createDecipheriv, timingSafeEqual } = require('node:crypto');
const { Readable } = require('node:stream');
const MAGIC = Buffer.from('CHICORYVAULT1');
const VAULT_FORMAT = 1;
const HEADER_SIZE = MAGIC.length + 12 + 16;
let context = null;

function failure(message = 'Encrypted wallet storage could not be opened.') {
  return Object.assign(new Error(message), { code: 'VAULT_UNAVAILABLE' });
}
function derive(key, purpose) {
  return Buffer.from(hkdfSync('sha256', key, Buffer.from('chicory-desktop-vault-v1'), Buffer.from(purpose), 32));
}
function canonical(relative) {
  return relative.replaceAll(path.sep, '/').replace(/\.vault-tmp-[a-f0-9]+$/, '').replace(/(?:\.\d+)?\.tmp$/, '');
}
function isDatabaseFile(file) {
  const name = path.basename(String(file));
  // A directory name cannot opt its descendants out of file encryption.
  // Restore markers and backup MAC metadata remain protected, including temps.
  if (/\.(?:restored|hmac|mac)(?:[.-]|$)/i.test(name)) return false;
  return /\.(?:db|sqlite)(?:$|[.-])/i.test(name);
}
function isProcessFile(file) { return /(?:\.lock|daemon\.pid)(?:\.tmp)?$/.test(file); }
function location(file) {
  if (!context || typeof file === 'number') return null;
  const value = file instanceof URL ? fileURLToPath(file) : Buffer.isBuffer(file) ? file.toString() : file;
  if (typeof value !== 'string') return null;
  const absolute = path.resolve(value);
  const relative = path.relative(context.root, absolute);
  if (!relative || relative.startsWith('..' + path.sep) || relative === '..' || path.isAbsolute(relative)) return null;
  // Refuse links before following them. A wallet file cannot escape its vault.
  let current = context.root;
  for (const part of relative.split(path.sep)) {
    current = path.join(current, part);
    try { if (native.lstatSync(current).isSymbolicLink()) throw failure('Wallet storage contains an unsupported symbolic link.'); }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
  }
  return { absolute, relative: canonical(relative) };
}
function protectedLocation(file) {
  const result = location(file);
  return result && !isDatabaseFile(result.relative) && !isProcessFile(result.relative) ? result : null;
}
function keyFor(relative) {
  if (context.scope === 'wallet') return derive(context.key, `file:${relative}`);
  const wallet = /^wallets\/([^/]+)\/(.+)$/.exec(relative);
  return wallet ? derive(derive(context.key, `wallet:${wallet[1]}:files`), `file:${wallet[2]}`)
    : derive(derive(context.key, 'manager:files'), `file:${relative}`);
}
function aadPath(relative) {
  if (context.scope === 'wallet') return relative;
  return /^wallets\/[^/]+\/(.+)$/.exec(relative)?.[1] || relative;
}
function seal(bytes, relative) {
  const nonce = randomBytes(12);
  const key = keyFor(relative);
  try {
    const cipher = createCipheriv('aes-256-gcm', key, nonce);
    cipher.setAAD(Buffer.concat([MAGIC, Buffer.from(aadPath(relative))]));
    const body = Buffer.concat([cipher.update(bytes), cipher.final()]);
    return Buffer.concat([MAGIC, nonce, cipher.getAuthTag(), body]);
  } finally { key.fill(0); }
}
function unseal(bytes, relative) {
  if (bytes.length < HEADER_SIZE || !bytes.subarray(0, MAGIC.length).equals(MAGIC)) throw failure();
  const key = keyFor(relative);
  try {
    const decipher = createDecipheriv('aes-256-gcm', key, bytes.subarray(MAGIC.length, MAGIC.length + 12));
    decipher.setAAD(Buffer.concat([MAGIC, Buffer.from(aadPath(relative))]));
    decipher.setAuthTag(bytes.subarray(MAGIC.length + 12, HEADER_SIZE));
    return Buffer.concat([decipher.update(bytes.subarray(HEADER_SIZE)), decipher.final()]);
  } catch { throw failure(); }
  finally { key.fill(0); }
}
function flushDirectory(dir) {
  if (process.platform === 'win32') return;
  const fd = native.openSync(dir, 'r');
  try { native.fsyncSync(fd); } finally { native.closeSync(fd); }
}
function atomicWriteFileSync(file, data, options) {
  const target = protectedLocation(file);
  if (!target) throw failure('Encrypted file writes require a wallet storage path.');
  const encoding = typeof options === 'string' ? options : options?.encoding || 'utf8';
  const bytes = Buffer.isBuffer(data) ? data : Buffer.from(data, encoding);
  const sealed = seal(bytes, target.relative);
  native.mkdirSync(path.dirname(target.absolute), { recursive: true, mode: 0o700 });
  const temporary = `${target.absolute}.vault-tmp-${randomBytes(8).toString('hex')}`;
  let fd;
  try {
    fd = native.openSync(temporary, 'wx', 0o600);
    native.writeFileSync(fd, sealed); native.fsyncSync(fd); native.closeSync(fd); fd = undefined;
    const check = unseal(native.readFileSync(temporary), target.relative);
    if (check.length !== bytes.length || !timingSafeEqual(check, bytes)) throw failure('Encrypted wallet write verification failed.');
    if (typeof options === 'object' && options?.flag?.includes('x')) {
      native.linkSync(temporary, target.absolute); native.unlinkSync(temporary);
    } else native.renameSync(temporary, target.absolute);
    if (process.platform === 'win32') {
      const committed = native.openSync(target.absolute, 'r+');
      try { native.fsyncSync(committed); } finally { native.closeSync(committed); }
    }
    flushDirectory(path.dirname(target.absolute));
  } finally {
    if (fd !== undefined) native.closeSync(fd);
    try { native.unlinkSync(temporary); } catch (error) { if (error.code !== 'ENOENT') throw error; }
  }
}
function readFileSync(file, options) {
  const target = protectedLocation(file);
  if (!target) return native.readFileSync(file, options);
  const plain = unseal(native.readFileSync(file), target.relative);
  const encoding = typeof options === 'string' ? options : options?.encoding;
  return encoding ? plain.toString(encoding) : plain;
}
function writeFileSync(file, data, options) {
  if (!protectedLocation(file)) return native.writeFileSync(file, data, options);
  if (typeof options === 'object' && options?.flag?.startsWith('a')) return appendFileSync(file, data, options);
  return atomicWriteFileSync(file, data, options);
}
function appendFileSync(file, data, options) {
  if (!protectedLocation(file)) return native.appendFileSync(file, data, options);
  let previous;
  try { previous = readFileSync(file); } catch (error) { if (error.code !== 'ENOENT') throw error; previous = Buffer.alloc(0); }
  const encoding = typeof options === 'string' ? options : options?.encoding || 'utf8';
  atomicWriteFileSync(file, Buffer.concat([previous, Buffer.isBuffer(data) ? data : Buffer.from(data, encoding)]));
}
function renameSync(from, to) {
  const source = protectedLocation(from), target = protectedLocation(to);
  if (!source && !target) return native.renameSync(from, to);
  if (!source || !target) throw failure('Encrypted wallet files cannot be moved outside their storage boundary.');
  if (source.relative === target.relative) return native.renameSync(from, to);
  atomicWriteFileSync(to, readFileSync(from));
  native.unlinkSync(from);
}
function copyFileSync(from, to, flags) {
  const source = protectedLocation(from), target = protectedLocation(to);
  if (!source && !target) return native.copyFileSync(from, to, flags);
  if (!source || !target) throw failure('Encrypted wallet files require an explicit encrypted export.');
  return atomicWriteFileSync(to, readFileSync(from), { flag: flags & native.constants.COPYFILE_EXCL ? 'wx' : 'w' });
}
function configureVault({ root, key, scope = 'manager' }) {
  if (!Buffer.isBuffer(key) || key.length !== 32) throw failure('A valid protected wallet storage key is required.');
  clearVault();
  native.mkdirSync(root, { recursive: true, mode: 0o700 });
  if (native.lstatSync(root).isSymbolicLink()) throw failure('Wallet storage must not be a symbolic link.');
  context = { root: path.resolve(root), key: Buffer.from(key), scope };
}
function clearVault() { if (context) context.key.fill(0); context = null; }
function engineKeys(id) {
  if (!context || context.scope !== 'manager' || !/^[A-Za-z0-9_-]+$/.test(id)) throw failure();
  return { filesKey: derive(context.key, `wallet:${id}:files`).toString('hex'),
    databaseKey: derive(context.key, `wallet:${id}:database`).toString('hex'),
    filesRoot: path.join(context.root, 'wallets', id) };
}
function walk(dir) {
  const files = [];
  const directories = [dir];
  let inspected = 0;
  while (directories.length) {
    const current = directories.pop();
    for (const entry of native.readdirSync(current, { withFileTypes: true })) {
      if (++inspected > 100000) throw failure('Wallet storage is too large to inspect safely.');
      const file = path.join(current, entry.name);
      if (entry.isSymbolicLink()) throw failure('Wallet storage contains an unsupported symbolic link.');
      if (entry.isDirectory()) directories.push(file);
      else if (entry.isFile()) files.push(file);
      else throw failure('Wallet storage contains an unsupported entry.');
    }
  }
  return files;
}
function initializeVault() {
  if (!context || context.scope !== 'manager') throw failure();
  const marker = path.join(context.root, '.vault-v1');
  let state;
  try { state = JSON.parse(readFileSync(marker, 'utf8')); }
  catch (error) { if (error.code !== 'ENOENT') throw failure(); }
  const files = walk(context.root);
  if (!state) {
    if (files.length) throw failure('Wallet storage is not empty and has no valid encrypted vault marker. No files were changed.');
    atomicWriteFileSync(marker, JSON.stringify({ version: VAULT_FORMAT }));
    return;
  }
  if (state.version !== VAULT_FORMAT || Object.keys(state).length !== 1) throw failure();
  for (const file of files) {
    if (isProcessFile(file)) continue;
    if (isDatabaseFile(file)) {
      if (/(?:-wal|-shm|-journal)$/.test(file)) continue;
      const fd = native.openSync(file, 'r');
      const header = Buffer.alloc(16);
      try { native.readSync(fd, header, 0, 16, 0); } finally { native.closeSync(fd); }
      if (header.toString('binary') === 'SQLite format 3\0') throw failure('Unexpected unencrypted wallet database was found. No files were changed.');
    } else readFileSync(file);
  }
}
function rejectRaw(file) {
  if (protectedLocation(file)) throw failure('Raw file access is not allowed for encrypted wallet data.');
}
const overrides = { readFileSync, writeFileSync, appendFileSync, renameSync, copyFileSync,
  openSync(file, flags, mode) {
    rejectRaw(file);
    return native.openSync(file, flags, mode);
  },
  createReadStream(file, options) {
    if (!protectedLocation(file)) return native.createReadStream(file, options);
    const stream = Readable.from([readFileSync(file)]);
    if (options?.encoding) stream.setEncoding(options.encoding);
    return stream;
  },
  createWriteStream(file, options) {
    if (protectedLocation(file)) throw failure('Streaming wallet writes need an encrypted storage adapter.');
    return native.createWriteStream(file, options);
  },
};
overrides.truncateSync = (file, ...args) => { rejectRaw(file); return native.truncateSync(file, ...args); };
overrides.linkSync = (from, to) => { rejectRaw(from); rejectRaw(to); return native.linkSync(from, to); };
const asyncOperations = ['readFile', 'writeFile', 'appendFile', 'rename', 'copyFile', 'open', 'truncate', 'link'];
const promises = new Proxy(native.promises, { get(target, name) {
  if (asyncOperations.includes(name)) return async (...args) => {
    // Native FileHandle objects bypass the encrypted file adapter.
    if (name === 'open') { rejectRaw(args[0]); return target.open(...args); }
    return overrides[`${name}Sync`](...args);
  };
  return target[name];
} });
for (const name of asyncOperations) overrides[name] = (...args) => {
  const callback = args.pop();
  if (typeof callback !== 'function') throw new TypeError('A callback is required.');
  let result;
  try { result = overrides[`${name}Sync`](...args); }
  catch (error) { queueMicrotask(() => callback(error)); return; }
  queueMicrotask(() => callback(null, result));
};
overrides.promises = promises;
const facade = new Proxy(native, { get(target, name) { return overrides[name] || target[name]; } });
module.exports = { fs: facade, MAGIC, VAULT_FORMAT, configureVault, clearVault, engineKeys, initializeVault,
  atomicWriteFileSync, isDatabaseFile, isActive: () => !!context, protects: file => !!protectedLocation(file) };
