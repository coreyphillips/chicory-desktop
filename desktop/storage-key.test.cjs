'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { randomBytes, createCipheriv, createDecipheriv } = require('node:crypto');
const { loadStorageKey } = require('./storage-key.cjs');

function fixture(t) {
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'chicory-key-test-'));
  t.after(() => fs.rmSync(profile, { recursive: true, force: true }));
  return profile;
}

function secureStore(overrides = {}) {
  const osKey = randomBytes(32);
  const store = {
    available: true,
    backend: 'gnome_libsecret',
    rotate: false,
    encryptions: 0,
    decryptions: 0,
    async isAsyncEncryptionAvailable() { return this.available; },
    getSelectedStorageBackend() { return this.backend; },
    async encryptStringAsync(value) {
      this.encryptions++;
      const nonce = randomBytes(12);
      const cipher = createCipheriv('aes-256-gcm', osKey, nonce);
      const encrypted = Buffer.concat([cipher.update(value, 'utf8'), cipher.final()]);
      return Buffer.concat([nonce, cipher.getAuthTag(), encrypted]);
    },
    async decryptStringAsync(value) {
      this.decryptions++;
      const decipher = createDecipheriv('aes-256-gcm', osKey, value.subarray(0, 12));
      decipher.setAuthTag(value.subarray(12, 28));
      const result = Buffer.concat([decipher.update(value.subarray(28)), decipher.final()]).toString('utf8');
      return { result, shouldReEncrypt: this.rotate };
    },
  };
  return Object.assign(store, overrides);
}

function options(profile, safeStorage, extra = {}) {
  return { profile, safeStorage, platform: 'darwin', ...extra };
}

function envelopePath(profile) { return path.join(profile, 'storage-key.json'); }
function envelopeBytes(profile) { return fs.readFileSync(envelopePath(profile)); }
function writeWalletFile(profile, name, bytes) {
  const file = path.join(profile, 'wallets', name);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, bytes);
  return file;
}

async function expectRefusal(profile, store, code, extra) {
  const file = envelopePath(profile);
  const before = fs.existsSync(file) ? fs.readFileSync(file) : null;
  const encryptions = store.encryptions;
  await assert.rejects(loadStorageKey(options(profile, store, extra)), { code });
  if (before) assert.deepEqual(envelopeBytes(profile), before);
  else assert.equal(fs.existsSync(file), false);
  assert.equal(store.encryptions, encryptions);
}

test('creates an OS-wrapped 32-byte key and reopens it without replacing it', async (t) => {
  const profile = fixture(t);
  const store = secureStore();
  const key = await loadStorageKey(options(profile, store));
  assert.equal(Buffer.isBuffer(key), true);
  assert.equal(key.length, 32);
  const bytes = envelopeBytes(profile);
  const envelope = JSON.parse(bytes);
  assert.equal(envelope.version, 1);
  assert.equal(envelope.provider, 'electron.safeStorage');
  assert.equal(bytes.includes(key.toString('hex')), false);
  if (process.platform !== 'win32') assert.equal(fs.statSync(envelopePath(profile)).mode & 0o777, 0o600);
  assert.deepEqual(fs.readdirSync(profile), ['storage-key.json']);
  const reopened = await loadStorageKey(options(profile, store));
  assert.deepEqual(reopened, key);
  assert.deepEqual(envelopeBytes(profile), bytes);
  assert.equal(store.encryptions, 1);
  key.fill(0);
  assert.deepEqual(await loadStorageKey(options(profile, store)), reopened);
});

test('refuses an unavailable or failing OS secure store without creating a key', async (t) => {
  for (const override of [
    { available: false },
    { isAsyncEncryptionAvailable: async () => { throw new Error('Locked keyring'); } },
    { isAsyncEncryptionAvailable: undefined },
    { encryptStringAsync: undefined },
    { decryptStringAsync: undefined },
  ]) await expectRefusal(fixture(t), secureStore(override), 'STORAGE_PROTECTION_UNAVAILABLE');
});

