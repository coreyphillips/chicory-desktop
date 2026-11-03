'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { once } = require('node:events');

test('the manager serves the selected browser build and keeps missing API routes out of the SPA', async (t) => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'chicory-web-'));
  const publicDir = path.join(dir, 'site');
  await fs.mkdir(publicDir);
  await fs.writeFile(path.join(publicDir, 'index.html'), '<title>Chicory test build</title>');
  await fs.writeFile(path.join(publicDir, 'app.js'), 'window.chicory = true;');
  const child = spawn(process.execPath, [path.join(__dirname, 'index.js')], {
    env: {
      ...process.env, PORT: '0', DATA_DIR: path.join(dir, 'data'),
      PUBLIC_DIR: publicDir, BEIGNET_TRUST_ALL: '1', BEIGNET_BIN: '',
      TOR_PROXY_IP: '', TOR_PROXY_PORT: '', TOR_PASSWORD: '',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let output = '';
  child.stderr.on('data', (chunk) => { output += chunk; });
  t.after(async () => {
    if (child.exitCode === null) {
      const exited = once(child, 'exit');
      child.kill('SIGTERM');
      const timer = setTimeout(() => child.kill('SIGKILL'), 3000);
      await exited;
      clearTimeout(timer);
    }
    await fs.rm(dir, { recursive: true, force: true });
  });
  const port = await new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error(`Manager did not start: ${output}`)), 5000);
    child.once('error', (error) => { clearTimeout(timeout); reject(error); });
    child.once('exit', (code) => { clearTimeout(timeout); reject(new Error(`Manager exited ${code}: ${output}`)); });
    child.stdout.on('data', (chunk) => {
      output += chunk;
      const match = /chicory manager listening on :(\d+)/.exec(output);
      if (match) { clearTimeout(timeout); resolve(match[1]); }
    });
  });
  const origin = `http://127.0.0.1:${port}`;
  for (const pathname of ['/', '/activity/payment']) {
    const response = await fetch(origin + pathname);
    assert.equal(response.status, 200);
    assert.match(await response.text(), /Chicory test build/);
  }
  const asset = await fetch(origin + '/app.js');
  assert.equal(asset.status, 200);
  assert.match(await asset.text(), /window.chicory/);
  const health = await fetch(origin + '/api/health');
  assert.equal(health.status, 200);
  assert.equal((await health.json()).ok, true);
  for (const pathname of ['/api/not-a-route', '/wallets/not-a-wallet/api/balance']) {
    const response = await fetch(origin + pathname);
    assert.equal(response.status, 404);
    assert.doesNotMatch(await response.text(), /Chicory test build/);
  }
});
