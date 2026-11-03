'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { once } = require('node:events');
const { randomBytes } = require('node:crypto');
const http = require('node:http');
const { startManager } = require('./index');

async function start(t) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'chicory-desktop-manager-'));
  const publicDir = path.join(dir, 'site');
  const token = randomBytes(32).toString('hex');
  await fs.mkdir(publicDir);
  await fs.writeFile(path.join(publicDir, 'index.html'), '<title>Desktop wallet</title>');
  const child = spawn(process.execPath, [path.join(__dirname, 'index.js')], {
    env: {
      ...process.env, PORT: '1', BIND_HOST: '0.0.0.0', DATA_DIR: path.join(dir, 'data'),
      PUBLIC_DIR: publicDir, DESKTOP_SESSION_TOKEN: token, DESKTOP_MODE: '1',
      BEIGNET_TRUST_ALL: '1', BEIGNET_BIN: '', TOR_PROXY_IP: '', TOR_PROXY_PORT: '', TOR_PASSWORD: '',
    },
    stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
  });
  let output = '';
  child.stdout.on('data', chunk => { output += chunk; });
  child.stderr.on('data', chunk => { output += chunk; });
  t.after(async () => {
    if (child.exitCode === null && child.signalCode === null) {
      const exited = once(child, 'exit');
      child.kill('SIGTERM');
      const timer = setTimeout(() => child.kill('SIGKILL'), 3000);
      await exited;
      clearTimeout(timer);
    }
    await fs.rm(dir, { recursive: true, force: true });
  });
  const ready = await new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error(`Manager did not start: ${output}`)), 5000);
    child.once('error', error => { clearTimeout(timeout); reject(error); });
    child.once('exit', code => { clearTimeout(timeout); reject(new Error(`Manager exited ${code}: ${output}`)); });
    child.on('message', message => {
      if (message.type === 'ready') { clearTimeout(timeout); resolve(message); }
    });
  });
  assert.equal(ready.host, '127.0.0.1');
  assert.ok(ready.port > 1);
  assert.equal(ready.origin, `http://127.0.0.1:${ready.port}`);
  assert.equal(output.includes(token), false);
  return { child, ready, token };
}

test('desktop manager reports its private port, authenticates all paths and drains through IPC', async t => {
  const { child, ready, token } = await start(t);
  for (const pathname of ['/', '/api/health', '/api/backup', '/wallets/example/api/balance']) {
    const denied = await fetch(ready.origin + pathname);
    assert.equal(denied.status, 403);
  }
  const headers = { 'X-Chicory-Session': token };
  const html = await fetch(ready.origin + '/', { headers });
  assert.equal(html.status, 200);
  assert.match(await html.text(), /Desktop wallet/);
  const health = await fetch(ready.origin + '/api/health', { headers });
  assert.equal(health.status, 200);
  assert.equal((await health.json()).ok, true);
  const foreign = await fetch(ready.origin + '/api/health', {
    headers: { ...headers, Origin: 'https://example.com' },
  });
  assert.equal(foreign.status, 403);
  const exited = once(child, 'exit');
  child.send({ type: 'shutdown' });
  assert.deepEqual(await exited, [0, null]);
  await assert.rejects(fetch(ready.origin + '/', { headers }));
});

test('desktop manager exits when its controlling IPC parent disconnects', async t => {
  const { child } = await start(t);
  const exited = once(child, 'exit');
  child.disconnect();
  assert.deepEqual(await exited, [0, null]);
});

test('desktop capability stops at the manager while daemon credentials remain private', async t => {
  let received;
  const upstream = http.createServer((req, res) => {
    received = { url: req.url, headers: req.headers };
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify({ ok: true, result: { name: 'Local wallet' } }));
  });
  await new Promise(resolve => upstream.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => upstream.close(resolve)));
  const token = randomBytes(32).toString('hex');
  const service = await startManager({
    desktopSessionToken: token,
    manager: {
      async init() {}, async shutdown() {},
      target: () => `http://127.0.0.1:${upstream.address().port}`,
      runtimeState: () => ({ proc: {} }),
      token: () => 'daemon-only-token',
    },
  });
  t.after(() => service.close());
  const response = await fetch(`http://127.0.0.1:${service.server.address().port}/wallets/test/api/info`, {
    headers: { 'X-Chicory-Session': token },
  });
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { ok: true, result: { name: 'Local wallet' } });
  assert.equal(received.url, '/info');
  assert.equal(received.headers.authorization, 'Bearer daemon-only-token');
  assert.equal(received.headers['x-chicory-session'], undefined);
});

test('shutdown arriving during initialization is honored before announcing readiness', async t => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'chicory-desktop-startup-'));
  const fixture = path.join(dir, 'delay-init.cjs');
  await fs.writeFile(fixture, `
    const { WalletManager } = require(${JSON.stringify(path.join(__dirname, 'wallet-manager.js'))});
    const init = WalletManager.prototype.init;
    WalletManager.prototype.init = async function () {
      await new Promise(resolve => {
        process.on('message', message => { if (message?.type === 'continue-init') resolve(); });
        process.send({ type: 'initializing' });
      });
      return init.call(this);
    };
  `);
  const child = spawn(process.execPath, ['--require', fixture, path.join(__dirname, 'index.js')], {
    env: {
      ...process.env, DATA_DIR: path.join(dir, 'data'),
      DESKTOP_SESSION_TOKEN: randomBytes(32).toString('hex'), DESKTOP_MODE: '1',
      BEIGNET_BIN: '', TOR_PROXY_IP: '', TOR_PROXY_PORT: '', TOR_PASSWORD: '',
    },
    stdio: ['ignore', 'ignore', 'pipe', 'ipc'],
  });
  let ready = false;
  const exited = once(child, 'exit');
  const timer = setTimeout(() => child.kill('SIGKILL'), 5000);
  t.after(async () => {
    clearTimeout(timer);
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
    await fs.rm(dir, { recursive: true, force: true });
  });
  child.on('message', message => {
    if (message.type === 'ready') ready = true;
    if (message.type === 'initializing') {
      child.send({ type: 'shutdown' });
      child.send({ type: 'continue-init' });
    }
  });
  assert.deepEqual(await exited, [0, null]);
  assert.equal(ready, false);
});