test('refuses plaintext or unknown Linux key stores without invoking plaintext fallback', async (t) => {
  for (const backend of ['basic_text', 'unknown', '', undefined, 'new-unreviewed-provider']) {
    const store = secureStore({ backend, setUsePlainTextEncryption: () => assert.fail('Must not enable plaintext fallback') });
    await expectRefusal(fixture(t), store, 'STORAGE_PROTECTION_UNAVAILABLE', { platform: 'linux' });
  }
  await expectRefusal(fixture(t), secureStore({ getSelectedStorageBackend: undefined }), 'STORAGE_PROTECTION_UNAVAILABLE', { platform: 'linux' });
  await expectRefusal(fixture(t), secureStore({ getSelectedStorageBackend: () => { throw new Error('Missing keyring'); } }), 'STORAGE_PROTECTION_UNAVAILABLE', { platform: 'linux' });
});

test('supports recognized Linux keyrings and the Windows provider', async (t) => {
  for (const backend of ['gnome_libsecret', 'kwallet', 'kwallet5', 'kwallet6']) {
    assert.equal((await loadStorageKey(options(fixture(t), secureStore({ backend }), { platform: 'linux' }))).length, 32);
  }
  assert.equal((await loadStorageKey(options(fixture(t), secureStore(), { platform: 'win32' }))).length, 32);
});

test('does not replace an existing key when the OS store becomes unavailable', async (t) => {
  const profile = fixture(t);
  const store = secureStore();
  const key = await loadStorageKey(options(profile, store));
  store.available = false;
  await expectRefusal(profile, store, 'STORAGE_PROTECTION_UNAVAILABLE');
  store.available = true;
  assert.deepEqual(await loadStorageKey(options(profile, store)), key);
});

test('preserves a corrupt or unsupported envelope without attempting replacement', async (t) => {
  for (const bytes of [
    Buffer.from('{'), Buffer.alloc(0), Buffer.alloc(65537, 65),
    Buffer.from(JSON.stringify({ version: 2, provider: 'electron.safeStorage', ciphertext: 'YQ==' })),
    Buffer.from(JSON.stringify({ version: 1, provider: 'plaintext', ciphertext: 'YQ==' })),
    Buffer.from(JSON.stringify({ version: 1, provider: 'electron.safeStorage', ciphertext: '' })),
    Buffer.from(JSON.stringify({ version: 1, provider: 'electron.safeStorage', ciphertext: 'YQ==\n' })),
    Buffer.from(JSON.stringify({ version: 1, provider: 'electron.safeStorage', ciphertext: 'YR==' })),
  ]) {
    const profile = fixture(t);
    fs.writeFileSync(envelopePath(profile), bytes);
    await expectRefusal(profile, secureStore(), 'STORAGE_KEY_INVALID');
  }
});

test('preserves the envelope if its OS wrapper has been tampered with', async (t) => {
  const profile = fixture(t);
  const store = secureStore();
  await loadStorageKey(options(profile, store));
  const envelope = JSON.parse(envelopeBytes(profile));
  const ciphertext = Buffer.from(envelope.ciphertext, 'base64');
  ciphertext[ciphertext.length - 1] ^= 1;
  envelope.ciphertext = ciphertext.toString('base64');
  fs.writeFileSync(envelopePath(profile), JSON.stringify(envelope));
  await expectRefusal(profile, store, 'STORAGE_KEY_UNAVAILABLE');
});

test('does not reset a key protected by a different OS account or lost keychain', async (t) => {
  const profile = fixture(t);
  const originalStore = secureStore();
  const originalKey = await loadStorageKey(options(profile, originalStore));
  await expectRefusal(profile, secureStore(), 'STORAGE_KEY_UNAVAILABLE');
  assert.deepEqual(await loadStorageKey(options(profile, originalStore)), originalKey);
});

