'use strict';

/**
 * The portable full-wallet backup (issue #10). Unlike the identity and
 * settings archive in backup.js, it carries each wallet's channel databases,
 * so a fresh profile on another computer or OS account can take them back.
 *
 * Layout, every field authenticated:
 *
 *   magic "CHICORYFULL1" | format u8 | kdf u8 (1 = scrypt) | logN u8 | r u8 | p u8
 *   | salt 16 | wrapNonce 12 | wrappedKey 32 | wrapTag 16 | dataNonce 12
 *   | AES-256-GCM(exportKey, dataNonce, AAD = header) over the JSON payload | tag 16
 *
 * The export key is 32 random bytes made for this archive alone. The
 * passphrase only unwraps it, through scrypt, so the archive never depends on
 * a profile's OS-protected master key or anything derived from it. Each
 * database inside is SQLCipher under its own key, derived from the export key.
 */
const crypto = require('node:crypto');

const MAGIC = Buffer.from('CHICORYFULL1');
const FORMAT = 1;
const KDF_SCRYPT = 1;
const KIND = 'chicory-full-backup';
const DEFAULT_KDF = Object.freeze({ logN: 17, r: 8, p: 1 });
// Bounds an archive from anywhere is held to before any work: a hostile file
// cannot ask for unbounded memory or time. 2^21 blocks is 256 MiB of scrypt.
const KDF_LIMITS = Object.freeze({ minLogN: 14, maxLogN: 20, maxR: 16, maxP: 4, maxWork: 2 ** 21 });
const MIN_PASSPHRASE = 12;
const MAX_ARCHIVE_BYTES = 256 * 1024 * 1024;
const HEADER_BYTES = MAGIC.length + 5 + 16 + 12 + 32 + 16 + 12;
const TAG_BYTES = 16;
const WALLET_ID = /^[a-zA-Z0-9-]{1,64}$/;
const DATABASE_NAME = /^(?:[a-z0-9_-]{1,32}\.db|guardian\/[a-zA-Z0-9_-]{1,64}\.sqlite)$/;
const DATA_FILES = new Set(['channels.scb']);
const HISTORY_FILES = new Set(['channel-events.jsonl', 'direct-funding-fallbacks.jsonl']);
const BASE64 = /^[A-Za-z0-9+/]*={0,2}$/;

function failure(code, message, status = 400) {
  return Object.assign(new Error(message), { code, statusCode: status });
}

function passphraseBytes(passphrase) {
  if (typeof passphrase !== 'string' || [...passphrase.normalize('NFKC')].length < MIN_PASSPHRASE)
    throw failure('PASSPHRASE_TOO_SHORT', `Use a passphrase of at least ${MIN_PASSPHRASE} characters for a full backup.`);
  return Buffer.from(passphrase.normalize('NFKC'), 'utf8');
}

function checkKdf({ logN, r, p }) {
  const N = 2 ** logN;
  if (!Number.isInteger(logN) || !Number.isInteger(r) || !Number.isInteger(p) ||
      logN < KDF_LIMITS.minLogN || logN > KDF_LIMITS.maxLogN || r < 1 || r > KDF_LIMITS.maxR ||
      p < 1 || p > KDF_LIMITS.maxP || N * r * p > KDF_LIMITS.maxWork)
    throw failure('BAD_ARCHIVE', 'This full backup asks for passphrase work outside the supported bounds.');
  return { N, r, p };
}

function wrappingKey(passphrase, salt, kdf) {
  const { N, r, p } = checkKdf(kdf);
  const secret = passphraseBytes(passphrase);
  try { return crypto.scryptSync(secret, salt, 32, { N, r, p, maxmem: 256 * N * r + 1024 * 1024 }); }
  finally { secret.fill(0); }
}

/** 32 random bytes that key one archive. They never leave the process except wrapped. */
function createExportKey() {
  return crypto.randomBytes(32);
}

/** The SQLCipher key for one database inside one archive, as hex. */
function databaseKey(exportKey, walletId, name) {
  return Buffer.from(crypto.hkdfSync('sha256', exportKey, Buffer.from('chicory-full-backup-v1'),
    Buffer.from(`database:${walletId}:${name}`), 32)).toString('hex');
}

