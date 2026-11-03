'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { randomBytes } = require('node:crypto');
const vault = require('./vault-files');

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'chicory-vault-test-'));
  const key = randomBytes(32);
  t.after(() => { vault.clearVault(); key.fill(0); fs.rmSync(root, { recursive: true, force: true }); });
  vault.configureVault({ root, key });
  return { root, key, marker: path.join(root, '.vault-v1'), file: (name) => path.join(root, name) };
}

function diskBytes(file) { return fs.readFileSync(file); }
function assertEncrypted(file, plaintext) {
  const bytes = diskBytes(file);
  assert.deepEqual(bytes.subarray(0, vault.MAGIC.length), vault.MAGIC);
  assert.equal(bytes.includes(Buffer.from(plaintext)), false);
  if (process.platform !== 'win32') assert.equal(fs.statSync(file).mode & 0o777, 0o600);
}

async function ready(t) {
  const f = fixture(t);
  await vault.initializeVault();
  return f;
}

test('initializes a fresh encrypted vault and verifies its marker on reopen', async (t) => {
  const f = await ready(t);
  const before = diskBytes(f.marker);
  assertEncrypted(f.marker, '"version"');
  vault.configureVault({ root: f.root, key: f.key });
  await vault.initializeVault();
  assert.deepEqual(diskBytes(f.marker), before);
});

test('manager and engine scopes can read each other encrypted wallet files', async (t) => {
  const f = await ready(t);
  const file = f.file('wallets/fixture-wallet/secrets/mnemonic');
  vault.fs.writeFileSync(file, 'fixture phrase written by manager');
  assertEncrypted(file, 'fixture phrase written by manager');
  const engine = vault.engineKeys('fixture-wallet');
  vault.configureVault({ root: engine.filesRoot, key: Buffer.from(engine.filesKey, 'hex'), scope: 'wallet' });
  assert.equal(vault.fs.readFileSync(file, 'utf8'), 'fixture phrase written by manager');
  vault.fs.writeFileSync(file, 'fixture phrase written by engine');
  assertEncrypted(file, 'fixture phrase written by engine');
  vault.configureVault({ root: f.root, key: f.key });
  assert.equal(vault.fs.readFileSync(file, 'utf8'), 'fixture phrase written by engine');
});

test('raw ciphertext cannot be transplanted to another file or wallet', async (t) => {
  const f = await ready(t);
  const original = f.file('wallets/alpha/secrets/mnemonic');
  vault.fs.writeFileSync(original, 'fixture wallet alpha secret');
  const bytes = diskBytes(original);
  for (const destination of ['wallets/alpha/secrets/other', 'wallets/beta/secrets/mnemonic']) {
    const file = f.file(destination);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, bytes);
    assert.throws(() => vault.fs.readFileSync(file), { code: 'VAULT_UNAVAILABLE' });
    assert.deepEqual(diskBytes(file), bytes);
  }
});

test('rejects string and numeric raw write opens before creating a plaintext file', async (t) => {
  const f = await ready(t);
  const flags = ['w', 'wx', 'a', 'r+', fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_TRUNC,
    fs.constants.O_RDWR | fs.constants.O_CREAT, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_APPEND];
  for (let i = 0; i < flags.length; i++) {
    const file = f.file(`numeric-${i}`);
    assert.throws(() => vault.fs.openSync(file, flags[i], 0o600), { code: 'VAULT_UNAVAILABLE' });
    assert.equal(fs.existsSync(file), false);
  }
});

test('promise writes and appends encrypt data before it reaches disk', async (t) => {
  const f = await ready(t);
  const file = f.file('wallets/fixture-wallet/promised-data');
  await vault.fs.promises.writeFile(file, 'first private fixture');
  assertEncrypted(file, 'first private fixture');
  await vault.fs.promises.appendFile(file, ' second private fixture');
  assertEncrypted(file, 'second private fixture');
  assert.equal(await vault.fs.promises.readFile(file, 'utf8'), 'first private fixture second private fixture');
  await assert.rejects(vault.fs.promises.open(f.file('raw-promise'), 'w'), { code: 'VAULT_UNAVAILABLE' });
  assert.equal(fs.existsSync(f.file('raw-promise')), false);
});