test('rejects a decrypted key with any length or format other than exactly 32 bytes', async (t) => {
  for (const value of ['', 'ab'.repeat(31), 'ab'.repeat(33), 'GH'.repeat(32), 'AB'.repeat(32), 'ab'.repeat(32) + '\n']) {
    const profile = fixture(t);
    const store = secureStore();
    const encrypted = await store.encryptStringAsync(value);
    fs.writeFileSync(envelopePath(profile), JSON.stringify({ version: 1, provider: 'electron.safeStorage', ciphertext: encrypted.toString('base64') }));
    await expectRefusal(profile, store, 'STORAGE_KEY_INVALID');
  }
});

test('refuses a new key when an encrypted profile marker is present', async (t) => {
  for (const name of ['.vault-v1', 'nested/.vault-v1']) {
    const profile = fixture(t);
    writeWalletFile(profile, name, '1');
    await expectRefusal(profile, secureStore(), 'STORAGE_KEY_MISSING');
  }
});

test('recognizes encrypted wallet files even when the marker is missing', async (t) => {
  const profile = fixture(t);
  writeWalletFile(profile, 'mainnet/channel-secrets.json', Buffer.concat([Buffer.from('CHICORYVAULT1'), randomBytes(64)]));
  await expectRefusal(profile, secureStore(), 'STORAGE_KEY_MISSING');
});

test('refuses unrecognized nonempty databases when the key and marker are missing', async (t) => {
  for (const extension of ['db', 'sqlite', 'sqlite3']) {
    const profile = fixture(t);
    writeWalletFile(profile, `mainnet/wallet.${extension}`, randomBytes(256));
    await expectRefusal(profile, secureStore(), 'STORAGE_KEY_MISSING');
  }
});

test('refuses existing plaintext wallet data without creating a replacement key', async (t) => {
  const profile = fixture(t);
  const legacy = [
    ['mainnet/seed.json', Buffer.from('{"seed":"test-only legacy fixture"}')],
    ['mainnet/wallet.sqlite', Buffer.concat([Buffer.from('SQLite format 3\0'), Buffer.alloc(256)])],
    ['mainnet/wallet.sqlite-wal', randomBytes(256)],
    ['signet/empty.db', Buffer.alloc(0)],
  ];
  const files = legacy.map(([name, bytes]) => [writeWalletFile(profile, name, bytes), bytes]);
  await expectRefusal(profile, secureStore(), 'STORAGE_KEY_MISSING');
  for (const [file, bytes] of files) assert.deepEqual(fs.readFileSync(file), bytes);
});

test('allows a fresh profile containing only empty wallet directories', async (t) => {
  const profile = fixture(t);
  fs.mkdirSync(path.join(profile, 'wallets', 'wallets', 'new-wallet'), { recursive: true });
  assert.equal((await loadStorageKey(options(profile, secureStore()))).length, 32);
});

test('refuses key-file directories and symbolic links without following them', { skip: process.platform === 'win32' }, async (t) => {
  const profile = fixture(t);
  fs.mkdirSync(envelopePath(profile));
  await assert.rejects(loadStorageKey(options(profile, secureStore())), { code: 'STORAGE_LAYOUT_UNSAFE' });
  fs.rmdirSync(envelopePath(profile));
  const target = path.join(fixture(t), 'other-key.json');
  fs.writeFileSync(target, 'untouched');
  fs.symlinkSync(target, envelopePath(profile));
  await assert.rejects(loadStorageKey(options(profile, secureStore())), { code: 'STORAGE_LAYOUT_UNSAFE' });
  assert.equal(fs.readFileSync(target, 'utf8'), 'untouched');
});