function seal(payload, passphrase, exportKey, { kdf = DEFAULT_KDF } = {}) {
  if (!Buffer.isBuffer(exportKey) || exportKey.length !== 32) throw failure('BAD_KEY', 'The export key is invalid.', 500);
  checkKdf(kdf);
  const salt = crypto.randomBytes(16);
  const wrapNonce = crypto.randomBytes(12);
  const dataNonce = crypto.randomBytes(12);
  const prefix = Buffer.concat([MAGIC, Buffer.from([FORMAT, KDF_SCRYPT, kdf.logN, kdf.r, kdf.p]), salt]);
  const wrapKey = wrappingKey(passphrase, salt, kdf);
  let wrappedKey;
  let wrapTag;
  try {
    const wrap = crypto.createCipheriv('aes-256-gcm', wrapKey, wrapNonce);
    wrap.setAAD(prefix);
    wrappedKey = Buffer.concat([wrap.update(exportKey), wrap.final()]);
    wrapTag = wrap.getAuthTag();
  } finally { wrapKey.fill(0); }
  const header = Buffer.concat([prefix, wrapNonce, wrappedKey, wrapTag, dataNonce]);
  const cipher = crypto.createCipheriv('aes-256-gcm', exportKey, dataNonce);
  cipher.setAAD(header);
  const plaintext = Buffer.from(JSON.stringify(payload), 'utf8');
  try {
    const body = Buffer.concat([cipher.update(plaintext), cipher.final()]);
    const archive = Buffer.concat([header, body, cipher.getAuthTag()]);
    if (archive.length > MAX_ARCHIVE_BYTES)
      throw failure('BACKUP_TOO_LARGE', 'These wallets are too large for one full backup.', 413);
    return archive;
  } finally { plaintext.fill(0); }
}

function readHeader(archive) {
  if (!Buffer.isBuffer(archive) || archive.length < HEADER_BYTES + TAG_BYTES || archive.length > MAX_ARCHIVE_BYTES)
    throw failure('BAD_ARCHIVE', 'This is not a Chicory full backup, or it is damaged or truncated.');
  if (!archive.subarray(0, MAGIC.length).equals(MAGIC))
    throw failure('BAD_ARCHIVE', 'This is not a Chicory full backup. A recovery phrase or settings archive is restored elsewhere.');
  let at = MAGIC.length;
  const format = archive[at++];
  const kdfId = archive[at++];
  const kdf = { logN: archive[at++], r: archive[at++], p: archive[at++] };
  if (format !== FORMAT) throw failure('BAD_ARCHIVE', 'This full backup was written by a newer or unsupported version of Chicory.');
  if (kdfId !== KDF_SCRYPT) throw failure('BAD_ARCHIVE', 'This full backup uses an unsupported passphrase method.');
  checkKdf(kdf);
  const take = (length) => { const part = archive.subarray(at, at + length); at += length; return part; };
  const prefixEnd = at + 16;
  const salt = take(16);
  const wrapNonce = take(12);
  const wrappedKey = take(32);
  const wrapTag = take(16);
  const dataNonce = take(12);
  return { kdf, salt, wrapNonce, wrappedKey, wrapTag, dataNonce, prefix: archive.subarray(0, prefixEnd), header: archive.subarray(0, HEADER_BYTES) };
}