test('callback writes use the encrypted path too', async (t) => {
  const f = await ready(t);
  const file = f.file('wallets/fixture-wallet/callback-data');
  await new Promise((resolve, reject) => vault.fs.writeFile(file, 'callback private fixture', (error) => error ? reject(error) : resolve()));
  assertEncrypted(file, 'callback private fixture');
  const data = await new Promise((resolve, reject) => vault.fs.readFile(file, 'utf8', (error, value) => error ? reject(error) : resolve(value)));
  assert.equal(data, 'callback private fixture');
});

test('encrypted writes, copies, appends and atomic renames retain readable data', async (t) => {
  const f = await ready(t);
  const file = f.file('wallets/fixture-wallet/metadata.json');
  const temporary = `${file}.123.tmp`;
  vault.fs.writeFileSync(temporary, 'one');
  vault.fs.renameSync(temporary, file);
  vault.fs.appendFileSync(file, ' two');
  assert.equal(vault.fs.readFileSync(file, 'utf8'), 'one two');
  const copy = f.file('wallets/fixture-wallet/metadata-copy.json');
  vault.fs.copyFileSync(file, copy, fs.constants.COPYFILE_EXCL);
  assert.equal(vault.fs.readFileSync(copy, 'utf8'), 'one two');
  assertEncrypted(copy, 'one two');
  assert.throws(() => vault.fs.copyFileSync(file, copy, fs.constants.COPYFILE_EXCL), { code: 'EEXIST' });
  assert.equal(vault.fs.readFileSync(copy, 'utf8'), 'one two');
});

test('corrupt ciphertext is refused without replacing wallet data', async (t) => {
  const f = await ready(t);
  const file = f.file('wallets/fixture-wallet/private-state');
  vault.fs.writeFileSync(file, 'fixture secret');
  const bytes = diskBytes(file);
  bytes[bytes.length - 1] ^= 1;
  fs.writeFileSync(file, bytes);
  assert.throws(() => vault.fs.readFileSync(file), { code: 'VAULT_UNAVAILABLE' });
  assert.throws(() => vault.fs.appendFileSync(file, 'new'), { code: 'VAULT_UNAVAILABLE' });
  assert.deepEqual(diskBytes(file), bytes);
});

test('wrong master key refuses vault opening and preserves its marker and files', async (t) => {
  const f = await ready(t);
  const file = f.file('wallets/fixture-wallet/private-state');
  vault.fs.writeFileSync(file, 'fixture secret');
  const marker = diskBytes(f.marker);
  const bytes = diskBytes(file);
  vault.configureVault({ root: f.root, key: randomBytes(32) });
  await assert.rejects(async () => vault.initializeVault(), { code: 'VAULT_UNAVAILABLE' });
  assert.deepEqual(diskBytes(f.marker), marker);
  assert.deepEqual(diskBytes(file), bytes);
  vault.configureVault({ root: f.root, key: f.key });
  await vault.initializeVault();
  assert.equal(vault.fs.readFileSync(file, 'utf8'), 'fixture secret');
});

test('a missing marker never resets a populated vault', async (t) => {
  const f = await ready(t);
  const file = f.file('wallets/fixture-wallet/private-state');
  vault.fs.writeFileSync(file, 'fixture secret');
  const bytes = diskBytes(file);
  fs.unlinkSync(f.marker);
  await assert.rejects(async () => vault.initializeVault(), { code: 'VAULT_UNAVAILABLE' });
  assert.equal(fs.existsSync(f.marker), false);
  assert.deepEqual(diskBytes(file), bytes);
});

test('a corrupt marker never resets or replaces a populated vault', async (t) => {
  const f = await ready(t);
  const marker = diskBytes(f.marker);
  marker[marker.length - 1] ^= 1;
  fs.writeFileSync(f.marker, marker);
  await assert.rejects(async () => vault.initializeVault(), { code: 'VAULT_UNAVAILABLE' });
  assert.deepEqual(diskBytes(f.marker), marker);
});