test('refuses unsafe wallet directory links rather than overlooking an encrypted wallet', { skip: process.platform === 'win32' }, async (t) => {
  const target = fixture(t);
  fs.writeFileSync(path.join(target, '.vault-v1'), '1');
  for (const nested of [false, true]) {
    const profile = fixture(t);
    const link = path.join(profile, 'wallets', ...(nested ? ['nested'] : []));
    fs.mkdirSync(path.dirname(link), { recursive: true });
    fs.symlinkSync(target, link);
    await expectRefusal(profile, secureStore(), 'STORAGE_LAYOUT_UNSAFE');
  }
});

test('verifies the OS wrapper before committing a key', async (t) => {
  const profile = fixture(t);
  const store = secureStore({ decryptStringAsync: async () => ({ result: 'ab'.repeat(32), shouldReEncrypt: false }) });
  await assert.rejects(loadStorageKey(options(profile, store)), { code: 'STORAGE_KEY_INVALID' });
  assert.equal(fs.existsSync(envelopePath(profile)), false);
  assert.deepEqual(fs.readdirSync(profile), []);
});

test('does not leave a key file or temporary file when syncing the new key fails', async (t) => {
  const profile = fixture(t);
  const store = secureStore();
  const failure = Object.assign(new Error('Simulated disk failure'), { code: 'EIO' });
  const mock = t.mock.method(fs, 'fsyncSync', () => { throw failure; });
  await assert.rejects(loadStorageKey(options(profile, store)), { code: 'EIO' });
  mock.mock.restore();
  assert.deepEqual(fs.readdirSync(profile), []);
  assert.equal((await loadStorageKey(options(profile, store))).length, 32);
});

test('concurrent first openers cannot overwrite the key the first opener committed', async (t) => {
  const profile = fixture(t);
  const store = secureStore();
  const results = await Promise.allSettled([loadStorageKey(options(profile, store)), loadStorageKey(options(profile, store))]);
  const accepted = results.filter((result) => result.status === 'fulfilled');
  const refused = results.filter((result) => result.status === 'rejected');
  assert.equal(accepted.length, 1);
  assert.equal(refused.length, 1);
  assert.equal(refused[0].reason.code, 'EEXIST');
  assert.deepEqual(await loadStorageKey(options(profile, store)), accepted[0].value);
  assert.deepEqual(fs.readdirSync(profile), ['storage-key.json']);
});

test('refreshes an outdated OS wrapper without changing the wallet key', async (t) => {
  const profile = fixture(t);
  const store = secureStore();
  const originalKey = await loadStorageKey(options(profile, store));
  const originalEnvelope = envelopeBytes(profile);
  store.rotate = true;
  assert.deepEqual(await loadStorageKey(options(profile, store)), originalKey);
  assert.notDeepEqual(envelopeBytes(profile), originalEnvelope);
  store.rotate = false;
  assert.deepEqual(await loadStorageKey(options(profile, store)), originalKey);
  assert.deepEqual(fs.readdirSync(profile), ['storage-key.json']);
});

test('preserves the original wrapped key if wrapper refresh cannot be protected', async (t) => {
  const profile = fixture(t);
  const store = secureStore();
  const originalKey = await loadStorageKey(options(profile, store));
  const originalEnvelope = envelopeBytes(profile);
  const encrypt = store.encryptStringAsync;
  store.rotate = true;
  store.encryptStringAsync = async () => { throw new Error('Keychain closed'); };
  await assert.rejects(loadStorageKey(options(profile, store)), { code: 'STORAGE_KEY_UNAVAILABLE' });
  assert.deepEqual(envelopeBytes(profile), originalEnvelope);
  store.rotate = false;
  store.encryptStringAsync = encrypt;
  assert.deepEqual(await loadStorageKey(options(profile, store)), originalKey);
});

test('rejects relative profiles and unsupported operating systems', async (t) => {
  await assert.rejects(loadStorageKey(options('relative-profile', secureStore())), { code: 'STORAGE_LAYOUT_UNSAFE' });
  await expectRefusal(fixture(t), secureStore(), 'STORAGE_PROTECTION_UNAVAILABLE', { platform: 'freebsd' });
});
