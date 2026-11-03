"use strict";

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { atomicSave } = require('./browser-wallet');
const { buildPayload } = require('./backup');
const { WalletManager } = require('./wallet-manager');

function fixture(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'chicory-atomic-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return { dir, file: path.join(dir, 'wallet.json') };
}

test('Windows persistence flushes file contents before and after the atomic rename', t => {
  const { file } = fixture(t);
  const flush = fs.fsyncSync;
  const kinds = [];
  t.mock.method(fs, 'fsyncSync', fd => {
    kinds.push(fs.fstatSync(fd).isDirectory() ? 'directory' : 'file');
    return flush(fd);
  });
  atomicSave(file, { payment: 'pending' }, { platform: 'win32' });
  assert.deepEqual(kinds, ['file', 'file']);
  assert.deepEqual(JSON.parse(fs.readFileSync(file, 'utf8')), { payment: 'pending' });
  assert.equal(fs.existsSync(file + '.tmp'), false);
});

test('a failed data flush preserves the previous wallet journal and propagates the error', t => {
  const { file } = fixture(t);
  fs.writeFileSync(file, JSON.stringify({ payment: 'original' }));
  t.mock.method(fs, 'fsyncSync', () => { throw Object.assign(new Error('Disk unavailable'), { code: 'EIO' }); });
  assert.throws(() => atomicSave(file, { payment: 'new' }, { platform: 'win32' }), { code: 'EIO' });
  assert.deepEqual(JSON.parse(fs.readFileSync(file, 'utf8')), { payment: 'original' });
});

test('a failed destination flush cannot acknowledge a Windows journal commit', t => {
  const { file } = fixture(t);
  const flush = fs.fsyncSync;
  let calls = 0;
  t.mock.method(fs, 'fsyncSync', fd => {
    if (++calls === 2) throw Object.assign(new Error('Disk unavailable'), { code: 'EIO' });
    return flush(fd);
  });
  assert.throws(() => atomicSave(file, { payment: 'pending' }, { platform: 'win32' }), { code: 'EIO' });
  assert.equal(calls, 2);
});

test('POSIX persistence keeps directory flush errors visible', t => {
  const { file } = fixture(t);
  const flush = fs.fsyncSync;
  let directoryFlushed = false;
  t.mock.method(fs, 'fsyncSync', fd => {
    if (fs.fstatSync(fd).isDirectory()) {
      directoryFlushed = true;
      throw Object.assign(new Error('Directory flush failed'), { code: 'EIO' });
    }
    return flush(fd);
  });
  assert.throws(() => atomicSave(file, { payment: 'pending' }, { platform: 'linux' }), { code: 'EIO' });
  assert.equal(directoryFlushed, true);
});

test('secret backups and restores use private portable modes even from Windows-style metadata', t => {
  const { dir } = fixture(t);
  const secrets = path.join(dir, 'wallets', 'wallet-one', 'secrets');
  fs.mkdirSync(secrets, { recursive: true });
  fs.writeFileSync(path.join(dir, 'registry.json'), '{}');
  for (const name of ['mnemonic', 'api_token']) {
    fs.writeFileSync(path.join(secrets, name), `test-${name}`, { mode: 0o666 });
    fs.chmodSync(path.join(secrets, name), 0o666);
  }
  const payload = buildPayload({ dataDir: dir, walletIds: ['wallet-one'] });
  for (const entry of payload.files.filter(entry => entry.path.includes('/secrets/')))
    assert.equal(entry.mode, 0o600);
  const restored = path.join(dir, 'restored-secret');
  const manager = Object.create(WalletManager.prototype);
  manager._writeSecret(restored, { data: Buffer.from('unchanged-secret'), mode: 0o666 });
  assert.equal(fs.readFileSync(restored, 'utf8'), 'unchanged-secret');
  if (process.platform !== 'win32') assert.equal(fs.statSync(restored).mode & 0o777, 0o600);
});
