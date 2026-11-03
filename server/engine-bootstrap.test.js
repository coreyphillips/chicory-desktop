'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const net = require('node:net');
const { fork } = require('node:child_process');
const { randomBytes } = require('node:crypto');
const { setTimeout: delay } = require('node:timers/promises');
const vault = require('./vault-files');
const { openEncryptedDatabase, verifyDatabase } = require('./engine-storage.cjs');

const runtime = path.resolve(__dirname, '../.runtime');
const node = path.join(runtime, 'node', process.platform === 'win32' ? 'node.exe' : 'bin/node');
const entry = path.join(runtime, 'engine/node_modules/beignet/dist/cli/cli.js');
const driverRoot = path.join(runtime, 'engine/node_modules/better-sqlite3-multiple-ciphers');
const binding = path.join(driverRoot, 'build/Release/better_sqlite3.node');
// Run against the exact provisioned CLI and native driver, without Electron,
// funds, a public chain, external peers or any production wallet directory.
const available = [node, entry, binding].every((file) => fs.existsSync(file));
const bootstrap = path.join(__dirname, 'engine-bootstrap.js');

async function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'chicory-engine-bootstrap-'));
  const key = randomBytes(32);
  const children = [];
  const sockets = new Set();
  const electrum = net.createServer((socket) => {
    sockets.add(socket);
    socket.on('error', () => {});
    socket.once('close', () => sockets.delete(socket));
    // Deliberately leave startup waiting on this local fixture. This verifies
    // disconnect cleanup before the CLI's normal ready/shutdown handlers exist.
    socket.resume();
  });
  await new Promise((resolve, reject) => {
    electrum.once('error', reject);
    electrum.listen(0, '127.0.0.1', resolve);
  });
  vault.configureVault({ root, key });
  vault.initializeVault();
  const keys = vault.engineKeys('fixture-wallet');
  const home = path.join(keys.filesRoot, 'home');
  const data = path.join(keys.filesRoot, 'data');
  fs.mkdirSync(home, { recursive: true });
  const environment = {
    PATH: process.env.PATH || '',
    ...(process.env.SystemRoot ? { SystemRoot: process.env.SystemRoot } : {}),
    HOME: home, USERPROFILE: home, NODE_ENV: 'test',
    BEIGNET_NETWORK: 'regtest', BEIGNET_DATA_DIR: data,
    BEIGNET_ELECTRUM_HOST: '127.0.0.1', BEIGNET_ELECTRUM_PORT: String(electrum.address().port),
    BEIGNET_ELECTRUM_TLS: 'false', BEIGNET_AUTO_BOOTSTRAP: 'false',
    BEIGNET_AUTO_RECONNECT: 'false', BEIGNET_IROH: 'false', BEIGNET_LISTEN_PORT: '0',
    BEIGNET_FEE_SOURCE: 'electrum', BEIGNET_RECOVERY_MODE: 'off',
  };
  function launch(args) {
    const child = fork(bootstrap, [entry, ...args], {
      execPath: node, execArgv: [], env: environment, cwd: home,
      stdio: ['ignore', 'pipe', 'pipe', 'ipc'], windowsHide: true,
    });
    const state = { child, lines: [], stdout: '', stderr: '', exited: false };
    state.exit = new Promise((resolve, reject) => {
      child.once('error', reject);
      child.once('exit', (code, signal) => { state.exited = true; resolve({ code, signal }); });
    });
    let pending = '';
    child.stdout.on('data', (data) => {
      const text = String(data);
      state.stdout = (state.stdout + text).slice(-65536);
      pending += text;
      const lines = pending.split('\n'); pending = lines.pop();
      for (const line of lines) { try { state.lines.push(JSON.parse(line)); } catch {} }
    });
    child.stderr.on('data', (data) => { state.stderr = (state.stderr + String(data)).slice(-65536); });
    children.push(state);
    return state;
  }
  t.after(async () => {
    for (const state of children) {
      if (!state.exited) state.child.kill('SIGKILL');
      await state.exit.catch(() => {});
    }
    for (const socket of sockets) socket.destroy();
    await new Promise((resolve) => electrum.close(resolve));
    vault.clearVault(); key.fill(0);
    fs.rmSync(root, { recursive: true, force: true });
  });
  return { root, home, data, keys, launch };
}