test('fresh-profile-only initialization refuses plaintext data without converting or deleting it', async (t) => {
  const f = fixture(t);
  const file = f.file('plaintext-data');
  fs.writeFileSync(file, 'fixture plaintext');
  await assert.rejects(async () => vault.initializeVault(), { code: 'VAULT_UNAVAILABLE' });
  assert.equal(fs.existsSync(f.marker), false);
  assert.equal(fs.readFileSync(file, 'utf8'), 'fixture plaintext');
});

test('failed file sync retains the previous ciphertext and removes only its temporary output', async (t) => {
  const f = await ready(t);
  const file = f.file('wallets/fixture-wallet/private-state');
  vault.fs.writeFileSync(file, 'original private fixture');
  const before = diskBytes(file);
  const mock = t.mock.method(fs, 'fsyncSync', () => { throw Object.assign(new Error('Simulated disk failure'), { code: 'EIO' }); });
  assert.throws(() => vault.fs.writeFileSync(file, 'replacement private fixture'), { code: 'EIO' });
  mock.mock.restore();
  assert.deepEqual(diskBytes(file), before);
  assert.deepEqual(fs.readdirSync(path.dirname(file)), ['private-state']);
  assert.equal(vault.fs.readFileSync(file, 'utf8'), 'original private fixture');
});

test('symbolic links cannot move a protected write outside its vault', { skip: process.platform === 'win32' }, async (t) => {
  const f = await ready(t);
  const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'chicory-vault-external-'));
  t.after(() => fs.rmSync(outside, { recursive: true, force: true }));
  fs.symlinkSync(outside, f.file('linked'));
  assert.throws(() => vault.fs.writeFileSync(f.file('linked/private'), 'fixture secret'), { code: 'VAULT_UNAVAILABLE' });
  assert.deepEqual(fs.readdirSync(outside), []);
});

test('database-like directories and restore metadata never bypass file encryption', async (t) => {
  const f = await ready(t);
  for (const name of [
    'wallets/fixture-wallet/cache.db.snapshots/private-state',
    'wallets/fixture-wallet/wallet.sqlite.restored',
    'wallets/fixture-wallet/wallet.sqlite.restored.123.tmp',
    'wallets/fixture-wallet/wallet.db.hmac',
    'wallets/fixture-wallet/wallet.db.mac.checkpoint.tmp',
  ]) {
    const file = f.file(name);
    assert.equal(vault.isDatabaseFile(file), false);
    vault.fs.writeFileSync(file, 'private metadata fixture');
    assertEncrypted(file, 'private metadata fixture');
    assert.equal(vault.fs.readFileSync(file, 'utf8'), 'private metadata fixture');
  }
});

test('ready vault refuses an unexpected plaintext database without changing it', async (t) => {
  const f = await ready(t);
  const marker = diskBytes(f.marker);
  const file = f.file('wallets/fixture-wallet/wallet.sqlite');
  const bytes = Buffer.concat([Buffer.from('SQLite format 3\0'), Buffer.alloc(128)]);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, bytes);
  await assert.rejects(async () => vault.initializeVault(), { code: 'VAULT_UNAVAILABLE' });
  assert.deepEqual(diskBytes(file), bytes);
  assert.deepEqual(diskBytes(f.marker), marker);
});

test('raw truncation and hard links cannot bypass the encrypted file adapter', async (t) => {
  const f = await ready(t);
  const file = f.file('wallets/fixture-wallet/private-state');
  vault.fs.writeFileSync(file, 'private fixture');
  const bytes = diskBytes(file);
  assert.throws(() => vault.fs.truncateSync(file, 0), { code: 'VAULT_UNAVAILABLE' });
  assert.throws(() => vault.fs.linkSync(file, f.file('linked-state')), { code: 'VAULT_UNAVAILABLE' });
  await assert.rejects(vault.fs.promises.truncate(file, 0), { code: 'VAULT_UNAVAILABLE' });
  await assert.rejects(vault.fs.promises.link(file, f.file('linked-state')), { code: 'VAULT_UNAVAILABLE' });
  assert.deepEqual(diskBytes(file), bytes);
  assert.equal(fs.existsSync(f.file('linked-state')), false);
});