/** Authenticates the whole archive and returns its payload and export key. Writes nothing. */
function open(archive, passphrase) {
  const header = readHeader(archive);
  const wrapKey = wrappingKey(passphrase, header.salt, header.kdf);
  let exportKey;
  try {
    const unwrap = crypto.createDecipheriv('aes-256-gcm', wrapKey, header.wrapNonce);
    unwrap.setAAD(header.prefix);
    unwrap.setAuthTag(header.wrapTag);
    exportKey = Buffer.concat([unwrap.update(header.wrappedKey), unwrap.final()]);
  } catch {
    throw failure('BAD_PASSPHRASE', 'That passphrase does not open this full backup. Nothing was changed.', 401);
  } finally { wrapKey.fill(0); }
  let plaintext;
  try {
    const decipher = crypto.createDecipheriv('aes-256-gcm', exportKey, header.dataNonce);
    decipher.setAAD(header.header);
    decipher.setAuthTag(archive.subarray(archive.length - TAG_BYTES));
    plaintext = Buffer.concat([decipher.update(archive.subarray(HEADER_BYTES, archive.length - TAG_BYTES)), decipher.final()]);
  } catch {
    exportKey.fill(0);
    throw failure('BAD_ARCHIVE', 'This full backup is damaged or was changed after it was written. Nothing was changed.');
  }
  let payload;
  try { payload = JSON.parse(plaintext.toString('utf8')); }
  catch {
    exportKey.fill(0);
    throw failure('BAD_ARCHIVE', 'This full backup could not be read. Nothing was changed.');
  } finally { plaintext.fill(0); }
  try { return { payload: validatePayload(payload), exportKey }; }
  catch (error) { exportKey.fill(0); throw error; }
}

function base64Field(value, label) {
  if (typeof value !== 'string' || value.length % 4 !== 0 || !BASE64.test(value))
    throw failure('BAD_ARCHIVE', `This full backup has an unreadable ${label}.`);
  return value;
}

/**
 * Checks everything a restore relies on before anything is written: kind and
 * format, unique wallet identities bound to their records, safe names only
 * (so nothing can name a path outside the wallet), and well-formed contents.
 */
function validatePayload(payload) {
  const bad = (message) => failure('BAD_ARCHIVE', `This full backup is not valid: ${message}. Nothing was changed.`);
  if (!payload || payload.kind !== KIND || payload.format !== FORMAT || !Array.isArray(payload.wallets))
    throw bad('it is not a full wallet backup');
  if (!payload.wallets.length) throw bad('it holds no wallets');
  const ids = new Set();
  for (const wallet of payload.wallets) {
    const record = wallet?.record;
    if (!record || typeof record !== 'object' || !WALLET_ID.test(String(record.id)) || record.id !== wallet.id)
      throw bad('a wallet record does not match its identity');
    if (ids.has(record.id)) throw bad('it names one wallet twice');
    ids.add(record.id);
    if (typeof record.network !== 'string' || !record.network) throw bad(`wallet ${record.id} has no network`);
    if (typeof wallet.mnemonic !== 'string' || wallet.mnemonic.trim().split(/\s+/).length < 12)
      throw bad(`wallet ${record.id} has no recovery phrase`);
    if (typeof wallet.apiToken !== 'string' || !/^[a-f0-9]{32,128}$/.test(wallet.apiToken))
      throw bad(`wallet ${record.id} has no service token`);
    if (!Array.isArray(wallet.databases)) throw bad(`wallet ${record.id} has no database list`);
    const names = new Set();
    for (const database of wallet.databases) {
      if (!DATABASE_NAME.test(String(database?.name)) || names.has(database.name))
        throw bad(`wallet ${record.id} names an unsafe or repeated database`);
      names.add(database.name);
      base64Field(database.content, 'database');
    }
    for (const [name, content] of Object.entries(wallet.files ?? {})) {
      if (!DATA_FILES.has(name)) throw bad(`wallet ${record.id} names an unexpected file`);
      base64Field(content, 'file');
    }
    for (const [name, content] of Object.entries(wallet.history ?? {})) {
      if (!HISTORY_FILES.has(name)) throw bad(`wallet ${record.id} names an unexpected history file`);
      base64Field(content, 'history');
    }
  }
  if (payload.settings !== undefined && (typeof payload.settings !== 'object' || payload.settings === null || Array.isArray(payload.settings)))
    throw bad('its settings are malformed');
  return payload;
}

module.exports = {
  MAGIC, FORMAT, KIND, DEFAULT_KDF, KDF_LIMITS, MIN_PASSPHRASE, MAX_ARCHIVE_BYTES, HEADER_BYTES,
  DATABASE_NAME, DATA_FILES, HISTORY_FILES,
  createExportKey, databaseKey, seal, open, validatePayload, readHeader,
};