async function until(predicate, message, timeout = 15000) {
  const end = Date.now() + timeout;
  while (Date.now() < end) {
    if (await predicate()) return;
    await delay(25);
  }
  assert.fail(message);
}

async function disconnect(state) {
  if (state.child.connected) state.child.disconnect();
  await until(() => state.exited, 'Engine remained alive after its private bootstrap channel closed.', 3000);
  return state.exit;
}

function noKeyOutput(state, keys) {
  for (const value of [keys.filesKey, keys.databaseKey]) {
    assert.equal((state.stdout + state.stderr).includes(value), false, 'Storage key appeared in engine output.');
    assert.equal(state.child.spawnargs.some((arg) => arg.includes(value)), false, 'Storage key appeared in process arguments.');
  }
}

test('actual patched CLI receives keys privately and encrypts config and schema through the bootstrap', { skip: !available, timeout: 30000 }, async (t) => {
  const f = await fixture(t);
  const config = path.join(f.home, '.beignet/config.json');
  const initializer = f.launch(['init', '--network', 'regtest']);
  await delay(100);
  assert.equal(fs.existsSync(config), false, 'The CLI executed before receiving storage keys.');
  initializer.child.send({ type: 'initialize-storage', ...f.keys });
  await until(() => initializer.lines.some((line) => line.ok === true && line.result?.message === 'Initialized'), 'Actual CLI initialization did not finish.');
  await disconnect(initializer);
  noKeyOutput(initializer, f.keys);
  const saved = JSON.parse(vault.fs.readFileSync(config, 'utf8'));
  assert.equal(saved.network, 'regtest');
  assert.equal(typeof saved.mnemonic, 'string');
  assert.equal(saved.mnemonic.split(' ').length >= 12, true);
  const ciphertext = fs.readFileSync(config);
  assert.deepEqual(ciphertext.subarray(0, vault.MAGIC.length), vault.MAGIC);
  assert.equal(ciphertext.includes(Buffer.from(saved.mnemonic)), false);
  assert.equal(ciphertext.includes(Buffer.from(saved.apiToken)), false);

  // Reopen through the real config module, which uses __importStar(require('fs')),
  // then start real SqliteStorage through the patched sqlite-binding module.
  const starter = f.launch(['start', '--no-auto-reconnect']);
  starter.child.send({ type: 'initialize-storage', ...f.keys });
  const database = path.join(f.data, 'regtest.db');
  await until(() => {
    if (!fs.existsSync(database) || fs.statSync(database).size === 0) return false;
    let opened;
    try {
      opened = openEncryptedDatabase(database, f.keys.databaseKey, { driverRoot, readonly: true, fileMustExist: true });
      const names = opened.prepare("SELECT name FROM sqlite_schema WHERE type='table'").all().map((row) => row.name);
      return names.includes('channels') && names.includes('wallet_data');
    } catch { return false; }
    finally { if (opened?.open) opened.close(); }
  }, 'Actual patched engine did not commit its encrypted wallet schema.');
  await disconnect(starter);
  noKeyOutput(starter, f.keys);
  assert.equal(verifyDatabase(database, f.keys.databaseKey, { driverRoot }), true);
  assert.throws(() => verifyDatabase(database, randomBytes(32).toString('hex'), { driverRoot }), { code: 'WALLET_STORAGE_LOCKED' });
  for (const name of fs.readdirSync(f.data).filter((name) => name.includes('.db'))) {
    const bytes = fs.readFileSync(path.join(f.data, name));
    assert.equal(bytes.subarray(0, 16).equals(Buffer.from('SQLite format 3\0')), false);
    assert.equal(bytes.includes(Buffer.from('CREATE TABLE')), false);
    assert.equal(bytes.includes(Buffer.from(saved.mnemonic)), false);
  }
  assert.deepEqual(fs.readFileSync(config), ciphertext);
});

test('invalid bootstrap keys fail before the installed CLI can create a config', { skip: !available, timeout: 10000 }, async (t) => {
  const f = await fixture(t);
  const initializer = f.launch(['init', '--network', 'regtest']);
  initializer.child.send({ type: 'initialize-storage', ...f.keys, filesKey: 'invalid-key' });
  const result = await initializer.exit;
  assert.equal(result.code, 1);
  assert.equal(fs.existsSync(path.join(f.home, '.beignet/config.json')), false);
  noKeyOutput(initializer, f.keys);
});
